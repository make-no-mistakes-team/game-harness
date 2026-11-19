import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, open, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute } from "node:path";

export const MACRO_CAPABILITIES_VERSION = "survival-macro/v1";
export const MACRO_MAX_INTENT_TTL_TICKS = 1_200;
export const MACRO_MAX_PLAN_TTL_TICKS = 7_200;
export const MACRO_MAX_HANDOFF_TTL_TICKS = 100;
export const MACRO_MAX_PLANNING_IDLE_MS = 3_000;
export const MACRO_MAX_STRATEGIC_EPISODES = 3;

const FILE_BYTES = {
  "active.json": 512,
  "handoff.json": 2 * 1024,
  "planning.json": 1024,
  "native-planning-final.json": 8 * 1024,
  "observation.json": 64 * 1024,
  "intent.json": 2 * 1024,
  "receipt.json": 4 * 1024,
  "revoked.json": 1024,
} as const;
const idPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const itemPattern = /^[a-z0-9_.:/-]{1,128}$/;
const utf8 = new TextDecoder("utf-8", { fatal: true });

export interface MacroBasis {
  readonly run: string;
  readonly life: number;
  readonly tick: number;
  readonly epoch: number;
}

export interface MacroOpportunity {
  readonly id: string;
  readonly verb: string;
  readonly summary: string;
  readonly risk: "read" | "low" | "guarded";
  readonly evidence: string;
}

export interface MacroObservation extends MacroBasis {
  readonly v: 1;
  readonly goal: string;
  readonly health: number;
  readonly food: number;
  readonly inventory: Readonly<Record<string, number>>;
  readonly opportunities: readonly MacroOpportunity[];
  readonly recent: readonly string[];
  readonly quiescent: boolean;
}

export interface MacroIntent {
  readonly v: 1;
  readonly id: string;
  readonly run: string;
  readonly life: number;
  readonly epoch: number;
  readonly basisTick: number;
  readonly expiresTick: number;
  readonly opportunityId: string;
  readonly skillHash: string | null;
}

export type MacroHandoff = Pick<MacroIntent, "v" | "run" | "life" | "epoch" | "basisTick" | "expiresTick">;

/** Host-owned notice; grants no authority to act, pause safety, or renew native idle time. */
export type MacroPlanning = Pick<MacroIntent, "v" | "run" | "life" | "epoch" | "basisTick" | "id">;

export interface MacroReceipt {
  readonly v: 1;
  readonly id: string;
  readonly run: string;
  readonly life: number;
  readonly tick: number;
  readonly status: "accepted" | "completed" | "refused" | "interrupted";
  readonly detail: string;
}

export interface MacroSkillReceipt {
  readonly tick: number;
  readonly verb: string;
  readonly status: "completed";
  readonly detail: string;
}

export interface MacroSkillCandidate {
  readonly source: string;
  readonly parentGeneration: number;
  readonly verbs: readonly string[];
}

const NATIVE_REVIEW_PACKAGE = "java/io/gameharness/survival";
const NATIVE_REVIEW_CLIENT = `survival-agent/src/client/${NATIVE_REVIEW_PACKAGE}`;
export const NATIVE_REVIEW_PUBLIC_PATHS = [
  `${NATIVE_REVIEW_CLIENT}/AgentCraftClick.java`,
  `${NATIVE_REVIEW_CLIENT}/mixin/AgentHandledScreenAccess.java`,
  `${NATIVE_REVIEW_CLIENT}/mixin/AgentMouseAccess.java`,
] as const;
export const NATIVE_REVIEW_NEW_SOURCE = `${NATIVE_REVIEW_CLIENT}/AgentCapabilityProposal.java`;
export const NATIVE_REVIEW_TEST_PATH = `survival-agent/src/test/${NATIVE_REVIEW_PACKAGE}/AgentCapabilityProposalTest.java`;
export const NATIVE_REVIEW_PATHS = [...NATIVE_REVIEW_PUBLIC_PATHS, NATIVE_REVIEW_NEW_SOURCE, NATIVE_REVIEW_TEST_PATH] as const;
export const NATIVE_REVIEW_MAX_FILE_BYTES = 8 * 1024;
export const NATIVE_REVIEW_MAX_BYTES = 10 * 1024;

