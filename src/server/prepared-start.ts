import type { AppSnapshot, GoalChoice, Json, RunView } from "../shared/contracts.ts";
import { preparedStartActive, type PreparedStartRequest, type PreparedStartView } from "../shared/prepared-start.ts";
import { PreparedSource, type PreparedSourceOptions } from "./prepared-source.ts";
import type { PreparationContract, PreparedSourceCandidate } from "./prepared-source-contract.ts";
import { RuntimeFault } from "./runtime-fault.ts";
import { adapterCompatibility } from "./adapter-contract.ts";

/** Synchronously reserves a new native startup, before any asynchronous launch work. */
export interface PreparedWorldLaunch {
  ready: Promise<void>;
  close(): Promise<void>;
}
export interface PreparedStartRuntime {
  snapshot(): RunView | null;
  startPreparedRun(candidate: PreparedSourceCandidate): Promise<RunView>;
  control(id: string, command: "start" | "pause" | "resume" | "stop"): Promise<void>;
}
export interface PreparedStartOptions {
  directory: string;
  sourceReferences?: PreparedSourceOptions["sourceReferences"];
  auth: PreparedSourceOptions["auth"];
  sandbox: PreparedSourceOptions["sandbox"];
  runtime: PreparedStartRuntime;
  state(): Pick<AppSnapshot, "game" | "server" | "sandbox" | "run">;
  getContract(): Promise<PreparationContract>;
  launch(): PreparedWorldLaunch;
  changed(): void;
  record(type: string, summary: string, details: Json): void;
}

/** Source preparation cannot enter the world; only this owner can release a checked, ready candidate. */
export class PreparedStart {
  private readonly source: PreparedSource;
  private catalog: GoalChoice[] = [];
  private launch: { owner: PreparedWorldLaunch; closing: Promise<void> | null } | null = null;

  constructor(private readonly options: PreparedStartOptions) {
    this.source = new PreparedSource({ directory: options.directory, auth: options.auth, sandbox: options.sandbox,
      sourceReferences: options.sourceReferences,
      getContract: () => this.refreshContract(), assertCanStart: () => this.assertIdle(),
      onReady: candidate => this.enter(candidate), onCancel: () => this.closeLaunch(),
      changed: options.changed, record: options.record });
  }
  async initialize(): Promise<void> {
    await this.source.initialize();
    try { await this.refreshContract(); }
    catch {
      this.options.record("preparation.catalog_unavailable", "Prepared-start catalog requires a fresh installed native artifact", null);
    }
  }
  snapshot(): PreparedStartView | null { return this.source.snapshot(); }
  goals(): GoalChoice[] { return structuredClone(this.catalog); }
  active(): boolean { return preparedStartActive(this.snapshot()); }
  async refreshContract(): Promise<PreparationContract> {
    const contract = await this.options.getContract();
    this.catalog = structuredClone([...(contract.adapter.goalChoices ?? [])]);
    this.options.changed();
    return contract;
  }
  start(request: PreparedStartRequest): Promise<PreparedStartView> { return this.source.start(request); }
  cancel(preparationId: string): Promise<PreparedStartView> { return this.source.cancel(preparationId); }
  async cancelCurrent(): Promise<void> {
    const current = this.snapshot();
    if (current && preparedStartActive(current)) await this.source.cancel(current.preparation_id);
  }
  close(): Promise<void> { return this.source.close(); }

  private assertIdle(): void {
    const state = this.options.state();
    if (this.launch || state.game.status !== "disconnected" || state.server.status !== "stopped" ||
      !state.server.eula_accepted || state.sandbox.status !== "ready" ||
      state.run && !["stopped", "completed", "failed"].includes(state.run.status))
      throw new RuntimeFault("precondition_failed", "Prepared start requires a stopped prepared server, disconnected player and no active run");
  }
  private closeLaunch(): Promise<void> {
    const launch = this.launch;
    if (!launch) return Promise.resolve();
    launch.closing ??= Promise.resolve().then(() => launch.owner.close());
    return launch.closing;
  }
  private async enter(candidate: PreparedSourceCandidate): Promise<{ run_id: string }> {
    candidate.assertCurrent();
    this.assertIdle();
    const contract = await this.refreshContract();
    candidate.assertCurrent();
    if (contract.artifact_sha256 !== candidate.artifact_sha256 ||
      adapterCompatibility(contract.adapter.descriptor, contract.adapter.schemas).compatibility_hash !== candidate.contract_hash)
      throw new RuntimeFault("stale_context", "Prepared native artifact or startup scope changed before join");
    this.assertIdle();
    candidate.setPhase("joining");
    const launch = { owner: this.options.launch(), closing: null as Promise<void> | null };
    this.launch = launch;
    try {
      await launch.owner.ready;
      candidate.assertCurrent();
      candidate.setPhase("activating");
      const run = await this.options.runtime.startPreparedRun(candidate);
      return { run_id: run.run_id };
    } catch (error) {
      const view = this.snapshot();
      if (view?.preparation_id === candidate.preparation_id && view.closure === "transferred") {
        // The ordinary run now owns the worker and healthy world. A failed
        // later Agent initialization cannot turn startup cancellation into a
        // hidden world disconnect or claim that the transferred worker closed.
        try {
          const run = this.options.runtime.snapshot();
          if (run?.run_id === view.run_id && !["stopped", "completed", "failed"].includes(run.status))
            await this.options.runtime.control(run.run_id, "stop");
          const final = this.options.runtime.snapshot();
          candidate.transferClosed(final?.run_id === view.run_id && final.operator.cleanup_error === null);
        } catch { candidate.transferClosed(false); }
      } else await this.closeLaunch();
      throw error;
    } finally {
      if (this.launch === launch) this.launch = null;
    }
  }
}
