import { randomUUID } from "node:crypto";
import type { ExpectedEffectOwner } from "../shared/control.ts";

export const HOST_MONOTONIC_CLOCK_ID = randomUUID();

export type TimingName =
  "observation_read_ms" | "action_round_trip_ms" | "video_forward_ms";

export interface TimingSummary {
  count: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

export interface NativeControlTiming {
  schema_version: 1;
  clock_id: string;
  received_ns: string;
  replied_ns: string;
  client_tick: number;
  controller_lease?: NativeControllerLeaseTiming;
  controller_application?: NativeControllerApplicationTiming;
}

/** Request-owned diagnostic stages; the ordinary consumed-input ACK remains authoritative. */
export interface NativeControllerApplicationTiming {
  schema_version: 1;
  owner: ExpectedEffectOwner;
  controller_generation: number;
  sequence: number;
  frame_seq: number;
  admitted_native_ns: string;
  pending_ahead: number;
  applying_ahead_sequence: number;
  admitted_preparation_ordinal: number;
  began_native_ns: string;
  began_native_tick: number;
  began_preparation_ordinal: number;
  prepared_native_ns: string | null;
  consumed_native_ns: string | null;
  sampled_native_ns: string | null;
  settled_native_ns: string;
  settled_native_tick: number;
}

/** Trusted native bookkeeping only; not an actor observation or an input receipt. */
export interface NativeControllerLeaseTiming {
  schema_version: 1;
  event: "open" | "renew" | "refused" | "retirement";
  owner: ExpectedEffectOwner;
  controller_generation: number;
  checked_native_ns: string;
  requested_deadline_native_ns: string | null;
  previous_deadline_native_ns: string | null;
  effective_deadline_native_ns: string;
  task_deadline_native_ns: string;
  accepted: boolean;
  first_fence_reason: string | null;
  first_fence_native_ns: string | null;
  retirement_trigger: string | null;
  retirement_native_ns: string | null;
}

export interface NativeClockCorrespondence {
  clock_id: string;
  host_sent_ms: number;
  host_received_ms: number;
  native_received_ns: string;
  native_replied_ns: string;
  native_processing_ms: number;
  residual_round_trip_ms: number;
  offset_lower_ms: number;
  offset_upper_ms: number;
  uncertainty_ms: number;
}

function nativeNanoseconds(value: string): bigint | null {
  if (typeof value !== "string" || !/^-?(?:0|[1-9]\d{0,18})$/.test(value)) return null;
  const parsed = BigInt(value);
  return parsed >= -9223372036854775808n && parsed <= 9223372036854775807n ? parsed : null;
}

function milliseconds(value: bigint): number {
  return Number(value / 1000000n) + Number(value % 1000000n) / 1e6;
}

/** Native-minus-host offset bounds; neither endpoint is a cross-clock duration. */
export function correlateNativeClock(
  hostSentMs: number,
  hostReceivedMs: number,
  timing: NativeControlTiming,
  expectedBoot: string,
): NativeClockCorrespondence | null {
  if (!Number.isFinite(hostSentMs) || !Number.isFinite(hostReceivedMs) || hostReceivedMs < hostSentMs ||
      timing.schema_version !== 1 || timing.clock_id !== expectedBoot ||
      !Number.isSafeInteger(timing.client_tick) || timing.client_tick < 0) return null;
  const received = nativeNanoseconds(timing.received_ns), replied = nativeNanoseconds(timing.replied_ns);
  if (received === null || replied === null || replied < received) return null;
  const processing = milliseconds(replied - received);
  const residual = hostReceivedMs - hostSentMs - processing;
  if (residual < 0) return null;
  const nativeReceivedMs = milliseconds(received), nativeRepliedMs = milliseconds(replied);
  // The raw longs remain strings. Widen bounds for float conversion/subtraction,
  // including an arbitrary large or negative System.nanoTime origin.
  const rounding = 4 * Number.EPSILON * Math.max(
    1, Math.abs(nativeReceivedMs), Math.abs(nativeRepliedMs), Math.abs(hostSentMs), Math.abs(hostReceivedMs),
  );
  const lower = nativeRepliedMs - hostReceivedMs - rounding;
  const upper = nativeReceivedMs - hostSentMs + rounding;
  if (lower > upper) return null;
  return {
    clock_id: timing.clock_id, host_sent_ms: hostSentMs, host_received_ms: hostReceivedMs,
    native_received_ns: timing.received_ns, native_replied_ns: timing.replied_ns,
    native_processing_ms: processing, residual_round_trip_ms: residual,
    offset_lower_ms: lower, offset_upper_ms: upper, uncertainty_ms: (upper - lower) / 2,
  };
}

export interface NativeRequestSpan {
  request_id: number;
  method: string;
  operation_id: string | null;
  run_id: string | null;
  execution_id: string | null;
  source_hash: string | null;
  native_boot_id: string;
  started_monotonic_ms: number;
  ended_monotonic_ms: number;
  status: "ok" | "error" | "unknown";
  observation_seq: number | null;
  native_timing: NativeControlTiming | null;
}

function detachedNativeTiming(value: NativeControlTiming | null): NativeControlTiming | null {
  if (!value) return null;
  return value.controller_lease || value.controller_application ? structuredClone(value) : { ...value };
}

/** Bounded diagnostic history; raw samples do not establish input or effect success. */
export class NativeControlTimeline {
  private readonly samples = new Array<NativeRequestSpan>(512);
  private cursor = 0;
  private size = 0;
  private total = 0;
  private missing = 0;
  private invalid = 0;
  private boot: string | null = null;
  private correspondence: NativeClockCorrespondence | null = null;
  private readonly observers = new Set<(sample: NativeRequestSpan, correspondence: NativeClockCorrespondence | null) => void>();
  private observerFailures = 0;

