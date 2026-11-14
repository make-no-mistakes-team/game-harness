import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { HistoryReader } from "../src/server/history-reader.ts";
import { ImprovementLearning } from "../src/server/improvement-learning.ts";
import { improvementFeedbackCursorSchema } from "../src/server/program-interface.ts";
import {
  evidenceObject,
  objectiveMetrics,
} from "../src/server/objective-metrics.ts";
import { Store } from "../src/server/store.ts";
import {
  finishHistoryExecution,
  historyExecution,
  historyFixture,
  historySpec,
} from "./helpers/history-fixture.ts";
import { skillAuthorityFixture } from "./helpers/adapter-contract.ts";
import { prepareHistoryProjectionBatch } from "../src/server/history-projection.ts";
import type { ImprovementFeedbackCursor } from "../src/shared/execution-evidence.ts";

const options = () => ({ deadlineHostMs: performance.now() + 120_000 });

test("an execution inserted and deleted before first publication has no invented measurement identity", async () => {
  const fixture = historyFixture();
  const { store, run } = fixture;
  const reader = new HistoryReader(store.readLocation());
  try {
    const skill = await store.registerSkill(run.run_id, historySpec(run));
    const removed = historyExecution(store, run, skill);
    const survivor = historyExecution(store, run, skill);
    const ordinal = store.executionReferences(
      run.run_id,
      survivor.execution_id,
    )[0]!.execution_ordinal;
    const db = new Database(store.readLocation().database);
    try {
      db.query(
        "DELETE FROM skill_executions WHERE run_id=? AND execution_id=?",
      ).run(run.run_id, removed.execution_id);
    } finally {
      db.close(true);
    }
    await new ImprovementLearning(store, reader).prepareFeedback(
      run.run_id,
      options(),
    );
    const page = await reader.query(
      {
        kind: "operator_feedback",
        run_id: run.run_id,
        after: {
          schema_version: 2,
          opportunity_change_seq: 0,
          metric_change_seq: 0,
          scope_hash: null,
        },
        limit: 10,
      },
      options(),
    );
    expect(page.has_more).toBe(false);
    expect(page.metrics).toMatchObject([
      {
        kind: "replace",
        execution_id: survivor.execution_id,
        program: { name: skill.name, version: skill.version },
        execution_ordinal: ordinal,
      },
    ]);
    expect(page.metrics).toHaveLength(1);
    expect(JSON.stringify(page)).not.toContain(removed.execution_id);
  } finally {
    await reader.close();
    fixture.close();
  }
});

