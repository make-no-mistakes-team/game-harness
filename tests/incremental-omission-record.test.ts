import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Json } from "../src/shared/contracts.ts";
import { HistoryReader } from "../src/server/history-reader.ts";
import { HISTORY_LIMITS } from "../src/server/history-limits.ts";
import {
  historyQuerySchema,
  type HistoryExportCursor,
  type HistoryQuery,
} from "../src/server/history-protocol.ts";
import { ImprovementLearning } from "../src/server/improvement-learning.ts";
import { programEvidence } from "../src/server/program-evidence.ts";
import { ProgramWorkspace } from "../src/server/program-workspace.ts";
import { Store, type StoredRun } from "../src/server/store.ts";
import { skillAuthorityFixture } from "./helpers/adapter-contract.ts";
import {
  finishHistoryExecution,
  historyExecution,
  historyFixture,
  historySpec,
} from "./helpers/history-fixture.ts";

const resources: { reader: HistoryReader; store: Store; close(): void }[] = [];
const options = () => ({ deadlineHostMs: performance.now() + 120_000 });
function object(value: unknown): Record<string, Json> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected JSON object");
  return value as Record<string, Json>;
}
afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.reader.close();
    resource.store.close();
    resource.close();
  }
});

async function fixture() {
  const retained = historyFixture();
  const resource = {
    store: retained.store,
    reader: new HistoryReader(retained.store.readLocation()),
    close: () => rmSync(retained.directory, { recursive: true, force: true }),
  };
  resources.push(resource);
  const run: StoredRun = { ...retained.run, goal: "craft_crafting_table" };
  resource.store.saveRun(run);
  const skill = await resource.store.registerSkill(
    run.run_id,
    historySpec(run, "whole evidence"),
  );
  const execution = historyExecution(resource.store, run, skill);
  const action = resource.store.admitAction(
    run.run_id,
    crypto.randomUUID(),
    { kind: "craft", item: "crafting_table", executions: 1 },
    "skill",
    execution.execution_id,
    skillAuthorityFixture(run, execution),
  ).action.view;
  action.status = "succeeded";
  action.ended_at = "2020-01-01T00:00:00.500Z";
  action.result = {
    status: "succeeded",
    summary: "Historical retained receipt, no game dispatched",
    evidence: {
      effect_confirmed: true,
      inventory_receipt_confirmed: true,
      inventory_before: { crafting_table: 0 },
      inventory_after: { crafting_table: 1 },
    },
  };
  resource.store.saveAction(run.run_id, action);
  const goals = resource.store.appendEvents(
    run.run_id,
    Array.from({ length: 500 }, () => ({
      type: "goal.verified",
      summary: "Historical goal accounting",
      details: {
        goal: run.goal,
        item: "crafting_table",
        action_id: action.action_id,
      },
    })),
  );
  finishHistoryExecution(resource.store, execution);
  const prepare = () =>
    new ImprovementLearning(resource.store, resource.reader).prepareFeedback(
      run.run_id,
      options(),
    );
  await prepare();
  const expected = programEvidence(resource.store, run.run_id)[0]!;
  expect(expected.goal_associations).toHaveLength(500);
  expect(expected.goal_associations.map((link) => link.event_seq)).toEqual(
    goals.map((event) => event.event_seq),
  );
  expect(
    expected.goal_associations.every(
      (link) =>
        link.action_id === action.action_id &&
        link.relationship === "direct_receipt",
    ),
  ).toBe(true);
  expect(expected.verified_event_seqs).toEqual(
    goals.map((event) => event.event_seq),
  );
  expect(expected.confirmed_effects).toBe(1);
  expect(expected.evidence_status).toBe("verified_goal");
  expect(expected.metrics.inventory_delta).toEqual({ crafting_table: 1 });
  expect(expected.metrics.inventory_receipts).toBe(1);
  expect(Buffer.byteLength(JSON.stringify(expected.metrics))).toBeLessThan(
    48000,
  );
  expect(Buffer.byteLength(JSON.stringify(expected))).toBeGreaterThan(48000);
  return {
    resource,
    directory: retained.directory,
    run,
    skill,
    execution,
    action,
    expected,
    prepare,
  };
}

