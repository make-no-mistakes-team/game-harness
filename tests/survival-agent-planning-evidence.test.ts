import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { finalPlanningEvidence } from "../survival-agent/planning-evidence.ts";

test("a revoked planner can seal its real idle maximum before the game stops", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "survival-planning-"));
  try {
    const ipc = path.join(dir, "macro");
    await mkdir(ipc, { mode: 0o700 });
    const sealed = {
      v: 1, run: path.basename(dir), life: 1, tick: 765, epoch: 5, reason: "authority_revoked",
      macro_planning_state: "inactive", macro_planning_evidence: "authority revoked",
      macro_wait_elapsed_ms: 0, macro_wait_max_idle_ms: 3042, macro_wait_max_overshoot_ms: 42,
      macro_wait_total_ms: 8935, macro_wait_max_no_work_ms: 13427,
      macro_planning_marker_notice_tick: 579, macro_planning_marker_notice_monotonic_ns: "150596242122733",
      macro_last_purposeful_tick: 763, macro_last_purposeful_action: "block broken",
      macro_blocked_count: 3, macro_urgent_count: 0, macro_fallback_actions: 2,
    };
    await writeFile(path.join(ipc, "native-planning-final.json"), JSON.stringify(sealed), { mode: 0o600 });
    const later = { ...sealed, tick: 2800 };
    expect(await finalPlanningEvidence(dir, later)).toMatchObject({
      measured: true, tick: 765, longestPendingWithoutWorkMs: 13427, rightCensored: false,
    });
    for (const changed of [
      { ...later, macro_planning_state: "local_in_progress" },
      { ...later, macro_last_purposeful_tick: 801 },
      { ...later, macro_wait_max_no_work_ms: 15000 },
    ]) {
      expect(await finalPlanningEvidence(dir, changed)).toMatchObject({
        measured: false, reason: "invalid_native_final", rightCensored: true,
      });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
