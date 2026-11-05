import type { ActivityEvent, Json } from "../shared/contracts.ts";
import type { SkillExecutionView } from "../shared/programs.ts";
import { programCompatibilitySchema } from "../shared/adapter.ts";
import { confirmedMinecraftGuiTransactions } from "../shared/minecraft.ts";
import { verificationResultSchema } from "../shared/validation.ts";
import {
  currentGoalLinks,
  type DetailedProgramEvidence,
  type GoalRelationship,
  type OwnedAction,
  type OwnedController,
} from "./program-evidence.ts";
import {
  confirmedRemoval,
  eligibleLog,
  receiptedInventoryDelta,
} from "./objective-metrics.ts";
import { residentReceiptSchema } from "./resident-evidence.ts";
import { contractHash } from "./adapter-contract.ts";
import type {
  HistorySourceKind,
  HistorySourceRecord,
} from "./history-source.ts";
import type {
  ProjectionCollection,
  ProjectionDraft,
  ProjectionQuery,
  ProjectionRow,
} from "./history-projection.ts";
import { readProjectedObjectiveMetric } from "./history-objective.ts";
import type { StoreReadQueries } from "./store-read.ts";
import type { StoredRun } from "./store.ts";

const object = (value: unknown): Record<string, Json> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : null;
const data = (row: ProjectionRow): Record<string, Json> => object(row.value)!;
const pad = (value: number): string => String(value).padStart(20, "0");
const cursor = (row: ProjectionRow) => ({
  order_seq: row.order_seq,
  key: row.key,
});
function put(
  draft: ProjectionDraft,
  collection: ProjectionCollection,
  key: string,
  value: Json,
  owner_id: string | null = null,
  source_id: string | null = null,
  order_seq = 0,
  tag: string | null = null,
): boolean {
  return draft.put({
    collection,
    key,
    value,
    owner_id,
    source_id,
    order_seq,
    tag,
  });
}
// Finish expansion before qualifying actions: qualification changes their scan
// order. Coalesce every notification before any goal can rebuild dependencies.
const evidenceWorkPriority = {
  skill: 0,
  global: 1,
  owner: 2,
  action: 3,
  notify: 4,
  goal: 5,
} as const;
type EvidenceWorkType = keyof typeof evidenceWorkPriority;
function putEvidenceWork(
  draft: ProjectionDraft,
  key: string,
  value: Record<string, Json> & { type: EvidenceWorkType },
): boolean {
  return put(
    draft,
    "dirty_evidence",
    key,
    value,
    null,
    null,
    evidenceWorkPriority[value.type],
  );
}
function dirty(
  draft: ProjectionDraft,
  type: EvidenceWorkType,
  id: string,
): boolean {
  const key = JSON.stringify([type, id]);
  if (draft.get("dirty_evidence", key)) return true;
  return putEvidenceWork(draft, key, { type, id });
}
function notifyActionAfter(
  draft: ProjectionDraft,
  id: string,
  endedOrder: number,
): boolean {
  const key = JSON.stringify(["notify", id]),
    previous = draft.get("dirty_evidence", key),
    previousOrder = previous ? data(previous).ended_order : null;
  // All action qualification finishes before notification fanout. Coalesce the
  // old and new eligibility intervals, retaining the earliest affected cutoff.
  if (
    previous &&
    (typeof previousOrder !== "number" || previousOrder <= endedOrder)
  )
    return true;
  return putEvidenceWork(draft, key, {
    type: "notify",
    id,
    ended_order: endedOrder,
  });
}
function eventAt(draft: ProjectionDraft, key: string): ActivityEvent | null {
  const record = draft.store.historySourceRecord(
    draft.runId,
    "event",
    key,
    draft.through,
  );
  return record ? draft.store.decodeHistorySource("event", record) : null;
}
function ownerAt(
  draft: ProjectionDraft,
  key: string,
): SkillExecutionView | null {
  return draft.source.skillExecution(draft.runId, { execution_id: key });
}
function actionScope(action: OwnedAction["action"]): string | null {
  const scope = action.view.scope;
  // Observation collectors deliberately have no space/root restriction: match the oracle.
  return scope
    ? JSON.stringify([
        scope.run_id,
        scope.world_id,
        scope.session_id,
        scope.epoch,
        scope.native_boot_id,
        scope.run_generation,
        scope.life_id,
      ])
    : null;
}
function observationScope(evidence: Record<string, Json>): string | null {
  const scope = object(evidence.scope);
  return scope
    ? JSON.stringify([
        scope.run_id,
        scope.world_id,
        scope.session_id,
        scope.epoch,
        scope.native_boot_id,
        scope.run_generation,
        scope.life_id,
      ])
    : null;
}
function actionEntry(draft: ProjectionDraft, id: string): OwnedAction | null {
  const indexed = draft.get("evidence_action", id);
  if (!indexed || indexed.tag === "unqualified") return null;
  const action = draft.source.getAction(draft.runId, id);
  const owner = action?.view.execution_id
    ? ownerAt(draft, action.view.execution_id)
    : null;
  return action && owner ? { action, owner } : null;
}
function controllerEntry(
  draft: ProjectionDraft,
  id: string,
): OwnedController | null {
  const rows = draft.page({
    collection: "controller",
    source_id: id,
    tag: "qualified",
    limit: 2,
  });
  if (rows.length !== 1) return null;
  const event = eventAt(draft, rows[0]!.key);
  const parsed = residentReceiptSchema.safeParse(event?.details);
  const owner = parsed.success
    ? ownerAt(draft, parsed.data.scope.execution_id)
    : null;
  return event && parsed.success && owner
    ? { event, receipt: parsed.data, owner }
    : null;
}
function qualifyAction(draft: ProjectionDraft, id: string): boolean {
  const previous = draft.get("evidence_action", id);
  const action = draft.source.getAction(draft.runId, id);
  const owner = action?.view.execution_id
    ? ownerAt(draft, action.view.execution_id)
    : null;
  const terminal = action
    ? draft.page({
        collection: "evidence_terminal",
        owner_id: id,
        tag: `action.${action.view.status}`,
        limit: 1,
      })[0]
    : null;
  const whole =
    action?.view.status === "succeeded" &&
    object(action.view.result?.evidence)?.effect_confirmed === true;
  const qualified = !!(
    action &&
    owner &&
    terminal &&
    (whole ||
      confirmedMinecraftGuiTransactions(
        action.request,
        action.view.result?.evidence,
      ).length)
  );
  const scope = action ? actionScope(action) : null;
  // Non-positive/unparseable dates conservatively share the first bucket.
  // The exact source predicates below remain authoritative.
  const endedAt = Date.parse(action?.view.ended_at ?? ""),
    endedOrder = Number.isSafeInteger(endedAt) && endedAt > 0 ? endedAt : 0;
  if (
    previous &&
    data(previous).qualified === true &&
    typeof data(previous).scope === "string" &&
    !notifyActionAfter(
      draft,
      `scope:${data(previous).scope}`,
      typeof data(previous).ended_order === "number"
        ? (data(previous).ended_order as number)
        : 0,
    )
  )
    return false;
  if (
    qualified &&
    scope &&
    !notifyActionAfter(draft, `scope:${scope}`, endedOrder)
  )
    return false;
  if (
    previous &&
    data(previous).whole === true &&
    !notifyActionAfter(
      draft,
      "legacy",
      typeof data(previous).ended_order === "number"
        ? (data(previous).ended_order as number)
        : 0,
    )
  )
    return false;
  if (qualified && whole && !notifyActionAfter(draft, "legacy", endedOrder))
    return false;
  if (!dirty(draft, "notify", `action:${id}`)) return false;
  for (const effect of draft.page({
    collection: "evidence_effect",
    source_id: id,
    limit: 3,
  }))
    if (!draft.delete("evidence_effect", effect.key)) return false;
  if (qualified && whole && owner) {
    for (const executionId of new Set([
      owner.execution_id,
      owner.root_execution_id,
    ]))
      if (
        !put(
          draft,
          "evidence_effect",
          JSON.stringify([id, executionId]),
          null,
          executionId,
          id,
          terminal!.order_seq,
        )
      )
        return false;
  }
  if (qualified && scope && action?.view.ended_at) {
    if (
      !put(
        draft,
        "goal_candidate",
        id,
        null,
        scope,
        id,
        endedOrder,
        whole ? "whole" : "prefix",
      )
    )
      return false;
  } else if (!draft.delete("goal_candidate", id)) return false;
  if (!action) return draft.delete("evidence_action", id);
  return put(
    draft,
    "evidence_action",
    id,
    {
      scope,
      terminal: terminal?.key ?? null,
      whole: qualified && whole,
      qualified,
      ended_order: endedOrder,
    },
    action.view.execution_id,
    action.view.execution_id,
    terminal?.order_seq ?? 0,
    qualified ? (whole ? "whole" : "prefix") : "unqualified",
  );
}
function qualifyController(draft: ProjectionDraft, key: string): boolean {
  const previous = draft.get("controller", key);
  const event = eventAt(draft, key);
  const parsed = residentReceiptSchema.safeParse(event?.details);
  if (!parsed.success || !event || event.type !== "controller.receipted") {
    if (
      previous?.source_id &&
      !dirty(draft, "notify", `controller:${previous.source_id}`)
    )
      return false;
    return draft.delete("controller", key);
  }
  const receipt = parsed.data,
    scope = receipt.scope,
    owner = ownerAt(draft, scope.execution_id),
    run = draft.source.getRun(draft.runId);
  const qualified = !!(
    owner?.entry === "step" &&
    owner.source_hash === scope.source_hash &&
    owner.compatibility_hash === receipt.compatibility_hash &&
    receipt.compatibility_hash === run?.compatibility_hash &&
    owner.run_id === scope.run_id &&
    owner.world_id === scope.world_id &&
    owner.session_id === scope.session_id &&
    owner.epoch === scope.epoch &&
    owner.native_boot_id === scope.native_boot_id &&
    owner.run_generation === scope.run_generation &&
    owner.life_id === scope.life_id &&
    owner.space_epoch === scope.space_epoch &&
    scope.source_hash === draft.source.skill(draft.runId, owner).hash &&
    receipt.input_id ===
      `controller:${owner.execution_id}:${receipt.update.controller_generation}:${receipt.update.sequence}`
  );
  if (
    previous?.source_id &&
    !dirty(draft, "notify", `controller:${previous.source_id}`)
  )
    return false;
  if (!dirty(draft, "notify", `controller:${receipt.input_id}`)) return false;
  return put(
    draft,
    "controller",
    key,
    null,
    scope.execution_id,
    receipt.input_id,
    event.event_seq,
    qualified ? "qualified" : "unqualified",
  );
}

