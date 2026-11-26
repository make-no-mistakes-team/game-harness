import { SURVIVAL_AGENT_GOALS, SURVIVAL_AGENT_STRATEGIES, type SurvivalAgentGoal,
  type SurvivalAgentSnapshot, type SurvivalAgentStart } from "../../src/shared/survival-agent-ui.ts";
import type { AuthState } from "../../src/shared/contracts.ts";
import { ApiError, fetchSurvivalAgent, startSurvivalAgent, stopSurvivalAgent } from "./api.ts";

const goalNames: Record<SurvivalAgentGoal, string> = {
  wooden_pickaxe: "Wooden pickaxe", stone_pickaxe: "Stone pickaxe", iron_pickaxe: "Iron pickaxe",
  diamond: "Diamond", diamond_pickaxe: "Diamond pickaxe", nether_portal: "Nether portal",
};

const strategyOutcomeLabels: Record<NonNullable<SurvivalAgentSnapshot["strategyOutcome"]>, string> = {
  strategy_applied: "The player used a strategy suggested by the model.",
  no_advice_applied: "No model strategy was applied.",
  native_effect_completed: "A model action was confirmed in Minecraft.",
  no_completed_effect: "No model action was confirmed.",
  provider_unavailable: "The model was unavailable.",
  refused: "The model declined the request.",
  provider_error: "A model request failed.",
  budget_limited: "The model reached its request or time limit.",
  display_lost: "The model lost the live game display.",
  protocol_fault: "The model could not continue safely.",
  cleanup_failed: "Model cleanup was not confirmed.",
};

type VideoState = "waiting" | "live" | "lost";
type Workspace = {
  el<T extends HTMLElement = HTMLElement>(id: string): T;
  text(id: string, value: string): void;
  errorText(id: string, value: string | null): void;
  openSettings(): void;
  closeSettings(): void;
  changeView(visible: boolean): void;
  updateControls(): void;
};

function phaseLabel(s: SurvivalAgentSnapshot): string {
  switch (s.phase) {
    case "idle": return "No agent running";
    case "starting": return "Preparing agent world";
    case "playing": return "Agent playing";
    case "stopping": return "Stopping agent";
    case "ended": return s.won === true ? "Goal verified" : s.strategy === "model" ? "Run ended" : "Goal not verified";
  }
}

// A native multipart <img> can retain the last JPEG after EOF. Read the
// authenticated parts so EOF, a hung capture, or a run change removes it.
async function readAgentFrames(run: string, signal: AbortSignal, frame: (parts: BlobPart[]) => void) {
  const response = await fetch(`/v1/survival-agent/video?run=${encodeURIComponent(run)}`, {
    credentials: "same-origin", mode: "same-origin", redirect: "error", cache: "no-store", signal,
  });
  const type = response.headers.get("Content-Type") ?? "";
  const boundary = /;\s*boundary=(?:"([^"]+)"|([^\s;]+))/i.exec(type);
  if (!response.ok || !response.body || !/^multipart\/x-mixed-replace\b/i.test(type) || !boundary)
    throw new Error("Agent video is unavailable.");
  const marker = `--${boundary[1] ?? boundary[2]}\r\n`;
  const reader = response.body.getReader();
  const header = new Uint8Array(1024), decoder = new TextDecoder();
  let headerBytes = 0, remaining = 0, parts: BlobPart[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error("The agent video stream closed.");
      let pos = 0;
      while (pos < value.length) {
        if (!remaining) {
          if (headerBytes === header.length) throw new Error("Unreadable agent video.");
          header[headerBytes++] = value[pos++]!;
          if (headerBytes < 4 || header[headerBytes - 4] !== 13 || header[headerBytes - 3] !== 10 ||
              header[headerBytes - 2] !== 13 || header[headerBytes - 1] !== 10) continue;
          const fields = decoder.decode(header.subarray(0, headerBytes)).replace(/^\r\n/, "");
          remaining = Number(/^Content-Length:[ \t]*(\d+)\r$/im.exec(fields)?.[1]);
          if (!fields.startsWith(marker) || !/^Content-Type:[ \t]*image\/jpeg\r$/im.test(fields) ||
              !(remaining > 0 && remaining <= 2_000_000)) throw new Error("Unreadable agent video.");
          headerBytes = 0;
        } else {
          const n = Math.min(remaining, value.length - pos);
          parts.push(value.subarray(pos, pos + n));
          pos += n;
          remaining -= n;
          if (!remaining) { frame(parts); parts = []; }
        }
      }
    }
  } finally { reader.releaseLock(); }
}

