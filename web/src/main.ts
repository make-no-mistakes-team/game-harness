import "@fontsource/jura/latin-500.css";
import "@fontsource/jura/latin-700.css";
import "@fontsource/jura/cyrillic-500.css";
import "@fontsource/jura/cyrillic-700.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "@fontsource/ibm-plex-mono/cyrillic-400.css";
import "@fontsource/ibm-plex-mono/cyrillic-500.css";
import "./styles.css";
import { minecraftProfileConfigurationSchema } from "../../src/shared/minecraft.ts";
import type {
  ActivityEvent,
  AppSnapshot,
  ProgramEvidenceView,
  RunView,
  TokenUsage,
} from "../../src/shared/contracts.ts";
import type {
  SkillExecutionView,
} from "../../src/shared/programs.ts";
import type {
  ExperienceView,
  PromotionDeclaration,
} from "../../src/server/experience.ts";
import {
  ApiError,
  cancelPreparation,
  createRun,
  eventSchema,
  fetchExperience,
  fetchHistory,
  fetchJev,
  fetchPerformance,
  fetchRunEvents,
  fetchSkillEvidence,
  fetchState,
  mutate,
  openSession,
  prepareAndPlay,
  promoteExperience,
  removeJevKey,
  setJevKey,
} from "./api.ts";
import type { PerformanceSnapshot, SkillEvidencePage } from "./api.ts";
import { NativeVideo } from "./video.ts";
import { SurvivalAgentView } from "./survival-agent-view.ts";
import { TERRA_MODEL_ID } from "../../src/shared/survival-agent-ui.ts";
import { EvidenceInspector, promotionEvidence } from "./evidence.ts";
import { MAX_TASK_CHARACTERS, taskTextSchema } from "../../src/shared/tasks.ts";
import { initialTaskDraft, editTaskPrompt, selectTaskChoice, taskSubmission } from "./task-draft.ts";
import {
  currentTaskText, stopControl, operatorLabel, canRefreshModels, commandAvailable, currentUsage,
  preparationPrerequisite, preparationLabel, preparationCancellation, preparationTiming, detachedPreparation,
} from "./operator-state.ts";
import { PREPARED_START_LIMITS, preparedStartActive, preparedStartRequestSchema, type PreparedStartRequest } from "../../src/shared/prepared-start.ts";

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("Application mount is missing.");
root.innerHTML = `
<a class="skip-link" href="#run-controls">Skip to run controls</a>
<main class="workspace">
  <header class="workspace-header"><h1>GameHarness</h1><span id="connection" role="status">Connecting to local service…</span><nav aria-label="Workspace"><button id="reconnect" type="button">Reconnect</button><button id="history-open" type="button">History</button><button id="settings-open" type="button">Settings</button><button id="sidebar-toggle" type="button" aria-expanded="true" aria-controls="context-panel">Hide panel</button></nav></header>
  <div id="request-error" class="notice error" role="alert" hidden></div>
  <div class="work-area" id="work-area">
    <section class="game-console" aria-label="Authentic Minecraft player video">
      <div class="console-topline"><h2>Minecraft <span class="muted">/ player view</span></h2><span id="view-status" class="model-only" role="status">Waiting</span><span class="survival-agent-only" id="survival-agent-video-status" role="status"></span></div>
      <div class="viewer" id="viewer" data-state="idle"><canvas id="game-video" class="model-only" aria-label="Read-only authentic Minecraft video, including the game HUD and player hand" hidden></canvas><div class="viewer-empty model-only" id="viewer-empty"><h3 id="viewer-title">No live video</h3><p id="viewer-description">Connect the isolated Minecraft client in Settings. No simulated footage is displayed.</p><button id="viewer-settings" type="button">Open settings</button></div><p class="frame-warning model-only" id="frame-warning" hidden></p>
        <img class="survival-agent-only" id="survival-agent-video" width="960" height="540" alt="Read-only gameplay from Minecraft Survival Agent" draggable="false" hidden>
        <div class="viewer-empty survival-agent-only" id="survival-agent-empty"><h3 id="survival-agent-video-message"></h3></div>
      </div>
      <div class="viewer-foot"><span id="video-detail" class="model-only">Waiting for the local service.</span><button id="video-reconnect" class="model-only" type="button">Reconnect video</button><span class="survival-agent-only" id="survival-agent-video-detail"></span><button id="survival-agent-video-retry" class="survival-agent-only" type="button" hidden>Reconnect video</button></div>
    </section>
    <aside class="context-panel" id="context-panel" aria-label="Current goal and program">
      <div class="context-overview model-only">
      <section><h2><button id="life-open" class="section-action" type="button"><span>Session / player life</span><span id="life-current" class="context-value">No game session.</span></button></h2></section>
      <section><h2>Current goal</h2><p id="current-task">No run created.</p><button id="goal-more" type="button" hidden>Read full task</button></section>
      <section><h2><button id="programs-open" class="section-action" type="button" title="Inspect programs, model and action"><span>Program / control</span><span id="program-current" class="context-value">No executing skill.</span><span id="program-status" class="context-value" hidden></span></button></h2></section>
      <section><h2><button id="activity-open" class="section-action" type="button" title="Inspect activity"><span id="activity-heading">Latest activity</span><span id="latest-activity" class="context-value">No recorded activity yet.</span></button></h2></section>
      </div>
      <section class="usage-summary model-only"><h2><button id="usage-open" class="section-action" type="button" aria-label="Usage details" title="Usage details">Actual usage</button></h2><dl id="usage-summary"></dl></section>
      <p id="run-error" class="error model-only" role="alert" hidden></p>
      <div class="context-overview survival-agent-only">
        <section><h2 id="survival-agent-goal-heading">Current goal</h2><p id="survival-agent-task"></p></section>
        <section id="survival-agent-activity"><h2 id="survival-agent-action-heading">Agent activity</h2><p id="survival-agent-action"></p></section>
        <section><h2>Player</h2><p id="survival-agent-player"></p></section>
      </div>
      <section class="usage-summary survival-agent-only"><h2>Strategy</h2><p id="survival-agent-model"></p><p id="survival-agent-strategy-outcome" hidden></p></section>
    </aside>
  </div>
  <section class="run-toolbar" id="run-controls" aria-label="Run controls" tabindex="-1"><div class="run-control-state model-only"><strong id="run-status" role="status">No run</strong><span id="run-hint">Configure a task in Settings.</span></div><div class="button-row model-only"><button id="new-task" type="button">Task / model</button><button id="cancel-preparation" class="danger" type="button" hidden>Cancel preparation</button><button id="start-run" class="primary" type="button">Start</button><button id="pause-run" type="button">Pause</button><button id="resume-run" class="primary" type="button" hidden>Resume</button><button id="stop-run" class="danger" type="button">Stop run</button></div>
    <div class="run-control-state survival-agent-only"><strong id="survival-agent-phase" role="status"></strong><span id="survival-agent-hint"></span><span id="survival-agent-control-error" class="error" role="alert" hidden></span></div>
    <div class="button-row survival-agent-only"><button id="survival-agent-check" type="button" hidden>Check status</button><button id="survival-agent-return" type="button" hidden>Model controls</button><button id="survival-agent-choose" class="primary" type="button" hidden>Choose goal</button><button id="survival-agent-stop" class="danger" type="button">Stop agent</button></div>
  </section>
  <footer><span id="readiness" class="model-only">World · unknown / Model · unknown / Isolation · unknown</span><button id="inventory-open" class="text-button model-only" type="button">Inventory</button><span class="muted">Read-only video · no manual gameplay</span></footer>
</main>
<dialog id="settings-dialog" aria-labelledby="settings-title"><div class="dialog-header"><h2 id="settings-title">Settings & task</h2><button type="button" data-close="settings-dialog" aria-label="Close settings">Close</button></div><div class="dialog-body settings-grid">
  <section aria-labelledby="survival-agent-heading"><h3 id="survival-agent-heading" tabindex="-1">Minecraft Survival Agent</h3><form id="survival-agent-form">
    <label for="survival-agent-strategy">Agent strategy</label><div class="input-row"><select id="survival-agent-strategy" required><option value="deterministic" selected>Deterministic (no model)</option><option value="terra">Terra (${TERRA_MODEL_ID})</option></select></div>
    <p id="survival-agent-strategy-disclosure" class="muted" hidden>Terra requires a connected OpenAI account with access to ${TERRA_MODEL_ID}. While Minecraft loads, Terra may send the task text to OpenAI in one request, even if the game never starts. Later requests may send live game frames. All requests count toward your account usage.</p>
    <label for="survival-agent-goal">Agent goal</label><div class="input-row"><select id="survival-agent-goal" required></select><button id="survival-agent-start" type="submit" class="primary" disabled>Start in new world</button></div><p id="survival-agent-start-status" role="status" hidden></p><p id="survival-agent-start-error" class="error" role="alert" hidden></p><button id="survival-agent-start-check" type="button" hidden>Check status</button></form></section>
  <section><h3>Game integration</h3><p>GameHarness runs model-authored game programs. Minecraft Java 1.21.4 is the first available integration; other game adapters are not available in this build.</p></section>
  <section class="settings-task"><h3>Task and strategic model</h3><form id="task-form"><div class="form-row"><label>Automatic success check<select id="goal" required aria-describedby="goal-condition"><option value="">Waiting for checks</option></select></label><label>Strategic model<select id="model" required><option value="">Connect OpenAI first</option></select></label></div><p id="goal-condition" role="status">Custom tasks have no automatic success check.</p><div class="section-heading"><label for="task">Task</label><button id="use-goal" class="text-button" type="button">Restore preset prompt</button></div><textarea id="task" rows="3" minlength="1" maxlength="${MAX_TASK_CHARACTERS}" required placeholder="Describe what the agent should do in this world."></textarea><p id="preparation-disclosure" class="muted">Preparation uses the selected model and counts toward your account usage: up to ${PREPARED_START_LIMITS.max_requests} requests, with a ${PREPARED_START_LIMITS.duration_ms / 60000}-minute preparation limit. It starts with fresh programs; the world opens only after compilation.</p><p id="preparation-prerequisite" role="status"></p><p id="preparation-error" class="error" role="alert" hidden></p><div class="button-row"><button id="prepare-play" type="submit" class="primary" aria-describedby="preparation-disclosure preparation-prerequisite">Prepare &amp; play</button><button id="create-run" type="submit" class="primary" hidden>Create run</button><span id="create-hint" class="muted" hidden>Create saves the task; Start begins inference.</span></div></form><div id="preparation-panel" class="preparation-status" tabindex="-1" aria-labelledby="preparation-status" hidden><p id="preparation-status" role="status"></p><p id="preparation-clock" class="mono"></p><p id="preparation-requests" class="mono"></p><button id="cancel-preparation-settings" class="danger" type="button" hidden>Cancel preparation</button><details><summary>Preparation details</summary><pre id="preparation-details" tabindex="0"></pre></details></div></section>
  <section class="settings-task"><h3>Program libraries</h3><div id="working-library"><label for="working-programs">Working definitions for the next task</label><select id="working-programs"><option value="continue">Continue this session’s same-model working programs</option><option value="fresh">Fresh — omit working programs</option></select><p>Working candidates retain validated code, not arguments, observations or execution state. They are not qualified experience.</p></div><p id="library-mode">Separately, optionally load one exact evidence-backed startup bundle. Neither choice executes code; the new run still receives fresh permissions and validation.</p><label for="experience">Qualified compatible startup bundle</label><select id="experience"><option value="">No saved programs</option></select><p id="library-status" role="status">Choose a strategic model to load compatible bundles.</p><button id="library-refresh" type="button">Refresh compatible library</button><pre id="experience-detail" tabindex="0" hidden></pre></section>
  <section><h3>OpenAI connection</h3><p id="account-description">Connect your own account to discover models.</p><div class="button-row"><button id="login-browser" type="button">Connect in browser</button><button id="login-device" type="button">Use device code</button><button id="refresh-models" type="button" hidden>Refresh models</button><button id="logout" type="button" hidden>Disconnect account</button></div><div id="login-flow" hidden><p id="login-instructions"></p><a id="authorize-link" class="button primary" target="_blank" rel="noopener noreferrer" hidden>Continue in browser</a><p class="muted">Complete authorization in your browser, then return here.</p><form id="auth-form" hidden><label id="auth-input-label" for="auth-input">Authorization response</label><div class="input-row"><input id="auth-input" autocomplete="off" spellcheck="false" maxlength="16000"><button id="auth-submit" type="submit">Submit response</button></div></form><button id="cancel-login" type="button">Cancel authorization</button></div><p id="auth-error" class="error" role="alert" hidden></p></section>
  <section><h3>Isolated Minecraft world</h3><p id="world-description">Waiting for the local server.</p><p class="muted">Uses the authorized official Launcher account for this isolated client only. Personal worlds are not changed.</p><label id="eula-row" class="check-row" hidden><input id="eula" type="checkbox"><span>I accept the <a href="https://www.minecraft.net/eula" target="_blank" rel="noopener noreferrer">Minecraft EULA</a> for this local server.</span></label><div class="button-row"><button id="prepare-game" type="button">Prepare server</button><button id="start-game" type="button">Start world</button><button id="stop-game" type="button">Stop world</button></div><details><summary>New world</summary><p>Replaces this app’s world lineage, not your personal worlds. Recorded runs are retained. Stop the run and world first.</p><label class="check-row"><input id="confirm-world" type="checkbox"><span>Replace this app’s current world.</span></label><button id="new-world" class="danger" type="button">Create new world</button></details><p id="game-error" class="error" role="alert" hidden></p><p id="sandbox-error" class="error" role="alert" hidden></p></section>
  <section><h3>Optional Jev connection</h3><p id="jev-status">Connection status not loaded.</p><p class="muted">JavaScript reactions need no Jev key. The key is sent only to the authenticated local service and is never returned.</p><form id="jev-form"><label for="jev-key">Jev API key</label><div class="input-row"><input id="jev-key" type="password" autocomplete="off" spellcheck="false" maxlength="4096"><button id="jev-save" type="submit">Set key</button></div></form><button id="jev-remove" class="danger" type="button">Remove key</button><p id="jev-error" class="error" role="alert" hidden></p></section>
  <section><h3>Performance diagnostics</h3><p>Inspect measured backend CPU, memory, event-loop lag, observation and command timings, and native video state. Sampling requests run only while the diagnostics dialog is open.</p><button id="performance-open" type="button">Open performance diagnostics</button></section>
  <section><h3>Motor profile</h3><p>Operator configuration applies live and persists independently of the model’s gameplay strategy. It does not move the player.</p><label for="motor-profile">Camera / movement profile</label><select id="motor-profile"><option value="precise">Precise</option><option value="balanced">Balanced</option><option value="fast">Fast</option></select><button id="motor-save" type="button">Apply profile</button><p id="motor-status" role="status">Waiting for current configuration.</p></section>
  <section><h3>Control & licenses</h3><p>Pause and Stop run fence agent work; the world, client and live video continue. Stop world closes the game session. Death and respawn remain model-controlled; video receives no keyboard or mouse gameplay input.</p><p><a href="/licenses/Jura-LICENSE.txt" target="_blank" rel="noopener">Jura license</a> · <a href="/licenses/IBM-Plex-Mono-LICENSE.txt" target="_blank" rel="noopener">IBM Plex Mono license</a></p></section>
</div><p id="settings-error" class="dialog-notice error" role="alert" hidden></p></dialog>
<dialog id="performance-dialog" aria-labelledby="performance-title"><div class="dialog-header"><h2 id="performance-title">Performance diagnostics</h2><button type="button" data-close="performance-dialog" aria-label="Close performance diagnostics">Close</button></div><div class="dialog-body"><p id="performance-status" role="status">Waiting for measured diagnostics.</p><p id="performance-error" class="error" role="alert" hidden></p><dl id="performance-process" class="strategy-card"></dl><h3>Backend timing distributions</h3><p>Reported durations are in milliseconds. Action round trip includes intentional gameplay duration; it is not transport-only latency. Backend video forwarding is separate from the browser’s capture-to-draw measurement.</p><p id="performance-window" class="muted">Distribution window not loaded.</p><div class="table-scroll"><table><thead><tr><th scope="col">Measurement</th><th scope="col">Samples (total)</th><th scope="col">p50</th><th scope="col">p95</th><th scope="col">p99</th><th scope="col">Maximum</th></tr></thead><tbody id="performance-timings"></tbody></table></div><h3>Native video</h3><p id="performance-video">No measured video state loaded.</p><h3>Browser video</h3><p id="performance-browser" class="mono">No browser video measurements yet.</p><p class="muted">Capture-to-draw delay and capture age use this host’s wall clock. These are browser measurements, not native encoding or backend forwarding time.</p><details><summary>Video transport / backpressure</summary><p>Actual relay counters and per-client buffered bytes. Send attempts and queued sends do not prove delivery or drawn frames; these counters are not FPS.</p><pre id="performance-transport" tabindex="0">Not loaded.</pre></details><h3>Native diagnostics</h3><pre id="performance-native" tabindex="0">Not loaded.</pre></div></dialog>
<dialog id="history-dialog" aria-labelledby="history-title"><div class="dialog-header"><h2 id="history-title">Run history</h2><button type="button" data-close="history-dialog" aria-label="Close history">Close</button></div><div class="dialog-body"><p id="history-status" role="status">Loading retained runs…</p><ol id="history-list" class="record-list"></ol><p class="muted">Inspecting a retained run does not resume it or change the current run.</p></div></dialog>
<dialog id="evidence-dialog" aria-labelledby="evidence-title"><div class="dialog-header"><div><h2 id="evidence-title">Run evidence</h2><p id="evidence-run" class="muted"></p></div><button type="button" data-close="evidence-dialog" aria-label="Close evidence">Close</button></div><div class="evidence-tabs" role="tablist" aria-label="Evidence category">${["programs", "executions", "revisions", "trace", "comparison", "learning", "life", "planning", "usage", "activity", "inventory"].map((name, index) => `<button id="${name}-tab" type="button" role="tab" aria-selected="${index === 0}" aria-controls="evidence-content" tabindex="${index === 0 ? 0 : -1}">${name[0]!.toUpperCase() + name.slice(1)}</button>`).join("")}</div><div id="evidence-content" class="dialog-body" role="tabpanel" aria-labelledby="programs-tab" tabindex="0"></div></dialog>
<dialog id="promotion-dialog" aria-labelledby="promotion-title"><div class="dialog-header"><h2 id="promotion-title">Save evidence-backed program</h2><button type="button" data-close="promotion-dialog" aria-label="Close program promotion">Close</button></div><div class="dialog-body"><p id="promotion-execution" class="mono"></p><p>Saving requires trusted evidence attributable to this execution, not its own success claim. Declare whether the exact code retains world-specific data; coordinates are not silently portable.</p><form id="promotion-form"><label for="promotion-name">Library name</label><input id="promotion-name" maxlength="120" required><div class="form-row"><label>Portability<select id="promotion-scope" required><option value="">Choose explicitly</option><option value="world_local">This world only</option><option value="portable">Portable to compatible worlds</option></select></label><label>Does this code retain world-specific data?<select id="promotion-world-data" required><option value="">Choose explicitly</option><option value="yes">Yes — retained world-specific data</option><option value="no">No — no retained world-specific data</option></select></label></div><label for="promotion-evidence">Trusted event in this execution interval</label><select id="promotion-evidence" required><option value="">Load and select actual evidence</option></select><p id="promotion-events-status" role="status"></p><button id="promotion-more" type="button">Load more retained events</button><div id="promotion-inventory" hidden><div class="form-row"><label>Observed item<select id="promotion-item"></select></label><label>Required attributable inventory gain<input id="promotion-gain" type="number" min="1" step="1" value="1"></label></div></div><pre id="promotion-event-detail" tabindex="0" hidden></pre><p id="promotion-scope-hint" class="muted">Choose scope and retained-data declarations before saving.</p><button id="promotion-save" class="primary" type="submit">Verify evidence & save</button></form><p id="promotion-result" role="status"></p><p id="promotion-error" class="error" role="alert" hidden></p></div></dialog>
<dialog id="source-dialog" aria-labelledby="source-title"><div class="dialog-header"><h2 id="source-title">Program source</h2><button type="button" data-close="source-dialog" aria-label="Close source">Close</button></div><div class="dialog-body"><p id="source-meta" class="mono"></p><dl id="strategy-card" class="strategy-card"></dl><h3>Immutable source</h3><p class="muted">Displayed as inert text. This window does not execute source.</p><pre tabindex="0"><code id="source-code"></code></pre><h3>Artifact & linked evidence</h3><pre id="source-evidence" tabindex="0"></pre></div></dialog>`;

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing interface element: ${id}`);
  return node as T;
}
function text(id: string, value: string): void {
  const node = el(id);
  if (node.textContent !== value) node.textContent = value;
}
function hidden(id: string, value: boolean): void {
  el(id).hidden = value;
}
function errorText(id: string, value: string | null): void {
  text(id, value ?? "");
  hidden(id, !value);
}
function label(value: string): string {
  return value.replaceAll("_", " ");
}
function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
function when(value: string | null): string {
  if (!value) return "unknown";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "unknown" : date.toLocaleString();
}
function count(value: number | null): string {
  return value === null ? "Unknown" : value.toLocaleString();
}
function message(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Request failed. Reconnect to inspect current state.";
}
const task = el<HTMLTextAreaElement>("task"),
  goal = el<HTMLSelectElement>("goal"),
  model = el<HTMLSelectElement>("model"),
  authInput = el<HTMLInputElement>("auth-input");
let snapshot: AppSnapshot | null = null;
let serviceReady = false,
  fetching = false,
  refreshAgain = false;
let generation = 0,
  refreshTimer = 0,
  promptIdentity = "",
  goalSignature = "",
  modelSignature = "";
let stream: EventSource | null = null;
let selectedRun: RunView | null = null;
let evidenceTab = "programs",
  evidenceSignature = "";
let library: ExperienceView[] = [];
let libraryGeneration = 0;
let libraryContext = "";
let preparationAttempt: { request: PreparedStartRequest; previousId: string | null } | null = null;
let preparationOutcomeUnknown = false;
let preparationTimer = 0;
let preparationIdentity = "";
let performanceTimer = 0;
let performanceGeneration = 0;
let performanceLastStarted = -Infinity;
let performanceAbort: AbortController | null = null;
let promotion: { run: RunView; execution: SkillExecutionView } | null = null;
const archivedEvents = new Map<
  string,
  {
    events: ActivityEvent[];
    cursor: number;
    more: boolean;
    loading: boolean;
    error: string | null;
    omitted: number[];
  }
>();
const measuredEvidence = new Map<
  string,
  {
    items: ProgramEvidenceView[];
    after: number;
    cursor: number;
    more: boolean;
    total: number | null;
    projection: SkillEvidencePage["projection"] | null;
    omissions: SkillEvidencePage["omissions"];
    loading: boolean;
    error: string | null;
    controller: AbortController | null;
  }
>();
const pending = new Set<string>(),
  events = new Map<string, ActivityEvent>();
const dialogOrigins = new Map<string, HTMLElement>();
let browserVideoDetail = "No browser video measurements yet.";
let motorEdited = false;
function minecraftMotorProfile(state: AppSnapshot | null): string | null {
  const descriptor = state?.game.binding?.descriptor;
  if (descriptor?.game.id !== "minecraft") return null;
  const configuration = minecraftProfileConfigurationSchema.safeParse(descriptor.observation.profile.configuration);
  return configuration.success ? configuration.data.motor_profile : null;
}
const inspector = new EvidenceInspector({
  openDialog,
  measurements: (runId) => measuredEvidence.get(runId)?.items ?? [],
  promote: (run, execution) => openPromotion(run, execution),
  trace: (run, executionId) => {
    selectedRun = run.run_id === snapshot?.run?.run_id ? null : run;
    openDialog("evidence-dialog");
    inspector.selectExecution(run.run_id, executionId);
    setEvidenceTab("trace");
  },
});
const video = new NativeVideo(
  el<HTMLCanvasElement>("game-video"),
  (state, detail, hasFrame) => {
    el("viewer").dataset.state = state;
    text("view-status", label(state));
    browserVideoDetail = detail;
    text(
      "video-detail",
      state === "streaming"
        ? detail.split(" · ", 2).join(" · ")
        : state === "stale"
          ? "Stale video · waiting for fresh frames"
          : state === "error"
            ? "Video unavailable · details in Settings diagnostics"
            : state === "disconnected"
              ? "Video disconnected · reconnecting"
              : state === "idle"
                ? "No live video"
                : "Waiting for client frames",
    );
    if (el<HTMLDialogElement>("performance-dialog").open)
      text("performance-browser", detail);
    hidden("game-video", !hasFrame);
    hidden("viewer-empty", hasFrame);
    const interrupted = hasFrame && state !== "streaming";
    hidden("frame-warning", !interrupted);
    text(
      "frame-warning",
      `${label(state)} · last authentic frame, not current gameplay`,
    );
    if (!hasFrame) {
      text(
        "viewer-title",
        state === "error"
          ? "Video unavailable"
          : state === "idle"
            ? "No live video"
            : "Waiting for client video",
      );
      text("viewer-description", detail);
    }
  },
);
const survivalAgent = new SurvivalAgentView({
  el, text, errorText,
  openSettings: settings,
  closeSettings() {
    const dialog = el<HTMLDialogElement>("settings-dialog");
    if (dialog.open) {
      dialogOrigins.set(dialog.id, el("run-controls"));
      dialog.close();
    }
  },
  changeView(visible) {
    const losingFocus = document.activeElement?.closest(visible ? ".model-only" : ".survival-agent-only");
    document.querySelector(".workspace")!.classList.toggle("show-survival-agent", visible);
    if (visible) video.disconnect();
    else if (serviceReady) video.connect();
    if (losingFocus) el("run-controls").focus({ preventScroll: true });
  },
  updateControls: buttons,
});
function openDialog(id: string): void {
  const dialog = el<HTMLDialogElement>(id);
  if (dialog.open) return;
  if (document.activeElement instanceof HTMLElement)
    dialogOrigins.set(id, document.activeElement);
  dialog.showModal();
}
for (const button of document.querySelectorAll<HTMLButtonElement>(
  "[data-close]",
))
  button.addEventListener("click", () =>
    el<HTMLDialogElement>(button.dataset.close!).close(),
  );
for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog"))
  dialog.addEventListener("close", () => {
    if (dialog.id === "settings-dialog")
      el<HTMLInputElement>("jev-key").value = "";
    if (dialog.id === "performance-dialog") stopPerformance();
    dialogOrigins.get(dialog.id)?.focus({ preventScroll: true });
    dialogOrigins.delete(dialog.id);
    if (dialog.id === "source-dialog" || dialog.id === "promotion-dialog")
      renderEvidence(true);
  });
function active(run: RunView | null): boolean {
  return !!run && !["stopped", "completed", "failed"].includes(run.status);
}
function canOperate(id?: string): boolean {
  return !survivalAgent.locksModel && commandAvailable(serviceReady, snapshot !== null, pending, id);
}
function buttons(): void {
  const state = snapshot,
    run = state?.run ?? null,
    available = canOperate(),
    hasRun = active(run);
  const preparation = state?.prepared_start ?? null;
  const startupLocked = preparedStartActive(preparation) || preparationAttempt !== null;
  survivalAgent.setModelConflict(startupLocked ? "Finish or cancel model preparation before starting the agent."
    : hasRun ? "Stop the model run before starting the agent."
    : state && (["running", "starting", "preparing"].includes(state.server.status) ||
      ["connecting", "connected"].includes(state.game.status))
      ? "Stop the model world before starting the agent."
      : pending.size ? "Wait for the current command to finish." : null);
  const preparePath = state?.game.status !== "connected" || startupLocked;
  const cancel = preparationCancellation(preparation);
  const focused = document.activeElement;
  const preparationReason = preparationOutcomeUnknown
    ? "Preparation outcome is unknown. Reconnect to inspect state, or retry this same request without creating a second preparation."
    : pending.has("prepare-play")
      ? "Submitting preparation request…"
      : !serviceReady
        ? "Reconnect to the local service before preparing."
        : preparationPrerequisite(state, {
            task: task.value, choiceId: goal.value, modelId: model.value,
            experienceId: el<HTMLSelectElement>("experience").value,
          });
  const authBusy = ["authorizing", "discovering"].includes(
    state?.auth.status ?? "",
  );
  const gameBusy = ["preparing", "starting"].includes(
    state?.server.status ?? "",
  );
  const reconnect =
    state?.server.status === "running" &&
    ["disconnected", "error"].includes(state.game.status);
  const prerequisites =
    !!state?.auth.authenticated &&
    state.auth.status === "ready" &&
    !!state.auth.models.length &&
    state.server.status === "running" &&
    state.sandbox.status === "ready";
  const ready = prerequisites && state?.game.status === "connected" &&
    !!state.game.session_id && !!state.game.life && state.game.binding?.ready === true && !!state.game.space;
  const executableRun = !!run && typeof run.goal !== "string" && run.native_boot_id === state?.game.binding?.native_boot_id &&
    run.compatibility_hash !== null && run.compatibility_hash === state?.game.binding?.compatibility_hash && run.session_id === state?.game.session_id;
  const disabled: Record<string, boolean> = {
    "login-browser": !available || authBusy || hasRun || startupLocked,
    "login-device": !available || authBusy || hasRun || startupLocked,
    "refresh-models":
      !available || !state?.auth.authenticated || authBusy || startupLocked || !canRefreshModels(run?.status),
    logout: !available || !state?.auth.authenticated || authBusy || hasRun || startupLocked,
    "auth-submit": !available || startupLocked || !state?.auth.login?.prompt,
    "cancel-login": !available || startupLocked || !state?.auth.login,
    "prepare-game":
      !available ||
      startupLocked ||
      gameBusy ||
      state?.server.status === "running" ||
      hasRun ||
      (!state?.server.eula_accepted && !el<HTMLInputElement>("eula").checked),
    "start-game":
      !available ||
      startupLocked ||
      gameBusy ||
      (!reconnect && state?.server.status !== "stopped") ||
      (hasRun && !(["created", "paused"].includes(run?.status ?? "") && reconnect)),
    "stop-game":
      !canOperate("stop-game") ||
      (!startupLocked && !["running", "starting", "error"].includes(state?.server.status ?? "") &&
        !["connected", "connecting", "error"].includes(state?.game.status ?? "")),
    "new-world":
      !available ||
      startupLocked ||
      hasRun ||
      state?.server.status !== "stopped" ||
      !el<HTMLInputElement>("confirm-world").checked,
    "create-run":
      !available ||
      startupLocked ||
      hasRun ||
      !ready ||
      !taskTextSchema.safeParse(task.value).success ||
      !goal.value ||
      !model.value,
    "prepare-play": !available || (preparationOutcomeUnknown
      ? !preparationAttempt || preparedStartActive(preparation)
      : startupLocked || preparationReason !== null),
    "cancel-preparation": !canOperate("cancel-preparation") || !cancel.available || cancel.draining,
    "cancel-preparation-settings": !canOperate("cancel-preparation") || !cancel.available || cancel.draining,
    "start-run": !available || startupLocked || run?.status !== "created" || !ready || !executableRun,
    "pause-run":
      !available || !["running", "bootstrapping", "reviewing"].includes(run?.status ?? ""),
    "resume-run": !available || startupLocked || run?.status !== "paused" || !ready || !executableRun,
    "stop-run":
      !canOperate("stop-run") ||
      !hasRun ||
      stopControl(run?.status, run?.operator.cleanup_error ?? null).draining,
    "use-goal": !available || hasRun || startupLocked || !state?.goals.find(item => item.id === goal.value)?.goal.verifier,
    "jev-save":
      !available || hasRun || startupLocked || !el<HTMLInputElement>("jev-key").value.trim(),
    "jev-remove": !available || hasRun || startupLocked,
    "motor-save": !available || startupLocked || !motorEdited || minecraftMotorProfile(snapshot) === null,
  };
  for (const [id, value] of Object.entries(disabled)) {
    const button = el<HTMLButtonElement>(id);
    button.disabled = value;
    button.setAttribute("aria-busy", String(pending.has(id === "cancel-preparation-settings" ? "cancel-preparation" : id)));
  }
  goal.disabled = !available || hasRun || startupLocked;
  model.disabled = !available || hasRun || startupLocked || !state?.auth.models.length;
  task.disabled = !available || hasRun || startupLocked;
  el<HTMLSelectElement>("experience").disabled = !available || hasRun || startupLocked;
  el<HTMLSelectElement>("working-programs").disabled = !available || hasRun || startupLocked || preparePath;
  el<HTMLSelectElement>("motor-profile").disabled = !available || startupLocked || minecraftMotorProfile(state) === null;
  for (const id of ["eula", "confirm-world", "auth-input", "jev-key"])
    el<HTMLInputElement>(id).disabled = !available || startupLocked;
  el<HTMLButtonElement>("library-refresh").disabled =
    !available || hasRun || startupLocked || !model.value;
  hidden("prepare-play", !preparePath || preparedStartActive(preparation));
  el<HTMLButtonElement>("prepare-play").type = preparePath ? "submit" : "button";
  el<HTMLButtonElement>("create-run").type = preparePath ? "button" : "submit";
  hidden("preparation-disclosure", !preparePath || startupLocked);
  hidden("create-run", preparePath);
  hidden("create-hint", preparePath);
  hidden("working-library", preparePath);
  text("library-mode", preparePath
    ? "Qualified bundles load through Create run in a connected world."
    : "Separately, optionally load one exact evidence-backed startup bundle. Neither choice executes code; the new run still receives fresh permissions and validation.");
  text("prepare-play", preparationOutcomeUnknown ? "Retry preparation request" : "Prepare & play");
  text("preparation-prerequisite", preparationReason ?? "");
  hidden("preparation-prerequisite", !preparePath || !preparationReason || preparedStartActive(preparation));
  for (const id of ["cancel-preparation", "cancel-preparation-settings"]) {
    hidden(id, !cancel.available);
    text(id, cancel.label);
  }
  hidden("start-run", startupLocked && !hasRun);
  hidden("stop-run", startupLocked && !hasRun);
  hidden("pause-run", run?.status === "paused" || startupLocked && !hasRun);
  hidden("resume-run", run?.status !== "paused" || startupLocked && !hasRun);
  text(
    "stop-run",
    stopControl(run?.status, run?.operator.cleanup_error ?? null).label,
  );
  text(
    "start-game",
    reconnect
      ? "Reconnect client"
      : gameBusy
        ? "Starting…"
        : state?.game.status === "connected"
          ? "Client connected"
          : "Start world",
  );
  text(
    "create-hint",
    hasRun
      ? "Stop this run before creating another task."
      : "Create saves the task; Start begins inference.",
  );
  if (focused instanceof HTMLButtonElement &&
    ["cancel-preparation", "cancel-preparation-settings"].includes(focused.id) &&
    (focused.disabled || focused.hidden)) {
    el(el<HTMLDialogElement>("settings-dialog").open ? "preparation-panel" : "run-controls")
      .focus({ preventScroll: true });
  }
  promotionButtons();
}

function librarySelection(): void {
  const selection = library.find(
    (item) => item.experience_id === el<HTMLSelectElement>("experience").value,
  );
  hidden("experience-detail", !selection);
  text("experience-detail", selection ? json(selection) : "");
  buttons();
}

async function loadLibrary(): Promise<void> {
  if (preparedStartActive(snapshot?.prepared_start ?? null) || preparationAttempt) return;
  const current = ++libraryGeneration;
  const modelId = model.value;
  libraryContext = json([modelId, snapshot?.server.world_id ?? null]);
  const select = el<HTMLSelectElement>("experience");
  const previous = select.value;
  const previousLabel = select.selectedOptions[0]?.textContent ?? previous;
  if (!serviceReady || !modelId) {
    text(
      "library-status",
      "Choose a strategic model to load compatible bundles.",
    );
    return;
  }
  text("library-status", "Loading model- and world-compatible saved bundles…");
  try {
    const items = await fetchExperience(modelId);
    if (current !== libraryGeneration || model.value !== modelId) return;
    library = items;
    select.replaceChildren(
      new Option("No saved programs", ""),
      ...items.map(
        (item) =>
          new Option(
            `${item.name} · ${label(item.portability)} · ${item.experience_id.slice(0, 12)}`,
            item.experience_id,
          ),
      ),
    );
    if (previous) {
      if (!items.some((item) => item.experience_id === previous))
        select.add(new Option(previousLabel, previous));
      select.value = previous;
    }
    text(
      "library-status",
      previous && !items.some(item => item.experience_id === previous)
        ? "The selected bundle is no longer listed. Clear it or refresh the compatible library before creating a run."
        : items.length
        ? `${items.length} bundles listed by the service for this model and current world. Exact compatibility is rechecked on admission.`
        : "No compatible saved bundles. New runs can still author their own programs.",
    );
    librarySelection();
  } catch (error) {
    if (current === libraryGeneration)
      text(
        "library-status",
        `Library unavailable: ${message(error)}${previous ? " Your selected bundle is unchanged." : " No saved bundle is selected."}`,
      );
  }
}

async function loadEventPage(runId: string): Promise<void> {
  let archive = archivedEvents.get(runId);
  if (!archive) {
    archive = {
      events: [],
      cursor: 0,
      more: true,
      loading: false,
      error: null,
      omitted: [],
    };
    archivedEvents.set(runId, archive);
  }
  if (archive.loading || !archive.more) return;
  archive.loading = true;
  archive.error = null;
  renderEvidence(true);
  renderPromotionEvents();
  try {
    const page = await fetchRunEvents(runId, archive.cursor);
    archive.events.push(...page.events);
    archive.cursor = page.next_cursor;
    archive.more = page.has_more;
    archive.omitted.push(...page.omitted_details);
  } catch (error) {
    archive.error = message(error);
  } finally {
    archive.loading = false;
    renderEvidence(true);
    renderPromotionEvents();
  }
}

async function loadMeasurements(runId: string, nextPage = false): Promise<void> {
  let measured = measuredEvidence.get(runId);
  if (nextPage && (!measured || measured.loading || !measured.more)) return;
  for (const [id, cached] of measuredEvidence) {
    if (id === runId) continue;
    cached.controller?.abort();
    measuredEvidence.delete(id);
  }
  if (!nextPage || !measured) {
    measured?.controller?.abort();
    measured = {
      items: [],
      after: 0,
      cursor: 0,
      more: false,
      total: null,
      projection: null,
      omissions: [],
      loading: false,
      error: null,
      controller: null,
    };
    measuredEvidence.set(runId, measured);
  }
  const after = measured.cursor;
  const controller = new AbortController();
  const focusKey = document.activeElement instanceof HTMLElement
    ? document.activeElement.dataset.key
    : undefined;
  measured.loading = true;
  measured.error = null;
  measured.controller = controller;
  renderEvidence(true);
  if (focusKey === "measurements-refresh" || focusKey === "measurements-next")
    document.getElementById("measurements-status")?.focus({ preventScroll: true });
  try {
    const page = await fetchSkillEvidence(runId, after, 25, controller.signal);
    if (measuredEvidence.get(runId) !== measured || controller.signal.aborted) return;
    measured.items = page.records;
    measured.after = after;
    measured.cursor = page.next_after;
    measured.more = page.has_more;
    measured.total = page.total;
    measured.projection = page.projection;
    measured.omissions = page.omissions;
  } catch (error) {
    if (measuredEvidence.get(runId) === measured && !controller.signal.aborted)
      measured.error = message(error);
  } finally {
    if (measuredEvidence.get(runId) === measured && !controller.signal.aborted) {
      const restoreFocus = (selectedRun ?? snapshot?.run)?.run_id === runId &&
        document.activeElement?.id === "measurements-status";
      measured.loading = false;
      measured.controller = null;
      renderEvidence(true);
      if (restoreFocus && focusKey) {
        const button = document.getElementById(focusKey);
        const target = button instanceof HTMLButtonElement && !button.disabled
          ? button
          : document.getElementById("measurements-refresh");
        target?.focus({ preventScroll: true });
      }
    }
  }
}

function promotionButtons(): void {
  if (!promotion) return;
  const scope = el<HTMLSelectElement>("promotion-scope").value;
  const worldData = el<HTMLSelectElement>("promotion-world-data").value;
  const invalidPortable = scope === "portable" && worldData === "yes";
  text(
    "promotion-scope-hint",
    invalidPortable
      ? "Retained world-specific data cannot be declared portable. Choose this world only, or review the exact program before declaring no retained data."
      : scope && worldData
        ? "The service will check the exact execution, immutable dependencies, trusted event, and attributable effects."
        : "Choose scope and retained-data declarations before saving.",
  );
  el<HTMLButtonElement>("promotion-save").disabled =
    !canOperate() ||
    preparedStartActive(snapshot?.prepared_start ?? null) ||
    preparationAttempt !== null ||
    invalidPortable ||
    !scope ||
    !worldData ||
    !el<HTMLSelectElement>("promotion-evidence").value;
}

function renderPromotionEvent(): void {
  const archive = promotion ? archivedEvents.get(promotion.run.run_id) : null;
  const event = archive?.events.find(
    (item) =>
      String(item.event_seq) ===
      el<HTMLSelectElement>("promotion-evidence").value,
  );
  const candidate = event && promotion ? promotionEvidence(event, promotion.run, promotion.execution,
    (archive?.events ?? []).filter(record => !archive?.omitted.includes(record.event_seq))) : null;
  const inventory = candidate?.kind === "inventory_gain";
  hidden("promotion-inventory", !inventory);
  hidden("promotion-event-detail", !event);
  text("promotion-event-detail", event ? json(event) : "");
  const select = el<HTMLSelectElement>("promotion-item");
  const previous = select.value;
  const items = candidate?.kind === "inventory_gain" ? Object.entries(candidate.counts) : [];
  select.replaceChildren(
    new Option("Choose observed item", ""),
    ...items.map(
      ([name, value]) => new Option(`${name} · observed ${value}`, name),
    ),
  );
  if (items.some(([name]) => name === previous)) select.value = previous;
  select.required = !!inventory;
  promotionButtons();
}

function renderPromotionEvents(): void {
  if (!promotion || !el<HTMLDialogElement>("promotion-dialog").open) return;
  const { run, execution } = promotion;
  const archive = archivedEvents.get(run.run_id);
  const select = el<HTMLSelectElement>("promotion-evidence");
  const previous = select.value;
  const history = (archive?.events ?? []).filter(event => !archive?.omitted.includes(event.event_seq));
  const candidates = (archive?.events ?? []).filter(
    (event) =>
      promotionEvidence(event, run, execution, history) !== null &&
      !archive?.omitted.includes(event.event_seq),
  );
  select.replaceChildren(
    new Option("Select actual trusted evidence", ""),
    ...candidates.map(
      (event) =>
        new Option(
          `#${event.event_seq} · ${label(event.type)} · ${event.summary}`,
          String(event.event_seq),
        ),
    ),
  );
  if (candidates.some((event) => String(event.event_seq) === previous))
    select.value = previous;
  text(
    "promotion-events-status",
    archive?.error
      ? `Evidence unavailable: ${archive.error}`
      : `${archive?.events.length ?? 0} retained events loaded; ${candidates.length} trusted candidates in this execution interval.${archive?.loading ? " Loading…" : archive?.more ? " Load more to reach later evidence." : " End of retained events."}${archive?.omitted.length ? ` ${archive.omitted.length} oversized event details explicitly omitted by the service; omitted records cannot be selected.` : ""}`,
  );
  el<HTMLButtonElement>("promotion-more").disabled =
    !!archive?.loading || archive?.more === false;
  renderPromotionEvent();
}