// Follow the published reference, not a hand-authored replacement query. Supporting the
// old metric URL/view makes the regression fail on the actual lost evidence fields.
function operatorQuery(reference: Record<string, Json>): HistoryQuery {
  const target = reference.program_evidence ?? reference.objective_metrics;
  const url = new URL(String(object(target).url), "http://history.invalid");
  const segments = url.pathname.split("/");
  return historyQuerySchema.parse({
    kind: "export_page",
    run_id: decodeURIComponent(segments[3]!),
    collection:
      segments[4] === "skill-evidence"
        ? "program_evidence"
        : "objective_metrics",
    execution_id: decodeURIComponent(segments[5]!),
    generation: Number(url.searchParams.get("generation")),
    after: {
      record_index: Number(url.searchParams.get("record_index")),
      chunk_index: Number(url.searchParams.get("chunk_index")),
    },
    limit: Number(url.searchParams.get("limit")),
  });
}
async function recover(reader: HistoryReader, initial: HistoryQuery) {
  let query = initial;
  const text: string[] = [];
  let hash: string | null = null,
    originalBytes = 0;
  for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
    const page = object(await reader.query(query, options()));
    expect(
      Buffer.byteLength(
        JSON.stringify({ id: Number.MAX_SAFE_INTEGER, ok: true, value: page }) +
          "\n",
      ),
    ).toBeLessThanOrEqual(HISTORY_LIMITS.responseBytes);
    expect(page.omissions).toEqual([]);
    const records = page.records;
    if (!Array.isArray(records)) throw new Error("Archive records missing");
    for (const value of records) {
      const chunk = object(value);
      if (chunk.kind !== "json_record_chunk") {
        expect(page.has_more).toBe(false);
        return chunk;
      }
      expect(chunk.collection).toBe("program_evidence");
      expect(chunk.record_count).toBe(1);
      expect(chunk.record_index).toBe(0);
      expect(chunk.chunk_index).toBe(text.length);
      expect(chunk.encoding).toBe("json_text");
      expect(typeof chunk.text).toBe("string");
      expect(Buffer.from(String(chunk.text)).toString("utf8")).toBe(
        String(chunk.text),
      );
      if (hash === null) {
        hash = String(chunk.sha256);
        originalBytes = Number(chunk.original_bytes);
      }
      expect(chunk.sha256).toBe(hash);
      text.push(String(chunk.text));
    }
    if (!page.has_more) {
      expect(text.length).toBeGreaterThan(1);
      const encoded = text.join("");
      expect(Buffer.byteLength(encoded)).toBe(originalBytes);
      expect(createHash("sha256").update(encoded).digest("hex")).toBe(hash!);
      return object(JSON.parse(encoded));
    }
    const after = object(page.next_after) as unknown as HistoryExportCursor;
    if (query.kind === "export_page") query = { ...query, after, limit: 1 };
    else if (
      query.kind === "model_inspect" &&
      (query.input.view === "metric" || query.input.view === "evidence")
    )
      query = { ...query, input: { ...query.input, after, limit: 1 } };
    else
      throw new Error("Reference did not select an archive receiving branch");
  }
  throw new Error("Finite whole-evidence archive did not drain");
}

