import { expect, test } from "bun:test";
import {
  NativeControlTimeline,
  type NativeControllerOpportunityBatch,
  type NativeRequestSpan,
} from "../src/server/performance.ts";

function opportunitySpan(): NativeRequestSpan {
  const batch: NativeControllerOpportunityBatch = {
    schema_version: 1,
    identity: {
      owner_operation_id: "native-owner",
      controller_generation: "9007199254740991",
      native_boot_id: "native-boot",
      source_hash: "a".repeat(64),
    },
    counts: {
      attempted: "1",
      accepted: "1",
      omitted: "0",
      contended: "0",
      exhausted: "0",
      closed_omitted: "0",
      drained: "0",
      retained: 1,
      sealed: true,
    },
    final_batch: true,
    unattached_retained: 0,
    counts_consistent: true,
    complete: true,
    events: [
      {
        kind: "begin",
        outcome: "empty",
        eventseq: "1",
        native_ns: "-9007199254740993",
        checked_native_ns: "-9007199254740994",
        tick: "9007199254740991",
        preparation_ordinal: "1",
        request_id: null,
        sequence: null,
        frame_sequence: null,
        captured_native_ns: null,
        pending_count: "0",
        head_request_id: null,
        head_sequence: null,
        head_frame_sequence: null,
        predecessor_request_id: null,
        predecessor_sequence: null,
        predecessor_frame_sequence: null,
        applying_request_id: null,
        applying_sequence: null,
        applying_frame_sequence: null,
        last_completed_request_id: null,
        last_completed_sequence: null,
        last_completed_frame_sequence: null,
        last_completed_tick: null,
        last_applied_native_ns: null,
        applied_native_ns: null,
        diagnostic_completion_native_ns: null,
        evaluated_mask: "7",
        value_mask: "0",
        last_sampled_tick: null,
        state_mask: null,
        stage: "0",
      },
    ],
  };
  return {
    request_id: 1,
    method: "controller_sample",
    operation_id: "native-owner",
    run_id: "run",
    execution_id: "execution",
    source_hash: "a".repeat(64),
    native_boot_id: "native-boot",
    started_monotonic_ms: 100,
    ended_monotonic_ms: 120,
    status: "error",
    observation_seq: null,
    native_timing: {
      schema_version: 1,
      clock_id: "native-boot",
      received_ns: "1100000000",
      replied_ns: "1105000000",
      client_tick: 10,
      controller_opportunities: batch,
    },
  };
}

for (const direction of ["source", "snapshot", "observer"] as const) {
  test(`native opportunity identity, counters and events survive ${direction} mutation`, () => {
    const timeline = new NativeControlTimeline();
    timeline.bindBoot("native-boot");
    const span = opportunitySpan(),
      original = structuredClone(span.native_timing!.controller_opportunities!);
    let observed: NativeRequestSpan | undefined;
    const mutate = (value: NativeRequestSpan) => {
      const batch = value.native_timing!.controller_opportunities!;
      batch.identity.owner_operation_id = "rewritten";
      if (batch.counts === null) throw new Error("Expected actual batch");
      batch.counts.accepted = "0";
      batch.events[0]!.native_ns = "0";
      batch.events[0]!.request_id = "99";
      batch.events.length = 0;
    };
    if (direction === "observer") timeline.subscribe(mutate);
    timeline.subscribe((value) => {
      observed = value;
    });
    timeline.record(span);
    if (direction === "source") mutate(span);
    if (direction === "snapshot") mutate(timeline.snapshot(121).samples[0]!);
    expect(observed?.native_timing?.controller_opportunities).toEqual(original);
    const snapshot = timeline.snapshot(121);
    expect(
      snapshot.samples[0]!.native_timing?.controller_opportunities,
    ).toEqual(original);
    expect(
      snapshot.samples[0]!.native_timing?.controller_opportunities?.events[0],
    ).toMatchObject({
      outcome: "empty",
      sequence: null,
      request_id: null,
      pending_count: "0",
    });
    expect(snapshot.input_or_effect_confirmation).toBe(false);
    expect(snapshot.observer_failures).toBe(0);
  });
}

test("an unavailable native opportunity marker remains detached unknown metadata", () => {
  const timeline = new NativeControlTimeline(),
    span = opportunitySpan();
  timeline.bindBoot("native-boot");
  span.native_timing!.controller_opportunities = {
    schema_version: 1,
    identity: { ...span.native_timing!.controller_opportunities!.identity },
    counts: null,
    final_batch: false,
    complete: false,
    events: [],
    unavailable: "committed_prefix_pending",
  };
  const original = structuredClone(
    span.native_timing!.controller_opportunities,
  );
  timeline.subscribe((value) => {
    value.native_timing!.controller_opportunities!.identity.source_hash =
      "b".repeat(64);
  });
  timeline.record(span);
  span.native_timing!.controller_opportunities.identity.owner_operation_id =
    "source-mutation";
  const first =
    timeline.snapshot(121).samples[0]!.native_timing!.controller_opportunities!;
  expect(first).toEqual(original);
  expect(first.complete).toBe(false);
  expect(first.counts).toBeNull();
  first.identity.native_boot_id = "snapshot-mutation";
  expect(
    timeline.snapshot(121).samples[0]!.native_timing!.controller_opportunities,
  ).toEqual(original);
});
