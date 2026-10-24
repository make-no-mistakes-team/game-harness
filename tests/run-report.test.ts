import { describe, expect, test } from "bun:test";
import type {
  ActionView,
  PolicyView,
  RunUsage,
  RunView,
  TokenUsage,
} from "../src/shared/contracts.ts";
import { buildRunReport } from "../web/src/run-report.ts";

const TENTH = "2026-10-22T10:00:00Z";
const TENTH_2500 = "2026-10-22T10:00:02.500Z";
const TENTH_5000 = "2026-10-22T10:00:05Z";
const NINTH = "2026-10-22T09:59:59Z";

function tokenUsage(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return {
    uncached_input: 0,
    cache_read: 0,
    cache_write: 0,
    output: 0,
    calls: 0,
    known_cost: null,
    legacy_input: null,
    ...overrides,
  };
}

function runUsage(overrides: Partial<TokenUsage> = {}): RunUsage {
  const total = tokenUsage(overrides);
  return {
    ...total,
    by_purpose: {
      authoring: total,
      planning: total,
      replanning: total,
      improvement: total,
      other: total,
    },
  };
}

function action(overrides: Partial<ActionView> = {}): ActionView {
  return {
    action_id: "action-1",
    session_id: "session-1",
    life_id: 1,
    kind: "dig",
    status: "succeeded",
    origin: "strategist",
    execution_id: null,
    summary: "Dig log",
    started_at: TENTH,
    ended_at: TENTH_2500,
    result: null,
    ...overrides,
  };
}

function policy(overrides: Partial<PolicyView> = {}): PolicyView {
  return {
    backend: "javascript",
    choices: null,
    policy_id: "gather-wood",
    version: 1,
    name: "Gather wood",
    hash: "hash",
    state: "active",
    source: "return { kind: 'continue' };",
    card: {
      purpose: "Collect wood",
      applicability: "Near a tree",
      method: "Dig logs",
      reason: "Supply crafting",
      limitations: "Needs a reachable tree",
    },
    priority: 10,
    interval_ms: 200,
    evaluations: 0,
    effects: 0,
    last_error: null,
    ...overrides,
  };
}

function runView(overrides: Partial<RunView> = {}): RunView {
  return {
    run_id: "run-1",
    world_id: "world-1",
    epoch: 1,
    session_id: "session-1",
    life_id: 1,
    task: "Collect three logs",
    goal: "collect_wood",
    model_id: "model-a",
    status: "running",
    started_at: TENTH,
    ended_at: TENTH_2500,
    turns: 7,
    model_status: "idle",
    action: action(),
    policies: [policy()],
    skills: [],
    executions: [],
    error: null,
    usage: runUsage({
      uncached_input: 1200,
      cache_read: 300,
      cache_write: 50,
      output: 800,
      calls: 4,
      known_cost: 0.25,
      legacy_input: null,
    }),
    ...overrides,
  };
}

describe("buildRunReport elapsed time", () => {
  test("a recorded end bounds the run at 2500 ms with basis ended", () => {
    const report = buildRunReport(runView(), TENTH_5000);
    expect(report.elapsed_ms).toBe(2500);
    expect(report.elapsed_basis).toBe("ended");
  });

  test("an invalid or late as_of never overrides a recorded end", () => {
    for (const as_of of ["not a timestamp", TENTH_2500]) {
      const report = buildRunReport(runView(), as_of);
      expect(report.elapsed_ms).toBe(2500);
      expect(report.elapsed_basis).toBe("ended");
    }
  });

  test("without an end the explicit as_of bounds the run, paused included", () => {
    const report = buildRunReport(
      runView({ status: "paused", ended_at: null }),
      TENTH_2500,
    );
    expect(report.elapsed_ms).toBe(2500);
    expect(report.elapsed_basis).toBe("as_of");
  });

  test("missing start, invalid required dates, or reversed dates stay unavailable", () => {
    for (const overrides of [
      { started_at: null, ended_at: null },
      { ended_at: "not a timestamp" },
      { ended_at: NINTH },
      { ended_at: null },
      { ended_at: null, started_at: "not a timestamp" },
    ] as Partial<RunView>[]) {
      const report = buildRunReport(runView(overrides), "not a timestamp");
      expect(report.elapsed_ms).toBe(null);
      expect(report.elapsed_basis).toBe("unavailable");
    }
    const asOfBeforeStart = buildRunReport(runView({ ended_at: null }), NINTH);
    expect(asOfBeforeStart.elapsed_ms).toBe(null);
    expect(asOfBeforeStart.elapsed_basis).toBe("unavailable");
  });

  test("equal dates give a zero duration, not unavailable", () => {
    const report = buildRunReport(runView({ ended_at: TENTH }), TENTH_5000);
    expect(report.elapsed_ms).toBe(0);
    expect(report.elapsed_basis).toBe("ended");
  });

  test("a time fault does not block the rest of the report", () => {
    const report = buildRunReport(
      runView({ started_at: null, ended_at: null }),
      TENTH_5000,
    );
    expect(report.elapsed_basis).toBe("unavailable");
    expect(report.run_id).toBe("run-1");
    expect(report.turns).toBe(7);
    expect(report.output).toBe(800);
    expect(report.latest_action?.action_id).toBe("action-1");
    expect(report.policies).toHaveLength(1);
  });
});

