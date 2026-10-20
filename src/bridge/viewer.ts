import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from "node:http";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve, extname, sep } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { Server as SocketServer } from "socket.io";
import type { BridgeBot } from "./types.ts";
import type { BridgeConnection } from "../shared/contracts.ts";
import { point } from "./perception.ts";
const require = createRequire(import.meta.url);
interface WorldStream extends EventEmitter {
  init(position: BridgeBot["entity"]["position"]): Promise<void>;
  updatePosition(position: BridgeBot["entity"]["position"]): Promise<void>;
  listenToBot(bot: BridgeBot): void;
  removeListenersFromBot(bot: BridgeBot): void;
}
// Load only the pinned server-side stream. The package root eagerly imports
// the unused Node canvas renderer; the browser already ships its own renderer.
const { WorldView } = require("prismarine-viewer/viewer/lib/worldView.js") as {
  WorldView: new (
    world: BridgeBot["world"],
    distance: number,
    position: BridgeBot["entity"]["position"],
    emitter: EventEmitter,
  ) => WorldStream;
};
const publicDir = resolve(
  dirname(require.resolve("prismarine-viewer/package.json")),
  "public",
);
const contentTypes: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".css": "text/css; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};
export class HumanViewer {
  private server: Server;
  private io: SocketServer;
  private host = "";
  private origin = "";
  private streams = new Set<() => void>();
  private closed = false;
  private bundle: Buffer | null = null;
  private worker: Buffer | null = null;
  constructor(
    bot: BridgeBot,
    private config: BridgeConnection,
  ) {
    this.server = createServer((req, res) => {
      void this.serve(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    this.io = new SocketServer(this.server, {
      path: "/viewer/socket.io/",
      serveClient: false,
      maxHttpBufferSize: 1024,
      allowRequest: (req, done) => done(null, this.authorized(req)),
    });
    this.io.engine.use(
      (
        req: IncomingMessage,
        res: ServerResponse,
        next: (err?: unknown) => void,
      ) => {
        if (this.authorized(req)) next();
        else {
          res.writeHead(403);
          res.end();
        }
      },
    );
    this.io.use((socket, next) =>
      this.authorized(socket.request)
        ? next()
        : next(new Error("Viewer access denied.")),
    );
    this.io.on("connection", (socket) => {
      const emitter = new EventEmitter();
      // Outbound-only emitter: socket mouseClick/other messages never reach WorldView.
      for (const event of [
        "entity",
        "loadChunk",
        "unloadChunk",
        "blockUpdate",
        "primitive",
      ])
        emitter.on(event, (data) => socket.emit(event, data));
      const view = new WorldView(bot.world, 3, bot.entity.position, emitter);
      socket.emit("version", config.version);
      const position = () => {
        if (!bot.entity) return;
        const p = point(bot.entity.position);
        p.y += bot.entity.eyeHeight - 1.6;
        socket.emit("position", {
          pos: p,
          yaw: bot.entity.yaw,
          pitch: bot.entity.pitch,
        });
      };
      let moving = false,
        dirty = false,
        closed = false;
      const update = async () => {
        dirty = true;
        if (moving || closed) return;
        moving = true;
        try {
          while (dirty && !closed) {
            dirty = false;
            position();
            await view.updatePosition(bot.entity.position);
          }
        } catch {
          socket.disconnect(true);
        } finally {
          moving = false;
        }
      };
      bot.on("move", update);
      bot.on("forcedMove", update);
      view.listenToBot(bot);
      position();
      const cleanup = () => {
        if (closed) return;
        closed = true;
        bot.off("move", update);
        bot.off("forcedMove", update);
        view.removeListenersFromBot(bot);
        emitter.removeAllListeners();
        this.streams.delete(cleanup);
      };
      this.streams.add(cleanup);
      socket.once("disconnect", cleanup);
      void view.init(bot.entity.position).catch(() => socket.disconnect(true));
    });
  }
  private authorized(req: IncomingMessage) {
    if (!this.host || req.headers.host !== this.host) return false;
    const origin = req.headers.origin;
    if (
      origin &&
      origin !== this.origin &&
      !this.config.operator_origins.includes(origin)
    )
      return false;
    const cookie = req.headers.cookie
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith("gh_viewer="))
      ?.slice(10);
    if (!cookie) return false;
    const given = Buffer.from(cookie),
      expected = Buffer.from(this.config.viewer_token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }
  async start() {
    // Patch only the verified pinned bundle seams; fail closed if an upgrade changes them.
    let bundle = await readFile(resolve(publicDir, "index.js"), "utf8");
    const loops = [...bundle.matchAll(/for\(let (\w+)=0;\1<256;\1\+=16\)/g)];
    if (loops.length !== 2)
      throw new Error("The viewer renderer is incompatible with this bridge.");
    bundle = bundle.replace(
      /for\(let (\w+)=0;\1<256;\1\+=16\)/g,
      "for(let $1=-64;$1<320;$1+=16)",
    );
    let worker = await readFile(resolve(publicDir, "worker.js"), "utf8");
    let replacements = 0;
    worker = worker.replace(
      /(\w+)\.sections\[Math\.floor\((\w+)\/16\)\]/g,
      (_match, column: string, y: string) => {
        replacements++;
        return `${column}.sections[Math.floor((${y}-(${column}.minY??0))/16)]`;
      },
    );
    if (replacements !== 2)
      throw new Error("The viewer worker is incompatible with this bridge.");
    // Both solid and liquid meshers also assume the old Y=0 world floor.
    // In this pinned bundle their first two arguments are world and cursor.
    const floorSeams = [
      ["function r(e,t,n,a,i,s,r){const p=[];", "g"],
      [
        'function v(e,t,n,i,s,_,r,c,v){const d=c.name.indexOf("glass")>=0;',
        "n",
      ],
    ] as const;
    for (const [signature, neighbor] of floorSeams) {
      const floor = `if(${neighbor}.position.y<0)continue`;
      const at = worker.indexOf(floor),
        signatureAt = worker.indexOf(signature);
      if (
        signatureAt === -1 ||
        signatureAt !== worker.lastIndexOf(signature) ||
        at === -1 ||
        at !== worker.lastIndexOf(floor)
      )
        throw new Error("The viewer mesher is incompatible with this bridge.");
      const body = signature.indexOf("{") + 1;
      worker = worker.replace(
        signature,
        `${signature.slice(0, body)}const gameHarnessMinY=e.getColumn(t.x&-16,t.z&-16).minY??0;${signature.slice(body)}`,
      );
      worker = worker.replace(
        floor,
        `if(${neighbor}.position.y<gameHarnessMinY)continue`,
      );
    }
    if (this.closed) throw new Error("Viewer startup was cancelled.");
    this.bundle = Buffer.from(bundle);
    this.worker = Buffer.from(worker);
    const listening = Promise.withResolvers<void>();
    this.server.once("error", listening.reject);
    this.server.listen(0, "127.0.0.1", () => {
      this.server.off("error", listening.reject);
      listening.resolve();
    });
    await listening.promise;
    if (this.closed) throw new Error("Viewer startup was cancelled.");
    const address = this.server.address();
    if (!address || typeof address === "string")
      throw new Error("The viewer listener could not start.");
    this.host = `127.0.0.1:${address.port}`;
    this.origin = `http://${this.host}`;
    return `${this.origin}/viewer/`;
  }
  private async serve(req: IncomingMessage, res: ServerResponse) {
    if (!this.authorized(req)) {
      res.writeHead(403);
      res.end("Viewer access denied.");
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405);
      res.end();
      return;
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    const ancestors = this.config.operator_origins
      .filter((origin) =>
        /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin),
      )
      .join(" ");
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'none'; script-src 'self'; worker-src 'self' blob:; connect-src 'self' ws://${this.host}; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors ${ancestors || "'none'"}; base-uri 'none'; form-action 'none'`,
    );
    const url = new URL(req.url ?? "/", this.origin);
    if (url.pathname === "/viewer") {
      res.writeHead(308, { Location: "/viewer/" });
      res.end();
      return;
    }
    if (!url.pathname.startsWith("/viewer/")) {
      res.writeHead(404);
      res.end();
      return;
    }
    let relative: string;
    try {
      relative = decodeURIComponent(url.pathname.slice("/viewer/".length));
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    if (relative === "index.html") {
      res.writeHead(308, { Location: "/viewer/" });
      res.end();
      return;
    }
    if (!relative) relative = "index.html";
    if (relative === "worker.js") {
      // The trusted pinned worker bootstraps AJV and NBT using dynamic code.
      // Permit it only here, never in the viewer document or main application.
      res.setHeader(
        "Content-Security-Policy",
        `default-src 'none'; script-src 'self' 'unsafe-eval'; connect-src 'self'; img-src 'self' data: blob:; base-uri 'none'; form-action 'none'`,
      );
    }
    const file = resolve(publicDir, relative);
    if (!file.startsWith(publicDir + sep)) {
      res.writeHead(404);
      res.end();
      return;
    }
    // Only the published browser assets are exposed, never package source or disk paths.
    if (
      !["index.html", "index.js", "worker.js"].includes(relative) &&
      !relative.startsWith("textures/") &&
      !relative.startsWith("blocksStates/")
    ) {
      res.writeHead(404);
      res.end();
      return;
    }
    const patched =
      relative === "index.js"
        ? this.bundle
        : relative === "worker.js"
          ? this.worker
          : null;
    let size: number;
    try {
      const info = await stat(file);
      if (!info.isFile()) throw new Error();
      size = patched?.length ?? info.size;
    } catch {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": contentTypes[extname(file)] ?? "application/octet-stream",
      "Content-Length": size,
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    if (patched) {
      res.end(patched);
      return;
    }
    const stream = createReadStream(file);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  }
  async close() {
    this.closed = true;
    for (const cleanup of this.streams) cleanup();
    this.io.disconnectSockets(true);
    this.server.closeAllConnections();
    const closed = Promise.withResolvers<void>();
    this.io.close(() => closed.resolve());
    await closed.promise;
    if (this.server.listening) {
      const stopped = Promise.withResolvers<void>();
      this.server.close(() => stopped.resolve());
      await stopped.promise;
    }
    this.bundle = null;
    this.worker = null;
  }
}
