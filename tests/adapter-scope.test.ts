import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionArbiter } from "../src/server/action-arbiter.ts";
import { SkillManager } from "../src/server/skills.ts";
import { Store, type StoredRun } from "../src/server/store.ts";
import { validateSkill } from "../src/server/program-validation.ts";
import { DEFAULT_SKILL_LIMITS } from "../src/shared/programs.ts";
import type { GameAction, GameActionResult, GameBridge } from "../src/shared/contracts.ts";
import type { ControllerInputChannel, RevocationAck } from "../src/shared/controller.ts";
import { ControllerInputs } from "../src/server/controller-inputs.ts";
import { effectScope, executionScopeFixture, minecraftObservationFixture, minecraftRunFixture, minecraftTestAdapter, minecraftTestBinding } from "./helpers/adapter-contract.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const card = { purpose: "Exercise host effect ownership", applicability: "Isolated contract fixture",
  method: "Admit through the real store and arbiter", reason: "Reject stale queued authority",
  limitations: "No native gameplay or second-game support claim" };
const success: GameActionResult = { status: "succeeded", summary: "Contract emitter settled", evidence: { effect_confirmed: true } };

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "gameharness-adapter-scope-"));
  const store = new Store(directory), scope = effectScope(), adapter = minecraftTestAdapter();
  const run = minecraftRunFixture(adapter, { run_id: scope.run_id, world_id: scope.world_id, epoch: scope.epoch,
    session_id: scope.session_id, life_id: scope.life_id, native_boot_id: scope.native_boot_id, space_epoch: scope.space_epoch, task: "Scope conformance only", model_id: "contract-model" });
  store.saveRun(run);
  const validated = await validateSkill({ entry: "run", name: "Scoped source", source:
    'return {status:"completed",summary:"Contract only",result:null};', card, dependencies: [] },
    adapter);
  const skill = await store.registerSkill(run.run_id, validated);
  const execution = store.admitSkill(run.run_id, { entry: "run", skill_id: skill.skill_id, version: skill.version,
    start_key: "host-start", ...executionScopeFixture(run, scope.run_generation),
    args: {}, limits: DEFAULT_SKILL_LIMITS }).view;
  const state = { status: "connected" as const, username: "fixture", version: "1.21.4", world_id: scope.world_id,
    epoch: scope.epoch, session_id: scope.session_id,
    life: { life_id: scope.life_id, status: "alive" as const, can_respawn: false, death: null },
    binding: minecraftTestBinding(adapter, scope.native_boot_id), space: { dimension_id: "minecraft:overworld", space_epoch: scope.space_epoch },
    screen: { screen_id: "visible-view", incarnation: 2, revision: 3 },
    presentation: null,
    last_observation_at: null, error: null,
    video: { status: "streaming" as const, width: 2, height: 2, fps: 30, frames: 1, last_frame_at: null, error: null } };
  const applied: unknown[] = [], cancellationOwners: unknown[] = [];
  const emitted = Promise.withResolvers<void>();
  let generation = scope.run_generation, currentSource = skill.hash;
  let emitter = async (_value: unknown, _signal: AbortSignal): Promise<GameActionResult> => success;
  const observe = async () => minecraftObservationFixture(adapter, { world_id: scope.world_id, session_id: scope.session_id, epoch: scope.epoch,
    native_boot_id: scope.native_boot_id, life: state.life, space: state.space, screen: state.screen });
  const game: GameBridge = {
    connect: async () => {}, disconnect: async () => {}, snapshot: () => structuredClone(state),
    observe, adapter: () => adapter,
    subscribe: () => () => {}, neutralize: async () => {},
    emergencyStop: async () => {},
    cancel: async (...args: unknown[]) => { cancellationOwners.push(args[1]); },
    execute: async (value, signal) => { applied.push(value); emitted.resolve(); return await emitter(value, signal); },
  };
  const host = { run: () => run, generation: () => generation, needsReconnect: () => false,
    changed: () => {}, wake: () => {}, pause: () => {}, uncertain: () => {}, admitted: () => {},
    observe, adapter: () => adapter, effect: () => {}, settled: () => {},
    invocation: (id: string) => ({ kind: "skill" as const, execution_id: id, source_hash: currentSource }),
    effectScope: (id: string) => ({ ...scope, execution_id: id, source_hash: currentSource, run_generation: generation }) };
  const arbiter = new ActionArbiter(store, game, host);
  cleanup.push(async () => { await arbiter.close("Fixture cleanup"); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, run, state, skill, execution, adapter, observe, arbiter, game, applied, emitted, cancellationOwners,
    setEmitter: (next: typeof emitter) => { emitter = next; },
    replaceSource: () => { currentSource = "f".repeat(64); },
    replaceGeneration: () => { generation++; },
    admit: (id = "scope-action", action: GameAction = { kind: "look", yaw: 0, pitch: 0 }) =>
      arbiter.admit(id, action, 0, undefined, null, execution.execution_id) };
}

