import { createHash, randomUUID } from "node:crypto";
import type { ActivityEvent, AdapterBinding, Json, RuntimeAdapter } from "../shared/contracts.ts";
import type { SkillDependency, SkillRef, SkillView } from "../shared/programs.ts";
import { SKILL_API_VERSION } from "../shared/programs.ts";
import { assertExecutableCompatible } from "./effect-contract.ts";
import { HOST_MONOTONIC_CLOCK_ID } from "./performance.ts";
import { resolveProgramModuleClosure } from "./program-modules.ts";
import { programFingerprint, validateSkill } from "./program-validation.ts";
import { RegisteredAdapterContract } from "./registered-adapter.ts";
import { RuntimeFault } from "./runtime-fault.ts";
import type { Store } from "./store.ts";

/** Source metadata and immutable artifacts only; no execution or native authority. */
export type SourceProgramStore = Readonly<Pick<Store,
  "skill" | "getRun" | "completedToolCall" | "registerSkill" | "importSkill"
>> & {
  event(...args: Parameters<Store["event"]>): ActivityEvent | Promise<ActivityEvent>;
};

export interface SourceProgramHost {
  adapter(): RuntimeAdapter | null;
  binding(): AdapterBinding | null;
  changed?(): void;
}

/** Shared cached-source check for catalog authoring and physical admission. */
export function assertSourceCompatible(skill: SkillView, binding: AdapterBinding): void {
  const validation = assertExecutableCompatible(skill.validation, binding);
  const features = skill.validation.runtime_features;
  if ((features !== undefined && (features.length > 2 || new Set(features).size !== features.length ||
    features.some(feature => feature !== "pure_modules_v1" && feature !== "motion_track_v1"))) ||
    !skill.entry || validation.fingerprint !== programFingerprint(skill.hash, skill.entry === "run" ? "skill" : skill.entry,
      binding.compatibility_hash, undefined, features))
    throw new RuntimeFault("precondition_failed", "Cached source validation is incompatible; retain history and create a fresh immutable revision");
}

/** Validate exact immutable dependency identities without constructing an action engine. */
export function assertSourceDependencies(store: Pick<SourceProgramStore, "skill">, runId: string,
  dependencies: SkillDependency[], compatible: (skill: SkillView) => void): void {
  const visited = new Map<string, number>();
  const visit = (ref: SkillRef, depth: number): void => {
    if (depth > 8) throw new Error("Dependency depth exceeds eight");
    const key = `${ref.skill_id}:${ref.version}`;
    if ((visited.get(key) ?? 0) >= depth) return;
    visited.set(key, depth);
    const dependency = store.skill(runId, ref);
    compatible(dependency);
    if (dependency.state !== "validated")
      throw new Error("Dependency is not validated");
    if (dependency.validation.runtime_version !== SKILL_API_VERSION)
      throw new RuntimeFault("precondition_failed", "Dependency uses an incompatible skill API; retained source is inspectable but cannot execute");
    if (createHash("sha256").update(dependency.source).digest("hex") !== dependency.hash)
      throw new RuntimeFault("stale_context", "Dependency bytes do not match the immutable source hash");
    for (const nested of dependency.dependencies) visit(nested, depth + 1);
  };
  for (const dependency of dependencies) visit(dependency, 2);
}

/** Pure source validation and catalog publication, independent of physical scheduling. */
export class SourcePrograms {
  private readonly registrations = new WeakMap<RuntimeAdapter, RegisteredAdapterContract>();
  constructor(private store: SourceProgramStore, private host: SourceProgramHost) {}

  private context() {
    const adapter = this.host.adapter(), binding = this.host.binding();
    if (!adapter || !binding?.ready) throw new RuntimeFault("precondition_failed", "A negotiated adapter contract is required");
    let registration = this.registrations.get(adapter);
    if (!registration) { registration = new RegisteredAdapterContract(adapter.descriptor, adapter.schemas, adapter.capabilityValidators); this.registrations.set(adapter, registration); }
    if (registration.compatibility.compatibility_hash !== binding.compatibility_hash)
      throw new RuntimeFault("precondition_failed", "Executable and native adapter profiles do not match");
    return { adapter, binding, registration, descriptor: adapter.descriptor, schemas: adapter.schemas };
  }

  private compatible(skill: SkillView): void {
    assertSourceCompatible(skill, this.context().binding);
  }