/** Index source identities only; qualification and dependency fanout are durable bounded jobs. */
export function indexEvidenceSource(
  draft: ProjectionDraft,
  kind: HistorySourceKind,
  record: HistorySourceRecord | null,
  key: string,
): boolean {
  if (kind === "run") {
    const run = record ? draft.store.decodeHistorySource("run", record) : null;
    // Qualification reads these fields, not turns, usage, status or wall-clock progress.
    // Hash the baseline rather than persisting another potentially large inventory.
    const signature = contractHash(
      run
        ? [
            run.run_id,
            run.world_id,
            run.session_id,
            run.epoch,
            run.native_boot_id,
            run.compatibility_hash,
            typeof run.goal === "string"
              ? run.goal
              : [
                  run.goal.adapter_id,
                  run.goal.goal_id,
                  run.goal.verifier
                    ? [run.goal.verifier.id, run.goal.verifier.version]
                    : null,
                ],
            run.baseline,
          ].map((value) => value ?? null)
        : null,
    );
    const stateKey = "evidence_run_qualification";
    if (draft.get("run_state", stateKey)?.value === signature) return true;
    return (
      put(draft, "run_state", stateKey, signature) &&
      dirty(draft, "global", "run")
    );
  }
  if (kind === "skill") return dirty(draft, "skill", key);
  if (kind === "execution") {
    const owner = record
      ? draft.store.decodeHistorySource("execution", record)
      : null;
    // Include presence, attribution, source/scope and controller receipt intervals.
    // Counters, resident state and results remain fresh source-frontier reads below.
    const signature = contractHash(
      owner
        ? [
            owner.execution_id,
            owner.root_execution_id,
            owner.skill_id,
            owner.version,
            owner.entry,
            owner.run_id,
            owner.world_id,
            owner.session_id,
            owner.epoch,
            owner.native_boot_id,
            owner.run_generation,
            owner.life_id,
            owner.space_epoch,
            owner.source_hash,
            owner.compatibility_hash,
            owner.started_at,
            owner.ended_at,
          ].map((value) => value ?? null)
        : null,
    );
    const stateKey = JSON.stringify(["evidence_owner_qualification", key]);
    if (draft.get("run_state", stateKey)?.value === signature) return true;
    return (
      put(draft, "run_state", stateKey, signature) && dirty(draft, "owner", key)
    );
  }
  if (kind === "action") {
    if (record) {
      const action = draft.store.decodeHistorySource("action", record);
      if (
        !draft.get("evidence_action", key) &&
        !put(
          draft,
          "evidence_action",
          key,
          {
            scope: actionScope(action),
            qualified: false,
            whole: false,
            terminal: null,
          },
          action.view.execution_id,
          action.view.execution_id,
          0,
          "unqualified",
        )
      )
        return false;
    }
    return dirty(draft, "action", key);
  }
  if (kind !== "event") return true;
  for (const collection of [
    "model_call",
    "compatibility",
    "fact",
    "controller",
    "promotion",
    "goal",
    "evidence_terminal",
  ] as const) {
    const previous = draft.get(collection, key);
    if (!previous) continue;
    if (
      collection === "fact" &&
      previous.owner_id &&
      !dirty(draft, "notify", `fact:${previous.owner_id}`)
    )
      return false;
    if (
      collection === "controller" &&
      previous.source_id &&
      !dirty(draft, "notify", `controller:${previous.source_id}`)
    )
      return false;
    if (
      collection === "evidence_terminal" &&
      previous.owner_id &&
      !dirty(draft, "action", previous.owner_id)
    )
      return false;
    if (collection === "compatibility" && !dirty(draft, "global", "goals"))
      return false;
    if (collection === "goal" && !dirty(draft, "goal", key)) return false;
    if (!draft.delete(collection, key)) return false;
  }
  if (!record) return true;
  const event = draft.store.decodeHistorySource("event", record),
    details = object(event.details);
  if (event.type === "model.call" && details?.backend !== "jev")
    return put(
      draft,
      "model_call",
      key,
      null,
      null,
      null,
      event.event_seq,
      event.at,
    );
  if (event.type === "run.adapter") {
    const parsed = programCompatibilitySchema.safeParse(event.details);
    return (
      !parsed.success ||
      (put(
        draft,
        "compatibility",
        key,
        null,
        null,
        parsed.data.compatibility_hash,
        event.event_seq,
      ) &&
        dirty(draft, "global", "goals"))
    );
  }
  if (
    event.type === "adapter.evidence" &&
    typeof details?.evidence_id === "string"
  )
    return (
      put(
        draft,
        "fact",
        key,
        null,
        details.evidence_id,
        null,
        event.event_seq,
      ) && dirty(draft, "notify", `fact:${details.evidence_id}`)
    );
  if (event.type === "controller.receipted")
    return qualifyController(draft, key);
  if (
    [
      "action.succeeded",
      "action.failed",
      "action.cancelled",
      "action.unknown",
    ].includes(event.type) &&
    typeof details?.action_id === "string"
  )
    return (
      put(
        draft,
        "evidence_terminal",
        key,
        null,
        details.action_id,
        null,
        event.event_seq,
        event.type,
      ) && dirty(draft, "action", details.action_id)
    );
  if (event.type === "experience.promoted") {
    const evidence = object(details?.evidence),
      predicate = object(evidence?.predicate);
    return (
      typeof evidence?.execution_id !== "string" ||
      typeof predicate?.event_seq !== "number" ||
      put(
        draft,
        "promotion",
        key,
        {
          event_seq: predicate.event_seq,
          status:
            predicate.kind === "goal_verified"
              ? "verified_goal"
              : "verified_predicate",
        },
        evidence.execution_id,
        null,
        event.event_seq,
      )
    );
  }
  if (event.type === "goal.verified")
    return (
      put(draft, "goal", key, null, null, null, event.event_seq) &&
      dirty(draft, "goal", key)
    );
  return true;
}

