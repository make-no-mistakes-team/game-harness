import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

const JOURNAL = "native-pause-timeline.tsv";
const MAX_ROWS = 16_384;
const MAX_BYTES = 1_024_000;
const NS_PER_MS = 1_000_000n;
const PAUSE_STATES = ["idle", "blocked", "aim_unverified", "input_unverified", "unsampled", "mechanical_wait",
  "crack", "route", "gui", "novelty", "safety"] as const;
type State = typeof PAUSE_STATES[number];
const WORK = new Set<State>(["crack", "route", "gui", "novelty", "safety"]);
const END_REASONS = new Set(["actor_exit", "death_no_respawn", "respawn_failed", "connection_closed", "goal_completed", "runner_stop"]);
const MAX_WITNESS_PAIRS = 12;

export const PAUSE_DIAGNOSTICS = Object.freeze({
  version: "survival-pause/v1", source: JOURNAL, clock: "linux-clock-monotonic",
  meaning: "diagnostic flags for review, not a human-likeness verdict",
  unit: "wall-clock milliseconds", durationComparison: "strictly_greater",
  window: "half-open, pause onset to pause onset",
  maxSinglePauseMs: 3_000,
  rolling: [{ overMs: 500, windowMs: 20_000, maxEpisodes: 1 },
    { overMs: 1_000, windowMs: 30_000, maxEpisodes: 1 }],
  maxWitnessIntervalMs: 150,
});

export interface ProviderPendingSpan {
  readonly startNs: bigint;
  readonly endNs: bigint | null;
  readonly terminalObserved: boolean;
  readonly stage?: "pre_spawn_goal_only" | "live_observation";
}

interface ReviewScope {
  run: string;
  runStartedNs: bigint;
  cutoffNs: bigint;
  recordingStartedNs?: bigint;
  runnerStopRequestedNs?: bigint;
  providerSpans?: readonly ProviderPendingSpan[];
}

interface Interval { start: bigint; end: bigint; startTick: number; endTick: number }
interface Segment extends Interval { state: State }
interface Pause extends Interval {
  initial: boolean;
  rightCensored: boolean;
  pending: bigint;
  unsampled: bigint;
  mechanical: bigint;
}

const toMs = (ns: bigint) => Number(ns) / 1e6;
const min = (a: bigint, b: bigint) => a < b ? a : b;
const max = (a: bigint, b: bigint) => a > b ? a : b;

function missing(reason: string) {
  return {
    version: PAUSE_DIAGNOSTICS.version, diagnostic: "insufficient_evidence" as const, reason,
    rightCensored: true, allGameplay: null, providerOverlap: null, startupToGameplayMs: null,
    startupProviderPendingBeforeGameplayMs: null,
    gameplayBeforeFirstInputMs: null, unobservedTailMs: null, usefulWorkMs: null, classifiedIdleMs: null, evidenceMs: null,
  };
}

function parseJournal(text: string, { run, runStartedNs, cutoffNs, runnerStopRequestedNs }: ReviewScope) {
  const rows = text.split("\n");
  const partial = rows.pop() !== "";
  if (rows.shift() !== `v1\t${run}` || rows.length > MAX_ROWS) throw new Error("Invalid timeline header or size.");
  const segments: Segment[] = [];
  let state: State | undefined;
  let first: bigint | undefined, firstInput: bigint | undefined, last: bigint | undefined, start = 0n;
  let startTick = 0, lastTick = 0;
  let seal: string | undefined;
  let limited = false;
  for (const row of rows) {
    const [kind, ns, tickText, value, extra] = row.split("\t");
    if (seal || limited || extra !== undefined || !ns || !/^\d{1,20}$/.test(ns) ||
        !tickText || !/^\d{1,10}$/.test(tickText)) throw new Error("Invalid timeline row.");
    const at = BigInt(ns), tick = Number(tickText);
    if (at < runStartedNs || at > cutoffNs || (last !== undefined && at < last) || tick < lastTick)
      throw new Error("Timeline does not match the run clock.");
    if (kind === "state" && PAUSE_STATES.includes(value as State)) {
      if (state && at > start) segments.push({ start, end: at, startTick, endTick: tick, state });
      first ??= at;
      state = value as State;
      start = at;
      startTick = tick;
    } else if (state && kind === "input" && value === undefined && firstInput === undefined) {
      firstInput = at;
    } else if (!(state && kind === "pulse" && value === undefined)) {
      if (state && kind === "end" && value && END_REASONS.has(value)) {
        if (value === "runner_stop" && (runnerStopRequestedNs === undefined || runnerStopRequestedNs < runStartedNs ||
            at < runnerStopRequestedNs)) throw new Error("Runner stop did not match the terminal request.");
        seal = value;
      } else if (state && kind === "limit" && value === undefined) limited = true;
      else throw new Error("Unknown timeline record.");
    }
    last = at;
    lastTick = tick;
  }
  if (first === undefined || last === undefined || !state || first === last) return null;
  if (last > start) segments.push({ start, end: last, startTick, endTick: lastTick, state });
  return { segments, first, last, lastTick, firstInput, seal: partial ? undefined : seal, limited, partial };
}

