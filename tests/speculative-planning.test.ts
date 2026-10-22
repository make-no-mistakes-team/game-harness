import { afterEach, expect, test, vi } from "bun:test";
import { createHash } from "node:crypto";
import type { Json, Observation } from "../src/shared/contracts.ts";
import type { LookaheadRequest, PlanningContext, StagePlanRequest } from "../src/shared/planning.ts";
import type { SkillExecutionView, SkillStartRequest, SkillView } from "../src/shared/programs.ts";
import { skillStartRequestSchema } from "../src/shared/validation.ts";
import { SpeculativePlanning } from "../src/server/speculative-planning.ts";
import { ProgramValidationError } from "../src/server/program-validation.ts";
import { RuntimeFault } from "../src/server/runtime-fault.ts";

const planners: SpeculativePlanning[] = [];
afterEach(() => {
  for (const planner of planners.splice(0)) planner.invalidate();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function source(id: string): SkillView {
  const text = 'return { status: "completed", summary: "Observed", result: null };';
  return {
    skill_id: id, version: 1, name: id, source: text,
    hash: createHash("sha256").update(text).digest("hex"),
    card: { purpose: "Observe", applicability: "Authorized life", method: "Read fresh state", reason: "Independent follow-up", limitations: "No effects" },
    dependencies: [], parent_version: null, state: "validated",
    validation: { fingerprint: "fixture", formatted_lines: 1, complexity: 1, nesting: 0 },
    created_at: new Date().toISOString(),
  };
}
function setup() {
  const candidate = source("follow-up");
  const predecessor = source("predecessor");
  const context: PlanningContext = {
    run_id: "run", generation: 1, session_id: "session", world_id: "world", epoch: 1,
    life_id: 1, life_status: "alive", task: "Observe", goal: "custom",
    root: { execution_id: "root", skill_id: predecessor.skill_id, version: 1, hash: predecessor.hash, status: "running" },
  };
  const observation: Observation = {
    schema_version: 2, session_id: "session", world_id: "world", epoch: 1,
    life: { life_id: 1, status: "alive", can_respawn: false, death: null },
    observation_seq: 10, captured_at: new Date().toISOString(),
    profile_id: "player-observable-structured", preset_id: "minecraft-observable-initial-r2",
    player: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 20, food: 20, on_ground: true, in_water: false, inventory: [] },
    blocks: [], entities: [], sounds: [], coverage: { partial: true, max_age_ms: 1000 },
  };
  const events: { type: string; details: Json }[] = [];
  const admitted: SkillStartRequest[] = [];
  const reads: number[] = [];
  const state = {
    evaluate: async (_source: string, _context: Json, _signal: AbortSignal) => true,
    beforeAdmit: async () => {},
    wakes: 0,
    hasRoot: true,
  };
  const sources = new Map([[candidate.skill_id, candidate], [predecessor.skill_id, predecessor]]);
  const planner = new SpeculativePlanning({
    admissionContext: () => context,
    context: () => state.hasRoot ? context : null,
    skill: (ref) => sources.get(ref.skill_id) ?? null,
    observe: async () => { reads.push(observation.observation_seq); return structuredClone(observation); },
    evaluatePrecondition: (text, data, signal) => state.evaluate(text, data, signal),
    admit: async (request, permit) => {
      skillStartRequestSchema.parse(request);
      await state.beforeAdmit();
      permit.assertCurrent();
      if (permit.signal.aborted) throw new Error("revoked");
      admitted.push(request);
      const execution: SkillExecutionView = {
        ...request, run_id: "run", execution_id: "next-root", root_execution_id: "next-root", parent_execution_id: null,
        status: "accepted", started_at: null, ended_at: null, deadline_at: new Date().toISOString(),
        actions: 0, calls: 0, result: null, error: null,
      };
      return execution;
    },
    evidence: (type, details) => events.push({ type, details }),
    wake: () => { state.wakes++; },
  });
  planners.push(planner);
  const request: LookaheadRequest = { root_execution_id: "root", after_ms: 0, reason: "Independent observation follow-up", budget: { calls: 3, tools: 8, duration_ms: 30_000 } };
  const arm = () => planner.optIn(request);
  const stage = async () => {
    const plan = arm();
    planner.begin();
    const input: StagePlanRequest = {
      plan_id: plan.plan_id,
      skill: { skill_id: candidate.skill_id, version: candidate.version },
      args: null, limits: { duration_ms: 1000, max_actions: 1, max_calls: 2, max_depth: 1 },
      precondition_source: "return context.observation.player.health > 0;",
    };
    await planner.stage(input);
    planner.finish(plan.plan_id);
    return plan.plan_id;
  };
  const succeed = () => { context.root.status = "succeeded"; planner.predecessorSettled("root"); };
  return { planner, context, observation, candidate, sources, request, state, admitted, events, reads, arm, stage, succeed };
}

test("opt-in leaves the predecessor running and staging grants no effects; activation observes fresh state", async () => {
  const fixture = setup();
  const id = await fixture.stage();
  expect(fixture.context.root.status).toBe("running");
  expect(fixture.admitted).toEqual([]);
  expect(fixture.reads).toEqual([]);
  expect(fixture.planner.projection()?.candidate).toEqual({
    skill_id: fixture.candidate.skill_id, version: fixture.candidate.version, hash: fixture.candidate.hash,
  });
  expect(fixture.planner.requestCall()).toBe(false);
  expect(() => fixture.planner.assertToolAuthority()).toThrow("closed");
  fixture.observation.observation_seq = 22;
  fixture.succeed();
  const activated = await fixture.planner.activate(id);
  expect(activated).toMatchObject({ state: "activated", observation_seq: 22, activation_execution_id: "next-root" });
  expect(fixture.reads).toEqual([22]);
  expect(fixture.admitted).toHaveLength(1);
  expect(fixture.admitted[0]).toMatchObject({ session_id: "session", life_id: 1, epoch: 1, start_key: `plan_${id}` });
});

test("staging accepts only an ordinary immutable ref and pins the host hash without accepting an old hash alias", async () => {
  const fixture = setup();
  const draft = fixture.arm(); fixture.planner.begin();
  const request: StagePlanRequest = {
    plan_id: draft.plan_id,
    skill: { skill_id: fixture.candidate.skill_id, version: fixture.candidate.version },
    args: null, limits: { duration_ms: 1000, max_actions: 1, max_calls: 2, max_depth: 1 },
    precondition_source: 'return context.observation.life.status === "alive";',
  };
  const oldShape = { ...request, skill: { ...request.skill, hash: "0".repeat(64) } };
  await expect(fixture.planner.stage(oldShape)).rejects.toThrow();
  expect(fixture.planner.projection()).toMatchObject({ state: "planning", candidate: null });
  const staged = await fixture.planner.stage(request);
  expect(staged.candidate).toEqual({
    skill_id: fixture.candidate.skill_id, version: fixture.candidate.version, hash: fixture.candidate.hash,
  });
  fixture.planner.finish(draft.plan_id); fixture.succeed();
  fixture.state.evaluate = async (_source, context) => {
    expect(context).toMatchObject({
      candidate: staged.candidate,
      predecessor: { execution_id: "root", status: "succeeded" },
    });
    return true;
  };
  expect((await fixture.planner.activate(draft.plan_id)).state).toBe("activated");
});

for (const sourceCase of ["foreign_scope", "wrong_id", "wrong_version", "unvalidated", "mutated_source"] as const) {
  test(`selected ${sourceCase} program is rejected with a typed source error, never a substituted candidate`, async () => {
    const fixture = setup();
    const draft = fixture.arm(); fixture.planner.begin();
    let skillId = fixture.candidate.skill_id;
    let version = fixture.candidate.version;
    if (sourceCase === "foreign_scope") skillId = "foreign-run-program";
    if (sourceCase === "wrong_id") {
      skillId = "different-program";
      fixture.sources.set(skillId, fixture.candidate);
    }
    if (sourceCase === "wrong_version") version++;
    if (sourceCase === "unvalidated") fixture.candidate.state = "retired";
    if (sourceCase === "mutated_source") fixture.candidate.source += "\nreturn null;";
    let rejected: unknown;
    try {
      await fixture.planner.stage({
        plan_id: draft.plan_id, skill: { skill_id: skillId, version },
        args: null, limits: { duration_ms: 1000, max_actions: 1, max_calls: 2, max_depth: 1 },
        precondition_source: "return true;",
      });
    } catch (error) { rejected = error; }
    const code = sourceCase === "foreign_scope" ? "not_found"
      : sourceCase === "unvalidated" ? "precondition_failed" : "stale_context";
    expect(rejected).toBeInstanceOf(RuntimeFault);
    expect(rejected).toMatchObject({ code });
    expect(fixture.planner.projection()).toMatchObject({
      state: "rejected", reason: "source_changed", candidate: null, activation_execution_id: null,
    });
    expect(fixture.events.find((event) => event.type === "planning.stage_rejected")?.details)
      .toMatchObject({ error: { code } });
    expect(fixture.admitted).toEqual([]);
  });
}

test("host-pinned source identity is checked again after the isolated predicate settles", async () => {
  const fixture = setup();
  const id = await fixture.stage(); fixture.succeed();
  fixture.state.evaluate = async () => {
    fixture.candidate.source += "\nreturn null;";
    return true;
  };
  expect(await fixture.planner.activate(id)).toMatchObject({ state: "rejected", reason: "source_changed" });
  expect(fixture.admitted).toEqual([]);
});

test("first-root admission prepares without a predecessor, arms once after admission, and fences stale preparations", () => {
  const fixture = setup();
  const config = { after_ms: 0, reason: "Independent root-start follow-up", budget: { calls: 1, tools: 2, duration_ms: 1000 } };
  fixture.state.hasRoot = false;
  const arm = fixture.planner.prepareOptIn(config);
  expect(fixture.planner.projection()).toBeNull();
  fixture.state.hasRoot = true;
  fixture.context.root.status = "accepted";
  const armed = arm("root");
  expect(armed).toMatchObject({ state: "armed", basis: { root: { execution_id: "root", status: "accepted" } } });
  expect(() => arm("root")).toThrow("already consumed");
  expect(() => fixture.planner.prepareOptIn(config)).toThrow("Only one");

  const cancelled = setup();
  const cancelledArm = cancelled.planner.prepareOptIn(config);
  cancelled.planner.invalidate("cancelled");
  expect(() => cancelledArm("root")).toThrow("revoked");
  expect(cancelled.planner.projection()).toBeNull();

  const stale = setup();
  const staleArm = stale.planner.prepareOptIn(config);
  stale.context.life_id++;
  expect(() => staleArm("root")).toThrow("another scope");
  expect(stale.planner.projection()).toBeNull();
});

for (const failure of [
  { name: "syntax", source: "return (", code: "invalid_syntax" },
  { name: "compactness", source: "return true;\n".repeat(81), code: "formatted_lines_limit" },
]) {
  test(`model can correct ${failure.name} on the same plan without renewing budgets or discarding failed source`, async () => {
    const fixture = setup();
    const draft = fixture.arm();
    fixture.planner.begin();
    expect(fixture.planner.requestCall()).toBe(true);
    fixture.planner.assertToolAuthority("planning_stage");
    const request: StagePlanRequest = {
      plan_id: draft.plan_id,
      skill: { skill_id: fixture.candidate.skill_id, version: fixture.candidate.version },
      args: null, limits: { duration_ms: 1000, max_actions: 1, max_calls: 2, max_depth: 1 },
      precondition_source: failure.source,
    };
    let rejected: unknown;
    try { await fixture.planner.stage(request); }
    catch (error) { rejected = error; }
    expect(rejected).toBeInstanceOf(ProgramValidationError);
    expect(rejected).toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ code: failure.code })]),
      stage_correction: { plan_id: draft.plan_id, correction_allowed: true, remaining_calls: 2, remaining_tools: 7, deadline_at: draft.deadline_at },
    });
    expect(fixture.planner.projection()).toMatchObject({
      plan_id: draft.plan_id, state: "planning", planning_active: true,
      calls: 1, tools: 1, deadline_at: draft.deadline_at, candidate: null,
    });
    const sourceEvents = fixture.events.filter((event) => event.type === "planning.precondition_source");
    expect(sourceEvents).toHaveLength(1);
    expect(sourceEvents[0]?.details).toMatchObject({
      plan_id: draft.plan_id, source_chunk: failure.source, chunk_index: 0,
      chunk_count: 1, chunk_unit: "utf16_code_units",
    });
    expect(fixture.events.find((event) => event.type === "planning.stage_rejected")?.details)
      .toMatchObject({ plan_id: draft.plan_id, state: "planning" });
    expect(fixture.planner.requestCall()).toBe(true);
    fixture.planner.assertToolAuthority("planning_stage");
    const staged = await fixture.planner.stage({
      ...request, precondition_source: 'return context.observation.life.status === "alive";',
    });
    expect(staged).toMatchObject({
      plan_id: draft.plan_id, state: "staged", calls: 2, tools: 2,
      deadline_at: draft.deadline_at, reason: null,
    });
    fixture.planner.finish(draft.plan_id);
    fixture.succeed();
    expect((await fixture.planner.activate(draft.plan_id)).state).toBe("activated");
    expect(fixture.admitted).toHaveLength(1);
  });
}