export interface MacroReviewPatch {
  readonly baseVersion: string;
  readonly baseSha256: string;
  readonly scope: string;
  readonly files: readonly { readonly path: string; readonly content: string }[];
}

export interface MacroReviewContext {
  readonly baseVersion: string;
  readonly baseSha256: string;
  readonly source: readonly { readonly path: string; readonly sha256: string; readonly content: string }[];
  readonly newSourcePath: string;
  readonly testPath: string;
}

export interface MacroProposal {
  readonly subgoal: string;
  readonly reason: string;
  readonly successCondition: string;
  readonly contingency: string;
  readonly alternative: string;
  readonly expiresTick: number;
  readonly action:
    | { readonly kind: "opportunity"; readonly opportunityId: string }
    | { readonly kind: "skill"; readonly candidate: MacroSkillCandidate }
    | { readonly kind: "tested-skill"; readonly skillHash: string }
    | { readonly kind: "selected-skill" }
    | { readonly kind: "gap"; readonly capability: string; readonly suggestion?: string; readonly reviewPatch?: MacroReviewPatch }
    | { readonly kind: "abstain" };
}

export interface MacroFrame {
  readonly source: "verified-game-display";
  readonly run: string;
  readonly life: number;
  readonly epoch: number;
  readonly tick: number;
  readonly mimeType: "image/png" | "image/jpeg";
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
  /** Private supervisor custody. Removed before the frame is sent to a strategist. */
  readonly artifact?: {
    readonly relativePath: string;
    readonly sha256: string;
    readonly discard?: () => Promise<void>;
  };
}

export type MacroTrigger = "first" | "premise" | "progress" | "receipt" | "risk" | "stuck";

export interface MacroFeedback {
  readonly kind: string;
  readonly detail: string;
}

export const MACRO_NOT_ISSUED_DISPOSITIONS = [
  "stale", "native_capability_gap", "proposal_refused", "duplicate_intent_refused",
  "skill_rejected", "skill_abstained", "skill_unavailable", "skill_promotion_refused", "unproven_skill_effect_refused",
] as const;

export type MacroEpisodeOutcome =
  | { readonly source: "native"; readonly status: Exclude<MacroReceipt["status"], "accepted">;
    readonly id: string; readonly tick: number; readonly verb: string; readonly summary: string; readonly detail: string }
  | { readonly source: "host"; readonly status: "not-issued"; readonly disposition: typeof MACRO_NOT_ISSUED_DISPOSITIONS[number] }
  | { readonly source: "host"; readonly status: "withdrawn"; readonly id: string; readonly tick: number;
    readonly verb: string; readonly summary: string };

export interface MacroStrategicEpisode {
  /** Original model decision; native outcome IDs refer to individual intents, not opportunity IDs. */
  readonly requestId: string;
  readonly basis: MacroBasis;
  readonly hypothesis: { readonly subgoal: string; readonly expected: string };
  /** The terminal native receipt establishes only the primitive's report. */
  readonly objectiveStatus: "not-evaluated";
  readonly outcome: MacroEpisodeOutcome;
}

export interface MacroRequest {
  readonly observation: MacroObservation;
  readonly objective?: string;
  readonly trigger: MacroTrigger;
  readonly lastReceipt: MacroReceipt | null;
  readonly feedback?: MacroFeedback;
  /** Same-life, same-goal history; newest first, at most MACRO_MAX_STRATEGIC_EPISODES. Never actionable. */
  readonly strategicEpisodes?: readonly MacroStrategicEpisode[];
  readonly capabilitiesVersion: string;
  readonly skillGeneration: number | null;
  readonly skillVerbs?: readonly string[];
  readonly selectedSkillHash?: string;
  readonly testedSkills?: readonly { readonly hash: string; readonly verb: string }[];
  readonly nativeReview?: MacroReviewContext;
  readonly maxSkillEffects?: number;
  readonly maxResponseBytes: number;
  readonly maxIntentTtlTicks: number;
  readonly maxPlanTtlTicks: number;
  readonly frame?: MacroFrame;
}

export interface MacroUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
}

export interface MacroInference {
  readonly proposal: unknown;
  readonly model: string;
  readonly basis: MacroBasis;
  readonly usage: MacroUsage | null;
  readonly costUsd: number | null;
  readonly outcome: "completed" | "refused" | "invalid" | "cancelled" | "provider_error" | "provider_unavailable" | "stale";
  readonly latencyMs?: number;
  readonly frameSha256?: string;
  readonly dispatched?: boolean;
}

