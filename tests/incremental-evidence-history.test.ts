import { afterEach, expect, setSystemTime, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionView, GameAction, Json } from "../src/shared/contracts.ts";
import type {
  ControllerEffectUpdate,
  ControllerInput,
} from "../src/shared/controller.ts";
import type {
  ImprovementFeedbackCursor,
  ImprovementOpportunity,
  ProgramVersionEvidence,
} from "../src/shared/execution-evidence.ts";
import {
  DEFAULT_SKILL_LIMITS,
  type SkillExecutionView,
  type SkillRef,
} from "../src/shared/programs.ts";
import { DEFAULT_RESIDENT_LIMITS } from "../src/shared/resident.ts";
import { jsonSchema } from "../src/shared/primitives.ts";
import { Store, type StoredRun } from "../src/server/store.ts";
import { SkillManager } from "../src/server/skills.ts";
import { HistoryReader } from "../src/server/history-reader.ts";
import { ImprovementLearning } from "../src/server/improvement-learning.ts";
import {
  programEvidence,
  type DetailedProgramEvidence,
} from "../src/server/program-evidence.ts";
import { readProjectedProgramEvidence } from "../src/server/history-evidence.ts";
import { objectiveMetrics } from "../src/server/objective-metrics.ts";
import { actionMetrics } from "../src/evaluation/results.ts";
import { observationEvidence } from "../src/server/adapter-evidence.ts";
import { retainResidentReceipt } from "../src/server/resident-evidence.ts";
import { ProgramWorkspace } from "../src/server/program-workspace.ts";
import { ProgramOperations } from "../src/server/program-operations.ts";
import { programWriteSchema } from "../src/server/program-interface.ts";
import type { RuntimeToolHost } from "../src/server/runtime-tools.ts";
import type { ReactiveRuntime } from "../src/server/reactive.ts";
import type { HistoryProjectionBatch } from "../src/server/history-projection.ts";
import { compareProgramVersionsPage } from "../src/server/program-comparison.ts";
import {
  executionScopeFixture,
  minecraftObservationFixture,
  minecraftRunFixture,
  minecraftTestAdapter,
  minecraftTestBinding,
  sha256,
} from "./helpers/adapter-contract.ts";

