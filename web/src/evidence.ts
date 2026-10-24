import type { ActivityEvent, GameState, Json, PolicyView, ProgramEvidenceView, RunView } from "../../src/shared/contracts.ts";
import { effectScopeSchema, type EffectScope } from "../../src/shared/control.ts";
import { minecraftObservationV3Schema } from "../../src/shared/minecraft.ts";
import { verificationResultSchema } from "../../src/shared/validation.ts";
import type { SkillExecutionView, SkillView } from "../../src/shared/programs.ts";
import type { ImprovementFeedbackCursor, ObjectiveMetrics, ProgramVersionEvidence, TracePage } from "../../src/shared/execution-evidence.ts";
import { fetchComparison, fetchDeaths, fetchHistory, fetchImprovementFeedback, fetchPlanning, fetchTrace } from "./api.ts";

type PromotionRun = Pick<RunView, "run_id" | "world_id" | "epoch" | "session_id" | "native_boot_id" | "compatibility_hash" | "goal">;
type PromotionEvidence = { kind: "goal_verified" } | { kind: "inventory_gain"; counts: Record<string, number> };
const evidenceRecord = (value: Json | undefined): Record<string, Json> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;

/** Follow only host-retained recovery transitions, never a changed live-run life field alone. */
function adoptedPromotionScope(event: ActivityEvent, run: PromotionRun, execution: SkillExecutionView,
  scope: EffectScope, history: readonly ActivityEvent[]): boolean {
  let life = execution.life_id, space = execution.space_epoch;
  const ordered = history.filter(record => record.run_id === run.run_id && record.event_seq < event.event_seq &&
    !!execution.started_at && record.at >= execution.started_at && record.at <= event.at)
    .sort((a, b) => a.event_seq - b.event_seq);
  for (const adoption of ordered) {
    if (adoption.type !== "skill.life_adopted") continue;
    const details = evidenceRecord(adoption.details);
    if (execution.parent_execution_id !== null || details?.execution_id !== execution.execution_id ||
      details.root_execution_id !== execution.root_execution_id || details.session_id !== execution.session_id ||
      details.previous_life_id !== life || typeof details.life_id !== "number" ||
      !Number.isSafeInteger(details.life_id) || details.life_id <= (life ?? -1) ||
      typeof details.respawn_action_id !== "string" || typeof details.observation_seq !== "number") continue;
    const accepted = ordered.find(record => {
      const value = evidenceRecord(record.details), request = evidenceRecord(value?.request);
      if (!value) return false;
      return record.type === "action.accepted" && record.event_seq < adoption.event_seq &&
        value.action_id === details.respawn_action_id && value.origin === "skill" &&
        value.execution_id === execution.execution_id && request?.kind === "respawn";
    });
    const succeeded = ordered.find(record => {
      const value = evidenceRecord(record.details), result = evidenceRecord(value?.result), receipt = evidenceRecord(result?.evidence);
      if (!value) return false;
      return record.type === "action.succeeded" && record.event_seq < adoption.event_seq &&
        !!accepted && record.event_seq > accepted.event_seq &&
        value.action_id === details.respawn_action_id && value.origin === "skill" &&
        value.execution_id === execution.execution_id && result?.status === "succeeded" && receipt?.effect_confirmed === true;
    });
    if (!accepted || !succeeded) continue;
    const observation = ordered.find(record => {
      if (record.type !== "adapter.evidence" || record.event_seq >= adoption.event_seq ||
        record.event_seq <= succeeded.event_seq) return false;
      const value = evidenceRecord(record.details), schema = evidenceRecord(value?.schema);
      const data = minecraftObservationV3Schema.safeParse(value?.data), witnessScope = effectScopeSchema.safeParse(value?.scope);
      return schema?.id === "observation_v3" && schema.version === 3 &&
        typeof run.goal !== "string" && value?.adapter_id === run.goal.adapter_id &&
        data.success && witnessScope.success && witnessScope.data.run_id === run.run_id &&
        witnessScope.data.world_id === run.world_id && witnessScope.data.session_id === run.session_id &&
        witnessScope.data.epoch === run.epoch && witnessScope.data.native_boot_id === run.native_boot_id &&
        witnessScope.data.run_generation === execution.run_generation &&
        witnessScope.data.life_id === details.life_id && witnessScope.data.space_epoch === data.data.space.space_epoch &&
        data.data.observation_seq === details.observation_seq && data.data.life.life_id === details.life_id &&
        data.data.life.status === "alive" && data.data.world_id === run.world_id && data.data.session_id === run.session_id &&
        data.data.epoch === run.epoch && data.data.native_boot_id === run.native_boot_id &&
        data.data.compatibility_hash === run.compatibility_hash;
    });
    if (!observation) continue;
    const parsed = minecraftObservationV3Schema.safeParse(evidenceRecord(observation.details)?.data);
    if (!parsed.success) continue;
    life = parsed.data.life.life_id; space = parsed.data.space.space_epoch;
  }
  return scope.life_id === life && scope.space_epoch === space;
}
/** Presentation eligibility only; the service still proves baseline gain and attributable effects. */
export function promotionEvidence(event: ActivityEvent, run: PromotionRun, execution: SkillExecutionView,
  history: readonly ActivityEvent[]): PromotionEvidence | null {
  if (event.run_id !== run.run_id || !execution.started_at || !execution.ended_at ||
    event.at < execution.started_at || event.at > execution.ended_at) return null;
  const details = evidenceRecord(event.details);
  if (typeof run.goal === "string") {
    if (event.type === "goal.verified" && typeof details?.goal === "string") return { kind: "goal_verified" };
    if (event.type !== "observation.inventory") return null;
    const historical = evidenceRecord(details?.counts);
    if (!historical) return null;
    const counts: Record<string, number> = Object.create(null);
    for (const [item, count] of Object.entries(historical)) {
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return null;
      if (count > 0) counts[item] = count;
    }
    return { kind: "inventory_gain", counts };
  }
  if (event.type === "goal.verified") {
    const verdict = verificationResultSchema.safeParse(event.details);
    return verdict.success && verdict.data.status === "verified" && run.goal.verifier &&
      verdict.data.adapter_id === run.goal.adapter_id && verdict.data.verifier_id === run.goal.verifier.id &&
      verdict.data.verifier_version === run.goal.verifier.version ? { kind: "goal_verified" } : null;
  }
  const schema = evidenceRecord(details?.schema);
  if (event.type !== "adapter.evidence" || details?.adapter_id !== run.goal.adapter_id ||
    schema?.id !== "observation_v3" || schema.version !== 3) return null;
  const decoded = minecraftObservationV3Schema.safeParse(details.data);
  const scope = effectScopeSchema.safeParse(details.scope);
  if (!decoded.success || !scope.success) return null;
  const observation = decoded.data;
  if (scope.data.run_id !== run.run_id || scope.data.world_id !== run.world_id || scope.data.session_id !== run.session_id ||
    scope.data.epoch !== run.epoch || scope.data.native_boot_id !== run.native_boot_id ||
    !adoptedPromotionScope(event, run, execution, scope.data, history) ||
    scope.data.run_generation !== execution.run_generation ||
    observation.world_id !== run.world_id || observation.session_id !== run.session_id || observation.epoch !== execution.epoch ||
    observation.native_boot_id !== execution.native_boot_id || observation.compatibility_hash !== run.compatibility_hash ||
    observation.life.life_id !== scope.data.life_id || observation.space.space_epoch !== scope.data.space_epoch ||
    observation.life.status !== "alive") return null;
  const counts: Record<string, number> = Object.create(null);
  for (const item of observation.data.player.inventory) {
    const count = (counts[item.name] ?? 0) + item.count;
    if (!Number.isSafeInteger(count)) return null;
    if (count > 0) counts[item.name] = count;
  }
  return { kind: "inventory_gain", counts };
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  return result;
}
function paragraph(parent: HTMLElement, text: string, className = ""): HTMLParagraphElement {
  const result = node("p", text);
  result.className = className;
  parent.append(result);
  return result;
}
function pre(parent: HTMLElement, value: unknown): void {
  const result = node("pre", typeof value === "string" ? value : JSON.stringify(value, null, 2));
  result.tabIndex = 0;
  parent.append(result);
}
function button(parent: HTMLElement, text: string, action: () => void): HTMLButtonElement {
  const result = node("button", text);
  result.type = "button";
  result.addEventListener("click", action);
  parent.append(result);
  return result;
}
function disclosure(parent: HTMLElement, title: string, value: unknown): HTMLDetailsElement {
  const result = node("details");
  result.append(node("summary", title));
  pre(result, value);
  parent.append(result);
  return result;
}
function field(parent: HTMLElement, title: string, select: HTMLSelectElement): void {
  const label = node("label", title);
  label.append(select);
  parent.append(label);
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Evidence request failed. Refresh to retry.";
}
function lineage(session: string | null, life: number | null): string {
  return `Session ${session ?? "unattributed historical record"} · life ${life === null ? "unattributed historical record" : life}`;
}
interface InspectorActions {
  openDialog(id: string): void;
  measurements(runId: string): ProgramEvidenceView[];
  promote(run: RunView, execution: SkillExecutionView): void;
  trace(run: RunView, executionId: string): void;
}
interface Panel {
  root: HTMLElement;
  game: HTMLElement | null;
  gameSignature: string;
}