class AgentVideo {
  run: string | null = null;
  state: VideoState = "waiting";
  reason = "";
  private controller: AbortController | null = null;
  private watchdog = 0;

  constructor(private readonly image: HTMLImageElement, private readonly changed: () => void) {}

  setRun(run: string | null, retry = false) {
    if (run === this.run && !retry) return;
    this.clear();
    this.run = run;
    this.state = "waiting";
    this.reason = "";
    if (!run) return;
    const controller = this.controller = new AbortController();
    let lastFrame = performance.now(), decoding = false;
    const fail = (why: string) => {
      if (this.controller !== controller) return;
      this.clear();
      this.state = "lost";
      this.reason = why;
      this.changed();
    };
    this.watchdog = window.setInterval(() => {
      if (performance.now() - lastFrame > 8000) fail("No fresh video frames received.");
    }, 1000);
    void readAgentFrames(run, controller.signal, parts => {
      // Drop frames instead of queueing old gameplay behind a slow decoder.
      if (this.controller !== controller || decoding) return;
      decoding = true;
      const url = URL.createObjectURL(new Blob(parts, { type: "image/jpeg" }));
      this.image.src = url;
      void this.image.decode().then(() => {
        if (this.controller !== controller) return;
        lastFrame = performance.now();
        if (this.state !== "live") {
          this.state = "live";
          this.image.hidden = false;
          this.changed();
        }
      }, () => fail("The video frame could not be displayed.")).finally(() => {
        decoding = false;
        URL.revokeObjectURL(url);
      });
    }).catch(error => fail(error instanceof TypeError ? "Lost connection to agent video." : error.message));
  }

  private clear() {
    this.controller?.abort();
    this.controller = null;
    window.clearInterval(this.watchdog);
    this.image.hidden = true;
    this.image.removeAttribute("src");
  }
}

export class SurvivalAgentView {
  visible = false;
  private readonly video: AgentVideo;
  private state: SurvivalAgentSnapshot | null = null;
  private online = false;
  private known = false;
  private timer = 0;
  private read: AbortController | null = null;
  private session = 0;
  private command: "start" | "stop" | null = null;
  private unresolvedStart = false;
  private dialogStart: SurvivalAgentStart | null = null;
  private readError: string | null = null;
  private startError: string | null = null;
  private stopError: string | null = null;
  private conflict: string | null = null;
  private modelLocked = false;
  private auth: AuthState | null = null;
  private modelSignature = "";

  constructor(private readonly ui: Workspace) {
    const { el } = ui;
    this.video = new AgentVideo(el<HTMLImageElement>("survival-agent-video"), () => this.renderVideo());
    const select = el<HTMLSelectElement>("survival-agent-goal");
    const strategySelect = el<HTMLSelectElement>("survival-agent-strategy");
    const modelSelect = el<HTMLSelectElement>("survival-agent-model-input");
    for (const goal of SURVIVAL_AGENT_GOALS) select.add(new Option(goalNames[goal], goal));
    el("settings-dialog").addEventListener("close", () => { this.dialogStart = null; });
    strategySelect.addEventListener("change", () => this.renderSettings());
    modelSelect.addEventListener("change", () => this.renderSettings());
    el("survival-agent-form").addEventListener("submit", e => {
      e.preventDefault();
      const goal = SURVIVAL_AGENT_GOALS.find(g => g === select.value);
      const strategy = SURVIVAL_AGENT_STRATEGIES.find(value => value === strategySelect.value);
      if (!goal || !strategy || el<HTMLButtonElement>("survival-agent-start").disabled) return;
      if (strategy === "deterministic") void this.submit({ goal, strategy });
      else {
        const model = this.modelChoices.find(item => `${item.provider}/${item.id}` === modelSelect.value);
        if (model) void this.submit({ goal, strategy, model: { provider: model.provider, modelId: model.id } });
      }
    });
    el("survival-agent-stop").addEventListener("click", () => {
      if (!el<HTMLButtonElement>("survival-agent-stop").disabled) void this.submit(null);
    });
    for (const id of ["survival-agent-check", "survival-agent-start-check"])
      el(id).addEventListener("click", () => this.check());
    el("survival-agent-video-retry").addEventListener("click", () => {
      if (!this.known || this.state?.phase !== "playing" || !this.state.run) return;
      this.video.setRun(this.state.run, true);
      this.renderVideo();
      el("run-controls").focus({ preventScroll: true });
    });
    el("survival-agent-choose").addEventListener("click", () => {
      ui.openSettings();
      select.focus();
    });
    el("survival-agent-return").addEventListener("click", () => {
      if (this.state?.phase !== "ended" || this.locksModel) return;
      this.show(false);
      el("new-task").focus({ preventScroll: true });
    });
  }

