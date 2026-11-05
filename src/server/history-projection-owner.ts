import type { Store } from "./store.ts";
import type { ImprovementLearning } from "./improvement-learning.ts";

/** Effect-free writer coordination. Notifications are hints; durable journals own progress. */
export class HistoryProjectionOwner {
  private readonly suspended = new Set<string>();
  private readonly faults = new Map<string, number>();
  private readonly unsubscribe: () => void;
  private requested = true;
  private closed = false;
  private auditing: string | null = null;
  private task: Promise<void> | null = null;
  private current: {
    runId: string;
    controller: AbortController;
    done: Promise<void>;
  } | null = null;
  private closing: Promise<void> | null = null;

  constructor(
    private readonly store: Store,
    private readonly learning: ImprovementLearning,
  ) {
    this.unsubscribe = store.subscribeHistoryChanges((runId) => {
      if (this.closed || this.auditing === runId) return;
      this.requested = true;
      this.schedule();
    });
    // Also discovers eventless and previously retained runs after reopen.
    this.schedule();
  }

  suspendRun(runId: string): Promise<void> {
    this.suspended.add(runId);
    const current = this.current?.runId === runId ? this.current : null;
    current?.controller.abort();
    return this.join([
      this.learning.suspendRun(runId),
      current?.done ?? Promise.resolve(),
    ]);
  }

  resumeRun(runId: string): void {
    if (this.closed) return;
    this.learning.resumeRun(runId);
    this.suspended.delete(runId);
    this.requested = true;
    this.schedule();
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.requested = false;
    this.unsubscribe();
    this.current?.controller.abort();
    this.closing = this.join([
      this.learning.close(),
      this.task ?? Promise.resolve(),
    ]);
    return this.closing;
  }

  private schedule(): void {
    if (this.closed || this.task || !this.requested) return;
    const task = Promise.resolve().then(() => this.sweep());
    this.task = task;
    void task.then(
      () => {
        if (this.task === task) this.task = null;
        this.schedule();
      },
      () => {
        // An enumeration/store fault is latched until a genuine committed change
        // schedules another pass. Never spin on a failed background owner.
        if (this.task === task) this.task = null;
        this.requested = false;
      },
    );
  }

  private async sweep(): Promise<void> {
    while (this.requested && !this.closed) {
      this.requested = false;
      let after: string | null = null;
      while (!this.closed) {
        const page = this.store.historyProjectionRunPage(after, 128);
        for (const runId of page.run_ids) {
          if (this.closed) return;
          if (!this.suspended.has(runId)) await this.prepare(runId);
          // Bound each event-loop turn, including already-current and faulted runs.
          const turn = Promise.withResolvers<void>();
          setTimeout(turn.resolve, 0);
          await turn.promise;
        }
        if (!page.has_more) break;
        after = page.next_after;
      }
    }
  }

  private async prepare(runId: string): Promise<void> {
    const available = this.store.historySourceHighwater(runId);
    const checkpoint = this.store.historyProjectionCheckpoint(runId);
    if (
      (this.faults.get(runId) ?? -1) >= available ||
      (checkpoint?.phase === "idle" && checkpoint.source_through >= available)
    )
      return;
    const controller = new AbortController();
    const completion = Promise.withResolvers<void>();
    const current = { runId, controller, done: completion.promise };
    this.current = current;
    try {
      await this.learning.prepareFeedback(runId, {
        signal: controller.signal,
        deadlineHostMs: performance.now() + 10_000,
      });
      this.faults.delete(runId);
    } catch (error) {
      if (
        !controller.signal.aborted &&
        !this.closed &&
        !this.suspended.has(runId)
      ) {
        const newerWork = this.store.historySourceHighwater(runId) > available;
        this.auditing = runId;
        try {
          this.store.event(
            runId,
            "runtime.history_preparation_failed",
            "History preparation failed; committed source evidence remains pending",
            {
              error:
                error instanceof Error
                  ? error.message.slice(0, 500)
                  : "History preparation failed",
            },
          );
        } finally {
          this.auditing = null;
          // A genuinely newer source commit authorizes a new invocation, but
          // the failure audit alone never does. Do not swallow coalesced work
          // that arrived after this invocation captured its fixed frontier.
          this.faults.set(
            runId,
            newerWork ? available : this.store.historySourceHighwater(runId),
          );
          if (newerWork) this.requested = true;
        }
      }
    } finally {
      if (this.current === current) this.current = null;
      completion.resolve();
    }
  }

  private async join(tasks: Promise<void>[]): Promise<void> {
    const results = await Promise.allSettled(tasks);
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        "History owners did not drain",
      );
  }
}
