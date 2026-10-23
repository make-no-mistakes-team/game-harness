import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core/types";
import { getBundledModel, getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { buildTransformedCodexRequestBody } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { adaptSchemaForStrict, validateJsonSchemaValue } from "@oh-my-pi/pi-ai/utils/schema";
import type { GameAPI } from "../src/shared/programs.ts";
import type { Observation } from "../src/shared/contracts.ts";
import { gameActionResultSchema, observationSchema, skillResultSchema } from "../src/shared/validation.ts";
import { Store, type StoredRun } from "../src/server/store.ts";
import { SkillManager } from "../src/server/skills.ts";
import { RuntimeTools } from "../src/server/runtime-tools.ts";
import { SpeculativePlanning } from "../src/server/speculative-planning.ts";
import { ImprovementLearning } from "../src/server/improvement-learning.ts";
import { RuntimeFault } from "../src/server/runtime-fault.ts";
import type { ReactiveRuntime } from "../src/server/reactive.ts";
import type { SandboxService } from "../src/server/sandbox.ts";
import { emptyRunUsage } from "../src/server/usage.ts";

const card = { purpose: "Exercise named program lifecycle", applicability: "Authorized neutral fixture", method: "Read and compose bounded results", reason: "Verify the consumer contract", limitations: "No gameplay efficacy claim" };
const source = 'return {status:"completed",summary:"Neutral result",result:args};';
const resources: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of resources.splice(0)) await close(); });

function aborted(signal: AbortSignal) {
  const ready = Promise.withResolvers<void>();
  if (signal.aborted) ready.resolve();
  else signal.addEventListener("abort", () => ready.resolve(), { once: true });
  return ready.promise;
}