/** Owns read-only evidence surfaces; requests happen on explicit inspection, never background polling. */
export class EvidenceInspector {
  private readonly panels = new Map<string, Panel>();
  private readonly executionSelections = new Map<string, string>();
  private readonly runs = new Map<string, RunView>();
  constructor(private readonly actions: InspectorActions) {}

  selectExecution(runId: string, executionId: string): void {
    this.executionSelections.set(runId, executionId);
    this.panels.delete(`trace:${runId}`);
  }

  showSource(program: SkillView | PolicyView, run: RunView): void {
    const set = (id: string, value: string): void => { document.getElementById(id)!.textContent = value; };
    set("source-title", `${program.name} · v${program.version}`);
    set("source-meta", `${"skill_id" in program ? "Skill" : `Reaction / ${program.backend}`} · ${program.state}\n${"skill_id" in program ? program.skill_id : program.policy_id}\nSHA ${program.hash}\n${lineage(run.session_id, run.life_id)}`);
    const card = document.getElementById("strategy-card")!;
    card.replaceChildren();
    for (const [key, value] of Object.entries(program.card)) {
      card.append(node("dt", key.replaceAll("_", " ")), node("dd", value));
    }
    set("source-code", program.source);
    set("source-evidence", JSON.stringify("skill_id" in program ? {
      run_id: run.run_id, world_id: run.world_id, epoch: run.epoch,
      session_id: run.session_id, life_id: run.life_id,
      parent_version: program.parent_version, dependencies: program.dependencies,
      compactness: program.validation, created_at: program.created_at,
      measured_effectiveness: this.actions.measurements(run.run_id).filter(item => item.skill_id === program.skill_id && item.version === program.version),
      executions: run.executions.filter(item => item.skill_id === program.skill_id && item.version === program.version),
      qualification: "No samples does not mean effective. Newer code is not proven better.",
    } : {
      run_id: run.run_id, backend: program.backend, choices: program.choices,
      priority: program.priority, interval_ms: program.interval_ms,
      evaluations: program.evaluations, effects: program.effects, last_error: program.last_error,
    }, null, 2));
    this.actions.openDialog("source-dialog");
  }