// Synthetic host-only facts. Nothing here authorizes native or model execution.
const EPOCH = Date.parse("2026-11-01T12:00:00.000Z");
const QUERY_TIME = EPOCH + 100;
const iso = (offset: number) => new Date(EPOCH + offset).toISOString();
const adapter = minecraftTestAdapter("balanced", { now: () => QUERY_TIME });
const compatibility = {
  descriptor: adapter.descriptor,
  compatibility_hash: sha256(adapter.descriptor),
};
const card = {
  purpose: "Measure retained receipt facts",
  applicability: "Authorized fixture scope",
  method: "Read current facts",
  reason: "Independent descriptive accounting",
  limitations: "Not a gameplay or improvement claim",
};
const source = 'return {status:"completed",summary:"No effects",result:null};';
const initialCursor = (): ImprovementFeedbackCursor => ({
  schema_version: 2,
  opportunity_change_seq: 0,
  metric_change_seq: 0,
  scope_hash: null,
});
const options = () => ({ deadlineHostMs: performance.now() + 120_000 });
function at<T>(offset: number, operation: () => T): T {
  setSystemTime(new Date(EPOCH + offset));
  try {
    return operation();
  } finally {
    setSystemTime(new Date(QUERY_TIME));
  }
}
class EvidenceFixture {
  readonly directory = mkdtempSync(join(tmpdir(), "incremental-evidence-"));
  store = new Store(join(this.directory, "runs"));
  reader = new HistoryReader(this.store.readLocation());
  learning = new ImprovementLearning(this.store, this.reader);
  run: StoredRun;
  manager: SkillManager;
  constructor(goalId = "custom", descriptor = true) {
    setSystemTime(new Date(QUERY_TIME));
    this.run = minecraftRunFixture(adapter, {
      started_at: iso(0),
      model_id: "evidence-fixture-model",
      goal: adapter.goals.find((goal) => goal.goal_id === goalId)!,
    });
    this.run.baseline = adapter.captureBaseline(
      adapter.goals.find((goal) => goal.goal_id === goalId)!,
      this.observation({}, 0, 1),
    );
    at(0, () => this.store.saveRun(this.run));
    if (descriptor)
      at(1, () =>
        this.store.event(
          this.run.run_id,
          "run.adapter",
          "Registered compatibility",
          jsonSchema.parse(compatibility),
        ),
      );
    this.manager = this.makeManager();
    resources.push(this);
  }
  makeManager() {
    return new SkillManager(
      this.store,
      {
        runSkill: async () => {
          throw new Error("Fixture must not dispatch a program");
        },
      },
      {
        authorize: () => {},
        adapter: () => adapter,
        binding: () => minecraftTestBinding(adapter),
        observe: async () => this.observation({}, 0),
        action: async () => {
          throw new Error("Fixture must not issue effects");
        },
        queryCapability: async () => null,
        cancelActions: async () => {},
        changed: () => {},
        unsafe: () => {},
        recover: async () => {
          throw new Error("No recovery authority");
        },
      },
    );
  }
  async authored(name = "measured", entry: "run" | "step" = "run") {
    return this.manager.register(this.run.run_id, {
      entry,
      name,
      source:
        entry === "step"
          ? "export function step(frame,state,intent) { return null; }"
          : source,
      card,
      dependencies: [],
    });
  }
  admit(
    skill: SkillRef,
    started: number | null = 0,
    entry: "run" | "step" = "run",
  ) {
    const identity = {
      skill_id: skill.skill_id,
      version: skill.version,
      start_key: crypto.randomUUID(),
      ...executionScopeFixture(this.run),
      args: null,
    };
    const view = this.store.admitSkill(
      this.run.run_id,
      entry === "step"
        ? {
            ...identity,
            entry: "step",
            initial_state: null,
            limits: { ...DEFAULT_RESIDENT_LIMITS },
          }
        : { ...identity, entry: "run", limits: { ...DEFAULT_SKILL_LIMITS } },
    ).view;
    if (started !== null) {
      view.status = "running";
      view.started_at = iso(started);
      at(started, () =>
        this.store.updateSkillExecution(
          view,
          "skill.running",
          "Dispatched fixture ledger",
        ),
      );
    }
    return view;
  }
  close(
    view: SkillExecutionView,
    ended = 40,
    status: "unknown" | "failed" | "cancelled" = "unknown",
  ) {
    view.status = status;
    view.ended_at = iso(ended);
    view.result = null;
    view.error = "Retained uncertain outcome";
    return at(ended, () =>
      this.store.updateSkillExecution(
        view,
        "skill.closed",
        "Closed fixture ledger",
      ),
    );
  }
  authority(owner: SkillExecutionView) {
    return {
      scope: {
        run_id: this.run.run_id,
        world_id: this.run.world_id,
        epoch: owner.epoch,
        session_id: owner.session_id!,
        native_boot_id: owner.native_boot_id!,
        run_generation: owner.run_generation!,
        life_id: owner.life_id!,
        space_epoch: owner.space_epoch!,
        execution_id: owner.execution_id,
        source_hash: owner.source_hash!,
      },
      invocation: {
        kind: "skill" as const,
        execution_id: owner.execution_id,
        source_hash: owner.source_hash!,
      },
      compatibility_hash: this.run.compatibility_hash!,
    };
  }
  action(
    owner: SkillExecutionView,
    evidence: Json,
    ended = 10,
    request: GameAction = { kind: "look", yaw: 0, pitch: 0 },
    status: "succeeded" | "unknown" = "succeeded",
  ) {
    const view = this.store.admitAction(
      this.run.run_id,
      crypto.randomUUID(),
      request,
      "skill",
      owner.execution_id,
      this.authority(owner),
    ).action.view;
    view.status = status;
    view.ended_at = iso(ended);
    view.result = { status, summary: "Retained fixture receipt", evidence };
    at(ended, () => this.store.saveAction(this.run.run_id, view));
    return view;
  }
  observation(counts: Record<string, number>, observed = 20, seq = 2) {
    const current = minecraftObservationFixture(adapter, {
      world_id: this.run.world_id,
      session_id: this.run.session_id!,
      epoch: this.run.epoch,
      native_boot_id: this.run.native_boot_id!,
      life: {
        life_id: this.run.life_id!,
        status: "alive",
        can_respawn: false,
        death: null,
      },
      space: {
        dimension_id: "minecraft:overworld",
        space_epoch: this.run.space_epoch!,
      },
      captured_at: iso(observed),
      observation_seq: seq,
    });
    current.data.player.inventory = Object.entries(counts).map(
      ([name, count], slot) => ({ name, display_name: name, count, slot }),
    );
    return current;
  }
  possession(
    owner: SkillExecutionView,
    counts: Record<string, number>,
    observed = 20,
    seq = 2,
  ) {
    const fact = observationEvidence(
      adapter,
      this.authority(owner).scope,
      this.observation(counts, observed, seq),
    );
    at(observed, () =>
      this.store.event(
        this.run.run_id,
        "adapter.evidence",
        "Retained possession",
        jsonSchema.parse(fact),
      ),
    );
    return fact;
  }
  effects(
    owner: SkillExecutionView,
    receipt: ActionView,
    request: GameAction,
    retain = true,
  ) {
    const facts = adapter.effectEvidence!(
      this.authority(owner).scope,
      receipt.action_id,
      request,
      receipt.result!,
      receipt.ended_at!,
    );
    if (retain)
      for (const fact of facts)
        at(Date.parse(receipt.ended_at!) - EPOCH + 1, () =>
          this.store.event(
            this.run.run_id,
            "adapter.evidence",
            "Retained typed effect",
            jsonSchema.parse(fact),
          ),
        );
    return facts;
  }
  verdict(facts: Parameters<typeof adapter.verifyCompletion>[1], offset = 30) {
    if (typeof this.run.goal === "string")
      throw new Error("Typed goal required");
    const verdict = adapter.verifyCompletion(
      {
        goal: this.run.goal,
        run_id: this.run.run_id,
        world_id: this.run.world_id,
        session_id: this.run.session_id!,
        epoch: this.run.epoch,
        native_boot_id: this.run.native_boot_id!,
        baseline: this.run.baseline,
      },
      facts,
    );
    expect(verdict.status).toBe("verified");
    const event = at(offset, () =>
      this.store.event(
        this.run.run_id,
        "goal.verified",
        "Registered typed verdict",
        jsonSchema.parse(verdict),
      ),
    );
    return event;
  }
  async prepare() {
    await this.learning.prepareFeedback(this.run.run_id, options());
  }
  async reopen() {
    await this.reader.close();
    this.store.close();
    this.store = new Store(join(this.directory, "runs"));
    this.reader = new HistoryReader(this.store.readLocation());
    this.learning = new ImprovementLearning(this.store, this.reader);
    this.manager = this.makeManager();
  }
  async feedback(after = initialCursor(), limit = 100) {
    return this.reader.query(
      { kind: "operator_feedback", run_id: this.run.run_id, after, limit },
      options(),
    );
  }
  async published() {
    const beforeClock = Math.floor(performance.timeOrigin + performance.now());
    const page = await this.reader.query(
      {
        kind: "operator_evidence",
        run_id: this.run.run_id,
        after: 0,
        limit: 100,
      },
      options(),
    );
    const records = [...page.records];
    let continuation = page;
    while (continuation.has_more) {
      continuation = await this.reader.query(
        {
          kind: "operator_evidence",
          run_id: this.run.run_id,
          after: continuation.next_after,
          limit: 100,
        },
        options(),
      );
      expect(continuation.projection).toEqual(page.projection);
      expect(continuation.omissions).toEqual([]);
      records.push(...continuation.records);
    }
    const afterClock = Math.ceil(performance.timeOrigin + performance.now());
    expect(records).toHaveLength(page.total);
    expect(page.omissions).toEqual([]);
    expect(page.projection.has_pending).toBe(false);
    const generation = this.store.historyProjectionGeneration(
      this.run.run_id,
      page.projection.generation,
    )!;
    expect(generation.source_through).toBe(page.projection.source_through);
    const snapshot = this.store.historySnapshot(
      this.run.run_id,
      generation.source_through,
    );
    const expected = programEvidence(snapshot, this.run.run_id);
    const objective = objectiveMetrics(snapshot, this.run.run_id);
    expect(records.map((row) => row.execution_id)).toEqual(
      expected.map((row) => row.execution_id),
    );
    for (const row of records) {
      const oracle = expected.find(
        (value) => value.execution_id === row.execution_id,
      )!;
      const execution = snapshot.skillExecution(this.run.run_id, {
        execution_id: row.execution_id,
      })!;
      const fixedClockRead = readProjectedProgramEvidence(
        this.store,
        this.run.run_id,
        row.execution_id,
        generation.generation,
      );
      expect(fixedClockRead).toEqual(oracle);
      if (execution.started_at && !execution.ended_at)
        expect(fixedClockRead!.duration_ms).toBe(
          QUERY_TIME - Date.parse(execution.started_at),
        );
      // Only active duration is a wall-clock read, not persisted descriptive state.
      if (execution.started_at && !execution.ended_at) {
        expect(row.duration_ms!).toBeGreaterThanOrEqual(
          Math.max(0, beforeClock - Date.parse(execution.started_at)),
        );
        expect(row.duration_ms!).toBeLessThanOrEqual(
          Math.max(0, afterClock - Date.parse(execution.started_at)),
        );
        expect({ ...row, duration_ms: oracle.duration_ms }).toEqual(oracle);
      } else expect(row).toEqual(oracle);
      expect(row.metrics).toEqual(
        objective.find((metric) => metric.execution_id === row.execution_id)!,
      );
    }
    const checkpoint = this.store.historyProjectionCheckpoint(this.run.run_id);
    const sourceThrough = this.store.historySourceHighwater(this.run.run_id);
    const opportunities = this.store.evidenceObjects<ImprovementOpportunity>(
      this.run.run_id,
      "opportunity",
    );
    const named = await this.reader.query(
      {
        kind: "model_inspect",
        run_id: this.run.run_id,
        input: { view: "history", after: 0, limit: 100 },
      },
      options(),
    );
    expect(named).toMatchObject({
      total: page.total,
      projection: page.projection,
    });
    if (
      !named ||
      typeof named !== "object" ||
      Array.isArray(named) ||
      !Array.isArray(named.records)
    )
      throw new Error("Named history did not retain its record page");
    expect(named.records.length).toBeGreaterThan(0);
    expect(named.records).toMatchObject(
      records.slice(0, named.records.length).map((row) => {
        const {
          execution_id: _execution,
          root_execution_id: _root,
          ...metric
        } = row.metrics;
        return {
          status: row.status,
          actions: row.actions,
          calls: row.calls,
          strategic_requests: row.strategic_requests,
          confirmed_effects: row.confirmed_effects,
          evidence_status: row.evidence_status,
          verified_event_seqs: row.verified_event_seqs,
          ...(row.status === "running" ? {} : { duration_ms: row.duration_ms }),
          metrics: metric,
          goal_associations: row.goal_associations.map(
            ({ action_id: _action, controller_input, ...association }) => ({
              ...association,
              ...(controller_input
                ? {
                    controller_input: {
                      generation: controller_input.generation,
                      sequence: controller_input.sequence,
                    },
                  }
                : {}),
            }),
          ),
        };
      }),
    );
    expect(this.store.historyProjectionCheckpoint(this.run.run_id)).toEqual(
      checkpoint,
    );
    expect(this.store.historySourceHighwater(this.run.run_id)).toBe(
      sourceThrough,
    );
    expect(this.store.evidenceObjects(this.run.run_id, "opportunity")).toEqual(
      opportunities,
    );
    return records;
  }
}
const resources: EvidenceFixture[] = [];
afterEach(async () => {
  try {
    for (const f of resources.splice(0)) {
      try {
        await f.reader.close();
      } finally {
        f.store.close();
        rmSync(f.directory, { recursive: true, force: true });
      }
    }
  } finally {
    setSystemTime();
  }
});
function measured(rows: DetailedProgramEvidence[], owner: SkillExecutionView) {
  return rows.find((row) => row.execution_id === owner.execution_id)!;
}
function expectNoFiniteAction(row: DetailedProgramEvidence) {
  expect(row.confirmed_effects).toBe(0);
  expect(row.metrics.inventory_delta).toEqual({});
  expect(row.metrics.inventory_receipts).toBe(0);
  expect(row.metrics.confirmed_block_removals).toBe(0);
  expect(row.metrics.removed_blocks).toEqual({});
  expect(row.metrics.motion_receipts).toBe(0);
  expect(row.metrics.evidence_event_seqs).toEqual([]);
}
test("imported resident realm receipts retain goal attribution after a newer library and Store reopen", async () => {
  const f = new EvidenceFixture("craft_crafting_table");
  const library = await f.manager.register(f.run.run_id, { entry: "library", name: "pure receipt helper",
    source: "export function step(frame,state,intent) { return null; }", card, dependencies: [] });
  const root = await f.manager.register(f.run.run_id, { entry: "step", name: "imported resident",
    source: 'export { step } from "./helper.js";', card,
    dependencies: [{ skill_id: library.skill_id, version: library.version, import_path: "./helper.js" }] });
  const owner = f.admit(root, 0, "step");
  expect(owner.source_hash).not.toBe(root.hash);
  const facts = at(10, () => retainResidentReceipt(f.store, adapter, owner, screenInput, residentUpdate));
  const read = f.possession(owner, { crafting_table: 1 }), goal = f.verdict([...facts, read]);
  f.close(owner);
  await f.manager.register(f.run.run_id, { entry: "library", name: library.name,
    source: "export function step(frame,state,intent) { return state; }", card, dependencies: [] });
  await f.reopen(); await f.prepare();
  const evidence = measured(await f.published(), owner);
  expect(evidence).toMatchObject({ evidence_status: "verified_goal", verified_event_seqs: [goal.event_seq],
    goal_associations: [expect.objectContaining({ relationship: "direct_receipt",
      controller_input: { input_id: `controller:${owner.execution_id}:1:7`, generation: 1, sequence: 7 } })] });
  expectNoFiniteAction(evidence);
});

for (const reopenBefore of [false, true]) {
  test(`incremental evidence interval backdating, inclusive close and duplicate request IDs (reopen=${reopenBefore})`, async () => {
    const f = new EvidenceFixture(),
      skill = await f.authored();
    const pending = f.admit(skill, null),
      overlapping = f.admit(skill, 0);
    for (const offset of [10, 15, 20])
      at(offset, () =>
        f.store.event(
          f.run.run_id,
          "model.call",
          "Distinct call with repeated request identity",
          { backend: "strategic", request_id: "same-request" },
        ),
      );
    at(12, () =>
      f.store.event(f.run.run_id, "model.call", "Jev is not strategic", {
        backend: "jev",
        request_id: "same-request",
      }),
    );
    await f.prepare();
    let rows = await f.published();
    expect(measured(rows, pending)).toMatchObject({
      strategic_requests: 0,
      duration_ms: null,
      status: "accepted",
      evidence_status: "unknown",
    });
    expect(measured(rows, overlapping).strategic_requests).toBe(3);
    if (reopenBefore) await f.reopen();
    pending.status = "running";
    pending.started_at = iso(0);
    f.store.updateSkillExecution(
      pending,
      "skill.running",
      "Backdated dispatch",
    );
    await f.prepare();
    rows = await f.published();
    expect(measured(rows, pending)).toMatchObject({
      strategic_requests: 3,
      status: "running",
      evidence_status: "unknown",
    });
    expect(measured(rows, overlapping).strategic_requests).toBe(3);
    f.close(pending, 15);
    await f.prepare();
    rows = await f.published();
    expect(measured(rows, pending)).toMatchObject({
      strategic_requests: 2,
      duration_ms: 15,
      status: "unknown",
      evidence_status: "unknown",
    });
    expect(measured(rows, overlapping).strategic_requests).toBe(3);
    await f.reopen();
    expect(measured(await f.published(), pending)).toMatchObject({
      strategic_requests: 2,
      duration_ms: 15,
      status: "unknown",
    });
  });
}