function fixture(runner?: SandboxService["runSkill"]) {
  const directory = mkdtempSync(join(tmpdir(), "gameharness-interface-"));
  const store = new Store(directory);
  const run: StoredRun = { run_id: crypto.randomUUID(), world_id: crypto.randomUUID(), epoch: 1,
    session_id: "fixture-session", life_id: 1, task: "Inspect neutral authorized state", goal: "custom", model_id: "fixture-model",
    status: "running", started_at: new Date().toISOString(), ended_at: null, turns: 0, model_status: "idle", error: null, usage: emptyRunUsage(), baseline: {} };
  store.saveRun(run);
  let generation = 1, actions = 0, dispatches = 0;
  let life: Observation["life"] = { life_id: 1, status: "alive", can_respawn: false, death: null };
  const observation = (): Observation => ({ schema_version: 2, session_id: run.session_id!, world_id: run.world_id, epoch: run.epoch,
    life: { ...life, life_id: run.life_id! }, observation_seq: 1,
    captured_at: new Date().toISOString(), profile_id: "player-observable-structured", preset_id: "minecraft-observable-initial-r2",
    player: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 20, food: 20, on_ground: true, in_water: false,
      inventory: [{ name: "stone", display_name: "Stone", count: 2, slot: 0 }] },
    blocks: [{ id: "authorized-block", name: "stone", position: { x: 0, y: 63, z: 0 }, observed_at: "2026-10-22T00:00:00Z", current: true }],
    entities: [{ id: "authorized-item", name: "item", item_name: "stone", position: { x: 1, y: 64, z: 0 }, observed_at: "2026-10-22T00:00:00Z", current: true }],
    sounds: [{ category: "movement", direction: "here", distance: "near", observed_at: "2026-10-22T00:00:00Z" }],
    coverage: { partial: true, max_age_ms: 1000 } });
  const learning = new ImprovementLearning(store);
  let planning: SpeculativePlanning;
  const manager = new SkillManager(store, { runSkill: async (...args) => {
    dispatches++;
    if (runner) return await runner(...args);
    const [body, input, handle] = args;
    const game: GameAPI = { observe: async () => observationSchema.parse(await handle({ kind: "observe" })),
      action: async (action) => gameActionResultSchema.parse(await handle({ kind: "action", action })),
      respawn: async () => gameActionResultSchema.parse(await handle({ kind: "respawn" })),
      recipes: async (item) => await handle({ kind: "recipes", item }),
      call: async (skill, args) => skillResultSchema.parse(await handle({ kind: "call", skill, args })),
      progress: async (summary, details) => await handle({ kind: "progress", summary, details }) as null };
    const execute = new Function("game", "args", `return (async () => {${body}\n})();`);
    return skillResultSchema.parse(await execute(game, input));
  } }, {
    authorize: (runId, epoch, sessionId, lifeId) => { if (runId !== run.run_id || run.status !== "running" || epoch !== run.epoch || sessionId !== run.session_id || lifeId !== run.life_id) throw new RuntimeFault("stale_context", "Fixture authority revoked"); },
    observe: async () => observation(), action: async () => { actions++; return { status: "succeeded", summary: "Neutral receipt", evidence: { effect_confirmed: true } }; },
    recipes: async () => [], cancelActions: async () => {}, recover: async () => { throw new Error("Fixture has no respawn"); },
    changed: (outcome, execution) => { if (outcome && execution) { learning.feedback(run.run_id); planning.predecessorSettled(execution.execution_id); } },
    unsafe: () => {}, prepareLookahead: (config) => planning.prepareOptIn(config),
  });
  const scope = () => ({ run_id: run.run_id, world_id: run.world_id, generation, session_id: run.session_id!, epoch: run.epoch,
    life_id: run.life_id!, life_status: life.status, task: run.task, goal: run.goal });
  planning = new SpeculativePlanning({ admissionContext: () => run.status === "running" ? scope() : null,
    context: () => { const root = store.latestRootExecution(run.run_id); if (!root || run.status !== "running") return null;
      return { ...scope(), root: { ...root, hash: store.skill(run.run_id, root).hash } }; },
    skill: (ref) => store.skill(run.run_id, ref), observe: async () => observation(),
    evaluateGuard: async (body, observation, args) => await new Function("observation", "args", `return (async () => {${body}\n})();`)(observation, args),
    admit: async (request, permit) => { permit.assertCurrent(); return manager.start(run.run_id, request); },
    evidence: (type, details) => { store.event(run.run_id, type, "Planning evidence", details); }, wake: () => {},
  });
  const catalog = new RuntimeTools(store, manager, {} as ReactiveRuntime, null, {
    run: () => run, assertCurrent: (expected) => { if (expected !== generation || !["running", "reviewing"].includes(run.status)) throw new RuntimeFault("stale_context", "Fixture tool authority revoked"); return run; },
    observe: async () => observation(), recipes: async () => [], attentionAfter: () => {}, admitted: () => {},
    evidence: () => [], planning: () => planning, learning: () => learning,
    toolAuthority: () => { const revision = generation; const permit = planning.projection()?.planning_active ? planning.authority() : null;
      return () => { if (generation !== revision || !["running", "reviewing"].includes(run.status)) throw new RuntimeFault("stale_context", "Fixture turn fenced"); permit?.(); }; },
    finishTask: () => { run.status = "stopping"; generation++; planning.invalidate("cancelled"); manager.fence("Custom completion fenced"); store.saveRun(run); },
  });
  const tools = () => catalog.build(generation);
  const call = async (name: string, input: unknown, callId: string = crypto.randomUUID(), selected = tools()) => {
    const tool = selected.find((tool) => tool.name === name);
    if (!tool) throw new Error(`Tool not in actual catalog: ${name}`);
    return await tool.execute(callId, input);
  };
  const close = async () => { planning.invalidate("cancelled"); await manager.closeAll("Fixture complete"); store.close(); rmSync(directory, { recursive: true, force: true }); };
  resources.push(close);
  return { directory, store, run, manager, planning, learning, catalog, tools, call, actions: () => actions, dispatches: () => dispatches,
    observation, setLife: (value: Observation["life"]) => { life = value; },
    fence: () => { generation++; manager.fence("Fixture fenced"); planning.invalidate("cancelled"); },
    write: (name: string, body = source, options: Record<string, unknown> = {}, id?: string) => call("program_write", { name, source: body, card, dependencies: [], ...options }, id),
  };
}

async function waitClosed(store: Store, runId: string, executionId: string) {
  const terminal = () => !["accepted", "running", "cancel_requested"].includes(store.skillExecution(runId, { execution_id: executionId })!.status);
  if (terminal()) return;
  const ready = Promise.withResolvers<void>();
  const unsubscribe = store.subscribe((event) => {
    if (event.run_id === runId && event.type === "skill.closed" && terminal()) { unsubscribe(); ready.resolve(); }
  });
  await ready.promise;
}

function data(reply: AgentToolResult) {
  return JSON.parse(reply.content.filter((entry) => entry.type === "text").map((entry) => entry.text).join(""));
}

