import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { Json } from "../src/shared/contracts.ts";
import { dispatchHistoryQuery } from "../src/server/history-dispatch.ts";
import { HISTORY_LIMITS } from "../src/server/history-limits.ts";
import { historyQuerySchema } from "../src/server/history-protocol.ts";
import { HistoryReader } from "../src/server/history-reader.ts";
import { ImprovementLearning } from "../src/server/improvement-learning.ts";
import { programEvidence } from "../src/server/program-evidence.ts";
import { ProgramWorkspace } from "../src/server/program-workspace.ts";
import { ReadonlyStore } from "../src/server/store-read.ts";
import { Store, type StoredRun } from "../src/server/store.ts";
import { skillAuthorityFixture } from "./helpers/adapter-contract.ts";
import {
  finishHistoryExecution,
  historyExecution,
  historyFixture,
  historySpec,
} from "./helpers/history-fixture.ts";

class PageReferenceStore extends ReadonlyStore {
  override executionReferences(runId: string, executionId?: string) {
    if (executionId === undefined)
      throw new Error(
        "Named history cannot hydrate the entire reference ledger",
      );
    return super.executionReferences(runId, executionId);
  }
  override allSkillExecutions(): never {
    throw new Error("Named history cannot hydrate the entire execution ledger");
  }
}

function object(value: unknown): Record<string, Json> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a public object");
  return value as Record<string, Json>;
}
function bounded(value: unknown) {
  expect(
    Buffer.byteLength(
      JSON.stringify({ id: Number.MAX_SAFE_INTEGER, ok: true, value }) + "\n",
    ),
  ).toBeLessThanOrEqual(HISTORY_LIMITS.responseBytes);
}
async function prepare(store: Store, runId: string) {
  const reader = new HistoryReader(store.readLocation());
  try {
    await new ImprovementLearning(store, reader).prepareFeedback(runId, {
      deadlineHostMs: performance.now() + 120_000,
    });
  } finally {
    await reader.close();
  }
}

// Consume exactly the model-visible reference, including every continuation, without an opaque ID.
function follow(reader: PageReferenceStore, runId: string, reference: unknown) {
  const query = historyQuerySchema.parse({
    kind: "model_inspect",
    run_id: runId,
    input: reference,
  });
  if (
    query.kind !== "model_inspect" ||
    (query.input.view !== "evidence" && query.input.view !== "metric")
  )
    throw new Error("Expected a complete named record reference");
  const chunks: Record<string, Json>[] = [];
  for (let count = 0; count < 100; count++) {
    const page = object(
      reader.snapshot(() => dispatchHistoryQuery(reader, query)),
    );
    bounded(page);
    expect(page.omissions).toEqual([]);
    expect(object(page.projection).generation).toBe(query.input.generation);
    expect(page.total).toBe(1);
    if (!Array.isArray(page.records))
      throw new Error("Expected named record chunks");
    for (const value of page.records) {
      const record = object(value);
      if (record.kind !== "json_record_chunk") {
        expect(chunks).toEqual([]);
        expect(page.has_more).toBe(false);
        return record;
      }
      expect(record).toMatchObject({
        record_index: 0,
        chunk_index: chunks.length,
        collection:
          query.input.view === "evidence"
            ? "program_evidence"
            : "objective_metrics",
        encoding: "json_text",
      });
      chunks.push(record);
    }
    if (!page.has_more) {
      expect(chunks.length).toBeGreaterThan(1);
      const encoded = chunks.map((chunk) => chunk.text).join("");
      const hash = createHash("sha256").update(encoded).digest("hex");
      for (const chunk of chunks)
        expect(chunk).toMatchObject({
          sha256: hash,
          chunk_count: chunks.length,
          original_bytes: Buffer.byteLength(encoded),
        });
      return object(JSON.parse(encoded));
    }
    const after = object(page.next_after);
    if (
      typeof after.record_index !== "number" ||
      typeof after.chunk_index !== "number"
    )
      throw new Error("Expected chunk continuation");
    query.input.after = {
      record_index: after.record_index,
      chunk_index: after.chunk_index,
    };
  }
  throw new Error("Finite named archive did not drain");
}