for (const reopenBefore of [false, true]) {
  test(`comparison pins unknown eligibility across older completion and reopen (reopen=${reopenBefore})`, async () => {
    const f = new EvidenceFixture(),
      before = await f.authored("compared");
    const older = f.admit(before),
      younger = f.admit(before);
    f.close(younger);
    const after = await f.manager.register(f.run.run_id, {
      entry: "run",
      name: before.name,
      source:
        'return {status:"blocked",summary:"Another descriptive sample",result:null};',
      card,
      dependencies: [],
    });
    const newer = f.admit(after);
    f.close(newer);
    const undispatched = f.admit(after, null);
    f.close(undispatched, 40, "cancelled");
    await f.prepare();
    await f.published();
    const beforeRef: ProgramVersionEvidence = {
      run_id: f.run.run_id,
      skill_id: before.skill_id,
      version: before.version,
      hash: before.hash,
    };
    const afterRef: ProgramVersionEvidence = {
      run_id: f.run.run_id,
      skill_id: after.skill_id,
      version: after.version,
      hash: after.hash,
    };
    const first = await f.reader.query(
      {
        kind: "operator_comparison",
        run_id: f.run.run_id,
        before: beforeRef,
        after: afterRef,
        after_sample: null,
        limit: 1,
      },
      options(),
    );
    expect(first.comparison).toMatchObject({
      sample_count: { before: 1, after: 1 },
      conclusion: "descriptive_only_no_causal_improvement_claim",
    });
    expect(
      first.comparison.samples.before.map((metric) => metric.execution_id),
    ).toEqual([younger.execution_id]);
    expect(first.comparison.samples.before[0]!.outcome).toBe("unknown");
    expect(first.comparison.samples.after).toEqual([]);
    expect(first.has_more).toBe(true);
    const modelFirst = await f.reader.query(
      {
        kind: "model_inspect",
        run_id: f.run.run_id,
        input: {
          view: "comparison",
          before: { name: before.name, version: before.version },
          after: { name: after.name, version: after.version },
          after_sample: null,
          limit: 1,
        },
      },
      options(),
    );
    expect(modelFirst).toMatchObject({
      comparison: {
        sample_count: { before: 1, after: 1 },
        samples: { before: [{ outcome: "unknown" }], after: [] },
        conclusion: "descriptive_only_no_causal_improvement_claim",
      },
    });
    if (reopenBefore) await f.reopen();
    f.close(older, 50);
    await f.prepare();
    await f.published();
    await f.reopen();
    const continued = await f.reader.query(
      {
        kind: "operator_comparison",
        run_id: f.run.run_id,
        before: beforeRef,
        after: afterRef,
        after_sample: first.next_after,
        limit: 1,
      },
      options(),
    );
    expect(continued.comparison.sample_count).toEqual({ before: 1, after: 1 });
    expect(continued.comparison.samples.before).toEqual([]);
    expect(
      continued.comparison.samples.after.map((metric) => metric.execution_id),
    ).toEqual([newer.execution_id]);
    expect(continued.has_more).toBe(false);
    expect(continued.next_after.before_generation).toBe(
      first.next_after.before_generation,
    );
    expect(continued.next_after.after_generation).toBe(
      first.next_after.after_generation,
    );
    expect(continued.next_after.offset).toBe(2);
    for (const [page, side, version, generationId] of [
      [first, "before", before, first.next_after.before_generation],
      [continued, "after", after, first.next_after.after_generation],
    ] as const) {
      const generation = f.store.historyProjectionGeneration(
        f.run.run_id,
        generationId,
      )!;
      const snapshot = f.store.historySnapshot(
        f.run.run_id,
        generation.source_through,
      );
      const eligible = snapshot
        .allSkillExecutions(f.run.run_id)
        .filter(
          (execution) =>
            execution.skill_id === version.skill_id &&
            execution.version === version.version &&
            execution.started_at !== null &&
            execution.ended_at !== null,
        );
      expect(eligible.map((execution) => execution.execution_id)).toEqual([
        side === "before" ? younger.execution_id : newer.execution_id,
      ]);
      const oracle = objectiveMetrics(snapshot, f.run.run_id);
      for (const metric of page.comparison.samples[side])
        expect(metric).toEqual(
          oracle.find((value) => value.execution_id === metric.execution_id)!,
        );
    }
    if (
      !modelFirst ||
      typeof modelFirst !== "object" ||
      Array.isArray(modelFirst) ||
      !modelFirst.next_after
    )
      throw new Error("Named comparison lacks pinned continuation");
    const modelContinued = await f.reader.query(
      {
        kind: "model_inspect",
        run_id: f.run.run_id,
        input: {
          view: "comparison",
          before: { name: before.name, version: before.version },
          after: { name: after.name, version: after.version },
          after_sample:
            modelFirst.next_after as unknown as typeof first.next_after,
          limit: 1,
        },
      },
      options(),
    );
    expect(modelContinued).toMatchObject({
      comparison: {
        sample_count: { before: 1, after: 1 },
        samples: { before: [], after: [{ outcome: "unknown" }] },
      },
      has_more: false,
    });
    const fresh = await f.reader.query(
      {
        kind: "operator_comparison",
        run_id: f.run.run_id,
        before: beforeRef,
        after: afterRef,
        after_sample: null,
        limit: 100,
      },
      options(),
    );
    expect(fresh.comparison.sample_count).toEqual({ before: 2, after: 1 });
    expect(
      fresh.comparison.samples.before.map((metric) => metric.execution_id),
    ).toEqual([older.execution_id, younger.execution_id]);
    expect(
      fresh.comparison.samples.after.map((metric) => metric.execution_id),
    ).toEqual([newer.execution_id]);
    expect(
      [
        ...fresh.comparison.samples.before,
        ...fresh.comparison.samples.after,
      ].some((metric) => metric.execution_id === undispatched.execution_id),
    ).toBe(false);
    const freshGeneration = f.store.historyProjectionGeneration(
      f.run.run_id,
      fresh.next_after.before_generation,
    )!;
    const freshOracle = objectiveMetrics(
      f.store.historySnapshot(f.run.run_id, freshGeneration.source_through),
      f.run.run_id,
    );
    for (const metric of [
      ...fresh.comparison.samples.before,
      ...fresh.comparison.samples.after,
    ])
      expect(metric).toEqual(
        freshOracle.find(
          (value) => value.execution_id === metric.execution_id,
        )!,
      );
    await expect(
      f.reader.query(
        {
          kind: "operator_comparison",
          run_id: f.run.run_id,
          before: { ...beforeRef, hash: "f".repeat(64) },
          after: afterRef,
          after_sample: null,
          limit: 1,
        },
        options(),
      ),
    ).rejects.toThrow();
    // A cursor is bound to exact versions, not just an interchangeable numeric offset.
    await expect(
      f.reader.query(
        {
          kind: "operator_comparison",
          run_id: f.run.run_id,
          before: afterRef,
          after: beforeRef,
          after_sample: first.next_after,
          limit: 1,
        },
        options(),
      ),
    ).rejects.toThrow();
  });
}

test("same-model authorization rejects foreign comparison before any artifact hydration", async () => {
  const f = new EvidenceFixture(),
    own = await f.authored("own");
  f.close(f.admit(own));
  await f.prepare();
  const foreign: StoredRun = {
    ...f.run,
    run_id: crypto.randomUUID(),
    model_id: "different-model",
  };
  f.store.saveRun(foreign);
  const left = await f.manager.register(foreign.run_id, {
    entry: "run",
    name: "foreign",
    source,
    card,
    dependencies: [],
  });
  const right = await f.manager.register(foreign.run_id, {
    entry: "run",
    name: "foreign",
    source: 'return {status:"blocked",summary:"Foreign revision",result:null};',
    card,
    dependencies: [],
  });
  await f.learning.prepareFeedback(foreign.run_id, options());
  const leftRef = {
    run_id: foreign.run_id,
    skill_id: left.skill_id,
    version: left.version,
    hash: left.hash,
  };
  const rightRef = {
    run_id: foreign.run_id,
    skill_id: right.skill_id,
    version: right.version,
    hash: right.hash,
  };
  const hydrate = f.store.skill.bind(f.store);
  let foreignReads = 0;
  f.store.skill = (runId, ref) => {
    if (runId === foreign.run_id) foreignReads++;
    return hydrate(runId, ref);
  };
  try {
    expect(() =>
      compareProgramVersionsPage(
        f.store,
        leftRef,
        rightRef,
        { kind: "model", run_id: f.run.run_id, model_id: f.run.model_id },
        null,
        1,
      ),
    ).toThrow("requesting model scope");
    expect(foreignReads).toBe(0);
  } finally {
    f.store.skill = hydrate;
  }
  const operator = await f.reader.query(
    {
      kind: "operator_comparison",
      run_id: foreign.run_id,
      before: leftRef,
      after: rightRef,
      after_sample: null,
      limit: 1,
    },
    options(),
  );
  expect(operator.comparison).toMatchObject({
    sample_count: { before: 0, after: 0 },
    conclusion: "descriptive_only_no_causal_improvement_claim",
  });
  const ownRef = {
    run_id: f.run.run_id,
    skill_id: own.skill_id,
    version: own.version,
    hash: own.hash,
  };
  expect(() =>
    compareProgramVersionsPage(
      f.store,
      ownRef,
      rightRef,
      { kind: "operator" },
      null,
      1,
    ),
  ).toThrow("same-model");
  await expect(
    f.reader.query(
      {
        kind: "operator_comparison",
        run_id: f.run.run_id,
        before: ownRef,
        after: rightRef,
        after_sample: null,
        limit: 1,
      },
      options(),
    ),
  ).rejects.toThrow();
});