  executionDetails(parent: HTMLElement, execution: SkillExecutionView, run: RunView): void {
    const details = node("details");
    const summary = node("summary", `${execution.skill_id} · v${execution.version} · ${execution.status} · ${execution.actions} actions / ${execution.calls} calls`);
    details.dataset.record = `execution:${execution.execution_id}`;
    summary.dataset.key = details.dataset.record;
    details.append(summary);
    paragraph(details, execution.result?.summary ?? execution.error ?? "No terminal result recorded.");
    paragraph(details, lineage(execution.session_id, execution.life_id), "mono");
    const measured = this.actions.measurements(run.run_id).find(item => item.execution_id === execution.execution_id);
    if (measured) {
      paragraph(details, `Evidence: ${measured.evidence_status.replaceAll("_", " ")} · ${measured.confirmed_effects} confirmed effects · ${measured.strategic_requests} strategic requests within interval · ${measured.duration_ms === null ? "unknown duration" : `${measured.duration_ms} ms`}.`);
      paragraph(details, `Code compactness (not effectiveness): ${measured.compactness.formatted_lines} canonical lines · complexity ${measured.compactness.complexity} · nesting ${measured.compactness.nesting}.`, "muted");
      pre(details, measured);
    } else paragraph(details, "Measured effectiveness is unavailable or not yet recorded. Execution status is not objective verification.", "muted");
    pre(details, execution);
    button(details, "Inspect attributed trace / conditions", () => this.actions.trace(run, execution.execution_id));
    if (execution.parent_execution_id === null && ["succeeded", "cancelled"].includes(execution.status)) {
      button(details, "Save with verified evidence", () => this.actions.promote(run, execution));
    }
    parent.append(details);
  }