function openPromotion(run: RunView, execution: SkillExecutionView): void {
  promotion = { run, execution };
  text(
    "promotion-execution",
    `${run.run_id}\n${execution.execution_id} · ${label(execution.status)}\n${execution.skill_id} · v${execution.version}`,
  );
  el<HTMLFormElement>("promotion-form").reset();
  text("promotion-result", "");
  errorText("promotion-error", null);
  openDialog("promotion-dialog");
  renderPromotionEvents();
  if (!archivedEvents.has(run.run_id)) void loadEventPage(run.run_id);
}
function renderTaskCondition(): void {
  const selected = snapshot?.goals.find(choice => choice.id === goal.value);
  const preset = Boolean(selected?.goal.verifier);
  text("goal-condition", preset
    ? `Automatically stops when verified: ${selected!.prompt} Editing the task switches to Custom.`
    : "Custom / natural language: no automatic success check. task_finish is model-reported and unverified.");
  el<HTMLButtonElement>("use-goal").disabled = !preset;
}
function renderOptions(state: AppSnapshot): void {
  const gs = json(state.goals);
  if (gs !== goalSignature) {
    goalSignature = gs;
    const draft = state.goals.length ? initialTaskDraft(state.goals, { choice_id: goal.value, task: task.value }) : null;
    goal.replaceChildren(
      ...state.goals.map((item) => new Option(item.goal.verifier === null ? "Custom / natural language" : `Preset: ${item.label}`, item.id)),
    );
    if (draft) { goal.value = draft.choice_id; task.value = draft.task; }
    renderTaskCondition();
  }
  const ms = json(state.auth.models);
  if (ms !== modelSignature) {
    modelSignature = ms;
    const previous = model.value || state.prepared_start?.model_id || state.run?.model_id;
    model.replaceChildren(
      ...(state.auth.models.length
        ? state.auth.models.map((item) => new Option(item.name, item.id))
        : [new Option("No models available", "")]),
    );
    if (previous && state.auth.models.some((item) => item.id === previous))
      model.value = previous;
  }
  const preparation = state.prepared_start;
  if (preparation && preparation.preparation_id !== preparationIdentity) {
    preparationIdentity = preparation.preparation_id;
    if (preparedStartActive(preparation) || !state.run) {
      task.value = preparation.task;
      const choice = state.goals.find(item => json(item.goal) === json(preparation.goal));
      goal.value = choice?.id ?? "";
      if (state.auth.models.some(item => item.id === preparation.model_id))
        model.value = preparation.model_id;
      renderTaskCondition();
    }
  }
  if (preparedStartActive(preparation))
    model.value = state.auth.models.some(item => item.id === preparation!.model_id) ? preparation!.model_id : "";
}
function safeOAuth(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      [
        "auth.openai.com",
        "auth0.openai.com",
        "login.openai.com",
        "platform.openai.com",
      ].includes(url.hostname) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
function renderAuth(state: AppSnapshot): void {
  const auth = state.auth;
  text(
    "account-description",
    auth.authenticated
      ? `${auth.account_label ?? "Account connected"} · ${auth.models.length} available models`
      : `OpenAI · ${label(auth.status)}. Connect your own account.`,
  );
  hidden("logout", !auth.authenticated);
  hidden("refresh-models", !auth.authenticated);
  hidden("login-flow", !auth.login);
  errorText("auth-error", auth.error);
  const login = auth.login,
    identity = login ? `${login.id}:${login.prompt?.label ?? ""}` : "";
  if (identity !== promptIdentity) {
    authInput.value = "";
    promptIdentity = identity;
  }
  hidden("auth-form", !login?.prompt);
  const url = safeOAuth(login?.url ?? null),
    link = el<HTMLAnchorElement>("authorize-link");
  hidden("authorize-link", !url);
  if (url) link.href = url;
  else link.removeAttribute("href");
  text(
    "login-instructions",
    login?.instructions ??
      "Open the provider link to authorize this local application.",
  );
  if (login?.url && !url)
    errorText(
      "auth-error",
      "Unsupported provider authorization address. Cancel and retry authorization.",
    );
  if (login?.prompt) {
    text("auth-input-label", login.prompt.label);
    authInput.type = login.prompt.secret ? "password" : "text";
    authInput.required = !login.prompt.allow_empty;
  }
}
function usageList(node: HTMLElement, usage: TokenUsage | null): void {
  node.replaceChildren();
  for (const [name, value] of [
    ["Reported uncached subtotal", usage ? count(usage.uncached_input) : "Unknown"],
    ["Reported cache-read subtotal", usage ? count(usage.cache_read) : "Unknown"],
    ["Reported cache-write subtotal", usage ? count(usage.cache_write) : "Unknown"],
    ["Reported output subtotal", usage ? count(usage.output) : "Unknown"],
    ["Calls", usage ? count(usage.calls) : "Unknown"],
  ]) {
    const dt = document.createElement("dt"),
      dd = document.createElement("dd");
    dt.textContent = name!;
    dd.textContent = value!;
    node.append(dt, dd);
  }
}
function renderPreparationClock(): void {
  window.clearTimeout(preparationTimer);
  preparationTimer = 0;
  const preparation = snapshot?.prepared_start;
  if (!preparation) return;
  const timing = preparationTiming(preparation, Date.now());
  const elapsed = timing.elapsed_ms === null ? null : Math.floor(timing.elapsed_ms / 1000);
  const clock = elapsed === null
    ? `Started ${when(preparation.started_at)} · deadline ${when(preparation.deadline_at)}`
    : `Elapsed ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")} · deadline ${when(preparation.deadline_at)}${timing.deadline_reached ? " · deadline passed" : ""}`;
  text("preparation-clock", clock);
  if (elapsed !== null && snapshot && detachedPreparation(snapshot) === preparation && !preparationAttempt &&
    !["cancelling", "cancelled", "failed", "started"].includes(preparation.phase) &&
    preparation.closure !== "unknown")
    text("run-hint",
      `${preparation.requests_admitted} / ${preparation.limits.max_requests} requests · elapsed ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")} · deadline ${new Date(preparation.deadline_at).toLocaleTimeString()}${timing.deadline_reached ? " · deadline passed" : ""}`);
  if (timing.elapsed_ms !== null)
    preparationTimer = window.setTimeout(renderPreparationClock, 1000);
}
function renderPreparation(): void {
  const preparation = snapshot?.prepared_start ?? null;
  hidden("preparation-panel", !preparation || preparationAttempt !== null);
  if (preparation) {
    text("preparation-status", preparationLabel(preparation));
    text("preparation-requests",
      `${preparation.requests_admitted} / ${preparation.limits.max_requests} model requests · ${preparation.model_id}`);
    const cleanup = preparation.closure === "unknown"
      ? `Cleanup is unconfirmed; new startup remains blocked. ${preparationCancellation(preparation).available ? "Use Cancel preparation or Stop world to retry cleanup." : "Use Stop world to retry cleanup."}`
      : null;
    const recovery = preparation.phase === "failed" && preparation.closure === "closed"
      ? "Review the task or model before starting a new preparation."
      : null;
    errorText("preparation-error", [preparation.error, cleanup, recovery].filter(Boolean).join(" ") || null);
    text("preparation-details", json(preparation));
  }
  renderPreparationClock();
}
function mergeEvents(incoming: ActivityEvent[]): void {
  for (const event of incoming)
    events.set(`${event.run_id ?? "system"}:${event.event_seq}`, event);
  const ordered = [...events.values()]
    .sort((a, b) => a.at.localeCompare(b.at) || a.event_seq - b.event_seq)
    .slice(-200);
  events.clear();
  for (const event of ordered)
    events.set(`${event.run_id ?? "system"}:${event.event_seq}`, event);
  const run = snapshot && detachedPreparation(snapshot) ? null : snapshot?.run;
  const latest = run ? ordered.filter(event => event.run_id === run.run_id).at(-1) : ordered.at(-1);
  const progress = run?.operator.progress;
  const summary = progress?.summary ?? latest?.summary;
  el("latest-activity").dataset.runId = run?.run_id ?? latest?.run_id ?? "";
  el("latest-activity").dataset.eventSeq = String(progress?.event_seq ?? latest?.event_seq ?? "");
  const longActivity = !!summary && (summary.length > 80 || /[\r\n]/.test(summary));
  text("activity-heading", progress ? "Model progress · unverified" : longActivity ? "Activity · read full" : "Latest activity");
  text(
    "latest-activity",
    summary
      ? longActivity ? `${summary.replace(/\s+/g, " ").trim().slice(0, 48).trimEnd()}…` : summary
      : "No recorded activity yet.",
  );
}
function render(state: AppSnapshot): void {
  snapshot = state;
  if (preparationAttempt && state.prepared_start &&
    state.prepared_start.preparation_id !== preparationAttempt.previousId &&
    state.prepared_start.task === preparationAttempt.request.task &&
    state.prepared_start.model_id === preparationAttempt.request.model_id &&
    json(state.prepared_start.goal) === json(preparationAttempt.request.goal)) {
    preparationAttempt = null;
    preparationOutcomeUnknown = false;
  }
  renderOptions(state);
  renderAuth(state);
  mergeEvents(state.events);
  video.setSourceState(state.game.video.status, state.game.video.error);
  const context = json([model.value, state.server.world_id]);
  if (libraryContext && libraryContext !== context) {
    libraryContext = context;
    libraryGeneration++;
    library = [];
    el<HTMLSelectElement>("experience").replaceChildren(
      new Option("No saved programs", ""),
    );
    librarySelection();
    text(
      "library-status",
      "Model or world changed. Refresh the compatible library before selecting a saved bundle.",
    );
    if (el<HTMLDialogElement>("settings-dialog").open) void loadLibrary();
  }
  const run = state.run;
  const preparation = detachedPreparation(state);
  const life = state.game.life;
  const deadControl = ["bootstrapping", "running"].includes(run?.status ?? "")
    ? "model may request respawn"
    : run?.status === "paused"
      ? "control paused"
      : run?.status === "created"
        ? "task not started"
        : run?.status === "reviewing"
          ? "effect-free review"
          : ["pausing", "stopping"].includes(run?.status ?? "")
            ? "control closing"
            : "no active run";
  text("life-current", state.game.status === "error"
    ? "Connection fault · inspect Settings"
    : state.game.status !== "connected"
      ? `Client ${label(state.game.status)}`
      : life
        ? `Life ${life.life_id} · ${life.status}${life.status === "dead" ? life.can_respawn ? ` · ${deadControl}` : " · waiting for death-screen readiness" : life.status === "respawning" ? " · awaiting native confirmation" : ""}`
        : "Connected · awaiting life readiness");
  const motorProfile = minecraftMotorProfile(state);
  el<HTMLSelectElement>("motor-profile").disabled = motorProfile === null;
  if (el<HTMLSelectElement>("motor-profile").value === motorProfile) motorEdited = false;
  if (!motorEdited && motorProfile) el<HTMLSelectElement>("motor-profile").value = motorProfile;
  text("motor-status", motorProfile ? `Current materialized profile: ${motorProfile}.${motorEdited ? " Selection not applied." : " Applies live without restarting the session; old executable validations cannot cross a changed profile."}` : "This adapter has no Minecraft motor-profile control.");
  text("run-status", preparationAttempt
    ? preparationOutcomeUnknown ? "Preparation outcome unknown" : "Submitting preparation request"
    : preparation && preparation.phase !== "started" ? preparationLabel(preparation)
      : run ? operatorLabel(run.operator.state, run.operator.completion) : "No run");
  el("run-status").dataset.state = preparationAttempt ? "preparation-pending"
    : preparation && preparation.phase !== "started" ? `preparation-${preparation.phase}` : run?.operator.state ?? "none";
  el("run-status").dataset.completion = preparation ? "none" : run?.operator.completion ?? "none";
  const currentGoal = preparation?.goal ?? run?.goal;
  const currentTask = preparation?.task ?? run?.task;
  const suppliedGoal = state.goals.find(item => typeof currentGoal === "object" && item.goal.adapter_id === currentGoal.adapter_id &&
    item.goal.goal_id === currentGoal.goal_id && item.goal.verifier?.id === currentGoal.verifier?.id &&
    item.goal.verifier?.version === currentGoal.verifier?.version);
  const taskText = currentTask ? currentTaskText(currentTask, currentTask === suppliedGoal?.prompt) : null;
  text("current-task", taskText?.excerpt ?? "No run created.");
  hidden("goal-more", !taskText?.showFull);
  const execution = preparation ? null : run?.executions.find((item) => item.execution_id === run.action?.execution_id) ?? run?.executions.find((item) =>
    ["running", "accepted", "cancel_requested"].includes(item.status),
  );
  const skill = run?.skills.find(
    (item) =>
      item.skill_id === execution?.skill_id &&
      item.version === execution?.version,
  );
  text(
    "program-current",
    preparation
      ? preparation.program?.name ?? "No program selected yet."
      : execution
      ? skill && skill.name.length <= 32 && !/[\r\n]/.test(skill.name)
        ? skill.name
        : execution.skill_id
      : run ? operatorLabel(run.operator.state, run.operator.completion) : "No executing skill.",
  );
  const currentAction = !preparation && run?.action && ["accepted", "running", "cancel_requested"].includes(run.action.status)
    ? `${run.action.kind} · ${run.action.summary.replace(/\s+/g, " ").slice(0, 80)}` : null;
  text("program-status", preparation
    ? [preparation.program ? `v${preparation.program.version}` : null, preparationLabel(preparation)].filter(Boolean).join(" · ")
    : [execution ? `v${execution.version} · ${label(execution.status)}` : null, currentAction].filter(Boolean).join(" · "));
  hidden("program-status", !preparation && !execution && !currentAction);
  usageList(el("usage-summary"), preparationAttempt ? null : currentUsage(state));
  errorText("run-error", preparation
    ? preparation.error
    : [...new Set([run?.error, run?.operator.cleanup_error].filter(Boolean))].join(" ") || null);
  text(
    "readiness",
    `World · ${label(state.server.status)} / OpenAI · ${label(state.auth.status)} / Isolation · ${label(state.sandbox.status)}`,
  );
  text(
    "world-description",
    `Minecraft ${state.server.version} · ${state.server.host}:${state.server.port} · ${label(state.server.status)} · client ${label(state.game.status)}`,
  );
  hidden("eula-row", state.server.eula_accepted);
  errorText(
    "game-error",
    state.server.error ?? state.game.error ?? state.game.video.error,
  );
  errorText("sandbox-error", state.sandbox.error);
  let hint = "Configure a task in Settings.";
  if (run?.status === "paused")
    hint = state.auth.status !== "ready"
      ? "Control paused. Refresh models in Settings; Resume needs model readiness. Reauthorization requires Stop run first."
      : run.operator.pause_cause === "deadline"
        ? "Strategic time allowance reached. Resume explicitly continues this task with fresh observations."
        : run.operator.pause_cause === "provider_aborted"
          ? "Provider response aborted. Resume explicitly continues this task with fresh observations."
          : "Paused control; world ticks continue. Resume explicitly continues this task with fresh observations.";
  else if (run?.status === "stopping")
    hint = run.operator.cleanup_error
      ? "Cleanup failed. Retry Stop; effects may be unknown."
      : "Fencing agent work; awaiting confirmed input neutralization.";
  else if (run?.status === "created")
    hint = life?.status === "dead" && life.can_respawn
      ? "Task saved. Start lets the model inspect the death state and choose recovery."
      : "Task saved. Start begins strategic inference.";
  else if (run?.status === "reviewing")
    hint = "Goal verified. Effect-free review; no additional gameplay trials.";
  else if (active(run))
    hint = life?.status === "dead"
      ? "Player dead. The model chooses whether to respawn; native video continues."
      : life?.status === "respawning"
        ? "Model requested respawn. Awaiting authoritative new-life readiness."
        : life?.status === "loading"
          ? "Player loading. Ordinary effects wait for native readiness."
          : "Pause and Stop fence agent work; the game session continues.";
  else if (run)
    hint = run.operator.completion === "model_reported_unverified"
      ? "Model completion report retained; no independent success check. Agent control is closed."
      : state.game.status === "connected"
      ? "Run closed. Client remains connected; create the next task without reconnecting."
      : `Run closed. Client ${label(state.game.status)}; inspect Settings before the next task.`;
  else if (state.game.status === "connected" && life?.status === "dead" && life.can_respawn)
    hint = state.auth.authenticated
      ? "Player dead; no active run. Create a task and Start so the model can choose recovery."
      : "Player dead; no active run. Connect OpenAI in Settings, create a task and Start.";
  else if (!state.auth.authenticated)
    hint = state.game.status === "disconnected"
      ? "In Settings, choose Minecraft Survival Agent or set up a model task."
      : "Connect OpenAI in Settings to run a model task.";
  if (preparationAttempt)
    hint = preparationOutcomeUnknown
      ? "Reconnect to inspect preparation. Stop world remains available in Settings."
      : "Waiting for the service to admit preparation. Stop world remains available in Settings.";
  else if (preparation && preparation.phase !== "started")
    hint = preparation.closure === "unknown"
      ? "Cleanup is unconfirmed. New startup is blocked; inspect preparation in Settings."
      : preparation.phase === "cancelling"
        ? "Waiting for confirmed cleanup; task and world settings remain locked."
        : preparation.phase === "failed"
          ? "Inspect the preparation error in Settings before trying again."
          : preparation.phase === "cancelled"
            ? "Configure the next task in Settings."
            : `${preparation.requests_admitted} / ${preparation.limits.max_requests} model requests · deadline ${new Date(preparation.deadline_at).toLocaleTimeString()}`;
  else if (!run && state.game.status === "disconnected" && state.auth.authenticated)
    hint = "Choose a task and model in Settings, then Prepare & play.";
  text("run-hint", hint);
  renderPreparation();
  buttons();
  renderEvidence();
}
function sectionHeading(parent: HTMLElement, title: string): void {
  const h = document.createElement("h3");
  h.textContent = title;
  parent.append(h);
}
function paragraph(
  parent: HTMLElement,
  value: string,
  className?: string,
): void {
  const p = document.createElement("p");
  p.textContent = value;
  if (className) p.className = className;
  parent.append(p);
}
function recordButton(
  parent: HTMLElement,
  title: string,
  detail: string,
  key: string,
  handler: () => void,
): void {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "record";
  button.dataset.key = key;
  const strong = document.createElement("strong"),
    span = document.createElement("span");
  strong.textContent = title;
  span.textContent = detail;
  button.append(strong, span);
  button.addEventListener("click", handler);
  parent.append(button);
}
function pre(parent: HTMLElement, value: unknown): void {
  const node = document.createElement("pre");
  node.tabIndex = 0;
  node.textContent = json(value);
  parent.append(node);
}
function usageTable(parent: HTMLElement, run: Pick<RunView, "usage">): void {
  paragraph(
    parent,
    "SDK/provider-message reported subtotals, not proven provider-consumption totals. Unknown means unreported; legacy aggregate input is not relabeled as uncached input. Reported monetary cost is a subtotal, not a subscription invoice.",
  );
  const scroller = document.createElement("div");
  scroller.className = "table-scroll";
  const table = document.createElement("table");
  const header = document.createElement("thead"),
    tr = document.createElement("tr");
  for (const name of [
    "Purpose",
    "Calls",
    "Uncached input",
    "Cache read",
    "Cache write",
    "Output",
    "Legacy input",
    "Reported cost subtotal",
  ]) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = name;
    tr.append(th);
  }
  header.append(tr);
  table.append(header);
  const body = document.createElement("tbody");
  for (const [name, value] of [
    ["Reported subtotal", run.usage],
    ...Object.entries(run.usage.by_purpose),
  ] as [string, TokenUsage][]) {
    const row = document.createElement("tr");
    const heading = document.createElement("th");
    heading.scope = "row";
    heading.textContent = label(name);
    row.append(heading);
    for (const item of [
      count(value.calls),
      count(value.uncached_input),
      count(value.cache_read),
      count(value.cache_write),
      count(value.output),
      count(value.legacy_input),
      value.known_cost === null ? "Unknown" : `$${value.known_cost.toFixed(4)}`,
    ]) {
      const td = document.createElement("td");
      td.textContent = item;
      row.append(td);
    }
    body.append(row);
  }
  table.append(body);
  scroller.append(table);
  parent.append(scroller);
  paragraph(
    parent,
    "Token usage, code compactness, and measured gameplay effectiveness are separate evidence. No causal speedup is inferred.",
    "muted",
  );
}
function renderEvidence(force = false): void {
  if (!el<HTMLDialogElement>("evidence-dialog").open) return;
  if (
    el<HTMLDialogElement>("source-dialog").open ||
    el<HTMLDialogElement>("promotion-dialog").open
  )
    return;
  const preparation = selectedRun || !snapshot ? null : detachedPreparation(snapshot);
  const run = selectedRun ?? (preparation ? null : snapshot?.run ?? null);
  const archive = run ? archivedEvents.get(run.run_id) : null;
  const retained = new Map<string, ActivityEvent>();
  for (const event of [...events.values(), ...(archive?.events ?? [])]) {
    if (!run || !event.run_id || event.run_id === run.run_id)
      retained.set(`${event.run_id ?? "system"}:${event.event_seq}`, event);
  }
  const relevantEvents = [...retained.values()].sort(
    (a, b) => b.at.localeCompare(a.at) || b.event_seq - a.event_seq,
  );
  const signature = json([
    evidenceTab,
    run,
    preparation,
    evidenceTab === "activity" ? [relevantEvents, archive] : null,
    evidenceTab === "inventory" ? snapshot?.game.presentation : null,
    evidenceTab === "life" ? snapshot?.game : null,
    run ? measuredEvidence.get(run.run_id) : null,
  ]);
  if (!force && signature === evidenceSignature) return;
  evidenceSignature = signature;
  const node = el("evidence-content");
  text(
    "evidence-run",
    run
      ? `${selectedRun ? "Retained" : "Current"} run · ${run.run_id} · ${operatorLabel(run.operator.state, run.operator.completion)}`
      : preparation ? `${preparationLabel(preparation)} · ${preparation.model_id}` : "No run selected",
  );
  if (inspector.render(evidenceTab, node, run, selectedRun ? null : snapshot?.game ?? null)) return;
  const focused =
    document.activeElement instanceof HTMLElement
      ? document.activeElement.dataset.key
      : undefined;
  const openDetails = new Set(
    [...node.querySelectorAll<HTMLDetailsElement>("details[open]")].map(
      (item) => item.dataset.record,
    ),
  );
  const scroll = node.scrollTop;
  node.replaceChildren();
  if (run || preparation) {
    paragraph(node, (run ?? preparation)!.task, "evidence-task");
    const task = node.querySelector<HTMLElement>(".evidence-task")!;
    task.tabIndex = -1;
    task.dataset.key = "full-task";
  }
  if (evidenceTab === "activity") {
    if (run) {
      paragraph(
        node,
        archive?.error
          ? `Retained activity unavailable: ${archive.error}`
          : archive?.loading
            ? "Loading retained activity…"
            : `${archive?.events.length ?? 0} retained events loaded in bounded pages. Latest live events are also shown.`,
      );
      if (archive?.omitted.length)
        paragraph(
          node,
          `Details explicitly omitted for oversized event sequences: ${archive.omitted.join(", ")}. These summaries do not establish a promotion predicate.`,
          "muted",
        );
      if (!archive || archive.more) {
        const more = document.createElement("button");
        more.type = "button";
        more.textContent = archive?.loading
          ? "Loading…"
          : "Load more retained activity";
        more.disabled = !!archive?.loading;
        more.addEventListener("click", () => void loadEventPage(run.run_id));
        node.append(more);
      }
    }
    if (!relevantEvents.length)
      paragraph(node, "No recorded activity available in the loaded window.");
    for (const event of relevantEvents) {
      const details = document.createElement("details"),
        summary = document.createElement("summary");
      details.dataset.record = `event:${event.run_id ?? "system"}:${event.event_seq}`;
      summary.dataset.key = details.dataset.record;
      summary.textContent = `${when(event.at)} · ${label(event.type)} — ${event.summary}`;
      details.append(summary);
      pre(details, event);
      node.append(details);
    }
  } else if (evidenceTab === "inventory") {
    if (selectedRun) {
      paragraph(
        node,
        "Live adapter state belongs to the current client, not this retained run. Review linked evidence for historical observations.",
      );
    } else {
      const presentation = snapshot?.game.presentation;
      paragraph(
        node,
        presentation
          ? `Observed ${when(snapshot?.game.last_observation_at ?? null)} · ${presentation.summary}`
          : "Adapter state is unavailable.",
      );
      if (presentation) paragraph(node, json(presentation.state), "mono");
    }
  } else if (preparation && evidenceTab === "usage") {
    usageTable(node, preparation);
  } else if (preparation && evidenceTab === "programs") {
    sectionHeading(node, preparationLabel(preparation));
    paragraph(node, preparation.program
      ? `Selected program: ${preparation.program.name} · v${preparation.program.version}`
      : "No program selected yet.");
    if (preparation.error) paragraph(node, preparation.error, "error");
    pre(node, preparation);
  } else if (!run) {
    paragraph(
      node,
      "Create a run in Settings. Model-authored programs, executions, revisions, and actual usage appear here when recorded.",
    );
  } else if (evidenceTab === "programs") {
    sectionHeading(node, "Model & current control");
    paragraph(node, `${run.model_id} · strategist ${label(run.model_status)} · ${run.turns} turns`);
    for (const execution of run.executions.filter((item) =>
      ["running", "accepted", "cancel_requested"].includes(item.status),
    )) {
      const skill = run.skills.find((item) =>
        item.skill_id === execution.skill_id && item.version === execution.version,
      );
      paragraph(node, `${skill?.name ?? execution.skill_id} · ${execution.skill_id} · v${execution.version} · ${label(execution.status)} · ${execution.actions} actions / ${execution.calls} host calls`, "mono");
    }
    paragraph(node, run.action
      ? `${label(run.action.origin)} · ${run.action.kind} · ${label(run.action.status)} — ${run.action.summary}`
      : "No foreground action.");
    sectionHeading(node, "Skills");
    if (!run.skills.length)
      paragraph(node, "No model-authored skills registered in this run.");
    for (const skill of run.skills)
      recordButton(
        node,
        `${skill.name} · v${skill.version}`,
        `${label(skill.state)} · ${skill.validation.formatted_lines} canonical lines · ${skill.dependencies.length} exact dependencies`,
        `${skill.skill_id}:${skill.version}`,
        () => inspector.showSource(skill, run),
      );
    sectionHeading(node, "Reactive programs");
    if (!run.policies.length)
      paragraph(node, "No reactive programs registered.");
    for (const policy of run.policies)
      recordButton(
        node,
        `${policy.name} · v${policy.version}`,
        `${policy.backend} · ${label(policy.state)} · ${policy.evaluations} evaluations / ${policy.effects} effects`,
        `${policy.policy_id}:${policy.version}`,
        () => inspector.showSource(policy, run),
      );
  } else if (evidenceTab === "executions") {
    paragraph(
      node,
      "Program result status does not certify the run’s objective. Unknown actions are not automatically replayed.",
      "muted",
    );
    const measured = measuredEvidence.get(run.run_id);
    const status = document.createElement("p");
    status.id = status.dataset.key = "measurements-status";
    status.tabIndex = -1;
    status.setAttribute("role", "status");
    const displayedExecutions = new Set(run.executions.map(item => item.execution_id));
    const matching = measured?.items.filter(item => displayedExecutions.has(item.execution_id)).length ?? 0;
    status.textContent = measured && measured.total !== null
      ? `${measured.items.length} measurements in this page · ${matching} linked to displayed executions · ${measured.total} retained in total.${measured.after > 0 || measured.more ? " Other pages are not loaded." : ""}${measured.projection?.has_pending ? " Newer measurements pending." : ""}`
      : "No measurement page loaded.";
    if (measured?.loading)
      status.textContent = measured.total === null
        ? "Loading measured program evidence…"
        : `Loading next measurement page… ${status.textContent}`;
    node.append(status);
    if (measured?.error) {
      const error = document.createElement("p");
      error.className = "error";
      error.setAttribute("role", "alert");
      error.textContent = `Measured evidence unavailable: ${measured.error}${measured.total !== null ? " · Displayed measurements are from the previously loaded page." : ""}`;
      node.append(error);
    }
    if (measured?.omissions.length) {
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      details.dataset.record = "measurement-omissions";
      summary.dataset.key = details.dataset.record;
      summary.textContent = `${measured.omissions.length} explicit measurement omission${measured.omissions.length === 1 ? "" : "s"} in this page`;
      details.append(summary);
      pre(details, measured.omissions);
      node.append(details);
    }
    const paging = document.createElement("div");
    paging.className = "button-row";
    const reload = document.createElement("button");
    reload.type = "button";
    reload.id = reload.dataset.key = "measurements-refresh";
    reload.textContent = measured?.loading && measured.total === null
      ? "Refreshing measured evidence…"
      : "Refresh measured evidence";
    reload.disabled = !!measured?.loading;
    reload.addEventListener("click", () => void loadMeasurements(run.run_id));
    const next = document.createElement("button");
    next.type = "button";
    next.id = next.dataset.key = "measurements-next";
    next.textContent = measured?.loading && measured.total !== null
      ? "Loading…"
      : "Next measurement page";
    next.disabled = !measured?.more || measured.loading;
    next.addEventListener("click", () => void loadMeasurements(run.run_id, true));
    paging.append(reload, next);
    node.append(paging);
    if (!run.executions.length)
      paragraph(node, "No skill executions admitted in this run.");
    for (const execution of [...run.executions].reverse())
      inspector.executionDetails(node, execution, run);
    if (run.action) {
      sectionHeading(node, "Latest linked leaf action");
      pre(node, run.action);
    }
  } else if (evidenceTab === "revisions") {
    paragraph(
      node,
      "Immutable versions are shown with exact parent and dependency links. A newer version is not evidence of improved gameplay.",
      "muted",
    );
    if (!run.skills.length && !run.policies.length)
      paragraph(node, "No program revisions recorded.");
    for (const skill of [...run.skills].sort(
      (a, b) => a.skill_id.localeCompare(b.skill_id) || b.version - a.version,
    ))
      recordButton(
        node,
        `${skill.name} · v${skill.version}`,
        `Parent ${skill.parent_version === null ? "none" : `v${skill.parent_version}`} · ${when(skill.created_at)} · SHA ${skill.hash}`,
        `revision:${skill.skill_id}:${skill.version}`,
        () => inspector.showSource(skill, run),
      );
    for (const policy of run.policies)
      recordButton(
        node,
        `${policy.name} · v${policy.version}`,
        `Reaction · ${policy.backend} · SHA ${policy.hash}`,
        `revision:${policy.policy_id}:${policy.version}`,
        () => inspector.showSource(policy, run),
      );
  } else if (evidenceTab === "usage") usageTable(node, run);
  for (const details of node.querySelectorAll<HTMLDetailsElement>("details"))
    details.open = openDetails.has(details.dataset.record);
  node.scrollTop = scroll;
  if (focused)
    node
      .querySelector<HTMLElement>(`[data-key="${CSS.escape(focused)}"]`)
      ?.focus({ preventScroll: true });
}
function setEvidenceTab(name: string, focus = false): void {
  evidenceTab = name;
  for (const tab of document.querySelectorAll<HTMLButtonElement>(
    ".evidence-tabs [role=tab]",
  )) {
    const selected = tab.id === `${name}-tab`;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && focus) tab.focus();
  }
  el("evidence-content").setAttribute("aria-labelledby", `${name}-tab`);
  renderEvidence(true);
  const run = selectedRun ?? snapshot?.run;
  if (run && ["programs", "executions", "revisions"].includes(name) &&
    !measuredEvidence.has(run.run_id)) void loadMeasurements(run.run_id);
  if (run && name === "activity" && !archivedEvents.has(run.run_id))
    void loadEventPage(run.run_id);
}
function openEvidence(name: string, run: RunView | null = null): void {
  selectedRun = run;
  openDialog("evidence-dialog");
  setEvidenceTab(name);
}
async function refresh(): Promise<void> {
  if (!serviceReady) return;
  if (fetching) {
    refreshAgain = true;
    return;
  }
  fetching = true;
  const current = generation;
  try {
    const next = await fetchState();
    if (current === generation) render(next);
  } catch (error) {
    if (current === generation) {
      serviceReady = false;
      stream?.close();
      text("connection", "State unavailable · reconnect required");
      errorText(
        "request-error",
        `${message(error)} Displayed evidence may be stale.`,
      );
      buttons();
    }
  } finally {
    fetching = false;
    if (refreshAgain) {
      refreshAgain = false;
      scheduleRefresh();
    }
  }
}
function scheduleRefresh(): void {
  if (!refreshTimer)
    refreshTimer = window.setTimeout(() => {
      refreshTimer = 0;
      void refresh();
    }, 180);
}
async function command(
  id: string,
  operation: () => Promise<void>,
): Promise<void> {
  if (!canOperate(id)) return;
  pending.add(id);
  errorText("request-error", null);
  errorText("settings-error", null);
  buttons();
  try {
    await operation();
    await refresh();
  } catch (error) {
    errorText("request-error", message(error));
    if (el<HTMLDialogElement>("settings-dialog").open)
      errorText("settings-error", message(error));
    scheduleRefresh();
  } finally {
    pending.delete(id);
    buttons();
  }
}
async function bootstrap(): Promise<void> {
  const current = ++generation;
  stream?.close();
  survivalAgent.disconnect();
  video.disconnect();
  serviceReady = false;
  buttons();
  el<HTMLButtonElement>("reconnect").disabled = true;
  text("connection", "Connecting to local service…");
  errorText("request-error", null);
  try {
    await openSession();
    if (current !== generation) return;
    survivalAgent.connect();
    const next = await fetchState();
    if (current !== generation) return;
    serviceReady = true;
    render(next);
    if (!survivalAgent.visible) video.connect();
    const source = new EventSource("/v1/events", { withCredentials: true });
    stream = source;
    source.onopen = () => {
      if (current !== generation) return;
      text("connection", "Local service connected");
      scheduleRefresh();
    };
    source.onerror = () => {
      if (current !== generation) return;
      text("connection", "Live updates interrupted");
      errorText(
        "request-error",
        "Live updates interrupted. Displayed state may be stale; reconnect to inspect authority. Stop remains available through the authenticated service.",
      );
    };
    const activity = (event: MessageEvent<string>): void => {
      if (current !== generation) return;
      try {
        const parsed = eventSchema.safeParse(JSON.parse(event.data));
        if (parsed.success) mergeEvents([parsed.data]);
        else
          errorText(
            "request-error",
            "Unreadable activity received. Reconnect to inspect state.",
          );
      } catch {
        errorText(
          "request-error",
          "Unreadable activity received. Reconnect to inspect state.",
        );
      }
      scheduleRefresh();
    };
    source.onmessage = activity;
    source.addEventListener("activity", activity as EventListener);
    source.addEventListener("changed", scheduleRefresh);
  } catch (error) {
    if (current === generation) {
      text("connection", "Local service unavailable");
      errorText("request-error", message(error));
    }
  } finally {
    if (current === generation) {
      el<HTMLButtonElement>("reconnect").disabled = false;
      buttons();
    }
  }
}
async function loadJev(): Promise<void> {
  try {
    const status = await fetchJev();
    text(
      "jev-status",
      status.configured
        ? `Key configured · ${status.state}. ${status.selection ? `TypeSafe judge ${status.selection.model_id} · request deadline ${status.selection.request_timeout_ms} ms.` : "No local judge selection."} Broker limits: ${status.limits.max_concurrent} concurrent / ${status.limits.requests_per_minute} requests per minute / ${status.limits.max_request_ms} ms maximum. Connectivity and entitlement are not established by a saved key.`
        : `Jev ${status.state}; no judge selected. JavaScript mode remains available. A saved key would establish local configuration only, not connectivity or entitlement.`,
    );
    errorText("jev-error", null);
  } catch (error) {
    text("jev-status", "Jev status unavailable.");
    errorText("jev-error", message(error));
  }
}
function settings(): void {
  openDialog("settings-dialog");
  survivalAgent.check();
  if (serviceReady) {
    void loadJev();
    void loadLibrary();
  }
}
function stopPerformance(): void {
  performanceGeneration++;
  window.clearTimeout(performanceTimer);
  performanceTimer = 0;
  performanceAbort?.abort();
  performanceAbort = null;
}