for (const reopenBefore of [false, true]) {
  test(`exact parent discovery beyond 256 and durable named-write retry (reopen=${reopenBefore})`, async () => {
    const f = new EvidenceFixture(),
      parent = await f.authored("exact parent"),
      other = await f.authored("unrelated");
    const firstParent = f.admit(parent);
    f.close(firstParent, 40, "failed");
    for (let index = 0; index < 255; index++)
      f.close(f.admit(other), 40, "failed");
    // The newest catalog version must not substitute for the explicitly selected parent.
    await f.manager.register(f.run.run_id, {
      entry: "run",
      name: other.name,
      source:
        'return {status:"blocked",summary:"Unrelated newer version",result:null};',
      card,
      dependencies: [],
    });
    const latestParent = f.admit(parent);
    await f.prepare();
    expect(
      f.store.evidenceObjects<ImprovementOpportunity>(
        f.run.run_id,
        "opportunity",
      ),
    ).toHaveLength(256);
    if (reopenBefore) await f.reopen();
    f.close(latestParent, 50, "failed");
    // Find by retained identity, not an assumed contiguous terminal sequence.
    let eventCursor = 0,
      closeEvent: ReturnType<Store["eventsAfter"]>[number] | undefined;
    while (!closeEvent) {
      const page = f.store.eventsAfter(f.run.run_id, eventCursor, 500);
      closeEvent = page.find(
        (event) =>
          event.type === "skill.closed" &&
          event.details &&
          typeof event.details === "object" &&
          !Array.isArray(event.details) &&
          event.details.execution_id === latestParent.execution_id,
      );
      if (!page.length) break;
      eventCursor = page.at(-1)!.event_seq;
    }
    if (!closeEvent)
      throw new Error("Latest exact-parent closure not retained");
    await f.prepare();
    const evidence = measured(await f.published(), latestParent);
    expect(evidence).toMatchObject({
      status: "failed",
      evidence_status: "unknown",
      confirmed_effects: 0,
      goal_associations: [],
    });
    expectNoFiniteAction(evidence);
    const workspace = new ProgramWorkspace(f.store, f.run.run_id),
      selected = workspace.latestOpportunity(
        f.store.skill(f.run.run_id, parent),
      );
    expect(selected).toMatchObject({
      execution_id: latestParent.execution_id,
      event_seqs: [closeEvent.event_seq],
      version: {
        run_id: f.run.run_id,
        skill_id: parent.skill_id,
        version: parent.version,
        hash: parent.hash,
      },
    });
    expect(
      f.store.evidenceObjects<ImprovementOpportunity>(
        f.run.run_id,
        "opportunity",
      ),
    ).toHaveLength(257);
    let cursor = initialCursor(),
      hasMore = true;
    const opportunityIds: string[] = [];
    for (let pageNumber = 0; hasMore && pageNumber < 100; pageNumber++) {
      const page = await f.feedback(cursor, 32);
      expect(page.opportunities.length).toBeLessThanOrEqual(32);
      expect(page.metrics.length).toBeLessThanOrEqual(32);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
        65536,
      );
      expect(page.omitted).toEqual([]);
      opportunityIds.push(
        ...page.opportunities.map((value) => value.opportunity_id),
      );
      if (page.has_more)
        expect(
          page.next_after.opportunity_change_seq >
            cursor.opportunity_change_seq ||
            page.next_after.metric_change_seq > cursor.metric_change_seq,
        ).toBe(true);
      cursor = page.next_after;
      hasMore = page.has_more;
    }
    expect(hasMore).toBe(false);
    expect(opportunityIds).toHaveLength(257);
    expect(new Set(opportunityIds).size).toBe(257);
    expect(opportunityIds).toContain(selected.opportunity_id);
    const named = await f.reader.query(
      {
        kind: "model_inspect",
        run_id: f.run.run_id,
        input: {
          view: "feedback",
          program: { name: parent.name, version: parent.version },
          after: initialCursor(),
          limit: 100,
        },
      },
      options(),
    );
    const firstOrdinal = f.store.executionReferences(
      f.run.run_id,
      firstParent.execution_id,
    )[0]!.execution_ordinal;
    const latestOrdinal = f.store.executionReferences(
      f.run.run_id,
      latestParent.execution_id,
    )[0]!.execution_ordinal;
    expect(latestOrdinal).toBeGreaterThan(256);
    expect(named).toMatchObject({
      has_more: false,
      opportunities: [
        { execution_ordinal: firstOrdinal, event_seqs: expect.any(Array) },
        {
          execution_ordinal: latestOrdinal,
          event_seqs: [closeEvent.event_seq],
        },
      ],
    });
    // Exercise the real named write implementation. The commit fence fails only
    // after immutable source registration, leaving the existing exact feedback binding durable.
    const host: RuntimeToolHost = {
      run: () => f.run,
      assertCurrent: (generation) => {
        if (generation !== 1 || f.run.status !== "running")
          throw new Error("Fixture authority revoked");
        return f.run;
      },
      observe: async () => f.observation({}, 0),
      adapter: () => adapter,
      generation: () => 1,
      attentionAfter: () => {
        throw new Error("Named write cannot schedule attention");
      },
      admitted: () => {
        throw new Error("Named write cannot admit execution");
      },
      history: () => f.reader,
      planning: () => {
        throw new Error("Named write cannot schedule a plan");
      },
      learning: () => f.learning,
      toolAuthority: () => () => {
        if (f.run.status !== "running")
          throw new Error("Fixture authority revoked");
      },
      finishTask: () => {
        throw new Error("Named write cannot finish a task");
      },
    };
    const writeInput = programWriteSchema.parse({
      entry: "run",
      name: parent.name,
      based_on: parent.version,
      source:
        'return {status:"blocked",summary:"Unmeasured candidate",result:null};',
      card,
      dependencies: [],
      reason: "Candidate addressing the exact latest retained parent outcome",
    });
    const callId = "pinned-beyond-256";
    const operations = new ProgramOperations(
      f.store,
      f.manager,
      {} as ReactiveRuntime,
      null,
      host,
      f.run,
    );
    await expect(
      operations.write(writeInput, callId, () => {
        if (f.store.namedSkill(f.run.run_id, parent.name, 2))
          throw new Error("Lost acknowledgement after immutable registration");
      }),
    ).rejects.toThrow("Lost acknowledgement");
    expect(
      f.store.namedSkill(f.run.run_id, parent.name, 2)?.parent_version,
    ).toBe(1);
    const newer = f.admit(parent);
    f.close(newer, 60, "failed");
    await f.prepare();
    await f.published();
    expect(
      new ProgramWorkspace(f.store, f.run.run_id).latestOpportunity(
        f.store.skill(f.run.run_id, parent),
      ).execution_id,
    ).toBe(newer.execution_id);
    await f.reopen();
    const retryCheckpoint = f.store.historyProjectionCheckpoint(f.run.run_id);
    const retryOperations = new ProgramOperations(
      f.store,
      f.manager,
      {} as ReactiveRuntime,
      null,
      host,
      f.run,
    );
    const retried = await retryOperations.write(writeInput, callId, () =>
      host.assertCurrent(1),
    );
    expect(retried).toMatchObject({
      name: parent.name,
      version: 2,
      experiment: {
        decision: "revise",
        measured: false,
        reason: writeInput.reason,
        qualification: "candidate_not_proven_improvement",
      },
    });
    expect(f.store.historyProjectionCheckpoint(f.run.run_id)).toEqual(
      retryCheckpoint,
    );
    expect(
      f.store.opportunity(f.run.run_id, selected.opportunity_id)?.resolution,
    ).toMatchObject({
      decision: "revise",
      revision: { skill_id: parent.skill_id, version: 2 },
      event_seqs: [closeEvent.event_seq],
      measured: false,
    });
    const latest = new ProgramWorkspace(
      f.store,
      f.run.run_id,
    ).latestOpportunity(f.store.skill(f.run.run_id, parent));
    expect(latest.execution_id).toBe(newer.execution_id);
    expect(latest.resolution).toBeNull();
    const retained = f.store.evidenceObjects<ImprovementOpportunity>(
      f.run.run_id,
      "opportunity",
    );
    expect(
      await retryOperations.write(writeInput, callId, () =>
        host.assertCurrent(1),
      ),
    ).toEqual(retried);
    expect(
      f.store.evidenceObjects<ImprovementOpportunity>(
        f.run.run_id,
        "opportunity",
      ),
    ).toEqual(retained);
    await f.prepare();
    await f.published();
    await f.reopen();
    expect(
      new ProgramWorkspace(f.store, f.run.run_id).latestOpportunity(
        f.store.skill(f.run.run_id, parent),
      ).execution_id,
    ).toBe(newer.execution_id);
    expect(
      f.store.opportunity(f.run.run_id, selected.opportunity_id)?.resolution
        ?.revision?.version,
    ).toBe(2);
  }, 180_000);
}

