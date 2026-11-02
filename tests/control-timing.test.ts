import { expect, test } from "bun:test";
import * as timing from "../src/server/performance.ts";

const reply = {
  schema_version: 1 as const,
  clock_id: "native-boot",
  received_ns: "1105000000",
  replied_ns: "1110000000",
  client_tick: 12,
};

const request = (request_id: number, native_timing: typeof reply | null = reply) => ({
  request_id, method: "observe", operation_id: null, run_id: null,
  execution_id: null, source_hash: null, native_boot_id: "native-boot",
  started_monotonic_ms: 100, ended_monotonic_ms: 120,
  status: "ok" as const, observation_seq: request_id, native_timing,
});

test("four timestamps retain an offset interval instead of treating reply RTT as native input latency", () => {
  const sample = timing.correlateNativeClock(100, 120, reply, "native-boot")!;
  expect(sample.native_processing_ms).toBe(5);
  expect(sample.residual_round_trip_ms).toBe(15);
  expect(sample.offset_lower_ms).toBeCloseTo(990, 8);
  expect(sample.offset_upper_ms).toBeCloseTo(1005, 8);
  expect(sample.uncertainty_ms).toBeCloseTo(7.5, 8);
  expect(sample.native_received_ns).toBe("1105000000");
  expect(sample.native_replied_ns).toBe("1110000000");
});

test("clock correspondence rejects stale boot, reversed endpoints and impossible processing intervals", () => {
  expect(timing.correlateNativeClock(100, 120, reply, "different-boot")).toBeNull();
  expect(timing.correlateNativeClock(121, 120, reply, "native-boot")).toBeNull();
  expect(timing.correlateNativeClock(100, 120, { ...reply, replied_ns: "1104000000" }, "native-boot")).toBeNull();
  expect(timing.correlateNativeClock(100, 102, reply, "native-boot")).toBeNull();
  expect(timing.correlateNativeClock(NaN, 120, reply, "native-boot")).toBeNull();
});

test("native long timestamps preserve a one-nanosecond interval beyond JavaScript integer precision", () => {
  const sample = timing.correlateNativeClock(100, 120, {
    ...reply, received_ns: "100999999999999999", replied_ns: "101000000000000000",
  }, "native-boot")!;
  expect(sample.native_processing_ms).toBe(.000001);
  expect(sample.native_received_ns).toBe("100999999999999999");
  expect(sample.native_replied_ns).toBe("101000000000000000");
  expect(sample.offset_upper_ms).toBeGreaterThanOrEqual(sample.offset_lower_ms);
  const negative = timing.correlateNativeClock(100, 120, {
    ...reply, received_ns: "-1110000000", replied_ns: "-1105000000",
  }, "native-boot")!;
  expect(negative.native_processing_ms).toBe(5);
  expect(negative.offset_lower_ms).toBeLessThan(negative.offset_upper_ms);
});

test("bounded control history exposes omissions and never reuses correspondence across boot or age fences", () => {
  const timeline = new timing.NativeControlTimeline();
  timeline.bindBoot("native-boot");
  for (let id = 1; id <= 514; id++) timeline.record(request(id));
  const current = timeline.snapshot(121);
  expect(current.samples.map(sample => sample.request_id)).toEqual(Array.from({ length: 512 }, (_, index) => index + 3));
  expect(current.omitted_samples).toBe(2);
  expect(current.correspondence?.clock_id).toBe("native-boot");
  expect(timeline.snapshot(10121).correspondence).toBeNull();
  timeline.bindBoot("replacement-boot");
  expect(timeline.snapshot(121).correspondence).toBeNull();
  timeline.record(request(515));
  expect(timeline.snapshot(121).correspondence).toBeNull();
  timeline.bindBoot("native-boot");
  timeline.record(request(516, null));
  const missing = timeline.snapshot(121);
  expect(missing.correspondence).toBeNull();
  expect(missing.missing_clock_samples).toBe(1);
  expect(missing.invalid_clock_samples).toBe(1);
});

test("a subscribed evaluator retains every correlated reply across ring rollover and detaches without changing history", () => {
  const timeline = new timing.NativeControlTimeline();
  timeline.bindBoot("native-boot");
  const retained: Array<{ id: number; boot: string | null; uncertainty: number | null }> = [];
  const off = timeline.subscribe((sample, correspondence) => {
    retained.push({ id: sample.request_id, boot: correspondence?.clock_id ?? null,
      uncertainty: correspondence?.uncertainty_ms ?? null });
    sample.method = "observer-mutation";
    if (sample.native_timing) sample.native_timing.received_ns = "0";
  });
  for (let id = 1; id <= 514; id++) timeline.record(request(id));
  off();
  timeline.record(request(515));
  expect(retained.map(row => row.id)).toEqual(Array.from({ length: 514 }, (_, index) => index + 1));
  expect(retained[0]).toMatchObject({ id: 1, boot: "native-boot" });
  expect(retained[0]!.uncertainty).toBeCloseTo(7.5, 8);
  const after = timeline.snapshot(121);
  expect(after.samples[0]).toMatchObject({ request_id: 4, method: "observe",
    native_timing: { received_ns: "1105000000" } });
  expect(after.omitted_samples).toBe(3);
});