function providerWindows(spans: readonly ProviderPendingSpan[] | undefined, started: bigint) {
  if (!spans) return null;
  const ordered = [...spans].sort((a, b) => a.startNs < b.startNs ? -1 : a.startNs > b.startNs ? 1 : 0);
  const union: { start: bigint; end: bigint }[] = [];
  for (const span of ordered) {
    const { startNs: start, endNs: end } = span;
    if (start < started || end === null || end < start) return null;
    const prev = union.at(-1);
    if (prev && start <= prev.end) prev.end = max(prev.end, end);
    else union.push({ start, end });
  }
  return union;
}

function measure(episodes: readonly Pause[], first: bigint, duration: (pause: Pause) => bigint) {
  const format = (episode: Pause) => ({
    onsetMs: toMs(episode.start - first), endMs: toMs(episode.end - first),
    durationMs: toMs(episode.end - episode.start), pendingOverlapMs: toMs(episode.pending),
    unsampledMs: toMs(episode.unsampled), witnessedMechanicalWaitMs: toMs(episode.mechanical),
    startTick: episode.startTick, endTick: episode.endTick, initial: episode.initial, rightCensored: episode.rightCensored,
  });
  function rolling(rule: typeof PAUSE_DIAGNOSTICS.rolling[number]) {
    const relevant = episodes.filter(pause => duration(pause) > BigInt(rule.overMs) * NS_PER_MS);
    const windowNs = BigInt(rule.windowMs) * NS_PER_MS;
    let left = 0, maximum = 0, maximumAt = 0, pairCount = 0;
    const pairs: { first: ReturnType<typeof format>; second: ReturnType<typeof format> }[] = [];
    for (let right = 0; right < relevant.length; right++) {
      const newest = relevant[right]!;
      while (newest.start - relevant[left]!.start >= windowNs) ++left;
      pairCount += right - left;
      if (right - left + 1 > maximum) {
        maximum = right - left + 1;
        maximumAt = left;
      }
      for (let i = left; i < right && pairs.length < MAX_WITNESS_PAIRS; i++)
        pairs.push({ first: format(relevant[i]!), second: format(newest) });
    }
    return {
      qualifyingEpisodes: relevant.length, maxInWindow: maximum,
      maxWindowOnsetMs: maximum ? toMs(relevant[maximumAt]!.start - first) : null,
      violationPairCount: pairCount, violationPairs: pairs, pairsTruncated: pairCount > pairs.length,
    };
  }
  let total = 0n, longest = 0n, countOver = 0, longestEpisode: ReturnType<typeof format> | null = null;
  const overWitnesses: ReturnType<typeof format>[] = [];
  for (const pause of episodes) {
    const length = duration(pause);
    total += length;
    if (length > longest) {
      longest = length;
      longestEpisode = format(pause);
    }
    if (length > BigInt(PAUSE_DIAGNOSTICS.maxSinglePauseMs) * NS_PER_MS) {
      ++countOver;
      if (overWitnesses.length < MAX_WITNESS_PAIRS) overWitnesses.push(format(pause));
    }
  }
  return {
    count: episodes.length, idleMs: toMs(total), longestIdleMs: toMs(longest), longestEpisode,
    over3000: { count: countOver, witnesses: overWitnesses },
    over500In20s: rolling(PAUSE_DIAGNOSTICS.rolling[0]!),
    over1000In30s: rolling(PAUSE_DIAGNOSTICS.rolling[1]!),
  };
}