type GoalContext = {
  run: StoredRun | null;
  event: ActivityEvent | null;
  retained: Map<string, ActivityEvent | null>;
  confirmed: Map<string, OwnedAction>;
  receipted: Map<string, OwnedAction>;
  controllers: Map<string, OwnedController | null>;
  terms: string[];
  cutoffs: Map<string, number>;
  links: Map<string, GoalRelationship> | null;
  current: boolean;
};
function goalContext(draft: ProjectionDraft, key: string): GoalContext {
  const run = draft.source.getRun(draft.runId),
    sourceEvent = eventAt(draft, key);
  const event = sourceEvent?.type === "goal.verified" ? sourceEvent : null;
  const retained = new Map<string, ActivityEvent | null>(),
    confirmed = new Map<string, OwnedAction>(),
    receipted = new Map<string, OwnedAction>(),
    controllers = new Map<string, OwnedController | null>();
  const terms = new Set<string>(),
    cutoffs = new Map<string, number>();
  const parsed = verificationResultSchema.safeParse(event?.details);
  for (const id of new Set(parsed.success ? parsed.data.evidence_refs : [])) {
    terms.add(`fact:${id}`);
    const rows = draft.page({ collection: "fact", owner_id: id, limit: 2 });
    const fact = rows.length === 1 ? eventAt(draft, rows[0]!.key) : null;
    retained.set(id, fact);
    const evidence = object(fact?.details),
      body = object(evidence?.data),
      schema = object(evidence?.schema);
    if (!evidence) continue;
    if (schema?.id === "observation_v3") {
      const scope = observationScope(evidence);
      if (scope) {
        const term = `scope:${scope}`,
          at = Math.min(
            Date.parse(event?.at ?? ""),
            Date.parse(
              typeof body?.captured_at === "string" ? body.captured_at : "",
            ),
          ),
          cutoff = Number.isSafeInteger(at) && at > 0 ? at : 0;
        terms.add(term);
        cutoffs.set(term, Math.max(cutoffs.get(term) ?? 0, cutoff));
      }
    }
    const actionIds = new Set<string>();
    if (typeof body?.receipt_ref === "string") actionIds.add(body.receipt_ref);
    if (
      schema?.id === "minecraft_gui_transaction_v1" &&
      typeof body?.operation_index === "number"
    ) {
      const suffix = `:gui:${body.operation_index}`;
      if (id.endsWith(suffix)) {
        const inputId = id.slice(0, -suffix.length);
        terms.add(`controller:${inputId}`);
        controllers.set(inputId, controllerEntry(draft, inputId));
        actionIds.add(inputId);
      }
    }
    for (const actionId of actionIds) {
      terms.add(`action:${actionId}`);
      const entry = actionEntry(draft, actionId);
      if (!entry) continue;
      receipted.set(actionId, entry);
      if (draft.get("evidence_action", actionId)?.tag === "whole")
        confirmed.set(actionId, entry);
    }
  }
  const current = !!run && typeof run.goal !== "string";
  if (!current) {
    terms.add("legacy");
    const at = Date.parse(event?.at ?? "");
    cutoffs.set("legacy", Number.isSafeInteger(at) && at > 0 ? at : 0);
  }
  const descriptor = run
    ? draft.page({
        collection: "compatibility",
        source_id: run.compatibility_hash,
        descending: true,
        limit: 1,
      })[0]
    : null;
  const compatibility = programCompatibilitySchema.safeParse(
    descriptor ? eventAt(draft, descriptor.key)?.details : null,
  );
  const links =
    current && event
      ? currentGoalLinks(
          run!,
          event,
          retained,
          compatibility.success ? compatibility.data : null,
          confirmed,
          receipted,
          controllers,
        )
      : null;
  return {
    run,
    event,
    retained,
    confirmed,
    receipted,
    controllers,
    terms: [...terms],
    cutoffs,
    links,
    current,
  };
}
function addLinks(
  draft: ProjectionDraft,
  goalKey: string,
  event: ActivityEvent,
  entry: OwnedAction | OwnedController,
  id: string,
  relationship: GoalRelationship,
  controller: boolean,
  order: number,
): boolean {
  const owner = entry.owner;
  for (const executionId of new Set([
    owner.execution_id,
    owner.root_execution_id,
  ])) {
    const key = `${pad(event.event_seq)}:${controller ? "c" : "a"}:${pad(order)}:${JSON.stringify([id, executionId])}`;
    const association: DetailedProgramEvidence["goal_associations"][number] = {
      event_seq: event.event_seq,
      relationship,
      action_id: controller ? null : id,
      causal_item_origin: "unknown",
    };
    if ("receipt" in entry)
      association.controller_input = {
        input_id: id,
        generation: entry.receipt.update.controller_generation,
        sequence: entry.receipt.update.sequence,
      };
    if (
      !put(
        draft,
        "goal_link",
        key,
        association as unknown as Json,
        executionId,
        goalKey,
        event.event_seq,
        relationship,
      )
    )
      return false;
  }
  return true;
}
function stepGoal(draft: ProjectionDraft, queue: ProjectionRow): boolean {
  const state = data(queue),
    key = state.id as string,
    stage = typeof state.stage === "string" ? state.stage : "clear_links";
  const save = (stage: string, after: Json = null) =>
    putEvidenceWork(draft, queue.key, { type: "goal", id: key, stage, after });
  if (stage === "clear_links" || stage === "clear_dependencies") {
    const collection =
      stage === "clear_links" ? "goal_link" : "goal_dependency";
    const rows = draft.page({
      collection,
      ...(collection === "goal_link" ? { source_id: key } : { owner_id: key }),
      ...(object(state.after)
        ? {
            after: {
              order_seq: object(state.after)!.order_seq as number,
              key: object(state.after)!.key as string,
            },
          }
        : {}),
      limit: 1,
    });
    if (rows.length)
      return (
        draft.delete(collection, rows[0]!.key) &&
        save(stage, cursor(rows[0]!) as unknown as Json)
      );
    return save(
      stage === "clear_links" ? "clear_dependencies" : "dependencies",
      0,
    );
  }
  const context = goalContext(draft, key);
  if (stage === "dependencies") {
    const offset = typeof state.after === "number" ? state.after : 0,
      term = context.terms[offset];
    if (term !== undefined)
      return (
        put(
          draft,
          "goal_dependency",
          JSON.stringify([key, term]),
          null,
          key,
          term,
          context.cutoffs.get(term) ?? 0,
        ) && save(stage, offset + 1)
      );
    return save(context.current ? "mandatory_actions" : "actions");
  }
  if (!context.event || !context.run || (context.current && !context.links))
    return draft.delete("dirty_evidence", queue.key);
  if (
    !context.current &&
    (typeof object(context.event.details)?.goal !== "string" ||
      object(context.event.details)?.goal !== context.run.goal)
  )
    return draft.delete("dirty_evidence", queue.key);
  if (stage === "mandatory_actions") {
    const actions = [...context.receipted]
      .map(([id, entry]) => ({
        id,
        entry,
        row: draft.get("evidence_action", id)!,
      }))
      .sort(
        (a, b) =>
          a.row.order_seq - b.row.order_seq ||
          Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)),
      );
    const offset = typeof state.after === "number" ? state.after : 0,
      candidate = actions[offset];
    if (!candidate) return save("actions");
    const relationship = context.links?.get(candidate.id);
    if (
      relationship &&
      (!candidate.entry.action.view.ended_at ||
        candidate.entry.action.view.ended_at <= context.event.at) &&
      !addLinks(
        draft,
        key,
        context.event,
        candidate.entry,
        candidate.id,
        relationship,
        false,
        candidate.row.order_seq,
      )
    )
      return false;
    return save(stage, offset + 1);
  }
  if (stage === "actions") {
    const after = object(state.after);
    const scopes = context.terms.filter((term) => term.startsWith("scope:"));
    const scopeIndex =
      typeof state.scope_index === "number" ? state.scope_index : 0;
    if (context.current && scopeIndex >= scopes.length)
      return save("controllers");
    const rows = draft.page({
      ...(context.current
        ? {
            collection: "goal_candidate" as const,
            owner_id: scopes[scopeIndex]!.slice(6),
            before_order: (context.cutoffs.get(scopes[scopeIndex]!) ?? 0) + 1,
          }
        : { collection: "evidence_action" as const, tag: "whole" }),
      ...(after
        ? {
            after: {
              order_seq: after.order_seq as number,
              key: after.key as string,
            },
          }
        : {}),
      limit: 1,
    });
    if (!rows.length) {
      if (!context.current) return save("controllers");
      return putEvidenceWork(draft, queue.key, {
        type: "goal",
        id: key,
        stage,
        scope_index: scopeIndex + 1,
        after: null,
      });
    }
    const row = rows[0]!,
      entry = actionEntry(draft, row.key);
    if (
      entry &&
      (!context.current || !context.receipted.has(row.key)) &&
      (!entry.action.view.ended_at ||
        entry.action.view.ended_at <= context.event.at)
    ) {
      let relationship: GoalRelationship | undefined;
      if (context.current) {
        // The mandatory maps are bounded by the verdict's 256 direct references.
        // Optional collectors are evaluated one at a time, never accumulated.
        const confirmed = new Map(context.confirmed),
          receipted = new Map(context.receipted);
        receipted.set(row.key, entry);
        if (row.tag === "whole") confirmed.set(row.key, entry);
        const descriptor = draft.page({
          collection: "compatibility",
          source_id: context.run.compatibility_hash,
          descending: true,
          limit: 1,
        })[0];
        const compatibility = programCompatibilitySchema.safeParse(
          descriptor ? eventAt(draft, descriptor.key)?.details : null,
        );
        relationship = currentGoalLinks(
          context.run,
          context.event,
          context.retained,
          compatibility.success ? compatibility.data : null,
          confirmed,
          receipted,
          context.controllers,
        )?.get(row.key);
      } else if (row.tag === "whole") {
        const details = object(context.event.details)!,
          receipt = object(entry.action.view.result?.evidence);
        const collector =
          typeof details.item === "string" &&
          (receiptedInventoryDelta(entry.action)?.[details.item] ?? 0) > 0;
        const removal =
          confirmedRemoval(entry.action) &&
          typeof receipt?.target_name === "string" &&
          eligibleLog(receipt.target_name);
        const direct =
          details.action_id === row.key &&
          (details.goal === "break_log"
            ? removal
            : collector || entry.action.request.kind === "craft");
        relationship = direct
          ? "direct_receipt"
          : collector
            ? "inventory_collector"
            : removal
              ? "block_removal_contributor"
              : undefined;
      }
      if (
        relationship &&
        !addLinks(
          draft,
          key,
          context.event,
          entry,
          row.key,
          relationship,
          false,
          context.current
            ? draft.get("evidence_action", row.key)!.order_seq
            : row.order_seq,
        )
      )
        return false;
    }
    return putEvidenceWork(draft, queue.key, {
      type: "goal",
      id: key,
      stage,
      scope_index: scopeIndex,
      after: cursor(row) as unknown as Json,
    });
  }
  const controllers = [...context.controllers]
    .flatMap(([id, entry]) => (entry ? [{ id, entry }] : []))
    .sort((a, b) => a.entry.event.event_seq - b.entry.event.event_seq);
  const offset = typeof state.after === "number" ? state.after : 0,
    candidate = controllers[offset];
  if (!candidate) return draft.delete("dirty_evidence", queue.key);
  const relationship = context.links?.get(candidate.id);
  if (
    relationship &&
    !addLinks(
      draft,
      key,
      context.event,
      candidate.entry,
      candidate.id,
      relationship,
      true,
      candidate.entry.event.event_seq,
    )
  )
    return false;
  return save(stage, offset + 1);
}