for (const mutation of ["move", "delete"] as const) {
  test(`published named history pins ordinary records and whole-record references while current executions ${mutation}`, async () => {
    const fixture = historyFixture();
    let store = fixture.store;
    let reader: PageReferenceStore | undefined;
    try {
      const run: StoredRun = { ...fixture.run, goal: "craft_crafting_table" };
      store.saveRun(run);
      const a = await store.registerSkill(
        run.run_id,
        historySpec(run, "Published A"),
      );
      const b = await store.registerSkill(
        run.run_id,
        historySpec(run, "Pending B"),
      );
      const ordinary = historyExecution(store, run, a);
      const oversized = historyExecution(store, run, a);
      const counts = {
        ...Object.fromEntries(
          Array.from({ length: 3500 }, (_, index) => [
            `retained_fixture_item_${index}`,
            index + 1,
          ]),
        ),
        crafting_table: 1,
      };
      const receipt = store.admitAction(
        run.run_id,
        crypto.randomUUID(),
        { kind: "craft", item: "crafting_table", executions: 1 },
        "skill",
        oversized.execution_id,
        skillAuthorityFixture(run, oversized),
      ).action.view;
      receipt.status = "succeeded";
      receipt.ended_at = "2020-01-01T00:00:00.010Z";
      receipt.result = {
        status: "succeeded",
        summary: "Complete retained inventory receipt",
        evidence: {
          effect_confirmed: true,
          inventory_receipt_confirmed: true,
          inventory_before: {},
          inventory_after: counts,
        },
      };
      store.saveAction(run.run_id, receipt);
      const goals = store.appendEvents(
        run.run_id,
        Array.from({ length: 3 }, () => ({
          type: "goal.verified",
          summary: "Retained historical receipt association",
          details: {
            goal: run.goal,
            item: "crafting_table",
            action_id: receipt.action_id,
          },
        })),
      );
      finishHistoryExecution(store, ordinary);
      finishHistoryExecution(store, oversized);
      await prepare(store, run.run_id);
      const published = store.historyProjectionGeneration(run.run_id)!;
      const ordinals = [ordinary, oversized].map(
        (execution) =>
          store.executionReferences(run.run_id, execution.execution_id)[0]!
            .execution_ordinal,
      );
      reader = new PageReferenceStore(store.readLocation());
      const workspace = new ProgramWorkspace(reader, run.run_id);
      const snapshot = store.historySnapshot(
        run.run_id,
        published.source_through,
      );
      const expected = programEvidence(snapshot, run.run_id).map((record) =>
        workspace.historyView(record, published.generation),
      );
      expect(Buffer.byteLength(JSON.stringify(expected[1]))).toBeGreaterThan(
        48000,
      );
      expect(expected[1]!.goal_associations).toEqual(
        goals.map((goal) => ({
          event_seq: goal.event_seq,
          relationship: "direct_receipt",
          causal_item_origin: "unknown",
        })),
      );
      expect(expected[1]!.metrics!.inventory_delta).toEqual(counts);
      const db = new Database(store.readLocation().database);
      try {
        for (const execution of [ordinary, oversized]) {
          if (mutation === "delete") {
            db.query(
              "DELETE FROM skill_executions WHERE run_id=? AND execution_id=?",
            ).run(run.run_id, execution.execution_id);
          } else {
            const moved = {
              ...execution,
              skill_id: b.skill_id,
              version: b.version,
              source_hash: b.hash,
            };
            db.query(
              "UPDATE skill_executions SET skill_id=?,version=?,view=? WHERE run_id=? AND execution_id=?",
            ).run(
              b.skill_id,
              b.version,
              JSON.stringify(moved),
              run.run_id,
              execution.execution_id,
            );
          }
        }
      } finally {
        db.close(true);
      }
      // Do not prepare B: these public reads must use the still-published A generation.
      const checkpoint = store.historyProjectionCheckpoint(run.run_id);
      const page = object(
        reader.snapshot(() =>
          dispatchHistoryQuery(reader!, {
            kind: "model_inspect",
            run_id: run.run_id,
            input: {
              view: "history",
              program: { name: a.name },
              after: 0,
              limit: 10,
            },
          }),
        ),
      );
      bounded(page);
      expect(page).toMatchObject({
        total: 2,
        next_after: 2,
        has_more: false,
        projection: { generation: published.generation, has_pending: true },
        records: [expected[0]],
        omissions: [
          {
            index: 1,
            reason: "record_byte_budget",
            reference: {
              view: "evidence",
              program: { name: a.name, version: a.version },
              execution_ordinal: ordinals[1],
              generation: published.generation,
            },
          },
        ],
      });
      if (!Array.isArray(page.omissions))
        throw new Error("Expected the whole-evidence omission");
      const evidenceReference = object(page.omissions[0]).reference;
      expect<unknown>(follow(reader, run.run_id, evidenceReference)).toEqual(
        expected[1],
      );
      const metricReference = workspace.metricReadReference(
        oversized.execution_id,
        published.generation,
      );
      expect(metricReference).toMatchObject({
        program: { name: a.name, version: a.version },
        execution_ordinal: ordinals[1],
        generation: published.generation,
      });
      expect<unknown>(follow(reader, run.run_id, metricReference)).toEqual(
        expected[1]!.metrics,
      );
      for (const reference of [evidenceReference, metricReference]) {
        const altered = {
          ...object(reference),
          program: { name: b.name, version: b.version },
        };
        const query = historyQuerySchema.parse({
          kind: "model_inspect",
          run_id: run.run_id,
          input: altered,
        });
        expect(() => dispatchHistoryQuery(reader!, query)).toThrow(
          "does not belong to this exact program",
        );
      }
      expect(store.historyProjectionCheckpoint(run.run_id)).toEqual(checkpoint);
      const exposed = JSON.stringify({
        page,
        evidenceReference,
        metricReference,
        whole: follow(reader, run.run_id, evidenceReference),
      });
      for (const id of [
        run.run_id,
        a.skill_id,
        b.skill_id,
        ordinary.execution_id,
        oversized.execution_id,
        receipt.action_id,
      ])
        expect(exposed).not.toContain(id);
      await prepare(store, run.run_id);
      expect(
        store.historyProjectionGeneration(run.run_id)!.generation,
      ).toBeGreaterThan(published.generation);
      expect<unknown>(follow(reader, run.run_id, evidenceReference)).toEqual(
        expected[1],
      );
      expect<unknown>(follow(reader, run.run_id, metricReference)).toEqual(
        expected[1]!.metrics,
      );
      reader.close();
      reader = undefined;
      store.close();
      store = new Store(fixture.directory);
      reader = new PageReferenceStore(store.readLocation());
      expect<unknown>(
        new ProgramWorkspace(reader, run.run_id).evidenceReadReference(
          oversized.execution_id,
          published.generation,
        ),
      ).toEqual(evidenceReference);
      expect(
        new ProgramWorkspace(reader, run.run_id).metricReadReference(
          oversized.execution_id,
          published.generation,
        ),
      ).toEqual(metricReference);
      expect<unknown>(follow(reader, run.run_id, evidenceReference)).toEqual(
        expected[1],
      );
      expect<unknown>(follow(reader, run.run_id, metricReference)).toEqual(
        expected[1]!.metrics,
      );
    } finally {
      reader?.close();
      store.close();
      fixture.close();
    }
  }, 180_000);
}
