import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import type { Json } from "../shared/contracts.ts";
import { jsonSchema } from "../shared/primitives.ts";

export interface NativeArtifactContract { artifact_sha256: string; resource: Json }
const MAX_JAR_BYTES = 64 * 1024 * 1024, MAX_RESOURCE_BYTES = 1024 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Read one JSON contract entry from actual JAR bytes; no extraction, sidecar, CLI or ZIP64 guessing. */
export async function readNativeArtifactContract(
  artifact: string, entry = "gameharness-native-contract.json",
): Promise<NativeArtifactContract> {
  const resourceName = Buffer.from(entry);
  const handle = await open(artifact, "r");
  let bytes: Buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 22 || stat.size > MAX_JAR_BYTES) throw new Error("Native artifact size is invalid");
    bytes = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) throw new Error("Native artifact changed during preparation");
      offset += result.bytesRead;
    }
    const final = await handle.stat();
    if (final.size !== stat.size || final.mtimeMs !== stat.mtimeMs) throw new Error("Native artifact changed during preparation");
  } finally { await handle.close(); }
  let end = -1;
  for (let offset = bytes.length - 22, minimum = Math.max(0, bytes.length - 65557); offset >= minimum; offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) {
      end = offset; break;
    }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0)
    throw new Error("Native artifact has no supported single-disk ZIP directory");
  const count = bytes.readUInt16LE(end + 10), centralSize = bytes.readUInt32LE(end + 12), central = bytes.readUInt32LE(end + 16);
  if (count === 0xffff || bytes.readUInt16LE(end + 8) !== count || central === 0xffffffff || centralSize === 0xffffffff || central + centralSize > end)
    throw new Error("Native artifact has an unsupported or malformed ZIP directory");
  const centralEnd = central + centralSize;
  let cursor = central, resource: Json | undefined;
  for (let entry = 0; entry < count; entry++) {
    if (cursor + 46 > centralEnd || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error("Malformed native JAR entry");
    const nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > centralEnd) throw new Error("Truncated native JAR entry");
    const matching = nameLength === resourceName.length && bytes.subarray(cursor + 46, cursor + 46 + nameLength).equals(resourceName);
    if (matching) {
      if (resource !== undefined) throw new Error("Duplicate native contract resources are not authoritative");
      const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), crc = bytes.readUInt32LE(cursor + 16);
      const compressed = bytes.readUInt32LE(cursor + 20), length = bytes.readUInt32LE(cursor + 24), local = bytes.readUInt32LE(cursor + 42);
      if ((flags & 1) !== 0 || method !== 0 && method !== 8 || compressed > MAX_RESOURCE_BYTES * 2 || length > MAX_RESOURCE_BYTES ||
        local + 30 > central || bytes.readUInt32LE(local) !== 0x04034b50)
        throw new Error("Unsupported or oversized native contract resource");
      const localNameLength = bytes.readUInt16LE(local + 26), localExtraLength = bytes.readUInt16LE(local + 28);
      const payload = local + 30 + localNameLength + localExtraLength;
      if (payload + compressed > central || localNameLength !== resourceName.length ||
        !bytes.subarray(local + 30, local + 30 + localNameLength).equals(resourceName) ||
        bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method)
        throw new Error("Native JAR directory and local contract entry disagree");
      const encoded = bytes.subarray(payload, payload + compressed);
      const decoded = method === 0 ? encoded : inflateRawSync(encoded, { maxOutputLength: Math.max(1, length) });
      if (decoded.length !== length || (Bun.hash.crc32(decoded) >>> 0) !== crc) throw new Error("Native contract resource checksum mismatch");
      resource = jsonSchema.parse(JSON.parse(utf8.decode(decoded)));
    }
    cursor = next;
  }
  if (cursor !== centralEnd || resource === undefined) throw new Error("Actual native JAR contract resource is missing or malformed");
  return { artifact_sha256: createHash("sha256").update(bytes).digest("hex"), resource };
}
