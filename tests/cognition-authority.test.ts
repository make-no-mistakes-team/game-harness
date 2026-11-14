import { afterEach, expect, spyOn, test } from "bun:test";
import type { Json } from "../src/shared/contracts.ts";
import { DEFAULT_SKILL_LIMITS, type SkillExecutionView } from "../src/shared/programs.ts";
import { CognitionAuthority } from "../src/server/cognition-authority.ts";
import { SpeculativePlanning } from "../src/server/speculative-planning.ts";
import type { CognitionRequestIdentity } from "../src/server/cognition-ports.ts";
import * as monotonic from "../src/server/os-monotonic.ts";
import { osMonotonicNs } from "../src/server/os-monotonic.ts";
import { eventLoopTurn, passiveHostFixture, type PassiveHostFixture } from "./helpers/cognition-process.fixture.ts";

const fixtures: PassiveHostFixture[] = [];
const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
  for (const fixture of fixtures.splice(0)) fixture.close();
});
function fixture() {
  const f = passiveHostFixture(); fixtures.push(f);
  const root = spyOn(f.store, "latestRootExecution").mockImplementation(() => f.state.root);
  restores.push(() => root.mockRestore());
  const authority = new CognitionAuthority(f.store, f.host);
  authority.start(f.run, 1);
  return { ...f, authority };
}
function identity(authority: CognitionAuthority, overrides: Partial<CognitionRequestIdentity> = {}): CognitionRequestIdentity {
  const deadline = osMonotonicNs() + 10_000_000_000n;
  authority.beginTurn("turn-1", deadline);
  return { turn_id: "turn-1", request_id: "request-1", generation: 1, role: "ordinary",
    deadline_os_ns: deadline.toString(), phase: "running", root_execution_id: null, source_hash: null,
    authoring_deadline_at: null, pending_decision: false, plan_id: null, ...overrides };
}
function response(authority: CognitionAuthority, args: unknown = { value: 7 }, name = "help") {
  authority.response({ request_id: "request-1", successful: true, calls: [{ id: "call-1", name, arguments: args }] });
}
function root(f: PassiveHostFixture): SkillExecutionView {
  // Identity-only root metadata. No source is registered, compiled or executed.
  return { execution_id: "root-1", root_execution_id: "root-1", parent_execution_id: null,
    run_id: f.run.run_id, world_id: f.run.world_id, start_key: "root-start", skill_id: "metadata-only", version: 1,
    epoch: f.run.epoch, session_id: f.run.session_id, life_id: f.run.life_id, native_boot_id: f.run.native_boot_id,
    run_generation: 1, space_epoch: f.run.space_epoch, source_hash: "a".repeat(64), compatibility_hash: f.run.compatibility_hash,
    args: null, status: "running", started_at: new Date().toISOString(), ended_at: null,
    deadline_at: new Date(Date.now() + 60_000).toISOString(), actions: 0, calls: 0, result: null, error: null,
    entry: "run", limits: { ...DEFAULT_SKILL_LIMITS, duration_ms: 60_000 } };
}

function speculativeFlight(f: ReturnType<typeof fixture>, tools: number) {
  const original = f.host.speculation!().projection()!;
  const currentRoot = root(f);
  f.state.root = currentRoot;
  f.state.pending = true;
  const basis = { ...original.basis, root: { ...original.basis.root,
    execution_id: currentRoot.execution_id, skill_id: currentRoot.skill_id,
    version: currentRoot.version, hash: currentRoot.source_hash!, status: currentRoot.status } };
  const adapter = f.host.adapter?.();
  if (!adapter) throw new Error("Speculative fixture requires its registered adapter");
  const planning = new SpeculativePlanning({
    contract: () => adapter,
    admissionContext: () => basis,
    context: () => basis,
    skill: () => { throw new Error("Source staging is outside this authority regression"); },
    observe: () => f.host.observe(),
    evaluateGuard: async () => { throw new Error("No guard evaluation is admitted"); },
    admit: async () => { throw new Error("No gameplay admission is permitted"); },
    evidence: (type, details) => { f.store.event(f.run.run_id, type, "Speculative authority regression", details); },
    wake: () => f.authority.wake("speculative_lookahead"),
  });
  f.host.speculation = () => planning;
  restores.push(() => planning.invalidate("cancelled"));
  planning.optIn({ root_execution_id: currentRoot.execution_id, after_ms: 1000,
    reason: "Bounded inactive preparation", budget: { calls: 1, tools, duration_ms: 10_000 } });
  const view = planning.begin();
  if (!view) throw new Error("Real speculative flight did not begin");
  return { planning, view };
}

