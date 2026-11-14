import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ProgramCompatibility } from "../shared/contracts.ts";
import type {
  SkillExecutionView,
  SkillRef,
  SkillView,
} from "../shared/programs.ts";
import type { Store } from "./store.ts";
import type { SourcePrograms } from "./source-programs.ts";
import { SKILL_API_VERSION } from "../shared/programs.ts";
import { sameProgramCompatibility } from "./adapter-contract.ts";
import { qualifyMinecraftExperience } from "./minecraft-qualification.ts";
export const HISTORICAL_PROGRAM_COMPATIBILITY_V3 = Object.freeze({
  adapter_id: "fabric-owned-client" as const,
  game_version: "1.21.4" as const,
  observation_schema: 2 as const,
  profile_id: "player-observable-structured" as const,
  preset_id: "minecraft-observable-initial-r2" as const,
  skill_protocol: 3 as const,
});
export interface LegacyProgramCompatibility {
  adapter_id: string;
  game_version: string;
  observation_schema: 1 | 2;
  profile_id: string;
  preset_id: string;
  skill_protocol: 1 | 2 | 3;
}
function compatible(
  value: unknown,
  current: ProgramCompatibility | null,
): boolean {
  return current !== null && sameProgramCompatibility(value, current);
}
export interface ExperienceView {
  experience_id: string;
  name: string;
  model_id: string;
  profile_id: string;
  /** Historical display metadata only; no active preset alias is emitted. */
  preset_id?: string;
  source_run_id: string;
  source_world_id: string;
  portability: "portable" | "world_local";
  retained_world_data: boolean;
  compatibility: ProgramCompatibility | LegacyProgramCompatibility;
  root: SkillRef;
  created_at: string;
  evidence: {
    execution_id: string;
    action_ids: string[];
    predicate: PromotionDeclaration["predicate"];
  };
}
export interface PromotionDeclaration {
  portability: "portable" | "world_local";
  retained_world_data: boolean;
  predicate:
    | { kind: "goal_verified"; event_seq: number }
    | { kind: "break_log"; event_seq: number }
    | {
        kind: "inventory_gain";
        item: string;
        min_gain: number;
        event_seq: number;
      };
}
export const promotionDeclarationSchema: z.ZodType<PromotionDeclaration> = z
  .object({
    portability: z.enum(["portable", "world_local"]),
    retained_world_data: z.boolean(),
    predicate: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("break_log"),
          event_seq: z.number().int().positive(),
        })
        .strict(),
      z
        .object({
          kind: z.literal("goal_verified"),
          event_seq: z.number().int().positive(),
        })
        .strict(),
      z
        .object({
          kind: z.literal("inventory_gain"),
          item: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/),
          min_gain: z.number().int().min(1).max(4096),
          event_seq: z.number().int().positive(),
        })
        .strict(),
    ]),
  })
  .strict();
