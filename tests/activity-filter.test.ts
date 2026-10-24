import { describe, expect, test } from "bun:test";
import type { ActivityEvent, Json } from "../src/shared/contracts.ts";
import {
  filterActivity,
  type ActivityFilter,
} from "../web/src/activity-filter.ts";

function event(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    event_seq: 1,
    run_id: "run-1",
    at: "2026-10-22T10:00:00Z",
    type: "action.succeeded",
    summary: "Dig log completed",
    details: null,
    ...overrides,
  };
}

function filter(overrides: Partial<ActivityFilter> = {}): ActivityFilter {
  return {
    scope: "all",
    current_run_id: "run-1",
    types: [],
    query: "",
    ...overrides,
  };
}

describe("filterActivity scopes", () => {
  const current = event({ event_seq: 1, run_id: "run-1" });
  const other = event({
    event_seq: 2,
    run_id: "run-2",
    summary: "Other run event",
  });
  const system = event({
    event_seq: 3,
    run_id: null,
    summary: "System event",
  });
  const events = [current, other, system];

  test("'all' keeps events of every run and system events", () => {
    expect(filterActivity(events, filter({ scope: "all" }))).toEqual([
      current,
      other,
      system,
    ]);
  });

  test("'current_run' keeps only exact run id matches", () => {
    expect(
      filterActivity(
        events,
        filter({ scope: "current_run", current_run_id: "run-1" }),
      ),
    ).toEqual([current]);
    expect(
      filterActivity(
        events,
        filter({ scope: "current_run", current_run_id: "run-2" }),
      ),
    ).toEqual([other]);
  });

  test("'current_run' without a current run returns nothing, not system events", () => {
    expect(
      filterActivity(
        events,
        filter({ scope: "current_run", current_run_id: null }),
      ),
    ).toEqual([]);
  });

  test("'all' and 'system' ignore current_run_id", () => {
    for (const current_run_id of ["run-1", null] as const) {
      expect(
        filterActivity(events, filter({ scope: "all", current_run_id })),
      ).toEqual([current, other, system]);
      expect(
        filterActivity(events, filter({ scope: "system", current_run_id })),
      ).toEqual([system]);
    }
  });
});

describe("filterActivity types", () => {
  const failed = event({
    event_seq: 1,
    type: "action.failed",
    summary: "Dig failed",
  });
  const cancelled = event({
    event_seq: 2,
    type: "action.cancelled",
    summary: "Dig cancelled",
  });
  const loud = event({
    event_seq: 3,
    type: "ACTION.FAILED",
    summary: "Uppercase type",
  });
  const mention = event({
    event_seq: 4,
    type: "action.note",
    summary: "Reported action.failed earlier",
  });
  const events = [failed, cancelled, loud, mention];

  test("an empty list admits every type", () => {
    expect(filterActivity(events, filter({ types: [] }))).toEqual(events);
  });

  test("several types join through OR", () => {
    expect(
      filterActivity(
        events,
        filter({ types: ["action.cancelled", "action.note"] }),
      ),
    ).toEqual([cancelled, mention]);
  });

  test("matching is exact and case-sensitive", () => {
    expect(
      filterActivity(events, filter({ types: ["action.failed"] })),
    ).toEqual([failed]);
    expect(
      filterActivity(events, filter({ types: ["ACTION.FAILED"] })),
    ).toEqual([loud]);
  });

  test("an unknown type selects nothing", () => {
    expect(
      filterActivity(events, filter({ types: ["action.unknown"] })),
    ).toEqual([]);
  });
});