test("one speculative tool survives repeated local commit checks and spends exactly one tool", () => {
  const f = fixture(), { planning, view } = speculativeFlight(f, 1);
  f.authority.grant(identity(f.authority, { role: "speculative", plan_id: view.plan_id }));
  f.authority.response({ request_id: "request-1", successful: true, calls: [
    { id: "call-1", name: "help", arguments: { topic: "programs" } },
    { id: "call-2", name: "help", arguments: { topic: "controller" } },
  ] });
  const permit = f.authority.tool("request-1", "call-1", "help", { topic: "programs" });
  const commit = f.authority.toolAuthority();
  for (let check = 0; check < 6; check++) { permit.assert(); commit(); }
  expect(planning.projection()?.tools).toBe(1);
  permit.release();
  expect(() => f.authority.tool("request-1", "call-2", "help", { topic: "controller" })).toThrow();
  expect(planning.projection()).toMatchObject({ tools: 1, reason: "budget_exhausted", planning_active: false });
});

for (const phase of ["before-request", "awaiting-tool-commit"] as const) {
  test(`ordinary attention synchronously revokes real speculative authority ${phase}`, async () => {
    const f = fixture(), { planning, view } = speculativeFlight(f, 4);
    const flightPermit = planning.authority();
    let permit: ReturnType<CognitionAuthority["tool"]> | undefined, commit = flightPermit;
    if (phase === "awaiting-tool-commit") {
      f.authority.grant(identity(f.authority, { role: "speculative", plan_id: view.plan_id }));
      response(f.authority, { topic: "programs" });
      permit = f.authority.tool("request-1", "call-1", "help", { topic: "programs" });
      commit = f.authority.toolAuthority();
    }
    await eventLoopTurn();
    f.authority.wake("selected_attention");
    expect(planning.projection()).toMatchObject({ planning_active: false, reason: "cancelled" });
    expect(() => flightPermit()).toThrow();
    expect(() => commit()).toThrow();
    permit?.release();
  });
}

test("a mechanical no-effect advisory does not revoke optional preparation by itself", () => {
  const f = fixture(), { planning } = speculativeFlight(f, 1);
  const permit = planning.authority();
  f.authority.wake("program_no_effect");
  permit();
  expect(planning.projection()).toMatchObject({ planning_active: true, state: "planning", tools: 0 });
});

for (const field of ["run_id", "world_id", "session_id", "epoch", "life_id", "native_boot_id", "space_epoch", "compatibility_hash", "task", "goal"] as const) {
  test(`a host-local ${field} change revokes an admitted tool before commit`, () => {
    const f = fixture(); f.authority.grant(identity(f.authority)); response(f.authority);
    const permit = f.authority.tool("request-1", "call-1", "help", { value: 7 });
    const commit = f.authority.toolAuthority();
    const previous = f.run[field];
    Object.assign(f.run, { [field]: typeof previous === "number" ? previous + 1 : typeof previous === "string" ? `${previous}-new` : { changed: true } });
    expect(() => permit.assert()).toThrow();
    expect(() => commit()).toThrow();
    permit.release();
  });
}