for (const mutation of ["delete", "rekey", "move"] as const) {
  test(`public feedback explicitly retracts an execution source ${mutation} and continues after reopen`, async () => {
    const fixture = historyFixture();
    let store = fixture.store;
    let reader = new HistoryReader(store.readLocation());
    const run = fixture.run;
    try {
      const skill = await store.registerSkill(run.run_id, historySpec(run));
      const removed = historyExecution(store, run, skill);
      finishHistoryExecution(store, removed);
      const survivor = historyExecution(store, run, skill);
      const otherSkill = await store.registerSkill(run.run_id, {
        ...historySpec(run),
        name: "OtherRetractionFamily",
      });
      const other = historyExecution(store, run, otherSkill);
      const ordinal = store.executionReferences(
        run.run_id,
        removed.execution_id,
      )[0]!.execution_ordinal;
      const feedback = (
        after = {
          schema_version: 2 as const,
          opportunity_change_seq: 0,
          metric_change_seq: 0,
          scope_hash: null as string | null,
        },
      ) =>
        reader.query(
          { kind: "operator_feedback", run_id: run.run_id, after, limit: 1 },
          options(),
        );
      await new ImprovementLearning(store, reader).prepareFeedback(
        run.run_id,
        options(),
      );
      let seeded = await feedback();
      while (seeded.has_more) seeded = await feedback(seeded.next_after);
      const previousGeneration = seeded.projection.generation;
      const namedBefore = await reader.query(
        {
          kind: "model_inspect",
          run_id: run.run_id,
          input: {
            view: "feedback",
            program: { name: skill.name },
            limit: 10,
            after: {
              schema_version: 2,
              opportunity_change_seq: 0,
              metric_change_seq: 0,
              scope_hash: null,
            },
          },
        },
        options(),
      );
      const db = new Database(store.readLocation().database);
      let replacementId: string | undefined;
      try {
        if (mutation === "delete") {
          db.query(
            "DELETE FROM skill_executions WHERE run_id=? AND execution_id=?",
          ).run(run.run_id, removed.execution_id);
        } else if (mutation === "rekey") {
          replacementId = crypto.randomUUID();
          const replacement = {
            ...removed,
            execution_id: replacementId,
            root_execution_id: replacementId,
          };
          db.query(
            "UPDATE skill_executions SET execution_id=?,root_execution_id=?,view=? WHERE run_id=? AND execution_id=?",
          ).run(
            replacementId,
            replacementId,
            JSON.stringify(replacement),
            run.run_id,
            removed.execution_id,
          );
        } else {
          const moved = {
            ...removed,
            skill_id: otherSkill.skill_id,
            version: otherSkill.version,
            source_hash: otherSkill.hash,
          };
          db.query(
            "UPDATE skill_executions SET skill_id=?,version=?,view=? WHERE run_id=? AND execution_id=?",
          ).run(
            otherSkill.skill_id,
            otherSkill.version,
            JSON.stringify(moved),
            run.run_id,
            removed.execution_id,
          );
        }
      } finally {
        db.close(true);
      }
      await new ImprovementLearning(store, reader).prepareFeedback(
        run.run_id,
        options(),
      );
      const delivered = [];
      let page = await feedback(seeded.next_after);
      for (let pages = 0; ; pages++) {
        expect(pages).toBeLessThan(10);
        expect(
          Buffer.byteLength(
            JSON.stringify({
              id: Number.MAX_SAFE_INTEGER,
              ok: true,
              value: page,
            }) + "\n",
          ),
        ).toBeLessThanOrEqual(65536);
        expect(
          page.metrics.length + page.opportunities.length + page.omitted.length,
        ).toBeLessThanOrEqual(1);
        delivered.push(...page.metrics);
        if (!page.has_more) break;
        page = await feedback(page.next_after);
      }
      expect(
        delivered.filter(
          (value) =>
            value.execution_id === removed.execution_id &&
            value.kind === "retract",
        ),
      ).toEqual([
        {
          kind: "retract",
          execution_id: removed.execution_id,
          execution_ordinal: ordinal,
          program: { name: skill.name, version: skill.version },
          reason: "execution_removed",
          generation: page.projection.generation,
          revision: store.historyProjectionGeneration(run.run_id)!.revision,
        },
      ]);
      expect(
        delivered.filter((value) => value.execution_id === other.execution_id),
      ).toEqual([]);
      if (replacementId)
        expect(
          delivered.filter((value) => value.execution_id === replacementId),
        ).toHaveLength(1);
      if (mutation === "move") {
        expect(
          delivered.filter(
            (value) =>
              value.execution_id === removed.execution_id &&
              value.kind === "replace",
          ),
        ).toMatchObject([
          {
            program: { name: otherSkill.name, version: otherSkill.version },
            execution_ordinal: ordinal,
          },
        ]);
      }
      const namedAfter = await reader.query(
        {
          kind: "model_inspect",
          run_id: run.run_id,
          input: {
            view: "feedback",
            program: { name: skill.name },
            limit: 10,
            after: improvementFeedbackCursorSchema.parse(
              evidenceObject(namedBefore)?.next_after,
            ),
          },
        },
        options(),
      );
      expect(JSON.stringify(namedAfter)).not.toContain(removed.execution_id);
      expect(JSON.stringify(namedAfter)).not.toContain(otherSkill.skill_id);
      expect(namedAfter).toMatchObject({
        metrics: expect.arrayContaining([
          {
            kind: "retract",
            execution_ordinal: ordinal,
            program: { name: skill.name, version: skill.version },
            reason: "execution_removed",
            generation: page.projection.generation,
            revision: store.historyProjectionGeneration(run.run_id)!.revision,
          },
        ]),
      });
      await reader.close();
      store.close();
      store = new Store(fixture.directory);
      reader = new HistoryReader(store.readLocation());
      const pinned = await reader.query(
        {
          kind: "model_inspect",
          run_id: run.run_id,
          input: {
            view: "metric",
            program: { name: skill.name, version: skill.version },
            execution_ordinal: ordinal,
            generation: previousGeneration,
            after: { record_index: 0, chunk_index: 0 },
            limit: 1,
          },
        },
        options(),
      );
      expect(JSON.stringify(pinned)).not.toContain(removed.execution_id);
      expect(pinned).toMatchObject({
        total: 1,
        has_more: false,
        records: [
          {
            name: skill.name,
            version: skill.version,
            execution_ordinal: ordinal,
            root_execution_ordinal: ordinal,
            outcome: "succeeded",
          },
        ],
      });
      const replayed = await reader.query(
        {
          kind: "model_inspect",
          run_id: run.run_id,
          input: {
            view: "feedback",
            program: { name: skill.name },
            limit: 10,
            after: {
              schema_version: 2,
              opportunity_change_seq: 0,
              metric_change_seq: 0,
              scope_hash: null,
            },
          },
        },
        options(),
      );
      expect(replayed).toMatchObject({
        opportunities: [{ execution_ordinal: ordinal }],
        metrics: expect.arrayContaining([
          {
            kind: "retract",
            program: { name: skill.name, version: skill.version },
            execution_ordinal: ordinal,
            reason: "execution_removed",
            generation: page.projection.generation,
            revision: store.historyProjectionGeneration(run.run_id)!.revision,
          },
        ]),
      });
      expect(JSON.stringify(replayed)).not.toContain(removed.execution_id);
      survivor.status = "unknown";
      survivor.ended_at = "2020-01-01T00:00:01.000Z";
      store.updateSkillExecution(
        survivor,
        "skill.closed",
        "Later retained update after retraction",
      );
      await new ImprovementLearning(store, reader).prepareFeedback(
        run.run_id,
        options(),
      );
      let later = await feedback(page.next_after);
      const laterMetrics = [...later.metrics];
      while (later.has_more) {
        later = await feedback(later.next_after);
        laterMetrics.push(...later.metrics);
      }
      expect(laterMetrics.map((value) => value.execution_id)).toEqual([
        survivor.execution_id,
      ]);
      expect(laterMetrics[0]).toMatchObject({
        kind: "replace",
        metric: { outcome: "unknown" },
      });
      expect((await feedback(later.next_after)).metrics).toEqual([]);
      if (mutation === "delete") {
        const corrupt = new Database(store.readLocation().projection!);
        try {
          corrupt
            .query(
              "UPDATE history_projection_rows SET payload=json_set(payload,'$.kind','replace') WHERE run_id=? AND collection='metric_update' AND owner_id=? AND json_extract(payload,'$.kind')='retract'",
            )
            .run(run.run_id, removed.execution_id);
          expect(
            corrupt
              .query<{ count: number }, [string, string]>(
                "SELECT COUNT(*) AS count FROM history_projection_rows WHERE run_id=? AND collection='metric_update' AND owner_id=? AND json_extract(payload,'$.kind')='replace' AND json_extract(payload,'$.reason')='execution_removed'",
              )
              .get(run.run_id, removed.execution_id)?.count,
          ).toBe(1);
        } finally {
          corrupt.close(true);
        }
        // The later opportunity consumes the single-record helper's first page.
        // Read the complete bounded page so the corrupted metric is examined.
        await expect(
          reader.query(
            {
              kind: "operator_feedback",
              run_id: run.run_id,
              after: seeded.next_after,
              limit: 100,
            },
            options(),
          ),
        ).rejects.toThrow(
          "Published metric replacement execution identity is corrupt",
        );
      }
    } finally {
      await reader.close();
      store.close();
      fixture.close();
    }
  });
}

