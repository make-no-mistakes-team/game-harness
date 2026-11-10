import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import type { Json, RuntimeAdapter } from "../shared/contracts.ts";
import type { SkillRef, SkillView } from "../shared/programs.ts";
import { PREPARED_START_LIMITS } from "../shared/prepared-start.ts";
import { canonicalContractJson } from "./adapter-contract.ts";
import { programWriteSchema } from "./program-interface.ts";
import { buildArtifactModuleBundle, resolveArtifactModuleClosure, type ProgramArtifactCatalog } from "./program-modules.ts";
import { PROGRAM_LIMITS, validateSkill } from "./program-validation.ts";
import { PreparedSourceFault } from "./prepared-source-error.ts";

type Append = (type: string, details: Json) => void;
export const inactivePreparedWriteSchema = programWriteSchema.omit({ reason: true });

/** Private immutable history; all mutations and their replay receipt share one durable journal row. */
export class PreparedSourcebook implements ProgramArtifactCatalog {
  private readonly definitions = new Map<string, SkillView>();
  private readonly latest = new Map<string, SkillView>();
  private readonly receipts = new Map<string, { identity: string; value: Json }>();
  private bytes = 0;
  private sealed = false;
  constructor(readonly compatibility_hash: string, private readonly adapter: RuntimeAdapter,
    private readonly append: Append, private readonly current: () => void) {}

  get versions(): number { return this.definitions.size; }
  get sourceBytes(): number { return this.bytes; }
  read(ref: SkillRef): SkillView {
    const value = this.definitions.get(`${ref.skill_id}:${ref.version}`);
    if (!value) throw new PreparedSourceFault("No exact immutable definition in this preparation");
    return structuredClone(value);
  }
  select(ref: { name: string; version?: number }): SkillView {
    const latest = this.latest.get(ref.name);
    if (!latest) throw new PreparedSourceFault("No prepared program with this name");
    return this.read({ skill_id: latest.skill_id, version: ref.version ?? latest.version });
  }
  catalog(): Json {
    return [...this.latest.values()].map(value => ({ name: value.name, version: value.version,
      entry: value.entry ?? null, hash: value.hash, card: value.card as unknown as Json }));
  }
  receipt(callId: string, identity: string): Json | undefined {
    const previous = this.receipts.get(callId);
    if (!previous) return undefined;
    if (previous.identity !== identity) throw new PreparedSourceFault("Prepared tool call identity conflicts with its immutable receipt");
    return structuredClone(previous.value);
  }
  complete(callId: string, identity: string, value: Json): void {
    this.append("tool.receipt", { call_id: callId, identity, value });
    this.receipts.set(callId, { identity, value: structuredClone(value) });
  }
  seal(): void { this.current(); this.sealed = true; }
  private writable(): void {
    this.current();
    if (this.sealed) throw new PreparedSourceFault("Prepared source selection is already sealed");
  }
  async write(raw: unknown, callId: string, requestId: string): Promise<Json> {
    const input = inactivePreparedWriteSchema.parse(raw);
    const identity = canonicalContractJson({ tool: "program_write", input });
    const replay = this.receipt(callId, identity);
    if (replay !== undefined) return replay;
    this.writable();
    const parent = this.latest.get(input.name);
    if (parent ? input.based_on !== parent.version : input.based_on !== undefined)
      throw new PreparedSourceFault("Source revision conflicts with the latest immutable parent; inspect and explicitly select based_on");
    const dependencies = input.dependencies.map(ref => {
      const selected = this.select(ref);
      if (ref.import_path !== undefined ? selected.entry !== "library" : input.entry !== "step" && input.entry !== "run" || selected.entry !== "run")
        throw new PreparedSourceFault("Imports require pinned pure libraries; semantic dependencies require run children");
      return { skill_id: selected.skill_id, version: selected.version,
        ...(ref.import_path === undefined ? {} : { import_path: ref.import_path }) };
    });
    const validated = await validateSkill({ entry: input.entry, name: input.name, source: input.source,
      card: input.card, dependencies }, this.adapter);
    this.writable();
    if (this.latest.get(input.name) !== parent) throw new PreparedSourceFault("Source parent changed during validation");
    const size = Buffer.byteLength(validated.source, "utf8");
    if (size > PROGRAM_LIMITS.source_bytes) throw new PreparedSourceFault("Canonical source exceeds the per-definition byte bound");
    if (this.versions >= PREPARED_START_LIMITS.max_source_versions || this.bytes + size > PREPARED_START_LIMITS.max_source_bytes)
      throw new PreparedSourceFault("Finite all-history prepared source budget exhausted");
    const definition: SkillView = { ...validated, skill_id: parent?.skill_id ?? randomUUID(),
      version: (parent?.version ?? 0) + 1, parent_version: parent?.version ?? null,
      hash: createHash("sha256").update(validated.source, "utf8").digest("hex"), state: "validated", created_at: new Date().toISOString() };
    if (definition.entry !== "run") resolveArtifactModuleClosure(this, definition);
    this.captureSources(definition);
    const value = this.publicSource(definition);
    this.append("source.written", { request_id: requestId, tool_call_id: callId, identity,
      provenance: "selected_model_tool_output", definition: definition as unknown as Json, receipt: value });
    this.definitions.set(`${definition.skill_id}:${definition.version}`, structuredClone(definition));
    this.latest.set(definition.name, definition); this.bytes += size;
    this.receipts.set(callId, { identity, value: structuredClone(value) });
    return value;
  }
  publicSource(value: SkillView): Json {
    return { name: value.name, version: value.version, entry: value.entry ?? null, source: value.source,
      hash: value.hash, card: value.card as unknown as Json, based_on: value.parent_version,
      dependencies: value.dependencies.map(ref => { const child = this.read(ref); return { name: child.name,
        version: child.version, ...(ref.import_path === undefined ? {} : { import_path: ref.import_path }) }; }),
      validation: value.validation as unknown as Json, qualification: "source_only_not_gameplay_evidence" };
  }
  bundle(root: SkillView, executive = false) { return buildArtifactModuleBundle(this, root, undefined, executive); }
  /** Includes semantic child trees and even unused declared libraries, not just inline ESM bytes. */
  sources(root: SkillView): SkillView[] {
    return this.captureSources(this.read(root));
  }
  private captureSources(root: SkillView): SkillView[] {
    const values = new Map<string, SkillView>(), heights = new Map<string, number>(), active = new Set<string>();
    const visit = (value: SkillView, depth: number): number => {
      if (depth > 8) throw new PreparedSourceFault("Prepared dependency closure exceeds depth eight");
      const key = `${value.skill_id}:${value.version}`;
      if (active.has(key)) throw new PreparedSourceFault("Prepared dependency closure contains a cycle");
      const previous = heights.get(key);
      if (previous !== undefined) {
        if (depth + previous - 1 > 8) throw new PreparedSourceFault("Prepared dependency closure exceeds depth eight");
        return previous;
      }
      active.add(key);
      let height = 1;
      for (const ref of value.dependencies) height = Math.max(height, visit(this.read(ref), depth + 1) + 1);
      active.delete(key); heights.set(key, height);
      // Store imports require every exact dependency to precede its consumer.
      values.set(key, value);
      return height;
    };
    visit(root, 1); return structuredClone([...values.values()]);
  }
}
