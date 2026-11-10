import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { ExecutableModuleBundle } from "./programs.ts";

type ModuleRow = ExecutableModuleBundle["modules"][number];
const digest = (source: string) => createHash("sha256").update(source, "utf8").digest("hex");
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

/** Exact canonical file bytes remain the identity of roots without imports. */
export function executableModuleBundleHash(entry: ExecutableModuleBundle["entry"], modules: readonly ModuleRow[]): string {
  if (modules.length === 1 && modules[0]!.id === "root" && modules[0]!.imports.length === 0)
    return digest(modules[0]!.source);
  return digest(JSON.stringify({ schema_version: 1, entry, root: "root", modules: [...modules]
    .sort((a, b) => compare(a.id, b.id)).map(module => ({ id: module.id, source: module.source,
      source_hash: module.source_hash, imports: [...module.imports].sort((a, b) => compare(a.specifier, b.specifier))
        .map(binding => ({ specifier: binding.specifier, module_id: binding.module_id })) })) }));
}

/** For already canonical, import-free sources in standalone scripts and tests. */
export function singletonExecutableModuleBundle(source: string, entry: ExecutableModuleBundle["entry"]): ExecutableModuleBundle {
  const source_hash = digest(source);
  return { schema_version: 1, entry, root: "root", source_hash,
    modules: [{ id: "root", source, source_hash, imports: [] }] };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}
export function isLocalModuleSpecifier(value: string): boolean {
  return /^\.\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:js|mjs)$/.test(value);
}
function moduleId(value: unknown): value is string {
  if (value === "root") return true;
  if (typeof value !== "string" || !value.startsWith("module:") || value.length > 512) return false;
  try {
    const ref: unknown = JSON.parse(value.slice(7));
    return Array.isArray(ref) && ref.length === 2 && typeof ref[0] === "string" && ref[0].length > 0 &&
      ref[0].length <= 80 && ref[0].trim().length > 0 && Number.isSafeInteger(ref[1]) && ref[1] > 0 &&
      value === `module:${JSON.stringify(ref)}`;
  } catch { return false; }
}

/** Validate only captured data: no filesystem resolution or implicit alias discovery. */
export function assertExecutableModuleBundle(value: unknown, expectedEntry?: ExecutableModuleBundle["entry"]): asserts value is ExecutableModuleBundle {
  const fail = (): never => { throw new Error("Invalid executable module bundle."); };
  if (!record(value) || !keys(value, ["schema_version", "entry", "root", "source_hash", "modules"]) ||
    value.schema_version !== 1 || !["step", "analyze"].includes(value.entry as string) ||
    (expectedEntry !== undefined && value.entry !== expectedEntry) || value.root !== "root" ||
    typeof value.source_hash !== "string" || !/^[a-f0-9]{64}$/.test(value.source_hash) ||
    !Array.isArray(value.modules) || value.modules.length < 1 || value.modules.length > 32) fail();
  const bundle = value as unknown as ExecutableModuleBundle;
  if (Buffer.byteLength(JSON.stringify(bundle), "utf8") > 262144) fail();
  const rows = new Map<string, ModuleRow>();
  let bytes = 0;
  for (const row of bundle.modules) {
    if (!record(row) || !keys(row, ["id", "source", "source_hash", "imports"]) || !moduleId(row.id) ||
      rows.has(row.id) || typeof row.source !== "string" || Buffer.byteLength(row.source, "utf8") > 16384 ||
      typeof row.source_hash !== "string" || row.source_hash !== digest(row.source) ||
      !Array.isArray(row.imports) || row.imports.length > 32) fail();
    bytes += Buffer.byteLength(row.source, "utf8");
    if (bytes > 65536) fail();
    const aliases = new Set<string>();
    for (const binding of row.imports) {
      if (!record(binding) || !keys(binding, ["specifier", "module_id"]) ||
        typeof binding.specifier !== "string" || binding.specifier.length > 512 ||
        !isLocalModuleSpecifier(binding.specifier) || aliases.has(binding.specifier) ||
        !moduleId(binding.module_id) || binding.module_id === "root") fail();
      aliases.add(binding.specifier);
    }
    rows.set(row.id, row);
  }
  const active = new Set<string>(), heights = new Map<string, number>();
  const visit = (id: string): number => {
    const cached = heights.get(id);
    if (cached !== undefined) return cached;
    const row = rows.get(id);
    if (!row || active.has(id)) return fail();
    active.add(id);
    let height = 1;
    for (const binding of row.imports) height = Math.max(height, visit(binding.module_id) + 1);
    active.delete(id);
    if (height > 8) return fail();
    heights.set(id, height);
    return height;
  };
  visit("root");
  if (heights.size !== rows.size || bundle.source_hash !== executableModuleBundleHash(bundle.entry, bundle.modules)) fail();
}