function renderPerformance(data: PerformanceSnapshot): void {
  const process = el("performance-process");
  process.replaceChildren();
  const backend = data.backend;
  text(
    "performance-window",
    `Sample counts are lifetime totals. Percentiles and maximum use the latest up to ${backend.percentile_window_samples.toLocaleString()} retained samples per measurement, not every lifetime sample. The CPU sample window is separate.`,
  );
  const values = [
    [
      "Backend CPU",
      backend.cpu_percent_of_one_core === null
        ? "Unknown"
        : `${backend.cpu_percent_of_one_core.toFixed(1)}% of one core`,
    ],
    ["Resident memory", `${(backend.rss_bytes / 1048576).toFixed(1)} MiB`],
    [
      "Reported CPU sample window",
      backend.sample_window_ms === null
        ? "Not sampled"
        : `${backend.sample_window_ms.toLocaleString()} ms`,
    ],
  ];
  for (const [name, value] of values) {
    const dt = document.createElement("dt"),
      dd = document.createElement("dd");
    dt.textContent = name!;
    dd.textContent = value!;
    process.append(dt, dd);
  }
  const rows = el("performance-timings");
  rows.replaceChildren();
  const timings = [
    ["Event-loop lag", backend.event_loop_lag_ms],
    ["Observation read", backend.timings.observation_read_ms],
    [
      "Action round trip (includes gameplay)",
      backend.timings.action_round_trip_ms,
    ],
    ["Video forwarding", backend.timings.video_forward_ms],
  ] as const;
  for (const [name, summary] of timings) {
    const row = document.createElement("tr"),
      heading = document.createElement("th");
    heading.scope = "row";
    heading.textContent = name;
    row.append(heading);
    const samples = document.createElement("td");
    samples.textContent = summary.count.toLocaleString();
    row.append(samples);
    for (const value of [summary.p50, summary.p95, summary.p99, summary.max]) {
      const cell = document.createElement("td");
      cell.textContent =
        summary.count === 0
          ? "Not sampled"
          : value === null
            ? "Unknown"
            : value.toFixed(2);
      row.append(cell);
    }
    rows.append(row);
  }
  const video = data.video;
  text(
    "performance-video",
    `${label(video.status)} · ${video.width} × ${video.height} · ${video.fps === null ? "unknown" : video.fps.toFixed(1)} reported native fps · ${video.frames.toLocaleString()} frames · last frame ${when(video.last_frame_at)}${video.error ? ` · ${video.error}` : ""}`,
  );
  text(
    "performance-native",
    data.native === null
      ? "Native diagnostics unavailable. No native measurements reported."
      : json(data.native),
  );
  text("performance-transport", json(data.video_transport));
}

