import { afterEach, expect, test } from "bun:test";
import type { ProgramEvidenceView } from "../src/shared/contracts.ts";
import type {
  ImprovementOpportunity,
  ObjectiveMetricUpdate,
  ObjectiveMetrics,
  TracePage,
  VersionComparison,
} from "../src/shared/execution-evidence.ts";
import type { SkillView } from "../src/shared/programs.ts";
import { createHash } from "node:crypto";
import { objectiveMetrics } from "../src/server/objective-metrics.ts";
import { HistoryReader } from "../src/server/history-reader.ts";
import { ImprovementLearning } from "../src/server/improvement-learning.ts";
import { ProgramWorkspace } from "../src/server/program-workspace.ts";
import { ReadonlyStore } from "../src/server/store-read.ts";
import { skillAuthorityFixture } from "./helpers/adapter-contract.ts";
import {
  finishHistoryExecution,
  historyExecution,
  historyFixture,
  historySpec,
  type HistoryFixture,
} from "./helpers/history-fixture.ts";

// Exercise the consumer projections with a reader that permits exact references,
// but cannot materialize an unbounded ledger for one model page.
class ExactReferenceStore extends ReadonlyStore {
  override executionReferences(runId: string, executionId?: string) {
    if (executionId === undefined)
      throw new Error("An entire reference ledger is not a page");
    return super.executionReferences(runId, executionId);
  }
}

const fixtures: HistoryFixture[] = [];
const readers: ReadonlyStore[] = [];
async function prepare(store: HistoryFixture["store"], runId: string) {
  const preparationReader = new HistoryReader(store.readLocation());
  try {
    await new ImprovementLearning(store, preparationReader).prepareFeedback(runId,
      { deadlineHostMs: performance.now() + 120_000 });
  } finally { await preparationReader.close(); }
}
afterEach(() => {
  for (const reader of readers.splice(0)) reader.close();
  for (const fixture of fixtures.splice(0)) fixture.close();
});