for (const workLimit of [1, 2]) {
  test(`publication rollback keeps live cursors and opportunity generation atomic (work_limit=${workLimit})`, async () => {
    const f = new EvidenceFixture(),
      owner = f.admit(await f.authored());
    await f.prepare();
    const initial = await f.feedback();
    expect(initial.metrics[0]).toMatchObject({ kind: "replace", metric: { outcome: "running" } });
    f.close(owner);
    const desired = f.store.historySourceHighwater(f.run.run_id);
    let checkpoint = f.store.beginHistoryProjection(f.run.run_id, desired);
    let publishing: HistoryProjectionBatch | null = null;
    for (let step = 0; step < 2000; step++) {
      const batch = await f.reader.query(
        {
          kind: "projection_batch",
          run_id: f.run.run_id,
          checkpoint,
          work_limit: workLimit,
        },
        options(),
      );
      expect(batch.patches.length).toBeLessThanOrEqual(64);
      expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThanOrEqual(
        65536,
      );
      if (
        batch.patches.some(
          (patch) =>
            patch.type === "delete" &&
            patch.collection === "pending_opportunity",
        )
      ) {
        publishing = batch;
        break;
      }
      f.store.commitHistoryProjectionBatch(f.run.run_id, batch);
      checkpoint = batch.after;
      if (!batch.has_more)
        throw new Error("Closure published without its failure opportunity");
    }
    if (!publishing)
      throw new Error(
        "Bounded projection did not reach opportunity publication",
      );
    const db = new Database(f.store.readLocation().database);
    try {
      const rowsBefore = db
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM history_projection_rows WHERE run_id=?",
        )
        .get(f.run.run_id)!.count;
      db.exec(
        "CREATE TRIGGER evidence_projection_rollback BEFORE UPDATE ON history_projection_checkpoints BEGIN SELECT RAISE(ABORT,'injected history checkpoint rollback'); END;",
      );
      expect(() =>
        f.store.commitHistoryProjectionBatch(f.run.run_id, publishing!),
      ).toThrow("injected history checkpoint rollback");
      expect(f.store.historyProjectionCheckpoint(f.run.run_id)).toEqual(
        checkpoint,
      );
      expect(
        db
          .query<{ count: number }, [string]>(
            "SELECT COUNT(*) AS count FROM history_projection_rows WHERE run_id=?",
          )
          .get(f.run.run_id)!.count,
      ).toBe(rowsBefore);
      expect(
        f.store.evidenceObjects<ImprovementOpportunity>(
          f.run.run_id,
          "opportunity",
        ),
      ).toEqual([]);
      const pending = await f.feedback(initial.next_after);
      expect(pending).toMatchObject({
        opportunities: [],
        metrics: [],
        projection: {
          generation: initial.projection.generation,
          has_pending: true,
        },
      });
      const old = await f.reader.query(
        { kind: "operator_evidence", run_id: f.run.run_id, after: 0, limit: 1 },
        options(),
      );
      expect(old.records[0]!.metrics.outcome).toBe("running");
      expect(old.projection.generation).toBe(initial.projection.generation);
      db.exec("DROP TRIGGER evidence_projection_rollback;");
    } finally {
      db.close();
    }
    await f.reopen();
    f.store.commitHistoryProjectionBatch(f.run.run_id, publishing);
    expect(() =>
      f.store.commitHistoryProjectionBatch(f.run.run_id, publishing!),
    ).toThrow();
    await f.prepare();
    const finalEvidence = measured(await f.published(), owner),
      delivered = await f.feedback(initial.next_after);
    expect(finalEvidence.status).toBe("unknown");
    expect(delivered.metrics).toHaveLength(1);
    expect(delivered.metrics[0]!.metric).toEqual(finalEvidence.metrics);
    expect(delivered.opportunities).toHaveLength(1);
    expect(delivered.opportunities[0]).toMatchObject({
      kind: "failure",
      execution_id: owner.execution_id,
    });
    expect(delivered.metrics[0]!.generation).toBe(
      delivered.projection.generation,
    );
    await f.reopen();
    const empty = await f.feedback(delivered.next_after);
    expect(empty).toMatchObject({
      opportunities: [],
      metrics: [],
      has_more: false,
    });
    expect(
      f.store.evidenceObjects<ImprovementOpportunity>(
        f.run.run_id,
        "opportunity",
      ),
    ).toHaveLength(1);
  });
}

for (const reopenBefore of [false, true]) {
  test(`live feedback replaces an already emitted running metric, closure and late receipt (reopen=${reopenBefore})`, async () => {
    const f = new EvidenceFixture(),
      owner = f.admit(await f.authored());
    await f.prepare();
    await f.published();
    const emitted = await f.feedback();
    expect(emitted.has_more).toBe(false);
    expect(emitted.opportunities).toEqual([]);
    expect(emitted.metrics.map((row) => row.execution_id)).toEqual([
      owner.execution_id,
    ]);
    expect(emitted.metrics[0]).toMatchObject({ kind: "replace", metric: { outcome: "running" } });
    const runningRevision = emitted.metrics[0]!.revision,
      runningGeneration = emitted.metrics[0]!.generation;
    if (reopenBefore) await f.reopen();
    f.close(owner);
    await f.prepare();
    const closedEvidence = measured(await f.published(), owner);
    const closed = await f.feedback(emitted.next_after);
    expect(closed.has_more).toBe(false);
    expect(closed.opportunities).toHaveLength(1);
    expect(closed.opportunities[0]).toMatchObject({
      kind: "failure",
      execution_id: owner.execution_id,
    });
    expect(closed.metrics).toHaveLength(1);
    expect(closed.metrics[0]).toMatchObject({
      execution_id: owner.execution_id,
      metric: closedEvidence.metrics,
    });
    expect(closed.metrics[0]!.revision).toBeGreaterThan(runningRevision);
    expect(closed.metrics[0]!.generation).toBeGreaterThan(runningGeneration);
    expect(closed.next_after.opportunity_change_seq).toBeGreaterThan(
      emitted.next_after.opportunity_change_seq,
    );
    expect(closed.next_after.metric_change_seq).toBeGreaterThan(
      emitted.next_after.metric_change_seq,
    );
    expect(closed.metrics[0]).toMatchObject({ kind: "replace", metric: { outcome: "unknown" } });
    const receipt = f.action(
      owner,
      {
        effect_confirmed: true,
        inventory_receipt_confirmed: true,
        inventory_before: { stone: 0 },
        inventory_after: { stone: 1 },
      },
      10,
    );
    await f.prepare();
    const receiptedEvidence = measured(await f.published(), owner);
    const receipted = await f.feedback(closed.next_after);
    expect(receipted.opportunities).toEqual([]);
    expect(receipted.metrics).toHaveLength(1);
    expect(receipted.has_more).toBe(false);
    expect(receipted.metrics[0]!.metric).toEqual(receiptedEvidence.metrics);
    expect(receipted.metrics[0]!.metric).toMatchObject({
      outcome: "unknown",
      inventory_delta: { stone: 1 },
      inventory_receipts: 1,
    });
    expect(receipted.metrics[0]!.revision).toBeGreaterThan(
      closed.metrics[0]!.revision,
    );
    expect(receipted.next_after.opportunity_change_seq).toBe(
      closed.next_after.opportunity_change_seq,
    );
    await f.reopen();
    receipt.result!.evidence = {
      effect_confirmed: true,
      inventory_receipt_confirmed: true,
      inventory_before: { stone: 0 },
      inventory_after: { stone: 3 },
    };
    f.store.saveAction(f.run.run_id, receipt);
    await f.prepare();
    const replacedEvidence = measured(await f.published(), owner),
      replacement = await f.feedback(receipted.next_after);
    expect(replacement.metrics).toHaveLength(1);
    expect(replacement.opportunities).toEqual([]);
    expect(replacement.metrics[0]!.metric).toEqual(replacedEvidence.metrics);
    expect(replacement.metrics[0]!.metric).toMatchObject({
      outcome: "unknown",
      inventory_delta: { stone: 3 },
      inventory_receipts: 1,
    });
    expect(replacement.metrics[0]!.revision).toBeGreaterThan(
      receipted.metrics[0]!.revision,
    );
    const named = await f.reader.query(
      {
        kind: "model_inspect",
        run_id: f.run.run_id,
        input: {
          view: "feedback",
          program: { name: "measured", version: 1 },
          after: initialCursor(),
          limit: 100,
        },
      },
      options(),
    );
    expect(named).toMatchObject({
      projection: replacement.projection,
      metrics: [
        {
          generation: runningGeneration,
          metric: { outcome: "running", inventory_delta: {} },
        },
        {
          generation: closed.metrics[0]!.generation,
          metric: { outcome: "unknown", inventory_delta: {} },
        },
        {
          generation: receipted.metrics[0]!.generation,
          metric: { outcome: "unknown", inventory_delta: { stone: 1 } },
        },
        {
          generation: replacement.metrics[0]!.generation,
          metric: { outcome: "unknown", inventory_delta: { stone: 3 } },
        },
      ],
    });
    // Reopening preserves the cursor and makes a drained retry a read, not a new detection pass.
    await f.reopen();
    const checkpoint = f.store.historyProjectionCheckpoint(f.run.run_id);
    const drained = await f.feedback(replacement.next_after);
    expect(drained).toMatchObject({
      opportunities: [],
      metrics: [],
      has_more: false,
      next_after: replacement.next_after,
    });
    expect(f.store.historyProjectionCheckpoint(f.run.run_id)).toEqual(
      checkpoint,
    );
    expect(
      f.store.evidenceObjects<ImprovementOpportunity>(
        f.run.run_id,
        "opportunity",
      ),
    ).toHaveLength(1);
  });
}