test("a failing trusted timing observer cannot break reply ownership and its evidence loss remains explicit", () => {
  const timeline = new timing.NativeControlTimeline();
  timeline.bindBoot("native-boot");
  const seen: number[] = [];
  timeline.subscribe(() => { throw new Error("Evaluator evidence sink failed"); });
  timeline.subscribe(sample => seen.push(sample.request_id));
  timeline.record(request(1));
  timeline.record(request(2, null));
  expect(seen).toEqual([1, 2]);
  expect(timeline.snapshot(121)).toMatchObject({
    observer_failures: 2, missing_clock_samples: 1,
    samples: [{ request_id: 1, status: "ok" }, { request_id: 2, native_timing: null }],
  });
});

for (const direction of ["recorded input", "returned snapshot"] as const) {
  test(`native application-stage evidence cannot be rewritten by mutating the ${direction}`, () => {
    const timeline = new timing.NativeControlTimeline();
    timeline.bindBoot("native-boot");
    const application: timing.NativeControllerApplicationTiming = {
      schema_version: 1,
      owner: { operation_id: "application-owner", generation: 3,
        scope: { session_id: "session", world_id: "world", epoch: 1, native_boot_id: "native-boot",
          run_id: "run", run_generation: 2, life_id: 4, space_epoch: 5, execution_id: "execution", source_hash: "a".repeat(64) } },
      controller_generation: 7, sequence: 9, frame_seq: 19,
      admitted_native_ns: "-9007199254740992", pending_ahead: 2, applying_ahead_sequence: 7,
      admitted_preparation_ordinal: 4, began_native_ns: "-9007199254740990", began_native_tick: 10,
      began_preparation_ordinal: 6, prepared_native_ns: "-9007199254740989",
      consumed_native_ns: null, sampled_native_ns: null,
      settled_native_ns: "-9007199254740985", settled_native_tick: 11,
    };
    timeline.record({ ...request(1), method: "controller_submit", native_timing: { ...reply, controller_application: application } });
    const mutable = direction === "recorded input" ? application : timeline.snapshot(121).samples[0]!.native_timing!.controller_application!;
    mutable.pending_ahead = 0;
    mutable.began_native_ns = "0";
    mutable.owner.scope.source_hash = "b".repeat(64);
    expect(timeline.snapshot(121).samples[0]!.native_timing?.controller_application).toMatchObject({
      pending_ahead: 2, began_native_ns: "-9007199254740990",
      owner: { scope: { source_hash: "a".repeat(64) } }, consumed_native_ns: null,
    });
  });

  test(`native lease evidence cannot be rewritten by mutating the ${direction}`, () => {
    const timeline = new timing.NativeControlTimeline();
    timeline.bindBoot("native-boot");
    const lease: timing.NativeControllerLeaseTiming = {
      schema_version: 1, event: "renew",
      owner: { operation_id: "lease-owner", generation: 3,
        scope: { session_id: "session", world_id: "world", epoch: 1, native_boot_id: "native-boot",
          run_id: "run", run_generation: 2, life_id: 4, space_epoch: 5, execution_id: "execution", source_hash: "a".repeat(64) } },
      controller_generation: 7, checked_native_ns: "1106000000", requested_deadline_native_ns: "1350000000",
      previous_deadline_native_ns: "1250000000", effective_deadline_native_ns: "1350000000",
      task_deadline_native_ns: "9000000000", accepted: true, first_fence_reason: null,
      first_fence_native_ns: null, retirement_trigger: null, retirement_native_ns: null,
    };
    const sample: timing.NativeRequestSpan = { ...request(1), method: "controller_heartbeat",
      native_timing: { ...reply, controller_lease: lease } };
    timeline.record(sample);
    const mutable = direction === "recorded input" ? lease : timeline.snapshot(121).samples[0]!.native_timing!.controller_lease!;
    mutable.effective_deadline_native_ns = "0";
    mutable.accepted = false;
    mutable.owner.scope.source_hash = "b".repeat(64);
    mutable.owner.generation = 900;
    expect(timeline.snapshot(121).samples[0]!.native_timing?.controller_lease).toMatchObject({
      effective_deadline_native_ns: "1350000000", accepted: true,
      owner: { generation: 3, scope: { source_hash: "a".repeat(64) } },
    });
  });
}