async function fixture(Reader = ExactReferenceStore) {
  const value = historyFixture();
  fixtures.push(value);
  const { store, run } = value;
  const rootSkill = await store.registerSkill(
    run.run_id,
    historySpec(run, "root"),
  );
  const childSkill = await store.registerSkill(
    run.run_id,
    historySpec(run, "child"),
  );
  const root = historyExecution(store, run, rootSkill);
  const parent = historyExecution(store, run, rootSkill, root);
  const child = historyExecution(store, run, childSkill, parent);
  for (let index = 0; index < 2; index++) {
    const receipt = store.admitAction(run.run_id, crypto.randomUUID(), { kind: "dig",
      target: { target_id: "retained-stone", incarnation: 1, life_id: run.life_id!,
        space: { dimension_id: "minecraft:overworld", space_epoch: run.space_epoch! } } },
    "skill", child.execution_id, skillAuthorityFixture(run, child)).action.view;
    receipt.status = "succeeded";
    receipt.ended_at = "2020-01-01T00:00:00.010Z";
    receipt.result = { status: "succeeded", summary: "Retained storage-only removal",
      evidence: { effect_confirmed: true, block_removed: true, target_name: "stone", native_action_ms: 6 } };
    store.saveAction(run.run_id, receipt);
  }
  finishHistoryExecution(store, child);
  finishHistoryExecution(store, parent);
  finishHistoryExecution(store, root);
  await prepare(store, run.run_id);
  const reader = new Reader(store.readLocation());
  readers.push(reader);
  const workspace = new ProgramWorkspace(reader, run.run_id);
  const version = (skill: SkillView) => ({
    run_id: run.run_id,
    skill_id: skill.skill_id,
    version: skill.version,
    hash: skill.hash,
  });
  const opportunity: ImprovementOpportunity = {
    opportunity_id: "private-opportunity",
    run_id: run.run_id,
    kind: "outcome",
    version: version(childSkill),
    execution_id: child.execution_id,
    event_seqs: [1],
    created_at: "2020-01-01T00:00:01.000Z",
    resolution: {
      decision: "keep",
      reason: "Retained evidence only",
      revision: null,
      event_seqs: [1],
      measured: false,
      at: "2020-01-01T00:00:02.000Z",
    },
  };
  store.saveOpportunity(opportunity);
  const measured = objectiveMetrics(store, run.run_id);
  const metric = measured.find(value => value.execution_id === child.execution_id)!;
  const replacement = (value: ObjectiveMetrics): Extract<ObjectiveMetricUpdate, { kind: "replace" }> => ({
    kind: "replace", execution_id: value.execution_id, revision: 1, generation: 1,
    program: { name: childSkill.name, version: childSkill.version }, execution_ordinal: 3, metric: value,
  });
  const scopeHash = createHash("sha256").update(JSON.stringify(["feedback-v2", run.run_id, null, null])).digest("hex");
  const cursor = { schema_version: 2 as const, opportunity_change_seq: 1, metric_change_seq: 3, scope_hash: scopeHash };
  const projection = { generation: 1, source_through: store.historySourceHighwater(run.run_id),
    source_available: store.historySourceHighwater(run.run_id), has_pending: false };
  const feedback = {
    opportunities: [opportunity],
    metrics: [replacement(metric)],
    next_after: cursor,
    has_more: true,
    projection,
  };
  const trace: TracePage = {
    records: [
      {
        trace_seq: 7,
        at: "2020-01-01T00:00:01.000Z",
        kind: "branch",
        payload: "Selected branch",
        run_id: run.run_id,
        execution_id: child.execution_id,
        root_execution_id: root.execution_id,
        parent_execution_id: parent.execution_id,
        skill_id: childSkill.skill_id,
        version: childSkill.version,
        hash: childSkill.hash,
        session_id: run.session_id,
        life_id: run.life_id,
        observation_seq: 2,
        capability: null,
        event_seq: 1,
        omission: null,
      },
    ],
    next_after: 7,
    has_more: false,
    budget: {
      max_records: 100,
      max_bytes: 10000,
      recorded: 1,
      bytes: 100,
      omitted_records: 0,
      omitted_bytes: 0,
    },
  };
  const history: ProgramEvidenceView & { metrics: ObjectiveMetrics } = {
    execution_id: child.execution_id,
    root_execution_id: root.execution_id,
    skill_id: childSkill.skill_id,
    version: childSkill.version,
    status: "succeeded",
    duration_ms: 1000,
    actions: 0,
    calls: 0,
    strategic_requests: 0,
    confirmed_effects: 0,
    evidence_status: "self_reported",
    verified_event_seqs: [],
    compactness: childSkill.validation,
    metrics: metric,
  };
  const comparison: VersionComparison = {
    before: version(rootSkill),
    after: version(childSkill),
    source_diff: {
      common_prefix_lines: 1,
      common_suffix_lines: 0,
      removed: [],
      added: [],
    },
    card_diff: {},
    samples: { before: [measured.find(value => value.execution_id === root.execution_id)!], after: [metric] },
    sample_count: { before: 1, after: 1 },
    controlled_conditions: null,
    conclusion: "descriptive_only_no_causal_improvement_claim",
  };
  const comparisonPage = {
    comparison,
    next_after: { schema_version: 2 as const, before_generation: 1, after_generation: 1, offset: 1,
      scope_hash: createHash("sha256").update(JSON.stringify([version(rootSkill), version(childSkill)])).digest("hex") },
    has_more: false,
    omissions: [],
    projection: { before: projection, after: projection },
  };
  return {
    ...value,
    reader,
    workspace,
    rootSkill,
    childSkill,
    root,
    parent,
    child,
    opportunity,
    metric,
    replacement,
    feedback,
    trace,
    history,
    comparisonPage,
  };
}