test("resident reservation blocks finite admission until confirmed old-owner retirement", async () => {
  const f = await fixture(), retired = Promise.withResolvers<RevocationAck>();
  const drained = Promise.withResolvers<void>(), draining = Promise.withResolvers<void>();
  let fenced = false, settled = false;
  f.game.openController = async (reservation, generation) => {
    const owner = { operation_id: reservation.operation_id, scope: reservation.scope, generation: 1 };
    const ledger = new ControllerInputs(owner, generation);
    const channel: ControllerInputChannel = {
      owner, controllerGeneration: generation,
      sample: async () => { throw new Error("No sensor in this isolated authority fixture"); },
      submit: () => { throw new Error("No actuator in this isolated authority fixture"); },
      renew: async (_frame) => { throw new Error("No native clock in this isolated authority fixture"); },
      revoke: () => retired.promise, snapshot: () => ledger.snapshot(),
    };
    return channel;
  };
  const channel = await f.arbiter.reserveController(f.execution.execution_id, 1, performance.now() + 5000, () => {}, () => {}, {
    fence: () => { fenced = true; }, drain: async () => { draining.resolve(); await drained.promise; },
  });
  cleanup.unshift(async () => { drained.resolve(); retired.resolve({ owner: channel.owner, controller_generation: 1,
    admission_revoked: true, last_applied_sequence: 0, ordered_edge_prefix: 0,
    retirement_applied_native_tick: 7, retirement_applied_native_ns: "123456",
    input_application: "confirmed", unresolved_operation_refs: [] }); });
  expect(f.arbiter.busy).toBe(true);
  expect(() => f.admit("blocked-by-controller")).toThrow();
  expect(f.store.getAction(f.run.run_id, "blocked-by-controller")).toBeNull();
  const barrier = channel.revoke();
  void barrier.then(() => { settled = true; });
  expect(fenced).toBe(true);
  expect(f.arbiter.busy).toBe(true);
  expect(() => f.admit("blocked-by-retiring-controller")).toThrow();
  retired.resolve({ owner: channel.owner, controller_generation: 1, admission_revoked: true,
    last_applied_sequence: 0, ordered_edge_prefix: 0, retirement_applied_native_tick: 7,
    retirement_applied_native_ns: "123456", input_application: "confirmed", unresolved_operation_refs: [] });
  await draining.promise;
  expect(settled).toBe(false);
  expect(f.arbiter.busy).toBe(true);
  expect(() => f.admit("native-retired-worker-still-live")).toThrow();
  drained.resolve();
  await barrier;
  expect(f.arbiter.busy).toBe(false);
  f.admit("after-controller-retirement");
  await f.emitted.promise;
  expect(f.store.getAction(f.run.run_id, "after-controller-retirement")?.view.status).not.toBe("cancelled");
});

// A positive control ensures stale tests cannot pass by globally closing effects.
test("one current host invocation reaches the existing arbiter with its complete immutable scope", async () => {
  const f = await fixture();
  f.admit();
  await f.emitted.promise;
  expect(f.applied).toHaveLength(1);
  expect(f.applied[0]).toMatchObject({
    operation_id: "scope-action",
    scope: { ...effectScope(), execution_id: f.execution.execution_id, source_hash: f.skill.hash },
    invocation: { kind: "skill", execution_id: f.execution.execution_id, source_hash: f.skill.hash },
    compatibility_hash: f.state.binding.compatibility_hash,
    action: { kind: "look", yaw: 0, pitch: 0 },
  });
});

test("closed-view admission sends explicit absent authority rather than an unrestricted omission", async () => {
  const f = await fixture();
  Reflect.set(f.state, "screen", null);
  f.admit("no-screen-operation");
  await f.emitted.promise;
  expect(f.applied[0]).toHaveProperty("expected_screen", { kind: "absent" });
});

test("GUI layout admission survives unrelated transactional revision changes", async () => {
  const f = await fixture();
  f.admit("persistent-screen", { kind: "screen_input",
    screen: { screen_id: f.state.screen.screen_id, incarnation: f.state.screen.incarnation, layout_revision: 1 }, operations: [] });
  f.state.screen.revision++;
  await f.emitted.promise;
  expect(f.applied[0]).toHaveProperty("expected_screen", { kind: "layout",
    screen: { screen_id: "visible-view", incarnation: 2, layout_revision: 1 } });
});

test("queued GUI layout cannot dispatch after its handler is replaced", async () => {
  const f = await fixture();
  f.admit("stale-screen", { kind: "screen_input",
    screen: { screen_id: f.state.screen.screen_id, incarnation: f.state.screen.incarnation, layout_revision: 1 }, operations: [] });
  f.state.screen.incarnation++;
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(f.applied).toEqual([]);
  expect(f.store.getAction(f.run.run_id, "stale-screen")?.view.status).toBe("cancelled");
});

