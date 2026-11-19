import { Database } from "bun:sqlite";
import { Buffer } from "node:buffer";
import { createHash, randomInt, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { parse } from "acorn";
import { analyze as analyzeScopes } from "eslint-scope";
import type { Json } from "../../shared/contracts.ts";
import { singletonExecutableModuleBundle } from "../../shared/program-modules.ts";
import type { ResidentAnalysisWorker } from "../../shared/resident.ts";
import { residentWorkerFailure } from "../resident-worker-fault.ts";
import { ResidentWorkerCleanupFault, SandboxService } from "../sandbox.ts";
import {
  MACRO_MAX_INTENT_TTL_TICKS, type MacroIntent, type MacroObservation, type MacroOpportunity, type MacroReceipt,
  type MacroSkillCandidate, type MacroSkillReceipt,
} from "./protocol.ts";
import { macroTrialWitnessDigest, type MacroTrialTarget, type MacroTrialWitness } from "./trial-witness.ts";

export const MACRO_SKILL_LIMITS = Object.freeze({
  sourceBytes: 8_192, candidates: 12, observationBytes: 32_768, evaluationMs: 150, operationMs: 45_000,
  previousReceipts: 2,
});
// A bounded move can still pick up an item. Only camera-only actions have
// sufficient side-effect evidence for automatic scope.
export const MACRO_AUTOMATIC_SKILL_VERBS = Object.freeze(["survey", "inspect"] as const);
const automaticVerbs = new Set<string>(MACRO_AUTOMATIC_SKILL_VERBS);
const digestPattern = /^[a-f0-9]{64}$/;
const digest = (source: string) => createHash("sha256").update(source, "utf8").digest("hex");
const boundedText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= max;

export interface MacroSkillProposal {
  readonly opportunityId: string;
  readonly skillHash: string;
  readonly generation: number;
  readonly basisDigest: string;
}
export interface MacroSkillTrialBinding {
  skillHash: string;
  parentGeneration: number;
  parentHash: string | null;
  capabilityVersion: string;
  adapterVersion: string;
  actorJarSha256: string;
  worldId: string;
  verbs: readonly string[];
}
export interface MacroSkillTrialAttestation extends MacroSkillTrialBinding {
  run: string;
  life: number;
  epoch: number;
  basisTick: number;
  intentId: string;
  opportunityId: string;
  verb: string;
  risk: MacroOpportunity["risk"];
  evidence: string;
  acceptedTick: number;
  target: MacroTrialTarget;
  targetDigest: string;
  receiptTick: number;
  effectRef: string;
}
export interface MacroSkillSelection {
  generation: number;
  hash: string | null;
}
export interface SurvivalMacroSkillOptions {
  /** Private host-owned directory, never mounted in the source worker. */
  directory: string;
  projectRoot: string;
  /** Identity of the ordinary run; diagnostic run identities must differ. */
  worldId: string;
  capabilityVersion: string;
  adapterVersion: string;
  actorJarSha256: string;
  lowRiskVerbs: readonly string[];
  /** In-process proof reader owned by the trusted diagnostic scheduler, not a file from the actor/model. */
  readTrial: (binding: MacroSkillTrialBinding) => MacroSkillTrialAttestation | null;
  /** Synchronous host fence for the latest fresh native projection and no pending control. */
  isNeutralHandoff: (observation: MacroObservation) => boolean;
}

type SkillState = "draft" | "validated" | "trial" | "active" | "retired" | "quarantined";
interface SkillRow {
  hash: string;
  source: string;
  verbs: string;
  parent_generation: number;
  parent_hash: string | null;
  state: SkillState;
  shadowed: -1 | 0 | 1;
  trial_world: string | null;
  trial_probe: string | null;
  trial_intent: string | null;
  trial_witness: string | null;
}
interface TrialProbe {
  tick: number;
  basisDigest: string;
  offer: MacroOpportunity;
}
interface BoundTrialWitness {
  witness: MacroTrialWitness;
  terminal: MacroReceipt;
}
interface ShadowWitness {
  tick: number;
  basisDigest: string;
  offer: MacroOpportunity;
}
interface SkillEvaluation {
  basisDigest: string;
  offer: MacroOpportunity | null;
}
class InvalidSource extends Error {}
class SandboxUnavailable extends Error {}

// No top-level state, imports, asynchronous instructions or unbound names other than these
// deterministic data intrinsics. The externally watched Docker realm, not the parser, is isolation.
const intrinsics = new Set([
  "Object", "Array", "Boolean", "Number", "String", "Map", "Set", "JSON",
  "undefined", "NaN", "Infinity", "isFinite", "isNaN", "parseInt", "parseFloat",
]);
const forbiddenSyntax = new Set([
  "ImportDeclaration", "ImportExpression", "ExportDefaultDeclaration", "ExportAllDeclaration",
  "MetaProperty", "ThisExpression", "Super", "WithStatement", "AwaitExpression", "YieldExpression",
  "ClassDeclaration", "ClassExpression", "DebuggerStatement",
]);
const prototypeKeys = new Set(["constructor", "__proto__", "prototype"]);
type Node = { type: string; [key: string]: unknown };
function node(value: unknown): Node | undefined {
  if (value && typeof value === "object" && "type" in value && typeof value.type === "string") return value as Node;
}
function checkSource(source: string): void {
  const ast = parse(source, { ecmaVersion: 2025, sourceType: "module", ranges: true });
  const statements = ast.body.map(statement => node(statement)!);
  const exports = statements.filter(statement => statement.type === "ExportNamedDeclaration");
  const entry = node(exports[0]?.declaration);
  const params = entry?.params;
  if (exports.length !== 1 || entry?.type !== "FunctionDeclaration" || node(entry.id)?.name !== "analyze" ||
      !Array.isArray(params) || params.length !== 1 || node(params[0])?.type !== "Identifier" ||
      statements.some(statement => statement !== exports[0] && statement.type !== "FunctionDeclaration"))
    throw new InvalidSource("expected one synchronous export function analyze(observation)");
  const stack: { item: Node; depth: number }[] = [{ item: node(ast)!, depth: 0 }];
  let visited = 0;
  while (stack.length) {
    const { item, depth } = stack.pop()!;
    if (++visited > 1_500 || depth > 40) throw new InvalidSource("static complexity limit");
    if (forbiddenSyntax.has(item.type) ||
        (item.type.endsWith("FunctionExpression") || item.type === "FunctionDeclaration") && (item.async || item.generator))
      throw new InvalidSource("syntax outside the pure selector interface");
    if (item.type === "MemberExpression" || item.type === "Property") {
      const key = node(item.type === "MemberExpression" ? item.property : item.key);
      if (prototypeKeys.has(String(key?.value ?? (!item.computed ? key?.name : ""))))
        throw new InvalidSource("prototype access outside the pure selector interface");
    }
    for (const value of Object.values(item)) {
      if (Array.isArray(value)) {
        for (const element of value) {
          const child = node(element);
          if (child) stack.push({ item: child, depth: depth + 1 });
        }
      } else {
        const child = node(value);
        if (child) stack.push({ item: child, depth: depth + 1 });
      }
    }
  }
  const scope = analyzeScopes(ast as unknown as Parameters<typeof analyzeScopes>[0], {
    ecmaVersion: 2025, sourceType: "module",
  });
  if (!scope.globalScope || scope.globalScope.through.some(ref => !intrinsics.has(ref.identifier.name)))
    throw new InvalidSource("ambient name outside the pure selector interface");
}

type SkillObservation = Omit<MacroObservation, "run" | "tick"> & {
  readonly previousReceipts: readonly MacroSkillReceipt[];
};
function project(observation: MacroObservation, receipts: readonly MacroSkillReceipt[]): SkillObservation {
  const inventory = Object.entries(observation.inventory).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return {
    v: observation.v, life: observation.life, epoch: observation.epoch,
    goal: observation.goal, health: observation.health, food: observation.food,
    inventory: Object.fromEntries(inventory),
    opportunities: observation.opportunities.map(({ id, verb, summary, risk, evidence }) => ({ id, verb, summary, risk, evidence })),
    recent: [...observation.recent], quiescent: observation.quiescent,
    previousReceipts: receipts.map(({ tick, verb, status, detail }) => ({ tick, verb, status, detail })),
  };
}
function inputDigest(observation: SkillObservation): string {
  return digest(JSON.stringify(observation));
}
function validReceipts(receipts: readonly MacroSkillReceipt[], currentTick: number, verb: string): boolean {
  if (!Array.isArray(receipts) || receipts.length > MACRO_SKILL_LIMITS.previousReceipts) return false;
  let previous = -1;
  for (const receipt of receipts) {
    if (!receipt || !Number.isSafeInteger(receipt.tick) || receipt.tick <= previous || receipt.tick > currentTick ||
        receipt.verb !== verb || receipt.status !== "completed" || !boundedText(receipt.detail, 1024) ||
        /[\x00-\x1f\x7f]/.test(receipt.detail)) return false;
    previous = receipt.tick;
  }
  return true;
}
function readVerbs(row: SkillRow): string[] {
  return JSON.parse(row.verbs) as string[];
}
function verifiedVerb(row: SkillRow): string | null {
  if (!row.trial_witness) return null;
  const { witness } = JSON.parse(row.trial_witness) as BoundTrialWitness;
  return automaticVerbs.has(witness.verb) && readVerbs(row).includes(witness.verb) ? witness.verb : null;
}
function permitted(offer: MacroOpportunity, verbs: readonly string[]): boolean {
  return offer.risk === "read" && verbs.includes(offer.verb);
}
function offered(raw: Json, observation: SkillObservation, verbs: readonly string[]): MacroOpportunity | null {
  if (raw === null) return null;
  if (!boundedText(raw, 256)) throw new InvalidSource("selector result must be an offered ID or null");
  const matches = observation.opportunities.filter(({ id }) => raw === id);
  const result = matches[0];
  if (matches.length !== 1 || !result || !permitted(result, verbs))
    throw new InvalidSource("selector returned an unavailable or unauthorized opportunity");
  return result;
}

/** Offline gates are independent of candidate logic, with fresh held-out IDs and offer order. */
function offlineObservations(verbs: readonly string[]): { input: SkillObservation; allowed: readonly string[] }[] {
  const opportunity = (verb: string, risk: MacroOpportunity["risk"], summary: string): MacroOpportunity =>
    ({ id: randomUUID(), verb, summary, risk, evidence: randomUUID() });
  const observation = (goal: string, opportunities: MacroOpportunity[], health = 20,
    previousReceipts: readonly MacroSkillReceipt[] = []): SkillObservation =>
    ({ v: 1, life: 2, epoch: 11, goal, health, food: 17, inventory: { "minecraft:torch": 3 },
      opportunities, recent: [], quiescent: health > 8, previousReceipts });
  const possible = verbs.map(verb => opportunity(verb, "read", "A witnessed dry clearing."));
  const guarded = opportunity(verbs[0]!, "guarded", "Do not proceed at this hazardous edge.");
  const unsupported = opportunity("break", "low", "Obtain the exposed block.");
  const shuffle = (options: MacroOpportunity[]) => {
    for (let i = options.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [options[i], options[j]] = [options[j]!, options[i]!];
    }
    return options;
  };
  const base = [
    observation("Pause until a new safe opportunity is visible.", [], 4),
    observation("Cross the ledge without risking a fall.", [guarded], 7),
    observation("Find a route to the stone shelf.", [unsupported]),
    observation("Choose a cheap view of the next route.", shuffle([...possible, unsupported])),
    observation("Look for a way around instead of approaching the ledge.", shuffle([
      guarded, ...possible.map(option => ({ ...option, id: randomUUID(), evidence: randomUUID() })),
    ])),
  ].map(input => ({ input, allowed: verbs }));
  for (const verb of verbs) {
    const completed = { tick: 113, verb, status: "completed" as const, detail: "The requested view is now witnessed." };
    const alternate = verb === "inspect" ? "survey" : "inspect";
    base.push(
      { allowed: [verb], input: observation("Continue only within the proven observation capability.",
        [opportunity(alternate, "read", "A different opportunity is visible."), unsupported], 17, [completed]) },
      { allowed: [verb], input: observation("Inspect the newly visible route or hold.",
        shuffle([opportunity(verb, "read", "The area beyond the original view is now visible."), unsupported]), 18,
        [completed, { ...completed, tick: 156, detail: "The second view has settled." }]) },
    );
  }
  return base;
}

function privateDatabase(directory: string): Database {
  mkdirSync(directory, { mode: 0o700, recursive: true });
  const uid = process.getuid?.();
  const directoryInfo = lstatSync(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.uid !== uid || (directoryInfo.mode & 0o077) !== 0)
    throw new Error("Macro skill storage must be a private host-owned directory.");
  const filename = join(directory, "skill-selection.sqlite");
  const fd = openSync(filename, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== uid || info.nlink !== 1 || (info.mode & 0o077) !== 0)
      throw new Error("Macro skill storage must be a private host-owned file.");
  } finally { closeSync(fd); }
  return new Database(filename, { strict: true });
}