for (const actor of ["operator", "model"] as const) {
  test(`${actor} whole-record omission reference recovers evidence beyond its small metric and stays generation-pinned after reopen`, async () => {
    const f = await fixture(),
      { run, skill, execution, expected, resource } = f;
    const operator = await resource.reader.query(
      { kind: "operator_evidence", run_id: run.run_id, after: 0, limit: 1 },
      options(),
    );
    expect(operator).toMatchObject({
      records: [],
      total: 1,
      next_after: 1,
      has_more: false,
    });
    expect(operator.omissions).toHaveLength(1);
    const generation = operator.projection.generation;
    const namedExpected = new ProgramWorkspace(
      resource.store,
      run.run_id,
    ).historyView(expected);
    const named = object(
      await resource.reader.query(
        {
          kind: "model_inspect",
          run_id: run.run_id,
          input: {
            view: "history",
            program: { name: skill.name, version: skill.version },
            after: 0,
            limit: 1,
          },
        },
        options(),
      ),
    );
    expect(named.records).toEqual([]);
    const namedOmissions = named.omissions;
    if (!Array.isArray(namedOmissions) || namedOmissions.length !== 1)
      throw new Error("Named history omitted the lossless reference");
    const reference = object(
      actor === "operator"
        ? operator.omissions[0]!.reference
        : object(namedOmissions[0]).reference,
    );
    const query =
      actor === "operator"
        ? operatorQuery(reference)
        : historyQuerySchema.parse({
            kind: "model_inspect",
            run_id: run.run_id,
            input: reference,
          });
    const recovered = await recover(resource.reader, query);
    expect(recovered.goal_associations).toHaveLength(500);
    expect(recovered.verified_event_seqs).toEqual(expected.verified_event_seqs);
    expect(recovered.evidence_status).toBe("verified_goal");
    expect(recovered.confirmed_effects).toBe(1);
    expect<unknown>(recovered).toEqual(
      actor === "operator" ? expected : namedExpected,
    );
    const end = { record_index: 1, chunk_index: 0 };
    const eof =
      query.kind === "export_page"
        ? { ...query, after: end }
        : query.kind === "model_inspect" &&
            (query.input.view === "evidence" || query.input.view === "metric")
          ? { ...query, input: { ...query.input, after: end } }
          : null;
    if (!eof)
      throw new Error(
        "Published reference did not select its exact archive branch",
      );
    expect(await resource.reader.query(eof, options())).toMatchObject({
      records: [],
      total: 1,
      has_more: false,
      next_after: end,
    });
    if (actor === "model") {
      const encoded = JSON.stringify(recovered);
      for (const id of [
        run.run_id,
        skill.skill_id,
        execution.execution_id,
        f.action.action_id,
      ])
        expect(encoded).not.toContain(id);
      expect(reference).toMatchObject({
        view: "evidence",
        program: { name: skill.name, version: 1 },
        generation,
      });
    } else
      expect(reference).toMatchObject({
        run_id: run.run_id,
        execution_id: execution.execution_id,
        generation,
      });

    // A changed historical goal, a new named version, and a later execution must
    // not redirect an already-issued exact-version/generation namespace.
    resource.store.saveRun({ ...run, goal: "break_log" });
    const next = await resource.store.registerSkill(
      run.run_id,
      historySpec(
        run,
        skill.name,
        'return {status:"blocked",summary:"Later retained version 🧭",result:null};',
      ),
    );
    const later = historyExecution(resource.store, run, next);
    finishHistoryExecution(resource.store, later);
    await f.prepare();
    expect(
      resource.store.historyProjectionGeneration(run.run_id)!.generation,
    ).toBeGreaterThan(generation);
    const current = programEvidence(resource.store, run.run_id).find(
      (record) => record.execution_id === execution.execution_id,
    )!;
    expect(current.goal_associations).toEqual([]);
    expect(await recover(resource.reader, query)).toEqual(recovered);
    await resource.reader.close();
    resource.store.close();
    resource.store = new Store(f.directory);
    resource.reader = new HistoryReader(resource.store.readLocation());
    expect(await recover(resource.reader, query)).toEqual(recovered);

    if (query.kind === "model_inspect" && query.input.view === "evidence") {
      await expect(
        resource.reader.query(
          {
            ...query,
            input: {
              ...query.input,
              program: { name: next.name, version: next.version },
            },
          },
          options(),
        ),
      ).rejects.toMatchObject({ code: "conflict" });
      const laterOrdinal = new ProgramWorkspace(
        resource.store,
        run.run_id,
      ).executionReference(later.execution_id)!.execution_ordinal;
      await expect(
        resource.reader.query(
          {
            ...query,
            input: { ...query.input, execution_ordinal: laterOrdinal },
          },
          options(),
        ),
      ).rejects.toMatchObject({
        code: "not_found",
        message: "Named execution ordinal is not retained in this generation",
      });
      await expect(
        resource.reader.query(
          { ...query, input: { ...query.input, execution_ordinal: 999999 } },
          options(),
        ),
      ).rejects.toMatchObject({ code: "not_found" });
    } else if (query.kind === "export_page") {
      await expect(
        resource.reader.query(
          { ...query, execution_id: later.execution_id },
          options(),
        ),
      ).rejects.toMatchObject({ code: "not_found" });
    }
    const artifact = join(
      resource.store.readLocation().artifacts,
      `${skill.hash}.js`,
    );
    const originalSource = readFileSync(artifact);
    try {
      writeFileSync(
        artifact,
        "return null; // Retained hash no longer matches",
      );
      await expect(
        resource.reader.query(query, options()),
      ).rejects.toMatchObject({ code: "query_failed" });
    } finally {
      writeFileSync(artifact, originalSource);
    }
  }, 180_000);
}