test("invalid source cannot obtain another model request when the original call budget is exhausted", async () => {
  const fixture = setup();
  fixture.request.budget.calls = 1;
  const draft = fixture.arm(); fixture.planner.begin();
  expect(fixture.planner.requestCall()).toBe(true);
  fixture.planner.assertToolAuthority("planning_stage");
  let rejected: unknown;
  try {
    await fixture.planner.stage({
      plan_id: draft.plan_id,
      skill: { skill_id: fixture.candidate.skill_id, version: fixture.candidate.version },
      args: null, limits: { duration_ms: 1000, max_actions: 1, max_calls: 2, max_depth: 1 },
      precondition_source: "return (",
    });
  } catch (error) { rejected = error; }
  expect(rejected).toMatchObject({ stage_correction: { correction_allowed: false, remaining_calls: 0 } });
  expect(fixture.planner.requestCall()).toBe(false);
  fixture.planner.finish(draft.plan_id);
  expect(fixture.planner.projection()?.state).toBe("empty");
  expect(fixture.admitted).toEqual([]);
});

test("unsafe source remains terminal and forbidden effect or registration tools cannot gain authority", async () => {
  const fixture = setup();
  const draft = fixture.arm(); fixture.planner.begin();
  fixture.planner.assertToolAuthority("planning_stage");
  await expect(fixture.planner.stage({
    plan_id: draft.plan_id,
    skill: { skill_id: fixture.candidate.skill_id, version: fixture.candidate.version },
    args: null, limits: { duration_ms: 1000, max_actions: 1, max_calls: 2, max_depth: 1 },
    precondition_source: "return process.pid;",
  })).rejects.toThrow();
  expect(fixture.planner.projection()).toMatchObject({ state: "rejected", reason: "precondition_error", planning_active: false });
  expect(fixture.planner.requestCall()).toBe(false);
  const other = setup(); other.arm(); other.planner.begin();
  for (const name of ["skill_start", "skill_register", "skill_revise", "planning_activate", "policy_activate"])
    expect(() => other.planner.assertToolAuthority(name)).toThrow("only permits");
  expect(other.admitted).toEqual([]);
});