for (const change of ["generation", "run-object", "phase", "request", "turn", "root", "fence", "restart"] as const) {
  test(`a late commit cannot survive host-local ${change} replacement`, () => {
    const f = fixture(); f.authority.grant(identity(f.authority)); response(f.authority);
    const permit = f.authority.tool("request-1", "call-1", "help", { value: 7 });
    const commit = f.authority.toolAuthority();
    switch (change) {
      case "generation": f.state.generation++; break;
      case "run-object": f.state.run = structuredClone(f.run); break;
      case "phase": f.run.status = "paused"; break;
      case "request": f.authority.grant({ ...identity(f.authority), request_id: "request-2" }); break;
      case "turn": f.authority.beginTurn("turn-2", osMonotonicNs() + 10_000_000_000n); break;
      case "root": f.state.root = root(f); break;
      case "fence": f.authority.fence(); break;
      case "restart": f.authority.start(f.run, 1); break;
    }
    expect(() => permit.assert()).toThrow(); expect(() => commit()).toThrow();
    permit.release();
  });
}

test("a released tool cannot lend its captured host commit authority to another tool", () => {
  const f = fixture(); f.authority.grant(identity(f.authority));
  f.authority.response({ request_id: "request-1", successful: true, calls: [
    { id: "call-1", name: "help", arguments: {} }, { id: "call-2", name: "help", arguments: {} }] });
  const first = f.authority.tool("request-1", "call-1", "help", {});
  const commit = f.authority.toolAuthority();
  expect(() => f.authority.tool("request-1", "call-2", "help", {})).toThrow();
  first.release();
  const second = f.authority.tool("request-1", "call-2", "help", {});
  expect(() => commit()).toThrow(); expect(() => second.assert()).not.toThrow(); second.release();
});

test("the original OS-monotonic request deadline is rechecked locally after an await", async () => {
  const f = fixture();
  let now = osMonotonicNs();
  const clock = spyOn(monotonic, "osMonotonicNs").mockImplementation(() => now);
  restores.push(() => clock.mockRestore());
  const request = identity(f.authority, { deadline_os_ns: (now + 40_000_000n).toString() });
  f.authority.grant(request); response(f.authority);
  const permit = f.authority.tool("request-1", "call-1", "help", { value: 7 });
  const commit = f.authority.toolAuthority();
  await eventLoopTurn();
  now = BigInt(request.deadline_os_ns);
  expect(() => permit.assert()).toThrow(); expect(() => commit()).toThrow();
  expect(() => f.authority.assertRequest("request-1")).toThrow(); permit.release();
});

test("SDK fetch admission retains every original request identity field and deadline across an await", async () => {
  const f = fixture();
  let now = osMonotonicNs();
  const clock = spyOn(monotonic, "osMonotonicNs").mockImplementation(() => now);
  restores.push(() => clock.mockRestore());
  const request = identity(f.authority, { deadline_os_ns: (now + 40_000_000n).toString() });
  f.authority.grant(request);
  const permit = f.authority.sdkFetch({ ...request });
  for (const field of Object.keys(request) as (keyof CognitionRequestIdentity)[]) {
    const value = request[field];
    const changed = { ...request, [field]: typeof value === "number" ? value + 1 :
      typeof value === "boolean" ? !value : value === null ? "changed" : `${value}-changed` };
    expect(() => f.authority.sdkFetch(changed)).toThrow();
  }
  await eventLoopTurn();
  permit();
  now = BigInt(request.deadline_os_ns);
  expect(() => permit()).toThrow();
});

test("SDK fetch admission cannot borrow a replacement grant even with a reused exact request identity", async () => {
  const f = fixture(), request = identity(f.authority);
  f.authority.grant(request);
  const permit = f.authority.sdkFetch({ ...request });
  await eventLoopTurn();
  f.authority.grant({ ...request });
  expect(() => permit()).toThrow();
  expect(() => f.authority.sdkFetch({ ...request })).not.toThrow();
});

