import { decodeNativeVideoHeader } from "../../src/shared/video.ts";

const MAX_FRAME_AGE_MS = 10_000;

export function classifyVideoFrame(
  data: unknown,
  now: number,
): "malformed" | "stale" | "fresh" {
  if (!(data instanceof ArrayBuffer)) return "malformed";
  const header = decodeNativeVideoHeader(new Uint8Array(data));
  if (!header || data.byteLength !== header.headerBytes + header.width * header.height * 4) return "malformed";
  return Math.abs(now - header.capturedAt) >= MAX_FRAME_AGE_MS ? "stale" : "fresh";
}

export class NativeVideo {
  private socket: WebSocket | null = null;
  private pending: ArrayBuffer | null = null;
  private raf = 0;
  private lastDraw = 0;
  private capture = 0;
  private captureToDraw: number | null = null;
  private drawn = 0;
  private measuredFps: number | null = null;
  private size = { width: 0, height: 0 };
  private enabled = false;
  private failure: string | null = null;
  private state = "idle";
  private gl: WebGLRenderingContext | null = null;
  private texture: WebGLTexture | null = null;
  private flip: WebGLUniformLocation | null = null;
  private interval: number;
  private reconnectTimer = 0;
  private sourceState = "idle";
  private sourceError: string | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private report: (state: string, detail: string, hasFrame: boolean) => void,
  ) {
    this.initialize();
    canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      this.gl = null;
      this.failure =
        "Video graphics context lost. Reconnect the view to recover; the game is not restarted.";
      this.updateStatus();
    });
    canvas.addEventListener("webglcontextrestored", () => {
      this.initialize();
      this.size = { width: 0, height: 0 };
      this.failure = null;
      this.lastDraw = 0;
    });
    this.interval = window.setInterval(() => {
      this.measuredFps = this.drawn;
      this.drawn = 0;
      this.updateStatus();
    }, 1000);
  }

  private initialize(): void {
    const gl = this.canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) {
      this.failure =
        "WebGL is unavailable. Authentic video cannot be displayed on this graphics configuration.";
      return;
    }
    const shader = (type: number, source: string): WebGLShader => {
      const result = gl.createShader(type);
      if (!result) throw new Error("Video shader allocation failed.");
      gl.shaderSource(result, source);
      gl.compileShader(result);
      if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) {
        gl.deleteShader(result);
        throw new Error("Video shader compilation failed.");
      }
      return result;
    };
    try {
      const vertex = shader(
        gl.VERTEX_SHADER,
        "attribute vec2 p; varying vec2 uv; void main(){uv=(p+1.0)*0.5; gl_Position=vec4(p,0.0,1.0);}",
      );
      const fragment = shader(
        gl.FRAGMENT_SHADER,
        "precision mediump float; varying vec2 uv; uniform sampler2D image; uniform float bottomUp; void main(){vec2 t=vec2(uv.x,mix(1.0-uv.y,uv.y,bottomUp));gl_FragColor=vec4(texture2D(image,t).rgb,1.0);}",
      );
      const program = gl.createProgram();
      if (!program) throw new Error("Video program allocation failed.");
      gl.attachShader(program, vertex);
      gl.attachShader(program, fragment);
      gl.linkProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        throw new Error("Video graphics program could not link.");
      gl.useProgram(program);
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
        gl.STATIC_DRAW,
      );
      const position = gl.getAttribLocation(program, "p");
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      this.flip = gl.getUniformLocation(program, "bottomUp");
      this.texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.gl = gl;
    } catch (error) {
      this.failure =
        error instanceof Error ? error.message : "Video graphics setup failed.";
    }
  }

  connect(): void {
    this.disconnect();
    this.enabled = true;
    if (!this.gl) {
      this.initialize();
      if (!this.gl) {
        this.updateStatus();
        return;
      }
    }
    this.failure = null;
    this.state = "connecting";
    const endpoint = new URL("/v1/video", location.href);
    endpoint.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(endpoint);
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      if (this.socket === socket) this.state = "waiting";
    };
    socket.onmessage = (event: MessageEvent<unknown>) => {
      if (this.socket !== socket) return;
      const admission = classifyVideoFrame(event.data, Date.now());
      if (admission === "malformed") {
        this.failure =
          "The local service sent an invalid video frame. Reconnect after checking client compatibility.";
        socket.close(1002, "Invalid video frame");
        this.updateStatus();
        return;
      }
      if (admission === "stale") {
        this.pending = null;
        if (this.state !== "stale") {
          this.state = "stale";
          this.updateStatus();
        }
        return;
      }
      this.pending = event.data as ArrayBuffer;
      if (!this.raf) this.raf = requestAnimationFrame(() => this.draw());
    };
    socket.onerror = () => {
      if (this.socket === socket) this.state = "disconnected";
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.state = "disconnected";
      this.updateStatus();
      if (this.enabled && !this.failure)
        this.reconnectTimer = window.setTimeout(() => this.connect(), 3000);
    };
    this.updateStatus();
  }

  private draw(): void {
    this.raf = 0;
    const buffer = this.pending,
      gl = this.gl;
    this.pending = null;
    if (!buffer || !gl) return;
    const header = decodeNativeVideoHeader(new Uint8Array(buffer));
    if (!header) return;
    const { width, height } = header;
    if (
      Math.abs(Date.now() - header.capturedAt) >= MAX_FRAME_AGE_MS
    ) {
      if (this.state !== "stale") {
        this.state = "stale";
        this.updateStatus();
      }
      return;
    }
    const pixels = new Uint8Array(buffer, header.headerBytes);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    if (this.size.width !== width || this.size.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.size = { width, height };
      gl.viewport(0, 0, width, height);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        width,
        height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixels,
      );
    } else
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        width,
        height,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixels,
      );
    gl.uniform1f(this.flip, Number(header.bottomUp));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.lastDraw = performance.now();
    this.capture = header.capturedAt;
    this.drawn++;
    this.captureToDraw = Date.now() - this.capture;
    this.state = "streaming";
  }

  private updateStatus(): void {
    const hasFrame = this.lastDraw > 0;
    const stale = hasFrame && performance.now() - this.lastDraw > 2500;
    const sourceFailure = !hasFrame || stale ? this.sourceError : null;
    const state =
      this.failure || sourceFailure
        ? "error"
        : this.state === "disconnected"
          ? "disconnected"
          : stale || this.state === "stale"
            ? "stale"
            : !hasFrame && this.sourceState === "starting"
              ? "starting"
              : this.state;
    const latency = this.capture ? Date.now() - this.capture : null;
    const detail =
      this.failure ??
      sourceFailure ??
      (state === "streaming"
        ? `${this.size.width} × ${this.size.height} · ${this.measuredFps ?? "unknown"} drawn fps · capture→draw ${this.captureToDraw === null ? "unknown" : Math.round(this.captureToDraw) + " ms"} · latest age ${latency === null ? "unknown" : Math.round(latency) + " ms"} (same-host wall clock)`
        : state === "stale"
          ? "Video is stale. Waiting for fresh frames; any retained authentic frame is not current gameplay."
          : state === "disconnected"
            ? "Video disconnected. Reconnecting the stream only; no game restart."
            : state === "idle"
              ? "No live video connection. No simulated footage."
              : "Waiting for authentic client frames, including hand and HUD.");
    this.report(state, detail, hasFrame);
  }

  setSourceState(status: string, error: string | null): void {
    this.sourceState = status;
    this.sourceError = error;
    this.updateStatus();
  }

  disconnect(): void {
    this.enabled = false;
    clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.socket = null;
    this.pending = null;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.state = "idle";
    this.updateStatus();
  }

  destroy(): void {
    this.disconnect();
    clearInterval(this.interval);
  }
}
