#!/usr/bin/env bun
import path from "node:path";
import { lstat } from "node:fs/promises";

// Serve only explicitly exported review clips. Never expose an attempt directory.
const local = path.resolve(import.meta.dir, "../local");
// Resolve existing absolute clip links before looking for newly exported clips.
const roots = ["survival-pilot", "survival-agent"].map(name => path.join(local, name, "reviews"));
async function findClip(name: string) {
    for (const root of roots) {
        try {
            if (!(await lstat(path.dirname(root))).isDirectory() || !(await lstat(root)).isDirectory()) continue;
            const file = path.join(root, name);
            const stat = await lstat(file);
            return stat.isFile() && stat.nlink === 1 && stat.size > 0 ? { file, stat } : null;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
        }
    }
    return null;
}
const host = "127.0.0.1";
const port = 4381;
Bun.serve({
    hostname: host, port,
    async fetch(req) {
        const name = new URL(req.url).pathname.slice(1);
        if (req.headers.get("host") !== `${host}:${port}` || !["GET", "HEAD"].includes(req.method) ||
            !/^survival-[a-z0-9-]{1,64}\.mp4$/.test(name)) return new Response(null, { status: 404 });
        const clip = await findClip(name);
        if (!clip) return new Response(null, { status: 404 });
        const { file, stat } = clip;
        const headers = new Headers({ "Content-Type": "video/mp4", "Accept-Ranges": "bytes",
            "Cache-Control": "private, no-cache", "Cross-Origin-Resource-Policy": "same-origin" });
        const range = req.headers.get("range");
        let lo = 0, hi = stat.size - 1;
        if (range !== null) {
            const m = /^bytes=(\d*)-(\d*)$/.exec(range);
            if (!m || (!m[1] && !m[2])) return new Response(null, { status: 416 });
            if (!m[1]) lo = Math.max(0, stat.size - Number(m[2]));
            else {
                lo = Number(m[1]);
                if (m[2]) hi = Math.min(hi, Number(m[2]));
            }
            if (!Number.isSafeInteger(lo) || lo > hi)
                return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${stat.size}` } });
            headers.set("Content-Range", `bytes ${lo}-${hi}/${stat.size}`);
        }
        headers.set("Content-Length", String(hi - lo + 1));
        return new Response(req.method === "HEAD" ? null : Bun.file(file).slice(lo, hi + 1),
            { status: range === null ? 200 : 206, headers });
    },
});
console.log(`Minecraft Survival Agent review clips: http://${host}:${port}/`);
