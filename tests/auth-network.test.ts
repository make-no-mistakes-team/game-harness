import { expect, test } from "bun:test";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { authWorkerEnvironment } from "../src/server/auth-network.ts";

test("OAuth initiation reaches the configured proxy before account sign-in", async () => {
  const connected = Promise.withResolvers<string>();
  const listening = Promise.withResolvers<void>();
  const sockets = new Set<Socket>();
  const proxy = createServer();
  proxy.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  proxy.on("connect", (request, socket) => {
    connected.resolve(request.url ?? "");
    // Refuse the tunnel locally: no provider request, user code or credential exchange.
    socket.end(
      "HTTP/1.1 502 Fixture Tunnel Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
  });
  proxy.once("error", listening.reject);
  proxy.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = proxy.address();
  if (!address || typeof address === "string")
    throw new Error("Proxy fixture did not bind");
  const network = authWorkerEnvironment({
    HTTPS_PROXY: `http://127.0.0.1:${address.port}`,
    OPENAI_API_KEY: "fixture-secret-must-not-be-inherited",
    NODE_OPTIONS: "--require=/nonexistent/ambient-preload.js",
  });
  expect(network).not.toHaveProperty("OPENAI_API_KEY");
  expect(network).not.toHaveProperty("NODE_OPTIONS");
  const worker = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      fileURLToPath(new URL("../src/server/auth-worker.ts", import.meta.url)),
      "device",
    ],
    { env: network, stdin: "pipe", stdout: "ignore", stderr: "ignore" },
  );
  // A real Bun subprocess cannot share fake timers. This only bounds failure
  // cleanup; successful readiness awaits the proxy's actual CONNECT event.
  const deadline = setTimeout(
    () =>
      connected.reject(
        new Error("OAuth bypassed the configured proxy or never initiated"),
      ),
    7000,
  );
  try {
    expect(await connected.promise).toBe("auth.openai.com:443");
  } finally {
    clearTimeout(deadline);
    worker.kill("SIGKILL");
    await worker.exited;
    for (const socket of sockets) socket.destroy();
    const closed = Promise.withResolvers<void>();
    proxy.close(() => closed.resolve());
    await closed.promise;
  }
}, 10000);
