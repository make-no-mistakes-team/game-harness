import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { MinecraftClient } from "../src/server/minecraft-client.ts";
import { readNativeArtifactContract } from "../src/server/native-artifact.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

// Independently constructed ZIP wire fixture; exercises real stored/DEFLATE/CRC
// decoding, not a fake extractor. This JSON is not a native compatibility claim.
function jar(name: string, contents: Buffer, compressed: boolean) {
  const filename = Buffer.from(name), payload = compressed ? deflateRawSync(contents) : contents;
  const crc = Bun.hash.crc32(contents) >>> 0, method = compressed ? 8 : 0;
  const local = Buffer.alloc(30 + filename.length);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(payload.length, 18); local.writeUInt32LE(contents.length, 22);
  local.writeUInt16LE(filename.length, 26); filename.copy(local, 30);
  const central = Buffer.alloc(46 + filename.length);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(method, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(payload.length, 20);
  central.writeUInt32LE(contents.length, 24); central.writeUInt16LE(filename.length, 28); filename.copy(central, 46);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(local.length + payload.length, 16);
  return Buffer.concat([local, payload, central, end]);
}
async function artifact(bytes: Buffer) {
  const root = await mkdtemp(join(tmpdir(), "gameharness-contract-jar-")); roots.push(root);
  const file = join(root, "native.jar"); await writeFile(file, bytes); return file;
}
for (const compressed of [false, true]) {
  test(`reads the actual ${compressed ? "DEFLATE" : "stored"} JAR resource and hashes those exact final bytes`, async () => {
    const resource = { resource_schema: 1, fixture: "actual artifact bytes, not a sidecar" };
    const bytes = jar("gameharness-native-contract.json", Buffer.from(JSON.stringify(resource)), compressed);
    const result = await readNativeArtifactContract(await artifact(bytes));
    expect(result.resource).toEqual(resource);
    expect(result.artifact_sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  });
}

test("a sidecar cannot substitute for a missing built JAR contract resource", async () => {
  const bytes = jar("unrelated.json", Buffer.from('{}'), false);
  const file = await artifact(bytes);
  await writeFile(file + ".contract.json", '{"resource_schema":1}');
  await expect(readNativeArtifactContract(file)).rejects.toThrow();
});
for (const corruption of ["crc", "compressed size", "local name", "encryption", "truncation"] as const) {
  test(`corrupt native JAR ${corruption} cannot produce a trusted resource`, async () => {
    let bytes = jar("gameharness-native-contract.json", Buffer.from('{"resource_schema":1}'), true);
    const end = bytes.length - 22, central = bytes.readUInt32LE(end + 16);
    switch (corruption) {
      case "crc": bytes.writeUInt32LE(0, central + 16); break;
      case "compressed size": bytes.writeUInt32LE(0xffffffff, central + 20); break;
      case "local name": bytes[30] = 0x78; break;
      case "encryption": bytes.writeUInt16LE(1, central + 8); break;
      case "truncation": bytes = bytes.subarray(0, bytes.length - 3); break;
    }
    await expect(readNativeArtifactContract(await artifact(bytes))).rejects.toThrow();
  });
}

test("inflated resource size is bounded before JSON parsing", async () => {
  const bytes = jar("gameharness-native-contract.json", Buffer.alloc(1048577, 32), true);
  await expect(readNativeArtifactContract(await artifact(bytes))).rejects.toThrow();
});

const oldManifest = { schemaVersion: 1, id: "survival_agent", version: "1.0" };
const terraManifest = { ...oldManifest, custom: { "gameharness:terra_work_wire": 10 } };
const actor = (manifest: object) => jar("fabric.mod.json", Buffer.from(JSON.stringify(manifest)), true);

for (const [kind, bytes] of [
  ["unmarked", actor(oldManifest)],
  ["pre-furnace work-wire version 1", actor({ ...oldManifest, custom: { "gameharness:terra_work_wire": 1 } })],
  ["pre-prospecting work-wire version 2", actor({ ...oldManifest, custom: { "gameharness:terra_work_wire": 2 } })],
  ["pre-water-fill work-wire version 3", actor({ ...oldManifest, custom: { "gameharness:terra_work_wire": 3 } })],
  ["pre-attached-support work-wire version 4", actor({ ...oldManifest, custom: { "gameharness:terra_work_wire": 4 } })],
  ["pre-pending-production work-wire version 5", actor({ ...oldManifest, custom: { "gameharness:terra_work_wire": 5 } })],
  ["pre-ordinary-pending work-wire version 6", actor({ ...oldManifest, custom: { "gameharness:terra_work_wire": 6 } })],
  ["pre-scoped-travel work-wire version 7", actor({ ...oldManifest, custom: { "gameharness:terra_work_wire": 7 } })],
  ["pre-landmark work-wire version 8", actor({ ...oldManifest, custom: { "gameharness:terra_work_wire": 8 } })],
  ["pre-grade work-wire version 9", actor({ ...oldManifest, custom: { "gameharness:terra_work_wire": 9 } })],
  ["wrong future work-wire version", actor({ ...oldManifest, custom: { "gameharness:terra_work_wire": 11 } })],
  ["malformed work-wire marker", actor({ ...oldManifest, custom: { "gameharness:terra_work_wire": "9" } })],
  ["malformed JAR", Buffer.from("not a JAR")],
  ["missing", null],
] as const) {
  test(`Terra staging rejects a ${kind} actor with rebuild instructions`, async () => {
    const file = await artifact(bytes ?? Buffer.alloc(0));
    const root = dirname(file);
    if (bytes === null) await rm(file);
    await writeFile(join(root, "fabric.mod.json"), JSON.stringify(terraManifest)); // A sidecar cannot admit a build.
    const client = new MinecraftClient(root, { dataDir: root });
    await expect(client.stageAgentArtifact(file, true)).rejects.toThrow("bun run build:agent");
  });
}

for (const [kind, bytes, requireTerraWorkWire] of [
  ["Terra", actor(terraManifest), true],
  ["deterministic or pinned trial", actor(oldManifest), false],
] as const) {
  test(`${kind} staging hashes exactly the installed actor bytes`, async () => {
    const file = await artifact(bytes);
    const root = dirname(file);
    const client = new MinecraftClient(root, { dataDir: root });
    const hash = await client.stageAgentArtifact(file, requireTerraWorkWire);
    expect(await readFile(join(client.directory, "mods/survival-agent.jar"))).toEqual(bytes);
    expect(hash).toBe(createHash("sha256").update(bytes).digest("hex"));
  });
}
