#!/usr/bin/env bun
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { Readable } from "node:stream";
import path from "node:path";

// A browser's native multipart JPEG viewer. No input channel, auth files or game
// metadata are served. Anyone joining mid-frame receives the next JPEG boundary.
const port = 4379;
const root = path.resolve(import.meta.dir, "../local/survival-pilot");
const viewers = new Set<ServerResponse>();
let capture: ChildProcessByStdio<null, Readable, null> | undefined;
let current = "";
let busy = false;
let stopping = false;

async function tick() {
    if (busy || stopping) return;
    busy = true;
    try {
        let source: { run: string, display: string, authority: string } | undefined;
        if (viewers.size) {
            const data = JSON.parse(await readFile(path.join(root, "live.json"), "utf8"));
            if (data.active === true && typeof data.run === "string" && /^[\w.-]+$/.test(data.run) &&
                data.run !== "." && data.run !== ".." && /^:\d+$/.test(data.display) &&
                Number(data.display.slice(1)) >= 90 && path.isAbsolute(data.authority)) {
                const run = path.join(root, "runs", data.run);
                const closed = await stat(path.join(run, "outcome.json")).then(() => true, (e) => {
                    if (e.code === "ENOENT") return false;
                    throw e;
                });
                if (!closed) {
                    const pid = (await readFile(`/tmp/.X${data.display.slice(1)}-lock`, "utf8")).trim();
                    if (!/^[1-9]\d*$/.test(pid)) throw new Error("Invalid display owner");
                    const proc = `/proc/${pid}`;
                    const argv = (await readFile(`${proc}/cmdline`, "utf8")).split("\0");
                    const auth = argv.indexOf("-auth");
                    const expected = Bun.which("Xvfb");
                    if (expected && await realpath(`${proc}/exe`) === await realpath(expected) &&
                        argv[1] === data.display && auth >= 0 &&
                        await realpath(argv[auth+1]!) === await realpath(data.authority)) source = data;
                }
            }
        }
        if (stopping) return;
        if (!source || !viewers.size || source.run !== current) {
            capture?.kill();
            capture = undefined;
            current = "";
        }
        if (source && viewers.size && !capture) {
            const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin",
                "-f", "x11grab", "-framerate", "20", "-draw_mouse", "1", "-video_size", "1280x720",
                "-i", `${source.display}+0,0`, "-an", "-vf", "scale=960:540", "-c:v", "mjpeg",
                "-threads", "2", "-q:v", "5", "-f", "mpjpeg", "-boundary_tag", "pilotframe", "pipe:1"],
                { stdio: ["ignore", "pipe", "ignore"], env: { PATH: "/usr/bin:/bin", XAUTHORITY: source.authority } });
            capture = child;
            current = source.run;
            child.on("error", () => {});
            child.on("close", () => { if (capture === child) { capture = undefined; current = ""; } });
            child.stdout.on("data", (chunk: Buffer) => {
                if (capture !== child) return;
                for (const viewer of viewers) {
                    if (viewer.writableLength > 2_000_000) viewer.destroy();
                    else viewer.write(chunk);
                }
            });
        }
    } catch { capture?.kill(); capture = undefined; current = ""; }
    finally { busy = false; }
}

const server = createServer((req, res) => {
    if (req.headers.host !== `127.0.0.1:${port}` || req.method !== "GET" || req.url !== "/" ||
        req.headers["sec-fetch-site"] === "cross-site" && req.headers["sec-fetch-mode"] !== "navigate") {
        res.writeHead(403).end(); return;
    }
    res.writeHead(200, { "Content-Type": "multipart/x-mixed-replace; boundary=pilotframe",
        "Cache-Control": "no-store", "Cross-Origin-Resource-Policy": "same-origin",
        "X-Content-Type-Options": "nosniff" });
    res.flushHeaders();
    viewers.add(res);
    res.on("close", () => { viewers.delete(res); void tick(); });
    void tick();
});
server.listen(port, "127.0.0.1", () => console.log(`Survival Pilot live: http://127.0.0.1:${port}/`));
const timer = setInterval(() => void tick(), 500);
function close() {
    stopping = true;
    clearInterval(timer);
    capture?.kill();
    for (const viewer of viewers) viewer.destroy();
    server.close();
}
process.once("SIGTERM", close);
process.once("SIGINT", close);
