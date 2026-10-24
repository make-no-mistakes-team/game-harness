import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExperienceLibrary } from "../src/server/experience.ts";
import { ReactiveRuntime } from "../src/server/reactive.ts";
import { Store, type StoredRun } from "../src/server/store.ts";
import { emptyRunUsage } from "../src/server/usage.ts";
import { fetchExperience } from "../web/src/api.ts";
import { binding, historicalObservation, minecraftObservationFixture, minecraftTestAdapter, minecraftTestBinding, sha256 } from "./helpers/adapter-contract.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
const card = { purpose: "Retain historical evidence", applicability: "Read-only historical artifact",
  method: "Keep source and outcomes exactly", reason: "No protocol relabeling", limitations: "Cannot activate" };
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "gameharness-adapter-history-"));
  const store = new Store(directory);
  const run: StoredRun = { run_id: "history-run", world_id: "history-world", session_id: "history-session", life_id: 1, epoch: 1,
    native_boot_id: null, space_epoch: null, compatibility_hash: null,
    task: "Historical task", goal: "custom", model_id: "fixture-model", status: "running", started_at: "2026-10-22T00:00:00Z",
    ended_at: null, turns: 0, model_status: "idle", error: null, baseline: {}, usage: emptyRunUsage() };
  store.saveRun(run);
  cleanups.push(async () => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, store, run };
}
function historicalBundle() {
  return { experience_id: "3".repeat(64), name: "API3 immutable history", model_id: "fixture-model",
    profile_id: "player-observable-structured", preset_id: "minecraft-observable-initial-r2",
    source_run_id: "history-run", source_world_id: "history-world", portability: "portable", retained_world_data: false,
    compatibility: { adapter_id: "fabric-owned-client", game_version: "1.21.4", observation_schema: 2,
      profile_id: "player-observable-structured", preset_id: "minecraft-observable-initial-r2", skill_protocol: 3 },
    root: { skill_id: "historical-source", version: 1 }, created_at: "2026-10-22T00:00:00Z",
    evidence: { execution_id: "historical-execution", action_ids: ["historical-action"], predicate: { kind: "goal_verified", event_seq: 1 } },
    skills: [] } as const;
}

test("API3 experience remains byte-identical inspectable history but cannot enter API4 selected libraries", async () => {
  const f = fixture(), directory = join(f.directory, "library");
  const current = binding();
  const compatibility = { descriptor: current.descriptor, compatibility_hash: current.compatibility_hash };
  const library: ExperienceLibrary = Reflect.construct(ExperienceLibrary, [directory, compatibility]);
  const db = new Database(join(directory, "experience.sqlite"));
  const bundle = historicalBundle(), bytes = JSON.stringify(bundle);
  try {
    db.query("INSERT INTO bundles(id,model,payload) VALUES(?,?,?)").run(bundle.experience_id, bundle.model_id, bytes);
    expect(library.inspect(bundle.experience_id, bundle.model_id)?.compatibility).toEqual(bundle.compatibility);
    expect(library.list(bundle.model_id, bundle.source_world_id)).toEqual([]);
    expect(library.catalog(bundle.model_id, bundle.source_world_id, 0, 20).records).toEqual([]);
    expect(library.named(bundle.model_id, bundle.source_world_id, bundle.name)).toBeNull();
    let imports = 0;
    const manager = { importSnapshot: async () => { imports++; throw new Error("History must never reach active import"); } };
    await expect(Reflect.apply(library.hydrate, library, [bundle.experience_id, bundle.model_id,
      bundle.source_world_id, f.run.run_id, manager])).rejects.toThrow();
    expect(imports).toBe(0);
    expect(db.query<{ payload: string }, [string]>("SELECT payload FROM bundles WHERE id=?").get(bundle.experience_id)?.payload).toBe(bytes);
  } finally { db.close(); library.close(); }
});

test("selected libraries use stable descriptor content, not object identity or adapter_id equality", () => {
  const f = fixture(), directory = join(f.directory, "library"), current = binding();
  const compatibility = { descriptor: current.descriptor, compatibility_hash: current.compatibility_hash };
  const library: ExperienceLibrary = Reflect.construct(ExperienceLibrary, [directory, compatibility]);
  const db = new Database(join(directory, "experience.sqlite"));
  const matching = { ...historicalBundle(), experience_id: "4".repeat(64), name: "Matching API4 library",
    profile_id: current.descriptor.observation.profile.id, compatibility };
  const changedDescriptor = structuredClone(current.descriptor);
  changedDescriptor.observation.profile.configuration.motor_profile = "precise";
  changedDescriptor.observation.profile.configuration_hash = sha256(changedDescriptor.observation.profile.configuration);
  const mismatched = { ...matching, experience_id: "5".repeat(64), name: "Same adapter incompatible profile",
    compatibility: { descriptor: changedDescriptor, compatibility_hash: sha256(changedDescriptor) } };
  try {
    for (const [index, value] of [matching, mismatched].entries())
      db.query("INSERT INTO bundles(id,model,payload,revision) VALUES(?,?,?,?)").run(value!.experience_id, value!.model_id, JSON.stringify(value), index + 1);
    expect(library.list(matching.model_id, matching.source_world_id).map(value => value.experience_id)).toEqual([matching.experience_id]);
    expect(library.named(matching.model_id, matching.source_world_id, matching.name)?.experience_id).toBe(matching.experience_id);
    expect(library.named(mismatched.model_id, mismatched.source_world_id, mismatched.name)).toBeNull();
  } finally { db.close(); library.close(); }
});