describe("buildRunReport latest action", () => {
  test("no action in the snapshot gives latest_action null", () => {
    expect(
      buildRunReport(runView({ action: null }), TENTH_5000).latest_action,
    ).toBe(null);
  });

  test("an unfinished action gets no duration from the run clock", () => {
    const report = buildRunReport(
      runView({
        action: action({ status: "running", ended_at: null }),
        ended_at: TENTH_5000,
      }),
      TENTH_5000,
    );
    expect(report.latest_action).toEqual({
      action_id: "action-1",
      kind: "dig",
      status: "running",
      duration_ms: null,
    });
  });

  test("invalid or reversed action dates give a null duration", () => {
    for (const overrides of [
      { started_at: null, ended_at: TENTH_2500 },
      { started_at: "not a timestamp", ended_at: TENTH_2500 },
      { started_at: TENTH, ended_at: "not a timestamp" },
      { started_at: TENTH_2500, ended_at: TENTH },
    ] as Partial<ActionView>[]) {
      const report = buildRunReport(
        runView({ action: action(overrides) }),
        TENTH_5000,
      );
      expect(report.latest_action?.duration_ms).toBe(null);
    }
  });

  test("an unknown status stays unknown while the duration is computed", () => {
    const report = buildRunReport(
      runView({ action: action({ status: "unknown" }) }),
      TENTH_5000,
    );
    expect(report.latest_action).toEqual({
      action_id: "action-1",
      kind: "dig",
      status: "unknown",
      duration_ms: 2500,
    });
  });
});

describe("buildRunReport policies", () => {
  test("versions of one policy stay separate and sort numerically", () => {
    const ten = policy({ version: 10, evaluations: 40, effects: 4 });
    const two = policy({ version: 2, evaluations: 8, effects: 1 });
    const other = policy({
      policy_id: "avoid-lava",
      version: 1,
      evaluations: 5,
      effects: 0,
    });
    const report = buildRunReport(
      runView({ policies: [ten, other, two] }),
      TENTH_5000,
    );
    expect(report.policies).toEqual([
      {
        policy_id: "avoid-lava",
        version: 1,
        state: "active",
        evaluations: 5,
        effects: 0,
      },
      {
        policy_id: "gather-wood",
        version: 2,
        state: "active",
        evaluations: 8,
        effects: 1,
      },
      {
        policy_id: "gather-wood",
        version: 10,
        state: "active",
        evaluations: 40,
        effects: 4,
      },
    ]);
  });

  test("repeated calls give equal reports and keep the input untouched", () => {
    const run = runView({
      policies: [policy({ version: 10 }), policy({ version: 2 })],
    });
    const before = structuredClone(run);
    const first = buildRunReport(run, TENTH_5000);
    const second = buildRunReport(run, TENTH_5000);
    expect(second).toEqual(first);
    expect(run).toEqual(before);
    expect(run.policies.map((item) => item.version)).toEqual([10, 2]);
  });
});

describe("buildRunReport snapshot fields", () => {
  test("known cost distinguishes unknown from known zero", () => {
    const unknown = buildRunReport(
      runView({ usage: runUsage({ known_cost: null }) }),
      TENTH_5000,
    );
    const zero = buildRunReport(
      runView({ usage: runUsage({ known_cost: 0 }) }),
      TENTH_5000,
    );
    expect(unknown.known_cost).toBe(null);
    expect(zero.known_cost).toBe(0);
  });

  test("carries the split usage counters from the snapshot", () => {
    const report = buildRunReport(runView(), TENTH_5000);
    expect(report).toMatchObject({
      run_id: "run-1",
      status: "running",
      turns: 7,
      uncached_input: 1200,
      cache_read: 300,
      cache_write: 50,
      output: 800,
      calls: 4,
      legacy_input: null,
    });
  });

  test("model latency and goal success rate stay explicitly unavailable", () => {
    expect(buildRunReport(runView(), TENTH_5000).unavailable_metrics).toEqual([
      "model_latency",
      "goal_success_rate",
    ]);
  });
});