test("pending or unsuccessful predecessors cannot activate a staged draft", async () => {
  const pending = setup();
  const pendingId = await pending.stage();
  await expect(pending.planner.activate(pendingId)).rejects.toThrow("still pending");
  expect(pending.planner.projection()?.state).toBe("staged");
  const failed = setup();
  const failedId = await failed.stage();
  failed.context.root.status = "failed";
  failed.planner.predecessorSettled("root");
  await expect(failed.planner.activate(failedId)).rejects.toThrow();
  expect(failed.planner.projection()).toMatchObject({ state: "rejected", reason: "predecessor_unsuccessful" });
  expect(failed.admitted).toEqual([]);
});

test("new player life invalidates an asynchronous precondition and captured authoring permission", async () => {
  const fixture = setup();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<boolean>();
  fixture.state.evaluate = async (_source, _context, signal) => { entered.resolve(); await release.promise; expect(signal.aborted).toBe(true); return true; };
  const id = await fixture.stage();
  fixture.succeed();
  const activation = fixture.planner.activate(id);
  await entered.promise;
  fixture.context.life_id = 2;
  fixture.planner.invalidate("life_changed");
  release.resolve(true);
  expect(await activation).toMatchObject({ state: "invalidated", reason: "life_changed" });
  expect(fixture.admitted).toEqual([]);

  const author = setup();
  author.arm(); author.planner.begin();
  const permit = author.planner.authority();
  author.context.life_status = "dead";
  expect(permit).toThrow("life_changed");
  expect(author.planner.requestCall()).toBe(false);
});

