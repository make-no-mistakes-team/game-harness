import "@fontsource/jura/latin-500.css";
import "@fontsource/jura/latin-700.css";
import "@fontsource/jura/cyrillic-500.css";
import "@fontsource/jura/cyrillic-700.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "@fontsource/ibm-plex-mono/cyrillic-400.css";
import "@fontsource/ibm-plex-mono/cyrillic-500.css";
import "./styles.css";
import type {
  ActivityEvent,
  AppSnapshot,
  PolicyView,
  RunView,
} from "../../src/shared/contracts.ts";
import {
  ApiError,
  createRun,
  eventSchema,
  fetchState,
  mutate,
  openSession,
} from "./api.ts";

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("Application mount is missing.");
root.innerHTML = `
  <a class="skip-link" href="#run-controls">Skip to run controls</a>
  <main class="workspace">
    <header class="workspace-header">
      <h1>GameHarness</h1>
      <div class="header-state"><span id="connection" role="status">Connecting to local service…</span><button id="reconnect" type="button">Reconnect</button><button id="setup-toggle" type="button" aria-expanded="true" aria-controls="setup">Setup</button></div>
    </header>
    <div class="readiness" aria-label="Service readiness"><span id="auth-status">OpenAI · unknown</span><span id="server-status">World · unknown</span><span id="sandbox-status">Isolation · unknown</span></div>
    <div class="notice error" id="request-error" role="alert" hidden></div>
    <section class="setup" id="setup" aria-label="Connection and world setup">
      <section class="setup-section" aria-labelledby="account-heading">
        <h2 id="account-heading">OpenAI connection</h2>
        <p id="account-description">Connect your own account to discover available models.</p>
        <div class="button-row"><button id="login-browser" type="button">Connect in browser</button><button id="login-device" type="button">Use device code</button><button id="refresh-models" type="button" hidden>Refresh models</button><button id="logout" type="button" hidden>Disconnect account</button></div>
        <div id="login-flow" hidden>
          <p class="instructions" id="login-instructions"></p>
          <a class="button primary" id="authorize-link" target="_blank" rel="noopener noreferrer" hidden>Continue in browser</a>
          <p class="muted" id="authorization-wait">Waiting for provider authorization. This page does not complete login for you.</p>
          <form id="auth-form" hidden><label id="auth-input-label" for="auth-input">Authorization response</label><div class="input-row"><input id="auth-input" type="text" autocomplete="off" spellcheck="false" maxlength="16000"><button id="auth-submit" type="submit">Submit response</button></div></form>
          <button id="cancel-login" type="button">Cancel authorization</button>
        </div>
        <p id="auth-error" class="error" role="alert" hidden></p>
      </section>
      <section class="setup-section" aria-labelledby="world-heading">
        <h2 id="world-heading">Local Minecraft world</h2>
        <p id="world-description">Waiting for the local server state.</p>
        <label class="check-row" id="eula-row" hidden><input id="eula" type="checkbox"><span>I accept the <a href="https://www.minecraft.net/eula" target="_blank" rel="noopener noreferrer">Minecraft EULA</a> for this local server.</span></label>
        <div class="button-row"><button id="prepare-game" type="button">Prepare server</button><button id="start-game" type="button">Start world</button><button id="stop-game" type="button">Stop world</button></div>
        <details id="new-world-details"><summary>World management</summary><p>New world replaces the current world lineage. Existing runs remain recorded. Stop the run and world first.</p><label class="check-row"><input id="confirm-world" type="checkbox"><span>Replace the current world with a new world.</span></label><button id="new-world" class="danger" type="button">Create new world</button></details>
        <p id="game-error" class="error" role="alert" hidden></p><p id="sandbox-error" class="error" role="alert" hidden></p>
      </section>
    </section>
    <div class="console-layout">
      <div class="play-stack">
        <section class="run-toolbar" id="run-controls" aria-labelledby="run-heading" tabindex="-1">
          <div class="run-control-state"><h2 id="run-heading">Run controls</h2><span id="run-status" class="state" role="status">No run</span></div>
          <div class="button-row" role="group" aria-label="Run actions"><button id="start-run" class="primary" type="button">Start</button><button id="pause-run" type="button">Pause</button><button id="resume-run" class="primary" type="button" hidden>Resume</button><button id="stop-run" class="danger" type="button">Stop run</button></div>
        </section>
        <section class="game-console" aria-labelledby="view-heading">
          <div class="console-topline"><h2 id="view-heading">Minecraft <span class="muted">/ player view</span></h2><span id="view-status" class="state">Not connected</span></div>
          <div class="viewer" id="viewer">
            <div class="viewer-empty" id="viewer-empty"><h3 id="viewer-empty-title">No game connection</h3><p id="viewer-empty-copy">Start the local world in Setup to connect the player and renderer.</p><p id="viewer-interrupted-action" hidden></p><p id="viewer-recovery-hint" hidden></p><button id="open-setup" type="button">Open setup</button></div>
          </div>
          <div class="viewer-foot"><span id="viewer-note">Live view unavailable until the game connects.</span><button id="reload-viewer" type="button" hidden>Reload view</button></div>
          <div class="player-strip" id="player-strip"><span id="player-vitals">Player state unavailable</span><span id="player-position"></span><span id="observation-time"></span></div>
        </section>
        <section class="run-console" aria-labelledby="task-heading">
          <div class="section-heading"><h2 id="task-heading">Task and model</h2></div>
          <form id="task-form">
            <div class="task-options"><div class="field"><label for="goal">Goal</label><select id="goal" required><option value="">Waiting for goals</option></select></div><div class="field model-field"><label for="model">Strategic model</label><select id="model" required><option value="">Connect OpenAI first</option></select></div></div>
            <div class="task-label"><label for="task">Task</label><button id="use-goal" class="text-button" type="button">Use goal prompt</button></div>
            <textarea id="task" rows="3" maxlength="8000" placeholder="Describe what the agent should do in this world." required></textarea>
            <div class="run-actions"><button id="create-run" type="submit">Create run</button></div>
          </form>
          <p id="run-hint" class="muted">Connect an account and start the world to create a run.</p>
          <p id="run-error" class="error" role="alert" hidden></p>
          <div class="current-run" id="current-run" hidden><p id="current-task"></p><dl class="run-facts"><div><dt>Model</dt><dd id="current-model"></dd></div><div><dt>Strategist</dt><dd id="model-status"></dd></div><div><dt>Turns</dt><dd id="turns"></dd></div><div><dt>Tokens · in / out</dt><dd id="tokens"></dd></div><div><dt>Cost</dt><dd id="cost"></dd></div></dl><p class="action-summary" id="action-summary"></p><details><summary>Run / action evidence</summary><pre id="run-evidence" tabindex="0"></pre></details></div>
        </section>
        <details class="inventory"><summary>Player inventory <span id="inventory-count"></span></summary><p id="inventory-empty">Inventory is unavailable until the player connects.</p><ul id="inventory-items"></ul></details>
      </div>
      <aside class="tool-bay" aria-label="Activity and policy evidence">
        <div class="bay-tabs" role="tablist" aria-label="Evidence type"><button type="button" id="activity-tab" role="tab" aria-selected="true" aria-controls="activity-panel" tabindex="0">Activity</button><button type="button" id="policies-tab" role="tab" aria-selected="false" aria-controls="policies-panel" tabindex="-1">Policies <span id="policy-count">0</span></button></div>
        <div class="follow-bar"><span id="follow-state">Following live activity</span><button id="resume-live" type="button" hidden>Resume live</button></div>
        <section id="activity-panel" role="tabpanel" aria-labelledby="activity-tab">
          <p class="bay-empty" id="activity-empty">No recorded activity yet. Setup and run events will appear here.</p>
          <ol id="activity-list" class="activity-list" aria-label="Recorded activity"></ol>
          <section class="evidence" id="event-evidence" hidden aria-labelledby="event-evidence-heading"><h3 id="event-evidence-heading">Event evidence</h3><p id="event-summary"></p><pre id="event-details" tabindex="0"></pre></section>
        </section>
        <section id="policies-panel" role="tabpanel" aria-labelledby="policies-tab" hidden>
          <p class="bay-empty" id="policies-empty">No model-authored policies in this run. Authored source, strategy cards, and effects appear here when registered.</p>
          <ul id="policy-list" class="policy-list"></ul>
          <section id="policy-evidence" class="evidence" hidden aria-labelledby="policy-name"><h3 id="policy-name"></h3><p id="policy-meta" class="mono"></p><p id="policy-error" class="error" hidden></p><dl id="strategy-card" class="strategy-card"></dl><details open><summary>Immutable policy source</summary><pre tabindex="0"><code id="policy-source"></code></pre></details></section>
        </section>
      </aside>
    </div>
    <footer><span>Local operator workspace · Minecraft Java 1.21.4</span><details><summary>Font licenses</summary><span>Jura and IBM Plex Mono are distributed under the SIL Open Font License 1.1. </span><a href="/licenses/Jura-LICENSE.txt" target="_blank" rel="noopener">Jura license</a> · <a href="/licenses/IBM-Plex-Mono-LICENSE.txt" target="_blank" rel="noopener">IBM Plex Mono license</a></details></footer>
  </main>`;

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing interface element: ${id}`);
  return node as T;
}
function text(id: string, value: string): void {
  const node = element(id);
  if (node.textContent !== value) node.textContent = value;
}
function hidden(id: string, value: boolean): void {
  element(id).hidden = value;
}
function errorText(id: string, value: string | null): void {
  text(id, value ?? "");
  hidden(id, !value);
}
function label(value: string): string {
  return value.replaceAll("_", " ");
}
function when(value: string | null): string {
  if (!value) return "unknown";
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "unknown time"
    : date.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
}
function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
const task = element<HTMLTextAreaElement>("task");
const goal = element<HTMLSelectElement>("goal");
const model = element<HTMLSelectElement>("model");
const authInput = element<HTMLInputElement>("auth-input");
let snapshot: AppSnapshot | null = null;
let serviceReady = false;
const pendingCommands = new Set<string>();
let eventStream: EventSource | null = null;
let refreshTimer: number | null = null;
let fetching = false;
let refreshAgain = false;
let bootstrapGeneration = 0;
let taskEdited = false;
let setupTouched = false;
let setupInitialized = false;
let followLive = true;
let selectedEvent: ActivityEvent | null = null;
let selectedPolicy: PolicyView | null = null;
let activeTab: "activity" | "policies" = "activity";
let promptIdentity = "";
let viewerUrl: string | null = null;
let viewerFrame: HTMLIFrameElement | null = null;
const events = new Map<string, ActivityEvent>();
const eventRows = new Map<string, HTMLLIElement>();
const policyRows = new Map<string, HTMLLIElement>();
let goalSignature = "";
let modelSignature = "";
const streamFailure =
  "Live activity is unavailable. Displayed state may be stale; reconnect to refresh the local session.";

function setSetup(open: boolean): void {
  hidden("setup", !open);
  element("setup-toggle").setAttribute("aria-expanded", String(open));
}
function setTab(tab: "activity" | "policies", focus = false): void {
  activeTab = tab;
  for (const name of ["activity", "policies"] as const) {
    const button = element<HTMLButtonElement>(`${name}-tab`);
    button.setAttribute("aria-selected", String(name === tab));
    button.tabIndex = name === tab ? 0 : -1;
    hidden(`${name}-panel`, name !== tab);
    if (name === tab && focus) button.focus();
  }
}
function eventKey(event: ActivityEvent): string {
  return `${event.run_id ?? "system"}:${event.event_seq}`;
}
function policyKey(policy: PolicyView): string {
  return `${policy.policy_id}:${policy.version}`;
}
function selectEvidence(): void {
  text(
    "follow-state",
    followLive
      ? "Following live activity"
      : "Evidence selected · live follow paused",
  );
  hidden("resume-live", followLive);
  for (const [key, row] of eventRows)
    row
      .querySelector("button")
      ?.setAttribute(
        "aria-pressed",
        String(selectedEvent !== null && key === eventKey(selectedEvent)),
      );
  hidden("event-evidence", !selectedEvent);
  if (selectedEvent) {
    text("event-summary", selectedEvent.summary);
    text("event-details", json(selectedEvent));
  }
  for (const [key, row] of policyRows)
    row
      .querySelector("button")
      ?.setAttribute(
        "aria-pressed",
        String(selectedPolicy !== null && key === policyKey(selectedPolicy)),
      );
  hidden("policy-evidence", !selectedPolicy);
  if (selectedPolicy) {
    text("policy-name", selectedPolicy.name);
    text(
      "policy-meta",
      `${label(selectedPolicy.state)} · v${selectedPolicy.version}\n${selectedPolicy.policy_id}\nSHA ${selectedPolicy.hash}\n${selectedPolicy.evaluations} evaluations · ${selectedPolicy.effects} effects\n${selectedPolicy.interval_ms} ms interval · priority ${selectedPolicy.priority}`,
    );
    errorText("policy-error", selectedPolicy.last_error);
    const card = element("strategy-card");
    for (const [key, value] of Object.entries(selectedPolicy.card)) {
      let dd = card.querySelector<HTMLElement>(`[data-card="${key}"]`);
      if (!dd) {
        const dt = document.createElement("dt");
        dt.textContent = label(key);
        dd = document.createElement("dd");
        dd.dataset.card = key;
        card.append(dt, dd);
      }
      if (dd.textContent !== value) dd.textContent = value;
    }
    text("policy-source", selectedPolicy.source);
  }
}
function mergeEvents(incoming: ActivityEvent[]): void {
  for (const event of incoming) events.set(eventKey(event), event);
  const ordered = [...events.values()]
    .sort((a, b) => a.at.localeCompare(b.at) || a.event_seq - b.event_seq)
    .slice(-200);
  const keys = new Set(ordered.map(eventKey));
  for (const key of events.keys()) if (!keys.has(key)) events.delete(key);
  for (const [key, row] of eventRows)
    if (!keys.has(key)) {
      row.remove();
      eventRows.delete(key);
    }
  const list = element("activity-list");
  for (const event of ordered) {
    const key = eventKey(event);
    let row = eventRows.get(key);
    if (!row) {
      row = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "activity-event";
      const meta = document.createElement("span");
      meta.className = "event-meta";
      meta.textContent = `${when(event.at)} · ${label(event.type)}`;
      const summary = document.createElement("span");
      summary.className = "event-summary";
      summary.textContent = event.summary;
      button.append(meta, summary);
      button.addEventListener("click", () => {
        followLive = false;
        selectedEvent = event;
        selectEvidence();
      });
      row.append(button);
      eventRows.set(key, row);
      list.append(row);
    }
  }
  hidden("activity-empty", ordered.length > 0);
  if (followLive && ordered.length > 0) {
    selectedEvent = ordered[ordered.length - 1]!;
    list.scrollTop = list.scrollHeight;
  }
  selectEvidence();
}
function renderPolicies(run: RunView | null): void {
  const policies = run?.policies ?? [];
  text("policy-count", String(policies.length));
  hidden("policies-empty", policies.length > 0);
  const keys = new Set(policies.map(policyKey));
  for (const [key, row] of policyRows)
    if (!keys.has(key)) {
      row.remove();
      policyRows.delete(key);
    }
  for (const policy of policies) {
    const key = policyKey(policy);
    let row = policyRows.get(key);
    if (!row) {
      row = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.policy = key;
      button.addEventListener("click", () => {
        followLive = false;
        selectedPolicy =
          snapshot?.run?.policies.find((item) => policyKey(item) === key) ??
          policy;
        selectEvidence();
      });
      row.append(button);
      element("policy-list").append(row);
      policyRows.set(key, row);
    }
    const button = row.querySelector("button")!;
    const copy = `${policy.name} · v${policy.version}\n${label(policy.state)} · ${policy.effects} effects`;
    if (button.textContent !== copy) button.textContent = copy;
  }
  if (followLive)
    selectedPolicy =
      policies.find((policy) => policy.state === "active") ??
      policies.at(-1) ??
      null;
  selectEvidence();
}
function renderOptions(state: AppSnapshot): void {
  const nextGoals = json(state.goals.map((item) => [item.id, item.label]));
  if (nextGoals !== goalSignature) {
    goalSignature = nextGoals;
    const selected = goal.value;
    const options = state.goals.map((item) => new Option(item.label, item.id));
    goal.replaceChildren(
      ...(options.length ? options : [new Option("No goals available", "")]),
    );
    if (state.goals.some((item) => item.id === selected)) goal.value = selected;
    if (!taskEdited && !task.value)
      task.value =
        state.goals.find((item) => item.id === goal.value)?.prompt ?? "";
  }
  const nextModels = json(
    state.auth.models.map((item) => [item.id, item.name]),
  );
  if (nextModels !== modelSignature) {
    modelSignature = nextModels;
    const selected = model.value || state.run?.model_id;
    const options = state.auth.models.map(
      (item) => new Option(item.name, item.id),
    );
    model.replaceChildren(
      ...(options.length
        ? options
        : [
            new Option(
              state.auth.authenticated
                ? "No available models"
                : "Connect OpenAI first",
              "",
            ),
          ]),
    );
    if (selected && state.auth.models.some((item) => item.id === selected))
      model.value = selected;
  }
}
function safeExternalUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["127.0.0.1", "localhost"].includes(url.hostname))
      ? url.href
      : null;
  } catch {
    return null;
  }
}
function renderAuth(state: AppSnapshot): void {
  const auth = state.auth;
  text("auth-status", `OpenAI · ${label(auth.status)}`);
  element("auth-status").dataset.ready = String(
    auth.authenticated && auth.models.length > 0,
  );
  text(
    "account-description",
    auth.authenticated
      ? `${auth.account_label ?? "Account connected"} · ${auth.models.length} available ${auth.models.length === 1 ? "model" : "models"}.`
      : auth.status === "authorizing"
        ? "Complete authorization with OpenAI. No credentials are imported from other apps."
        : "Connect your own OpenAI account. Subscription access depends on your account entitlement.",
  );
  hidden("logout", !auth.authenticated);
  hidden("refresh-models", !auth.authenticated);
  hidden("login-flow", !auth.login);
  errorText("auth-error", auth.error);
  const login = auth.login;
  const nextPrompt = login ? `${login.id}:${login.prompt?.label ?? ""}` : "";
  if (nextPrompt !== promptIdentity) {
    authInput.value = "";
    promptIdentity = nextPrompt;
  }
  hidden("auth-form", !login?.prompt);
  if (login) {
    text(
      "login-instructions",
      login.instructions ??
        (login.mode === "device"
          ? "Follow the provider’s device authorization instructions."
          : "Open the provider link to authorize this local application."),
    );
    const url = safeExternalUrl(login.url);
    const link = element<HTMLAnchorElement>("authorize-link");
    hidden("authorize-link", !url);
    if (url && link.href !== url) link.href = url;
    if (!url) link.removeAttribute("href");
    if (login.url && !url)
      errorText(
        "auth-error",
        "The provider returned an unsupported authorization URL. Cancel and retry authorization.",
      );
    if (login.prompt) {
      text("auth-input-label", login.prompt.label);
      const type = login.prompt.secret ? "password" : "text";
      if (authInput.type !== type) authInput.type = type;
      authInput.required = !login.prompt.allow_empty;
    }
  } else {
    element<HTMLAnchorElement>("authorize-link").removeAttribute("href");
    text("login-instructions", "");
  }
}
function renderViewer(state: AppSnapshot): void {
  const game = state.game;
  text("view-status", label(game.status));
  let url: string | null = null;
  if (game.viewer_ready && game.viewer_url) {
    try {
      const candidate = new URL(game.viewer_url);
      if (
        candidate.protocol === "http:" &&
        candidate.hostname === "127.0.0.1" &&
        candidate.pathname === "/viewer/" &&
        !candidate.username &&
        !candidate.password &&
        !candidate.search &&
        !candidate.hash
      )
        url = candidate.href;
    } catch {
      /* Invalid renderer address remains unavailable. */
    }
  }
  if (url !== viewerUrl) {
    viewerFrame?.remove();
    viewerFrame = null;
    viewerUrl = url;
    if (url) {
      const frame = document.createElement("iframe");
      frame.title = "Live Minecraft player view";
      frame.referrerPolicy = "no-referrer";
      frame.allowFullscreen = true;
      frame.setAttribute("allow", "fullscreen");
      frame.src = url;
      frame.addEventListener("error", () => {
        text(
          "viewer-note",
          "Renderer service could not be loaded. Check the game connection, then reload the view.",
        );
      });
      viewerFrame = frame;
      element("viewer").append(frame);
    }
  }
  hidden("viewer-empty", !!url);
  hidden("reload-viewer", !url);
  if (url)
    text(
      "viewer-note",
      "Live renderer · read-only player view. If the frame is blank or disconnected, reload the view.",
    );
  else {
    const samePausedConnection =
      state.run?.status === "paused" &&
      state.run.world_id === game.world_id &&
      state.run.epoch === game.epoch &&
      (game.status === "error" || game.status === "disconnected");
    const interruptedAction =
      samePausedConnection && state.run?.action?.status === "unknown"
        ? state.run.action
        : null;
    text(
      "viewer-empty-title",
      game.status === "connecting"
        ? "Connecting player…"
        : game.status === "connected"
          ? "Renderer unavailable"
          : game.error
            ? "Player connection ended"
            : "No game connection",
    );
    const connectionHint =
      game.status === "connected"
        ? "The player is connected, but the rendering service has not provided a usable view."
        : state.server.status === "running"
          ? game.status === "connecting"
            ? "The world is running. Waiting for the player and renderer to connect."
            : state.run?.status === "paused"
              ? "Resume reconnects the player and continues this run, including model requests."
              : state.run?.status === "created"
                ? "Your run is saved. In Setup, reconnect the player, then press Start. Reconnecting does not call the model."
                : activeRun(state.run)
                  ? "The player is disconnected. Stop the run, then reconnect the player in Setup."
                  : "The world is running. Reconnect the player in Setup to restore the live view."
          : "Start the local world in Setup to connect the player and renderer.";
    text(
      "viewer-empty-copy",
      game.error ? `Connection event: ${game.error}` : connectionHint,
    );
    text(
      "viewer-interrupted-action",
      interruptedAction
        ? `Interrupted ${interruptedAction.kind}: outcome unverified. This action result does not explain why the player disconnected. No action is automatically replayed.`
        : "",
    );
    hidden("viewer-interrupted-action", !interruptedAction);
    text("viewer-recovery-hint", game.error ? connectionHint : "");
    hidden("viewer-recovery-hint", !game.error);
    text(
      "open-setup",
      state.run?.status === "paused" && state.server.status === "running"
        ? "Go to Resume"
        : "Open setup",
    );
    text(
      "viewer-note",
      game.viewer_ready && !url
        ? "The renderer returned an unsupported address. Check the local service."
        : "No live renderer available. No simulated footage is displayed.",
    );
  }
  const player = game.player;
  text(
    "player-vitals",
    player
      ? `Health ${player.health.toFixed(1)} / 20 · Food ${player.food} / 20`
      : "Player state unavailable",
  );
  text(
    "player-position",
    player
      ? `XYZ ${player.position.x.toFixed(1)} / ${player.position.y.toFixed(1)} / ${player.position.z.toFixed(1)}`
      : "",
  );
  text(
    "observation-time",
    game.last_observation_at
      ? `Observed ${when(game.last_observation_at)}`
      : "No observation",
  );
  const inventory = player?.inventory ?? [];
  text("inventory-count", player ? `(${inventory.length} occupied slots)` : "");
  text(
    "inventory-empty",
    player
      ? "Inventory is empty."
      : "Inventory is unavailable until the player connects.",
  );
  hidden("inventory-empty", inventory.length > 0);
  const list = element("inventory-items");
  const signature = json(inventory);
  if (list.dataset.signature !== signature) {
    list.dataset.signature = signature;
    list.replaceChildren(
      ...inventory.map((item) => {
        const li = document.createElement("li");
        li.textContent = `${item.display_name} × ${item.count}`;
        return li;
      }),
    );
  }
}
function activeRun(run: RunView | null): boolean {
  return !!run && !["stopped", "completed", "failed"].includes(run.status);
}
function canOperate(id?: string): boolean {
  return (
    serviceReady &&
    !!snapshot &&
    (pendingCommands.size === 0 ||
      (id === "stop-run" && !pendingCommands.has(id)))
  );
}
function updateButtons(): void {
  const state = snapshot;
  const available = canOperate();
  const run = state?.run ?? null;
  const active = activeRun(run);
  const busyAuth =
    state?.auth.status === "authorizing" ||
    state?.auth.status === "discovering";
  const gameBusy = ["preparing", "starting"].includes(
    state?.server.status ?? "",
  );
  const canReconnect =
    state?.server.status === "running" &&
    ["disconnected", "error"].includes(state.game.status);
  const runPrerequisitesReady =
    state?.auth.authenticated &&
    !!state.auth.models.length &&
    state.server.status === "running" &&
    state.sandbox.status === "ready";
  const runReady = runPrerequisitesReady && state?.game.status === "connected";
  const disabled: Record<string, boolean> = {
    "login-browser": !available || !!busyAuth || active,
    "login-device": !available || !!busyAuth || active,
    "refresh-models":
      !available || !state?.auth.authenticated || !!busyAuth || active,
    logout: !available || !state?.auth.authenticated || !!busyAuth || active,
    "auth-submit": !available || !state?.auth.login?.prompt,
    "cancel-login": !available || !state?.auth.login,
    "prepare-game":
      !available ||
      gameBusy ||
      state?.server.status === "running" ||
      active ||
      (!state?.server.eula_accepted &&
        !element<HTMLInputElement>("eula").checked),
    "start-game":
      !available ||
      gameBusy ||
      (state?.server.status !== "stopped" && !canReconnect) ||
      (active && !(run?.status === "created" && canReconnect)),
    "stop-game":
      !available ||
      !["running", "starting", "error"].includes(state?.server.status ?? "") ||
      active,
    "new-world":
      !available ||
      active ||
      state?.server.status !== "stopped" ||
      !element<HTMLInputElement>("confirm-world").checked,
    "create-run":
      !available ||
      active ||
      !runReady ||
      !task.value.trim() ||
      !model.value ||
      !goal.value,
    "start-run": !available || run?.status !== "created" || !runReady,
    "pause-run":
      !available || !["running", "bootstrapping"].includes(run?.status ?? ""),
    "resume-run":
      !available || run?.status !== "paused" || !runPrerequisitesReady,
    "stop-run":
      !canOperate("stop-run") ||
      !active ||
      (run?.status === "stopping" && !run.error),
    "use-goal": !available || !goal.value,
  };
  for (const [id, value] of Object.entries(disabled)) {
    const button = element<HTMLButtonElement>(id);
    button.disabled = value;
    button.setAttribute(
      "aria-busy",
      String(
        pendingCommands.has(id) ||
          (id === "stop-run" && run?.status === "stopping" && !run.error),
      ),
    );
  }
  text(
    "stop-run",
    run?.status === "stopping"
      ? run.error && !pendingCommands.has("stop-run")
        ? "Retry Stop"
        : "Stopping"
      : "Stop run",
  );
  text(
    "start-game",
    state?.server.status === "starting"
      ? "Starting…"
      : state?.server.status === "running"
        ? state.game.status === "connecting" ||
          pendingCommands.has("start-game")
          ? "Connecting player…"
          : state.game.status === "connected"
            ? "Player connected"
            : "Reconnect player"
        : pendingCommands.has("start-game")
          ? "Starting…"
          : "Start world",
  );
  goal.disabled = !available || active;
  model.disabled = !available || active || !state?.auth.models.length;
  task.disabled = !serviceReady || active;
  hidden("pause-run", run?.status === "paused");
  hidden("resume-run", run?.status !== "paused");
  element("task-form").setAttribute(
    "aria-busy",
    String(pendingCommands.has("create-run")),
  );
}
function render(state: AppSnapshot): void {
  snapshot = state;
  renderOptions(state);
  renderAuth(state);
  renderViewer(state);
  text("server-status", `World · ${label(state.server.status)}`);
  element("server-status").dataset.ready = String(
    state.server.status === "running",
  );
  text("sandbox-status", `Isolation · ${label(state.sandbox.status)}`);
  element("sandbox-status").dataset.ready = String(
    state.sandbox.status === "ready",
  );
  text(
    "world-description",
    `Minecraft ${state.server.version} · ${state.server.host}:${state.server.port} · ${label(state.server.status)}${state.server.eula_accepted ? " · EULA accepted" : ""}`,
  );
  hidden("eula-row", state.server.eula_accepted);
  errorText("game-error", state.server.error ?? state.game.error);
  errorText(
    "sandbox-error",
    state.sandbox.error
      ? `Policy isolation unavailable: ${state.sandbox.error}`
      : null,
  );
  text(
    "prepare-game",
    state.server.status === "preparing" ? "Preparing…" : "Prepare server",
  );
  const run = state.run;
  text("run-status", run ? label(run.status) : "No run");
  hidden("current-run", !run);
  errorText("run-error", run?.error ?? null);
  if (run) {
    text("current-task", run.task);
    text("current-model", run.model_id);
    text("model-status", label(run.model_status));
    text("turns", String(run.turns));
    text(
      "tokens",
      `${run.usage.input_tokens.toLocaleString()} / ${run.usage.output_tokens.toLocaleString()}`,
    );
    text(
      "cost",
      run.usage.known_cost === null
        ? "Unknown / unmeasured"
        : `$${run.usage.known_cost.toFixed(4)}`,
    );
    text(
      "action-summary",
      run.action
        ? `${label(run.action.origin)} action · ${run.action.kind} · ${label(run.action.status)} — ${run.action.summary}`
        : "No foreground action.",
    );
    text(
      "run-evidence",
      json({
        run_id: run.run_id,
        world_id: run.world_id,
        epoch: run.epoch,
        started_at: run.started_at,
        ended_at: run.ended_at,
        action: run.action,
      }),
    );
  }
  const hint = !state.auth.authenticated
    ? "Connect OpenAI in Setup before creating a run."
    : state.auth.models.length === 0
      ? "No model is available. Refresh models or check your account entitlement."
      : state.server.status !== "running"
        ? "Start the local world in Setup."
        : state.sandbox.status !== "ready"
          ? "Policy isolation is not ready. The local Docker sandbox must be available before a run can start."
          : run?.status === "paused"
            ? "Run paused. Resume reconnects the player if needed and continues this task; Stop closes it and disconnects the player."
            : state.game.status !== "connected"
              ? state.game.status === "connecting"
                ? "Waiting for a real player connection. Check Setup for connection errors."
                : run?.status === "created"
                  ? "Your task and model are saved. Reconnect the player in Setup, then press Start above; no new run or model request is needed to reconnect."
                  : activeRun(run)
                    ? "The player is disconnected. Stop the run, then reconnect the player in Setup."
                    : "Reconnect the player in Setup before creating a run."
              : run?.status === "created"
                ? "Run created. Start above admits the first strategic turn."
                : activeRun(run)
                  ? "Pause fences new decisions and cancels the foreground action. Stop also disconnects the player; the world itself keeps running."
                  : goal.value === "custom"
                    ? "Custom goals do not self-certify success from model text. Stop when you have reviewed the result."
                    : "Create a run, then Start. Completion requires actual inventory evidence.";
  text(
    "run-hint",
    run?.status === "stopping"
      ? run.error
        ? "Stop cleanup failed. Retry Stop above to finish cleanup."
        : "Stopping the run and disconnecting the player. The world itself keeps running."
      : hint,
  );
  if (!setupInitialized) {
    setupInitialized = true;
    if (!setupTouched)
      setSetup(
        !state.auth.authenticated ||
          state.server.status !== "running" ||
          state.sandbox.status !== "ready",
      );
  }
  mergeEvents(state.events);
  renderPolicies(run);
  updateButtons();
}
async function refreshState(): Promise<void> {
  if (!serviceReady) return;
  if (fetching) {
    refreshAgain = true;
    return;
  }
  fetching = true;
  const generation = bootstrapGeneration;
  try {
    const next = await fetchState();
    if (generation === bootstrapGeneration) render(next);
  } catch (error) {
    if (generation === bootstrapGeneration) {
      errorText(
        "request-error",
        `${message(error)} Displayed evidence is retained; current state is unavailable.`,
      );
      serviceReady = false;
      eventStream?.close();
      text(
        "connection",
        error instanceof ApiError && [401, 403].includes(error.status)
          ? "Local session expired · reconnect required"
          : "State unavailable · reconnect required",
      );
      updateButtons();
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
  if (refreshTimer === null)
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null;
      void refreshState();
    }, 150);
}
function message(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The request failed. Reconnect to inspect the current state.";
}
async function command(
  id: string,
  operation: () => Promise<void>,
): Promise<void> {
  if (!canOperate(id)) return;
  pendingCommands.add(id);
  errorText("request-error", null);
  updateButtons();
  try {
    await operation();
    await refreshState();
  } catch (error) {
    errorText("request-error", message(error));
    scheduleRefresh();
  } finally {
    pendingCommands.delete(id);
    updateButtons();
  }
}
async function bootstrap(): Promise<void> {
  const generation = ++bootstrapGeneration;
  eventStream?.close();
  eventStream = null;
  serviceReady = false;
  updateButtons();
  element<HTMLButtonElement>("reconnect").disabled = true;
  text("connection", "Connecting to local service…");
  errorText("request-error", null);
  try {
    await openSession();
    const next = await fetchState();
    if (generation !== bootstrapGeneration) return;
    serviceReady = true;
    render(next);
    const stream = new EventSource("/v1/events", { withCredentials: true });
    eventStream = stream;
    stream.onopen = () => {
      if (generation === bootstrapGeneration) {
        text("connection", "Local service · live updates connected");
        if (element("request-error").textContent === streamFailure)
          errorText("request-error", null);
        scheduleRefresh();
      }
    };
    stream.onerror = () => {
      if (generation === bootstrapGeneration) {
        text("connection", "Live updates interrupted · reconnecting");
        errorText("request-error", streamFailure);
      }
    };
    const activity = (event: MessageEvent<string>): void => {
      try {
        const parsed = eventSchema.safeParse(JSON.parse(event.data));
        if (parsed.success) mergeEvents([parsed.data]);
        else
          errorText(
            "request-error",
            "An unreadable activity event was received. Reconnect to refresh state.",
          );
      } catch {
        errorText(
          "request-error",
          "An unreadable activity event was received. Reconnect to refresh state.",
        );
      }
      scheduleRefresh();
    };
    stream.onmessage = activity;
    stream.addEventListener("activity", activity as EventListener);
    stream.addEventListener("changed", scheduleRefresh);
  } catch (error) {
    if (generation === bootstrapGeneration) {
      text("connection", "Local service unavailable");
      errorText("request-error", message(error));
    }
  } finally {
    if (generation === bootstrapGeneration) {
      element<HTMLButtonElement>("reconnect").disabled = false;
      updateButtons();
    }
  }
}
function onClick(id: string, handler: () => void): void {
  element(id).addEventListener("click", handler);
}
onClick("reconnect", () => {
  void bootstrap();
});
onClick("setup-toggle", () => {
  setupTouched = true;
  setSetup(element("setup").hidden !== false);
});
onClick("open-setup", () => {
  if (
    snapshot?.run?.status === "paused" &&
    snapshot.server.status === "running"
  ) {
    const resume = element<HTMLButtonElement>("resume-run");
    const target = resume.disabled ? element("run-controls") : resume;
    target.scrollIntoView({ block: "center" });
    target.focus();
    return;
  }
  setupTouched = true;
  setSetup(true);
  if (snapshot?.auth.authenticated) {
    element("world-heading").scrollIntoView({ block: "nearest" });
    const connect = element<HTMLButtonElement>("start-game");
    if (!connect.disabled) connect.focus();
  } else {
    element("account-heading").scrollIntoView({ block: "nearest" });
    element("login-browser").focus();
  }
});
onClick("login-browser", () => {
  void command("login-browser", () =>
    mutate("/v1/auth/login", { mode: "browser" }),
  );
});
onClick("login-device", () => {
  void command("login-device", () =>
    mutate("/v1/auth/login", { mode: "device" }),
  );
});
onClick("refresh-models", () => {
  void command("refresh-models", () => mutate("/v1/auth/refresh"));
});
onClick("logout", () => {
  void command("logout", () => mutate("/v1/auth/logout"));
});
onClick("cancel-login", () => {
  const login = snapshot?.auth.login;
  if (login)
    void command("cancel-login", () =>
      mutate("/v1/auth/cancel", { login_id: login.id }),
    );
});
element("auth-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const login = snapshot?.auth.login;
  if (!login?.prompt || (!login.prompt.allow_empty && !authInput.value)) return;
  const value = authInput.value;
  void command("auth-submit", async () => {
    await mutate("/v1/auth/input", { login_id: login.id, value });
    authInput.value = "";
  });
});
onClick("prepare-game", () => {
  void command("prepare-game", () =>
    mutate("/v1/game/prepare", {
      accept_eula:
        !!snapshot?.server.eula_accepted ||
        element<HTMLInputElement>("eula").checked,
    }),
  );
});
onClick("start-game", () => {
  void command("start-game", () => mutate("/v1/game/start"));
});
onClick("stop-game", () => {
  void command("stop-game", () => mutate("/v1/game/stop"));
});
onClick("new-world", () => {
  if (element<HTMLInputElement>("confirm-world").checked)
    void command("new-world", async () => {
      await mutate("/v1/game/new-world", { confirm: true });
      element<HTMLInputElement>("confirm-world").checked = false;
    });
});
for (const id of ["eula", "confirm-world"])
  element(id).addEventListener("change", updateButtons);
task.addEventListener("input", () => {
  taskEdited = true;
  updateButtons();
});
goal.addEventListener("change", () => {
  if (!taskEdited)
    task.value =
      snapshot?.goals.find((item) => item.id === goal.value)?.prompt ?? "";
  updateButtons();
});
model.addEventListener("change", updateButtons);
onClick("use-goal", () => {
  task.value =
    snapshot?.goals.find((item) => item.id === goal.value)?.prompt ?? "";
  taskEdited = false;
  task.focus();
  updateButtons();
});
element("task-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (element<HTMLButtonElement>("create-run").disabled) return;
  const initiatingElement = document.activeElement;
  let createdRunId: string | null = null;
  void command("create-run", async () => {
    const run = await createRun({
      task: task.value.trim(),
      goal: goal.value,
      model_id: model.value,
    });
    createdRunId = run.run_id;
    if (snapshot) render({ ...snapshot, run });
  }).then(() => {
    const start = element<HTMLButtonElement>("start-run");
    if (
      createdRunId &&
      snapshot?.run?.run_id === createdRunId &&
      !start.disabled &&
      (document.activeElement === document.body ||
        document.activeElement === initiatingElement)
    )
      start.focus();
  });
});
for (const control of ["start", "pause", "resume", "stop"] as const)
  onClick(`${control}-run`, () => {
    const run = snapshot?.run;
    if (!run) return;
    const button = element<HTMLButtonElement>(`${control}-run`);
    const hadFocus = document.activeElement === button;
    const request_id = crypto.randomUUID();
    void command(`${control}-run`, () =>
      mutate(`/v1/runs/${encodeURIComponent(run.run_id)}/controls`, {
        command: control,
        request_id,
      }),
    ).then(() => {
      if (
        !hadFocus ||
        pendingCommands.size > 0 ||
        (document.activeElement !== document.body &&
          document.activeElement !== button)
      )
        return;
      const status = snapshot?.run?.status;
      const next = element<HTMLButtonElement>(
        status === "paused"
          ? "resume-run"
          : status === "created"
            ? "start-run"
            : status === "running" || status === "bootstrapping"
              ? "pause-run"
              : "stop-run",
      );
      if (!next.disabled && !next.hidden) next.focus({ preventScroll: true });
      else element("run-controls").focus({ preventScroll: true });
    });
  });
onClick("reload-viewer", () => {
  if (viewerFrame && viewerUrl) viewerFrame.src = viewerUrl;
});
onClick("activity-tab", () => setTab("activity"));
onClick("policies-tab", () => setTab("policies"));
for (const tab of ["activity", "policies"])
  element(`${tab}-tab`).addEventListener("keydown", (event) => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      setTab(
        event.key === "Home"
          ? "activity"
          : event.key === "End"
            ? "policies"
            : activeTab === "activity"
              ? "policies"
              : "activity",
        true,
      );
    }
  });
onClick("resume-live", () => {
  followLive = true;
  mergeEvents([]);
  renderPolicies(snapshot?.run ?? null);
});
window.addEventListener("online", scheduleRefresh);
window.addEventListener("pagehide", () => eventStream?.close());
window.addEventListener("pageshow", (event) => {
  if (event.persisted) void bootstrap();
});
updateButtons();
if (window.location.hostname === "localhost") {
  // Cookie hosts do not include ports. The separate renderer uses 127.0.0.1,
  // so canonicalize before creating an operator/viewer session on another host.
  const canonical = new URL(window.location.href);
  canonical.hostname = "127.0.0.1";
  window.location.replace(canonical.href);
} else {
  void bootstrap();
}