export type MacroStrategist = (request: MacroRequest, signal: AbortSignal) => Promise<MacroInference>;

function invalid(field: string): never {
  throw new Error(`Invalid survival macro field: ${field}.`);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(field);
  return value as Record<string, unknown>;
}

function shape(value: unknown, field: string, required: readonly string[], optional: readonly string[] = []) {
  const record = object(value, field);
  if (required.some(key => !Object.hasOwn(record, key)) ||
      Object.keys(record).some(key => !required.includes(key) && !optional.includes(key))) invalid(field);
  return record;
}

function whole(value: unknown, field: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) invalid(field);
  return value;
}

function finite(value: unknown, field: string, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) invalid(field);
  return value;
}

function text(value: unknown, field: string, max: number, multiline = false): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > max ||
      (multiline ? /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/ : /[\x00-\x1F\x7F]/).test(value)) invalid(field);
  return value;
}

export function validateMacroId(value: unknown, field: string): string {
  if (typeof value !== "string" || !idPattern.test(value) || value === "." || value === "..") invalid(field);
  return value;
}

function version(value: unknown): 1 {
  if (value !== 1) invalid("v");
  return 1;
}

function choice<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) invalid(field);
  return value as T;
}

function bounds(value: unknown, field: string, max: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid(field);
  return value;
}

function basis(record: Record<string, unknown>): MacroBasis {
  return {
    run: validateMacroId(record.run, "run"), life: whole(record.life, "life", 1, 2_147_483_647),
    tick: whole(record.tick, "tick", 1), epoch: whole(record.epoch, "epoch", 1),
  };
}

export function parseMacroObservation(value: unknown): MacroObservation {
  const record = shape(value, "observation", [
    "v", "run", "life", "tick", "epoch", "goal", "health", "food", "inventory", "opportunities", "recent", "quiescent",
  ]);
  const inventory = Object.create(null) as Record<string, number>;
  const entries = Object.entries(object(record.inventory, "inventory"));
  if (entries.length > 128) invalid("inventory");
  for (const [item, count] of entries) {
    if (!itemPattern.test(item) || item === "__proto__" || item === "constructor" || item === "prototype") invalid("inventory item");
    inventory[item] = whole(count, "inventory count", 0, 65_535);
  }
  const ids = new Set<string>();
  const opportunities = bounds(record.opportunities, "opportunities", 64).map(value => {
    const offer = shape(value, "opportunity", ["id", "verb", "summary", "risk", "evidence"]);
    const id = validateMacroId(offer.id, "opportunity id");
    if (ids.has(id)) invalid("duplicate opportunity id");
    ids.add(id);
    return Object.freeze({
      id, verb: validateMacroId(offer.verb, "verb"), summary: text(offer.summary, "summary", 512),
      risk: choice(offer.risk, "risk", ["read", "low", "guarded"] as const),
      evidence: text(offer.evidence, "evidence", 512),
    });
  });
  if (typeof record.quiescent !== "boolean") invalid("quiescent");
  return Object.freeze({
    v: version(record.v), ...basis(record), goal: text(record.goal, "goal", 256),
    health: finite(record.health, "health", 1_024), food: whole(record.food, "food", 0, 20),
    inventory: Object.freeze(inventory), opportunities: Object.freeze(opportunities),
    recent: Object.freeze(bounds(record.recent, "recent", 32).map(entry => text(entry, "recent entry", 512))),
    quiescent: record.quiescent,
  });
}

export function parseMacroIntent(value: unknown): MacroIntent {
  const record = shape(value, "intent", [
    "v", "id", "run", "life", "epoch", "basisTick", "expiresTick", "opportunityId", "skillHash",
  ]);
  const basisTick = whole(record.basisTick, "basisTick", 1, Number.MAX_SAFE_INTEGER - MACRO_MAX_INTENT_TTL_TICKS);
  if (record.skillHash !== null && (typeof record.skillHash !== "string" || !hashPattern.test(record.skillHash))) invalid("skillHash");
  return Object.freeze({
    v: version(record.v), id: validateMacroId(record.id, "intent id"), run: validateMacroId(record.run, "run"),
    life: whole(record.life, "life", 1, 2_147_483_647), epoch: whole(record.epoch, "epoch", 1), basisTick,
    expiresTick: whole(record.expiresTick, "expiresTick", basisTick + 1, basisTick + MACRO_MAX_INTENT_TTL_TICKS),
    opportunityId: validateMacroId(record.opportunityId, "opportunity id"), skillHash: record.skillHash,
  });
}