test("named writes use optimistic revisions and catalog pagination counts families, not alphabetical tails", async () => {
  const f = fixture();
  const first = data(await f.write("zebra"));
  expect(first).toMatchObject({ name: "zebra", version: 1, state: "validated" });
  expect(first.source).toBeUndefined();
  const revised = data(await f.write("zebra", source, { based_on: 1 }, "revision-call"));
  expect(revised.version).toBe(2);
  expect(data(await f.write("zebra", source, { based_on: 1 }, "revision-call"))).toEqual(revised);
  expect(f.store.skills(f.run.run_id)).toHaveLength(2);
  const stale = data(await f.write("zebra", source, { based_on: 1 }));
  expect(stale.error).toMatchObject({ code: "conflict", issues: [{ code: "stale_parent", latest_parent: { name: "zebra", version: 2 } }] });
  await f.write("alpha");
  const page = data(await f.call("program_inspect", { view: "catalog", limit: 1 }));
  expect(page.records).toMatchObject([{ name: "alpha", version: 1 }]);
  expect(page.has_more).toBe(true);
  const next = data(await f.call("program_inspect", { view: "catalog", limit: 1, after: page.next_after }));
  expect(next.records).toMatchObject([{ name: "zebra", version: 2 }]);
  expect(next.has_more).toBe(false);
  expect(data(await f.call("program_inspect", { view: "source", name: "zebra", version: 1 })).version).toBe(1);
});

test("latest validated selection pins once and never follows newer catalog revisions", async () => {
  const f = fixture();
  await f.write("reader"); await f.write("reader", source, { based_on: 1 });
  const db = new Database(join(f.directory, "runs.sqlite"));
  db.query("UPDATE skills SET metadata=json_set(metadata,'$.state','quarantined') WHERE run_id=? AND name='reader' AND version=2").run(f.run.run_id);
  const started = data(await f.call("program_run", { operation: "start", name: "reader", args: "selected-once" }));
  expect(started.version).toBe(1);
  const admitted = f.store.latestRootExecution(f.run.run_id)!;
  await waitClosed(f.store, f.run.run_id, admitted.execution_id);
  await f.write("reader", source, { based_on: 2 });
  const outcome = data(await f.call("program_inspect", { view: "execution", program: { name: "reader" }, target: "latest" }));
  expect(outcome).toMatchObject({ name: "reader", version: 1, result: { result: "selected-once" } });
  const denied = await f.call("program_run", { operation: "start", name: "reader", version: 2, args: null });
  expect(denied.isError).toBe(true);
  expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(1);
  db.close();
});

test("source game.call resolves only parent-pinned named children after newer child writes", async () => {
  const f = fixture();
  await f.write("child", 'return {status:"completed",summary:"Pinned child",result:1};');
  await f.write("parent", 'return await game.call({name:"child"},args);', { dependencies: [{ name: "child" }] });
  await f.write("child", 'return {status:"completed",summary:"New child",result:2};', { based_on: 1 });
  await f.call("program_run", { operation: "start", name: "parent", args: null });
  const root = f.store.latestRootExecution(f.run.run_id)!;
  await waitClosed(f.store, f.run.run_id, root.execution_id);
  expect(f.store.skillExecution(f.run.run_id, { execution_id: root.execution_id })!.result).toMatchObject({ result: 1 });
  expect(f.store.allSkillExecutions(f.run.run_id).filter((execution) => execution.parent_execution_id === root.execution_id).map((execution) => execution.version)).toEqual([1]);
  await f.write("mismatch", 'return await game.call({name:"child",version:2},args);', { dependencies: [{ name: "child", version: 1 }] });
  await f.call("program_run", { operation: "start", name: "mismatch", args: null });
  const invalid = f.store.latestRootExecution(f.run.run_id)!;
  await waitClosed(f.store, f.run.run_id, invalid.execution_id);
  expect(f.store.skillExecution(f.run.run_id, { execution_id: invalid.execution_id })!.status).toBe("failed");
  expect(f.store.allSkillExecutions(f.run.run_id).filter((execution) => execution.parent_execution_id === invalid.execution_id)).toHaveLength(0);
});

test("lost acknowledgement retries compound trusted call identity with original scope and version", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const f = fixture(async (_source, _args, _handle, _limits, signal) => { entered.resolve(); await Promise.race([release.promise, aborted(signal)]); return { status: "completed", summary: "Released", result: null }; });
  await f.write("durable");
  const db = new Database(join(f.directory, "runs.sqlite"));
  db.exec("CREATE TRIGGER lose_tool_ack BEFORE INSERT ON evidence_objects WHEN NEW.kind='tool_result' BEGIN SELECT RAISE(ABORT,'lost acknowledgement'); END;");
  const id = "call_abcdef0123456789|fc_123456789abcdef0";
  const input = { operation: "start", name: "durable", args: { original: true } };
  expect((await f.call("program_run", input, id)).isError).toBe(true);
  await entered.promise;
  const original = f.store.latestRootExecution(f.run.run_id)!;
  db.exec("DROP TRIGGER lose_tool_ack;");
  f.run.epoch = 2; f.run.life_id = 2; f.store.saveRun(f.run);
  await f.write("durable", source, { based_on: 1 });
  expect(data(await f.call("program_run", input, id)).version).toBe(1);
  expect(f.dispatches()).toBe(1);
  expect(f.store.latestRootExecution(f.run.run_id)).toMatchObject({ execution_id: original.execution_id, epoch: 1, life_id: 1, version: 1 });
  expect(data(await f.call("program_run", { ...input, args: { changed: true } }, id)).error.code).toBe("conflict");
  await f.call("program_run", input, `${id}0`);
  expect(f.store.latestRootExecution(f.run.run_id)).toMatchObject({ epoch: 2, life_id: 2, version: 2 });
  expect(new Set(f.store.allSkillExecutions(f.run.run_id).map((execution) => execution.start_key)).size).toBe(2);
  f.fence(); release.resolve(); await f.manager.closeAll("Fenced after lost acknowledgement"); db.close();
});