for (const unrelatedType of ["constructor", "toString", "__proto__"]) {
  test(`inherited event name ${unrelatedType} cannot become objective terminal provenance`, async () => {
    const fixture = historyFixture();
    let store = fixture.store;
    let reader = new HistoryReader(store.readLocation());
    try {
      const run = fixture.run;
      const skill = await store.registerSkill(run.run_id, historySpec(run));
      const owner = historyExecution(store, run, skill);
      const action = store.admitAction(
        run.run_id,
        crypto.randomUUID(),
        { kind: "look", yaw: 0, pitch: 0 },
        "skill",
        owner.execution_id,
        skillAuthorityFixture(run, owner),
      ).action.view;
      store.event(
        run.run_id,
        unrelatedType,
        "Unrelated retained event, not an action terminal",
        { action_id: action.action_id },
      );
      await new ImprovementLearning(store, reader).prepareFeedback(
        run.run_id,
        options(),
      );
      const emptyGeneration = store.historyProjectionGeneration(run.run_id)!;
      const read = async () => {
        const page = await reader.query(
          {
            kind: "operator_evidence",
            run_id: run.run_id,
            after: 0,
            limit: 10,
          },
          options(),
        );
        expect(page.omissions).toEqual([]);
        expect(page.projection.has_pending).toBe(false);
        return page.records.find(
          (value) => value.execution_id === owner.execution_id,
        )!.metrics;
      };
      const empty = await read();
      // Independent expectation, not merely parity with the oracle.
      expect(empty.evidence_event_seqs).toEqual([]);
      expect(empty.inventory_receipts).toBe(0);
      expect(empty.inventory_delta).toEqual({});
      expect(empty).toEqual(
        objectiveMetrics(
          store.historySnapshot(run.run_id, emptyGeneration.source_through),
          run.run_id,
        )[0]!,
      );
      await reader.close();
      store.close();
      store = new Store(fixture.directory);
      reader = new HistoryReader(store.readLocation());
      expect(await read()).toEqual(empty);
      action.status = "succeeded";
      action.ended_at = "2020-01-01T00:00:00.010Z";
      action.result = {
        status: "succeeded",
        summary: "Actual retained terminal receipt",
        evidence: {
          effect_confirmed: true,
          inventory_receipt_confirmed: true,
          inventory_delta: { stone: 3 },
        },
      };
      store.saveAction(run.run_id, action);
      const realTerminal = store.lastEventSeq();
      await new ImprovementLearning(store, reader).prepareFeedback(
        run.run_id,
        options(),
      );
      const populatedGeneration = store.historyProjectionGeneration(
        run.run_id,
      )!;
      const actual = await read();
      expect(actual.evidence_event_seqs).toEqual([realTerminal]);
      expect(actual.inventory_receipts).toBe(1);
      expect(actual.inventory_delta).toEqual({ stone: 3 });
      expect(actual).toEqual(
        objectiveMetrics(
          store.historySnapshot(run.run_id, populatedGeneration.source_through),
          run.run_id,
        )[0]!,
      );
      // Later source mutations must not change the independently empty pinned history.
      expect(
        objectiveMetrics(
          store.historySnapshot(run.run_id, emptyGeneration.source_through),
          run.run_id,
        )[0]!.evidence_event_seqs,
      ).toEqual([]);
      await reader.close();
      store.close();
      store = new Store(fixture.directory);
      reader = new HistoryReader(store.readLocation());
      expect(
        store.historyProjectionGeneration(
          run.run_id,
          emptyGeneration.generation,
        )?.source_through,
      ).toBe(emptyGeneration.source_through);
      expect(
        store.historyProjectionGeneration(
          run.run_id,
          populatedGeneration.generation,
        )?.source_through,
      ).toBe(populatedGeneration.source_through);
      expect(await read()).toEqual(actual);
    } finally {
      await reader.close();
      store.close();
      fixture.close();
    }
  });
}