export function reviewPauseJournal(text: string, scope: ReviewScope) {
  if (!text) return missing("native_journal_missing");
  if (Buffer.byteLength(text) > MAX_BYTES) return missing("native_journal_too_large");
  let observed;
  try { observed = parseJournal(text, scope); }
  catch { return missing("native_journal_invalid"); }
  if (!observed) return missing("no_elapsed_native_gameplay");
  const { first, firstInput, last, lastTick, segments, seal, limited, partial } = observed;

  const provider = providerWindows(scope.providerSpans, scope.runStartedNs);
  // The startup lane admits at most one span. Keep time before the first
  // observed gameplay sample separate from all actual gameplay accounting.
  const startup = scope.providerSpans?.find(span => span.stage === "pre_spawn_goal_only");
  const startupProviderPendingBeforeGameplayMs = !provider ? null : startup?.endNs != null
    ? toMs(max(0n, min(startup.endNs, first) - startup.startNs)) : 0;
  const evidenceNs = new Map<State, bigint>();
  let cursor = 0;
  function pendingIn(start: bigint, end: bigint) {
    if (!provider) return 0n;
    let total = 0n;
    while (cursor < provider.length && provider[cursor]!.end <= start) ++cursor;
    for (let i = cursor; i < provider.length; ++i) {
      const span = provider[i]!;
      if (span.start >= end) break;
      total += min(end, span.end) - max(start, span.start);
    }
    return total;
  }

  const pauses: Pause[] = [];
  let activePause: Pause | undefined;
  let useful = 0n, usefulOverlap = 0n, pendingGameplay = 0n, mechanicalOverlap = 0n, unsampledOverlap = 0n;
  for (const { start, end, startTick, endTick, state } of segments) {
    const length = end - start, pending = pendingIn(start, end);
    pendingGameplay += pending;
    evidenceNs.set(state, (evidenceNs.get(state) ?? 0n) + length);
    if (WORK.has(state)) {
      useful += length;
      usefulOverlap += pending;
      activePause = undefined;
      continue;
    }
    if (!activePause) {
      activePause = { start, end, startTick, endTick, pending: 0n, initial: start === first,
        rightCensored: false, unsampled: 0n, mechanical: 0n };
      pauses.push(activePause);
    }
    activePause.end = end;
    activePause.endTick = endTick;
    activePause.pending += pending;
    if (state === "unsampled") {
      activePause.unsampled += length;
      unsampledOverlap += pending;
    } else if (state === "mechanical_wait") {
      activePause.mechanical += length;
      mechanicalOverlap += pending;
    }
  }
  if (activePause) activePause.rightCensored = true;
  const allGameplay = measure(pauses, first, pause => pause.end - pause.start);
  const rightCensored = !seal;
  const unsampledNs = evidenceNs.get("unsampled") ?? 0n;
  const flagged = allGameplay.over3000.count > 0 || allGameplay.over500In20s.violationPairCount > 0 ||
    allGameplay.over1000In30s.violationPairCount > 0;
  return {
    version: PAUSE_DIAGNOSTICS.version,
    diagnostic: flagged ? "threshold_flagged" : rightCensored || unsampledNs > 0n || firstInput === undefined
      ? "insufficient_evidence" : "within_observed_thresholds",
    reason: limited ? "journal_limit" : partial ? "partial_record" : seal ?? "native_end_missing",
    onsetClockNs: first.toString(), rightCensored,
    startupToGameplayMs: toMs(first - scope.runStartedNs), startupProviderPendingBeforeGameplayMs,
    gameplayBeforeFirstInputMs: firstInput === undefined ? null : toMs(firstInput - first),
    firstInputNotObservedThroughMs: firstInput === undefined ? toMs(last - first) : null,
    runnerStop: scope.runnerStopRequestedNs === undefined ? null : {
      requestedClockNs: scope.runnerStopRequestedNs.toString(),
      requestedMs: toMs(scope.runnerStopRequestedNs - first),
      acknowledgedMs: seal === "runner_stop" ? toMs(last - first) : null,
      tick: seal === "runner_stop" ? lastTick : null,
    },
    gameplayRecordingOffsetEstimateMs: scope.recordingStartedNs === undefined ? null : toMs(first - scope.recordingStartedNs),
    observedGameplayMs: toMs(last - first), unobservedTailMs: rightCensored ? toMs(scope.cutoffNs - last) : 0,
    usefulWorkMs: toMs(useful),
    classifiedIdleMs: toMs(last - first - useful - unsampledNs),
    evidenceMs: Object.fromEntries(PAUSE_STATES.map(state => [state, toMs(evidenceNs.get(state) ?? 0n)])),
    allGameplay,
    providerOverlap: !provider ? null : {
      definition: "observed transport pending overlap, not proof of cause; uses original pause onsets and summed pending duration",
      pendingGameplayMs: toMs(pendingGameplay),
      usefulOverlapMs: toMs(usefulOverlap),
      idleOverlapMs: toMs(pendingGameplay - usefulOverlap),
      classifiedIdleOverlapMs: toMs(pendingGameplay - usefulOverlap - unsampledOverlap),
      witnessedMechanicalOverlapMs: toMs(mechanicalOverlap),
      unsampledOverlapMs: toMs(unsampledOverlap),
      pendingUnobservedTailMs: rightCensored ? toMs(pendingIn(last, scope.cutoffNs)) : 0,
      overlapFraction: pendingGameplay > 0n ? Number(usefulOverlap) / Number(pendingGameplay) : null,
      unconfirmedServerTerminations: scope.providerSpans!.filter(span => !span.terminalObserved).length,
      episodes: measure(pauses.filter(pause => pause.pending > 0n), first, pause => pause.pending),
    },
    providerSpans: scope.providerSpans?.map(span => ({
      startMs: toMs(span.startNs - first), endMs: span.endNs === null ? null : toMs(span.endNs - first),
      terminalObserved: span.terminalObserved, stage: span.stage ?? "live_observation",
    })) ?? null,
  };
}

export async function finalPauseEvidence(dir: string, scope: Omit<ReviewScope, "run">) {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path.join(dir, JOURNAL), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 ||
        info.size > MAX_BYTES) return missing("native_journal_invalid");
    const bytes = Buffer.allocUnsafe(info.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== info.size) return missing("native_journal_changed_during_review");
    return reviewPauseJournal(bytes.toString("utf8", 0, length), { ...scope, run: path.basename(dir) });
  } catch (error) {
    return missing((error as NodeJS.ErrnoException).code === "ENOENT" ? "native_journal_missing" : "native_journal_unreadable");
  } finally {
    await file?.close();
  }
}