test("actual catalogs and dispatch share ordinary, speculative, advanced-module and review permissions", async () => {
  const release = Promise.withResolvers<void>();
  const f = fixture(async (_source, _args, _handle, _limits, signal) => {
    await Promise.race([release.promise, aborted(signal)]);
    return { status: "completed", summary: "Neutral predecessor drained", result: null };
  });
  const ordinary = f.tools();
  expect(ordinary.some((tool) => tool.name === "program_run")).toBe(true);
  expect(ordinary.some((tool) => tool.name === "task_finish")).toBe(true);
  expect(ordinary.some((tool) => tool.name === "prepare_next" || tool.name === "reflex" || tool.name === "memory")).toBe(false);
  await f.call("help", { topic: "reflex" });
  expect(f.tools().some((tool) => tool.name === "reflex")).toBe(true);
  await f.write("predecessor"); await f.write("candidate");
  await f.call("program_run", { operation: "start", name: "predecessor", args: null, next: { after_ms: 0, reason: "Bounded neutral flight", budget: { calls: 1, tools: 8, duration_ms: 30000 } } });
  const plan = f.planning.begin()!;
  expect(plan).not.toBeNull();
  const speculative = f.tools();
  expect(speculative.some((tool) => tool.name === "prepare_next")).toBe(true);
  expect(speculative.some((tool) => tool.name === "program_run" || tool.name === "program_write" || tool.name === "task_finish")).toBe(false);
  expect((await f.call("program_write", { name: "forbidden", source, card, dependencies: [] }, "forbidden-write", ordinary)).isError).toBe(true);
  expect(data(await f.call("task_finish", { summary: "Not authorized during speculation" }, "forbidden-spec-finish", ordinary)).error.code).toBe("forbidden");
  expect(data(await f.call("prepare_next", { name: "candidate", args: null })).guard_status).toBe("omitted");
  f.planning.finish(plan.plan_id); release.resolve();
  const root = f.store.latestRootExecution(f.run.run_id)!;
  await waitClosed(f.store, f.run.run_id, root.execution_id);
  f.run.status = "reviewing";
  expect(f.tools().some((tool) => tool.name === "program_review")).toBe(true);
  expect(f.tools().some((tool) => tool.name === "program_run" || tool.name === "prepare_next" || tool.name === "task_finish")).toBe(false);
  expect((await f.call("program_run", { operation: "start", name: "candidate", args: null }, "forbidden-review-run", ordinary)).isError).toBe(true);
  expect(data(await f.call("task_finish", { summary: "Not authorized during review" }, "forbidden-review-finish", ordinary)).error.code).toBe("forbidden");
  await f.call("help", { topic: "memory" });
  expect(f.tools().some((tool) => tool.name === "memory")).toBe(false);
  expect(f.actions()).toBe(0);
  expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(1);
});

test("task_finish persists an immutable acknowledgement despite consuming its own authority", async () => {
  const entered = Promise.withResolvers<void>();
  const f = fixture(async (_source, _args, _handle, _limits, signal) => {
    entered.resolve();
    await aborted(signal);
    return { status: "completed", summary: "Fenced worker settled", result: null };
  });
  await f.write("pending");
  const ordinary = f.tools();
  await f.call("program_run", { operation: "start", name: "pending", args: null });
  await entered.promise;
  const root = f.store.latestRootExecution(f.run.run_id)!;
  const id = "finish-once";
  const input = { summary: "  Whole task done from authorized evidence  " };
  const first = await f.call("task_finish", input, id, ordinary);
  expect(first.isError).not.toBe(true);
  expect(data(first)).toEqual({ status: "stopping", verification: "unverified" });
  expect(f.run.status).toBe("stopping");
  expect(f.store.completedToolCall(f.run.run_id, id, {
    tool: "task_finish", input: { summary: "Whole task done from authorized evidence" },
  })).toEqual({ status: "stopping", verification: "unverified" });
  await waitClosed(f.store, f.run.run_id, root.execution_id);
  expect(f.store.skillExecution(f.run.run_id, { execution_id: root.execution_id })?.status).toBe("cancelled");
  f.run.status = "stopped";
  expect(data(await f.call("task_finish", input, id, ordinary))).toEqual({ status: "stopping", verification: "unverified" });
  expect(f.run.status).toBe("stopped");
  expect(data(await f.call("task_finish", { summary: "Changed claim" }, id, ordinary)).error.code).toBe("conflict");
  expect(data(await f.call("task_finish", input, "new-finish", ordinary)).error.code).toBe("stale_context");
  expect(data(await f.call("program_run", { operation: "start", name: "pending", args: null }, "after-finish", ordinary)).error.code).toBe("stale_context");
  expect((await f.write("after-finish")).isError).toBe(true);
  expect(f.store.skills(f.run.run_id).map((program) => program.name)).toEqual(["pending"]);
  expect(f.dispatches()).toBe(1);
  expect(f.store.eventsAfter(f.run.run_id, 0, 500).filter((event) =>
    event.type === "model.tool_result" && event.details !== null && typeof event.details === "object" &&
    !Array.isArray(event.details) && event.details.tool === "task_finish")).toHaveLength(1);
});