function collectorLink(goal: number, action: ActionView) {
  return {
    event_seq: goal,
    relationship: "inventory_collector",
    action_id: action.action_id,
    causal_item_origin: "unknown",
  };
}
function directLink(goal: number, action: ActionView) {
  return {
    event_seq: goal,
    relationship: "direct_receipt",
    action_id: action.action_id,
    causal_item_origin: "unknown",
  };
}
for (const reopenBefore of [false, true]) {
  for (const invalidation of [
    "duplicate possession",
    "retract acquisition",
  ] as const) {
    test(`whole combined verdict and ordered promotion fallback after ${invalidation} (reopen=${reopenBefore})`, async () => {
      const f = new EvidenceFixture("collect_and_craft_table"),
        owner = f.admit(await f.authored());
      const planksRequest: GameAction = {
        kind: "craft",
        item: "oak_planks",
        executions: 1,
      };
      const tableRequest: GameAction = {
        kind: "craft",
        item: "crafting_table",
        executions: 1,
      };
      const planks = f.action(
        owner,
        {
          effect_confirmed: true,
          inventory_receipt_confirmed: true,
          inventory_before: { oak_log: 1 },
          inventory_after: { oak_planks: 4 },
        },
        10,
        planksRequest,
      );
      const planksFacts = f.effects(owner, planks, planksRequest);
      const table = f.action(
        owner,
        {
          effect_confirmed: true,
          inventory_receipt_confirmed: true,
          inventory_before: { oak_planks: 4 },
          inventory_after: { crafting_table: 1 },
        },
        12,
        tableRequest,
      );
      const tableFacts = f.effects(owner, table, tableRequest);
      const possession = f.possession(owner, { crafting_table: 1 });
      // u is a genuine historical verdict under its then-current goal, not a
      // metadata-only claim. The final combined goal uses a different verifier.
      f.run.goal = adapter.goals.find(
        (value) => value.goal_id === "craft_crafting_table",
      )!;
      f.store.saveRun(f.run);
      const u = f.verdict([...tableFacts, possession], 21);
      f.run.goal = adapter.goals.find(
        (value) => value.goal_id === "collect_and_craft_table",
      )!;
      f.store.saveRun(f.run);
      const v = f.store
        .eventsAfter(f.run.run_id, 0, 500)
        .find(
          (event) =>
            event.type === "adapter.evidence" &&
            event.details &&
            typeof event.details === "object" &&
            !Array.isArray(event.details) &&
            event.details.evidence_id === possession.evidence_id,
        )!;
      for (const [offset, kind, reference] of [
        [23, "goal_verified", u.event_seq],
        [24, "inventory_gain", v.event_seq],
        [25, "inventory_gain", v.event_seq],
      ] as const)
        at(offset, () =>
          f.store.event(
            f.run.run_id,
            "experience.promoted",
            "Historical host promotion assignment",
            {
              evidence: {
                execution_id: owner.execution_id,
                predicate: { kind, event_seq: reference },
              },
            },
          ),
        );
      const goal = f.verdict([...planksFacts, ...tableFacts, possession]);
      f.close(owner);
      await f.prepare();
      const original = measured(await f.published(), owner);
      expect(original).toMatchObject({
        status: "unknown",
        confirmed_effects: 2,
        evidence_status: "verified_goal",
        verified_event_seqs: [u.event_seq, v.event_seq, goal.event_seq],
        goal_associations: [
          collectorLink(goal.event_seq, planks),
          directLink(goal.event_seq, table),
        ],
      });
      expect(original.metrics.inventory_delta).toEqual({
        oak_log: -1,
        oak_planks: 0,
        crafting_table: 1,
      });
      expect(original.metrics.inventory_receipts).toBe(2);
      if (reopenBefore) await f.reopen();
      if (invalidation === "duplicate possession")
        at(50, () =>
          f.store.event(
            f.run.run_id,
            "adapter.evidence",
            "Identical ID is still ambiguous",
            jsonSchema.parse(possession),
          ),
        );
      else {
        planks.result!.evidence = {
          effect_confirmed: false,
          inventory_receipt_confirmed: false,
        };
        at(50, () => f.store.saveAction(f.run.run_id, planks));
      }
      await f.prepare();
      const changed = measured(await f.published(), owner);
      expect(changed).toMatchObject({
        status: "unknown",
        evidence_status: "verified_predicate",
        verified_event_seqs: [u.event_seq, v.event_seq],
        goal_associations: [],
      });
      if (invalidation === "duplicate possession") {
        expect(changed.confirmed_effects).toBe(2);
        expect(changed.metrics).toEqual(original.metrics);
      } else {
        expect(changed.confirmed_effects).toBe(1);
        expect(changed.metrics.inventory_delta).toEqual({
          oak_planks: -4,
          crafting_table: 1,
        });
        expect(changed.metrics.inventory_receipts).toBe(1);
        expect(changed.metrics.evidence_event_seqs).toEqual(
          original.metrics.evidence_event_seqs,
        );
      }
      await f.reopen();
      expect(measured(await f.published(), owner)).toEqual(changed);
    });
  }
  test(`late fact cannot retroactively become a pre-verdict receipt (reopen=${reopenBefore})`, async () => {
    const f = new EvidenceFixture("craft_crafting_table"),
      owner = f.admit(await f.authored());
    const request: GameAction = {
      kind: "craft",
      item: "crafting_table",
      executions: 1,
    };
    const receipt = f.action(
      owner,
      {
        effect_confirmed: true,
        inventory_receipt_confirmed: true,
        inventory_before: {},
        inventory_after: { crafting_table: 1 },
      },
      10,
      request,
    );
    const missingFacts = f.effects(owner, receipt, request, false);
    const possession = f.possession(owner, { crafting_table: 1 });
    f.verdict([...missingFacts, possession]);
    f.close(owner);
    await f.prepare();
    expect(measured(await f.published(), owner)).toMatchObject({
      evidence_status: "confirmed_effects",
      confirmed_effects: 1,
      goal_associations: [],
      verified_event_seqs: [],
    });
    if (reopenBefore) await f.reopen();
    for (const fact of missingFacts)
      at(50, () =>
        f.store.event(
          f.run.run_id,
          "adapter.evidence",
          "Old observed_at but late retained event",
          jsonSchema.parse(fact),
        ),
      );
    await f.prepare();
    const changed = measured(await f.published(), owner);
    expect(changed).toMatchObject({
      evidence_status: "confirmed_effects",
      confirmed_effects: 1,
      goal_associations: [],
      verified_event_seqs: [],
    });
    expect(changed.metrics.inventory_delta).toEqual({ crafting_table: 1 });
    await f.reopen();
    expect(measured(await f.published(), owner)).toEqual(changed);
  });
}