test("predecessor replacement and changed candidate or dependency source reject fresh admission", async () => {
  const replaced = setup();
  const replacedId = await replaced.stage();
  replaced.succeed(); replaced.context.root.execution_id = "replacement";
  await expect(replaced.planner.activate(replacedId)).rejects.toThrow("predecessor_changed");
  expect(replaced.admitted).toEqual([]);

  const changed = setup();
  const changedId = await changed.stage(); changed.succeed();
  changed.candidate.source += "\nreturn null;";
  expect(await changed.planner.activate(changedId)).toMatchObject({ state: "rejected", reason: "source_changed" });
  expect(changed.admitted).toEqual([]);

  const graph = setup();
  const graphId = await graph.stage(); graph.succeed();
  const dependency = source("new-dependency");
  graph.sources.set(dependency.skill_id, dependency);
  graph.candidate.dependencies.push({ skill_id: dependency.skill_id, version: 1 });
  expect(await graph.planner.activate(graphId)).toMatchObject({ state: "rejected", reason: "source_changed" });
});

test("activation is single-use and reserves validation before any asynchronous read", async () => {
  const fixture = setup();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<boolean>();
  fixture.state.evaluate = async () => { entered.resolve(); return await release.promise; };
  const id = await fixture.stage(); fixture.succeed();
  const first = fixture.planner.activate(id);
  await entered.promise;
  await expect(fixture.planner.activate(id)).rejects.toThrow("not staged");
  release.resolve(true);
  expect((await first).state).toBe("activated");
  await expect(fixture.planner.activate(id)).rejects.toThrow("already activated");
  expect(fixture.admitted).toHaveLength(1);
});

