import type { ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { MACRO_MAX_PLANNING_IDLE_MS, type MacroBasis, type MacroInference } from "../src/server/survival-macro/protocol.ts";

export const urgentThreatLimits = { wallSeconds: 120, maxRequests: 3 } as const;
export const urgentCraftLimits = { wallSeconds: 120, maxRequests: 0 } as const;
type ProbeKind = "terra" | "craft";
const TAG = "gameharness_urgent_diagnostic";
const DELAY_MS = 300;
const SOURCE_BLOCKS = 3;
const CRAFT_SOURCE_BLOCKS = 4;
const CLOCK_MARGIN_MS = 10;
const JOURNAL = "urgent-danger.jsonl";

export const urgentThreatDeclaration = {
  scope: "prepared-diagnostic-only",
  cue: { source: "vanilla ignited creeper", trigger: "first authorized provider fetch",
    delayMs: DELAY_MS, placement: "three blocks behind the admitted first-person player, for an audio-first cue",
    ignoresModelResponse: true, fallbackCues: false },
  inputWriter: "ordinary agent client",
  evidence: { native: JOURNAL, host: "history.jsonl", clock: "monotonic within each process; conservative wall-time correlation",
    recording: "screen.mp4", audioRecorded: false },
  cleanup: "cancel unissued cue; remove only fixture creeper after client disconnect; drain the private server",
} as const;

export const urgentCraftDeclaration = {
  ...urgentThreatDeclaration,
  cue: { source: "vanilla ignited creeper", trigger: "first confirmed native workbench drag preview with a carried stack",
    delayMs: 0, placement: "four blocks behind the admitted first-person player",
    followsFirstPreviewOnly: true, independentlyScheduledFromDefense: true, fallbackCues: false },
  evidence: { ...urgentThreatDeclaration.evidence, nativeDrag: "gui-drag.tsv", model: null },
} as const;

type Dispatch = { basis: MacroBasis; startedAtMs: number; wallMs: number };
type Settlement = {
  basis: MacroBasis; settledAtMs: number; wallMs: number; outcome: MacroInference["outcome"];
  providerTerminalAtMs?: number; providerTerminalWallMs?: number;
};
type Boundary = { monoMs: number; wallMs: number };
type ConsoleOutcome = "acknowledged" | "none" | "unconfirmed";
type Drag = { id: string; job: number; syncId: number; edge: string; wallMs: number; cursorCount: number; effect: string };
const stamp = (): Boundary => ({ monoMs: performance.now(), wallMs: Date.now() });

// The reply attests to fixture setup or cleanup, never to what the client perceived or did.
function vanillaCommand(server: ChildProcess, command: string, acknowledgement: RegExp) {
  const { stdin, stdout } = server;
  if (!stdin?.writable || !stdout?.readable) return Promise.resolve<ConsoleOutcome>("unconfirmed");
  return new Promise<ConsoleOutcome>(resolve => {
    let tail = "";
    const finish = (outcome: ConsoleOutcome) => {
      clearTimeout(timeout);
      stdout.off("data", output);
      server.off("exit", onExit);
      resolve(outcome);
    };
    const onExit = () => finish("unconfirmed");
    const output = (chunk: Buffer) => {
      const lines = (tail + chunk.toString("utf8")).split("\n");
      tail = lines.pop()!.slice(-1_024);
      for (const line of lines) {
        const message = line.match(/^\[[^\]]+\] \[Server thread\/INFO\]: (.*)$/)?.[1]?.trim();
        if (!message) continue;
        if (acknowledgement.test(message)) { finish("acknowledged"); break; }
        if (message === "No entity was found") { finish("none"); break; }
      }
    };
    const timeout = setTimeout(onExit, 1_500);
    stdout.on("data", output);
    server.once("exit", onExit);
    stdin.write(`${command}\n`, error => { if (error) finish("unconfirmed"); });
  });
}