/** Dependency-ordered work; every priority and fanout cursor survives cancellation/reopen. */
export function stepEvidenceProjection(draft: ProjectionDraft): boolean {
  const queue = draft.page({ collection: "dirty_evidence", limit: 1 })[0];
  if (!queue) return false;
  const state = data(queue),
    type = state.type as EvidenceWorkType,
    id = state.id as string;
  return draft.atomic(() => {
    if (type === "goal") return stepGoal(draft, queue);
    if (type === "action")
      return (
        qualifyAction(draft, id) && draft.delete("dirty_evidence", queue.key)
      );
    const after = object(state.after),
      stage =
        typeof state.stage === "string"
          ? state.stage
          : type === "notify"
            ? "dependencies"
            : type === "global" && id === "goals"
              ? "goals"
              : "actions";
    let query: ProjectionQuery;
    if (type === "notify")
      query = {
        collection: "goal_dependency",
        source_id: id,
        ...(typeof state.ended_order === "number" && state.ended_order > 0
          ? { after_order: state.ended_order - 1 }
          : {}),
      };
    else if (type === "skill") query = { collection: "execution", tag: id };
    else if (stage === "actions")
      query = {
        collection: "evidence_action",
        ...(type === "owner" ? { source_id: id } : {}),
      };
    else if (stage === "controllers")
      query = {
        collection: "controller",
        ...(type === "owner" ? { owner_id: id } : {}),
      };
    else query = { collection: "goal" };
    const rows = draft.page({
      ...query,
      ...(after
        ? {
            after: {
              order_seq: after.order_seq as number,
              key: after.key as string,
            },
          }
        : {}),
      limit: 1,
    });
    if (rows.length) {
      const row = rows[0]!;
      if (type === "notify") {
        if (row.owner_id && !dirty(draft, "goal", row.owner_id)) return false;
      } else if (type === "skill") {
        if (!dirty(draft, "owner", row.key)) return false;
      } else if (stage === "actions") {
        if (!dirty(draft, "action", row.key)) return false;
      } else if (stage === "controllers") {
        if (!qualifyController(draft, row.key)) return false;
      } else if (!dirty(draft, "goal", row.key)) return false;
      return putEvidenceWork(draft, queue.key, {
        type,
        id,
        stage,
        after: cursor(row) as unknown as Json,
        ...(typeof state.ended_order === "number"
          ? { ended_order: state.ended_order }
          : {}),
      });
    }
    if (
      type === "notify" ||
      type === "skill" ||
      stage === "goals" ||
      (type === "owner" && stage === "controllers")
    )
      return draft.delete("dirty_evidence", queue.key);
    return putEvidenceWork(draft, queue.key, {
      type,
      id,
      stage: stage === "actions" ? "controllers" : "goals",
      after: null,
    });
  });
}