function expectPublic(value: unknown, privateIds: string[]) {
  const encoded = JSON.stringify(value);
  for (const id of privateIds) expect(encoded).not.toContain(id);
}

test("feedback, trace, history and comparison preserve named rows and distinct root/parent ordinals", async () => {
  const f = await fixture();
  const feedback = f.workspace.feedbackView(f.feedback);
  const replacement = feedback.metrics[0]!;
  if (replacement.kind !== "replace") throw new Error("Expected the retained metric replacement");
  expect(feedback).toMatchObject({
    opportunities: [
      {
        kind: "outcome",
        version: { name: "child", version: 1 },
        execution_ordinal: 3,
        event_seqs: [1],
        resolution: { decision: "keep", revision: null, measured: false },
      },
    ],
    metrics: [
      {
        revision: 1,
        generation: 1,
        execution_ordinal: 3,
        metric: {
        name: "child",
        version: 1,
        execution_ordinal: 3,
        root_execution_ordinal: 1,
        confirmed_block_removals: 2,
        removed_blocks: { stone: 2 },
        spans_ms: { native_action: 12 },
        evidence_event_seqs: f.metric.evidence_event_seqs,
        },
      },
    ],
    next_after: f.feedback.next_after,
    has_more: true,
  });
  const trace = f.workspace.traceView(f.trace);
  expect(trace).toEqual({
    records: [
      {
        trace_seq: 7,
        at: "2020-01-01T00:00:01.000Z",
        kind: "branch",
        name: "child",
        version: 1,
        execution_ordinal: 3,
        root_execution_ordinal: 1,
        parent_execution_ordinal: 2,
        observation_seq: 2,
        capability: null,
        event_seq: 1,
        payload: "Selected branch",
        omission: null,
      },
    ],
    next_after: 7,
    has_more: false,
    budget: f.trace.budget,
  });
  const history = f.workspace.historyView({
    ...f.history,
    goal_associations: [
      {
        event_seq: 1,
        relationship: "direct_receipt",
        action_id: "private-action",
        controller_input: {
          input_id: "private-input",
          generation: 4,
          sequence: 5,
        },
        causal_item_origin: "unknown",
      },
    ],
  });
  expect(history).toMatchObject({
    name: "child",
    version: 1,
    execution_ordinal: 3,
    root_execution_ordinal: 1,
    evidence_status: "self_reported",
    metrics: replacement.metric,
    goal_associations: [
      {
        event_seq: 1,
        relationship: "direct_receipt",
        controller_input: { generation: 4, sequence: 5 },
        causal_item_origin: "unknown",
      },
    ],
  });
  expect(history.compactness).not.toHaveProperty("fingerprint");
  const comparison = f.workspace.comparisonView(f.comparisonPage);
  expect(comparison).toMatchObject({
    next_after: f.comparisonPage.next_after,
    has_more: false,
    omissions: [],
    comparison: {
      before: { name: "root", version: 1 },
      after: { name: "child", version: 1 },
      samples: {
        before: [
          { name: "root", execution_ordinal: 1, root_execution_ordinal: 1 },
        ],
        after: [replacement.metric],
      },
      sample_count: { before: 1, after: 1 },
      conclusion: "descriptive_only_no_causal_improvement_claim",
    },
  });
  expectPublic({ feedback, trace, history, comparison }, [
    f.run.run_id,
    f.root.execution_id,
    f.parent.execution_id,
    f.child.execution_id,
    f.childSkill.skill_id,
    f.rootSkill.skill_id,
    f.opportunity.opportunity_id,
    "private-action",
    "private-input",
    f.childSkill.validation.fingerprint,
  ]);
});