async function pollPerformance(current: number): Promise<void> {
  if (
    current !== performanceGeneration ||
    !el<HTMLDialogElement>("performance-dialog").open
  )
    return;
  const delay = 1000 - (performance.now() - performanceLastStarted);
  if (delay > 0) {
    performanceTimer = window.setTimeout(
      () => void pollPerformance(current),
      delay,
    );
    return;
  }
  performanceLastStarted = performance.now();
  const controller = new AbortController();
  performanceAbort = controller;
  try {
    const data = await fetchPerformance(controller.signal);
    if (
      current !== performanceGeneration ||
      !el<HTMLDialogElement>("performance-dialog").open
    )
      return;
    renderPerformance(data);
    text(
      "performance-status",
      `Measured snapshot received ${when(new Date().toISOString())}. Requests run no more than once per second while this dialog is open.`,
    );
    errorText("performance-error", null);
  } catch (error) {
    if (current !== performanceGeneration || controller.signal.aborted) return;
    text(
      "performance-status",
      "Diagnostics unavailable. Any displayed snapshot is retained, not current.",
    );
    errorText("performance-error", message(error));
  } finally {
    if (performanceAbort === controller) performanceAbort = null;
    if (
      current === performanceGeneration &&
      el<HTMLDialogElement>("performance-dialog").open
    ) {
      performanceTimer = window.setTimeout(
        () => void pollPerformance(current),
        1000,
      );
    }
  }
}

