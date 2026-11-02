import { afterEach, expect, test, vi } from "bun:test";
import { createHash } from "node:crypto";
import type { Json, ObservationV3 } from "../src/shared/contracts.ts";
import type { LookaheadRequest, PlanningContext, StagePlanRequest } from "../src/shared/planning.ts";
import type { SkillExecutionView, SkillStartRequest, SkillView } from "../src/shared/programs.ts";
import { skillStartRequestSchema } from "../src/shared/validation.ts";
import { SpeculativePlanning } from "../src/server/speculative-planning.ts";
import { ProgramValidationError, programFingerprint } from "../src/server/program-validation.ts";
import { minecraftObservationFixture, minecraftTestAdapter, sha256 } from "./helpers/adapter-contract.ts";

const adapter = minecraftTestAdapter(), compatibilityHash = sha256(adapter.descriptor);

const planners: SpeculativePlanning[] = [];
afterEach(() => {
  for (const planner of planners.splice(0)) planner.invalidate();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function source(id: string): SkillView {
  const text = 'return { status: "completed", summary: "Observed", result: null };';
  const hash = createHash("sha256").update(text).digest("hex");
  return {
    entry: "run", skill_id: id, version: 1, name: id, source: text,
    hash,
    card: { purpose: "Observe", applicability: "Authorized life", method: "Read fresh state", reason: "Independent follow-up", limitations: "No effects" },
    dependencies: [], parent_version: null, state: "validated",
    validation: { fingerprint: programFingerprint(hash, "skill", compatibilityHash), runtime_version: 5, api_version: 5,
      validator_version: 5, compatibility_hash: compatibilityHash, formatted_lines: 1, complexity: 1, nesting: 0 },
    created_at: new Date().toISOString(),
  };
}
function setup() {
  const candidate = source("follow-up");
  const predecessor = source("predecessor");
  const context: PlanningContext = {
    run_id: "run", generation: 1, session_id: "session", world_id: "world", epoch: 1,
    life_id: 1, life_status: "alive", task: "Observe", goal: adapter.goals.find(goal => goal.goal_id === "custom")!,
    native_boot_id: "fixture-native-boot", space_epoch: 1, compatibility_hash: compatibilityHash, screen: null,
    root: { execution_id: "root", skill_id: predecessor.skill_id, version: 1, hash: predecessor.hash, status: "running" },
  };
  const observation = minecraftObservationFixture(adapter, { observation_seq: 10 });
  const events: { type: string; details: Json }[] = [];
  const admitted: SkillStartRequest[] = [];
  const reads: number[] = [];
  const guards: { source: string; observation: ObservationV3; args: Json }[] = [];
  const state = {
    evaluate: async (_source: string, _observation: ObservationV3, _args: Json, _signal: AbortSignal): Promise<boolean> => true,
    beforeObserve: async () => {},
    beforeAdmit: async () => {},
    afterAdmit: async () => {},
    admissionStatus: "accepted" as SkillExecutionView["status"],
    wakes: [] as string[], hasRoot: true,
  };
  const sources = new Map([[candidate.skill_id, candidate], [predecessor.skill_id, predecessor]]);
  const planner = new SpeculativePlanning({
    contract: () => adapter,
    admissionContext: () => context,
    context: () => state.hasRoot ? context : null,
    skill: (ref) => sources.get(ref.skill_id) ?? null,
    observe: async () => { await state.beforeObserve(); reads.push(observation.observation_seq); return structuredClone(observation); },
    evaluateGuard: (text, fresh, args, signal) => {
      guards.push({ source: text, observation: structuredClone(fresh), args: structuredClone(args) });
      return state.evaluate(text, fresh, args, signal);
    },
    admit: async (request, permit) => {
      if (request.entry !== "run") throw new Error("Planner only admits run entries");
      skillStartRequestSchema.parse(request);
      await state.beforeAdmit();
      permit.assertCurrent();
      if (permit.signal.aborted) throw new Error("revoked");
      admitted.push(request);
      context.root = { execution_id: "next-root", skill_id: candidate.skill_id, version: candidate.version, hash: candidate.hash, status: state.admissionStatus };
      const execution: SkillExecutionView = {
        ...request, run_id: "run", world_id: context.world_id, source_hash: candidate.hash, execution_id: "next-root", root_execution_id: "next-root", parent_execution_id: null,
        status: state.admissionStatus, started_at: null, ended_at: null, deadline_at: new Date().toISOString(),
        actions: 0, calls: 0, result: null, error: state.admissionStatus === "unknown" ? "Uncertain outcome" : null,
      };
      await state.afterAdmit();
      return execution;
    },
    evidence: (type, details) => events.push({ type, details }),
    wake: (reason) => { state.wakes.push(reason); },
  });
  planners.push(planner);
  const request: LookaheadRequest = { root_execution_id: "root", after_ms: 0, reason: "Independent observation follow-up", budget: { calls: 3, tools: 8, duration_ms: 30_000 } };
  const arm = (automatic = false) => {
    const { root_execution_id, ...configuration } = request;
    return automatic
      ? planner.prepareOptIn({ ...configuration, activation: "on_predecessor_success" })(root_execution_id)
      : planner.optIn(request);
  };
  const input = (planId: string, guard: string | undefined = "return observation.data.player.health > 0;"): StagePlanRequest => ({
    plan_id: planId, skill: { skill_id: candidate.skill_id, version: candidate.version },
    args: { minimum: 1 }, limits: { duration_ms: 1000, max_actions: 1, max_calls: 2, max_depth: 1 },
    ...(guard === undefined ? {} : { guard_source: guard }),
  });
  const stage = async (automatic = false, guard: string | undefined = "return observation.data.player.health > 0;") => {
    const plan = arm(automatic); planner.begin();
    const staged = input(plan.plan_id, guard);
    if (guard === undefined) delete staged.guard_source;
    await planner.stage(staged); planner.finish(plan.plan_id);
    return plan.plan_id;
  };
  const succeed = () => { context.root.status = "succeeded"; planner.predecessorSettled("root"); };
  return { planner, context, observation, candidate, sources, request, state, admitted, events, reads, guards, arm, input, stage, succeed };
}

test("manual staging grants no effects; deliberate activation obtains fresh game-only observation and args", async () => {
  const f = setup(); const id = await f.stage();
  expect(f.context.root.status).toBe("running"); expect(f.admitted).toEqual([]); expect(f.reads).toEqual([]);
  expect(f.planner.projection()).toMatchObject({ activation: "manual", activation_permit: "not_authorized", guard_status: "pending" });
  f.observation.observation_seq = 22; f.succeed();
  expect(await f.planner.pendingActivation()).toBeNull(); expect(f.admitted).toEqual([]);
  f.state.evaluate = async (_source, observation, args) => {
    expect(observation).toEqual(f.observation); expect(args).toEqual({ minimum: 1 });
    expect(observation).not.toHaveProperty("task"); expect(observation).not.toHaveProperty("predecessor");
    expect(args).not.toHaveProperty("candidate"); return true;
  };
  expect(await f.planner.activate(id)).toMatchObject({ state: "activated", observation_seq: 22, guard_status: "passed", activation_trigger: "manual" });
  expect(f.reads).toEqual([22]); expect(f.admitted).toHaveLength(1);
  expect(f.admitted[0]).toMatchObject({ start_key: `plan_${id}`, session_id: "session", life_id: 1, epoch: 1 });
  expect(f.planner.requestCall()).toBe(false); expect(() => f.planner.assertToolAuthority()).toThrow("closed");
});

for (const order of ["stage_first", "closure_first"] as const) {
  test(`Main root-start permit automatically admits once after ${order}, without a model request`, async () => {
    const f = setup(); const plan = f.arm(true); f.planner.begin();
    if (order === "closure_first") f.succeed();
    await f.planner.stage(f.input(plan.plan_id));
    expect(f.admitted).toEqual([]);
    f.planner.finish(plan.plan_id);
    if (order === "stage_first") {
      expect(f.planner.projection()?.state).toBe("staged"); f.succeed();
    }
    expect(f.planner.projection()).toMatchObject({ state: "validating", activation_permit: "consumed", predecessor_closed: true });
    expect(() => f.planner.assertOrdinaryAdmission()).toThrow("owns admission");
    expect(await f.planner.pendingActivation()).toMatchObject({ state: "activated", activation_trigger: "automatic", activation_permit: "consumed", calls: 0 });
    f.planner.predecessorSettled("root"); f.planner.finish(plan.plan_id);
    await expect(f.planner.activate(plan.plan_id)).rejects.toThrow("already activated");
    expect(await f.planner.pendingActivation()).toMatchObject({ state: "activated" });
    expect(f.admitted).toHaveLength(1); expect(f.reads).toHaveLength(1); expect(f.guards).toHaveLength(1);
    expect(f.state.wakes.filter((reason) => reason === "continuation")).toHaveLength(1);
    expect(() => f.planner.assertOrdinaryAdmission()).not.toThrow();
  });
}

test("succeeded status without the trusted drain notification grants neither automatic nor manual activation", async () => {
  const f = setup(); const id = await f.stage(true); f.context.root.status = "succeeded";
  expect(await f.planner.pendingActivation()).toBeNull();
  await expect(f.planner.activate(id)).rejects.toThrow("cleanup is still pending"); expect(f.admitted).toEqual([]);
  f.planner.predecessorSettled("root"); expect((await f.planner.pendingActivation())?.state).toBe("activated");
});

test("closure-first ownership waits for speculative finish and returns outcome authority on an empty flight", async () => {
  const f = setup(); const plan = f.arm(true); f.planner.begin(); f.context.root.status = "succeeded";
  expect(f.planner.predecessorSettled("root")).toBe(true);
  expect(await f.planner.pendingActivation("root")).toBeNull();
  expect(f.state.wakes).toEqual([]);
  f.planner.finish(plan.plan_id);
  expect(f.planner.projection()).toMatchObject({ state: "empty", predecessor_closed: true });
  expect(f.state.wakes).toEqual(["continuation"]); expect(f.admitted).toEqual([]);
});

test("a never-started flight cannot launch speculative inference after predecessor closure", async () => {
  const f = setup(); f.arm(true); f.context.root.status = "succeeded";
  expect(f.planner.predecessorSettled("root")).toBe(false);
  expect(f.planner.projection()).toMatchObject({ state: "rejected", reason: "predecessor_already_settled" });
  expect(f.planner.begin()).toBeNull(); expect(f.admitted).toEqual([]);
});

test("only the Main root-start closure mints an automatic permit; speculative tools cannot expand it", () => {
  const f = setup();
  expect(() => f.planner.optIn({ ...f.request, activation: "on_predecessor_success" })).toThrow("Main authorization at root start");
  expect(f.planner.projection()).toBeNull();
  const { root_execution_id: _root, ...config } = f.request;
  f.state.hasRoot = false; const arm = f.planner.prepareOptIn({ ...config, activation: "on_predecessor_success" });
  f.state.hasRoot = true; f.context.root.status = "accepted";
  expect(arm("root")).toMatchObject({ activation_permit: "available" });
  expect(() => arm("root")).toThrow("already consumed"); f.planner.begin();
  for (const tool of ["program_run", "program_write", "program_review", "reflex", "memory"])
    expect(() => f.planner.assertToolAuthority(tool)).toThrow("only permits");
  expect(f.admitted).toEqual([]);
});

for (const stale of ["cancelled", "life", "task", "generation"] as const) {
  test(`prepared root authorization rejects ${stale} before being consumed`, () => {
    const f = setup(); const { root_execution_id: _root, ...config } = f.request;
    const arm = f.planner.prepareOptIn(config);
    if (stale === "cancelled") f.planner.invalidate();
    else if (stale === "life") f.context.life_id++;
    else if (stale === "task") f.context.task = "Another task";
    else f.context.generation++;
    expect(() => arm("root")).toThrow(); expect(f.planner.projection()).toBeNull();
  });
}

for (const automatic of [false, true]) {
  test(`omitted guard is explicit, never evaluated, and still observes fresh state (${automatic ? "automatic" : "manual"})`, async () => {
    const f = setup(); const plan = f.arm(automatic); f.planner.begin();
    const input = f.input(plan.plan_id); delete input.guard_source;
    await f.planner.stage(input); f.planner.finish(plan.plan_id);
    f.observation.observation_seq = 55; f.state.evaluate = async () => { throw new Error("Omitted guard must not run"); };
    f.succeed();
    const result = automatic ? await f.planner.pendingActivation() : await f.planner.activate(plan.plan_id);
    expect(result).toMatchObject({ state: "activated", guard_status: "omitted", guard_hash: null, observation_seq: 55 });
    expect(f.reads).toEqual([55]); expect(f.guards).toEqual([]); expect(f.admitted).toHaveLength(1);
  });
}

for (const result of ["false", "error", "nonboolean"] as const) {
  test(`fresh ${result} guard rejects automatic admission without replay`, async () => {
    const f = setup(); const id = await f.stage(true);
    f.state.evaluate = async () => {
      if (result === "error") throw new Error("Guard failed");
      return result === "nonboolean" ? "yes" as unknown as boolean : false;
    };
    f.observation.observation_seq = 33; f.succeed();
    expect(await f.planner.pendingActivation()).toMatchObject({ state: "rejected", reason: result === "error" ? "guard_error" : "guard_failed", activation_permit: "revoked", observation_seq: 33 });
    await expect(f.planner.activate(id)).rejects.toThrow(); f.planner.predecessorSettled("root");
    expect(f.reads).toEqual([33]); expect(f.admitted).toEqual([]);
  });
}

for (const status of ["failed", "blocked", "cancelled", "unknown", "cancel_requested"] as const) {
  test(`${status} predecessor never consumes authorization or admits a successor`, async () => {
    const f = setup(); const id = await f.stage(true); f.context.root.status = status;
    f.planner.predecessorSettled("root");
    expect(f.planner.projection()).toMatchObject({ state: "rejected", reason: "predecessor_unsuccessful", activation_permit: "revoked" });
    expect(f.context.root.status).toBe(status); expect(f.admitted).toEqual([]); expect(f.guards).toEqual([]);
    await expect(f.planner.activate(id)).rejects.toThrow();
  });
}

test("cancellation after stage invalidates the permit before predecessor closure", async () => {
  const f = setup(); await f.stage(true); f.planner.invalidate("cancelled"); f.succeed();
  expect(f.planner.projection()).toMatchObject({ state: "invalidated", reason: "cancelled", activation_permit: "revoked" });
  expect(await f.planner.pendingActivation()).toBeNull(); expect(f.admitted).toEqual([]);
});

for (const phase of ["observation", "guard", "neutral_barrier", "after_admission"] as const) {
  for (const mutation of ["cancel", "life", "session", "epoch", "task", "goal", "generation", "root_hash", "candidate", "dependency"] as const) {
    test(`${mutation} change during ${phase} fences the actual activation permit`, async () => {
      const f = setup(); const dependency = source("dependency");
      f.sources.set(dependency.skill_id, dependency); f.candidate.dependencies.push({ skill_id: dependency.skill_id, version: 1 });
      const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
      const wait = async () => { entered.resolve(); await release.promise; };
      if (phase === "observation") f.state.beforeObserve = wait;
      else if (phase === "guard") f.state.evaluate = async () => { await wait(); return true; };
      else if (phase === "neutral_barrier") f.state.beforeAdmit = wait;
      else f.state.afterAdmit = wait;
      await f.stage(true); f.succeed(); await entered.promise;
      if (mutation === "cancel") f.planner.invalidate();
      else if (mutation === "life") f.context.life_id++;
      else if (mutation === "session") f.context.session_id = "new-session";
      else if (mutation === "epoch") f.context.epoch++;
      else if (mutation === "task") f.context.task = "New task";
      else if (mutation === "goal") f.context.goal = { ...f.context.goal, parameters: { changed: true } };
      else if (mutation === "generation") f.context.generation++;
      else if (mutation === "root_hash") f.context.root.hash = "changed";
      else if (mutation === "candidate") f.candidate.source += "\nreturn null;";
      else dependency.source += "\nreturn null;";
      release.resolve();
      expect(await f.planner.pendingActivation()).toMatchObject({ state: mutation === "cancel" ? "invalidated" : "rejected", activation_permit: "revoked" });
      expect(f.admitted).toHaveLength(phase === "after_admission" ? 1 : 0);
    });
  }
}

test("uncertain durable admission retains execution identity and UNKNOWN without effect replay", async () => {
  const f = setup(); const id = await f.stage(true); f.state.admissionStatus = "unknown"; f.succeed();
  expect(await f.planner.pendingActivation()).toMatchObject({ state: "rejected", reason: "admission_failed", activation_execution_id: "next-root" });
  expect(f.context.root.status).toBe("unknown");
  await expect(f.planner.activate(id)).rejects.toThrow(); expect(f.admitted).toHaveLength(1);
});

test("manual validation reserves exactly once and an old auto result cannot suppress a successor outcome", async () => {
  const f = setup(); const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<boolean>();
  f.state.evaluate = async () => { entered.resolve(); return await release.promise; };
  const id = await f.stage(); f.succeed(); const activation = f.planner.activate(id); await entered.promise;
  await expect(f.planner.activate(id)).rejects.toThrow("not staged");
  release.resolve(true); expect((await activation).state).toBe("activated");
  await expect(f.planner.activate(id)).rejects.toThrow("already activated"); expect(f.admitted).toHaveLength(1);
  const automatic = setup(); await automatic.stage(true); automatic.succeed(); await automatic.planner.pendingActivation("root");
  expect(await automatic.planner.pendingActivation("next-root")).toBeNull();
});

for (const mutation of ["candidate_hash", "dependency_hash", "dependency_graph"] as const) {
  test(`fresh exact ${mutation} changes reject an otherwise valid captured source closure`, async () => {
    const f = setup(); const dependency = source("dependency");
    f.sources.set(dependency.skill_id, dependency); f.candidate.dependencies.push({ skill_id: dependency.skill_id, version: 1 });
    await f.stage(true);
    if (mutation === "dependency_graph") f.candidate.dependencies = [];
    else {
      const changed = mutation === "candidate_hash" ? f.candidate : dependency;
      changed.source += "\nreturn null;"; changed.hash = createHash("sha256").update(changed.source).digest("hex");
    }
    f.succeed();
    expect(await f.planner.pendingActivation()).toMatchObject({ state: "rejected", reason: "source_changed" });
    expect(f.admitted).toEqual([]);
  });
}

test("a pending predecessor, replaced predecessor, or missing host context cannot admit", async () => {
  const pending = setup(); const id = await pending.stage();
  await expect(pending.planner.activate(id)).rejects.toThrow("still pending");
  for (const mutation of ["root", "missing", "hash"] as const) {
    const f = setup(); const planId = await f.stage(); f.succeed();
    if (mutation === "root") f.context.root.execution_id = "replacement";
    else if (mutation === "missing") f.state.hasRoot = false;
    else f.context.root.hash = "changed";
    await expect(f.planner.activate(planId)).rejects.toThrow(); expect(f.admitted).toEqual([]);
  }
});

for (const key of ["session", "world", "epoch", "life", "dead"] as const) {
  test(`fresh observation rejects mismatched ${key} even if outer scope is unchanged`, async () => {
    const f = setup(); const id = await f.stage(); f.succeed();
    if (key === "session") f.observation.session_id = "other";
    else if (key === "world") f.observation.world_id = "other";
    else if (key === "epoch") f.observation.epoch++;
    else if (key === "life") f.observation.life.life_id++;
    else f.observation.life.status = "dead";
    expect(await f.planner.activate(id)).toMatchObject({ state: "rejected", reason: key === "life" || key === "dead" ? "life_changed" : "session_changed" });
    expect(f.guards).toEqual([]); expect(f.admitted).toEqual([]);
  });
}

for (const failure of [
  { name: "syntax", source: "return (", code: "invalid_syntax" },
  { name: "source bytes", source: "return true;\n".repeat(1400), code: "source_bytes_limit" },
]) {
  test(`explicit ${failure.name} correction retains the original finite planning budget`, async () => {
    const f = setup(); const plan = f.arm(); f.planner.begin();
    expect(f.planner.requestCall()).toBe(true); f.planner.assertToolAuthority("prepare_next");
    let error: unknown;
    try { await f.planner.stage(f.input(plan.plan_id, failure.source)); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(ProgramValidationError);
    expect(error).toMatchObject({ issues: expect.arrayContaining([expect.objectContaining({ code: failure.code })]), stage_correction: { correction_allowed: true, remaining_calls: 2, remaining_tools: 7, deadline_at: plan.deadline_at } });
    expect(f.planner.projection()).toMatchObject({ state: "planning", planning_active: true, calls: 1, tools: 1, deadline_at: plan.deadline_at });
    expect(f.planner.requestCall()).toBe(true); f.planner.assertToolAuthority("prepare_next");
    await f.planner.stage(f.input(plan.plan_id)); f.planner.finish(plan.plan_id); f.succeed();
    expect(await f.planner.activate(plan.plan_id)).toMatchObject({ state: "activated", calls: 2, tools: 2, deadline_at: plan.deadline_at });
  });
}

test("exhausted correction budget never creates a model call or renews the flight", async () => {
  const f = setup(); f.request.budget.calls = 1; const plan = f.arm(); f.planner.begin();
  expect(f.planner.requestCall()).toBe(true); f.planner.assertToolAuthority("prepare_next");
  await expect(f.planner.stage(f.input(plan.plan_id, "return ("))).rejects.toMatchObject({ stage_correction: { correction_allowed: false, remaining_calls: 0 } });
  expect(f.planner.requestCall()).toBe(false); f.planner.finish(plan.plan_id);
  expect(f.planner.projection()?.state).toBe("empty"); expect(f.admitted).toEqual([]);
});

test("unsafe guard source is terminal; immutable candidate refs cannot accept hash aliases or wrong scope", async () => {
  const unsafe = setup(); const plan = unsafe.arm(); unsafe.planner.begin();
  await expect(unsafe.planner.stage(unsafe.input(plan.plan_id, "return process.pid;"))).rejects.toThrow();
  expect(unsafe.planner.projection()).toMatchObject({ state: "rejected", reason: "guard_error" });
  for (const kind of ["hash_alias", "foreign", "wrong_id", "wrong_version", "retired", "mutated"] as const) {
    const f = setup(); const draft = f.arm(); f.planner.begin(); const input = f.input(draft.plan_id);
    if (kind === "hash_alias") Object.assign(input.skill, { hash: "0".repeat(64) });
    else if (kind === "foreign") input.skill.skill_id = "foreign";
    else if (kind === "wrong_id") { input.skill.skill_id = "other"; f.sources.set("other", f.candidate); }
    else if (kind === "wrong_version") input.skill.version++;
    else if (kind === "retired") f.candidate.state = "retired";
    else f.candidate.source += "\nreturn null;";
    await expect(f.planner.stage(input)).rejects.toThrow(); expect(f.admitted).toEqual([]);
    if (kind !== "hash_alias") expect(f.planner.projection()).toMatchObject({ state: "rejected", reason: "source_changed" });
  }
});

test("the removed precondition_source convention cannot silently become an omitted guard", async () => {
  const f = setup(); const plan = f.arm(); f.planner.begin(); const input = f.input(plan.plan_id);
  delete input.guard_source; Object.assign(input, { precondition_source: "return context.observation.player.health > 0;" });
  await expect(f.planner.stage(input)).rejects.toThrow("optional game guard");
  expect(f.planner.projection()).toMatchObject({ state: "planning", candidate: null }); expect(f.admitted).toEqual([]);
});

test("one root gets one bounded flight and tool-budget exhaustion cannot extend it", () => {
  const f = setup(); f.request.budget.calls = 1; f.request.budget.tools = 1;
  f.arm(); f.planner.begin(); expect(f.planner.requestCall()).toBe(true); expect(f.planner.requestCall()).toBe(false);
  f.planner.assertToolAuthority("program_inspect"); expect(() => f.planner.assertToolAuthority("program_inspect")).toThrow("budget exhausted");
  expect(f.planner.projection()).toMatchObject({ state: "rejected", reason: "budget_exhausted" });
  expect(f.arm).toThrow("unused lookahead allowance");
});

test("scheduled attention wakes once and expires at the original deadline", () => {
  vi.useFakeTimers(); const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  const f = setup(); f.request.after_ms = 1000; f.request.budget.duration_ms = 1000; f.arm();
  clock.mockReturnValue(999); vi.advanceTimersByTime(999); expect(f.state.wakes).toEqual([]);
  clock.mockReturnValue(1000); vi.advanceTimersByTime(1); expect(f.state.wakes).toEqual(["lookahead"]);
  clock.mockReturnValue(2001); vi.advanceTimersByTime(1001);
  expect(f.planner.projection()).toMatchObject({ state: "expired", reason: "deadline" });
  expect(f.planner.begin()).toBeNull(); expect(f.planner.requestCall()).toBe(false);
});

for (const phase of ["before_closure", "guard", "admission"] as const) {
  test(`automatic ${phase} expiration never extends the finite flight deadline`, async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0); const f = setup();
    const id = await f.stage(true); const deadline = f.planner.projection()!.deadline_at;
    if (phase === "before_closure") clock.mockReturnValue(30_000);
    else if (phase === "guard") f.state.evaluate = async () => { clock.mockReturnValue(30_000); return true; };
    else f.state.beforeAdmit = async () => { clock.mockReturnValue(30_000); };
    f.succeed(); await f.planner.pendingActivation();
    expect(f.planner.projection()).toMatchObject({ plan_id: id, state: "expired", reason: "deadline", deadline_at: deadline });
    expect(f.admitted).toEqual([]);
  });
}

test("an old cancelled activation cannot overwrite or return a new draft", async () => {
  const f = setup(); const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<boolean>();
  f.state.evaluate = async () => { entered.resolve(); return await release.promise; };
  const id = await f.stage(); f.succeed(); const activation = f.planner.activate(id); await entered.promise;
  f.planner.invalidate("life_changed"); f.context.life_id = 2; f.context.root.execution_id = "new-root"; f.context.root.status = "running";
  f.request.root_execution_id = "new-root"; const next = f.arm(); release.resolve(true);
  expect(await activation).toMatchObject({ plan_id: id, state: "invalidated", reason: "life_changed" });
  expect(f.planner.projection()).toMatchObject({ plan_id: next.plan_id, state: "armed" }); expect(f.admitted).toEqual([]);
});