for (const finalScope of ["other", "original", "deleted"] as const) {
  test(`resumed indexing coalesces published scope A through staged B to ${finalScope} without ghost metrics`, async () => {
    const fixture = historyFixture();
    let store = fixture.store;
    let reader = new HistoryReader(store.readLocation());
    const run = fixture.run;
    const initial = () => ({
      schema_version: 2 as const,
      opportunity_change_seq: 0,
      metric_change_seq: 0,
      scope_hash: null,
    });
    try {
      const a = await store.registerSkill(run.run_id, historySpec(run));
      const b = await store.registerSkill(
        run.run_id,
        historySpec(
          run,
          a.name,
          'return {status:"completed",summary:"Staged B",result:null};',
        ),
      );
      const c = await store.registerSkill(
        run.run_id,
        historySpec(run, "ResumedScopeC"),
      );
      expect(b.version).not.toBe(a.version);
      const owner = historyExecution(store, run, a);
      const ordinal = store.executionReferences(
        run.run_id,
        owner.execution_id,
      )[0]!.execution_ordinal;
      const named = (
        skill: typeof a,
        after: ImprovementFeedbackCursor = initial(),
      ) =>
        reader.query(
          {
            kind: "model_inspect",
            run_id: run.run_id,
            input: {
              view: "feedback",
              program: { name: skill.name, version: skill.version },
              after,
              limit: 10,
            },
          },
          options(),
        );
      await new ImprovementLearning(store, reader).prepareFeedback(
        run.run_id,
        options(),
      );
      const seeded = await reader.query(
        {
          kind: "operator_feedback",
          run_id: run.run_id,
          after: initial(),
          limit: 100,
        },
        options(),
      );
      expect(seeded.has_more).toBe(false);
      const namedSeeds = await Promise.all(
        [a, b, c].map((skill) => named(skill)),
      );
      const mutate = (skill: typeof a) => {
        Object.assign(owner, {
          skill_id: skill.skill_id,
          version: skill.version,
          source_hash: skill.hash,
        });
        const db = new Database(store.readLocation().database);
        try {
          db.query(
            "UPDATE skill_executions SET skill_id=?,version=?,view=? WHERE run_id=? AND execution_id=?",
          ).run(
            skill.skill_id,
            skill.version,
            JSON.stringify(owner),
            run.run_id,
            owner.execution_id,
          );
        } finally {
          db.close(true);
        }
      };
      const stage = (skill: typeof a | null) => {
        let checkpoint = store.beginHistoryProjection(run.run_id);
        const target = checkpoint.target_through;
        for (let batches = 0; batches < 1000; batches++) {
          expect(checkpoint.phase).toBe("index");
          const batch = prepareHistoryProjectionBatch(
            store,
            run.run_id,
            checkpoint,
            1,
          );
          // A discarded readonly preview must not consume the pending scope change.
          expect(
            prepareHistoryProjectionBatch(store, run.run_id, checkpoint, 1),
          ).toEqual(batch);
          expect(batch.patches.length).toBeLessThanOrEqual(64);
          expect(
            Buffer.byteLength(JSON.stringify(batch.after.job)),
          ).toBeLessThanOrEqual(8192);
          expect(
            Buffer.byteLength(
              JSON.stringify({
                id: Number.MAX_SAFE_INTEGER,
                ok: true,
                value: batch,
              }) + "\n",
            ),
          ).toBeLessThanOrEqual(65536);
          store.commitHistoryProjectionBatch(run.run_id, batch);
          checkpoint = batch.after;
          const indexed = store.historyProjectionRow(
            run.run_id,
            checkpoint.revision,
            "execution",
            owner.execution_id,
          );
          if (
            checkpoint.job.index_after === target &&
            (skill
              ? indexed?.source_id === skill.skill_id &&
                indexed.tag === JSON.stringify([skill.skill_id, skill.version])
              : !indexed)
          )
            return checkpoint;
        }
        throw new Error(
          "Scope mutation did not reach its bounded indexing checkpoint",
        );
      };
      mutate(b);
      const stagedB = stage(b);
      expect(stagedB.generation).toBe(seeded.projection.generation);
      await reader.close();
      store.close();
      store = new Store(fixture.directory);
      reader = new HistoryReader(store.readLocation());
      expect(store.historyProjectionCheckpoint(run.run_id)).toEqual(stagedB);
      if (finalScope === "deleted") {
        const db = new Database(store.readLocation().database);
        try {
          db.query(
            "DELETE FROM skill_executions WHERE run_id=? AND execution_id=?",
          ).run(run.run_id, owner.execution_id);
        } finally {
          db.close(true);
        }
      } else mutate(finalScope === "original" ? a : c);
      stage(
        finalScope === "deleted" ? null : finalScope === "original" ? a : c,
      );
      if (finalScope !== "deleted") {
        // Later same-scope status/counter indexing must not erase A's pending removal.
        owner.status = "unknown";
        owner.ended_at = "2020-01-01T00:00:01.000Z";
        owner.calls++;
        store.updateSkillExecution(
          owner,
          "skill.closed",
          "Resumed source progress",
        );
        stage(finalScope === "original" ? a : c);
      }
      await reader.close();
      store.close();
      store = new Store(fixture.directory);
      reader = new HistoryReader(store.readLocation());
      await new ImprovementLearning(store, reader).prepareFeedback(
        run.run_id,
        options(),
      );
      let page = await reader.query(
        {
          kind: "operator_feedback",
          run_id: run.run_id,
          after: seeded.next_after,
          limit: 1,
        },
        options(),
      );
      const delivered = [...page.metrics];
      for (let pages = 0; page.has_more; pages++) {
        expect(pages).toBeLessThan(10);
        expect(
          Buffer.byteLength(
            JSON.stringify({
              id: Number.MAX_SAFE_INTEGER,
              ok: true,
              value: page,
            }) + "\n",
          ),
        ).toBeLessThanOrEqual(65536);
        page = await reader.query(
          {
            kind: "operator_feedback",
            run_id: run.run_id,
            after: page.next_after,
            limit: 1,
          },
          options(),
        );
        delivered.push(...page.metrics);
      }
      const summary = delivered.map((metric) => ({
        kind: metric.kind,
        program: metric.program,
        execution_id: metric.execution_id,
        execution_ordinal: metric.execution_ordinal,
      }));
      const expected = [
        ...(finalScope === "original"
          ? []
          : [
              {
                kind: "retract" as const,
                program: { name: a.name, version: a.version },
                execution_id: owner.execution_id,
                execution_ordinal: ordinal,
              },
            ]),
        ...(finalScope === "deleted"
          ? []
          : [
              {
                kind: "replace" as const,
                program:
                  finalScope === "original"
                    ? { name: a.name, version: a.version }
                    : { name: c.name, version: c.version },
                execution_id: owner.execution_id,
                execution_ordinal: ordinal,
              },
            ]),
      ];
      expect(summary).toEqual(expected);
      expect(page.projection.has_pending).toBe(false);
      expect(
        (
          await reader.query(
            {
              kind: "operator_feedback",
              run_id: run.run_id,
              after: page.next_after,
              limit: 1,
            },
            options(),
          )
        ).metrics,
      ).toEqual([]);
      for (const [index, skill] of [a, b, c].entries()) {
        const after = improvementFeedbackCursorSchema.parse(
          evidenceObject(namedSeeds[index])?.next_after,
        );
        const selected = await named(skill, after);
        const selectedExpected = expected
          .filter(
            (metric) =>
              metric.program.name === skill.name &&
              metric.program.version === skill.version,
          )
          .map(({ execution_id: _id, ...metric }) => metric);
        expect(selected).toMatchObject({
          metrics: selectedExpected.map((metric) =>
            expect.objectContaining(metric),
          ),
        });
        expect(evidenceObject(selected)?.metrics).toHaveLength(
          selectedExpected.length,
        );
        expect(JSON.stringify(selected)).not.toContain(owner.execution_id);
      }
    } finally {
      await reader.close();
      store.close();
      fixture.close();
    }
  });
}
