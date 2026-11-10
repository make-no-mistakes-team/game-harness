import type { Json, RunUsage, RuntimeAdapter } from "../shared/contracts.ts";
import type { ExecutableModuleBundle, SkillRef, SkillView } from "../shared/programs.ts";
import type { ResidentLimits, ResidentWorker } from "../shared/resident.ts";
import type { ControlSessionConfig } from "../shared/control-session.ts";
import type { PreparedStartRequest } from "../shared/prepared-start.ts";

/** A trusted artifact contract, not a negotiated native binding or observation. */
export interface PreparationContract {
  adapter: RuntimeAdapter;
  artifact_sha256: string;
}

/** Compile-only ownership transfers once, after real run admission validates the same source. */
export interface PreparedSourceCandidate {
  readonly preparation_id: string;
  readonly request: PreparedStartRequest;
  readonly contract_hash: string;
  readonly artifact_sha256: string;
  readonly sources: readonly SkillView[];
  readonly root: SkillRef;
  readonly bundle: ExecutableModuleBundle;
  readonly initial_state: Json;
  readonly intent: Json;
  readonly limits: ResidentLimits;
  readonly session: ControlSessionConfig;
  readonly usage: RunUsage;
  readonly deadline_host_ms: number;
  assertCurrent(): void;
  setPhase(phase: "joining" | "activating"): void;
  takeWorker(runId: string): ResidentWorker;
  /** Only the trusted launch owner calls this after an actually joined failure drain. */
  transferClosed(confirmed: boolean): void;
}