function click(id: string, handler: () => void): void {
  el(id).addEventListener("click", handler);
}
for (const id of ["settings-open", "viewer-settings", "new-task"])
  click(id, settings);
click("performance-open", () => {
  stopPerformance();
  text("performance-status", "Loading measured diagnostics…");
  errorText("performance-error", null);
  el("performance-process").replaceChildren();
  el("performance-timings").replaceChildren();
  text("performance-window", "Distribution window not loaded.");
  text("performance-video", "No measured video state loaded.");
  text("performance-browser", browserVideoDetail);
  text("performance-native", "Not loaded.");
  text("performance-transport", "Not loaded.");
  openDialog("performance-dialog");
  void pollPerformance(performanceGeneration);
});
click("reconnect", () => void bootstrap());
click("video-reconnect", () => {
  if (serviceReady) video.connect();
  else void bootstrap();
});
click("sidebar-toggle", () => {
  const panel = el("context-panel"),
    hide = !panel.hidden;
  panel.hidden = hide;
  el("work-area").classList.toggle("panel-hidden", hide);
  text("sidebar-toggle", hide ? "Show panel" : "Hide panel");
  el("sidebar-toggle").setAttribute("aria-expanded", String(!hide));
});
for (const name of ["programs", "activity", "usage", "inventory", "life"])
  click(`${name}-open`, () => openEvidence(name));
