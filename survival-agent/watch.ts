#!/usr/bin/env bun
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { Readable } from "node:stream";
import path from "node:path";

// A browser's native multipart JPEG viewer. A new reader must start on a MIME
// boundary, not halfway through the encoder's current JPEG.
const args = process.argv.slice(2);
const diagnostic = args.length === 1 && args[0] === "--diagnostic";
if (args.length && !diagnostic) {
    console.error("Usage: bun run watch:agent [--diagnostic]");
    process.exit(1);
}
const port = diagnostic ? 4382 : 4379;
const root = path.resolve(import.meta.dir, "../local/survival-agent");
const descriptor = path.join(root, diagnostic ? "diagnostic-live.json" : "live.json");
const runs = path.join(root, diagnostic ? "diagnostic-runs" : "runs");
const label = diagnostic ? "Minecraft Survival Agent diagnostic" : "Minecraft Survival Agent";
const boundary = "agentframe";
const waitingText = diagnostic ? "Waiting for the next diagnostic run" : "Waiting for the next survival run";
const capturePath = "/usr/bin:/bin";
const xvfb = Bun.which("Xvfb", { PATH: capturePath });
const viewers = new Set<ServerResponse>();
let capture: ChildProcessByStdio<null, Readable, null> | undefined;
let current = "";
let busy = false;
let stopping = false;
const waiting = Bun.spawnSync(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
    "-i", "color=c=black:s=960x540", "-vf", `drawtext=text='${waitingText}':fontcolor=white:fontsize=24:x=(w-tw)/2:y=(h-th)/2`,
    "-frames:v", "1", "-threads", "1", "-f", "mjpeg", "pipe:1"]).stdout;
const delimiter = Buffer.from("\r\n\r\n");
let lastJpeg: Buffer = waiting;
function send(viewer: ServerResponse, jpeg: Buffer) {
    if (viewer.writableLength > 2_000_000) { viewer.destroy(); return; }
    viewer.cork();
    viewer.write(`--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
    viewer.write(jpeg);
    viewer.write("\r\n");
    viewer.uncork();
}
function idle() {
    capture?.kill();
    capture = undefined;
    current = "";
    if (lastJpeg === waiting) return;
    lastJpeg = waiting;
    for (const viewer of viewers) send(viewer, waiting);
}

async function captureSource() {
    if (!xvfb) return;
    const data = JSON.parse(await readFile(descriptor, "utf8"));
    if (data?.active !== true || typeof data.run !== "string" || !/^[\w.-]+$/.test(data.run) ||
        data.run === "." || data.run === ".." || typeof data.display !== "string" ||
        typeof data.authority !== "string" || !path.isAbsolute(data.authority)) return;
    const display: string = data.display;
    const number = display.match(/^:([1-9]\d*)$/)?.[1];
    if (!number || !Number.isSafeInteger(Number(number)) || Number(number) < 90) return;
    const run = path.join(runs, data.run);
    if (!(await lstat(run)).isDirectory()) return;
    const closed = await lstat(path.join(run, "outcome.json")).then(() => true, (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
    });
    if (closed) return;
    const pid = (await readFile(`/tmp/.X${number}-lock`, "utf8")).trim();
    if (!/^[1-9]\d*$/.test(pid)) return;
    const proc = `/proc/${pid}`;
    const [running, expected, cmdline, authority] = await Promise.all([
        realpath(`${proc}/exe`), realpath(xvfb), readFile(`${proc}/cmdline`, "utf8"), realpath(data.authority),
    ]);
    const argv = cmdline.split("\0");
    const auth = argv.indexOf("-auth");
    const offline = argv.some((arg, index) => arg === "-nolisten" && argv[index + 1] === "tcp");
    const online = argv.some((arg, index) => arg === "-listen" && argv[index + 1] === "tcp");
    if (running !== expected || argv[1] !== display || !offline || online || auth < 0 ||
        await realpath(argv[auth + 1]!) !== authority) return;
    const authStat = await stat(authority);
    if (!authStat.isFile() || authStat.uid !== process.getuid?.() || (authStat.mode & 0o077)) return;
    return { display, authority, identity: JSON.stringify([data.run, display, pid, authority]) };
}

async function tick() {
    if (busy || stopping) return;
    busy = true;
    try {
        const source = viewers.size ? await captureSource() : undefined;
        if (stopping) return;
        if (!source || !viewers.size || source.identity !== current) {
            idle();
        }
        if (source && viewers.size && !capture) {
            const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin",
                "-f", "x11grab", "-framerate", "20", "-draw_mouse", "1", "-video_size", "1280x720",
                "-i", `${source.display}+0,0`, "-an", "-vf", "scale=960:540", "-c:v", "mjpeg",
                "-threads", "2", "-q:v", "5", "-f", "mpjpeg", "-boundary_tag", boundary, "pipe:1"],
                { stdio: ["ignore", "pipe", "ignore"], env: { PATH: capturePath, XAUTHORITY: source.authority } });
            capture = child;
            current = source.identity;
            child.on("error", () => {});
            child.on("close", () => { if (capture === child) idle(); });
            let pending: Buffer = Buffer.alloc(0);
            let length = 0;
            child.stdout.on("data", (chunk: Buffer) => {
                if (capture !== child) return;
                pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
                while (pending.length) {
                    if (!length) {
                        const end = pending.indexOf(delimiter);
                        if (end < 0) { if (pending.length > 512) idle(); return; }
                        length = Number(/\bContent-length:\s*(\d+)/i.exec(pending.toString("ascii", 0, end))?.[1]);
                        if (!(length > 0 && length <= 2_000_000)) { idle(); return; }
                        pending = pending.subarray(end + delimiter.length);
                    }
                    if (pending.length < length) return;
                    lastJpeg = pending.subarray(0, length);
                    pending = pending.subarray(length);
                    length = 0;
                    for (const viewer of viewers) send(viewer, lastJpeg);
                }
            });
        }
    } catch { idle(); }
    finally { busy = false; }
}

const server = createServer((req, res) => {
    if (req.headers.host !== `127.0.0.1:${port}` || req.method !== "GET" || req.url !== "/" ||
        req.headers["sec-fetch-site"] === "cross-site" && req.headers["sec-fetch-mode"] !== "navigate") {
        res.writeHead(403).end(); return;
    }
    res.writeHead(200, { "Content-Type": `multipart/x-mixed-replace; boundary=${boundary}`,
        "Cache-Control": "no-store", "Cross-Origin-Resource-Policy": "same-origin",
        "X-Content-Type-Options": "nosniff" });
    res.flushHeaders();
    viewers.add(res);
    send(res, lastJpeg);
    res.on("close", () => { viewers.delete(res); void tick(); });
    void tick();
});
server.listen(port, "127.0.0.1", () => console.log(`${label} live: http://127.0.0.1:${port}/`));
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
