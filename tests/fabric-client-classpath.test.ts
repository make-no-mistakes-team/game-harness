import { expect, test } from "bun:test";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { prepareFabricClientClasspath } from "../src/server/minecraft-client.ts";

test("Fabric classpath never requests profile metadata or accepts unverified JARs", async () => {
  const root = await mkdtemp(join(tmpdir(), "fabric-client-classpath-"));
  const source = join(root, "minecraft");
  const dataDir = join(root, "client");
  const shared = join(root, "shared");
  const vanilla = join(source, "versions", "1.21.4", "1.21.4.json");
  const relative = "org/ow2/asm/asm/9.7.1/asm-9.7.1.jar";
  const sharedJar = join(shared, relative);
  const localJar = join(dataDir, "native-libraries", relative);
  const artifactUrl = `https://maven.fabricmc.net/${relative}`;
  const requests: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    requests.push(String(input));
    if (String(input) !== artifactUrl) throw new Error("Unexpected network dependency");
    return new Response("not the pinned JAR");
  }) as typeof fetch;
  const signal = new AbortController().signal;

  try {
    await mkdir(dirname(vanilla), { recursive: true });
    await writeFile(vanilla, JSON.stringify({ id: "1.21.4", libraries: [], assetIndex: { id: "19" } }));

    for (const cached of [sharedJar, localJar]) {
      await mkdir(dirname(cached), { recursive: true });
      await writeFile(cached, "not the pinned JAR");
      await expect(prepareFabricClientClasspath(source, dataDir, signal, shared))
        .rejects.toThrow("Cached Fabric library checksum mismatch (org.ow2.asm:asm:9.7.1).");
      await rm(cached);
    }
    expect(requests).toEqual([]);

    await expect(prepareFabricClientClasspath(source, dataDir, signal, shared))
      .rejects.toThrow("Minecraft artifact checksum mismatch.");
    expect(requests).toEqual([artifactUrl]);
    await expect(access(localJar)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