interface Bundle extends ExperienceView {
  skills: SkillView[];
}
/** Explicit immutable model-scoped library. World observations and invocation args never travel. */
export class ExperienceLibrary {
  private db: Database;
  constructor(
    directory: string,
    private current: ProgramCompatibility | (() => ProgramCompatibility | null) | null = null,
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const filename = join(directory, "experience.sqlite");
    this.db = new Database(filename, { create: true, strict: true });
    try {
      chmodSync(filename, 0o600);
      this.db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS bundles(id TEXT PRIMARY KEY,model TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload))) STRICT;",
      );
      this.db.transaction(() => {
        const columns = this.db.query<{ name: string }, []>("PRAGMA table_info(bundles)").all();
        if (!columns.some((column) => column.name === "revision")) {
          this.db.exec("ALTER TABLE bundles ADD COLUMN revision INTEGER");
          this.db.exec("UPDATE bundles SET revision=rowid");
        }
        this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS bundles_revision ON bundles(revision)");
      })();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private compatibility(): ProgramCompatibility | null { return typeof this.current === "function" ? this.current() : this.current; }
  list(modelId: string, worldId: string | null): ExperienceView[] {
    const current = this.compatibility();
    return this.db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM bundles WHERE model=? ORDER BY rowid DESC LIMIT 100",
      )
      .all(modelId)
      .map((row) => {
        const { skills: _skills, ...view } = JSON.parse(row.payload) as Bundle;
        return view;
      })
      .filter(
        (view) =>
          compatible(view.compatibility, current) &&
          (view.portability === "portable" || view.source_world_id === worldId),
      );
  }
  catalog(modelId: string, worldId: string | null, after: number, limit: number) {
    const current = this.compatibility();
    if (!current) return { records: [], next_after: after, has_more: false, omissions: [] };
    const rows = this.db.query<{ version: number; payload: string }, [string, string | null, string, number, number, number]>(
      "WITH compatible AS (SELECT revision AS version,payload FROM bundles WHERE model=? AND (json_extract(payload,'$.portability')='portable' OR json_extract(payload,'$.source_world_id')=?) AND json_extract(payload,'$.compatibility.compatibility_hash')=?), latest AS (SELECT json_extract(payload,'$.name') AS name,MAX(version) AS version FROM compatible GROUP BY name) SELECT c.version,c.payload FROM compatible c JOIN latest l ON c.version=l.version WHERE (?=0 OR c.version<?) ORDER BY c.version DESC LIMIT ?",
    ).all(modelId, worldId, current.compatibility_hash, after, after, limit + 1);
    const selected = rows.slice(0, limit);
    return { records: selected.map(({ version, payload }) => {
      const { skills: _skills, ...view } = JSON.parse(payload) as Bundle;
      return { ...view, version };
    }).filter(view => compatible(view.compatibility, current)), next_after: selected.at(-1)?.version ?? after, has_more: rows.length > limit, omissions: [] };
  }
  named(modelId: string, worldId: string | null, name: string, version?: number): (ExperienceView & { version: number }) | null {
    const current = this.compatibility();
    if (!current) return null;
    const row = this.db.query<{ version: number; payload: string }, [string, string, number | null, number | null, string | null, string]>(
      "SELECT revision AS version,payload FROM bundles WHERE model=? AND json_extract(payload,'$.name')=? AND revision IS NOT NULL AND (? IS NULL OR revision=?) AND (json_extract(payload,'$.portability')='portable' OR json_extract(payload,'$.source_world_id')=?) AND json_extract(payload,'$.compatibility.compatibility_hash')=? ORDER BY revision DESC LIMIT 1",
    ).get(modelId, name, version ?? null, version ?? null, worldId, current.compatibility_hash);
    if (!row) return null;
    const { skills: _skills, ...view } = JSON.parse(row.payload) as Bundle;
    if (!compatible(view.compatibility, current)) return null;
    return { ...view, version: row.version };
  }
  snapshotVersion(id: string, modelId: string): number | null {
    return this.db.query<{ version: number }, [string, string]>(
      "SELECT revision AS version FROM bundles WHERE id=? AND model=?",
    ).get(id, modelId)?.version ?? null;
  }
  /** Historical snapshots stay inspectable without becoming executable-compatible. */
  inspect(id: string, modelId: string): ExperienceView | null {
    const row = this.db.query<{ payload: string }, [string, string]>("SELECT payload FROM bundles WHERE id=? AND model=?").get(id, modelId);
    if (!row) return null;
    const { skills: _skills, ...view } = JSON.parse(row.payload) as Bundle;
    return view;
  }
  promote(
    store: Store,
    runId: string,
    execution: SkillExecutionView,
    name: string,
    declaration: PromotionDeclaration,
  ): ExperienceView {
    declaration = promotionDeclarationSchema.parse(declaration);
    const run = store.getRun(runId);
    if (
      !run ||
      execution.run_id !== runId ||
      execution.parent_execution_id !== null
    )
      throw new Error("Promotion requires a root execution in this run");
    const provenance = store
      .eventsAfter(runId, 0, 100)
      .find((event) => event.type === "run.adapter");
    const current = this.compatibility();
    if (!current || !compatible(provenance?.details, current))
      throw new Error(
        "Native adapter provenance is absent or incompatible; legacy runs are not portable evidence",
      );
    if (
      declaration.portability === "portable" &&
      declaration.retained_world_data
    )
      throw new Error("World-bound retained code/data must remain world-local");
    const verified = store.eventsAfter(
      runId,
      declaration.predicate.event_seq - 1,
      1,
    )[0];
    if (
      !verified ||
      verified.event_seq !== declaration.predicate.event_seq ||
      verified.run_id !== runId ||
      !execution.started_at ||
      verified.at < execution.started_at ||
      !execution.ended_at ||
      verified.at > execution.ended_at
    )
      throw new Error(
        "Evidence must come from this bounded execution interval",
      );
    if (
      execution.status !== "succeeded" &&
      !(execution.status === "cancelled" && verified.type === "goal.verified")
    )
      throw new Error(
        "Promotion requires completed execution or trusted objective closure",
      );
    if (current.descriptor.observation.payload_schema.id !== "minecraft_observation_v1")
      throw new Error("This adapter has no registered experience qualification predicate implementation");
    const actionIds = qualifyMinecraftExperience(store, run, execution, declaration);
    const skills: SkillView[] = [];
    const seen = new Set<string>();
    const visit = (ref: SkillRef): void => {
      const key = `${ref.skill_id}:${ref.version}`;
      if (seen.has(key)) return;
      seen.add(key);
      const skill = store.skill(runId, ref);
      if (skill.state !== "validated")
        throw new Error("Promotion requires validated exact dependencies");
      if (!skill.entry || skill.validation.runtime_version !== SKILL_API_VERSION || skill.validation.api_version !== 5 || skill.validation.validator_version !== 5 ||
        skill.validation.compatibility_hash !== current.compatibility_hash)
        throw new Error("Promotion requires compatible skill API sources; retained incompatible history is inspectable only");
      for (const dependency of skill.dependencies) visit(dependency);
      skills.push(skill);
    };
    visit(execution);
    const payload: Omit<Bundle, "experience_id"> = {
      name,
      model_id: run.model_id,
      profile_id: current.descriptor.observation.profile.id,
      source_run_id: runId,
      source_world_id: run.world_id,
      portability: declaration.portability,
      retained_world_data: declaration.retained_world_data,
      compatibility: current,
      root: { skill_id: execution.skill_id, version: execution.version },
      created_at: new Date().toISOString(),
      evidence: {
        execution_id: execution.execution_id,
        action_ids: actionIds,
        predicate: declaration.predicate,
      },
      skills,
    };
    const experience_id = createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex");
    this.db.transaction(() => {
      const revision = this.db.query<{ revision: number }, []>("SELECT COALESCE(MAX(revision),0)+1 AS revision FROM bundles").get()!.revision;
      this.db.query("INSERT INTO bundles(id,model,payload,revision) VALUES(?,?,?,?)")
        .run(experience_id, run.model_id, JSON.stringify({ ...payload, experience_id }), revision);
    })();
    const { skills: _skills, ...view } = { ...payload, experience_id };
    return view;
  }
  async hydrate(
    id: string,
    modelId: string,
    worldId: string,
    runId: string,
    sources: Pick<SourcePrograms, "importSnapshot">,
    beforeCommit: () => void = () => {},
  ): Promise<SkillView> {
    const row = this.db
      .query<{ payload: string }, [string, string]>(
        "SELECT payload FROM bundles WHERE id=? AND model=?",
      )
      .get(id, modelId);
    if (!row) throw new Error("No compatible model-scoped experience snapshot");
    const bundle = JSON.parse(row.payload) as Bundle;
    const current = this.compatibility();
    if (!compatible(bundle.compatibility, current))
      throw new Error(
        "Snapshot adapter/game/profile/schema/protocol compatibility does not match",
      );
    if (bundle.portability !== "portable" && bundle.source_world_id !== worldId)
      throw new Error("World-local snapshot cannot hydrate into another world");
    if (bundle.portability === "portable" && bundle.retained_world_data)
      throw new Error(
        "Portable declaration conflicts with retained world data",
      );
    if (!current || bundle.profile_id !== current.descriptor.observation.profile.id)
      throw new Error("Observation profile incompatible");
    const imported = new Map<string, SkillView>();
    for (const skill of bundle.skills) {
      for (const ref of skill.dependencies)
        if (!imported.has(`${ref.skill_id}:${ref.version}`))
          throw new Error("Experience dependency snapshot incomplete");
      const view = await sources.importSnapshot(runId, skill, beforeCommit);
      imported.set(`${skill.skill_id}:${skill.version}`, view);
    }
    const root = imported.get(`${bundle.root.skill_id}:${bundle.root.version}`);
    if (!root) throw new Error("Experience root missing");
    return root;
  }
  close(): void {
    this.db.close();
  }
}