export function parseMacroHandoff(value: unknown): MacroHandoff {
  const record = shape(value, "handoff", ["v", "run", "life", "epoch", "basisTick", "expiresTick"]);
  const basisTick = whole(record.basisTick, "basisTick", 1, Number.MAX_SAFE_INTEGER - MACRO_MAX_INTENT_TTL_TICKS);
  return {
    v: version(record.v), run: validateMacroId(record.run, "run"), life: whole(record.life, "life", 1, 2_147_483_647),
    epoch: whole(record.epoch, "epoch", 1), basisTick,
    expiresTick: whole(record.expiresTick, "expiresTick", basisTick + 1, basisTick + MACRO_MAX_HANDOFF_TTL_TICKS),
  };
}

export function parseMacroPlanning(value: unknown): MacroPlanning {
  const record = shape(value, "planning", ["v", "run", "life", "epoch", "basisTick", "id"]);
  return {
    v: version(record.v), run: validateMacroId(record.run, "run"), life: whole(record.life, "life", 1, 2_147_483_647),
    epoch: whole(record.epoch, "epoch", 1), basisTick: whole(record.basisTick, "basisTick", 1),
    id: validateMacroId(record.id, "planning request id"),
  };
}

export function parseMacroReceipt(value: unknown): MacroReceipt {
  const record = shape(value, "receipt", ["v", "id", "run", "life", "tick", "status", "detail"]);
  return Object.freeze({
    v: version(record.v), id: validateMacroId(record.id, "receipt id"), run: validateMacroId(record.run, "run"),
    life: whole(record.life, "life", 1, 2_147_483_647), tick: whole(record.tick, "tick", 1),
    status: choice(record.status, "receipt status", ["accepted", "completed", "refused", "interrupted"] as const),
    detail: text(record.detail, "receipt detail", 1_024),
  });
}

export function parseMacroRevocation(value: unknown): MacroBasis {
  const record = shape(value, "native revocation", ["v", "run", "life", "tick", "epoch"]);
  version(record.v);
  return basis(record);
}

export function parseMacroReviewPatch(value: unknown): MacroReviewPatch {
  const patch = shape(value, "review patch", ["baseVersion", "baseSha256", "scope", "files"]);
  if (typeof patch.baseVersion !== "string" || !/^[A-Za-z0-9._:/-]{1,128}$/.test(patch.baseVersion)) invalid("review base version");
  if (typeof patch.baseSha256 !== "string" || !hashPattern.test(patch.baseSha256)) invalid("review base digest");
  const scope = text(patch.scope, "review scope", 1024);
  if (/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(scope)) invalid("review scope");
  const paths = new Set<string>();
  let totalBytes = 0;
  const files = bounds(patch.files, "review files", NATIVE_REVIEW_PATHS.length).map(value => {
    const file = shape(value, "review file", ["path", "content"]);
    const path = choice(file.path, "review file path", NATIVE_REVIEW_PATHS);
    if (paths.has(path)) invalid("duplicate review file");
    paths.add(path);
    const content = text(file.content, "review file content", NATIVE_REVIEW_MAX_FILE_BYTES, true);
    // Printable ASCII and exact LF endings keep the review diff visually unambiguous.
    if (/[^\x20-\x7e\n\t]/.test(content) || !content.endsWith("\n")) invalid("review file content");
    totalBytes += content.length;
    return Object.freeze({ path, content });
  });
  if (paths.size < 2 || !paths.has(NATIVE_REVIEW_TEST_PATH)) invalid("review code and test files");
  if (totalBytes > NATIVE_REVIEW_MAX_BYTES) invalid("review file byte limit");
  return Object.freeze({ baseVersion: patch.baseVersion, baseSha256: patch.baseSha256, scope, files: Object.freeze(files) });
}