test("omission-only opportunities and executions resolve to named references without exposing their IDs", async () => {
  const f = await fixture();
  const omittedExecution = historyExecution(f.store, f.run, f.childSkill);
  finishHistoryExecution(f.store, omittedExecution);
  const omittedOpportunity = {
    ...f.opportunity,
    opportunity_id: "private-omission-opportunity",
    execution_id: omittedExecution.execution_id,
  };
  f.store.saveOpportunity(omittedOpportunity);
  const missingExecutionOpportunity = {
    ...f.opportunity,
    opportunity_id: "private-unretained-opportunity",
    execution_id: "private-unretained-execution",
  };
  f.store.saveOpportunity(missingExecutionOpportunity);
  await prepare(f.store, f.run.run_id);
  const published = f.store.historyProjectionGeneration(f.run.run_id)!;
  const generation = published.generation;
  const omission = (kind: string, id: string) => ({
    kind,
    id,
    reason: "record_byte_budget",
    original_bytes: 70000,
    reference: { generation, revision: published.revision },
  });
  const feedback = f.workspace.feedbackView({
    opportunities: [],
    metrics: [],
    omitted: [
      omission("opportunity", omittedOpportunity.opportunity_id),
      omission("opportunity", omittedOpportunity.opportunity_id),
      omission("metric", omittedExecution.execution_id),
      omission("opportunity", "private-missing-opportunity"),
      omission("metric", "private-missing-execution"),
      omission("opportunity", f.root.execution_id),
      omission("opportunity", missingExecutionOpportunity.opportunity_id),
    ],
    next_after: { ...f.feedback.next_after, opportunity_change_seq: 3, metric_change_seq: 4 },
    has_more: false,
  });
  expect(feedback).toMatchObject({
    opportunities: [],
    metrics: [],
    omitted: [
      {
        kind: "opportunity",
        reference: {
          version: { name: "child", version: 1 },
          execution_ordinal: 4,
        },
      },
      {
        kind: "opportunity",
        reference: {
          version: { name: "child", version: 1 },
          execution_ordinal: 4,
        },
      },
      {
        kind: "metric",
        reference: { view: "metric", program: { name: "child", version: 1 }, execution_ordinal: 4, generation,
          after: { record_index: 0, chunk_index: 0 }, limit: 25 },
      },
      { kind: "opportunity", reference: { reference_omission: expect.any(String) } },
      { kind: "metric", reference: null },
      {
        kind: "opportunity",
        reference: { name: "root", version: 1, execution_ordinal: 1 },
      },
      {
        kind: "opportunity",
        reference: {
          version: { name: "child", version: 1 },
          execution_ordinal: null,
        },
      },
    ],
    next_after: { ...f.feedback.next_after, opportunity_change_seq: 3, metric_change_seq: 4 },
    has_more: false,
  });
  expect(
    feedback.omitted.every(
      (value) =>
        value.reason === "record_byte_budget" && value.original_bytes === 70000,
    ),
  ).toBe(true);
  const comparison = f.workspace.comparisonView({
    ...f.comparisonPage,
    next_after: { ...f.comparisonPage.next_after, before_generation: generation, after_generation: generation },
    projection: { before: published, after: published },
    comparison: {
      ...f.comparisonPage.comparison,
      samples: { before: [], after: [] },
    },
    omissions: [
      {
        field: "sample",
        reason: "record_byte_budget",
        original_bytes: 70000,
        reference: { execution_id: omittedExecution.execution_id, generation },
      },
      {
        field: "sample",
        reason: "record_byte_budget",
        original_bytes: 70000,
        // The same live ID did not exist in the original pinned generation.
        reference: { execution_id: omittedExecution.execution_id, generation: f.comparisonPage.next_after.after_generation },
      },
      {
        field: "sample",
        reason: "record_byte_budget",
        original_bytes: 70000,
        reference: { execution_id: "private-missing-execution", generation: 1 },
      },
      {
        field: "source_diff",
        reason: "field_byte_budget",
        original_bytes: 70000,
        reference: null,
      },
      {
        field: "card_diff",
        reason: "field_byte_budget",
        original_bytes: 70000,
        reference: null,
      },
      {
        field: "sample",
        reason: "record_byte_budget",
        original_bytes: 70000,
        reference: ["invalid reference"],
      },
    ],
  });
  expect(comparison.omissions.map((value) => value.reference)).toEqual([
    { view: "metric", program: { name: "child", version: 1 }, execution_ordinal: 4, generation,
      after: { record_index: 0, chunk_index: 0 }, limit: 25 },
    null,
    null,
    {
      before: { name: "root", version: 1 },
      after: { name: "child", version: 1 },
    },
    {
      before: { name: "root", version: 1 },
      after: { name: "child", version: 1 },
    },
    null,
  ]);
  expectPublic({ feedback, comparison }, [
    omittedExecution.execution_id,
    omittedOpportunity.opportunity_id,
    missingExecutionOpportunity.opportunity_id,
    missingExecutionOpportunity.execution_id,
    "private-missing-opportunity",
    "private-missing-execution",
    f.root.execution_id,
    f.childSkill.skill_id,
  ]);
});

