import path from "node:path";
import { z } from "zod";
import { MacroDirectory } from "../src/server/survival-macro/protocol.ts";

const ms = z.number().finite().nonnegative();
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const nativeSample = z.object({
  tick: count, life: count.positive(),
  macro_planning_state: z.enum(["awaiting_plan", "planning_wait", "blocked/no_safe_action",
    "local_in_progress", "terra_in_progress", "handoff", "urgent", "inactive", "trial_idle"]),
  macro_planning_evidence: z.string().max(1024),
  macro_wait_elapsed_ms: ms, macro_wait_max_idle_ms: ms, macro_wait_max_overshoot_ms: ms, macro_wait_total_ms: ms,
  macro_wait_max_no_work_ms: ms, macro_wait_total_no_work_ms: ms.optional(), macro_planning_marker_notice_tick: count.nullable(),
  macro_planning_marker_notice_monotonic_ns: z.string().regex(/^-?\d{1,20}$/).nullable(),
  macro_last_purposeful_tick: count.nullable(), macro_last_purposeful_action: z.string().max(512).nullable(),
  macro_blocked_count: count, macro_urgent_count: count, macro_fallback_actions: count,
});

/** Last native sample, including overshoot. A missing measurement is never zero idle time. */
export function planningWaitEvidence(sample: unknown) {
  if (!sample || typeof sample !== "object" || !("macro_planning_state" in sample)) return null;
  const result = nativeSample.safeParse(sample);
  if (!result.success) return { measured: false as const, reason: "invalid_native_sample" };
  const v = result.data;
  return {
    measured: true as const, tick: v.tick, life: v.life,
    state: v.macro_planning_state, evidence: v.macro_planning_evidence,
    currentPolicyWaitMs: v.macro_wait_elapsed_ms, longestPolicyWaitMs: v.macro_wait_max_idle_ms,
    longestPendingWithoutWorkMs: v.macro_wait_max_no_work_ms,
    totalPendingWithoutWorkMs: v.macro_wait_total_no_work_ms ?? null,
    markerObservedTick: v.macro_planning_marker_notice_tick, markerObservedMonotonicNs: v.macro_planning_marker_notice_monotonic_ns,
    maxDeadlineOvershootMs: v.macro_wait_max_overshoot_ms, totalIdleMs: v.macro_wait_total_ms,
    lastPurposefulTick: v.macro_last_purposeful_tick, lastPurposefulAction: v.macro_last_purposeful_action,
    blockedEpisodes: v.macro_blocked_count, urgentInterventions: v.macro_urgent_count,
    completedLocalActions: v.macro_fallback_actions,
  };
}

const terminalScope = z.object({
  v: z.literal(1), run: z.string(), life: count.positive(), tick: count, epoch: count,
  reason: z.enum(["authority_revoked", "actor_exit", "death_no_respawn", "respawn_failed", "connection_closed", "goal_completed"]),
});

export async function finalPlanningEvidence(runDir: string, sample: unknown) {
  const last = planningWaitEvidence(sample);
  let ipc: MacroDirectory | undefined;
  try {
    ipc = await MacroDirectory.open(path.join(runDir, "macro"));
    const final = await ipc.read("native-planning-final.json", raw => {
      const scope = terminalScope.parse(raw);
      const evidence = planningWaitEvidence(raw);
      if (!evidence?.measured || scope.run !== path.basename(runDir))
        throw new Error("Native planning close does not match the attempt.");
      if (last?.measured && (scope.tick < last.tick || scope.life < last.life)) {
        // The game can keep ticking after the final authority revocation.
        // Later inactive ticks do not supersede the seal; new work would.
        const sameRetiredAuthority = scope.reason === "authority_revoked" && last.state === "inactive" &&
          evidence.state === "inactive" && scope.life === last.life &&
          last.lastPurposefulTick === evidence.lastPurposefulTick &&
          last.markerObservedMonotonicNs === evidence.markerObservedMonotonicNs &&
          last.longestPendingWithoutWorkMs === evidence.longestPendingWithoutWorkMs &&
          last.totalPendingWithoutWorkMs === evidence.totalPendingWithoutWorkMs &&
          last.longestPolicyWaitMs === evidence.longestPolicyWaitMs &&
          last.totalIdleMs === evidence.totalIdleMs && last.blockedEpisodes === evidence.blockedEpisodes &&
          last.completedLocalActions === evidence.completedLocalActions && last.urgentInterventions === evidence.urgentInterventions;
        if (!sameRetiredAuthority) throw new Error("Planning continued past the reported native close.");
      }
      return { ...evidence, source: "native_final" as const, rightCensored: false, epoch: scope.epoch, reason: scope.reason };
    });
    if (final) return final;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return { measured: false as const, reason: "invalid_native_final", lastSnapshot: last, rightCensored: true };
    }
  } finally {
    await ipc?.close();
  }
  return last && { ...last, source: "progress_snapshot" as const, rightCensored: true };
}