test("task_finish validates bounded summaries and preserves cancellation, generation and built-in authority checks", async () => {
  const f = fixture();
  const ordinary = f.tools();
  for (const input of [{}, { summary: "" }, { summary: "   " }, { summary: "x".repeat(2001) }, { summary: 1 }, { summary: "Done", extra: true }]) {
    expect(data(await f.call("task_finish", input)).error.code).toBe("invalid_request");
    expect(f.run.status).toBe("running");
  }
  const cancelled = new AbortController();
  cancelled.abort();
  expect(data(await ordinary.find((tool) => tool.name === "task_finish")!.execute(
    "cancelled-finish", { summary: "Not admitted" }, cancelled.signal,
  )).error.code).toBe("stale_context");
  f.run.goal = "collect_wood";
  expect(data(await f.call("task_finish", { summary: "Not trusted proof" }, "built-in-finish", ordinary)).error.code).toBe("forbidden");
  expect(f.run.status).toBe("running");
  f.run.goal = "custom";
  f.fence();
  expect(data(await f.call("task_finish", { summary: "Stale claim" }, "stale-finish", ordinary)).error.code).toBe("stale_context");
  expect(f.run.status).toBe("running");
  expect(f.store.eventsAfter(f.run.run_id, 0, 500).some((event) => event.type === "model.tool_result")).toBe(false);
});

test("effect-free review links actual revisions to exact matching feedback and inspection stays read-only", async () => {
  const f = fixture();
  await f.write("reviewed");
  await f.call("program_run", { operation: "start", name: "reviewed", args: null });
  const root = f.store.latestRootExecution(f.run.run_id)!;
  await waitClosed(f.store, f.run.run_id, root.execution_id);
  f.learning.feedback(f.run.run_id);
  f.run.status = "reviewing";
  const before = JSON.stringify(f.store.evidenceObjects(f.run.run_id, "opportunity"));
  await f.call("program_inspect", { view: "feedback", program: { name: "reviewed", version: 1 } });
  expect(JSON.stringify(f.store.evidenceObjects(f.run.run_id, "opportunity"))).toBe(before);
  const written = data(await f.write("reviewed", 'return {status:"blocked",summary:"Candidate needs future measurement",result:null};', { based_on: 1, reason: "Test a changed code path; efficacy remains unproven" }));
  expect(written).toMatchObject({ name: "reviewed", version: 2, experiment: { decision: "revise", measured: false, qualification: "candidate_not_proven_improvement" } });
  const opportunities = f.store.evidenceObjects<{ resolution: { revision: { version: number }; measured: boolean } }>(f.run.run_id, "opportunity");
  expect(opportunities[0]!.resolution).toMatchObject({ revision: { version: 2 }, measured: false });
  expect(data(await f.call("program_review", { name: "reviewed", version: 2, decision: "keep", reason: "No outcome exists" })).error.code).toBe("not_found");
  expect(f.actions()).toBe(0);
  expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(1);
});

test("stop fences the actual named execution and stale tool closures cannot write", async () => {
  const f = fixture(async (_source, _args, _handle, _limits, signal) => {
    await aborted(signal);
    return { status: "completed", summary: "Worker neutralized", result: null };
  });
  await f.write("stoppable");
  await f.call("program_run", { operation: "start", name: "stoppable", args: null });
  const root = f.store.latestRootExecution(f.run.run_id)!;
  expect(data(await f.call("program_run", { operation: "stop" })).status).toBe("cancel_requested");
  await waitClosed(f.store, f.run.run_id, root.execution_id);
  expect(f.store.skillExecution(f.run.run_id, { execution_id: root.execution_id })!.status).toBe("cancelled");
  const old = f.tools(); f.fence();
  expect((await f.call("program_write", { name: "stale", source, card, dependencies: [] }, "stale-call", old)).isError).toBe(true);
  expect(f.store.namedSkill(f.run.run_id, "stale")).toBeNull();
  expect(f.actions()).toBe(0);
});