/** Authored source has no effect channel. Only validated offered-ID proposals leave the worker. */
export class SurvivalMacroSkills {
  readonly #db: Database;
  readonly #sandbox: SandboxService;
  readonly #options: Readonly<SurvivalMacroSkillOptions>;
  readonly #stop = new AbortController();
  readonly #shadowWitnesses = new Map<string, ShadowWitness>();
  readonly #activeProposals = new WeakMap<MacroSkillProposal, number>();
  #flight: Promise<unknown> | null = null;
  #closing: Promise<void> | null = null;
  #sandboxFailed = false;

  constructor(options: SurvivalMacroSkillOptions) {
    const verbs = [...new Set(options.lowRiskVerbs)].sort();
    if (verbs.some(verb => !automaticVerbs.has(verb)) || !boundedText(options.worldId, 256) ||
        !boundedText(options.capabilityVersion, 256) || !boundedText(options.adapterVersion, 256) ||
        !digestPattern.test(options.actorJarSha256))
      throw new Error("Invalid survival macro skill authority.");
    this.#options = Object.freeze({ ...options, lowRiskVerbs: Object.freeze(verbs) });
    this.#sandbox = new SandboxService(options.projectRoot);
    this.#db = privateDatabase(options.directory);
    try {
      this.#db.exec(`PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0;
        CREATE TABLE IF NOT EXISTS policy (id INTEGER PRIMARY KEY CHECK (id=1), identity TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS skills (
          hash TEXT PRIMARY KEY, source TEXT NOT NULL, verbs TEXT NOT NULL,
          parent_generation INTEGER NOT NULL, parent_hash TEXT REFERENCES skills(hash),
          state TEXT NOT NULL CHECK(state IN ('draft','validated','trial','active','retired','quarantined')),
          shadowed INTEGER NOT NULL DEFAULT 0, trial_world TEXT UNIQUE, trial_probe TEXT,
          trial_intent TEXT, trial_witness TEXT
        );
        CREATE TABLE IF NOT EXISTS selection (generation INTEGER PRIMARY KEY, hash TEXT REFERENCES skills(hash));
        CREATE TABLE IF NOT EXISTS history (
          seq INTEGER PRIMARY KEY, at_ms INTEGER NOT NULL, hash TEXT REFERENCES skills(hash), event TEXT NOT NULL, detail TEXT NOT NULL
        );`);
      const identity = JSON.stringify([2, options.worldId, options.capabilityVersion, options.adapterVersion, options.actorJarSha256, verbs]);
      this.#db.transaction(() => {
        this.#db.run("INSERT OR IGNORE INTO policy VALUES (1,?)", [identity]);
        const pinned = this.#db.query<{ identity: string }, []>("SELECT identity FROM policy WHERE id=1").get();
        if (pinned?.identity !== identity) throw new Error("Existing skill selection is pinned to another run or authority.");
        this.#db.run("INSERT OR IGNORE INTO selection VALUES (0,NULL)");
      }).immediate();
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  selection(): MacroSkillSelection {
    const selection = this.#db.query<MacroSkillSelection, []>("SELECT generation,hash FROM selection ORDER BY generation DESC LIMIT 1").get();
    if (!selection) throw new Error("Macro skill selection is unavailable.");
    return selection;
  }

  allowedVerbs(): readonly string[] {
    return this.#options.lowRiskVerbs;
  }

  status(hash: string): SkillState | null {
    return this.row(hash)?.state ?? null;
  }

  draft(candidate: MacroSkillCandidate): string {
    if (this.#stop.signal.aborted || !boundedText(candidate.source, MACRO_SKILL_LIMITS.sourceBytes) ||
        Buffer.from(candidate.source, "utf8").toString("utf8") !== candidate.source ||
        !Array.isArray(candidate.verbs) || !candidate.verbs.length || candidate.verbs.length > automaticVerbs.size ||
        new Set(candidate.verbs).size !== candidate.verbs.length ||
        candidate.verbs.some(verb => !this.#options.lowRiskVerbs.includes(verb)))
      throw new Error("Skill candidate exceeds its admitted source or capability scope.");
    const source = candidate.source, hash = digest(source);
    const verbs = JSON.stringify([...candidate.verbs].sort());
    return this.#db.transaction(() => {
      const parent = this.selection();
      if (parent.generation !== candidate.parentGeneration) throw new Error("Skill candidate parent generation is stale.");
      const existing = this.row(hash);
      if (existing) {
        if (existing.parent_generation !== parent.generation || existing.verbs !== verbs || existing.source !== source)
          throw new Error("This source digest already has a different immutable binding.");
        return hash;
      }
      const count = this.#db.query<{ n: number }, []>("SELECT count(*) AS n FROM skills").get()!.n;
      if (count >= MACRO_SKILL_LIMITS.candidates) throw new Error("Macro skill candidate budget exhausted.");
      this.#db.run(`INSERT INTO skills(hash,source,verbs,parent_generation,parent_hash,state) VALUES (?,?,?,?,?,'draft')`,
        [hash, source, verbs, parent.generation, parent.hash]);
      this.record(hash, "draft", { parent, verbs: JSON.parse(verbs) });
      return hash;
    }).immediate();
  }

  async validate(hash: string, signal?: AbortSignal): Promise<boolean> {
    const row = this.currentDraft(hash, "draft");
    if (!row || this.#flight || signal?.aborted || this.#stop.signal.aborted) return false;
    try { checkSource(row.source); }
    catch {
      this.quarantine(hash, "static-admission");
      return false;
    }
    const verbs = readVerbs(row), fixtures = offlineObservations(verbs);
    const passed = await this.evaluate(row, signal, async (worker, operation) => {
      for (const { input, allowed } of fixtures) offered(await this.compute(worker, input, operation), input, allowed);
      return true;
    });
    if (!passed || signal?.aborted || this.#stop.signal.aborted) return false;
    return this.#db.transaction(() => {
      if (!this.currentDraft(hash, "draft")) return false;
      this.#db.run("UPDATE skills SET state='validated' WHERE hash=?", [hash]);
      this.record(hash, "validated", { negativeCases: 3, heldOutCases: 2, feedbackCases: fixtures.length - 5 });
      return true;
    }).immediate();
  }

  /** Audit only. The returned ID must not be placed on an ordinary or diagnostic input channel. */
  async shadow(hash: string, observation: MacroObservation, signal?: AbortSignal): Promise<MacroSkillProposal | null> {
    const row = this.currentDraft(hash, "validated") ?? this.currentDraft(hash, "trial");
    if (!row || observation.run !== this.#options.worldId) return null;
    const result = await this.evaluateObservation(row, observation, signal);
    if (!result || signal?.aborted || this.#stop.signal.aborted) return null;
    return this.#db.transaction(() => {
      const current = this.currentDraft(hash, row.state);
      if (!current) return null;
      const { offer, basisDigest } = result;
      if (offer) this.#shadowWitnesses.set(hash, { tick: observation.tick, basisDigest, offer });
      else this.#shadowWitnesses.delete(hash);
      if ((offer && current.shadowed !== 1) || (!offer && current.shadowed === 0)) {
        this.#db.run("UPDATE skills SET shadowed=? WHERE hash=?", [offer ? 1 : -1, hash]);
        this.record(hash, "shadow", {
          run: observation.run, life: observation.life, epoch: observation.epoch, tick: observation.tick,
          basisDigest, opportunityId: offer?.id ?? null, verb: offer?.verb ?? null, applied: false,
        });
      }
      return offer && { opportunityId: offer.id, skillHash: hash, generation: row.parent_generation, basisDigest };
    }).immediate();
  }

  beginTrial(hash: string, worldId: string): MacroSkillTrialBinding {
    if (this.#stop.signal.aborted || !boundedText(worldId, 256) || worldId === this.#options.worldId)
      throw new Error("A macro skill trial requires a distinct diagnostic run.");
    return this.#db.transaction(() => {
      const row = this.currentDraft(hash, "validated");
      const running = this.#db.query<{ hash: string }, []>("SELECT hash FROM skills WHERE state='trial'").get();
      if (row?.shadowed !== 1 || running) throw new Error("Macro skill is not eligible for a diagnostic trial.");
      const binding = this.binding(row, worldId);
      this.#db.run("UPDATE skills SET state='trial',trial_world=? WHERE hash=?", [worldId, hash]);
      this.record(hash, "trial", binding);
      return binding;
    }).immediate();
  }

  /** The diagnostic scheduler alone may issue this single proposal in the bound run. */
  async probeTrial(hash: string, observation: MacroObservation, signal?: AbortSignal): Promise<MacroSkillProposal | null> {
    const row = this.currentDraft(hash, "trial");
    if (!row || row.trial_probe || row.trial_world !== observation.run || !observation.quiescent) return null;
    const result = await this.evaluateObservation(row, observation, signal);
    if (!result?.offer || signal?.aborted || this.#stop.signal.aborted) return null;
    const { offer, basisDigest } = result;
    return this.#db.transaction(() => {
      const current = this.currentDraft(hash, "trial");
      if (!current || current.trial_probe || current.trial_world !== observation.run) return null;
      const probe: TrialProbe = { tick: observation.tick, basisDigest, offer };
      this.#db.run("UPDATE skills SET trial_probe=? WHERE hash=?", [JSON.stringify(probe), hash]);
      this.record(hash, "trial-proposal", probe);
      return { opportunityId: offer.id, skillHash: hash, generation: row.parent_generation, basisDigest };
    }).immediate();
  }

  /** Trusted diagnostic owner reserves the exact witnessed native intent before writing it. */
  bindTrialIntent(hash: string, intent: MacroIntent, observation: MacroObservation): boolean {
    return this.#db.transaction(() => {
      const row = this.currentDraft(hash, "trial");
      if (!row?.trial_probe || row.trial_intent || row.trial_world !== observation.run || !observation.quiescent ||
          intent.v !== 1 || intent.run !== observation.run || intent.life !== observation.life ||
          intent.epoch !== observation.epoch || intent.basisTick !== observation.tick || intent.skillHash !== hash ||
          !boundedText(intent.id, 128) || !Number.isSafeInteger(intent.expiresTick) ||
          intent.expiresTick <= intent.basisTick || intent.expiresTick - intent.basisTick > MACRO_MAX_INTENT_TTL_TICKS)
        return false;
      const probe = JSON.parse(row.trial_probe) as TrialProbe;
      if (observation.tick < probe.tick || intent.opportunityId !== probe.offer.id ||
          inputDigest(project(observation, [])) !== probe.basisDigest) return false;
      this.#db.run("UPDATE skills SET trial_intent=? WHERE hash=?", [JSON.stringify(intent), hash]);
      this.record(hash, "trial-intent-bound", intent);
      return true;
    }).immediate();
  }

  /** Bind the native accepted target and matching completed receipt, not authored results. */
  bindTrialWitness(hash: string, witness: MacroTrialWitness, terminal: MacroReceipt): boolean {
    return this.#db.transaction(() => {
      const row = this.currentDraft(hash, "trial");
      if (!row?.trial_probe || !row.trial_intent || row.trial_witness) return false;
      const probe = JSON.parse(row.trial_probe) as TrialProbe;
      const intent = JSON.parse(row.trial_intent) as MacroIntent;
      if (witness.v !== 1 || witness.run !== intent.run || witness.life !== intent.life || witness.epoch !== intent.epoch ||
          witness.basisTick !== intent.basisTick || witness.intentId !== intent.id || witness.opportunityId !== intent.opportunityId ||
          witness.verb !== probe.offer.verb || !permitted(probe.offer, readVerbs(row)) ||
          !Number.isSafeInteger(witness.acceptedTick) || witness.acceptedTick < intent.basisTick ||
          witness.acceptedTick > intent.expiresTick || witness.target.kind !== "camera" ||
          !Number.isFinite(witness.target.yaw) || !Number.isFinite(witness.target.pitch) ||
          Math.abs(witness.target.pitch) > 90 || terminal.v !== 1 || terminal.run !== intent.run ||
          terminal.life !== intent.life || terminal.id !== intent.id || terminal.status !== "completed" ||
          !Number.isSafeInteger(terminal.tick) || terminal.tick <= witness.acceptedTick || terminal.tick > intent.expiresTick)
        return false;
      const bound: BoundTrialWitness = { witness, terminal };
      this.#db.run("UPDATE skills SET trial_witness=? WHERE hash=?", [JSON.stringify(bound), hash]);
      this.record(hash, "trial-witness-bound", { ...bound, targetDigest: macroTrialWitnessDigest(witness) });
      return true;
    }).immediate();
  }

  promote(hash: string, expectedGeneration: number, observation: MacroObservation): boolean {
    if (!this.neutral(observation)) return false;
    return this.#db.transaction(() => {
      const row = this.currentDraft(hash, "trial"), previous = this.selection();
      if (!row?.trial_world || !row.trial_probe || !row.trial_intent || !row.trial_witness ||
          previous.generation !== expectedGeneration) return false;
      const binding = this.binding(row, row.trial_world);
      const probe = JSON.parse(row.trial_probe) as TrialProbe;
      const intent = JSON.parse(row.trial_intent) as MacroIntent;
      const bound = JSON.parse(row.trial_witness) as BoundTrialWitness;
      if (!this.matchesShadow(hash, observation, bound.witness.verb)) return false;
      const proof = this.#options.readTrial(binding);
      if (!proof || !this.matchesProof(binding, probe, intent, bound, proof) ||
          !this.neutral(observation) || !this.matchesShadow(hash, observation, bound.witness.verb)) return false;
      this.switchSelection(previous, hash);
      this.record(hash, "activated", { previous, proof, ordinaryShadow: this.#shadowWitnesses.get(hash) });
      this.#shadowWitnesses.delete(hash);
      return true;
    }).immediate();
  }

  /** Restore the nearest still-eligible ancestor, or no skill. This never changes the world. */
  revert(expectedGeneration: number, observation: MacroObservation): boolean {
    if (!this.neutral(observation)) return false;
    return this.#db.transaction(() => {
      const previous = this.selection();
      if (previous.generation !== expectedGeneration || !previous.hash) return false;
      let ancestor = this.row(previous.hash)?.parent_hash;
      for (let depth = 0; ancestor && depth < MACRO_SKILL_LIMITS.candidates; depth++) {
        const row = this.row(ancestor);
        if (row?.state === "retired") break;
        ancestor = row?.parent_hash;
      }
      if (ancestor && this.row(ancestor)?.state !== "retired") return false;
      this.switchSelection(previous, ancestor ?? null);
      this.record(previous.hash, "reverted", { previous, restored: ancestor ?? null });
      return true;
    }).immediate();
  }

  quarantine(hash: string, reason: string): void {
    if (this.#stop.signal.aborted) return;
    this.#db.transaction(() => {
      const row = this.row(hash);
      if (!row || row.state === "quarantined") return;
      this.#db.run("UPDATE skills SET state='quarantined' WHERE hash=?", [hash]);
      this.#shadowWitnesses.delete(hash);
      this.record(hash, "quarantined", { reason: reason.slice(0, 160), generation: this.selection().generation });
    }).immediate();
  }

  async select(observation: MacroObservation, signal?: AbortSignal,
    receipts: readonly MacroSkillReceipt[] = []): Promise<MacroSkillProposal | null> {
    if (observation.run !== this.#options.worldId || this.#stop.signal.aborted) return null;
    const selected = this.selection(), row = selected.hash ? this.row(selected.hash) : null;
    if (!row || row.state !== "active") return null;
    const verb = verifiedVerb(row);
    if (!verb || !validReceipts(receipts, observation.tick, verb)) return null;
    const result = await this.evaluateObservation(row, observation, signal, receipts, [verb]);
    if (!result?.offer || signal?.aborted || this.#stop.signal.aborted || this.selection().generation !== selected.generation ||
        this.row(row.hash)?.state !== "active") return null;
    const proposal = Object.freeze({
      opportunityId: result.offer.id, skillHash: row.hash, generation: selected.generation, basisDigest: result.basisDigest,
    });
    this.#activeProposals.set(proposal, observation.tick);
    return proposal;
  }

  /** Check the exact evaluated proposal against the latest projection immediately before IPC. */
  matchesSelection(proposal: MacroSkillProposal, observation: MacroObservation,
    receipts: readonly MacroSkillReceipt[] = []): boolean {
    const basisTick = this.#activeProposals.get(proposal);
    if (this.#stop.signal.aborted || observation.run !== this.#options.worldId || basisTick === undefined ||
        observation.tick < basisTick) return false;
    const selected = this.selection();
    if (selected.hash !== proposal.skillHash || selected.generation !== proposal.generation) return false;
    const row = this.row(proposal.skillHash);
    if (!row || row.state !== "active") return false;
    const verb = verifiedVerb(row);
    return !!verb && validReceipts(receipts, observation.tick, verb) &&
      observation.opportunities.some(offer => offer.id === proposal.opportunityId && permitted(offer, [verb])) &&
      inputDigest(project(observation, receipts)) === proposal.basisDigest;
  }

  close(): Promise<void> {
    if (!this.#closing) {
      this.#stop.abort();
      this.#closing = (async () => {
        try {
          await this.#flight?.catch(() => {});
          await this.#sandbox.close();
        } finally { this.#db.close(); }
      })();
    }
    return this.#closing;
  }

  private row(hash: string): SkillRow | null {
    if (!digestPattern.test(hash)) return null;
    const row = this.#db.query<SkillRow, [string]>("SELECT * FROM skills WHERE hash=?").get(hash);
    if (row && (digest(row.source) !== hash || readVerbs(row).some(verb => !this.#options.lowRiskVerbs.includes(verb))))
      throw new Error("Stored skill no longer matches its immutable scope.");
    return row;
  }

  private currentDraft(hash: string, state: SkillState): SkillRow | null {
    if (this.#stop.signal.aborted) return null;
    const row = this.row(hash);
    if (!row || row.state !== state) return null;
    const parent = this.selection();
    return parent.generation === row.parent_generation && parent.hash === row.parent_hash ? row : null;
  }

  private neutral(observation: MacroObservation): boolean {
    return !this.#stop.signal.aborted && !this.#flight && observation.run === this.#options.worldId &&
      observation.quiescent && this.#options.isNeutralHandoff(observation);
  }

  private matchesShadow(hash: string, observation: MacroObservation, verified: string): boolean {
    const witness = this.#shadowWitnesses.get(hash);
    return !!witness && witness.tick <= observation.tick && permitted(witness.offer, [verified]) &&
      inputDigest(project(observation, [])) === witness.basisDigest;
  }

  private binding(row: SkillRow, worldId: string): MacroSkillTrialBinding {
    const { capabilityVersion, adapterVersion, actorJarSha256 } = this.#options;
    return Object.freeze({ skillHash: row.hash, parentGeneration: row.parent_generation, parentHash: row.parent_hash,
      capabilityVersion, adapterVersion, actorJarSha256, worldId, verbs: Object.freeze(readVerbs(row)) });
  }

  private matchesProof(binding: MacroSkillTrialBinding, probe: TrialProbe, intent: MacroIntent, { witness, terminal }: BoundTrialWitness,
    proof: MacroSkillTrialAttestation): boolean {
    return proof.skillHash === binding.skillHash && proof.parentGeneration === binding.parentGeneration &&
      proof.parentHash === binding.parentHash && proof.capabilityVersion === binding.capabilityVersion &&
      proof.adapterVersion === binding.adapterVersion && proof.actorJarSha256 === binding.actorJarSha256 &&
      proof.worldId === binding.worldId && proof.run === binding.worldId && proof.run === intent.run &&
      proof.life === intent.life && proof.epoch === intent.epoch && proof.basisTick === intent.basisTick &&
      proof.intentId === intent.id && proof.opportunityId === intent.opportunityId &&
      Array.isArray(proof.verbs) && proof.verbs.length === binding.verbs.length &&
      proof.verbs.every((verb, index) => verb === binding.verbs[index]) &&
      proof.opportunityId === probe.offer.id && proof.verb === probe.offer.verb &&
      proof.risk === probe.offer.risk && proof.evidence === probe.offer.evidence &&
      proof.acceptedTick === witness.acceptedTick && witness.target.kind === "camera" && proof.target?.kind === "camera" &&
      proof.target.yaw === witness.target.yaw && proof.target.pitch === witness.target.pitch &&
      proof.targetDigest === macroTrialWitnessDigest(witness) && /^sha256:[a-f0-9]{64}$/.test(proof.effectRef) &&
      proof.receiptTick === terminal.tick;
  }

  private record(hash: string, event: string, detail: unknown): void {
    this.#db.run("INSERT INTO history(at_ms,hash,event,detail) VALUES (?,?,?,?)",
      [Date.now(), hash, event, JSON.stringify(detail)]);
  }

  private switchSelection(previous: MacroSkillSelection, target: string | null): void {
    if (previous.hash) this.#db.run("UPDATE skills SET state='retired' WHERE hash=? AND state='active'", [previous.hash]);
    if (target) this.#db.run("UPDATE skills SET state='active' WHERE hash=?", [target]);
    this.#db.run("INSERT INTO selection VALUES (?,?)", [previous.generation + 1, target]);
    // A generation change fences any outstanding diagnostic attestation and frees its trial slot.
    const stale = this.#db.query<{ hash: string }, []>("SELECT hash FROM skills WHERE state='trial'").get();
    if (stale) {
      this.#db.run("UPDATE skills SET state='quarantined' WHERE hash=?", [stale.hash]);
      this.record(stale.hash, "quarantined", { reason: "selection-changed", generation: previous.generation + 1 });
    }
  }

  private async evaluateObservation(row: SkillRow, observation: MacroObservation, signal?: AbortSignal,
    receipts: readonly MacroSkillReceipt[] = [], verbs: readonly string[] = readVerbs(row)): Promise<SkillEvaluation | undefined> {
    const projected = project(observation, receipts);
    const basisDigest = inputDigest(projected);
    return await this.evaluate(row, signal, async (worker, operation) => ({
      basisDigest, offer: offered(await this.compute(worker, projected, operation), projected, verbs),
    }));
  }

  private async compute(worker: ResidentAnalysisWorker, observation: SkillObservation, signal: AbortSignal): Promise<Json> {
    if (Buffer.byteLength(JSON.stringify(observation), "utf8") > MACRO_SKILL_LIMITS.observationBytes)
      throw new SandboxUnavailable("Skill observation exceeds the worker admission bound.");
    return await worker.analyze(observation as unknown as Json, signal);
  }

  private async evaluate<T>(row: SkillRow, signal: AbortSignal | undefined,
    run: (worker: ResidentAnalysisWorker, operation: AbortSignal) => Promise<T>): Promise<T | undefined> {
    if (this.#flight || this.#sandboxFailed || this.#stop.signal.aborted || signal?.aborted) return;
    const operation = AbortSignal.any([this.#stop.signal, AbortSignal.timeout(MACRO_SKILL_LIMITS.operationMs), ...(signal ? [signal] : [])]);
    const work = (async () => {
      if (this.#sandbox.snapshot().status !== "ready") {
        const state = await this.#sandbox.prepare();
        if (state.status !== "ready") {
          this.#sandboxFailed = true;
          throw new SandboxUnavailable("Isolated skill worker is unavailable.");
        }
      }
      operation.throwIfAborted();
      const worker = await this.#sandbox.createResidentAnalysisWorker(
        singletonExecutableModuleBundle(row.source, "analyze"), MACRO_SKILL_LIMITS.evaluationMs, operation);
      try {
        const result = await run(worker, operation);
        operation.throwIfAborted();
        return result;
      } finally { await worker.close(); }
    })();
    this.#flight = work;
    try { return await work; }
    catch (error) {
      const code = residentWorkerFailure(error)?.code;
      if (code === "cleanup" || error instanceof ResidentWorkerCleanupFault) {
        this.#sandboxFailed = true;
        throw error;
      }
      if (!operation.aborted && (error instanceof InvalidSource || code === "source_throw" ||
          code === "watchdog" || code === "invalid_return_json"))
        this.quarantine(row.hash, error instanceof InvalidSource ? error.message : `isolated-${code}`);
      return undefined;
    } finally { this.#flight = null; }
  }
}
