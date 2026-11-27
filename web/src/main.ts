import "@fontsource/jura/latin-500.css";
import "@fontsource/jura/latin-700.css";
import "@fontsource/jura/cyrillic-500.css";
import "@fontsource/jura/cyrillic-700.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "@fontsource/ibm-plex-mono/cyrillic-400.css";
import "@fontsource/ibm-plex-mono/cyrillic-500.css";
import "./styles.css";
import { fetchState, mutate, openSession } from "./api.ts";
import { SurvivalAgentView } from "./survival-agent-view.ts";
import type { AuthState } from "../../src/shared/auth-types.ts";

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("Application mount is missing.");
root.innerHTML = `
<a class="skip-link" href="#run-controls">Skip to run controls</a>
<main class="workspace show-survival-agent">
  <header class="workspace-header"><h1>GameHarness</h1><span id="connection" role="status">Connecting to local service…</span><nav aria-label="Workspace"><button id="reconnect" type="button">Reconnect</button><button id="settings-open" type="button">Settings</button><button id="sidebar-toggle" type="button" aria-expanded="true" aria-controls="context-panel">Hide panel</button></nav></header>
  <div id="request-error" class="notice error" role="alert" hidden></div>
  <div class="work-area" id="work-area">
    <section class="game-console" aria-label="Authentic Minecraft player video">
      <div class="console-topline"><h2>Minecraft <span class="muted">/ player view</span></h2><span id="survival-agent-video-status" role="status"></span></div>
      <div class="viewer" id="viewer"><img id="survival-agent-video" width="960" height="540" alt="Read-only gameplay from GameHarness" draggable="false" hidden><div class="viewer-empty" id="survival-agent-empty"><h3 id="survival-agent-video-message">No live video</h3></div></div>
      <div class="viewer-foot"><span id="survival-agent-video-detail"></span><button id="survival-agent-video-retry" type="button" hidden>Reconnect video</button></div>
    </section>
    <aside class="context-panel" id="context-panel" aria-label="Current goal and player">
      <div class="context-overview"><section><h2 id="survival-agent-goal-heading">Current goal</h2><p id="survival-agent-task"></p></section><section id="survival-agent-activity"><h2 id="survival-agent-action-heading">Agent activity</h2><p id="survival-agent-action"></p></section><section><h2>Player</h2><p id="survival-agent-player"></p></section></div>
      <section class="usage-summary"><h2>Strategy</h2><p id="survival-agent-model"></p><p id="survival-agent-strategy-outcome" hidden></p></section>
    </aside>
  </div>
  <section class="run-toolbar" id="run-controls" aria-label="Run controls" tabindex="-1"><div class="run-control-state"><strong id="survival-agent-phase" role="status">No agent running</strong><span id="survival-agent-hint">Choose a goal in Settings.</span><span id="survival-agent-control-error" class="error" role="alert" hidden></span></div><div class="button-row"><button id="survival-agent-check" type="button" hidden>Check status</button><button id="survival-agent-choose" class="primary" type="button">Choose goal</button><button id="survival-agent-stop" class="danger" type="button" disabled>Stop agent</button></div></section>
  <footer><span class="muted">Read-only video · no manual gameplay</span></footer>
</main>
<dialog id="settings-dialog" aria-labelledby="settings-title"><div class="dialog-header"><h2 id="settings-title">Settings</h2><button id="settings-close" type="button">Close</button></div><div class="dialog-body settings-grid">
  <section aria-labelledby="survival-agent-heading"><h3 id="survival-agent-heading" tabindex="-1">Minecraft Survival Agent</h3><form id="survival-agent-form">
    <label for="survival-agent-strategy">Agent strategy</label><div class="input-row"><select id="survival-agent-strategy" required><option value="deterministic" selected>Deterministic (no model)</option><option value="model">Model</option></select></div>
    <div id="survival-agent-model-field" hidden><label for="survival-agent-model-input">Strategy model</label><div class="input-row"><select id="survival-agent-model-input" disabled><option value="">Connect OpenAI first</option></select></div></div>
    <p id="survival-agent-strategy-disclosure" class="muted" hidden>Model strategy sends your goal, inventory, player status, visible environment and task queue to the selected provider through your connected account. Requests count toward your account usage. The player continues without a reply.</p>
    <label for="survival-agent-goal">Agent goal</label><div class="input-row"><select id="survival-agent-goal" required></select><button id="survival-agent-start" type="submit" class="primary" disabled>Start in new world</button></div><p id="survival-agent-start-status" role="status" hidden></p><p id="survival-agent-start-error" class="error" role="alert" hidden></p><button id="survival-agent-start-check" type="button" hidden>Check status</button></form></section>
  <section><h3>OpenAI connection</h3><p id="account-description">Connect your own account to discover models.</p><div class="button-row"><button id="login-browser" type="button">Connect in browser</button><button id="login-device" type="button">Use device code</button><button id="refresh-models" type="button" hidden>Refresh models</button><button id="logout" type="button" hidden>Disconnect account</button></div><div id="login-flow" hidden><p id="login-instructions"></p><a id="authorize-link" class="button primary" target="_blank" rel="noopener noreferrer" hidden>Continue in browser</a><p class="muted">Complete authorization in your browser, then return here.</p><form id="auth-form" hidden><label id="auth-input-label" for="auth-input">Authorization response</label><div class="input-row"><input id="auth-input" autocomplete="off" spellcheck="false" maxlength="16000"><button id="auth-submit" type="submit">Submit response</button></div></form><button id="cancel-login" type="button">Cancel authorization</button></div><p id="auth-error" class="error" role="alert" hidden></p></section>

  <section><h3>Isolated Minecraft world</h3><p id="world-description" role="status">Checking EULA consent.</p><p class="muted">Uses your official Launcher account for an isolated client. Personal worlds are not changed.</p><label id="eula-row" class="check-row"><input id="eula" type="checkbox"><span>I accept the <a href="https://www.minecraft.net/en-us/eula" target="_blank" rel="noopener noreferrer">Minecraft EULA</a> for this local server.</span></label><button id="prepare-game" type="button" disabled>Prepare server</button><p id="game-error" class="error" role="alert" hidden></p></section>
  <section><h3>Control &amp; licenses</h3><p>Start opens a new Survival world. Stop agent saves and closes that world's owned processes. Video receives no manual gameplay input.</p><p><a href="/licenses/Jura-LICENSE.txt" target="_blank" rel="noopener">Jura license</a> · <a href="/licenses/IBM-Plex-Mono-LICENSE.txt" target="_blank" rel="noopener">IBM Plex Mono license</a></p></section>
</div></dialog>`;

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing interface element: ${id}`);
  return node as T;
}
function text(id: string, value: string) { el(id).textContent = value; }
function errorText(id: string, value: string | null) { text(id, value ?? ""); el(id).hidden = !value; }
const dialog = el<HTMLDialogElement>("settings-dialog");
let dialogOrigin: HTMLElement | null = null;
function openSettings() { if (!dialog.open) { dialogOrigin = document.activeElement as HTMLElement; dialog.showModal(); } }
function closeSettings() { dialog.close(); }
dialog.addEventListener("close", () => { dialogOrigin?.focus({ preventScroll: true }); });
el("settings-open").addEventListener("click", openSettings);
el("settings-close").addEventListener("click", closeSettings);
el("sidebar-toggle").addEventListener("click", () => {
  const panel = el("context-panel"); panel.hidden = !panel.hidden;
  el("work-area").classList.toggle("panel-hidden", panel.hidden);
  el("sidebar-toggle").setAttribute("aria-expanded", String(!panel.hidden));
  text("sidebar-toggle", panel.hidden ? "Show panel" : "Hide panel");
});
let state: Awaited<ReturnType<typeof fetchState>> | null = null;
let online = false, pending = false, generation = 0, timer = 0;
const agent = new SurvivalAgentView({ el, text, errorText, openSettings, closeSettings, updateControls });
function updateControls() {
  const busy = pending || !online || agent.locksModel;
  for (const id of ["login-browser", "login-device", "logout", "refresh-models"]) el<HTMLButtonElement>(id).disabled = busy;
  el<HTMLButtonElement>("prepare-game").disabled = busy || !!state?.preparing ||
    !(state?.eulaAccepted || el<HTMLInputElement>("eula").checked);
  el<HTMLButtonElement>("cancel-login").disabled = pending || !online;
  el<HTMLButtonElement>("auth-submit").disabled = pending || !online || !state?.auth.login?.prompt;
}
function renderAuth(auth: AuthState) {
  agent.setAuth(auth);
  text("account-description", auth.account_label ? `Connected: ${auth.account_label}` :
    auth.status === "discovering" ? "Discovering models…" : "Connect your own account to discover models.");
  const login = auth.login;
  el("login-flow").hidden = !login;
  el("logout").hidden = el("refresh-models").hidden = !auth.authenticated;
  text("login-instructions", login?.instructions ?? "");
  const link = el<HTMLAnchorElement>("authorize-link"); link.hidden = !login?.url;
  if (login?.url) link.href = login.url; else link.removeAttribute("href");
  el("auth-form").hidden = !login?.prompt;
  const input = el<HTMLInputElement>("auth-input");
  input.type = login?.prompt?.secret ? "password" : "text";
  input.required = !login?.prompt?.allow_empty;
  text("auth-input-label", login?.prompt?.label ?? "Authorization response");
  errorText("auth-error", auth.error);
}
async function refresh(epoch: number) {
  try {
    const next = await fetchState();
    if (epoch !== generation) return;
    state = next; online = true;
    text("connection", "Local service connected");
    renderAuth(next.auth);
    el("eula-row").hidden = next.eulaAccepted;
    text("world-description", next.preparing ? "Preparing the Minecraft server…" : next.eulaAccepted ? "Minecraft EULA consent saved." : "Accept the EULA before preparing the server.");
    errorText("game-error", next.preparationError);
    agent.setModelConflict(next.preparing ? "Wait for server preparation to finish." : !next.eulaAccepted ? "Accept the Minecraft EULA and prepare the server first." : null);
    agent.connect();
  } catch (error) {
    if (epoch !== generation) return;
    online = false; text("connection", "Local service unavailable");
    errorText("request-error", error instanceof Error ? error.message : "Reconnect to inspect local state.");
    agent.disconnect();
  } finally {
    if (epoch === generation) { updateControls(); timer = window.setTimeout(() => void refresh(epoch), 1500); }
  }
}
async function connect() {
  const epoch = ++generation; window.clearTimeout(timer); online = false; updateControls();
  try { await openSession(); if (epoch !== generation) return; errorText("request-error", null); await refresh(epoch); }
  catch (error) { if (epoch !== generation) return; errorText("request-error", error instanceof Error ? error.message : "Reconnect to the local service."); text("connection", "Local service unavailable"); }
}
async function command(path: string, body: unknown = {}) {
  if (pending || !online) return;
  pending = true; updateControls(); errorText("request-error", null);
  try { await mutate(path, body); }
  catch (error) { errorText("request-error", error instanceof Error ? error.message : "Check local state before retrying."); }
  finally { pending = false; window.clearTimeout(timer); await refresh(generation); }
}
el("reconnect").addEventListener("click", () => void connect());
for (const [id, mode] of [["login-browser", "browser"], ["login-device", "device"]])
  el(id!).addEventListener("click", () => void command("/v1/auth/login", { mode }));
el("logout").addEventListener("click", () => void command("/v1/auth/logout"));
el("refresh-models").addEventListener("click", () => void command("/v1/auth/refresh"));
el("cancel-login").addEventListener("click", () => { if (state?.auth.login) void command("/v1/auth/cancel", { login_id: state.auth.login.id }); });
el("auth-form").addEventListener("submit", event => {
  event.preventDefault(); if (!state?.auth.login) return;
  const input = el<HTMLInputElement>("auth-input"), value = input.value; input.value = "";
  void command("/v1/auth/input", { login_id: state.auth.login.id, value });
});
el("eula").addEventListener("change", updateControls);
el("prepare-game").addEventListener("click", () => void command("/v1/server/prepare", { accept_eula: !!state?.eulaAccepted || el<HTMLInputElement>("eula").checked }));
void connect();