test("retained incompatible source remains readable but cannot be admitted", async () => {
  const f = fixture();
  await f.write("legacy");
  const original = f.store.namedSkill(f.run.run_id, "legacy")!;
  const db = new Database(join(f.directory, "runs.sqlite"));
  db.query("UPDATE skills SET metadata=json_remove(metadata,'$.validation.runtime_version') WHERE run_id=? AND name='legacy'").run(f.run.run_id);
  const inspected = data(await f.call("program_inspect", { view: "source", name: "legacy", version: 1 }));
  expect(inspected.source).toBe(original.source);
  expect(inspected.validation.runtime_version).toBeNull();
  const rejected = data(await f.call("program_run", { operation: "start", name: "legacy", version: 1, args: null }));
  expect(rejected.error.code).toBe("precondition_failed");
  expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(0);
  expect(f.dispatches()).toBe(0);
  db.close();
});

test("oversized evidence omissions advance the actual event cursor without hiding the next record", async () => {
  const f = fixture();
  const large = f.store.event(f.run.run_id, "fixture.large", "Oversized retained evidence", { value: "x".repeat(52000) });
  const next = f.store.event(f.run.run_id, "fixture.next", "Next retained evidence", { value: "bounded" });
  const omitted = data(await f.call("program_inspect", { view: "events", after: large.event_seq - 1, limit: 1 }));
  expect(omitted.records).toEqual([]);
  expect(omitted.omissions).toMatchObject([{ reason: "record_byte_budget" }]);
  expect(omitted.next_after).toBe(large.event_seq);
  expect(omitted.has_more).toBe(true);
  const resumed = data(await f.call("program_inspect", { view: "events", after: omitted.next_after, limit: 1 }));
  expect(resumed.records[0]).toMatchObject({ event_seq: next.event_seq, type: "fixture.next" });
});

test("named keep assessment is exact, immutable and never authorizes effects", async () => {
  const f = fixture();
  await f.write("kept");
  await f.call("program_run", { operation: "start", name: "kept", args: null });
  const root = f.store.latestRootExecution(f.run.run_id)!;
  await waitClosed(f.store, f.run.run_id, root.execution_id);
  await f.write("kept", source, { based_on: 1 });
  f.learning.feedback(f.run.run_id); f.run.status = "reviewing";
  const choice = { name: "kept", decision: "keep", reason: "Retain this version without an efficacy claim" };
  expect(data(await f.call("program_review", choice, "keep-call"))).toMatchObject({ name: "kept", version: 1, decision: "keep" });
  expect(data(await f.call("program_review", choice, "keep-call"))).toMatchObject({ decision: "keep" });
  expect(data(await f.call("program_review", { ...choice, decision: "insufficient_evidence" })).error.code).toBe("conflict");
  expect(f.store.evidenceObjects<{ resolution: { revision: unknown } }>(f.run.run_id, "opportunity")[0]!.resolution.revision).toBeNull();
  expect(f.actions()).toBe(0);
  expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(1);
});

test("a trace continuation cursor stays pinned when a newer execution becomes latest", async () => {
  const f = fixture();
  await f.write("traced", 'await game.progress("Run marker",args); return {status:"completed",summary:"Marker retained",result:null};');
  await f.call("program_run", { operation: "start", name: "traced", args: "original-execution" });
  const original = f.store.latestRootExecution(f.run.run_id)!;
  await waitClosed(f.store, f.run.run_id, original.execution_id);
  const originalTrace = f.store.tracePage(f.run.run_id, 0, 100, original.execution_id);
  const first = data(await f.call("program_inspect", { view: "trace", program: { name: "traced" }, limit: 1 }));
  expect(first.has_more).toBe(true);
  await f.call("program_run", { operation: "start", name: "traced", args: "newer-execution" });
  const newer = f.store.latestRootExecution(f.run.run_id)!;
  await waitClosed(f.store, f.run.run_id, newer.execution_id);
  const continued = data(await f.call("program_inspect", { view: "trace", program: { name: "traced" }, after: first.next_after, limit: 100 }));
  expect(continued.records.length).toBeGreaterThan(0);
  expect(continued.records.every((record: { trace_seq: number }) => originalTrace.records.some((original) => original.trace_seq === record.trace_seq))).toBe(true);
  expect(JSON.stringify(continued)).not.toContain("newer-execution");
});