const screenInput: ControllerInput = {
  kind: "screen",
  screen: { screen_id: "view", incarnation: 1, layout_revision: 1 },
  operations: [
    {
      kind: "slot",
      slot_id: 0,
      button: "left",
      mode: "ordinary",
      hotbar_slot: null,
      expected_cursor: { item: null, count: 0 },
      expected_slots: [
        { slot_id: 0, value: { item: "crafting_table", count: 1 } },
      ],
    },
    { kind: "close" },
  ],
};
const confirmedPrefix: Json = {
  kind: "gui_transaction",
  mechanism: "visible_gui",
  operation_index: 0,
  receipt_ref: "server:incremental:1",
  input_application: "confirmed",
  effect_status: "confirmed",
  inventory_before: { oak_planks: 4 },
  inventory_after: {},
  productions: [
    {
      producer: "crafting",
      item: "crafting_table",
      count: 1,
      source: "server_result_slot_take",
      production_confirmed: true,
    },
  ],
};
const residentUpdate: ControllerEffectUpdate = {
  controller_generation: 1,
  sequence: 7,
  recorded_native_ns: "123456",
  result: {
    status: "unknown",
    summary: "Confirmed prefix; unknown suffix",
    evidence: {
      effect_confirmed: false,
      transaction_status: "unknown",
      gui_transactions: [confirmedPrefix],
    },
  },
};
function craftStage(
  stage_index: number,
  item: string,
  executions: number,
  output_per_execution: number,
  inventory_before: Record<string, number>,
  inventory_after: Record<string, number>,
  completed_executions = executions,
) {
  return {
    stage_index, item, executions, output_per_execution, completed_executions,
    confirmed_executions: completed_executions,
    status: completed_executions === executions ? "succeeded" : "partial",
    inventory_receipt_confirmed: true, inventory_custody_confirmed: true,
    cursor_count: 0, grid_count: 0,
    receipt_ref: `native-operation:craft:nonce-${stage_index}`,
    inventory_before, inventory_after,
  };
}
for (const product of ["crafting_table", "stone_pickaxe", "iron_pickaxe"]) {
  test(`native single-stage ${product} production links its enclosing action`, async () => {
    const goalId = product === "crafting_table" ? "craft_crafting_table" : `craft_${product}`;
    const f = new EvidenceFixture(goalId),
      owner = f.admit(await f.authored());
    const request: GameAction = { kind: "craft", item: product, executions: 1 };
    const receipt = f.action(owner, {
      effect_confirmed: true,
      craft_stages: [craftStage(0, product, 1, 1, {}, { [product]: 1 })],
    }, 10, request);
    const facts = f.effects(owner, receipt, request),
      read = f.possession(owner, { [product]: 1 }),
      goal = f.verdict([...facts, read]);
    f.close(owner);
    await f.prepare();
    const projected = measured(await f.published(), owner);
    expect(projected).toMatchObject({
      evidence_status: "verified_goal", confirmed_effects: 1,
      goal_associations: [directLink(goal.event_seq, receipt)],
      verified_event_seqs: [goal.event_seq],
    });
    expect(projected.metrics.inventory_delta).toEqual({ [product]: 1 });
    expect(projected.metrics.inventory_receipts).toBe(1);
  });
}
for (const interrupted of [false, true]) {
  test(`native combined craft ${interrupted ? "unknown prefix" : "full sequence"} retains consumed intermediate production`, async () => {
    const f = new EvidenceFixture("collect_and_craft_table"),
      owner = f.admit(await f.authored());
    const request: GameAction = {
      kind: "craft", sequence: [
        { item: "oak_planks", executions: 1 },
        { item: "crafting_table", executions: 1 },
        ...(interrupted ? [{ item: "stick", executions: 1 }] : []),
      ],
    };
    const stages = [
      craftStage(0, "oak_planks", 1, 4, { oak_log: 1 }, { oak_planks: 4 }),
      craftStage(1, "crafting_table", 1, 1, { oak_planks: 4 }, { crafting_table: 1 }),
    ];
    const receipt = f.action(owner, {
      effect_confirmed: !interrupted, craft_stages: stages,
      ...(!interrupted ? {
        inventory_receipt_confirmed: true,
        inventory_before: { oak_log: 1 }, inventory_after: { crafting_table: 1 },
      } : {}),
    }, 10, request, interrupted ? "unknown" : "succeeded");
    const facts = f.effects(owner, receipt, request),
      read = f.possession(owner, { crafting_table: 1 }),
      goal = f.verdict([...facts, read]);
    f.close(owner);
    await f.prepare();
    const original = measured(await f.published(), owner);
    expect(original).toMatchObject({
      status: "unknown", confirmed_effects: interrupted ? 0 : 1,
      evidence_status: "verified_goal",
      goal_associations: [directLink(goal.event_seq, receipt)],
      verified_event_seqs: [goal.event_seq],
    });
    expect(original.metrics.inventory_delta).toEqual({ oak_log: -1, oak_planks: 0, crafting_table: 1 });
    expect(original.metrics.inventory_receipts).toBe(1);
    expect(actionMetrics([{ request, view: receipt }])).toMatchObject({
      count: 1, inventory_receipts: 1,
      inventory_delta: { oak_log: -1, oak_planks: 0, crafting_table: 1 },
      uncertain_outcomes: interrupted ? 1 : 0,
    });
    await f.reopen();
    receipt.result!.evidence = { effect_confirmed: !interrupted, craft_stages: [] };
    at(50, () => f.store.saveAction(f.run.run_id, receipt));
    await f.prepare();
    const changed = measured(await f.published(), owner);
    expect(changed).toMatchObject({
      status: "unknown", confirmed_effects: interrupted ? 0 : 1,
      evidence_status: interrupted ? "unknown" : "confirmed_effects",
      goal_associations: [], verified_event_seqs: [],
    });
    expect(changed.metrics.inventory_delta).toEqual({});
    expect(changed.metrics.inventory_receipts).toBe(0);
    await f.reopen();
    expect(measured(await f.published(), owner)).toEqual(changed);
  });
}
for (const partialStage of [false, true]) {
  test(`native ${partialStage ? "partially completed stage" : "completed first stage"} credits no unknown suffix`, async () => {
    const f = new EvidenceFixture(),
      owner = f.admit(await f.authored());
    const request: GameAction = { kind: "craft", sequence: [
      { item: "oak_planks", executions: partialStage ? 3 : 2 },
      { item: "stick", executions: 1 },
    ] };
    const receipt = f.action(owner, {
      effect_confirmed: false,
      craft_stages: [
        craftStage(0, "oak_planks", partialStage ? 3 : 2, 4, { oak_log: 3 }, { oak_log: 1, oak_planks: 8 }, 2),
        ...(partialStage ? [{ stage_index: 1, item: "stick", inventory_after: { stick: 999 } }] : []),
      ],
      ...(partialStage ? {
        inventory_receipt_confirmed: true,
        inventory_before: { oak_log: 3 }, inventory_after: { stick: 999 },
      } : {}),
    }, 10, request, "unknown");
    f.close(owner);
    await f.prepare();
    const projected = measured(await f.published(), owner);
    expect(projected.confirmed_effects).toBe(0);
    expect(projected.metrics.inventory_delta).toEqual({ oak_log: -2, oak_planks: 8 });
    expect(projected.metrics.inventory_receipts).toBe(1);
    expect(actionMetrics([{ request, view: receipt }])).toMatchObject({
      count: 1, confirmed_effects: 0, inventory_receipts: 1,
      inventory_delta: { oak_log: -2, oak_planks: 8 }, uncertain_outcomes: 1,
    });
  });
}
test("native final partial stage production links without confirming uncompleted executions", async () => {
  const f = new EvidenceFixture("craft_crafting_table"),
    owner = f.admit(await f.authored());
  const request: GameAction = { kind: "craft", item: "crafting_table", executions: 2 };
  const receipt = f.action(owner, {
    effect_confirmed: false,
    craft_stages: [craftStage(0, "crafting_table", 2, 1, { oak_planks: 8 }, { oak_planks: 4, crafting_table: 1 }, 1)],
  }, 10, request, "unknown");
  const facts = f.effects(owner, receipt, request),
    read = f.possession(owner, { oak_planks: 4, crafting_table: 1 }),
    goal = f.verdict([...facts, read]);
  f.close(owner);
  await f.prepare();
  const projected = measured(await f.published(), owner);
  expect(projected).toMatchObject({
    status: "unknown", confirmed_effects: 0, evidence_status: "verified_goal",
    goal_associations: [directLink(goal.event_seq, receipt)],
    verified_event_seqs: [goal.event_seq],
  });
  expect(projected.metrics.inventory_delta).toEqual({ oak_planks: -4, crafting_table: 1 });
  expect(projected.metrics.inventory_receipts).toBe(1);
});
for (const mutation of ["receipt", "scope", "payload", "stage identity", "order", "custody"] as const) {
  test(`native stage association rejects mismatched ${mutation}`, async () => {
    const f = new EvidenceFixture("craft_crafting_table"),
      owner = f.admit(await f.authored());
    const request: GameAction = { kind: "craft", sequence: [
      { item: "oak_planks", executions: 1 }, { item: "crafting_table", executions: 1 },
    ] };
    const stages = [
      craftStage(0, "oak_planks", 1, 4, { oak_log: 1 }, { oak_planks: 4 }),
      craftStage(1, "crafting_table", 1, 1, { oak_planks: 4 }, { crafting_table: 1 }),
    ];
    const receipt = f.action(owner, { effect_confirmed: false, craft_stages: stages }, 10, request, "unknown");
    const facts = f.effects(owner, receipt, request, false);
    const production = facts.find(fact => fact.evidence_id.endsWith(":craft:1:production"))!;
    if (mutation === "receipt") (production.data as Record<string, Json>).receipt_ref = "foreign-receipt";
    if (mutation === "scope") production.scope.source_hash = sha256("foreign source");
    if (mutation === "payload") (production.data as Record<string, Json>).inventory_before = { oak_planks: 5 };
    if (mutation === "stage identity") production.evidence_id = `${receipt.action_id}:craft:0:production`;
    for (const fact of facts)
      at(11, () => f.store.event(f.run.run_id, "adapter.evidence", "Retained stage fixture", jsonSchema.parse(fact)));
    const read = f.possession(owner, { crafting_table: 1 });
    f.verdict([...facts, read]);
    if (mutation === "order" || mutation === "custody") {
      receipt.result!.evidence = {
        effect_confirmed: false,
        craft_stages: mutation === "order"
          ? [stages[1]!, stages[0]!]
          : [stages[0]!, { ...stages[1]!, cursor_count: 1 }],
      };
      at(35, () => f.store.saveAction(f.run.run_id, receipt));
    }
    f.close(owner);
    await f.prepare();
    expect(measured(await f.published(), owner)).toMatchObject({
      status: "unknown", confirmed_effects: 0, evidence_status: "unknown",
      goal_associations: [], verified_event_seqs: [],
    });
  });
}
for (const reopenBefore of [false, true]) {
  for (const duplicate of ["qualifying", "unqualified source"] as const) {
    test(`resident ${duplicate} duplicate does not invent finite actions (reopen=${reopenBefore})`, async () => {
      const f = new EvidenceFixture("craft_crafting_table"),
        owner = f.admit(await f.authored("resident", "step"), 0, "step");
      const facts = at(10, () =>
        retainResidentReceipt(
          f.store,
          adapter,
          owner,
          screenInput,
          residentUpdate,
        ),
      );
      const retained = f.store
        .eventsAfter(f.run.run_id, 0, 500)
        .find((event) => event.type === "controller.receipted")!;
      const read = f.possession(owner, { crafting_table: 1 }),
        goal = f.verdict([...facts, read]);
      f.close(owner);
      await f.prepare();
      const original = measured(await f.published(), owner);
      const association = {
        event_seq: goal.event_seq,
        relationship: "direct_receipt",
        action_id: null,
        controller_input: {
          input_id: `controller:${owner.execution_id}:1:7`,
          generation: 1,
          sequence: 7,
        },
        causal_item_origin: "unknown",
      };
      expect(original).toMatchObject({
        status: "unknown",
        evidence_status: "verified_goal",
        verified_event_seqs: [goal.event_seq],
        goal_associations: [association],
      });
      expectNoFiniteAction(original);
      if (reopenBefore) await f.reopen();
      const details = structuredClone(retained.details);
      if (duplicate === "unqualified source") {
        if (
          !details ||
          typeof details !== "object" ||
          Array.isArray(details) ||
          !details.scope ||
          typeof details.scope !== "object" ||
          Array.isArray(details.scope)
        )
          throw new Error("Retained receipt lacks typed scope");
        details.scope.source_hash = sha256("Not the resident source");
      }
      at(50, () =>
        f.store.event(
          f.run.run_id,
          "controller.receipted",
          "Duplicate controller input",
          details,
        ),
      );
      await f.prepare();
      const changed = measured(await f.published(), owner);
      expectNoFiniteAction(changed);
      expect(changed).toMatchObject(
        duplicate === "qualifying"
          ? {
              evidence_status: "unknown",
              verified_event_seqs: [],
              goal_associations: [],
            }
          : {
              evidence_status: "verified_goal",
              verified_event_seqs: [goal.event_seq],
              goal_associations: [association],
            },
      );
      expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(1);
      const db = new Database(f.store.readLocation().database, {
        readonly: true,
      });
      try {
        expect(
          db
            .query<{ count: number }, [string]>(
              "SELECT COUNT(*) AS count FROM actions WHERE run_id=?",
            )
            .get(f.run.run_id)!.count,
        ).toBe(0);
      } finally {
        db.close();
      }
      await f.reopen();
      expect(measured(await f.published(), owner)).toEqual(changed);
    });
  }
  test(`unknown finite GUI prefix retracts without resetting outcome (reopen=${reopenBefore})`, async () => {
    const f = new EvidenceFixture("craft_crafting_table"),
      owner = f.admit(await f.authored());
    const request: GameAction = {
      kind: "screen_input",
      screen: screenInput.screen,
      operations: screenInput.operations,
    };
    const receipt = f.action(
      owner,
      {
        effect_confirmed: false,
        transaction_status: "unknown",
        gui_transactions: [confirmedPrefix],
      },
      10,
      request,
      "unknown",
    );
    const facts = f.effects(owner, receipt, request),
      read = f.possession(owner, { crafting_table: 1 }),
      goal = f.verdict([...facts, read]);
    f.close(owner);
    await f.prepare();
    const original = measured(await f.published(), owner);
    expect(original).toMatchObject({
      status: "unknown",
      confirmed_effects: 0,
      evidence_status: "verified_goal",
      goal_associations: [directLink(goal.event_seq, receipt)],
      verified_event_seqs: [goal.event_seq],
    });
    expect(original.metrics.inventory_delta).toEqual({ oak_planks: -4 });
    expect(original.metrics.inventory_receipts).toBe(1);
    if (reopenBefore) await f.reopen();
    receipt.result!.evidence = {
      effect_confirmed: false,
      transaction_status: "unknown",
      gui_transactions: [],
    };
    at(50, () => f.store.saveAction(f.run.run_id, receipt));
    await f.prepare();
    const changed = measured(await f.published(), owner);
    expect(changed).toMatchObject({
      status: "unknown",
      confirmed_effects: 0,
      evidence_status: "unknown",
      goal_associations: [],
      verified_event_seqs: [],
    });
    expect(changed.metrics.inventory_delta).toEqual({});
    expect(changed.metrics.inventory_receipts).toBe(0);
    expect(changed.metrics.evidence_event_seqs).toEqual(
      original.metrics.evidence_event_seqs,
    );
    await f.reopen();
    expect(measured(await f.published(), owner)).toEqual(changed);
  });
}

