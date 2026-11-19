import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { finalPlanningEvidence } from "../survival-agent/planning-evidence.ts";
import { finalPauseEvidence, PAUSE_DIAGNOSTICS, reviewPauseJournal } from "../survival-agent/pause-evidence.ts";

const ns = (ms: number) => BigInt(ms) * 1_000_000n;
function playback(
  changes: [number, string][], end: number, pending: [number, number][] = [], sealed = true,
) {
  const lines = ["v1\tfixture", `state\t${ns(1_000)}\t1\t${changes[0]![1]}`, `input\t${ns(1_000)}\t1`];
  for (const [i, [at, state]] of changes.entries()) {
    if (i !== 0) lines.push(`state\t${ns(1_000 + at)}\t${i + 1}\t${state}`);
  }
  lines.push(`${sealed ? "end" : "pulse"}\t${ns(1_000 + end)}\t${changes.length + 1}${sealed ? "\tgoal_completed" : ""}`);
  return reviewPauseJournal(lines.join("\n") + "\n", {
    run: "fixture", runStartedNs: 0n, cutoffNs: ns(end + 1_000 + (sealed ? 0 : 1_500)),
    providerSpans: pending.map(([start, finish]) => ({
      startNs: ns(start + 1_000), endNs: ns(finish + 1_000), terminalObserved: true,
    })),
  });
}

test("strict pause thresholds and half-open rolling fences use episode onsets", () => {
  const report = playback([
    [0, "idle"], [500, "route"], [2_000, "idle"], [3_000, "crack"],
    [12_000, "idle"], [15_000, "crack"], [22_000, "idle"], [22_501, "route"],
    [42_000, "idle"], [43_001, "route"],
  ], 44_000);
  expect(report.allGameplay).toMatchObject({
    longestIdleMs: 3_000, over3000: { count: 0 },
    over500In20s: { qualifyingEpisodes: 4, maxInWindow: 2, violationPairCount: 2 },
    over1000In30s: { qualifyingEpisodes: 2, maxInWindow: 1, violationPairCount: 0 },
  });
  const near = playback([
    [0, "idle"], [1_001, "route"], [19_999, "idle"], [21_001, "route"],
    [29_999, "idle"], [31_001, "crack"],
  ], 32_000);
  expect(near.allGameplay).toMatchObject({
    over500In20s: { qualifyingEpisodes: 3, maxInWindow: 2, violationPairCount: 2 },
    over1000In30s: { qualifyingEpisodes: 3, maxInWindow: 3, violationPairCount: 3 },
  });
});

test("requests, unsupported gaze and measured stationary mechanics cannot split raw idle", () => {
  const report = playback([
    [0, "idle"], [600, "blocked"], [950, "aim_unverified"], [1_050, "mechanical_wait"],
    [2_000, "idle"], [3_010, "crack"], [4_000, "idle"], [5_100, "route"],
  ], 6_000, [[125, 1_000], [1_100, 3_500]]);
  expect(report).toMatchObject({
    diagnostic: "threshold_flagged",
    allGameplay: {
      idleMs: 4_110, longestIdleMs: 3_010, over3000: { count: 1 },
      over500In20s: { maxInWindow: 2, violationPairCount: 1 },
      over1000In30s: { maxInWindow: 2, violationPairCount: 1 },
    },
    providerOverlap: {
      pendingGameplayMs: 3_275, usefulOverlapMs: 490, idleOverlapMs: 2_785,
      episodes: { count: 1, longestIdleMs: 2_785 },
    },
    evidenceMs: { aim_unverified: 100, mechanical_wait: 950, crack: 990 },
  });
});

test("missing native evidence never becomes zero; a trailing known pause remains a lower bound", () => {
  const report = playback([[0, "route"], [800, "idle"]], 4_000, [], false);
  expect(report).toMatchObject({
    diagnostic: "threshold_flagged", rightCensored: true, unobservedTailMs: 1_500,
    allGameplay: { longestIdleMs: 3_200, longestEpisode: { rightCensored: true }, over3000: { count: 1 } },
    providerOverlap: { overlapFraction: null },
  });
  expect(playback([[0, "route"]], 1_000, [], false).diagnostic).toBe("insufficient_evidence");
  expect(reviewPauseJournal("", { run: "fixture", runStartedNs: 0n, cutoffNs: ns(100) })).toMatchObject({
    allGameplay: null, providerOverlap: null, diagnostic: "insufficient_evidence",
  });
});