test("actual execution and trace inspection preserve opaque model JSON keys and SDK observations", async () => {
  const f = fixture();
  const opaque = { hash: "sample", session_id: "model-session", life_id: 42, epoch: 17, run_id: "model-run",
    nested: [{ action_id: "model-action", plan_id: "model-plan", source_hash: "model-source", value: { hash: "nested" } }],
    skill_id: "model-data-not-a-reference", version: 99 };
  await f.write("opaque echo");
  await f.write("opaque parent", 'const child = await game.call({name:"opaque echo"},args); await game.progress("Opaque diagnostic",args); const observed = await game.observe(); return {status:"completed",summary:"Opaque values retained",result:{payload:child.result,sdk:observed}};', {
    dependencies: [{ name: "opaque echo" }],
  });
  await f.call("program_run", { operation: "start", name: "opaque parent", args: opaque });
  const root = f.store.latestRootExecution(f.run.run_id)!;
  await waitClosed(f.store, f.run.run_id, root.execution_id);
  const inspected = data(await f.call("program_inspect", { view: "execution", program: { name: "opaque parent" } }));
  expect(inspected.args).toEqual(opaque);
  expect(inspected.result.result.payload).toEqual(opaque);
  expect(inspected.result.result.sdk).toMatchObject({ schema_version: 2, session_id: f.run.session_id, world_id: f.run.world_id,
    epoch: f.run.epoch, life: { life_id: f.run.life_id }, blocks: [{ id: "authorized-block" }], entities: [{ id: "authorized-item", item_name: "stone" }] });
  expect(inspected.execution_id).toBeUndefined();
  expect(inspected.session_id).toBeUndefined();
  const trace = data(await f.call("program_inspect", { view: "trace", program: { name: "opaque parent" }, limit: 100 }));
  expect(trace.records.find((record: { kind: string }) => record.kind === "intent").payload.details).toEqual(opaque);
  const childResult = trace.records.find((record: { kind: string; capability: string }) => record.kind === "capability_result" && record.capability === "call");
  expect(childResult.payload.result.result).toEqual(opaque);
  expect(trace.records.find((record: { kind: string }) => record.kind === "observation").payload.blocks[0].id).toBe("authorized-block");
});

test("feedback names every exact version and distinguishes neutral executions without objective event sequences", async () => {
  const f = fixture();
  await f.write("measured A");
  const execute = async (name: string) => {
    await f.call("program_run", { operation: "start", name, args: null });
    const execution = f.store.latestRootExecution(f.run.run_id)!;
    await waitClosed(f.store, f.run.run_id, execution.execution_id);
  };
  await execute("measured A"); await execute("measured A");
  await f.write("measured A", source, { based_on: 1 });
  await execute("measured A");
  await f.write("measured B"); await execute("measured B");
  f.learning.feedback(f.run.run_id);
  const feedback = data(await f.call("program_inspect", { view: "feedback", limit: 100 }));
  expect(feedback.metrics.map((metric: { name: string; version: number }) => ({ name: metric.name, version: metric.version }))).toEqual([
    { name: "measured A", version: 1 }, { name: "measured A", version: 1 }, { name: "measured A", version: 2 }, { name: "measured B", version: 1 },
  ]);
  const ordinals = feedback.metrics.map((metric: { execution_ordinal: number }) => metric.execution_ordinal);
  expect(ordinals.every((ordinal: unknown) => typeof ordinal === "number" && Number.isSafeInteger(ordinal) && ordinal > 0)).toBe(true);
  expect(new Set(ordinals).size).toBe(4);
  expect(feedback.metrics.every((metric: { evidence_event_seqs: number[] }) => metric.evidence_event_seqs.length === 0)).toBe(true);
  expect(feedback.metrics.every((metric: { execution_id?: string; root_execution_id?: string }) => metric.execution_id === undefined && metric.root_execution_id === undefined)).toBe(true);
  const again = data(await f.call("program_inspect", { view: "feedback", limit: 100 }));
  expect(again.metrics.map((metric: { execution_ordinal: number }) => metric.execution_ordinal)).toEqual(ordinals);
});