  private get active() {
    const phase = this.state?.phase;
    return phase === "starting" || phase === "playing" || phase === "stopping";
  }
  get locksModel() { return this.active || this.command !== null || this.unresolvedStart; }

  setAuth(auth: AuthState) {
    this.auth = auth;
    this.renderSettings();
  }

  private get modelChoices() {
    const auth = this.auth;
    return auth?.authenticated && auth.status === "ready"
      ? auth.models.filter(item => item.provider === auth.provider) : [];
  }

  setModelConflict(conflict: string | null) {
    if (this.conflict === conflict) return;
    this.conflict = conflict;
    if (conflict && this.state?.phase === "ended" && !this.locksModel) this.show(false);
    this.renderSettings();
  }

  connect() { this.online = true; this.check(); }
  disconnect() {
    ++this.session;
    this.online = false;
    this.known = false;
    if (this.command === "start") this.unresolvedStart = true;
    this.cancelRead();
    this.render();
  }
  private cancelRead() {
    window.clearTimeout(this.timer);
    this.read?.abort();
    this.read = null;
  }
  check() {
    if (this.online && !this.command && !this.read) void this.poll();
  }
  private async poll() {
    window.clearTimeout(this.timer);
    const controller = this.read = new AbortController();
    try {
      const next = await fetchSurvivalAgent(AbortSignal.any([controller.signal, AbortSignal.timeout(6000)]));
      if (this.read !== controller) return;
      this.accept(next);
    } catch (error) {
      if (this.read !== controller) return;
      this.known = false;
      this.readError = error instanceof Error ? error.message : "Agent status unavailable.";
    } finally {
      if (this.read === controller) {
        this.read = null;
        this.render();
        this.timer = window.setTimeout(() => this.check(), this.active || !this.known ? 1200 : 5000);
      }
    }
  }
  private async submit(input: SurvivalAgentStart | null) {
    if (!this.online || !this.known || this.command) return;
    const session = this.session;
    this.cancelRead();
    this.command = input ? "start" : "stop";
    this.dialogStart = input;
    this.startError = this.stopError = null;
    this.ui.el(input ? "survival-agent-heading" : "run-controls").focus({ preventScroll: true });
    this.render();
    try {
      const next = input ? await startSurvivalAgent(input) : await stopSurvivalAgent();
      if (session !== this.session) return;
      this.accept(next);
    } catch (error) {
      if (session !== this.session) return;
      const detail = error instanceof Error ? error.message : "Agent request failed.";
      if (input) {
        this.startError = detail;
        this.unresolvedStart = !(error instanceof ApiError && error.status >= 400 && error.status < 500 && error.code !== "invalid_response");
        if (!this.unresolvedStart) this.dialogStart = null;
      }
      else this.stopError = detail;
      this.known = false; // Reconcile before another mutation, including after an unknown HTTP outcome.
    } finally {
      this.command = null;
      this.render();
      this.check();
    }
  }
  private accept(next: SurvivalAgentSnapshot) {
    const wasActive = this.active;
    const matchesSubmittedStart = this.dialogStart !== null &&
      next.goal === this.dialogStart.goal && next.strategy === this.dialogStart.strategy &&
      next.model === (this.dialogStart.model
        ? `${this.dialogStart.model.provider}/${this.dialogStart.model.modelId}` : null);
    this.state = next;
    this.known = true;
    this.readError = null;
    this.unresolvedStart = false;
    if (this.active) {
      this.startError = null;
      this.show(true);
      if (matchesSubmittedStart) this.ui.closeSettings();
    }
    else {
      this.stopError = null;
      if (next.phase === "idle") this.show(false);
      if (next.phase === "ended" && (wasActive || matchesSubmittedStart)) {
        // Require a fresh opt-in for the next world.
        this.ui.el<HTMLSelectElement>("survival-agent-strategy").value = "deterministic";
      }
    }
    this.dialogStart = null;
  }
  private show(visible: boolean) {
    if (visible === this.visible) return;
    this.visible = visible;
    this.ui.changeView(visible);
  }
  private renderSettings() {
    const { el, text, errorText } = this.ui, s = this.state;
    const strategy = el<HTMLSelectElement>("survival-agent-strategy");
    strategy.disabled = this.locksModel;
    if (this.active && s?.strategy) strategy.value = s.strategy;
    const usesModel = strategy.value === "model";
    const model = el<HTMLSelectElement>("survival-agent-model-input");
    const choices = this.modelChoices;
    const runningModel = this.active && s?.strategy === "model" ? s.model : null;
    const placeholder = !this.auth?.authenticated ? "Connect OpenAI first"
      : this.auth.status === "discovering" ? "Discovering models…"
      : this.auth.status !== "ready" ? "Models unavailable"
      : !choices.length ? "No models available" : "Choose a model";
    const signature = JSON.stringify([choices, placeholder, runningModel]);
    if (signature !== this.modelSignature) {
      this.modelSignature = signature;
      const previous = runningModel ?? model.value;
      model.replaceChildren(new Option(placeholder, ""),
        ...choices.map(item => new Option(`${item.name} · ${item.provider}/${item.id}`, `${item.provider}/${item.id}`)));
      if (runningModel && !choices.some(item => `${item.provider}/${item.id}` === runningModel)) {
        const retained = new Option(runningModel, runningModel);
        retained.disabled = true;
        model.add(retained);
      }
      if (previous && Array.from(model.options).some(option => option.value === previous)) model.value = previous;
    }
    el("survival-agent-model-field").hidden = !usesModel;
    model.required = usesModel;
    model.disabled = !usesModel || this.locksModel || !choices.length;
    const modelRequirement = !usesModel ? null
      : !this.auth?.authenticated ? "Connect your OpenAI account, or choose Deterministic (no model)."
      : this.auth.status === "discovering" ? "Waiting for model discovery."
      : this.auth.status !== "ready" || !choices.length
        ? "No models are available. Refresh models or choose Deterministic (no model)."
      : !choices.some(item => `${item.provider}/${item.id}` === model.value) ? "Choose a strategy model."
      : null;
    const blocked = this.command === "start" ? "Requesting agent start…"
      : !this.online ? "Reconnect to the local service to start the agent."
      : !this.known ? this.readError ? "Agent status unavailable." : "Checking agent status…"
      : s?.phase === "stopping" ? "Waiting for the agent’s world to close."
      : this.active ? "Stop the current agent run before starting another."
      : this.conflict ?? modelRequirement;
    const start = el<HTMLButtonElement>("survival-agent-start");
    start.disabled = !!blocked || this.locksModel;
    start.setAttribute("aria-busy", String(this.command === "start"));
    const select = el<HTMLSelectElement>("survival-agent-goal");
    select.disabled = this.locksModel;
    if (this.active && s?.goal && select.value !== s.goal) select.value = s.goal;
    const disclosure = el("survival-agent-strategy-disclosure");
    disclosure.hidden = !usesModel;
    for (const control of [strategy, model, start]) {
      if (disclosure.hidden) control.removeAttribute("aria-describedby");
      else control.setAttribute("aria-describedby", disclosure.id);
    }
    const last = s?.phase === "ended" && s.goal ? `Last run: ${goalNames[s.goal]} · ${s.status || phaseLabel(s)}` : null;
    const detail = blocked ?? last;
    text("survival-agent-start-status", detail ?? "");
    el("survival-agent-start-status").hidden = !detail;
    errorText("survival-agent-start-error", this.startError ?? this.readError);
    el("survival-agent-start-check").hidden = !this.online || !this.readError;
    if (document.activeElement === model && model.disabled)
      el(strategy.disabled ? "survival-agent-heading" : "survival-agent-strategy").focus({ preventScroll: true });
  }
  private render() {
    const { el, text, errorText } = this.ui, s = this.state;
    const focus = document.activeElement;
    this.renderSettings();
    // A failed status read is not a video interruption. Keep only the already
    // admitted stream; never open a new one against unconfirmed state.
    this.video.setRun(!this.online || !this.visible || this.command === "stop" ? null
      : !this.known ? this.video.run : s?.phase === "playing" ? s.run : null);
    this.renderVideo();
    if (this.visible && s) {
      const ended = s.phase === "ended" && this.known;
      const seconds = Math.floor(s.elapsedMs / 1000);
      const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
      text("survival-agent-phase", this.command === "stop" ? "Requesting agent stop" : this.known ? phaseLabel(s) : "Agent status unavailable");
      text("survival-agent-hint", !this.known ? "Run state is unconfirmed."
        : ended ? `${elapsed} elapsed`
        : `${elapsed} elapsed · Stop agent closes this world.`);
      text("survival-agent-goal-heading", s.phase === "ended" ? "Session goal" : "Current goal");
      text("survival-agent-task", !s.goal ? "Goal unavailable." : s.goal === "nether_portal"
        ? "Build a portal and enter the Nether." : s.goal === "diamond"
          ? "Mine and collect a diamond." : `Craft ${s.goal === "iron_pickaxe" ? "an" : "a"} ${goalNames[s.goal].toLowerCase()}.`);
      el("survival-agent-activity").hidden = ended;
      text("survival-agent-action-heading", this.known ? "Agent activity" : "Last reported activity");
      text("survival-agent-action", s.status.trim() || "No activity reported.");
      const deaths = s.deaths === null ? "" : ` · Deaths ${s.deaths}`;
      text("survival-agent-player", `${ended || !this.known ? "Last reported · " : ""}Health ${s.health ?? "unknown"} · Food ${s.food ?? "unknown"}${deaths}`);
      text("survival-agent-model", s.strategy === "model" && s.model ? `Model · ${s.model}`
        : s.strategy === "deterministic" ? "Deterministic · no model" : "Strategy unavailable");
      const strategyOutcome = ended && s.strategy === "model" ? s.strategyOutcome : null;
      el("survival-agent-strategy-outcome").hidden = strategyOutcome === null;
      text("survival-agent-strategy-outcome", strategyOutcome === null ? "" : strategyOutcomeLabels[strategyOutcome]);
      errorText("survival-agent-control-error", this.stopError ?? this.readError);
      el("survival-agent-check").hidden = !this.readError || !this.online;
      el("survival-agent-choose").hidden = el("survival-agent-return").hidden = !ended;
      const stop = el<HTMLButtonElement>("survival-agent-stop");
      stop.hidden = ended;
      stop.disabled = !this.online || !this.known || !this.active || s.phase === "stopping" || this.command !== null;
      stop.setAttribute("aria-busy", String(this.command === "stop"));
      text("survival-agent-stop", s.phase === "stopping" ? "Stopping agent" : "Stop agent");
      if (focus === stop && (stop.disabled || stop.hidden) || focus?.id === "survival-agent-check" && el("survival-agent-check").hidden)
        el("run-controls").focus({ preventScroll: true });
    }
    if (focus?.id === "survival-agent-start-check" && el("survival-agent-start-check").hidden)
      el(el<HTMLButtonElement>("survival-agent-start").disabled ? "survival-agent-heading" : "survival-agent-start").focus();
    if (this.locksModel !== this.modelLocked) {
      this.modelLocked = this.locksModel;
      this.ui.updateControls();
    }
  }
  private renderVideo() {
    if (!this.visible) return;
    const { el, text } = this.ui, s = this.state;
    const live = this.video.run !== null && this.video.state === "live";
    const lost = this.video.run !== null && this.video.state === "lost";
    el("survival-agent-empty").hidden = live;
    el("survival-agent-video-retry").hidden = !lost || !this.known;
    const ended = this.known && s?.phase === "ended";
    text("survival-agent-video-status", live ? "Live" : lost ? "Video unavailable" : "No live video");
    text("survival-agent-video-message", lost ? "Agent video interrupted" : !this.known ? "Waiting for agent status"
      : s?.phase === "starting" ? "Preparing the new world" : ended ? s.status.trim() || "Agent session ended"
      : this.command === "stop" || s?.phase === "stopping" ? "Closing the agent’s world" : "Waiting for agent video");
    const image = el<HTMLImageElement>("survival-agent-video");
    text("survival-agent-video-detail", live ? `${image.naturalWidth} × ${image.naturalHeight} · Minecraft Survival Agent`
      : lost ? this.video.reason : "Minecraft Survival Agent");
  }
}
