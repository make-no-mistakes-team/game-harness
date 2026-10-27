import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { authWorkerEnvironment } from "../src/server/auth-network.ts";
import { AuthManager } from "../src/server/auth.ts";

test("browser login exposes the provider HTTPS URL rather than the SDK loopback launch shortcut", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gameharness-browser-auth-"));
  const spawn = Bun.spawn;
  const intercepted = spyOn(Bun, "spawn").mockImplementation(((command: string[], options: object) => {
    if (!command.some(part => part.endsWith("/auth-worker.ts")))
      throw new Error("Only the isolated OAuth worker may start in this fixture");
    // Substitute only the child/provider seam, keeping real IPC decoding,
    // parent URL validation, state publication and owned cancellation.
    return spawn([command[0]!, "--no-env-file", "-e", `
process.stdout.write(JSON.stringify({type:"auth",
  url:"https://auth.openai.com/oauth/authorize?state=synthetic&code_challenge=synthetic",
  launch_url:"http://localhost:1455/launch",instructions:"Synthetic, no provider connection"})+"\\n");
setInterval(()=>{},1000);
`], options);
  }) as typeof Bun.spawn);
  let auth: AuthManager | undefined;
  const published = Promise.withResolvers<string>();
  const deadline = setTimeout(() => published.reject(new Error("No authorization URL published")), 5000);
  try {
    auth = await AuthManager.create(directory, () => {
      const snapshot = auth?.snapshot();
      if (snapshot?.login?.url) published.resolve(snapshot.login.url);
      if (snapshot?.error) published.reject(new Error(snapshot.error));
    });
    await auth.startLogin("browser");
    expect(await published.promise).toBe("https://auth.openai.com/oauth/authorize?state=synthetic&code_challenge=synthetic");
    expect(auth.snapshot().authenticated).toBe(false);
  } finally {
    clearTimeout(deadline);
    await auth?.close();
    intercepted.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
}, 10000);

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