  async register(
    runId: string,
    spec: unknown,
    beforeCommit: () => void = () => {},
    registration?: { call_id: string; input: Json },
  ): Promise<SkillView> {
    if (registration) {
      const previous = this.store.completedToolCall(runId, registration.call_id, registration.input);
      if (previous !== null) return this.store.skill(runId, previous as unknown as SkillRef);
    }
    return this.timeSource(runId, registration?.call_id ?? null, async timing => {
      const validated = await validateSkill(spec, this.context());
      assertSourceDependencies(this.store, runId, validated.dependencies, dependency => this.compatible(dependency));
      if (validated.entry === "run" && validated.dependencies.some(dependency => this.store.skill(runId, dependency).entry !== "run"))
        throw new RuntimeFault("precondition_failed", "Async run dependencies can only name semantic run children");
      if (validated.entry !== "run") resolveProgramModuleClosure(this.store, runId, {
        ...validated, hash: createHash("sha256").update(validated.source).digest("hex"),
      });
      timing.validatedAt = performance.now();
      const published = await this.store.registerSkill(runId, validated, registration, beforeCommit);
      timing.published = published;
      timing.publishedAt = performance.now();
      this.host.changed?.();
      return published;
    });
  }

  async importSnapshot(
    runId: string,
    snapshot: SkillView,
    beforeCommit: () => void = () => {},
  ): Promise<SkillView> {
    return this.timeSource(runId, null, async timing => {
      this.compatible(snapshot);
      const validated = await validateSkill({
        entry: snapshot.entry,
        name: snapshot.name,
        source: snapshot.source,
        card: snapshot.card,
        dependencies: snapshot.dependencies,
      }, this.context());
      if (
        validated.source !== snapshot.source ||
        createHash("sha256").update(snapshot.source).digest("hex") !==
          snapshot.hash
      )
        throw new Error(
          "Exact snapshot bytes do not match current canonical validation",
        );
      if (validated.validation.fingerprint !== snapshot.validation.fingerprint)
        throw new Error(
          "Snapshot validator configuration changed; fresh evidence requires a validated revision",
        );
      assertSourceDependencies(this.store, runId, snapshot.dependencies, dependency => this.compatible(dependency));
      if (snapshot.entry === "run" && snapshot.dependencies.some(dependency => this.store.skill(runId, dependency).entry !== "run"))
        throw new RuntimeFault("precondition_failed", "Async run dependencies can only name semantic run children");
      if (snapshot.entry !== "run") resolveProgramModuleClosure(this.store, runId, snapshot);
      timing.validatedAt = performance.now();
      const view = await this.store.importSkill(runId, snapshot, beforeCommit);
      timing.published = view;
      timing.publishedAt = performance.now();
      await this.store.event(
        runId,
        "skill.revalidated_import",
        "Exact portable snapshot freshly validated without rewriting dependency references",
        {
          skill_id: view.skill_id,
          version: view.version,
          hash: view.hash,
          validation: validated.validation as unknown as Json,
        },
      );
      this.host.changed?.();
      return view;
    });
  }

  private async timeSource(
    runId: string,
    toolCallId: string | null,
    perform: (timing: { validatedAt: number | null; publishedAt: number | null; published: SkillView | null }) => Promise<SkillView>,
  ): Promise<SkillView> {
    const started = performance.now(), validationId = randomUUID();
    const timing: { validatedAt: number | null; publishedAt: number | null; published: SkillView | null } = {
      validatedAt: null, publishedAt: null, published: null,
    };
    try {
      return await perform(timing);
    } finally {
      const ended = performance.now();
      await this.store.event(runId, "program.source_timing", "Source validation and publication timing; no execution or efficacy claim", {
        validation_id: validationId, tool_call_id: toolCallId,
        clock_id: HOST_MONOTONIC_CLOCK_ID, clock: "same_process_monotonic",
        started_monotonic_ms: started, ended_monotonic_ms: ended,
        validation_finished_monotonic_ms: timing.validatedAt, published_monotonic_ms: timing.publishedAt,
        duration_ms: ended - started, validation_succeeded: timing.validatedAt !== null,
        source_published: timing.published !== null, source_hash: timing.published?.hash ?? null,
        skill_id: timing.published?.skill_id ?? null, version: timing.published?.version ?? null,
      });
    }
  }
}