test("Stop between precondition and durable admission revokes the actual admission permit", async () => {
  const fixture = setup();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  fixture.state.beforeAdmit = async () => { entered.resolve(); await release.promise; };
  const id = await fixture.stage(); fixture.succeed();
  const activation = fixture.planner.activate(id);
  await entered.promise;
  fixture.planner.invalidate("cancelled");
  release.resolve();
  expect((await activation).state).toBe("invalidated");
  expect(fixture.admitted).toEqual([]);
});

test("one root gets one bounded flight; request and tool budgets cannot grant unbounded continuation", () => {
  const fixture = setup();
  fixture.request.budget.calls = 1; fixture.request.budget.tools = 1;
  fixture.arm(); fixture.planner.begin();
  expect(fixture.planner.requestCall()).toBe(true);
  expect(fixture.planner.requestCall()).toBe(false);
  fixture.planner.assertToolAuthority("skill_read");
  expect(() => fixture.planner.assertToolAuthority("skill_read")).toThrow("budget exhausted");
  expect(fixture.planner.projection()).toMatchObject({ state: "rejected", reason: "budget_exhausted", calls: 1, tools: 1 });
  expect(fixture.arm).toThrow("unused lookahead allowance");
});

test("selected attention wakes once, expires even while strategy is busy, and cannot poll", () => {
  vi.useFakeTimers();
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  const fixture = setup();
  fixture.request.after_ms = 1000;
  fixture.request.budget.duration_ms = 1000;
  fixture.arm();
  clock.mockReturnValue(999);
  vi.advanceTimersByTime(999);
  expect(fixture.state.wakes).toBe(0);
  clock.mockReturnValue(1000);
  vi.advanceTimersByTime(1);
  expect(fixture.state.wakes).toBe(1);
  clock.mockReturnValue(2001);
  vi.advanceTimersByTime(1001);
  expect(fixture.state.wakes).toBe(1);
  expect(fixture.planner.projection()).toMatchObject({ state: "expired", reason: "deadline" });
  expect(fixture.planner.begin()).toBeNull();
  expect(fixture.planner.requestCall()).toBe(false);
});