for (const transition of ["boot", "life", "dimension", "same-dimension relocation", "screen instance", "screen revision", "source", "run generation", "descriptor"] as const) {
  test(`queued old scope is rechecked after ${transition} before any effect dispatch`, async () => {
    const f = await fixture();
    // Admission queues a real durable action; its pump runs in the next microtask.
    // The transition deliberately occurs between receive/admission and application.
    f.admit();
    switch (transition) {
      case "boot": f.state.binding.native_boot_id = "replacement-boot"; break;
      case "life": f.state.life.life_id++; break;
      case "dimension": f.state.space = { dimension_id: "minecraft:the_nether", space_epoch: f.state.space.space_epoch + 1 }; break;
      case "same-dimension relocation": f.state.space.space_epoch++; break;
      case "screen instance": f.state.screen.incarnation++; break;
      case "screen revision": f.state.screen.revision++; break;
      case "source": f.replaceSource(); break;
      case "run generation": f.replaceGeneration(); break;
      case "descriptor": f.state.binding.compatibility_hash = "0".repeat(64); break;
    }
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.applied).toEqual([]);
    expect(f.store.getAction(f.run.run_id, "scope-action")?.view).toMatchObject({
      status: "cancelled", result: { evidence: { dispatched: false } },
    });
    // Dimension/relocation/screen replacement must not be implemented as death.
    if (["dimension", "same-dimension relocation", "screen instance", "screen revision"].includes(transition))
      expect(f.state.life.life_id).toBe(effectScope().life_id);
  });
}

test("an unready descriptor cannot create a durable accepted action", async () => {
  const f = await fixture(); f.state.binding.ready = false;
  expect(() => f.admit()).toThrow();
  expect(f.store.getAction(f.run.run_id, "scope-action")).toBeNull();
  expect(f.applied).toEqual([]);
});

test("a ready but incompatible descriptor cannot create durable effect admission", async () => {
  const f = await fixture(); f.state.binding.compatibility_hash = "0".repeat(64);
  expect(() => f.admit()).toThrow();
  expect(f.store.getAction(f.run.run_id, "scope-action")).toBeNull();
  expect(f.applied).toEqual([]);
});

test("late expected-owner cleanup cannot cancel a replacement owner", async () => {
  const f = await fixture();
  const first = Promise.withResolvers<GameActionResult>(), replacement = Promise.withResolvers<GameActionResult>();
  f.setEmitter(async () => await first.promise);
  f.admit("first"); await f.emitted.promise;
  const previous = f.arbiter.active;
  expect(previous).not.toBeNull();
  const retired = f.arbiter.awaitRetirement(previous!);
  first.resolve(success); await retired;
  expect(f.store.getAction(f.run.run_id, "first")?.view.status).toBe("succeeded");
  f.setEmitter(async () => await replacement.promise);
  f.admit("replacement", { kind: "look", yaw: 0.5, pitch: 0 });
  await new Promise<void>(resolve => setImmediate(resolve));
  try {
    expect(f.arbiter.active?.entry.stored.view.action_id).toBe("replacement");
    await f.arbiter.cancelExecution(previous!, "Late A cleanup");
    await f.arbiter.cancelOwned(new Set(["obsolete-execution"]), "Late unrelated cleanup");
    expect(f.cancellationOwners).toEqual([]);
    expect(f.store.getAction(f.run.run_id, "replacement")?.view.status).toBe("running");
  } finally {
    const active = f.arbiter.active;
    const drained = active ? f.arbiter.awaitRetirement(active) : Promise.resolve();
    replacement.resolve(success); await drained;
  }
});

// Actual SkillManager/Store fence: changing only the displayed API constant is insufficient.
test("API3 source and outcome remain inspectable but cannot allocate an active worker", async () => {
  const f = await fixture();
  const historical = { ...f.skill, skill_id: "retained-api3-source", name: "Retained API3 source",
    validation: { ...f.skill.validation, runtime_version: 3 } };
  const snapshot = await f.store.importSkill(f.run.run_id, historical);
  let allocations = 0;
  const manager = new SkillManager(f.store, { runSkill: async () => {
    allocations++; return { status: "completed", summary: "Should not allocate", result: null };
  } }, {
    authorize: () => {}, observe: f.observe, action: async () => success, adapter: () => f.adapter, binding: () => f.state.binding,
    queryCapability: async () => [], cancelActions: async () => {}, changed: () => {}, unsafe: () => {},
    recover: async () => { throw new Error("No recovery in a historical read"); },
  });
  try {
    expect(() => manager.start(f.run.run_id, { ...snapshot, entry: "run", start_key: "old-api-attempt", ...executionScopeFixture(f.run, effectScope().run_generation),
      args: { scope: effectScope() }, limits: DEFAULT_SKILL_LIMITS })).toThrow();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(allocations).toBe(0);
    expect(f.store.skillExecution(f.run.run_id, { start_key: "old-api-attempt" })).toBeNull();
    expect(f.store.skill(f.run.run_id, snapshot).source).toBe(historical.source);
    expect(f.store.skill(f.run.run_id, snapshot).validation.runtime_version).toBe(3);
    expect(f.store.skillExecution(f.run.run_id, { execution_id: f.execution.execution_id })).not.toBeNull();
  } finally { await manager.closeAll("Historical fixture complete"); }
});