for (const invalid of [
  { generation: 2 }, { turn_id: "other-turn" }, { phase: "reviewing" }, { role: "review" },
  { deadline_os_ns: "1" }, { deadline_os_ns: (10n ** 24n).toString() },
] satisfies Partial<CognitionRequestIdentity>[]) {
  test(`request admission rejects changed identity ${JSON.stringify(invalid)}`, () => {
    const f = fixture(); expect(() => f.authority.grant(identity(f.authority, invalid))).toThrow();
  });
}

test("turn scope and finite maximum cannot be renewed by a child request", () => {
  const f = fixture(); const request = identity(f.authority);
  f.run.life_id = (f.run.life_id ?? 0) + 1;
  expect(() => f.authority.grant(request)).toThrow();
  expect(() => f.authority.beginTurn("too-long", osMonotonicNs() + 121_000_000_000n)).toThrow();
  expect(() => f.authority.beginTurn("expired", 1n)).toThrow();
});

test("ordinary pending-root decisions require a host wake and the same actual root", () => {
  const f = fixture(); f.state.pending = true; f.state.root = root(f);
  expect(() => f.authority.grant(identity(f.authority, { pending_decision: true }))).toThrow();
  f.authority.wake("selected_attention");
  const request = identity(f.authority, { pending_decision: true });
  f.authority.grant(request); response(f.authority);
  const permit = f.authority.tool("request-1", "call-1", "help", { value: 7 });
  f.state.root = { ...f.state.root, execution_id: "root-2", root_execution_id: "root-2" };
  expect(() => permit.assert()).toThrow(); permit.release();
  f.authority.wake("selected_attention");
  const next = identity(f.authority, { pending_decision: true });
  f.state.root = root(f);
  expect(() => f.authority.grant(next)).toThrow();
});

for (const change of ["root", "source", "status", "urgent-wake"] as const) {
  test(`root-bound authoring commit rechecks ${change} without child cooperation`, () => {
    const f = fixture(); f.state.pending = true; f.state.root = root(f);
    f.authority.grant(identity(f.authority, { role: "authoring", root_execution_id: "root-1", source_hash: "a".repeat(64),
      authoring_deadline_at: Date.now() + 10_000 }));
    response(f.authority);
    const permit = f.authority.tool("request-1", "call-1", "help", { value: 7 });
    expect(f.authority.toolRole()).toBe("authoring");
    if (change === "root") f.state.root = { ...f.state.root, execution_id: "root-2" };
    else if (change === "source") f.state.root.source_hash = "b".repeat(64);
    else if (change === "status") f.state.root.status = "cancelled";
    else f.authority.wake("policy_interrupt");
    expect(() => permit.assert()).toThrow(); permit.release();
  });
}

test("speculative authority is checked again locally and review role follows current phase", () => {
  const f = fixture(); f.authority.grant(identity(f.authority, { role: "speculative", plan_id: "plan-1" })); response(f.authority);
  const permit = f.authority.tool("request-1", "call-1", "help", { value: 7 });
  f.state.speculative = false; expect(() => permit.assert()).toThrow(); permit.release();
  f.run.status = "reviewing";
  expect(() => f.authority.grant(identity(f.authority, { phase: "reviewing", role: "ordinary" }))).toThrow();
  f.authority.grant(identity(f.authority, { phase: "reviewing", role: "review" }));
  response(f.authority); const review = f.authority.tool("request-1", "call-1", "help", { value: 7 });
  expect(f.authority.toolRole()).toBe("review"); review.release();
});

test("only an actual successful response grants exact request, call, tool and arguments once", () => {
  const f = fixture(); f.authority.grant(identity(f.authority));
  expect(() => f.authority.tool("request-1", "call-1", "help", {})).toThrow();
  expect(() => f.authority.response({ request_id: "other", successful: true, calls: [] })).toThrow();
  response(f.authority, { value: 7 });
  for (const [request, call, name, args] of [
    ["other", "call-1", "help", { value: 7 }], ["request-1", "other", "help", { value: 7 }],
    ["request-1", "call-1", "observe", { value: 7 }], ["request-1", "call-1", "help", { value: "7" }],
  ] as const) expect(() => f.authority.tool(request, call, name, args)).toThrow();
  const permit = f.authority.tool("request-1", "call-1", "help", { value: 7 }); permit.release();
  expect(() => f.authority.tool("request-1", "call-1", "help", { value: 7 })).toThrow();
});