test("provider attribution neither multiplies an episode nor masks a later all-game gap", () => {
  const report = playback([
    [0, "crack"], [1_000, "idle"], [2_500, "route"], [5_000, "idle"], [9_000, "crack"],
  ], 10_000, [[1_000, 1_500], [1_500, 2_501]]);
  expect(report).toMatchObject({
    allGameplay: { count: 2, over3000: { count: 1 }, over1000In30s: { violationPairCount: 1 } },
    providerOverlap: {
      idleOverlapMs: 1_500, usefulOverlapMs: 1,
      episodes: { count: 1, over1000In30s: { qualifyingEpisodes: 1, violationPairCount: 0 } },
    },
  });
});

test("one nanosecond changes strict duration qualification without rounding the window", () => {
  const report = reviewPauseJournal([
    "v1\tfixture",
    `state\t${ns(1_000)}\t1\tidle`,
    `input\t${ns(1_000)}\t1`,
    `state\t${ns(1_500) + 1n}\t2\troute`,
    `state\t${ns(21_000) - 1n}\t3\tidle`,
    `state\t${ns(21_500)}\t4\tcrack`,
    `end\t${ns(22_000)}\t5\tgoal_completed`,
    "",
  ].join("\n"), { run: "fixture", runStartedNs: 0n, cutoffNs: ns(22_000) });
  expect(report.allGameplay).toMatchObject({
    over500In20s: { qualifyingEpisodes: 2, maxInWindow: 2, violationPairCount: 1 },
  });
});

test("a cooperative end must acknowledge this run's terminal request", () => {
  const data = [
    "v1\tfixture",
    `state\t${ns(1_000)}\t1\tcrack`, `input\t${ns(1_015)}\t1`,
    `state\t${ns(1_050)}\t2\tidle`, `end\t${ns(1_250)}\t6\trunner_stop`, "",
  ].join("\n");
  const scope = { run: "fixture", runStartedNs: 0n, cutoffNs: ns(1_700) };
  expect(reviewPauseJournal(data, scope)).toMatchObject({
    diagnostic: "insufficient_evidence", rightCensored: true, allGameplay: null,
  });
  expect(reviewPauseJournal(data, { ...scope, runnerStopRequestedNs: ns(1_251) })).toMatchObject({
    diagnostic: "insufficient_evidence", rightCensored: true, allGameplay: null,
  });
  expect(reviewPauseJournal(data, { ...scope, runnerStopRequestedNs: ns(1_220) })).toMatchObject({
    reason: "runner_stop", rightCensored: false, unobservedTailMs: 0,
    observedGameplayMs: 250, runnerStop: { requestedMs: 220, acknowledgedMs: 250, tick: 6 },
    allGameplay: { idleMs: 200, longestEpisode: { rightCensored: true } },
  });
});

test("native pause evidence must be from the owning private regular file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "survival-pause-"));
  try {
    const target = path.join(dir, PAUSE_DIAGNOSTICS.source);
    const real = path.join(dir, "other.tsv");
    const data = [
      `v1\t${path.basename(dir)}`,
      `state\t${ns(1_000)}\t1\tidle`, `input\t${ns(1_600)}\t2`,
      `state\t${ns(1_700)}\t3\tcrack`, `end\t${ns(3_000)}\t30\tgoal_completed`, "",
    ].join("\n");
    const scope = { runStartedNs: 0n, cutoffNs: ns(3_000) };
    await writeFile(real, data, { mode: 0o600 });
    await symlink(real, target);
    expect(await finalPauseEvidence(dir, scope)).toMatchObject({
      diagnostic: "insufficient_evidence", allGameplay: null,
    });
    await rm(target);
    await writeFile(target, data, { mode: 0o600 });
    expect(await finalPauseEvidence(dir, scope)).toMatchObject({
      startupToGameplayMs: 1_000, gameplayBeforeFirstInputMs: 600,
      allGameplay: { idleMs: 700, longestEpisode: { initial: true } },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

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