export function createUrgentThreatProbe(
  dir: string, signal: AbortSignal, record: (event: string, fields?: Record<string, unknown>) => Promise<void>,
  kind: ProbeKind = "terra",
) {
  let endpoint: { server: ChildProcess; profile: string } | undefined;
  let dispatch: Dispatch | undefined;
  let settlement: Settlement | undefined;
  let issued: Boundary | undefined;
  let issueResult: ConsoleOutcome | undefined;
  let cleanup: ConsoleOutcome | "not_issued" | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> | undefined;
  let watching: Promise<void> | undefined;
  let craftTrigger: Drag | undefined;
  let logged = Promise.resolve();
  let logFailed = false;
  const log = (event: string, fields: Record<string, unknown>) => {
    logged = logged.then(() => record(`urgent_${event}`, fields)).catch(() => { logFailed = true; });
  };
  function bind(server: ChildProcess, profile: string) {
    if (endpoint || !/^[A-Za-z0-9_]{1,16}$/.test(profile)) throw new Error("Invalid urgent diagnostic endpoint.");
    endpoint = { server, profile };
    if (kind === "craft") watching = watchFirstCraft().catch(() => { if (!signal.aborted) logFailed = true; });
  }
  function onDispatch(event: Dispatch) {
    if (dispatch || signal.aborted) return;
    dispatch = event;
    const scheduledMonoMs = event.startedAtMs + DELAY_MS;
    log("provider_dispatched", { ...event, scheduledMonoMs });
    schedule(scheduledMonoMs, SOURCE_BLOCKS);
  }
  function schedule(scheduledMonoMs: number, blocks: number) {
    timer = setTimeout(() => {
      timer = undefined;
      if (signal.aborted || !endpoint) { log("cue_not_issued", { ...stamp() }); return; }
      const { server, profile } = endpoint;
      issued = stamp();
      log("cue_issued", { ...issued, scheduledMonoMs });
      const command = `execute at ${profile} rotated ~ 0 positioned ^ ^ ^-${blocks} ` +
        `run summon minecraft:creeper ~ ~ ~ {ignited:1b,PersistenceRequired:1b,Tags:["${TAG}"]}`;
      active = vanillaCommand(server, command, /^Summoned new Creeper$/).then(result => {
        issueResult = result;
        log("cue_console_result", { ...stamp(), result });
      });
    }, Math.ceil(Math.max(0, scheduledMonoMs - performance.now())));
  }
  async function dragRows() {
    const text = await readFile(path.join(dir, "gui-drag.tsv"), "utf8").catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    });
    return text.split("\n").slice(1, -1).flatMap(line => {
      const c = line.split("\t");
      if (c.length !== 21 || c[2] !== "crafting") return [];
      return [{ id: c[0]!, job: Number(c[1]), syncId: Number(c[3]), edge: c[4]!, wallMs: Number(c[6]),
        cursorCount: Number(c[15]), effect: c[20]! }];
    });
  }
  async function watchFirstCraft() {
    while (!signal.aborted) {
      const first = (await dragRows()).find(drag => drag.edge === "enter" && drag.cursorCount > 0 &&
        drag.effect === "native preview admitted");
      if (first && !signal.aborted) {
        const boundary = stamp();
        craftTrigger = first;
        log("craft_preview_observed", { ...boundary, preview: first });
        schedule(boundary.monoMs, CRAFT_SOURCE_BLOCKS);
        return;
      }
      await delay(12, undefined, { signal });
    }
  }
  function onSettled(event: Settlement) {
    settlement = event;
    log("provider_settled", event);
  }
  async function cleanUp() {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
      log("cue_cancelled_before_issue", { ...stamp() });
    }
    await watching;
    await active;
    cleanup = issued && endpoint ? await vanillaCommand(endpoint.server,
      `kill @e[type=minecraft:creeper,tag=${TAG}]`, /^Killed Creeper$/) : "not_issued";
    log("cleanup", { ...stamp(), result: cleanup, afterClientDisconnect: true });
    await logged;
  }
  async function samples() {
    return readFile(path.join(dir, JOURNAL), "utf8").then(text => text.trimEnd().split("\n").map(line =>
      row.parse(JSON.parse(line))), () => []);
  }
  async function ready() {
    if (!issued || (kind === "terra" && !settlement)) return false;
    const evidence = await samples().catch(() => []);
    const fuse = evidence.find(event => event.kind === "fuse");
    return !!fuse && evidence.some(event => event.fuse_tick === fuse.tick && event.tick >= fuse.tick + 48);
  }
  async function verify(context: { noDeath: boolean; recordingClosed: boolean; trustedDrain: boolean; budgetLimited: boolean }) {
    const evidence = await samples().catch(() => []);
    const first = evidence.find(event => event.kind === "fuse" && event.life === (dispatch?.basis.life ?? 1));
    const fuse = first?.kind === "fuse" ? first : undefined;
    const related = fuse ? evidence.filter(event => event.life === fuse.life && event.fuse_tick === fuse.tick) : [];
    const explosion = related.find(event => event.kind === "explosion");
    const effects = related.filter(event => event.kind === "effect_sample");
    const after = explosion?.kind === "explosion" ? effects.find(event =>
      event.mono_ms >= explosion.cue_mono_ms + 200) : undefined;
    const distanceBefore = fuse && Math.hypot(...fuse.cue_origin.map((value, i) => value - fuse.cue_player[i]!));
    const retreated = distanceBefore !== undefined && fuse && explosion?.kind === "explosion" ? effects.find(event =>
      event.mono_ms < explosion.cue_mono_ms && event.tick <= fuse.tick + 24 &&
      event.distance_from_fuse_origin >= distanceBefore + 1.5) : undefined;
    const terminal = settlement?.providerTerminalAtMs !== undefined && settlement.providerTerminalWallMs !== undefined
      ? { monoMs: settlement.providerTerminalAtMs, wallMs: settlement.providerTerminalWallMs } : undefined;
    const sameDrag = craftTrigger && (await dragRows().catch(() => [])).filter(event => event.id === craftTrigger!.id);
    const dragAbort = fuse && sameDrag?.find(event => event.edge === "aborted" && event.effect === "cancelled" &&
      event.wallMs >= fuse.cue_wall_ms && event.wallMs <= fuse.wall_ms + 1);
    const reconciled = fuse && effects.find(event => event.tick <= fuse.tick + 12 &&
      event.cursor_item_inventory_count === fuse.cursor_before_total && event.active_cursor_count === 0);
    const craftInterrupted = fuse?.cue_screen === "crafting_table" && fuse.cue_screen_rendered &&
      fuse.check_screen === "crafting_table" && fuse.rendered_at_check === "crafting_table" &&
      fuse.cue_screen_rendered_at_check && fuse.screen_after_keys === "world" &&
      fuse.hands_before.startsWith("craft ") && fuse.hands_after.endsWith(": cancelled");
    const report = (reason: string | null) => ({
      status: reason === null ? "proved" : context.budgetLimited ? "budget_limited" : "no_proof",
      reason, dispatch: dispatch ?? null, settlement: settlement ?? null,
      pendingScope: kind === "craft" ? "no-provider" :
        terminal ? "before-provider-terminal-observation" : "client-transport-in-flight",
      fixture: { issued: issued ?? null, issueResult: issueResult ?? null, cleanup: cleanup ?? null },
      native: { firstRecordedFuse: fuse ?? null, explosion: explosion ?? null, distanceBefore: distanceBefore ?? null,
        preBlastRetreat: retreated ?? null, afterBlast: after ?? null, minSampledHealth: related.length
          ? Math.min(...related.map(event => event.health), fuse!.cue_health) : null },
      craftingScreen: craftInterrupted ? reason === null ? "proved" : "observed_not_proved" : "not_proved",
      ...(kind === "craft" ? { craft: { trigger: craftTrigger ?? null, dragAbort: dragAbort ?? null,
        settledOrReleased: sameDrag?.some(event => event.edge === "settled" || event.edge === "up") ?? false,
        reconciled: reconciled ?? null } } : {}),
      ...context,
    });
    if (!issued || !fuse) return report("Missing fixture issue or perceivable vanilla fuse.");
    if (kind === "terra") {
      if (!dispatch || !settlement) return report("Missing an authorized provider interval.");
      if (settlement.basis.run !== dispatch.basis.run || settlement.basis.tick !== dispatch.basis.tick ||
          settlement.basis.life !== dispatch.basis.life || settlement.basis.epoch !== dispatch.basis.epoch)
        return report("The provider interval did not settle on the same request basis.");
      if (settlement.outcome === "provider_error" || settlement.outcome === "provider_unavailable")
        return report("The authorized fetch did not establish a usable provider request.");
      if (!clockAgrees(dispatch.startedAtMs, dispatch.wallMs, settlement.settledAtMs, settlement.wallMs) ||
          terminal && (!clockAgrees(dispatch.startedAtMs, dispatch.wallMs, terminal.monoMs, terminal.wallMs) ||
            !clockAgrees(terminal.monoMs, terminal.wallMs, settlement.settledAtMs, settlement.wallMs)) ||
          !clockAgrees(dispatch.startedAtMs, dispatch.wallMs, issued.monoMs, issued.wallMs) ||
          !clockAgrees(fuse.cue_mono_ms, fuse.cue_wall_ms, fuse.mono_ms, fuse.wall_ms) ||
          issued.monoMs < dispatch.startedAtMs + DELAY_MS ||
          fuse.cue_wall_ms <= dispatch.wallMs + CLOCK_MARGIN_MS ||
          fuse.cue_wall_ms < issued.wallMs - CLOCK_MARGIN_MS ||
          fuse.wall_ms >= (terminal?.wallMs ?? settlement.wallMs) - CLOCK_MARGIN_MS)
        return report("The genuine request was not proven pending through both the cue and applied controls.");
      if (fuse.planning_before !== "planning_wait" || fuse.mono_ms >= fuse.planning_deadline_mono_ms ||
          fuse.wall_ms >= dispatch.wallMs + MACRO_MAX_PLANNING_IDLE_MS - CLOCK_MARGIN_MS)
        return report("The defense did not interrupt the live planning wait before its native deadline.");
    } else if (!craftTrigger || craftTrigger.wallMs > issued.wallMs || fuse.cue_wall_ms < issued.wallMs - CLOCK_MARGIN_MS ||
        !craftInterrupted || fuse.gui_sync_id !== craftTrigger.syncId || fuse.hands_job_generation !== craftTrigger.job ||
        fuse.cursor_before_count <= 0 || fuse.cursor_preview_slots <= 0 || fuse.cursor_after_count !== 0 ||
        !dragAbort || sameDrag?.some(event => event.edge === "settled" || event.edge === "up") || !reconciled) {
      return report("The same real crafting drag, its cancellation without release, and cursor return were not all proved.");
    }
    if (fuse.previous_check_tick !== fuse.tick - 1 || !(fuse.previous_check_mono_ms < fuse.cue_mono_ms &&
        fuse.cue_mono_ms <= fuse.check_mono_ms && fuse.check_mono_ms <= fuse.mono_ms) ||
        !fuse.pursued_fuse_escape || !(fuse.key_forward || fuse.key_back || fuse.key_left || fuse.key_right || fuse.key_use))
      return report("No defensive keys were observed on the first schedulable client tick.");
    if (!retreated || !after || !after.alive || after.health <= 0)
      return report("No pre-blast retreat and living post-blast sample were both observed.");
    if (kind === "craft" && (fuse.cue_health !== 20 ||
        related.some(event => event.hurt_time !== 0 || event.health !== fuse.cue_health)))
      return report("The client observed damage during the crafting escape.");
    if (!context.noDeath || !context.recordingClosed || !context.trustedDrain || logFailed ||
        issueResult !== "acknowledged" || (cleanup !== "acknowledged" && cleanup !== "none"))
      return report("The recording, lifecycle, fixture cleanup, or provider drain did not close cleanly.");
    return report(null);
  }
  return { bind, onDispatch, onSettled, cleanUp, ready, verify };
}

