import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import type { ActionView, GameAction, GameActionResult, GameBridge, GameState, Observation, PolicyContext, PolicyDecision, PolicySpec } from "../src/shared/contracts.ts";
import { DEFAULT_SKILL_LIMITS } from "../src/shared/programs.ts";
import { ActionArbiter } from "../src/server/action-arbiter.ts";
import { JevBroker } from "../src/server/jev.ts";
import { ReactiveRuntime, activateSchema } from "../src/server/reactive.ts";
import { RuntimeFault } from "../src/server/runtime-fault.ts";
import { SkillManager } from "../src/server/skills.ts";
import type { SandboxService } from "../src/server/sandbox.ts";
import { Store, type StoredRun } from "../src/server/store.ts";
import { emptyRunUsage } from "../src/server/usage.ts";

// Exercise the real asynchronous scheduler, worker, and arbiter handoffs. Await
// their completion signals rather than advancing a process-global fake clock.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  const failures: unknown[] = [];
  try {
    for (const cleanup of cleanups.splice(0).reverse()) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
  } finally {
    setSystemTime();
  }
  if (failures.length) throw new AggregateError(failures, "Reactive fixture cleanup failed");
});
function hold<T>(cleanupValue: T) {
  const gate = Promise.withResolvers<T>();
  cleanups.push(async () => { gate.resolve(cleanupValue); });
  return gate;
}
function event(store: Store, type: string) {
  const signal = Promise.withResolvers<void>();
  const unsubscribe = store.subscribe((value) => {
    if (value.type === type) {
      unsubscribe();
      signal.resolve();
    }
  });
  cleanups.push(async () => { unsubscribe(); });
  return signal.promise;
}
function specification(backend: PolicySpec["backend"] = "javascript"): PolicySpec {
  return {
    backend,
    name: "Lifecycle boundary fixture",
    source: backend === "javascript" ? 'return {kind:"continue"};' : "Choose only a declared scheduler decision from the supplied current state.",
    choices: backend === "jev" ? [
      { id: "wait", decision: { kind: "continue" } },
      { id: "turn", decision: { kind: "replace", action: { kind: "look", yaw: 0.2, pitch: 0 }, reason: "Neutral boundary fixture" } },
    ] : null,
    card: {
      purpose: "Exercise authority boundaries",
      applicability: "Isolated consumer fixture",
      method: "Finite neutral decisions",
      reason: "Reject old-life work",
      limitations: "Not gameplay or live-provider evidence",
    },
    priority: 10,
    interval_ms: 200,
  };
}
function fixture(judge?: JevBroker) {
  const directory = mkdtempSync(join(tmpdir(), "gameharness-reactive-life-"));
  const store = new Store(directory);
  const sessionId = crypto.randomUUID();
  const run: StoredRun = {
    run_id: crypto.randomUUID(), world_id: crypto.randomUUID(), epoch: 1,
    session_id: sessionId, life_id: 1,
    task: "Neutral lifecycle fixture", goal: "custom", model_id: "strategic-not-a-typesafe-judge",
    status: "running", started_at: new Date().toISOString(), ended_at: null,
    turns: 0, model_status: "idle", error: null, usage: emptyRunUsage(), baseline: {},
  };
  store.saveRun(run);
  let observation: Observation = {
    schema_version: 2, world_id: run.world_id, session_id: sessionId, epoch: 1,
    life: { life_id: 1, status: "alive", can_respawn: false, death: null },
    observation_seq: 1, captured_at: new Date().toISOString(),
    profile_id: "player-observable-structured", preset_id: "minecraft-observable-initial-r2",
    player: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 20, food: 20, on_ground: true, in_water: false, inventory: [] },
    blocks: [], entities: [], sounds: [], coverage: { partial: true, max_age_ms: 1000 },
  };
  let state: GameState = {
    status: "connected", username: "Fixture", version: "1.21.4", world_id: run.world_id,
    epoch: 1, session_id: sessionId, life: observation.life, motor_profile: "balanced",
    video: { status: "idle", width: 0, height: 0, fps: null, frames: 0, last_frame_at: null, error: null },
    last_observation_at: observation.captured_at, player: observation.player, error: null,
  };
  let generation = 1;
  let disconnected = false;
  const executed: GameAction[] = [];
  const executions = new Map<number, (() => void)[]>();
  let evaluate: (context: PolicyContext, signal?: AbortSignal) => Promise<PolicyDecision> = async () => ({ kind: "continue" });
  let closePrograms = async () => {};
  let neutralize = async () => {};
  let cancel = async () => {};
  let execute: GameBridge["execute"] = async () => ({
    status: "succeeded", summary: "Neutral fixture action confirmed",
    evidence: { effect_confirmed: true },
  });
  let uncertain: (action: ActionView) => void = (action) => {
    throw new Error(`Unexpected unknown action ${action.action_id} in confirmed-effect lifecycle fixture`);
  };
  let workersClosed = 0;
  const game: GameBridge = {
    connect: async () => {}, disconnect: async () => { disconnected = true; },
    neutralize: async () => { await neutralize(); }, setMotorProfile: async () => {},
    snapshot: () => state, observe: async () => structuredClone(observation),
    execute: async (action, signal) => {
      executed.push(action);
      for (const resolve of executions.get(executed.length) ?? []) resolve();
      executions.delete(executed.length);
      return await execute(action, signal);
    },
    cancel: async () => { await cancel(); }, recipes: async () => [], subscribe: () => () => {},
  };
  const sandbox = {
    createWorker: async () => ({ evaluate: (context: PolicyContext, signal?: AbortSignal) => evaluate(context, signal), close: async () => { workersClosed++; } }),
  } as unknown as SandboxService;
  let reactive: ReactiveRuntime;
  const actions = new ActionArbiter(store, game, {
    run: () => run, generation: () => generation, needsReconnect: () => false,
    changed: () => {}, wake: () => {}, pause: (message) => { throw new Error(message); },
    observe: async () => observation, admitted: () => {},
    effect: (policy, kind, evidence) => reactive.recordEffect(policy, kind, evidence),
    succeeded: () => {},
    uncertain: (action) => uncertain(action),
  });
  reactive = new ReactiveRuntime(store, sandbox, actions, {
    run: () => run, generation: () => generation,
    assertCurrent: (expected, epoch) => {
      if (expected !== generation || (epoch !== undefined && epoch !== run.epoch)) throw new RuntimeFault("stale_context", "Fixture generation revoked");
      return run;
    },
    context: async () => ({ observation: structuredClone(observation), action: actions.view, task: run.task }),
    gameState: () => state, needsReconnect: () => false, wake: () => {}, changed: () => {}, admitted: () => {},
    closePrograms: async () => { await closePrograms(); }, neutralize: () => game.neutralize(),
  }, judge);
  reactive.initialize(run.run_id);
  cleanups.push(async () => {
    try {
      await reactive.closeAll(false);
      await actions.close("Fixture cleanup");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  return {
    reactive, actions, run, store, executed, game,
    execution: (count = 1) => {
      if (executed.length >= count) return Promise.resolve();
      const signal = Promise.withResolvers<void>();
      const pending = executions.get(count) ?? [];
      pending.push(signal.resolve);
      executions.set(count, pending);
      return signal.promise;
    },
    setEvaluator: (value: typeof evaluate) => { evaluate = value; },
    setProgramDrain: (value: typeof closePrograms) => { closePrograms = value; },
    setNeutralize: (value: typeof neutralize) => { neutralize = value; },
    setCancel: (value: typeof cancel) => { cancel = value; },
    setExecutor: (value: typeof execute) => { execute = value; },
    setUncertain: (value: typeof uncertain) => { uncertain = value; },
    nextGeneration: () => { generation++; },
    transition: (life: Observation["life"], session = sessionId) => {
      observation = { ...observation, session_id: session, life, observation_seq: observation.observation_seq + 1 };
      state = { ...state, session_id: session, life };
      run.session_id = session;
      run.life_id = life.life_id;
      store.saveRun(run);
    },
    disconnected: () => disconnected,
    workersClosed: () => workersClosed,
  };
}
async function select(f: { reactive: ReactiveRuntime }, backend: PolicySpec["backend"] = "javascript", maxMs = 120000) {
  const view = await f.reactive.register(specification(backend), 1, 1);
  const ref = { epoch: 1, policy_id: view.policy_id, version: view.version };
  await f.reactive.validate(ref, 1);
  await f.reactive.activate(activateSchema.parse({ ...ref, max_ms: maxMs }), 1);
  return { view, ref };
}
const replacement: PolicyDecision = { kind: "replace", action: { kind: "look", yaw: 0.2, pitch: 0 }, reason: "Neutral lifecycle test" };

test("old-life completion cannot control a same-epoch respawn; selected definitions resume with fresh worker state", async () => {
  const f = fixture();
  const { view } = await select(f);
  const pending = hold<PolicyDecision>({ kind: "continue" });
  const started = Promise.withResolvers<void>();
  f.setEvaluator(async () => { started.resolve(); return await pending.promise; });
  await started.promise;
  f.transition({ life_id: 1, status: "dead", can_respawn: true, death: { death_id: "death-1", at: new Date().toISOString(), message: null } });
  const drained = f.reactive.lifeChanged();
  f.transition({ life_id: 2, status: "alive", can_respawn: false, death: null });
  pending.resolve(replacement);
  await drained;
  expect(f.executed).toHaveLength(0);
  expect(f.disconnected()).toBe(false);
  expect(f.run.epoch).toBe(1);
  expect(view.state).toBe("trial");
  expect(view.effects).toBe(0);
  f.setEvaluator(async () => replacement);
  await f.reactive.resume(1);
  await f.execution();
  expect(f.executed[0]).toEqual({ kind: "look", yaw: 0.2, pitch: 0 });
  expect(f.actions.view?.session_id).toBe(f.run.session_id);
  expect(f.actions.view?.life_id).toBe(2);
  expect(f.workersClosed()).toBeGreaterThanOrEqual(2);
});

test("changed life identity alone rejects async completion before a lifecycle callback arrives", async () => {
  const f = fixture();
  await select(f);
  const pending = hold<PolicyDecision>({ kind: "continue" });
  const started = Promise.withResolvers<void>();
  f.setEvaluator(async () => { started.resolve(); return await pending.promise; });
  await started.promise;
  const stale = event(f.store, "policy.stale_result");
  f.transition({ life_id: 2, status: "alive", can_respawn: false, death: null });
  pending.resolve(replacement);
  await stale;
  expect(f.executed).toHaveLength(0);
});

test("an evaluation begun by an earlier run generation has no effect authority", async () => {
  const f = fixture();
  await select(f);
  const pending = hold<PolicyDecision>({ kind: "continue" });
  const started = Promise.withResolvers<void>();
  f.setEvaluator(async () => { started.resolve(); return await pending.promise; });
  await started.promise;
  const stale = event(f.store, "policy.stale_result");
  f.nextGeneration();
  pending.resolve(replacement);
  await stale;
  expect(f.executed).toHaveLength(0);
});

test("reaction replacement waits for both program worker drain and actual native neutralization", async () => {
  const f = fixture();
  await select(f);
  const drain = hold<void>(undefined);
  const neutral = hold<void>(undefined);
  const draining = Promise.withResolvers<void>();
  const neutralizing = Promise.withResolvers<void>();
  let nativeBarrierRequested = false;
  f.setProgramDrain(async () => { draining.resolve(); await drain.promise; });
  f.setNeutralize(async () => { nativeBarrierRequested = true; neutralizing.resolve(); await neutral.promise; });
  f.setEvaluator(async () => replacement);
  await draining.promise;
  expect(f.executed).toHaveLength(0);
  expect(nativeBarrierRequested).toBe(false);
  drain.resolve();
  await neutralizing.promise;
  expect(f.executed).toHaveLength(0);
  neutral.resolve();
  await f.execution();
});

test("Stop during the final native barrier revokes a previously chosen reactive replacement", async () => {
  const f = fixture();
  await select(f);
  const neutralizationAck = hold<void>(undefined);
  const neutralizationRequested = Promise.withResolvers<void>();
  f.setNeutralize(async () => {
    neutralizationRequested.resolve();
    await neutralizationAck.promise;
  });
  f.setEvaluator(async () => replacement);
  await neutralizationRequested.promise;
  f.run.status = "stopping";
  f.store.saveRun(f.run);
  f.nextGeneration();
  const closed = f.reactive.closeAll(false);
  f.actions.fence("Operator Stop");
  neutralizationAck.resolve();
  await closed;
  await f.actions.close("Operator Stop");
  expect(f.executed).toHaveLength(0);
  expect(f.disconnected()).toBe(false);
});

for (const stopAtBarrier of [false, true]) {
  test(stopAtBarrier
    ? "Stop rejects a direct policy-to-policy replacement after the old execution retires"
    : "a direct policy-to-policy replacement waits for pump retirement before its final native barrier", async () => {
    const f = fixture();
    const cancelled: GameActionResult = {
      status: "cancelled", summary: "Previous policy movement was neutralized",
      evidence: { neutralized_effect: true },
    };
    const move = hold<GameActionResult>(cancelled);
    const barrierAck = hold<void>(undefined);
    const barrierRequested = Promise.withResolvers<void>();
    let barriers = 0;
    let programDrains = 0;
    let proposedMove = false;
    f.setExecutor(async (action, signal) => {
      if (action.kind !== "move")
        return { status: "succeeded", summary: "Replacement look confirmed", evidence: { effect_confirmed: true } };
      signal.addEventListener("abort", () => move.resolve(cancelled), { once: true });
      return await move.promise;
    });
    f.setProgramDrain(async () => { programDrains++; });
    f.setNeutralize(async () => {
      if (++barriers === 2) {
        barrierRequested.resolve();
        await barrierAck.promise;
      }
    });
    const { view } = await select(f);
    f.setEvaluator(async (context) => {
      if (context.action?.kind === "move" && context.action.status === "running")
        return replacement;
      if (!proposedMove) {
        proposedMove = true;
        return {
          kind: "replace", reason: "First policy emitter",
          action: { kind: "move", controls: { forward: true }, duration_ms: 2000 },
        };
      }
      return { kind: "continue" };
    });
    await f.execution();
    const firstActionId = f.actions.view!.action_id;
    await barrierRequested.promise;
    expect(f.actions.active).toBeNull();
    expect(f.executed).toHaveLength(1);
    expect(f.store.getAction(f.run.run_id, firstActionId)?.view.status).toBe("cancelled");
    expect(programDrains).toBe(2);
    expect(f.workersClosed()).toBe(1);
    if (stopAtBarrier) {
      f.run.status = "stopping";
      f.store.saveRun(f.run);
      f.nextGeneration();
      const closed = f.reactive.closeAll(false);
      f.actions.fence("Operator Stop during direct policy handoff");
      barrierAck.resolve();
      await closed;
      await f.actions.close("Operator Stop");
      expect(f.executed).toHaveLength(1);
      expect(view.effects).toBe(0);
    } else {
      const effect = event(f.store, "policy.effect");
      barrierAck.resolve();
      await effect;
      expect(f.executed).toEqual([
        { kind: "move", controls: { forward: true }, duration_ms: 2000 },
        { kind: "look", yaw: 0.2, pitch: 0 },
      ]);
      expect(f.actions.view?.status).toBe("succeeded");
      expect(view.effects).toBe(1);
    }
    expect(f.disconnected()).toBe(false);
  });
}

test("owned reactive cancellation preserves UNKNOWN action and root, drains the worker and native emitter, then executes the chosen replacement", async () => {
  const f = fixture();
  let workerDrained = false;
  let uncertaintyFences = 0;
  const interrupted: GameActionResult = {
    status: "unknown", summary: "Prior movement effects cannot be confirmed",
    evidence: null,
  };
  const cancellationRequested = Promise.withResolvers<void>();
  const workerClosing = Promise.withResolvers<void>();
  const neutralizationRequested = Promise.withResolvers<void>();
  let releaseWorker: Promise<void>;
  const manager = new SkillManager(f.store, {
    runSkill: async (_source, _args, handle) => {
      try {
        await handle({ kind: "action", action: { kind: "move", controls: { forward: true }, duration_ms: 2000 } });
        return { status: "completed", summary: "Movement settled", result: null };
      } finally {
        workerClosing.resolve();
        await releaseWorker;
        workerDrained = true;
      }
    },
  }, {
    authorize: (runId, epoch, sessionId, lifeId) => {
      if (runId !== f.run.run_id || epoch !== f.run.epoch ||
        sessionId !== f.run.session_id || lifeId !== f.run.life_id)
        throw new Error("Skill lineage revoked");
    },
    observe: () => f.game.observe(),
    action: async (execution, action, _signal, callId) => {
      const actionId = `skill_${callId}`;
      const settled = Promise.withResolvers<GameActionResult>();
      const inspect = () => {
        const result = f.store.getAction(f.run.run_id, actionId)?.view.result;
        if (result) {
          unsubscribe();
          settled.resolve(result);
        }
      };
      const unsubscribe = f.store.subscribe(inspect);
      cleanups.push(async () => { unsubscribe(); });
      f.actions.admit(actionId, action, 0, undefined, null, execution.execution_id);
      inspect();
      return await settled.promise;
    },
    recipes: async () => [],
    cancelActions: (ids, reason) => f.actions.cancelOwned(ids, reason),
    changed: () => {},
    unsafe: () => { throw new Error("Unexpected skill cleanup failure"); },
    recover: async () => { throw new Error("No respawn in this preemption fixture"); },
  });
  cleanups.push(async () => { await manager.closeAll("Fixture cleanup"); });
  const move = hold<GameActionResult>(interrupted);
  const cancellationAck = hold<void>(undefined);
  const workerExit = hold<void>(undefined);
  const neutralizationAck = hold<void>(undefined);
  releaseWorker = workerExit.promise;
  f.setExecutor(async (action, signal) => {
    if (action.kind !== "move")
      return { status: "succeeded", summary: "Chosen replacement confirmed", evidence: { effect_confirmed: true } };
    signal.addEventListener("abort", () => move.resolve(interrupted), { once: true });
    return await move.promise;
  });
  f.setCancel(async () => {
    cancellationRequested.resolve();
    await cancellationAck.promise;
  });
  f.setProgramDrain(async () => { await manager.closeAll("Reactive policy interrupted the running program"); });
  f.setNeutralize(async () => {
    expect(workerDrained).toBe(true);
    neutralizationRequested.resolve();
    await neutralizationAck.promise;
  });
  f.setUncertain(() => {
    uncertaintyFences++;
    f.reactive.fence();
  });
  const skill = await manager.register(f.run.run_id, {
    name: "Interrupted movement",
    source: 'await game.action({kind:"move",controls:{forward:true},duration_ms:2000}); return {status:"completed",summary:"Movement settled",result:null};',
    dependencies: [], card: specification().card,
  });
  const root = manager.start(f.run.run_id, {
    skill_id: skill.skill_id, version: skill.version, start_key: "managed-preemption",
    epoch: f.run.epoch, session_id: f.run.session_id!, life_id: f.run.life_id!,
    args: null, limits: { ...DEFAULT_SKILL_LIMITS },
  });
  await f.execution();
  const oldActionId = f.actions.view!.action_id;
  await select(f);
  f.setEvaluator(async () => replacement);
  await cancellationRequested.promise;
  expect(f.executed).toHaveLength(1);
  cancellationAck.resolve();
  await workerClosing.promise;
  expect(f.executed).toHaveLength(1);
  expect(workerDrained).toBe(false);
  workerExit.resolve();
  await neutralizationRequested.promise;
  expect(f.store.getAction(f.run.run_id, oldActionId)?.view.status).toBe("unknown");
  expect(f.store.skillExecution(f.run.run_id, { execution_id: root.execution_id })?.status).toBe("unknown");
  expect(f.executed).toHaveLength(1);
  const effect = event(f.store, "policy.effect");
  neutralizationAck.resolve();
  await effect;
  expect(f.executed).toEqual([
    { kind: "move", controls: { forward: true }, duration_ms: 2000 },
    { kind: "look", yaw: 0.2, pitch: 0 },
  ]);
  expect(f.actions.view?.status).toBe("succeeded");
  expect(f.store.getAction(f.run.run_id, oldActionId)?.view.status).toBe("unknown");
  expect(f.store.skillExecution(f.run.run_id, { execution_id: root.execution_id })?.status).toBe("unknown");
  expect(uncertaintyFences).toBe(0);
  expect(f.disconnected()).toBe(false);
});

test("life recovery never renews an expired exact-version trial", async () => {
  const f = fixture();
  const { view, ref } = await select(f, "javascript", 1000);
  await f.reactive.lifeChanged();
  setSystemTime(Date.now() + 1050);
  f.transition({ life_id: 2, status: "alive", can_respawn: false, death: null });
  await f.reactive.resume(1);
  expect(view.state).toBe("validated");
  await expect(f.reactive.activate(activateSchema.parse(ref), 1)).rejects.toMatchObject({ code: "conflict" });
  expect(f.executed).toHaveLength(0);
});

test("earned exact-version evidence and kept definitions survive death without replay", async () => {
  const f = fixture();
  const { view, ref } = await select(f);
  const effect = event(f.store, "policy.effect");
  f.setEvaluator(async () => replacement);
  await effect;
  await f.reactive.activate(activateSchema.parse({ ...ref, mode: "keep" }), 1);
  f.transition({ life_id: 1, status: "dead", can_respawn: false, death: null });
  await f.reactive.lifeChanged();
  const effects = view.effects;
  const executions = f.executed.length;
  expect(view.state).toBe("active");
  expect(effects).toBeGreaterThan(0);
  f.transition({ life_id: 2, status: "alive", can_respawn: false, death: null });
  f.setEvaluator(async () => ({ kind: "continue" }));
  await f.reactive.resume(1);
  const evaluated = event(f.store, "policy.evaluated");
  await evaluated;
  expect(view.effects).toBe(effects);
  expect(f.executed).toHaveLength(executions);
  expect(f.disconnected()).toBe(false);
});

async function broker(fetch: FetchImpl, onChange?: () => void) {
  const directory = mkdtempSync(join(tmpdir(), "gameharness-judge-life-"));
  const value = await JevBroker.create(directory, { fetch, onChange });
  cleanups.push(async () => { await value.close(); rmSync(directory, { recursive: true, force: true }); });
  return value;
}
function answer(choice: "wait" | "turn") {
  return new Response(JSON.stringify({
    answers: { decision: { type: "choice", choice, confidence: 1, probabilities: { wait: choice === "wait" ? 1 : 0, turn: choice === "turn" ? 1 : 0 } } },
    usage: { input_tokens: 4, output_tokens: 1 },
  }), { headers: { "Content-Type": "application/json" } });
}

test("the actual Jev policy path admits a supported judge despite an unrelated strategic model ID", async () => {
  let sends = 0;
  const judge = await broker(async () => answer(++sends === 1 ? "wait" : "turn"));
  await judge.setKey("unit-test-not-a-real-provider-key");
  const status = judge.status();
  expect(status.models.some((model) => model.id === status.selection?.model_id)).toBe(true);
  expect(status.selection?.request_timeout_ms).toBe(2000);
  expect(status.limits.max_request_ms).toBe(10000);
  const f = fixture(judge);
  await select(f, "jev");
  await f.execution();
  expect(sends).toBeGreaterThanOrEqual(2);
  expect(f.run.usage.calls).toBeGreaterThanOrEqual(2);
});

test("life fencing aborts Jev authority while retaining a stalled transport slot until settlement", async () => {
  const response = Promise.withResolvers<Response>();
  const sent = Promise.withResolvers<void>();
  const idle = Promise.withResolvers<void>();
  let awaitingIdle = false;
  let sends = 0;
  let judge: JevBroker | undefined;
  const configured = await broker(async () => {
    if (++sends === 1) return answer("wait");
    sent.resolve();
    return await response.promise;
  }, () => {
    if (awaitingIdle && judge?.status().active_requests === 0) idle.resolve();
  });
  judge = configured;
  await judge.setKey("unit-test-not-a-real-provider-key");
  const f = fixture(judge);
  cleanups.push(async () => { response.resolve(answer("turn")); });
  await select(f, "jev");
  await sent.promise;
  f.transition({ life_id: 1, status: "dead", can_respawn: true, death: null });
  await f.reactive.lifeChanged();
  f.transition({ life_id: 2, status: "alive", can_respawn: false, death: null });
  expect(judge.status().active_requests).toBe(1);
  expect(f.executed).toHaveLength(0);
  awaitingIdle = true;
  response.resolve(answer("turn"));
  await idle.promise;
  expect(f.executed).toHaveLength(0);
  expect(f.disconnected()).toBe(false);
});

test("no key is explicitly unavailable and configured credentials do not prove service eligibility", async () => {
  let sends = 0;
  const judge = await broker(async () => { sends++; return new Response(null, { status: 403 }); });
  expect(judge.status().state).toBe("unavailable");
  expect(judge.status().selection).toBeNull();
  const f = fixture(judge);
  const view = await f.reactive.register(specification("jev"), 1, 1);
  await expect(f.reactive.validate({ epoch: 1, policy_id: view.policy_id, version: view.version }, 1)).rejects.toMatchObject({ code: "backend_unavailable" });
  expect(sends).toBe(0);
  await judge.setKey("unit-test-not-a-real-provider-key");
  expect(judge.status().state).toBe("configured");
  const other = fixture(judge);
  const candidate = await other.reactive.register(specification("jev"), 1, 1);
  await expect(other.reactive.validate({ epoch: 1, policy_id: candidate.policy_id, version: candidate.version }, 1)).rejects.toMatchObject({ code: "backend_unavailable" });
  expect(sends).toBe(1);
  expect(other.executed).toHaveLength(0);
  expect(candidate.effects).toBe(0);
  expect(other.run.usage.calls).toBe(1);
  expect(JSON.stringify(other.store.events(other.run.run_id))).not.toContain("unit-test-not-a-real-provider-key");
});
