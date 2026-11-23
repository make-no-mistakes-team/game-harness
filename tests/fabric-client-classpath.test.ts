import { expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { prepareAgentAssets, prepareFabricClientClasspath } from "../src/server/minecraft-client.ts";

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

test("concurrent agent asset roots share installed objects but not launcher assets or skin caches", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-client-assets-"));
  try {
    const source = join(root, "installed");
    const official = join(source, "assets");
    const index = "indexes/19.json";
    const skin = "skins/cached.png";
    const object = "objects/ab/asset";
    const primaryGame = join(root, "primary");
    const parallelGame = join(root, "parallel");
    for (const name of [index, skin, object]) {
      await mkdir(dirname(join(official, name)), { recursive: true });
      await writeFile(join(official, name), name);
    }
    await Promise.all([mkdir(primaryGame), mkdir(parallelGame)]);

    const [primary, parallel] = await Promise.all([
      prepareAgentAssets(source, primaryGame, "19"), prepareAgentAssets(source, parallelGame, "19"),
    ]);
    expect(primary).toBe(join(primaryGame, "assets"));
    expect(parallel).toBe(join(parallelGame, "assets"));
    for (const [assetDir, label] of [[primary, "primary"], [parallel, "parallel"]] as const) {
      expect(await readFile(join(assetDir, object), "utf8")).toBe(object);
      expect(await realpath(join(assetDir, object))).toBe(await realpath(join(official, object)));
      expect(await readFile(join(assetDir, index), "utf8")).toBe(index);
      await mkdir(dirname(join(assetDir, skin)), { recursive: true });
      await writeFile(join(assetDir, skin), label);
    }
    await writeFile(join(primary, index), "primary index");
    expect(await readFile(join(parallel, index), "utf8")).toBe(index);
    expect(await readFile(join(official, index), "utf8")).toBe(index);
    expect(await readFile(join(primary, skin), "utf8")).toBe("primary");
    expect(await readFile(join(parallel, skin), "utf8")).toBe("parallel");
    expect(await readFile(join(official, skin), "utf8")).toBe(skin);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