test("staging, predecessor closure and fresh validation share the original total deadline", async () => {
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  const fixture = setup();
  const draft = fixture.arm();
  fixture.planner.begin();
  clock.mockReturnValue(10_000);
  await fixture.planner.stage({
    plan_id: draft.plan_id,
    skill: { skill_id: fixture.candidate.skill_id, version: fixture.candidate.version },
    args: null, limits: { duration_ms: 1000, max_actions: 1, max_calls: 2, max_depth: 1 },
    precondition_source: "return context.observation.player.health > 0;",
  });
  fixture.planner.finish(draft.plan_id);
  expect(fixture.planner.projection()?.deadline_at).toBe(draft.deadline_at);
  clock.mockReturnValue(15_000);
  fixture.succeed();
  expect(fixture.planner.projection()?.deadline_at).toBe(draft.deadline_at);
  clock.mockReturnValue(29_000);
  fixture.state.evaluate = async () => {
    clock.mockReturnValue(30_000);
    return true;
  };
  expect(await fixture.planner.activate(draft.plan_id))
    .toMatchObject({ state: "expired", reason: "deadline", activation_execution_id: null });
  expect(fixture.reads).toHaveLength(1);
  expect(fixture.admitted).toEqual([]);
});

test("session epoch and task replacement revoke an in-flight read-only validation", async () => {
  for (const kind of ["epoch", "task", "generation"] as const) {
    const fixture = setup();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<boolean>();
    fixture.state.evaluate = async () => { entered.resolve(); return await release.promise; };
    const id = await fixture.stage(); fixture.succeed();
    const activation = fixture.planner.activate(id); await entered.promise;
    if (kind === "epoch") fixture.context.epoch++;
    else if (kind === "generation") fixture.context.generation++;
    else fixture.context.task = "A different task";
    release.resolve(true);
    expect(await activation).toMatchObject({ state: "rejected", reason: kind === "task" ? "task_changed" : "session_changed" });
    expect(fixture.admitted).toEqual([]);
  }
});

test("isolated false preconditions reject and forbidden gameplay tools cannot enter lookahead", async () => {
  const fixture = setup();
  const id = await fixture.stage(); fixture.succeed();
  fixture.state.evaluate = async () => false;
  expect(await fixture.planner.activate(id)).toMatchObject({ state: "rejected", reason: "precondition_failed" });
  expect(fixture.admitted).toEqual([]);
  const other = setup(); other.arm(); other.planner.begin();
  expect(() => other.planner.assertToolAuthority("skill_start")).toThrow("only permits");
  expect(() => other.planner.assertToolAuthority("planning_activate")).toThrow("only permits");
});

test("fresh observation must match session and life even when the outer host context is unchanged", async () => {
  for (const key of ["session", "life"] as const) {
    const fixture = setup(); const id = await fixture.stage(); fixture.succeed();
    if (key === "session") fixture.observation.session_id = "different";
    else fixture.observation.life.life_id = 99;
    expect(await fixture.planner.activate(id)).toMatchObject({ state: "rejected", reason: key === "session" ? "session_changed" : "life_changed" });
    expect(fixture.admitted).toEqual([]);
  }
});

test("an old cancelled activation cannot overwrite or return a new root draft", async () => {
  const fixture = setup();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<boolean>();
  fixture.state.evaluate = async () => { entered.resolve(); return await release.promise; };
  const id = await fixture.stage(); fixture.succeed();
  const activation = fixture.planner.activate(id); await entered.promise;
  fixture.planner.invalidate("life_changed");
  fixture.context.life_id = 2; fixture.context.root.execution_id = "new-root"; fixture.context.root.status = "running";
  fixture.request.root_execution_id = "new-root";
  const next = fixture.arm();
  release.resolve(true);
  expect(await activation).toMatchObject({ plan_id: id, state: "invalidated", reason: "life_changed" });
  expect(fixture.planner.projection()).toMatchObject({ plan_id: next.plan_id, state: "armed" });
  expect(fixture.admitted).toEqual([]);
});