export type ProjectedProgramEvidenceOptions = {
  generation?: number;
  offset?: number;
  limit?: number;
  skill_id?: string;
  version?: number;
  eligible_only?: boolean;
};
function executionQuery(
  options: ProjectedProgramEvidenceOptions,
): ProjectionQuery {
  return {
    collection: options.eligible_only ? "metric_population" : "execution",
    ...(options.skill_id !== undefined
      ? options.version !== undefined
        ? { tag: JSON.stringify([options.skill_id, options.version]) }
        : { source_id: options.skill_id }
      : {}),
  };
}
export function countProjectedProgramEvidence(
  store: StoreReadQueries,
  runId: string,
  options: ProjectedProgramEvidenceOptions = {},
): number {
  const generation = store.historyProjectionGeneration(
    runId,
    options.generation,
  );
  return generation
    ? store.historyProjectionCount(
        runId,
        generation.revision,
        executionQuery(options),
      )
    : 0;
}
function* rows(
  store: StoreReadQueries,
  runId: string,
  revision: number,
  query: ProjectionQuery,
): Generator<ProjectionRow> {
  let after: { order_seq: number; key: string } | undefined;
  while (true) {
    const page = store.historyProjectionRows(runId, revision, {
      ...query,
      after,
      limit: 128,
    });
    for (const row of page) yield row;
    if (page.length < 128) break;
    after = cursor(page[page.length - 1]!);
  }
}
export function readProjectedProgramEvidence(
  store: StoreReadQueries,
  runId: string,
  executionId: string,
  generationId?: number,
): DetailedProgramEvidence | null {
  const generation = store.historyProjectionGeneration(runId, generationId);
  if (
    !generation ||
    !store.historyProjectionRow(
      runId,
      generation.revision,
      "execution",
      executionId,
    )
  )
    return null;
  const record = store.historySourceRecord(
    runId,
    "execution",
    executionId,
    generation.source_through,
  );
  if (!record) return null;
  const execution = store.decodeHistorySource("execution", record),
    start = execution.started_at ? Date.parse(execution.started_at) : null;
  const skillRecord = store.historySourceRecord(
    runId,
    "skill",
    JSON.stringify([execution.skill_id, execution.version]),
    generation.source_through,
  );
  if (!skillRecord)
    throw new Error("Published evidence skill source is missing");
  // Canonical hydration rehashes the external artifact on every evidence read.
  const compactness = store.decodeHistorySource(
    "skill",
    skillRecord,
  ).validation;
  // Owner and root attribution are distinct and deduplicated, not ancestor rollup.
  const confirmedEffects = store.historyProjectionCount(
    runId,
    generation.revision,
    { collection: "evidence_effect", owner_id: executionId },
  );
  let status: DetailedProgramEvidence["evidence_status"] = execution.result
    ? "self_reported"
    : "unknown";
  if (confirmedEffects) status = "confirmed_effects";
  const refs = new Set<number>();
  for (const row of rows(store, runId, generation.revision, {
    collection: "promotion",
    owner_id: executionId,
  })) {
    const value = data(row);
    status = value.status as DetailedProgramEvidence["evidence_status"];
    refs.add(value.event_seq as number);
  }
  const runRecord = store.historySourceRecord(
      runId,
      "run",
      runId,
      generation.source_through,
    ),
    run = runRecord ? store.decodeHistorySource("run", runRecord) : null;
  const associations: DetailedProgramEvidence["goal_associations"] = [];
  for (const row of rows(store, runId, generation.revision, {
    collection: "goal_link",
    owner_id: executionId,
  })) {
    const association =
      row.value as unknown as DetailedProgramEvidence["goal_associations"][number];
    associations.push(association);
    if (
      association.relationship === "direct_receipt" ||
      (association.relationship === "inventory_collector" &&
        run &&
        typeof run.goal !== "string" &&
        ["collect_wood", "obtain_stone"].includes(run.goal.goal_id))
    ) {
      status = "verified_goal";
      refs.add(association.event_seq);
    }
  }
  const metrics = readProjectedObjectiveMetric(
    store,
    runId,
    executionId,
    generation.generation,
  );
  if (!metrics)
    throw new Error("Published evidence objective metric is missing");
  const calls = { collection: "model_call" as const };
  const strategicRequests =
    execution.started_at &&
    (!execution.ended_at || execution.ended_at >= execution.started_at)
      ? store.historyProjectionCount(runId, generation.revision, {
          ...calls,
          after_tag: execution.started_at,
          ...(execution.ended_at ? { before_tag: execution.ended_at } : {}),
        }) +
        store.historyProjectionCount(runId, generation.revision, {
          ...calls,
          tag: execution.started_at,
        }) +
        (execution.ended_at && execution.ended_at > execution.started_at
          ? store.historyProjectionCount(runId, generation.revision, {
              ...calls,
              tag: execution.ended_at,
            })
          : 0)
      : 0;
  return {
    execution_id: executionId,
    skill_id: execution.skill_id,
    version: execution.version,
    root_execution_id: execution.root_execution_id,
    status: execution.status,
    duration_ms:
      start === null
        ? null
        : Math.max(
            0,
            (execution.ended_at ? Date.parse(execution.ended_at) : Date.now()) -
              start,
          ),
    actions: execution.actions,
    calls: execution.calls,
    strategic_requests: strategicRequests,
    confirmed_effects: confirmedEffects,
    evidence_status: status,
    verified_event_seqs: [...refs],
    compactness,
    metrics,
    goal_associations: associations,
  };
}
export function readProjectedProgramEvidencePage(
  store: StoreReadQueries,
  runId: string,
  options: ProjectedProgramEvidenceOptions = {},
): {
  evidence: DetailedProgramEvidence[];
  total: number;
  next_offset: number;
  generation: number;
  source_through: number;
} | null {
  const generation = store.historyProjectionGeneration(
    runId,
    options.generation,
  );
  if (!generation) return null;
  const offset = options.offset ?? 0,
    limit = Math.max(1, Math.min(128, options.limit ?? 50)),
    query = executionQuery(options);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit)
  )
    throw new Error("Invalid projected evidence page");
  const total = store.historyProjectionCount(runId, generation.revision, query),
    evidence: DetailedProgramEvidence[] = [];
  for (const row of store.historyProjectionRows(runId, generation.revision, {
    ...query,
    offset,
    limit,
  })) {
    const value = readProjectedProgramEvidence(
      store,
      runId,
      row.key,
      generation.generation,
    );
    if (value) evidence.push(value);
    if (evidence.length === limit) break;
  }
  return {
    evidence,
    total,
    next_offset: offset + evidence.length,
    generation: generation.generation,
    source_through: generation.source_through,
  };
}