click("goal-more", () => {
  openEvidence("programs");
  const content = el("evidence-content");
  content.scrollTop = 0;
  content.querySelector<HTMLElement>(".evidence-task")?.focus({ preventScroll: true });
});
click("history-open", () => {
  openDialog("history-dialog");
  text("history-status", "Loading retained runs…");
  el("history-list").replaceChildren();
  void fetchHistory()
    .then((runs) => {
      text(
        "history-status",
        runs.length
          ? `${runs.length} retained runs, latest first.`
          : "No retained runs. Create a task in Settings.",
      );
      for (const run of runs) {
        const li = document.createElement("li");
        recordButton(
          li,
          run.task,
          `${operatorLabel(run.operator.state, run.operator.completion)} · ${run.model_id} · ${when(run.started_at)} · ${run.run_id}`,
          run.run_id,
          () => openEvidence("programs", run),
        );
        el("history-list").append(li);
      }
    })
    .catch((error) => text("history-status", message(error)));
});
for (const name of [
  "programs",
  "executions",
  "revisions",
  "trace",
  "comparison",
  "learning",
  "life",
  "planning",
  "usage",
  "activity",
  "inventory",
]) {
  click(`${name}-tab`, () => setEvidenceTab(name));
  el(`${name}-tab`).addEventListener("keydown", (event) => {
    const names = [
        "programs",
        "executions",
        "revisions",
        "trace",
        "comparison",
        "learning",
        "life",
        "planning",
        "usage",
        "activity",
        "inventory",
      ],
      index = names.indexOf(name);
    let next: number | null = null;
    if (event.key === "ArrowRight") next = (index + 1) % names.length;
    if (event.key === "ArrowLeft")
      next = (index + names.length - 1) % names.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = names.length - 1;
    if (next !== null) {
      event.preventDefault();
      setEvidenceTab(names[next]!, true);
    }
  });
}
for (const mode of ["browser", "device"] as const)
  click(
    `login-${mode}`,
    () =>
      void command(`login-${mode}`, () => mutate("/v1/auth/login", { mode })),
  );
