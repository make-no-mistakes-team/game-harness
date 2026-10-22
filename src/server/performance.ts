export type TimingName =
  "observation_read_ms" | "action_round_trip_ms" | "video_forward_ms";

export interface TimingSummary {
  count: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
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