export function parseMacroProposal(value: unknown): MacroProposal {
  const record = shape(value, "proposal", [
    "subgoal", "reason", "successCondition", "contingency", "alternative", "expiresTick", "action",
  ]);
  const rawAction = object(record.action, "action");
  const kind = choice(rawAction.kind, "action kind", ["opportunity", "skill", "tested-skill", "selected-skill", "gap", "abstain"] as const);
  let action: MacroProposal["action"];
  switch (kind) {
    case "opportunity":
      shape(rawAction, "opportunity action", ["kind", "opportunityId"]);
      action = { kind, opportunityId: validateMacroId(rawAction.opportunityId, "opportunity id") };
      break;
    case "skill": {
      shape(rawAction, "skill action", ["kind", "candidate"]);
      const candidate = shape(rawAction.candidate, "candidate", ["source", "parentGeneration", "verbs"]);
      const verbs = bounds(candidate.verbs, "candidate verbs", 8).map(verb => validateMacroId(verb, "candidate verb"));
      if (!verbs.length || new Set(verbs).size !== verbs.length) invalid("candidate verbs");
      action = { kind, candidate: Object.freeze({
        source: text(candidate.source, "candidate source", 8 * 1024, true),
        parentGeneration: whole(candidate.parentGeneration, "parent generation"),
        verbs: Object.freeze(verbs),
      }) };
      break;
    }
    case "gap":
      shape(rawAction, "capability gap", ["kind", "capability"], ["suggestion", "reviewPatch"]);
      action = { kind, capability: text(rawAction.capability, "capability gap", 512),
        ...(Object.hasOwn(rawAction, "suggestion") ? { suggestion: text(rawAction.suggestion, "review suggestion", 4 * 1024, true) } : {}),
        ...(Object.hasOwn(rawAction, "reviewPatch") ? { reviewPatch: parseMacroReviewPatch(rawAction.reviewPatch) } : {}),
      };
      break;
    case "selected-skill":
    case "abstain":
      shape(rawAction, kind, ["kind"]);
      action = { kind };
      break;
    case "tested-skill":
      shape(rawAction, kind, ["kind", "skillHash"]);
      if (typeof rawAction.skillHash !== "string" || !hashPattern.test(rawAction.skillHash)) invalid("skillHash");
      action = { kind, skillHash: rawAction.skillHash };
      break;
  }
  return Object.freeze({
    subgoal: text(record.subgoal, "subgoal", 512), reason: text(record.reason, "reason", 1_024),
    successCondition: text(record.successCondition, "success condition", 512),
    contingency: text(record.contingency, "contingency", 512), alternative: text(record.alternative, "alternative", 512),
    expiresTick: whole(record.expiresTick, "proposal expiry", 1), action: Object.freeze(action),
  });
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/** Use the opened Linux directory, not a string which can be retargeted during IPC. */
export class MacroDirectory {
  private constructor(private readonly handle: FileHandle) {}

  static async open(directory: string): Promise<MacroDirectory> {
    if (process.platform !== "linux" || !isAbsolute(directory)) throw new Error("Macro IPC requires a private absolute Linux directory.");
    const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isDirectory() || info.uid !== process.getuid!() || (info.mode & 0o777) !== 0o700) {
        throw new Error("Macro IPC directory is not private.");
      }
      return new MacroDirectory(handle);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.handle.close();
  }

  private entry(name: string): string {
    if (!/^[A-Za-z0-9.-]{1,96}$/.test(name) || name === "." || name === "..") throw new Error("Invalid macro IPC entry name.");
    return `/proc/self/fd/${this.handle.fd}/${name}`;
  }

  async read<T>(name: keyof typeof FILE_BYTES, parse: (value: unknown) => T): Promise<T | null> {
    let file: FileHandle;
    try {
      file = await open(this.entry(name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    try {
      const info = await file.stat();
      const max = FILE_BYTES[name];
      if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid!() || (info.mode & 0o022) !== 0 ||
          info.size < 1 || info.size > max) throw new Error(`Invalid macro IPC file: ${name}.`);
      const bytes = Buffer.allocUnsafe(info.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length !== info.size) throw new Error(`Macro IPC file changed during read: ${name}.`);
      return parse(JSON.parse(utf8.decode(bytes.subarray(0, length))));
    } finally {
      await file.close();
    }
  }

  async write(name: "active.json" | "intent.json" | "handoff.json" | "planning.json", value: unknown): Promise<void> {
    const content = JSON.stringify(value) + "\n";
    if (Buffer.byteLength(content) > FILE_BYTES[name]) throw new Error(`Macro IPC output exceeds cap: ${name}.`);
    const partial = `.tmp-${randomUUID()}` as const;
    const temporary = this.entry(partial);
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      try { await file.writeFile(content); } finally { await file.close(); }
      // The mailbox is one pending item: never silently replace one already present.
      await link(temporary, this.entry(name));
    } finally {
      await this.remove(partial);
    }
  }

  async remove(name: "active.json" | "intent.json" | "handoff.json" | "planning.json" | `.tmp-${string}`): Promise<void> {
    try { await unlink(this.entry(name)); } catch (error) { if (!missing(error)) throw error; }
  }

  async createLog(name: "history.jsonl" | "proposals.jsonl" | "receipts.jsonl"): Promise<FileHandle> {
    return open(this.entry(name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  }

  /** The producer may be appending a line as we read. Only complete lines advance the cursor. */
  async readNativeReceiptLines(cursor: NativeReceiptCursor | null, maxBytes: number): Promise<NativeReceiptBatch | null> {
    let file: FileHandle;
    try {
      file = await open(this.entry("native-receipts.jsonl"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (missing(error) && cursor === null) return null;
      throw error;
    }
    try {
      const info = await file.stat({ bigint: true });
      const offset = cursor?.offset ?? 0;
      if (!info.isFile() || info.nlink !== 1n || info.uid !== BigInt(process.getuid!()) || (info.mode & 0o022n) !== 0n ||
          info.size < BigInt(offset) || info.size > BigInt(maxBytes) ||
          (cursor !== null && (info.dev !== cursor.device || info.ino !== cursor.inode))) {
        throw new Error("Invalid native macro receipt journal.");
      }
      const available = Number(info.size) - offset;
      const count = Math.min(16 * 1024, available);
      const bytes = Buffer.allocUnsafe(count);
      let filled = 0;
      while (filled < count) {
        const { bytesRead } = await file.read(bytes, filled, count - filled, offset + filled);
        if (bytesRead === 0) throw new Error("Native macro receipt journal was truncated.");
        filled += bytesRead;
      }
      const receipts: MacroReceipt[] = [];
      let start = 0;
      for (let end = bytes.indexOf(0x0a); end >= 0; end = bytes.indexOf(0x0a, start)) {
        if (end === start || end - start > FILE_BYTES["receipt.json"]) throw new Error("Invalid native macro receipt line.");
        receipts.push(parseMacroReceipt(JSON.parse(utf8.decode(bytes.subarray(start, end)))));
        start = end + 1;
      }
      if ((count === available || !start) && count - start > FILE_BYTES["receipt.json"]) {
        throw new Error("Native macro receipt line exceeds cap.");
      }
      return { cursor: { device: info.dev, inode: info.ino, offset: offset + start }, receipts,
        more: count < available, partial: count === available && count > start };
    } finally {
      await file.close();
    }
  }
}

export interface NativeReceiptCursor {
  readonly device: bigint;
  readonly inode: bigint;
  readonly offset: number;
}

interface NativeReceiptBatch {
  readonly cursor: NativeReceiptCursor;
  readonly receipts: readonly MacroReceipt[];
  readonly more: boolean;
  readonly partial: boolean;
}

async function withMacroDirectory<T>(directory: string, use: (ipc: MacroDirectory) => Promise<T>): Promise<T> {
  const ipc = await MacroDirectory.open(directory);
  try { return await use(ipc); } finally { await ipc.close(); }
}

export function readMacroObservation(directory: string): Promise<MacroObservation | null> {
  return withMacroDirectory(directory, ipc => ipc.read("observation.json", parseMacroObservation));
}

export function readMacroReceipt(directory: string): Promise<MacroReceipt | null> {
  return withMacroDirectory(directory, ipc => ipc.read("receipt.json", parseMacroReceipt));
}

export function writeMacroIntent(directory: string, intent: MacroIntent): Promise<void> {
  return withMacroDirectory(directory, ipc => ipc.write("intent.json", parseMacroIntent(intent)));
}