function clockAgrees(firstMs: number, firstWallMs: number, lastMs: number, lastWallMs: number) {
  return lastMs >= firstMs && Math.abs((lastMs - firstMs) - (lastWallMs - firstWallMs)) < CLOCK_MARGIN_MS / 2;
}

const position = z.tuple([z.number(), z.number(), z.number()]);
const sample = {
  tick: z.int().positive(), fuse_tick: z.int().positive(), life: z.int().positive(), alive: z.boolean(),
  health: z.number(), blocking: z.boolean(), player: position, distance_from_fuse_origin: z.number(),
  wall_ms: z.int().positive(), mono_ms: z.number(),
  cursor_item_inventory_count: z.int().nonnegative(), active_cursor_count: z.int().nonnegative(),
  hurt_time: z.int().nonnegative(),
};
const sound = {
  cue_wall_ms: z.int().positive(), cue_mono_ms: z.number(), cue_origin: position,
  cue_player: position, cue_health: z.number(), cue_screen: z.string(), cue_screen_rendered: z.boolean(),
};
const row = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fuse"), ...sample, ...sound,
    check_mono_ms: z.number(), previous_check_tick: z.int(), previous_check_mono_ms: z.number(),
    check_screen: z.string(), rendered_at_check: z.string(), cue_screen_rendered_at_check: z.boolean(),
    screen_after_keys: z.string(), pursued_fuse_escape: z.boolean(),
    hands_before: z.string(), hands_after: z.string(), cursor_before_item: z.string(),
    cursor_before_count: z.int().nonnegative(), cursor_after_count: z.int().nonnegative(),
    cursor_before_total: z.int().nonnegative(), cursor_preview_slots: z.int().nonnegative(),
    gui_sync_id: z.int().nonnegative(), hands_job_generation: z.int().nonnegative(),
    planning_before: z.string().nullable(), planning_deadline_mono_ms: z.number(),
    key_forward: z.boolean(), key_back: z.boolean(), key_left: z.boolean(), key_right: z.boolean(), key_use: z.boolean() }),
  z.object({ kind: z.literal("explosion"), ...sample, ...sound }),
  z.object({ kind: z.literal("effect_sample"), ...sample }),
]);