for (const reopenBefore of [false, true]) {
  for (const transition of [
    "late valid",
    "late after observation",
    "invalid candidate becomes valid",
  ] as const) {
    test(`old observation collector dependency: ${transition} (reopen=${reopenBefore})`, async () => {
      const f = new EvidenceFixture("obtain_stone"),
        owner = f.admit(await f.authored());
      const initiallyConfirmed =
        transition === "invalid candidate becomes valid";
      const receipt = f.action(
        owner,
        initiallyConfirmed
          ? {
              effect_confirmed: true,
              inventory_receipt_confirmed: true,
              inventory_before: { stone: 0 },
              inventory_after: { stone: 1 },
            }
          : { effect_confirmed: false },
        initiallyConfirmed ? 21 : 10,
        undefined,
        initiallyConfirmed ? "succeeded" : "unknown",
      );
      const read = f.possession(owner, { stone: 1 }),
        goal = f.verdict([read]);
      f.close(owner);
      await f.prepare();
      const original = measured(await f.published(), owner);
      expect(original).toMatchObject({
        status: "unknown",
        confirmed_effects: initiallyConfirmed ? 1 : 0,
        evidence_status: initiallyConfirmed ? "confirmed_effects" : "unknown",
        goal_associations: [],
        verified_event_seqs: [],
      });
      if (reopenBefore) await f.reopen();
      receipt.status = "succeeded";
      receipt.ended_at = iso(transition === "late after observation" ? 21 : 10);
      receipt.result = {
        status: "succeeded",
        summary: "Late confirmed inventory",
        evidence: {
          effect_confirmed: true,
          inventory_receipt_confirmed: true,
          inventory_before: { stone: 0 },
          inventory_after: { stone: 1 },
        },
      };
      at(50, () => f.store.saveAction(f.run.run_id, receipt));
      await f.prepare();
      const changed = measured(await f.published(), owner);
      expect(changed.status).toBe("unknown");
      expect(changed.confirmed_effects).toBe(1);
      expect(changed.metrics.inventory_delta).toEqual({ stone: 1 });
      expect(changed.metrics.inventory_receipts).toBe(1);
      expect(changed.metrics.evidence_event_seqs).toEqual(
        original.metrics.evidence_event_seqs,
      );
      expect(changed).toMatchObject(
        transition === "late after observation"
          ? {
              evidence_status: "confirmed_effects",
              verified_event_seqs: [],
              goal_associations: [],
            }
          : {
              evidence_status: "verified_goal",
              verified_event_seqs: [goal.event_seq],
              goal_associations: [collectorLink(goal.event_seq, receipt)],
            },
      );
      await f.reopen();
      expect(measured(await f.published(), owner)).toEqual(changed);
    });
  }
  for (const mutation of ["baseline", "goal", "late compatibility"] as const) {
    test(`eventless run and rejected goal dependencies: ${mutation} (reopen=${reopenBefore})`, async () => {
      const f = new EvidenceFixture(
          "obtain_stone",
          mutation !== "late compatibility",
        ),
        owner = f.admit(await f.authored());
      const receipt = f.action(owner, {
        effect_confirmed: true,
        inventory_receipt_confirmed: true,
        inventory_before: { stone: 0 },
        inventory_after: { stone: 1 },
      });
      const read = f.possession(owner, { stone: 1 }),
        goal = f.verdict([read]);
      f.close(owner);
      await f.prepare();
      const original = measured(await f.published(), owner),
        initiallyValid = mutation !== "late compatibility";
      expect(original).toMatchObject({
        evidence_status: initiallyValid ? "verified_goal" : "confirmed_effects",
        verified_event_seqs: initiallyValid ? [goal.event_seq] : [],
        goal_associations: initiallyValid
          ? [collectorLink(goal.event_seq, receipt)]
          : [],
      });
      if (reopenBefore) await f.reopen();
      const eventThrough = f.store
        .eventsAfter(f.run.run_id, 0, 500)
        .at(-1)!.event_seq;
      const sourceThrough = f.store.historySourceHighwater(f.run.run_id);
      if (mutation === "late compatibility")
        at(50, () =>
          f.store.event(
            f.run.run_id,
            "run.adapter",
            "Late matching descriptor",
            jsonSchema.parse(compatibility),
          ),
        );
      else {
        if (mutation === "baseline")
          f.run.baseline = adapter.captureBaseline(
            adapter.goals.find((value) => value.goal_id === "obtain_stone")!,
            f.observation({ stone: 1 }, 0, 1),
          );
        else
          f.run.goal = adapter.goals.find(
            (value) => value.goal_id === "custom",
          )!;
        f.store.saveRun(f.run);
        expect(f.store.eventsAfter(f.run.run_id, eventThrough, 500)).toEqual(
          [],
        );
      }
      expect(f.store.historySourceHighwater(f.run.run_id)).toBeGreaterThan(
        sourceThrough,
      );
      await f.prepare();
      const changed = measured(await f.published(), owner);
      expect(changed).toMatchObject(
        mutation === "late compatibility"
          ? {
              evidence_status: "verified_goal",
              verified_event_seqs: [goal.event_seq],
              goal_associations: [collectorLink(goal.event_seq, receipt)],
            }
          : {
              evidence_status: "confirmed_effects",
              verified_event_seqs: [],
              goal_associations: [],
            },
      );
      expect(changed.status).toBe("unknown");
      expect(changed.confirmed_effects).toBe(1);
      expect(changed.metrics).toEqual(original.metrics);
      await f.reopen();
      expect(measured(await f.published(), owner)).toEqual(changed);
    });
  }
  test(`metadata qualifiers cannot fabricate a typed goal or reset unknown (reopen=${reopenBefore})`, async () => {
    const f = new EvidenceFixture("obtain_stone"),
      owner = f.admit(await f.authored());
    const receipt = f.action(owner, {
      effect_confirmed: true,
      inventory_receipt_confirmed: true,
      inventory_before: { stone: 0 },
      inventory_after: { stone: 1 },
    });
    const read = f.possession(owner, { stone: 1 });
    if (typeof f.run.goal === "string") throw new Error("Typed goal required");
    const verdict = adapter.verifyCompletion(
      {
        goal: f.run.goal,
        run_id: f.run.run_id,
        world_id: f.run.world_id,
        session_id: f.run.session_id!,
        epoch: f.run.epoch,
        native_boot_id: f.run.native_boot_id!,
        baseline: f.run.baseline,
      },
      [read],
    );
    expect(verdict.status).toBe("verified");
    f.close(owner);
    await f.prepare();
    expect(measured(await f.published(), owner)).toMatchObject({
      status: "unknown",
      evidence_status: "confirmed_effects",
      goal_associations: [],
    });
    if (reopenBefore) await f.reopen();
    at(50, () =>
      f.store.event(
        f.run.run_id,
        "goal.verified",
        "Wrong verifier with persuasive metadata",
        {
          ...(jsonSchema.parse(verdict) as Record<string, Json>),
          verifier_version: verdict.verifier_version + 1,
          action_id: receipt.action_id,
          effect_confirmed: true,
          qualification: "verified_goal",
          status: "verified",
        },
      ),
    );
    await f.prepare();
    const changed = measured(await f.published(), owner);
    expect(changed).toMatchObject({
      status: "unknown",
      evidence_status: "confirmed_effects",
      confirmed_effects: 1,
      verified_event_seqs: [],
      goal_associations: [],
    });
    expect(changed.metrics.inventory_delta).toEqual({ stone: 1 });
    await f.reopen();
    expect(measured(await f.published(), owner)).toEqual(changed);
  });
}

for (const reopenBefore of [false, true]) {
  test(`goal order contains finite actions before resident links and retracts whole goals (reopen=${reopenBefore})`, async () => {
    const f = new EvidenceFixture("collect_and_craft_table"),
      owner = f.admit(await f.authored("combined resident", "step"), 0, "step");
    const request: GameAction = {
      kind: "craft",
      item: "oak_planks",
      executions: 1,
    };
    const planks = f.action(
      owner,
      {
        effect_confirmed: true,
        inventory_receipt_confirmed: true,
        inventory_before: { oak_log: 1 },
        inventory_after: { oak_planks: 4 },
      },
      10,
      request,
    );
    const acquisition = f.effects(owner, planks, request);
    const production = at(12, () =>
      retainResidentReceipt(
        f.store,
        adapter,
        owner,
        screenInput,
        residentUpdate,
      ),
    );
    const receiptEvent = f.store
      .eventsAfter(f.run.run_id, 0, 500)
      .find((event) => event.type === "controller.receipted")!;
    const possession = f.possession(owner, { crafting_table: 1 });
    const first = f.verdict([...acquisition, ...production, possession], 30);
    const second = f.verdict([...acquisition, ...production, possession], 31);
    f.close(owner);
    await f.prepare();
    const controllerLink = (event_seq: number) => ({
      event_seq,
      relationship: "direct_receipt",
      action_id: null,
      controller_input: {
        input_id: `controller:${owner.execution_id}:1:7`,
        generation: 1,
        sequence: 7,
      },
      causal_item_origin: "unknown",
    });
    const original = measured(await f.published(), owner);
    expect(original).toMatchObject({
      status: "unknown",
      confirmed_effects: 1,
      evidence_status: "verified_goal",
      verified_event_seqs: [first.event_seq, second.event_seq],
      goal_associations: [
        collectorLink(first.event_seq, planks),
        controllerLink(first.event_seq),
        collectorLink(second.event_seq, planks),
        controllerLink(second.event_seq),
      ],
    });
    // Resident table production is not a finite-action inventory contribution.
    expect(original.metrics.inventory_delta).toEqual({
      oak_log: -1,
      oak_planks: 4,
    });
    expect(original.metrics.inventory_receipts).toBe(1);
    if (reopenBefore) await f.reopen();
    at(50, () =>
      f.store.event(
        f.run.run_id,
        "controller.receipted",
        "Qualifying duplicate invalidates every dependent verdict",
        receiptEvent.details,
      ),
    );
    await f.prepare();
    const changed = measured(await f.published(), owner);
    expect(changed).toMatchObject({
      status: "unknown",
      evidence_status: "confirmed_effects",
      confirmed_effects: 1,
      verified_event_seqs: [],
      goal_associations: [],
    });
    expect(changed.metrics).toEqual(original.metrics);
    await f.reopen();
    expect(measured(await f.published(), owner)).toEqual(changed);
  });
}