test("browser experience history reads schema2/API3 without stripping or relabeling compatibility", async () => {
  const originalFetch = globalThis.fetch, originalWindow = Reflect.get(globalThis, "window");
  const bundle = historicalBundle();
  Reflect.set(globalThis, "window", { setTimeout, clearTimeout });
  globalThis.fetch = Object.assign(async () => Response.json({ experience: [bundle] }), { preconnect: originalFetch.preconnect });
  try {
    const values = await fetchExperience(bundle.model_id);
    expect(values).toHaveLength(1);
    expect(values[0]!.compatibility).toEqual(bundle.compatibility);
    expect(values[0]!.root).toEqual(bundle.root);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) Reflect.deleteProperty(globalThis, "window");
    else Reflect.set(globalThis, "window", originalWindow);
  }
});

test("schema2 observation/source/outcome bytes remain readable with their original identities", () => {
  const f = fixture();
  const source = '// API3 retained bytes, not freshly canonicalized\nreturn {status:"blocked", summary:"original outcome", result:null};\n';
  const hash = createHash("sha256").update(source).digest("hex");
  const old = f.store.registerSkill(f.run.run_id, { name: "Historical API3 source", source, card, dependencies: [],
    validation: { runtime_version: 3, fingerprint: "immutable-api3-validator", formatted_lines: 2, complexity: 1, nesting: 0 } });
  const event = f.store.event(f.run.run_id, "observation.historical", "Original observation", historicalObservation());
  const outcome = { status: "unknown", effect_confirmed: false, note: "original outcome" };
  f.store.event(f.run.run_id, "action.historical", "Original unresolved outcome", outcome);
  const before = f.store.eventsAfter(f.run.run_id, 0, 500);
  expect(f.store.skill(f.run.run_id, old)).toMatchObject({ source, hash, validation: { runtime_version: 3, fingerprint: "immutable-api3-validator" } });
  expect(before.find(value => value.event_seq === event.event_seq)?.details).toEqual(historicalObservation());
  expect(before.find(value => value.type === "action.historical")?.details).toEqual(outcome);
  expect(f.store.eventsAfter(f.run.run_id, 0, 500)).toEqual(before);
});

test("cached historical policies cannot activate just because their source remains canonical", async () => {
  const f = fixture();
  const source = 'return { kind: "continue" };\n', hash = createHash("sha256").update(source).digest("hex");
  const policy = { policy_id: "historical-policy", version: 1, name: "Historical reaction", backend: "javascript", choices: null,
    source, hash, card, priority: 1, interval_ms: 1000, state: "validated", evaluations: 0, effects: 0, last_error: null,
    validation: { runtime_version: 3 as const, validator_version: 2, fingerprint: "historical-policy" } };
  // Persist original retained bytes, never route API3 through current executable
  // registration or manufacture a skill execution to obtain a source artifact.
  writeFileSync(join(f.directory, "artifacts", `${hash}.js`), source, { mode: 0o600 });
  const { source: _source, ...metadata } = policy;
  const db: Database = Reflect.get(f.store, "db");
  db.query("INSERT INTO policies(policy_id,run_id,version,name,hash,metadata) VALUES(?,?,?,?,?,?)").run(policy.policy_id,
    f.run.run_id, 1, policy.name, hash, JSON.stringify(metadata));
  let allocated = 0;
  const adapter = minecraftTestAdapter(), currentBinding = minecraftTestBinding(adapter);
  const state = { status: "connected", world_id: f.run.world_id, session_id: f.run.session_id, epoch: 1,
    life: { life_id: 1, status: "alive", can_respawn: false, death: null }, binding: currentBinding,
    space: { dimension_id: "minecraft:overworld", space_epoch: 1 }, screen: null, error: null };
  const sandbox = { createWorker: async () => { allocated++; throw new Error("Historical policy must reject before worker allocation"); } };
  const actions = { close: async () => {}, cancelPolicy: async () => {} };
  const host = { run: () => f.run, generation: () => 1, assertCurrent: () => f.run,
    adapter: () => adapter, binding: () => currentBinding,
    context: async () => ({ observation: minecraftObservationFixture(adapter, { world_id: f.run.world_id, session_id: f.run.session_id! }), action: null, task: f.run.task }),
    gameState: () => state, needsReconnect: () => false, wake: () => {}, changed: () => {}, admitted: () => {},
    neutralize: async () => {}, closePrograms: async () => {} };
  const reactions: ReactiveRuntime = Reflect.construct(ReactiveRuntime, [f.store, sandbox, actions, host]);
  reactions.initialize(f.run.run_id);
  try {
    await expect(reactions.activate({ policy_id: policy.policy_id, version: policy.version, epoch: 1,
      mode: "trial", max_ms: 1000, max_actions: 1, max_evaluations: 1 }, 1)).rejects.toMatchObject({ code: "precondition_failed" });
    expect(allocated).toBe(0);
    expect(f.store.policies(f.run.run_id)[0]!.source).toBe(policy.source);
    expect(Reflect.get(f.store.policies(f.run.run_id)[0]!, "validation")).toEqual(Reflect.get(policy, "validation"));
  } finally { await reactions.closeAll(false); }
});
