import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type StoredRun } from "../../src/server/store.ts";
import { programFingerprint } from "../../src/server/program-validation.ts";
import { DEFAULT_SKILL_LIMITS, type SkillExecutionView, type SkillRef, type SkillSpec, type SkillView } from "../../src/shared/programs.ts";
import { executionScopeFixture, minecraftRunFixture, minecraftTestAdapter } from "./adapter-contract.ts";

export interface HistoryFixture {
  directory: string;
  store: Store;
  run: StoredRun;
  close(): void;
}

export function historyFixture(): HistoryFixture {
  const directory = mkdtempSync(join(tmpdir(), "gameharness-readonly-"));
  const store = new Store(directory);
  const run = minecraftRunFixture(minecraftTestAdapter());
  store.saveRun(run);
  return { directory, store, run, close() { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

/** Storage-only validated metadata, not a sandbox validation or effect claim. */
export function historySpec(run: StoredRun, name = "history fixture", source = 'return {status:"completed",summary:"Storage fixture",result:null};'): SkillSpec & { validation: SkillView["validation"] } {
  const hash = createHash("sha256").update(source).digest("hex");
  return {
    entry: "run", name, source, dependencies: [],
    card: { purpose: "Readonly storage parity", applicability: "Private SQLite fixtures only", method: "Read retained rows", reason: "History isolation", limitations: "No native or gameplay evidence" },
    validation: {
      fingerprint: programFingerprint(hash, "skill", run.compatibility_hash!),
      runtime_version: 5, api_version: 5, validator_version: 5, compatibility_hash: run.compatibility_hash!,
      formatted_lines: 1, complexity: 1, nesting: 0,
    },
  };
}

export function historyExecution(store: Store, run: StoredRun, skill: SkillRef, parent?: SkillExecutionView): SkillExecutionView {
  const view = store.admitSkill(run.run_id, {
    entry: "run", skill_id: skill.skill_id, version: skill.version, start_key: crypto.randomUUID(), ...executionScopeFixture(run), args: null, limits: { ...DEFAULT_SKILL_LIMITS },
  }, parent ? { parent_execution_id: parent.execution_id, root_execution_id: parent.root_execution_id } : undefined).view;
  view.status = "running";
  view.started_at = "2020-01-01T00:00:00.000Z";
  store.updateSkillExecution(view, "skill.running", "Storage fixture, no execution invoked");
  return view;
}

export function finishHistoryExecution(store: Store, view: SkillExecutionView): void {
  view.status = "succeeded";
  view.ended_at = "2020-01-01T00:00:01.000Z";
  view.result = { status: "completed", summary: "Storage-only self-report", result: null };
  store.updateSkillExecution(view, "skill.closed", "Storage fixture, no effect asserted");
}