test("ordinary and speculative observe project housekeeping only and retain authorized gameplay data", async () => {
  const release = Promise.withResolvers<void>();
  const f = fixture(async (_source, _args, _handle, _limits, signal) => {
    await Promise.race([release.promise, aborted(signal)]);
    return { status: "completed", summary: "Neutral predecessor ended", result: null };
  });
  const assertGameplay = (observed: Record<string, any>) => {
    expect(observed.schema_version).toBe(2);
    expect(observed.session_id).toBeUndefined(); expect(observed.world_id).toBeUndefined(); expect(observed.epoch).toBeUndefined();
    expect(observed.life.life_id).toBeUndefined();
    expect(observed.player).toEqual(f.observation().player);
    expect(observed.blocks).toEqual(f.observation().blocks);
    expect(observed.entities).toEqual(f.observation().entities);
    expect(observed.sounds).toEqual(f.observation().sounds);
    expect(observed.coverage).toEqual(f.observation().coverage);
    expect(observed.observation_seq).toBe(1);
    expect(typeof observed.captured_at).toBe("string");
  };
  assertGameplay(data(await f.call("observe", {})));
  await f.write("observe predecessor");
  await f.call("program_run", { operation: "start", name: "observe predecessor", args: null,
    next: { after_ms: 0, reason: "Inspect authorized observation projection", budget: { calls: 1, tools: 4, duration_ms: 30000 } } });
  const flight = f.planning.begin()!;
  assertGameplay(data(await f.call("observe", {})));
  f.planning.finish(flight.plan_id); release.resolve();
  const root = f.store.latestRootExecution(f.run.run_id)!;
  await waitClosed(f.store, f.run.run_id, root.execution_id);
  f.setLife({ life_id: 1, status: "dead", can_respawn: true, death: { death_id: "private-death", at: "2026-10-22T00:00:00Z", message: "Observed ordinary death" } });
  const dead = data(await f.call("observe", {}));
  assertGameplay(dead);
  expect(dead.life).toEqual({ status: "dead", can_respawn: true, death: { at: "2026-10-22T00:00:00Z", message: "Observed ordinary death" } });
  expect(f.observation().life.death?.death_id).toBe("private-death");
});

test("Codex wire preserves optional program arguments and discriminants through actual dispatch", async () => {
  const f = fixture();
  const descriptor = getBundledModels("openai-codex").find((model) => model.api === "openai-codex-responses");
  if (!descriptor) throw new Error("The installed static catalog has no Codex descriptor for offline schema translation");
  const model = getBundledModel<"openai-codex-responses">("openai-codex", descriptor.id);
  const tools = f.tools();
  // The real pure SDK request builder never opens a transport or resolves credentials.
  const request = await buildTransformedCodexRequestBody(model, {
    systemPrompt: ["Offline tool-schema regression"],
    messages: [{ role: "user", content: "Inspect the tool contract without inference.", timestamp: 0 }],
    tools,
  }, { responsesLite: false });
  const wireTools = z.array(z.object({ type: z.literal("function"), name: z.string(),
    parameters: z.record(z.string(), z.unknown()), strict: z.boolean().optional() }).loose()).parse(request.tools);
  const wireSchema = (name: string) => {
    const declaration = wireTools.find((tool) => tool.name === name);
    if (!declaration) throw new Error(`The actual Codex payload omitted ${name}`);
    // Model the documented Responses omission default, not an observed remote grammar:
    // https://developers.openai.com/api/docs/guides/function-calling#strict-mode
    return adaptSchemaForStrict(declaration.parameters, declaration.strict ?? true).schema;
  };
  const creation = { name: "wire neutral", source, card, dependencies: [] };
  expect(validateJsonSchemaValue(wireSchema("program_write"), creation)).toEqual({ success: true, issues: [] });
  const admitted = data(await f.call("program_write", creation, "wire-create", tools));
  expect(admitted).toMatchObject({ name: "wire neutral", version: 1, state: "validated" });
  const stored = data(await f.call("program_inspect", { view: "source", name: "wire neutral", version: 1 }));
  expect(stored).toMatchObject({ name: "wire neutral", version: 1, state: "validated" });
  expect(typeof stored.source).toBe("string");
  expect(validateJsonSchemaValue(wireSchema("program_run"), { operation: "inspect", target: "current" })).toEqual({ success: true, issues: [] });
  const mixed = { operation: "inspect", target: "current", name: "wire neutral" };
  expect(validateJsonSchemaValue(wireSchema("program_run"), mixed).success).toBe(false);
  expect(data(await f.call("program_run", mixed)).error.code).toBe("invalid_request");
  await f.call("program_run", { operation: "start", name: "wire neutral", args: { preserved: true } });
  const root = f.store.latestRootExecution(f.run.run_id)!;
  await waitClosed(f.store, f.run.run_id, root.execution_id);
  expect(data(await f.call("program_inspect", { view: "execution", program: { name: "wire neutral" } })).result.result).toEqual({ preserved: true });
  const revision = { ...creation, based_on: 1 };
  expect(validateJsonSchemaValue(wireSchema("program_write"), revision)).toEqual({ success: true, issues: [] });
  expect(data(await f.call("program_write", revision, "wire-revision"))).toMatchObject({ version: 2, state: "validated" });
  expect(data(await f.call("program_write", revision, "wire-stale-revision")).error.code).toBe("conflict");
  expect(data(await f.call("program_inspect", { view: "catalog" })).records).toMatchObject([{ name: "wire neutral", version: 2 }]);
});