test("missing optional roots and parents remain null while missing metric executions remain errors", async () => {
  const f = await fixture();
  const missing = "private-missing-execution";
  const metric = { ...f.metric, root_execution_id: missing };
  expect(f.workspace.metricView(metric)).toMatchObject({
    name: "child",
    execution_ordinal: 3,
    root_execution_ordinal: null,
  });
  expect(
    f.workspace.feedbackView({
      opportunities: [{ ...f.opportunity, execution_id: missing }],
      metrics: [f.replacement(metric)],
    }),
  ).toMatchObject({
    opportunities: [
      { version: { name: "child", version: 1 }, execution_ordinal: null },
    ],
    metrics: [{ execution_ordinal: 3, metric: { execution_ordinal: 3, root_execution_ordinal: null } }],
  });
  const trace = f.workspace.traceView({
    ...f.trace,
    records: [
      {
        ...f.trace.records[0]!,
        root_execution_id: missing,
        parent_execution_id: missing,
      },
      {
        ...f.trace.records[0]!,
        execution_id: missing,
        root_execution_id: null,
        parent_execution_id: null,
      },
    ],
  });
  expect(trace.records).toMatchObject([
    {
      execution_ordinal: 3,
      root_execution_ordinal: null,
      parent_execution_ordinal: null,
    },
    {
      execution_ordinal: null,
      root_execution_ordinal: null,
      parent_execution_ordinal: null,
    },
  ]);
  const history = f.workspace.historyView({
    ...f.history,
    root_execution_id: missing,
    metrics: metric,
  });
  expect(history).toMatchObject({
    execution_ordinal: 3,
    root_execution_ordinal: null,
    metrics: { root_execution_ordinal: null },
  });
  const missingMetric = { ...metric, execution_id: missing };
  for (const project of [
    () => f.workspace.metricView(missingMetric),
    () =>
      f.workspace.feedbackView({ opportunities: [], metrics: [f.replacement(missingMetric)] }),
    () => f.workspace.historyView({ ...f.history, metrics: missingMetric }),
    () =>
      f.workspace.comparisonView({
        ...f.comparisonPage,
        comparison: {
          ...f.comparisonPage.comparison,
          samples: { before: [], after: [missingMetric] },
        },
      }),
  ])
    expect(project).toThrow(
      "Metric execution is not retained in this workspace",
    );
  expectPublic({ trace, history }, [
    missing,
    f.child.execution_id,
    f.root.execution_id,
  ]);
});