click(
  "refresh-models",
  () => void command("refresh-models", () => mutate("/v1/auth/refresh")),
);
click("logout", () => void command("logout", () => mutate("/v1/auth/logout")));
click("cancel-login", () => {
  if (snapshot?.auth.login)
    void command("cancel-login", () =>
      mutate("/v1/auth/cancel", { login_id: snapshot!.auth.login!.id }),
    );
});
el("auth-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const login = snapshot?.auth.login;
  if (!login?.prompt || (!login.prompt.allow_empty && !authInput.value)) return;
  const value = authInput.value;
  authInput.value = "";
  void command("auth-submit", () =>
    mutate("/v1/auth/input", { login_id: login.id, value }),
  );
});
click(
  "prepare-game",
  () =>
    void command("prepare-game", () =>
      mutate("/v1/game/prepare", {
        accept_eula:
          !!snapshot?.server.eula_accepted ||
          el<HTMLInputElement>("eula").checked,
      }),
    ),
);
click(
  "start-game",
  () => void command("start-game", () => mutate("/v1/game/start")),
);
click(
  "stop-game",
  () => void command("stop-game", () => mutate("/v1/game/stop")),
);
click("new-world", () => {
  if (el<HTMLInputElement>("confirm-world").checked)
    void command("new-world", async () => {
      await mutate("/v1/game/new-world", { confirm: true });
      el<HTMLInputElement>("confirm-world").checked = false;
    });
});
for (const id of ["eula", "confirm-world"])
  el(id).addEventListener("change", buttons);
