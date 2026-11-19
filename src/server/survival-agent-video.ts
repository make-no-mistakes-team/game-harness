export interface AgentDisplay {
  display: string;
  authority: string;
  ffmpeg: string;
  live(): boolean;
}

const BOUNDARY = "agentframe";
type Viewer = { close(): Promise<void> };

/** Private Xvfb capture with bounded readers; each viewer starts at its own MIME boundary. */
export class AgentVideo {
  private readonly viewers = new Set<Viewer>();

  open(source: AgentDisplay, signal: AbortSignal, expires: number, headers: Record<string, string>): Response | null {
    if (this.viewers.size >= 2 || signal.aborted || expires <= Date.now() || !source.live()) return null;
    const child = Bun.spawn([source.ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin",
      "-f", "x11grab", "-framerate", "15", "-draw_mouse", "1", "-video_size", "1280x720",
      "-i", `${source.display}+0,0`, "-an", "-vf", "scale=960:540", "-c:v", "mjpeg",
      "-threads", "2", "-q:v", "5", "-f", "mpjpeg", "-boundary_tag", BOUNDARY, "pipe:1"], {
      env: { PATH: "/usr/bin:/bin", XAUTHORITY: source.authority },
      stdin: "ignore", stdout: "pipe", stderr: "ignore",
    });
    const reader = child.stdout.getReader();
    let controller: ReadableStreamDefaultController<Uint8Array>;
    let closing: Promise<void> | undefined;
    let expiry: ReturnType<typeof setTimeout>;
    const viewer: Viewer = { close: () => {
      closing ??= (async () => {
        signal.removeEventListener("abort", abort);
        clearTimeout(expiry);
        try { controller.close(); } catch { /* Already cancelled by the reader. */ }
        if (child.exitCode === null) child.kill("SIGTERM");
        const force = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 2000);
        try {
          await Promise.allSettled([reader.cancel(), child.exited]);
        } finally {
          clearTimeout(force);
          this.viewers.delete(viewer);
        }
      })();
      return closing;
    } };
    const abort = () => { void viewer.close(); };
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) { controller = streamController; },
      async pull(streamController) {
        try {
          const frame = await reader.read();
          if (closing) return;
          if (frame.done) await viewer.close();
          else streamController.enqueue(frame.value);
        } catch { await viewer.close(); }
      },
      cancel() { return viewer.close(); },
    });
    this.viewers.add(viewer);
    expiry = setTimeout(abort, expires - Date.now());
    signal.addEventListener("abort", abort, { once: true });
    void child.exited.catch(abort);
    return new Response(stream, {
      headers: { ...headers, "Cross-Origin-Resource-Policy": "same-origin",
        "Content-Type": `multipart/x-mixed-replace; boundary=${BOUNDARY}` },
    });
  }

  async close(): Promise<void> {
    await Promise.all([...this.viewers].map((viewer) => viewer.close()));
  }
}