test("named source omissions retain exact version scope instead of substituting another version", async () => {
  const f = await fixture();
  const unavailable = {
    ...f.opportunity,
    version: { ...f.opportunity.version, version: 999 },
  };
  const feedback = f.workspace.feedbackView({ opportunities: [unavailable] });
  expect(feedback.opportunities).toMatchObject([
    {
      version: {
        name: null,
        version: 999,
        reference_omission: "Program is outside the current named workspace",
      },
      execution_ordinal: 3,
    },
  ]);
  const comparison = f.workspace.comparisonView({
    ...f.comparisonPage,
    comparison: { ...f.comparisonPage.comparison, after: unavailable.version },
  });
  expect(comparison.comparison.after).toEqual({
    name: null,
    version: 999,
    reference_omission: "Program is outside the current named workspace",
  });
  expectPublic({ feedback, comparison }, [
    f.childSkill.skill_id,
    f.child.execution_id,
  ]);
});

test("unrelated large ledgers cannot change a small named page or hide its early references", async () => {
  const f = await fixture();
  const project = () => ({
    feedback: f.workspace.feedbackView(f.feedback),
    trace: f.workspace.traceView(f.trace),
    history: f.workspace.historyView(f.history),
    comparison: f.workspace.comparisonView(f.comparisonPage),
    metric: f.workspace.metricView(f.metric),
  });
  const before = project();
  const unrelated = await f.store.registerSkill(
    f.run.run_id,
    historySpec(f.run, "unrelated"),
  );
  for (let index = 0; index < 320; index++) {
    const execution = historyExecution(f.store, f.run, unrelated);
    finishHistoryExecution(f.store, execution);
  }
  expect(f.store.executionReferences(f.run.run_id).length).toBe(323);
  expect(f.reader.skillExecutions(f.run.run_id)).toHaveLength(100);
  const after = project();
  expect(after).toEqual(before);
  expect(after.trace.records[0]).toMatchObject({
    execution_ordinal: 3,
    root_execution_ordinal: 1,
    parent_execution_ordinal: 2,
  });
  expectPublic(after, [
    unrelated.skill_id,
    f.child.execution_id,
    f.root.execution_id,
  ]);
});

test("exact reference and omitted opportunity read failures propagate instead of becoming missing references", async () => {
  const referenceError = new Error("Exact reference read failed");
  const opportunityError = new Error("Exact opportunity read failed");
  class FailingReferenceStore extends ExactReferenceStore {
    override executionReferences(runId: string, executionId?: string) {
      if (executionId === "failing-execution") throw referenceError;
      return super.executionReferences(runId, executionId);
    }
    override historyProjectionRow(...args: Parameters<ReadonlyStore["historyProjectionRow"]>) {
      if (args[3] === "failing-execution") throw referenceError;
      return super.historyProjectionRow(...args);
    }
    override opportunity(runId: string, id: string) {
      if (id === "failing-opportunity") throw opportunityError;
      return super.opportunity(runId, id);
    }
  }
  const f = await fixture(FailingReferenceStore);
  for (const project of [
    () =>
      f.workspace.metricView({
        ...f.metric,
        root_execution_id: "failing-execution",
      }),
    () =>
      f.workspace.feedbackView({
        opportunities: [
          { ...f.opportunity, execution_id: "failing-execution" },
        ],
      }),
    () =>
      f.workspace.traceView({
        ...f.trace,
        records: [
          { ...f.trace.records[0]!, parent_execution_id: "failing-execution" },
        ],
      }),
    () =>
      f.workspace.historyView({
        ...f.history,
        root_execution_id: "failing-execution",
      }),
    () =>
      f.workspace.comparisonView({
        ...f.comparisonPage,
        omissions: [
          {
            field: "sample",
            reason: "record_byte_budget",
            original_bytes: 70000,
            reference: { execution_id: "failing-execution", generation: 1 },
          },
        ],
      }),
  ])
    expect(project).toThrow(referenceError);
  expect(() =>
    f.workspace.feedbackView({
      opportunities: [],
      omitted: [
        {
          kind: "opportunity",
          id: "failing-opportunity",
          reason: "record_byte_budget",
          original_bytes: 70000,
        },
      ],
    }),
  ).toThrow(opportunityError);
});