  /** Trusted diagnostic consumers own their finite retention; none of this reaches actor feedback. */
  subscribe(observer: (sample: NativeRequestSpan, correspondence: NativeClockCorrespondence | null) => void): () => void {
    this.observers.add(observer);
    return () => { this.observers.delete(observer); };
  }

  bindBoot(boot: string | null): void {
    if (boot !== this.boot) {
      this.boot = boot;
      this.correspondence = null;
    }
  }

  record(sample: NativeRequestSpan): void {
    if (!Number.isFinite(sample.started_monotonic_ms) || !Number.isFinite(sample.ended_monotonic_ms) ||
        sample.ended_monotonic_ms < sample.started_monotonic_ms) throw new Error("Native request requires ordered host-clock endpoints");
    this.samples[this.cursor] = { ...sample, native_timing: detachedNativeTiming(sample.native_timing) };
    this.cursor = (this.cursor + 1) % this.samples.length;
    this.size = Math.min(this.size + 1, this.samples.length);
    this.total++;
    if (sample.native_timing === null) {
      this.missing++;
    } else {
      const mapping = sample.native_boot_id === this.boot
        ? correlateNativeClock(sample.started_monotonic_ms, sample.ended_monotonic_ms, sample.native_timing, this.boot)
        : null;
      if (mapping) this.correspondence = mapping;
      else this.invalid++;
    }
    for (const observer of this.observers) {
      try { observer(structuredClone(sample), this.currentCorrespondence(sample.ended_monotonic_ms)); }
      catch { this.observerFailures++; }
    }
  }

  currentCorrespondence(now = performance.now()): NativeClockCorrespondence | null {
    const age = this.correspondence ? now - this.correspondence.host_received_ms : null;
    return this.correspondence && age !== null && age >= 0 && age <= 10000 ? { ...this.correspondence } : null;
  }

  snapshot(now = performance.now()) {
    const samples: NativeRequestSpan[] = [];
    const first = (this.cursor - this.size + this.samples.length) % this.samples.length;
    for (let index = 0; index < this.size; index++) {
      const sample = this.samples[(first + index) % this.samples.length]!;
      samples.push({ ...sample, native_timing: detachedNativeTiming(sample.native_timing) });
    }
    return {
      clock_id: HOST_MONOTONIC_CLOCK_ID, native_boot_id: this.boot,
      correspondence: this.currentCorrespondence(now),
      correspondence_max_age_ms: 10000, samples, omitted_samples: this.total - this.size,
      missing_clock_samples: this.missing, invalid_clock_samples: this.invalid,
      observer_failures: this.observerFailures,
      input_or_effect_confirmation: false,
    };
  }
}

class DurationWindow {
  private readonly values = new Float64Array(512);
  private cursor = 0;
  private size = 0;
  private total = 0;

  record(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
    this.values[this.cursor] = milliseconds;
    this.cursor = (this.cursor + 1) % this.values.length;
    this.size = Math.min(this.size + 1, this.values.length);
    this.total++;
  }

  snapshot(): TimingSummary {
    if (!this.size)
      return { count: this.total, p50: null, p95: null, p99: null, max: null };
    const sorted = this.values.slice(0, this.size).sort();
    const percentile = (fraction: number): number =>
      sorted[Math.max(0, Math.ceil(this.size * fraction) - 1)]!;
    return {
      count: this.total,
      p50: percentile(0.5),
      p95: percentile(0.95),
      p99: percentile(0.99),
      max: sorted[this.size - 1]!,
    };
  }
}

export class PerformanceMonitor {
  private readonly lag = new DurationWindow();
  private readonly durations: Record<TimingName, DurationWindow> = {
    observation_read_ms: new DurationWindow(),
    action_round_trip_ms: new DurationWindow(),
    video_forward_ms: new DurationWindow(),
  };
  private cpu = process.cpuUsage();
  private cpuAt = performance.now();
  private expectedAt = this.cpuAt + 100;
  private cpuPercent: number | null = null;
  private sampleWindow: number | null = null;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor() {
    this.timer = setInterval(() => {
      const now = performance.now();
      this.lag.record(Math.max(0, now - this.expectedAt));
      this.expectedAt = now + 100;
      const elapsed = now - this.cpuAt;
      if (elapsed < 1000) return;
      const current = process.cpuUsage();
      const microseconds =
        current.user + current.system - this.cpu.user - this.cpu.system;
      this.cpuPercent = microseconds / (elapsed * 10);
      this.sampleWindow = elapsed;
      this.cpu = current;
      this.cpuAt = now;
    }, 100);
    this.timer.unref();
  }

  record(name: TimingName, milliseconds: number): void {
    this.durations[name].record(milliseconds);
  }

  snapshot(): {
    sample_window_ms: number | null;
    cpu_percent_of_one_core: number | null;
    rss_bytes: number;
    percentile_window_samples: number;
    event_loop_lag_ms: TimingSummary;
    timings: Record<TimingName, TimingSummary>;
  } {
    return {
      sample_window_ms: this.sampleWindow,
      cpu_percent_of_one_core: this.cpuPercent,
      rss_bytes: process.memoryUsage.rss(),
      percentile_window_samples: 512,
      event_loop_lag_ms: this.lag.snapshot(),
      timings: {
        observation_read_ms: this.durations.observation_read_ms.snapshot(),
        action_round_trip_ms: this.durations.action_round_trip_ms.snapshot(),
        video_forward_ms: this.durations.video_forward_ms.snapshot(),
      },
    };
  }

  close(): void {
    clearInterval(this.timer);
  }
}