test("whole-evidence protocol admits only exact pinned receiving selectors", () => {
  const after = { record_index: 0, chunk_index: 0 };
  const archive = {
    kind: "export_page",
    run_id: "retained-run",
    collection: "program_evidence",
    after,
    limit: 1,
  };
  expect(historyQuerySchema.safeParse(archive).success).toBe(false);
  expect(
    historyQuerySchema.safeParse({ ...archive, generation: 1 }).success,
  ).toBe(false);
  expect(
    historyQuerySchema.safeParse({
      ...archive,
      execution_id: "retained-execution",
    }).success,
  ).toBe(false);
  expect(
    historyQuerySchema.safeParse({
      ...archive,
      generation: 1,
      execution_id: "retained-execution",
    }).success,
  ).toBe(true);
  const model = {
    kind: "model_inspect",
    run_id: "retained-run",
    input: {
      view: "evidence",
      program: { name: "retained", version: 1 },
      execution_ordinal: 1,
      generation: 1,
      after,
      limit: 1,
    },
  };
  expect(historyQuerySchema.safeParse(model).success).toBe(true);
  expect(
    historyQuerySchema.safeParse({
      ...model,
      input: { ...model.input, program: { name: "retained" } },
    }).success,
  ).toBe(false);
  expect(
    historyQuerySchema.safeParse({
      ...model,
      input: { ...model.input, generation: undefined },
    }).success,
  ).toBe(false);
  expect(
    historyQuerySchema.safeParse({
      ...model,
      input: { ...model.input, execution_ordinal: undefined },
    }).success,
  ).toBe(false);
  expect(
    historyQuerySchema.safeParse({
      ...model,
      input: { ...model.input, execution_id: "opaque-not-model-facing" },
    }).success,
  ).toBe(false);
  expect(
    historyQuerySchema.safeParse({
      kind: "projection_status",
      run_id: "retained-run",
    }).success,
  ).toBe(true);
  expect(
    historyQuerySchema.safeParse({
      kind: "projection_status",
      run_id: "retained-run",
      generation: 1,
    }).success,
  ).toBe(false);
  expect(
    historyQuerySchema.safeParse({
      kind: "projection_status",
      run_id: "retained-run",
      sql: "SELECT 1",
    }).success,
  ).toBe(false);
});

test("readonly projection status distinguishes unpublished and stale publication without preparing history", async () => {
  const retained = historyFixture();
  const resource = {
    store: retained.store,
    reader: new HistoryReader(retained.store.readLocation()),
    close: () => rmSync(retained.directory, { recursive: true, force: true }),
  };
  resources.push(resource);
  const runId = retained.run.run_id;
  const before = {
    checkpoint: resource.store.historyProjectionCheckpoint(runId),
    through: resource.store.historySourceHighwater(runId),
    events: resource.store.lastEventSeq(),
  };
  expect(
    await resource.reader.query(
      { kind: "projection_status", run_id: runId },
      options(),
    ),
  ).toEqual({ published: null, source_available: before.through });
  expect(resource.store.historyProjectionCheckpoint(runId)).toEqual(
    before.checkpoint,
  );
  expect(resource.store.historySourceHighwater(runId)).toBe(before.through);
  expect(resource.store.lastEventSeq()).toBe(before.events);
  await new ImprovementLearning(
    resource.store,
    resource.reader,
  ).prepareFeedback(runId, options());
  const generation = resource.store.historyProjectionGeneration(runId)!;
  expect(
    await resource.reader.query(
      { kind: "projection_status", run_id: runId },
      options(),
    ),
  ).toEqual({
    published: {
      generation: generation.generation,
      source_through: generation.source_through,
      source_available: generation.source_available,
      has_pending: false,
    },
    source_available: generation.source_available,
  });
  resource.store.event(
    runId,
    "fixture.pending",
    "New retained source without preparation",
    null,
  );
  const checkpoint = resource.store.historyProjectionCheckpoint(runId);
  const available = resource.store.historySourceHighwater(runId);
  expect(available).toBeGreaterThan(generation.source_through);
  expect(
    await resource.reader.query(
      { kind: "projection_status", run_id: runId },
      options(),
    ),
  ).toEqual({
    published: {
      generation: generation.generation,
      source_through: generation.source_through,
      source_available: available,
      has_pending: true,
    },
    source_available: available,
  });
  expect(resource.store.historyProjectionCheckpoint(runId)).toEqual(checkpoint);
  await expect(
    resource.reader.query(
      { kind: "projection_status", run_id: "not-retained" },
      options(),
    ),
  ).rejects.toMatchObject({ code: "not_found" });
});