task.addEventListener("input", () => {
  if (snapshot?.goals.length) goal.value = editTaskPrompt(task.value, snapshot.goals).choice_id;
  renderTaskCondition();
  buttons();
});
model.addEventListener("change", () => {
  buttons();
  void loadLibrary();
});
goal.addEventListener("change", () => {
  if (snapshot) task.value = selectTaskChoice(goal.value, task.value, snapshot.goals).task;
  renderTaskCondition();
  buttons();
});
click("use-goal", () => {
  if (snapshot) task.value = selectTaskChoice(goal.value, task.value, snapshot.goals).task;
  task.focus();
  buttons();
});
async function startPreparedTask(): Promise<void> {
  if (el<HTMLButtonElement>("prepare-play").disabled || !snapshot) return;
  await command("prepare-play", async () => {
    if (!snapshot) throw new Error("No current service state.");
    if (!preparationAttempt) {
      const submission = taskSubmission({ choice_id: goal.value, task: task.value }, snapshot.goals);
      preparationAttempt = {
        request: preparedStartRequestSchema.parse({ ...submission, request_id: crypto.randomUUID(), model_id: model.value }),
        previousId: snapshot.prepared_start?.preparation_id ?? null,
      };
    }
    const request = preparationAttempt.request;
    preparationOutcomeUnknown = false;
    libraryGeneration++;
    render(snapshot);
    try {
      const preparation = await prepareAndPlay(request);
      preparationAttempt = null;
      preparationOutcomeUnknown = false;
      if (snapshot)
        render({ ...snapshot, prepared_start: snapshot.prepared_start?.preparation_id === preparation.preparation_id
          ? snapshot.prepared_start : preparation });
      el<HTMLDialogElement>("settings-dialog").close();
    } catch (error) {
      if (preparationAttempt) {
        if (error instanceof ApiError && error.status >= 400 && error.code !== "invalid_response")
          preparationAttempt = null;
        else preparationOutcomeUnknown = true;
      }
      if (snapshot) render(snapshot);
      throw error;
    }
  });
  if (!el<HTMLDialogElement>("settings-dialog").open) {
    const cancel = el<HTMLButtonElement>("cancel-preparation");
    (cancel.hidden || cancel.disabled ? el("run-controls") : cancel).focus({ preventScroll: true });
  }
}
for (const id of ["cancel-preparation", "cancel-preparation-settings"])
  click(id, () => {
    const preparation = snapshot?.prepared_start;
    if (!preparation || el<HTMLButtonElement>(id).disabled || !preparationCancellation(preparation).available) return;
    void command("cancel-preparation", async () => {
      const closed = await cancelPreparation(preparation.preparation_id);
      if (snapshot?.prepared_start?.preparation_id === preparation.preparation_id)
        render({ ...snapshot, prepared_start: closed });
    });
  });
el("task-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!el<HTMLButtonElement>("prepare-play").hidden) {
    void startPreparedTask();
    return;
  }
  if (el<HTMLButtonElement>("create-run").disabled) return;
  void command("create-run", async () => {
    const experienceId = el<HTMLSelectElement>("experience").value;
    if (!snapshot) throw new Error("No currently negotiated adapter");
    const submission = taskSubmission({ choice_id: goal.value, task: task.value }, snapshot.goals);
    const run = await createRun({
      ...submission,
      model_id: model.value,
      working_programs: el<HTMLSelectElement>("working-programs").value === "fresh" ? "fresh" : "continue",
      ...(experienceId ? { experience_id: experienceId } : {}),
    });
    if (snapshot) render({ ...snapshot, run });
    el<HTMLDialogElement>("settings-dialog").close();
  }).then(() => {
    if (snapshot?.run?.status === "created") el("start-run").focus();
  });
});
for (const control of ["start", "pause", "resume", "stop"] as const)
  click(`${control}-run`, () => {
    const run = snapshot?.run;
    if (!run) return;
    const button = el<HTMLButtonElement>(`${control}-run`),
      focused = document.activeElement === button;
    void command(`${control}-run`, () =>
      mutate(`/v1/runs/${encodeURIComponent(run.run_id)}/controls`, {
        command: control,
        request_id: crypto.randomUUID(),
      }),
    ).then(() => {
      if (!focused) return;
      const status = snapshot?.run?.status,
        next = el<HTMLButtonElement>(
          status === "paused"
            ? "resume-run"
            : status === "created"
              ? "start-run"
              : ["running", "bootstrapping"].includes(status ?? "")
                ? "pause-run"
                : "stop-run",
        );
      if (!next.disabled && !next.hidden) next.focus({ preventScroll: true });
      else el("run-controls").focus({ preventScroll: true });
    });
  });
el<HTMLInputElement>("jev-key").addEventListener("input", buttons);
el("jev-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (el<HTMLButtonElement>("jev-save").disabled) return;
  const input = el<HTMLInputElement>("jev-key"),
    key = input.value;
  input.value = "";
  void command("jev-save", async () => {
    await setJevKey(key);
    await loadJev();
  });
});
click(
  "jev-remove",
  () =>
    void command("jev-remove", async () => {
      await removeJevKey();
      el<HTMLInputElement>("jev-key").value = "";
      await loadJev();
    }),
);
click("library-refresh", () => void loadLibrary());
el("motor-profile").addEventListener("change", () => {
  const current = minecraftMotorProfile(snapshot);
  motorEdited = current !== null && el<HTMLSelectElement>("motor-profile").value !== current;
  text("motor-status", `Current materialized profile: ${current ?? "unsupported"}.${motorEdited ? " Selection not applied." : " Selected profile is current."}`);
  buttons();
});
click("motor-save", () => {
  const profile = el<HTMLSelectElement>("motor-profile").value;
  void command("motor-save", async () => {
    await mutate("/v1/config", { motor_profile: profile });
    motorEdited = false;
  });
});
el("experience").addEventListener("change", librarySelection);
click("promotion-more", () => {
  if (promotion) void loadEventPage(promotion.run.run_id);
});
el("promotion-evidence").addEventListener("change", renderPromotionEvent);
for (const id of [
  "promotion-scope",
  "promotion-world-data",
  "promotion-item",
  "promotion-gain",
])
  el(id).addEventListener("change", promotionButtons);
el("promotion-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!promotion || el<HTMLButtonElement>("promotion-save").disabled) return;
  const scope = el<HTMLSelectElement>("promotion-scope").value;
  const retained = el<HTMLSelectElement>("promotion-world-data").value;
  const evidence = archivedEvents
    .get(promotion.run.run_id)
    ?.events.find(
      (item) =>
        String(item.event_seq) ===
        el<HTMLSelectElement>("promotion-evidence").value,
    );
  if (
    (scope !== "portable" && scope !== "world_local") ||
    !["yes", "no"].includes(retained) ||
    !evidence
  )
    return;
  const item = el<HTMLSelectElement>("promotion-item").value;
  const minGain = Number(el<HTMLInputElement>("promotion-gain").value);
  const archive = archivedEvents.get(promotion.run.run_id);
  const candidate = promotionEvidence(evidence, promotion.run, promotion.execution,
    (archive?.events ?? []).filter(record => !archive?.omitted.includes(record.event_seq)));
  if (!candidate) return;
  if (
    candidate.kind === "inventory_gain" &&
    (!item || !(item in candidate.counts) || !Number.isSafeInteger(minGain) || minGain < 1)
  )
    return;
  const declaration: PromotionDeclaration = {
    portability: scope,
    retained_world_data: retained === "yes",
    predicate:
      candidate.kind === "goal_verified"
        ? { kind: "goal_verified", event_seq: evidence.event_seq }
        : {
            kind: "inventory_gain",
            item,
            min_gain: minGain,
            event_seq: evidence.event_seq,
          },
  };
  const target = promotion;
  void command("promotion-save", async () => {
    errorText("promotion-error", null);
    text(
      "promotion-result",
      "Checking trusted attribution and immutable dependencies…",
    );
    try {
      const saved = await promoteExperience(
        target.run.run_id,
        target.execution.execution_id,
        el<HTMLInputElement>("promotion-name").value.trim(),
        declaration,
      );
      text(
        "promotion-result",
        `Saved exact bundle ${saved.name} · ${label(saved.portability)} · ${saved.experience_id}. Predicate verified by the service, not inferred from program status.`,
      );
      await loadMeasurements(target.run.run_id);
      if (model.value === saved.model_id) await loadLibrary();
    } catch (error) {
      text("promotion-result", "Not saved.");
      errorText("promotion-error", message(error));
      throw error;
    }
  });
});
for (const link of document.querySelectorAll<HTMLAnchorElement>(
  'a[href^="/licenses/"]',
))
  link.addEventListener("click", (event) => {
    event.preventDefault();
    void fetch(link.pathname, { credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Font license could not be loaded.");
        const license = await response.text();
        text("source-title", link.textContent ?? "Font license");
        text("source-meta", "Bundled font license");
        el("strategy-card").replaceChildren();
        text("source-code", license);
        text("source-evidence", "Font license text; no program was executed.");
        openDialog("source-dialog");
      })
      .catch((error) => errorText("settings-error", message(error)));
  });
window.addEventListener("pagehide", () => {
  ++generation;
  survivalAgent.disconnect();
  stream?.close();
  video.disconnect();
  window.clearTimeout(preparationTimer);
  stopPerformance();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) void bootstrap();
});
buttons();
void bootstrap();