  render(tab: string, parent: HTMLElement, run: RunView | null, game: GameState | null): boolean {
    if (!["trace", "comparison", "learning", "life", "planning"].includes(tab)) return false;
    if (run) this.runs.set(run.run_id, run);
    const key = `${tab}:${run?.run_id ?? "no-run"}`;
    let panel = this.panels.get(key);
    if (!panel) {
      panel = { root: node("section"), game: null, gameSignature: "" };
      panel.root.className = "evidence-inspector";
      this.panels.set(key, panel);
      if (run) paragraph(panel.root, run.task, "evidence-task");
      if (tab === "life") {
        panel.game = node("div");
        panel.root.append(panel.game);
      }
      if (!run) paragraph(panel.root, tab === "life" ? "No run selected. Death episodes are retained with the run that observed them." : "Select a retained run or create a task to inspect recorded evidence.");
      else if (tab === "trace") this.tracePanel(panel.root, run);
      else if (tab === "comparison") this.comparisonPanel(panel.root, run);
      else if (tab === "learning") this.learningPanel(panel.root, run);
      else if (tab === "planning") this.planningPanel(panel.root, run);
      else this.deathPanel(panel.root, run);
    }
    const gameSignature = JSON.stringify(game ? {
      status: game.status, session_id: game.session_id, epoch: game.epoch,
      life: game.life, binding: game.binding, space: game.space, screen: game.screen, error: game.error,
      run_status: run?.status ?? null,
    } : null);
    if (panel.game && panel.gameSignature !== gameSignature) {
      panel.gameSignature = gameSignature;
      panel.game.replaceChildren();
      paragraph(panel.game, game ? `${game.status} · ${lineage(game.session_id, game.life?.life_id ?? null)} · profile ${game.binding?.descriptor.observation.profile.id ?? "not negotiated"} · space ${game.space?.space_epoch ?? "unavailable"}` : "Retained run: live player state is not attributed to this historical run.", "mono");
      if (game) {
        const life = game.life;
        const deathControl = ["bootstrapping", "running"].includes(run?.status ?? "")
          ? "The running model chooses whether to request respawn."
          : run?.status === "paused"
            ? "Control is paused; the model cannot request respawn until the run resumes."
            : run?.status === "created"
              ? "The task has not started. Start the run so the model can choose recovery."
              : run?.status === "reviewing"
                ? "The run is in effect-free review; it cannot request respawn."
                : ["pausing", "stopping"].includes(run?.status ?? "")
                  ? "Agent control is closing; no respawn request is admitted."
                  : "No active run. Configure a task and strategic model in Settings, then Start so the model can choose recovery.";
        paragraph(panel.game, game.error ? `Connection fault: ${game.error}` : life?.status === "dead"
          ? `Player dead. ${life.can_respawn ? `Vanilla death screen is ready. ${deathControl}` : "Waiting for native death-screen readiness."} Respawn is model-only; this view does not send gameplay input.`
          : life?.status === "respawning" ? "Model-selected respawn is awaiting authoritative new-life confirmation. Ordinary effects remain fenced."
          : life?.status === "loading" ? "Native player loading. Ordinary effects wait for readiness."
          : life?.status === "alive" ? "Player alive. Run controls do not close the game session." : "No authoritative player life available.");
        disclosure(panel.game, "Authoritative session / life state", { session_id: game.session_id, epoch: game.epoch, life, error: game.error });
      }
    }
    if (parent.firstElementChild !== panel.root) parent.replaceChildren(panel.root);
    return true;
  }