test("failed responses, duplicate call ids, excess calls and role-forbidden names never grant tools", () => {
  const f = fixture(); f.authority.grant(identity(f.authority));
  f.authority.response({ request_id: "request-1", successful: false, calls: [] });
  expect(() => f.authority.tool("request-1", "call-1", "help", {})).toThrow();
  for (const calls of [
    [{ id: "same", name: "help", arguments: {} }, { id: "same", name: "help", arguments: {} }],
    [{ id: "call-1", name: "prepare_next", arguments: {} }],
    [{ id: "call-1", name: "not_a_catalog_tool", arguments: {} }],
    Array.from({ length: 49 }, (_, i) => ({ id: `call-${i}`, name: "help", arguments: {} })),
  ]) {
    f.authority.grant(identity(f.authority));
    expect(() => f.authority.response({ request_id: "request-1", successful: true, calls })).toThrow();
  }
});

test("an invalid complete response cannot leave an earlier partial tool grant behind", () => {
  const f = fixture();
  for (const second of [
    { id: "call-1", name: "help", arguments: {} },
    { id: "call-2", name: "prepare_next", arguments: {} },
  ]) {
    f.authority.grant(identity(f.authority));
    expect(() => f.authority.response({ request_id: "request-1", successful: true, calls: [
      { id: "call-1", name: "help", arguments: {} }, second,
    ] })).toThrow();
    expect(() => f.authority.tool("request-1", "call-1", "help", {})).toThrow();
  }
});

test("raw own __proto__ is retained and cannot be dropped, inherited or changed before dispatch", () => {
  const f = fixture(); f.authority.grant(identity(f.authority));
  const raw: Json = JSON.parse('{"__proto__":{"fixture_owned":true},"value":7}');
  response(f.authority, raw);
  expect(Object.hasOwn(raw as object, "__proto__")).toBe(true);
  expect(() => f.authority.tool("request-1", "call-1", "help", { value: 7 })).toThrow();
  expect(() => f.authority.tool("request-1", "call-1", "help", Object.assign(Object.create({ fixture_owned: true }), { value: 7 }))).toThrow();
  expect(() => f.authority.tool("request-1", "call-1", "help", JSON.parse('{"__proto__":{"fixture_owned":false},"value":7}'))).toThrow();
  const permit = f.authority.tool("request-1", "call-1", "help", raw); permit.release();
  expect(Object.hasOwn({}, "fixture_owned")).toBe(false);
});

for (const [actual, substituted] of [
  [null, {}], [null, []], [7, "7"], [false, {}], [[1], { 0: 1 }],
  [{ value: null }, {}], [{ value: "7" }, { value: 7 }], [{ value: [null] }, { value: [] }],
]) {
  test(`raw invalid shape is not healed from ${JSON.stringify(actual)} to ${JSON.stringify(substituted)}`, () => {
    const f = fixture(); f.authority.grant(identity(f.authority)); response(f.authority, actual);
    expect(() => f.authority.tool("request-1", "call-1", "help", substituted)).toThrow();
    // Authority binds provenance; the actual tool's host-side schema owns validity.
    const permit = f.authority.tool("request-1", "call-1", "help", actual); permit.release();
  });
}

for (const [original, nonJson] of [
  [{}, { value: undefined }], [null, Number.NaN], [[null], [undefined]],
  [{ value: 7 }, { value: 7, toJSON: () => ({ value: 7 }) }],
]) {
  test("non-JSON values cannot exploit JSON serialization to match a successful call", () => {
    const f = fixture(); f.authority.grant(identity(f.authority)); response(f.authority, original);
    expect(() => f.authority.tool("request-1", "call-1", "help", nonJson)).toThrow();
  });
}