describe("filterActivity query", () => {
  const failure = event({
    event_seq: 1,
    type: "action.succeeded",
    summary: "Model request failed to settle",
  });
  const typed = event({
    event_seq: 2,
    type: "policy.evaluated",
    summary: "Reaction evaluated",
  });
  const hidden = event({
    event_seq: 3,
    type: "action.succeeded",
    summary: "Quiet note",
    details: { secret: "failed" },
  });

  test("finds lower-case text in summary and matches type text", () => {
    expect(
      filterActivity([failure, typed], filter({ query: "FAILED" })),
    ).toEqual([failure]);
    expect(
      filterActivity([failure, typed], filter({ query: "policy" })),
    ).toEqual([typed]);
  });

  test("trims query edges and treats blank queries as no condition", () => {
    expect(filterActivity([failure], filter({ query: "  failed  " }))).toEqual([
      failure,
    ]);
    expect(filterActivity([failure, typed], filter({ query: "   " }))).toEqual([
      failure,
      typed,
    ]);
  });

  test("treats the query as literal text, not a pattern", () => {
    const bracket = event({ event_seq: 4, summary: "Budget [strict] applied" });
    expect(filterActivity([bracket], filter({ query: "[" }))).toEqual([
      bracket,
    ]);
    expect(filterActivity([bracket], filter({ query: "]" }))).toEqual([
      bracket,
    ]);
    expect(filterActivity([bracket], filter({ query: ".*" }))).toEqual([]);
  });

  test("never reads details", () => {
    expect(filterActivity([hidden], filter({ query: "failed" }))).toEqual([]);
    const guarded: ActivityEvent = {
      event_seq: 5,
      run_id: "run-1",
      at: "2026-10-22T10:00:00Z",
      type: "action.succeeded",
      summary: "Visible summary",
      get details(): Json {
        throw new Error("details must not be read");
      },
    };
    expect(filterActivity([guarded], filter())).toEqual([guarded]);
    expect(filterActivity([guarded], filter({ query: "visible" }))).toEqual([
      guarded,
    ]);
  });
});

describe("filterActivity combined conditions", () => {
  const matching = event({
    event_seq: 1,
    run_id: "run-1",
    type: "action.failed",
    summary: "Dig failed",
  });
  const wrongRun = event({
    event_seq: 2,
    run_id: "run-2",
    type: "action.failed",
    summary: "Dig failed",
  });
  const wrongType = event({
    event_seq: 3,
    run_id: "run-1",
    type: "action.succeeded",
    summary: "Dig failed",
  });
  const wrongText = event({
    event_seq: 4,
    run_id: "run-1",
    type: "action.failed",
    summary: "Dig completed",
  });
  const events = [matching, wrongRun, wrongType, wrongText];

  test("every condition must hold at once", () => {
    expect(
      filterActivity(
        events,
        filter({
          scope: "current_run",
          types: ["action.failed"],
          query: "dig failed",
        }),
      ),
    ).toEqual([matching]);
  });

  test("empty input and full miss both give an empty result", () => {
    expect(filterActivity([], filter())).toEqual([]);
    expect(
      filterActivity(
        events,
        filter({ scope: "current_run", current_run_id: "run-9" }),
      ),
    ).toEqual([]);
  });
});

describe("filterActivity ordering and immutability", () => {
  const late = event({ event_seq: 2, at: "2026-10-22T10:00:02Z" });
  const early = event({ event_seq: 1, at: "2026-10-22T10:00:01Z" });
  const events = [late, early, late];

  test("keeps input order and repeated references without sorting", () => {
    const selected = filterActivity(events, filter());
    expect(selected).toEqual([late, early, late]);
    expect(selected[0]).toBe(late);
    expect(selected[1]).toBe(early);
    expect(selected[2]).toBe(late);
  });

  test("accepts frozen events, arrays, and filters", () => {
    const frozenFilter = Object.freeze({
      scope: "current_run" as const,
      current_run_id: "run-1",
      types: Object.freeze(["action.succeeded"]),
      query: "  dig ",
    });
    const frozenEvents = events.map((item) => Object.freeze(item));
    const frozenArray = Object.freeze(frozenEvents);
    expect(filterActivity(frozenArray, frozenFilter)).toEqual([
      late,
      early,
      late,
    ]);
    expect(frozenFilter.types).toEqual(["action.succeeded"]);
    expect(frozenArray).toEqual(frozenEvents);
  });
});