  private tracePanel(parent: HTMLElement, run: RunView): void {
    paragraph(parent, "Actual instrumented conditions, API requests/results, authorized observations and measured spans — not hidden reasoning. Progress records are model-authored intent, not success proof. Exact original code remains immutable.");
    paragraph(parent, "Span durations use same-process monotonic clocks where recorded. Overlapping categories are not additive; cross-process clocks do not establish latency. Missing spans remain unmeasured.", "muted");
    const controls = node("div");
    controls.className = "evidence-controls";
    const execution = node("select");
    execution.append(new Option("All executions and runtime spans", ""));
    for (const value of run.executions) execution.append(new Option(`${value.skill_id} v${value.version} · ${value.execution_id}`, value.execution_id));
    execution.value = this.executionSelections.get(run.run_id) ?? "";
    execution.addEventListener("focus", () => {
      const value = execution.value;
      execution.replaceChildren(new Option("All executions and runtime spans", ""));
      for (const item of (this.runs.get(run.run_id) ?? run).executions)
        execution.append(new Option(`${item.skill_id} v${item.version} · ${item.execution_id}`, item.execution_id));
      execution.value = value;
    });
    field(controls, "Execution / root (includes descendants)", execution);
    const kind = node("select");
    for (const [value, name] of [["all", "All recorded kinds"], ["branch", "Instrumented conditions"], ["span", "Attributed timing / pauses"], ["observation", "Authorized observations"], ["intent", "Model-authored progress intent"], ["capability_request", "API requests"], ["capability_result", "API results"]]) kind.append(new Option(name, value));
    field(controls, "Filter loaded page", kind);
    parent.append(controls);
    const status = paragraph(parent, "Loading first bounded trace page…");
    status.setAttribute("role", "status");
    const content = node("div");
    parent.append(content);
    const paging = node("div");
    paging.className = "button-row";
    parent.append(paging);
    let after = 0, nextAfter = 0, busy = false, page: TracePage | null = null;
    const cursors: number[] = [];
    const sourcePoints = new Map<string, Map<number, { start: number; end: number; line: number; column: number }>>();
    const draw = (): void => {
      content.replaceChildren();
      if (!page) return;
      const budget = page.budget;
      status.textContent = `${page.records.length} records in this page · ledger ${budget.recorded}/${budget.max_records} records, ${budget.bytes}/${budget.max_bytes} bytes · omitted ${budget.omitted_records} records / ${budget.omitted_bytes} bytes. Response pages are bounded to 64 KiB. Cursor ${after} → ${page.next_after}.`;
      const records = page.records.filter(record => kind.value === "all" || record.kind === kind.value);
      for (const record of page.records) {
        const payload = record.payload && typeof record.payload === "object" && !Array.isArray(record.payload) ? record.payload : null;
        if (record.kind !== "branch" || !payload || typeof payload.source_hash !== "string" || !Array.isArray(payload.points)) continue;
        const points = new Map<number, { start: number; end: number; line: number; column: number }>();
        for (const value of payload.points) {
          if (!value || typeof value !== "object" || Array.isArray(value)) continue;
          if (typeof value.point_id === "number" && Number.isSafeInteger(value.point_id) &&
            typeof value.start === "number" && Number.isSafeInteger(value.start) &&
            typeof value.end === "number" && Number.isSafeInteger(value.end) &&
            typeof value.line === "number" && typeof value.column === "number")
            points.set(value.point_id, { start: value.start, end: value.end, line: value.line, column: value.column });
        }
        sourcePoints.set(payload.source_hash, points);
      }
      if (!records.length) paragraph(content, page.records.length ? "No matching records in this page. Continue paging or change the loaded-page filter." : "No trace records retained after this cursor. Historical runs may predate instrumentation.");
      for (const record of records) {
        const payload = record.payload && typeof record.payload === "object" && !Array.isArray(record.payload) ? record.payload : null;
        const timing = record.kind === "span" && payload
          ? ` · ${typeof payload.category === "string" ? payload.category.replaceAll("_", " ") : "unattributed category"} · ${typeof payload.duration_ms === "number" ? `${payload.duration_ms.toFixed(2)} ms` : "unknown duration"}`
          : "";
        const title = `#${record.trace_seq} · ${record.kind === "intent" ? "model-authored intent" : record.kind}${timing} · ${record.capability ?? record.execution_id ?? "runtime"} · ${record.at}`;
        const details = record.kind === "branch" ? node("details") : disclosure(content, title, record);
        if (record.kind === "branch") {
          details.append(node("summary", title));
          content.append(details);
        }
        const attribution = `${lineage(record.session_id, record.life_id)} · source ${record.skill_id ?? "not attributed"} v${record.version ?? "unknown"} · SHA ${record.hash ?? "unknown"}`;
        if (record.kind !== "branch") paragraph(details, attribution, "mono");
        if (record.omission) paragraph(details, `Payload omitted: ${record.omission.reason}, original ${record.omission.original_bytes} bytes. This is not a complete observation or condition record.`, "error");
        const currentRun = this.runs.get(run.run_id) ?? run;
        const skill = currentRun.skills.find(value => value.skill_id === record.skill_id && value.version === record.version && value.hash === record.hash);
        if (skill) button(details, "Read exact source / full conditions", () => this.showSource(skill, currentRun));
        if (record.kind === "branch" && payload && Array.isArray(payload.events)) {
          const points = typeof payload.source_hash === "string" ? sourcePoints.get(payload.source_hash) : undefined;
          for (const event of payload.events) {
            if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.point_id !== "number" || typeof event.decision !== "boolean") continue;
            const point = points?.get(event.point_id);
            if (skill && point && payload.source_hash === skill.hash && point.start >= 0 && point.end >= point.start && point.end <= skill.source.length) {
              const condition = disclosure(details, `Condition #${event.point_id} · decision ${event.decision} · line ${point.line}:${point.column}`, skill.source.slice(point.start, point.end));
              condition.open = true;
              paragraph(condition, "Actual evaluated condition diagnostic. Not hidden reasoning, and not objective success proof.", "muted");
            } else paragraph(details, `Condition #${event.point_id} · actual decision ${event.decision}. Source-point metadata is not in the loaded pages; read the exact original source.`, "mono");
          }
          if (typeof payload.omitted === "number" && payload.omitted > 0) paragraph(details, `${payload.omitted} branch diagnostics explicitly omitted by the instrumentation budget.`, "muted");
        }
        if (record.kind === "branch") {
          paragraph(details, attribution, "mono");
          disclosure(details, "Raw record", record);
        }
      }
    };
    const load = async (cursor: number): Promise<void> => {
      if (busy) return;
      busy = true;
      previous.disabled = next.disabled = refresh.disabled = execution.disabled = true;
      status.textContent = "Loading bounded trace page…";
      try { page = await fetchTrace(run.run_id, cursor, execution.value); after = cursor; nextAfter = page.next_after; draw(); }
      catch (error) { status.textContent = `Trace unavailable: ${errorMessage(error)} Displayed records, if any, are retained.`; }
      finally { busy = false; previous.disabled = !cursors.length; next.disabled = !page?.has_more; refresh.disabled = execution.disabled = false; }
    };
    const previous = button(paging, "Previous page", () => { const cursor = cursors.pop(); if (cursor !== undefined) void load(cursor); });
    const next = button(paging, "Next trace page", () => { cursors.push(after); void load(nextAfter); });
    const refresh = button(paging, "Refresh this page", () => void load(after));
    previous.disabled = next.disabled = true;
    execution.addEventListener("change", () => { cursors.length = 0; page = null; content.replaceChildren(); void load(0); });
    kind.addEventListener("change", draw);
    void load(0);
  }

  private metric(parent: HTMLElement, metric: ObjectiveMetrics): void {
    const details = disclosure(parent, `${metric.execution_id} · ${metric.outcome} · ${metric.observation_samples} observation samples / ${metric.motion_receipts} motion receipts`, metric);
    paragraph(details, `${metric.confirmed_block_removals} confirmed block removals · ${metric.inventory_receipts} inventory receipts · ${metric.target_switches} target-ID switches / ${metric.target_position_switches} position switches. Extra blocks and switches are not labelled mistakes without evidence.`);
    paragraph(details, `Sampled travel ${metric.sampled_travel_distance.toFixed(2)} blocks / rotation ${metric.sampled_rotation_degrees.toFixed(2)}°; receipted travel ${metric.receipted_travel_distance.toFixed(2)} blocks / rotation ${metric.receipted_rotation_degrees.toFixed(2)}°. Sampling does not prove a complete path.`, "mono");
    paragraph(details, `Trace ${metric.trace_complete ? "within retained budget" : "incomplete"}. ${metric.limitations.join(" ")}`, "muted");
  }

  private learningPanel(parent: HTMLElement, run: RunView): void {
    paragraph(parent, "Durable failure, death and outcome opportunities. Decisions and revision reasons below are authored by the model. A measured candidate is not automatically better; an unmeasured candidate has no demonstrated improvement.");
    const status = paragraph(parent, "Loading bounded improvement feedback…");
    const content = node("div"); parent.append(content);
    const controls = node("div"); controls.className = "button-row"; parent.append(controls);
    let after: ImprovementFeedbackCursor = { opportunity_seq: 0, execution_seq: 0 };
    let nextAfter = after, busy = false;
    const cursors: ImprovementFeedbackCursor[] = [];
    const load = async (cursor: ImprovementFeedbackCursor): Promise<void> => {
      if (busy) return; busy = true;
      previous.disabled = next.disabled = refresh.disabled = true;
      try {
        const data = await fetchImprovementFeedback(run.run_id, cursor);
        after = cursor; nextAfter = data.next_after;
        content.replaceChildren();
        status.textContent = `${data.opportunities.length} opportunities / ${data.metrics.length} metric records in this page. ${data.review.effect_free ? "Post-goal review is effect-free" : ""}; at most ${data.review.max_decisions} decisions. Opportunity limit ${data.opportunity_budget.max_records}${data.opportunity_budget.reached ? " reached. " + data.opportunity_budget.omission : "."}`;
        if (!data.opportunities.length && !data.metrics.length) paragraph(content, "No improvement or objective metric records in this page.");
        if (data.omitted.length) disclosure(content, "Explicit page omissions", data.omitted);
        for (const opportunity of data.opportunities) {
          const resolution = opportunity.resolution;
          const details = disclosure(content, `${opportunity.kind} · ${opportunity.version.skill_id} v${opportunity.version.version} · ${resolution?.decision.replaceAll("_", " ") ?? "awaiting model decision"}`, opportunity);
          paragraph(details, resolution ? `${resolution.reason} · ${resolution.measured ? "Measured, not causally proven" : "Unmeasured / insufficient trials"}` : "No model decision recorded. The UI does not revise or approve source.");
          button(details, "Inspect linked execution trace", () => this.actions.trace(run, opportunity.execution_id));
        }
        for (const metric of data.metrics) this.metric(content, metric);
        next.disabled = !data.has_more;
      } catch (error) { status.textContent = `Improvement evidence unavailable: ${errorMessage(error)}`; }
      finally { busy = false; previous.disabled = !cursors.length; refresh.disabled = false; }
    };
    const previous = button(controls, "Previous page", () => { const cursor = cursors.pop(); if (cursor !== undefined) void load(cursor); });
    const next = button(controls, "Next feedback page", () => { cursors.push(after); void load(nextAfter); });
    const refresh = button(controls, "Refresh feedback", () => void load(after));
    void load({ opportunity_seq: 0, execution_seq: 0 });
  }

  private deathPanel(parent: HTMLElement, run: RunView): void {
    paragraph(parent, "Last authorized context is evidence, not an inferred cause of death. Missing death episodes remain missing, including a client first observed already dead. Respawn requests/results and life-recovery spans are inspectable in the trace and Activity.");
    const status = paragraph(parent, "Loading retained death episodes…");
    const content = node("div"); parent.append(content);
    const controls = node("div"); controls.className = "button-row"; parent.append(controls);
    let after = 0, nextAfter = 0, busy = false;
    const cursors: number[] = [];
    const load = async (cursor: number): Promise<void> => {
      if (busy) return; busy = true; previous.disabled = next.disabled = refresh.disabled = true;
      try {
        const data = await fetchDeaths(run.run_id, cursor);
        after = cursor; nextAfter = data.next_after; content.replaceChildren();
        status.textContent = data.episodes.length ? `${data.episodes.length} retained episodes in this bounded page.` : "No observed death episode retained in this page. No cause or identity is invented.";
        for (const episode of data.episodes) {
          const details = disclosure(content, `${episode.death_id} · life ${episode.life_id}`, episode);
          if (episode.current_root_execution_id) button(details, "Inspect interrupted root trace", () => this.actions.trace(run, episode.current_root_execution_id!));
        }
        next.disabled = !data.has_more;
      } catch (error) { status.textContent = `Death evidence unavailable: ${errorMessage(error)}`; }
      finally { busy = false; previous.disabled = !cursors.length; refresh.disabled = false; }
    };
    const previous = button(controls, "Previous page", () => { const cursor = cursors.pop(); if (cursor !== undefined) void load(cursor); });
    const next = button(controls, "Next death page", () => { cursors.push(after); void load(nextAfter); });
    const refresh = button(controls, "Refresh death context", () => void load(after));
    button(controls, "Inspect timing / recovery trace", () => this.actions.trace(run, ""));
    void load(0);
  }

  private planningPanel(parent: HTMLElement, run: RunView): void {
    paragraph(parent, "Model-selected bounded lookahead is separate from executing work. A staged candidate is not admitted until fresh-state validation succeeds. This view cannot activate plans.");
    const status = paragraph(parent, "Loading recorded planning state…");
    const content = node("div"); parent.append(content);
    let busy = false;
    const load = async (): Promise<void> => {
      if (busy) return; busy = true; refresh.disabled = true;
      try {
        const plan = await fetchPlanning(run.run_id); content.replaceChildren();
        status.textContent = plan ? `${plan.state}${plan.reason ? " · " + plan.reason.replaceAll("_", " ") : ""}` : "No speculative plan recorded for this run. Planning is opt-in, not simulated.";
        if (plan) {
          paragraph(content, `Model-authored intent: ${plan.intent}`);
          paragraph(content, `${plan.calls}/${plan.budget.calls} calls · ${plan.tools}/${plan.budget.tools} tools · deadline ${plan.deadline_at} · measured overlap ${plan.overlap_ms.toFixed(1)} ms (not causal speedup).`, "mono");
          paragraph(content, `${lineage(plan.basis.session_id, plan.basis.life_id)} · predecessor ${plan.basis.root.execution_id} · ${plan.basis.root.status}`, "mono");
          disclosure(content, "Exact basis, source, validation and admission projection", plan);
        }
      } catch (error) { status.textContent = `Planning projection unavailable: ${errorMessage(error)}`; }
      finally { busy = false; refresh.disabled = false; }
    };
    const refresh = button(parent, "Refresh planning projection", () => void load());
    void load();
  }

  private comparisonPanel(parent: HTMLElement, selected: RunView): void {
    paragraph(parent, "Compare exact immutable versions and StrategyCards alongside objective samples. Differences are descriptive, not evidence that the revision caused improvement. Missing measurements remain unknown.");
    const status = paragraph(parent, "Loading retained version choices…");
    const form = node("form"); form.className = "comparison-form";
    const selectors = node("div"); selectors.className = "form-row";
    const left = node("div"), right = node("div"); selectors.append(left, right); form.append(selectors);
    const beforeRun = node("select"), afterRun = node("select"), beforeSkill = node("select"), afterSkill = node("select");
    field(left, "Before run", beforeRun); field(left, "Exact before version / hash", beforeSkill);
    field(right, "After run", afterRun); field(right, "Exact after version / hash", afterSkill);
    const inspectBefore = button(left, "Read before source / card", () => inspect(beforeRun, beforeSkill));
    const inspectAfter = button(right, "Read after source / card", () => inspect(afterRun, afterSkill));
    const compare = node("button", "Compare exact versions"); compare.type = "submit"; compare.disabled = true; form.append(compare);
    parent.append(form);
    const content = node("div"); parent.append(content);
    const paging = node("div"); paging.className = "button-row"; parent.append(paging);
    let runs: RunView[] = [], after = 0, nextAfter = 0, busy = false;
    let active: { before: ProgramVersionEvidence; after: ProgramVersionEvidence } | null = null;
    const cursors: number[] = [];
    const source = (runSelect: HTMLSelectElement, skillSelect: HTMLSelectElement): { run: RunView; skill: SkillView } | null => {
      const run = runs.find(value => value.run_id === runSelect.value);
      const skill = run?.skills.find(value => `${value.skill_id}:${value.version}:${value.hash}` === skillSelect.value);
      return run && skill ? { run, skill } : null;
    };
    const inspect = (runSelect: HTMLSelectElement, skillSelect: HTMLSelectElement): void => {
      const value = source(runSelect, skillSelect); if (value) this.showSource(value.skill, value.run);
    };
    const enabled = (): void => {
      const a = source(beforeRun, beforeSkill), b = source(afterRun, afterSkill);
      inspectBefore.disabled = !a; inspectAfter.disabled = !b;
      compare.disabled = busy || !a || !b || a.run.model_id !== b.run.model_id;
    };
    const skills = (runSelect: HTMLSelectElement, skillSelect: HTMLSelectElement): void => {
      const run = runs.find(value => value.run_id === runSelect.value);
      skillSelect.replaceChildren(...(run?.skills ?? []).map(value => new Option(`${value.name} · ${value.skill_id} v${value.version} · ${value.hash}`, `${value.skill_id}:${value.version}:${value.hash}`)));
      if (!run?.skills.length) skillSelect.append(new Option("No retained skill versions", ""));
      enabled();
    };
    const load = async (cursor: number): Promise<void> => {
      if (!active || busy) return; busy = true; enabled(); previous.disabled = next.disabled = true;
      status.textContent = "Loading bounded exact-version comparison…";
      try {
        const data = await fetchComparison(active.before, active.after, cursor);
        const value = data.comparison; after = cursor; nextAfter = data.next_after; content.replaceChildren();
        status.textContent = `Recorded samples: before ${value.sample_count.before} / after ${value.sample_count.after}. Page includes ${value.samples.before.length} / ${value.samples.after.length}. Descriptive only — no causal improvement claim.`;
        disclosure(content, "Exact references and controlled conditions (null means not established)", { before: value.before, after: value.after, controlled_conditions: value.controlled_conditions });
        if (data.omissions.length) disclosure(content, "Explicit comparison omissions — read exact source / cards above", data.omissions);
        content.append(node("h3", "Source changes"));
        paragraph(content, `${value.source_diff.common_prefix_lines} unchanged leading lines / ${value.source_diff.common_suffix_lines} unchanged trailing lines. Read exact originals above for complete source.`);
        disclosure(content, "Removed source (inert text)", value.source_diff.removed.join("\n"));
        disclosure(content, "Added source (inert text)", value.source_diff.added.join("\n"));
        disclosure(content, "StrategyCard changes", value.card_diff);
        content.append(node("h3", "Before measurements"));
        if (!value.samples.before.length) paragraph(content, value.sample_count.before ? "No before samples in this page." : "No measured before executions. Unknown effectiveness.");
        for (const metric of value.samples.before) this.metric(content, metric);
        content.append(node("h3", "After measurements"));
        if (!value.samples.after.length) paragraph(content, value.sample_count.after ? "No after samples in this page." : "No measured after executions. This version is an unmeasured candidate.");
        for (const metric of value.samples.after) this.metric(content, metric);
        next.disabled = !data.has_more;
      } catch (error) { status.textContent = `Comparison unavailable: ${errorMessage(error)}`; }
      finally { busy = false; enabled(); previous.disabled = !cursors.length; }
    };
    const previous = button(paging, "Previous sample page", () => { const cursor = cursors.pop(); if (cursor !== undefined) void load(cursor); });
    const next = button(paging, "Next sample page", () => { cursors.push(after); void load(nextAfter); });
    previous.disabled = next.disabled = true;
    form.addEventListener("submit", event => {
      event.preventDefault();
      const a = source(beforeRun, beforeSkill), b = source(afterRun, afterSkill);
      if (!a || !b || compare.disabled) return;
      active = {
        before: { run_id: a.run.run_id, skill_id: a.skill.skill_id, version: a.skill.version, hash: a.skill.hash },
        after: { run_id: b.run.run_id, skill_id: b.skill.skill_id, version: b.skill.version, hash: b.skill.hash },
      };
      cursors.length = 0; void load(0);
    });
    beforeRun.addEventListener("change", () => skills(beforeRun, beforeSkill));
    afterRun.addEventListener("change", () => skills(afterRun, afterSkill));
    beforeSkill.addEventListener("change", enabled); afterSkill.addEventListener("change", enabled);
    const loadChoices = async (): Promise<void> => {
      choices.disabled = true;
      try {
        const history = await fetchHistory();
        const current = history.find(value => value.run_id === selected.run_id) ?? this.runs.get(selected.run_id) ?? selected;
        runs = [current, ...history.filter(value => value.run_id !== selected.run_id)];
        for (const select of [beforeRun, afterRun]) {
          select.replaceChildren(...runs.map(value => new Option(`${value.model_id} · ${value.task.slice(0, 80)} · ${value.run_id}`, value.run_id)));
          select.value = selected.run_id;
        }
        skills(beforeRun, beforeSkill); skills(afterRun, afterSkill);
        const versions = current.skills;
        if (versions.length > 1) {
          const last = versions.at(-1)!;
          const prior = versions.find(value => value.skill_id === last.skill_id && value.version === last.parent_version);
          afterSkill.value = `${last.skill_id}:${last.version}:${last.hash}`;
          if (prior) beforeSkill.value = `${prior.skill_id}:${prior.version}:${prior.hash}`;
        }
        enabled(); status.textContent = "Select exact same-model versions, then compare their recorded evidence.";
      } catch (error) { status.textContent = `Version choices unavailable: ${errorMessage(error)}`; }
      finally { choices.disabled = false; }
    };
    const choices = button(parent, "Refresh retained version choices", () => void loadChoices());
    void loadChoices();
  }
}
