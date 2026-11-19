import { SURVIVAL_PILOT_GOALS, type SurvivalPilotGoal, type SurvivalPilotSnapshot } from "../../src/shared/survival-pilot-ui.ts";
import { ApiError, fetchSurvivalPilot, startSurvivalPilot, stopSurvivalPilot } from "./api.ts";

const goalNames: Record<SurvivalPilotGoal, string> = {
  wooden_pickaxe: "Wooden pickaxe", stone_pickaxe: "Stone pickaxe", iron_pickaxe: "Iron pickaxe",
  diamond: "Diamond", nether_portal: "Nether portal",
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

function phaseLabel(s: SurvivalPilotSnapshot): string {
  switch (s.phase) {
    case "idle": return "No pilot running";
    case "starting": return "Preparing pilot world";
    case "playing": return "Pilot playing";
    case "stopping": return "Stopping pilot";
    case "ended": return s.won === true ? "Goal verified" : "Goal not verified";
  }
}

// A native multipart <img> can retain the last JPEG after EOF. Read the
// authenticated parts so EOF, a hung capture, or a run change removes it.
async function readPilotFrames(run: string, signal: AbortSignal, frame: (parts: BlobPart[]) => void) {
  const response = await fetch(`/v1/survival-pilot/video?run=${encodeURIComponent(run)}`, {
    credentials: "same-origin", mode: "same-origin", redirect: "error", cache: "no-store", signal,
  });
  const type = response.headers.get("Content-Type") ?? "";
  const boundary = /;\s*boundary=(?:"([^"]+)"|([^\s;]+))/i.exec(type);
  if (!response.ok || !response.body || !/^multipart\/x-mixed-replace\b/i.test(type) || !boundary)
    throw new Error("Pilot video is unavailable.");
  const marker = `--${boundary[1] ?? boundary[2]}\r\n`;
  const reader = response.body.getReader();
  const header = new Uint8Array(1024), decoder = new TextDecoder();
  let headerBytes = 0, remaining = 0, parts: BlobPart[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error("The pilot video stream closed.");
      let pos = 0;
      while (pos < value.length) {
        if (!remaining) {
          if (headerBytes === header.length) throw new Error("Unreadable pilot video.");
          header[headerBytes++] = value[pos++]!;
          if (headerBytes < 4 || header[headerBytes - 4] !== 13 || header[headerBytes - 3] !== 10 ||
              header[headerBytes - 2] !== 13 || header[headerBytes - 1] !== 10) continue;
          const fields = decoder.decode(header.subarray(0, headerBytes)).replace(/^\r\n/, "");
          remaining = Number(/^Content-Length:[ \t]*(\d+)\r$/im.exec(fields)?.[1]);
          if (!fields.startsWith(marker) || !/^Content-Type:[ \t]*image\/jpeg\r$/im.test(fields) ||
              !(remaining > 0 && remaining <= 2_000_000)) throw new Error("Unreadable pilot video.");
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

class PilotVideo {
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
    void readPilotFrames(run, controller.signal, parts => {
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
    }).catch(error => fail(error instanceof TypeError ? "Lost connection to pilot video." : error.message));
  }

  private clear() {
    this.controller?.abort();
    this.controller = null;
    window.clearInterval(this.watchdog);
    this.image.hidden = true;
    this.image.removeAttribute("src");
  }
}

export class SurvivalPilotView {
  visible = false;
  private readonly video: PilotVideo;
  private state: SurvivalPilotSnapshot | null = null;
  private online = false;
  private known = false;
  private timer = 0;
  private read: AbortController | null = null;
  private session = 0;
  private command: "start" | "stop" | null = null;
  private unresolvedStart = false;
  private dialogStart: SurvivalPilotGoal | null = null;
  private readError: string | null = null;
  private startError: string | null = null;
  private stopError: string | null = null;
  private conflict: string | null = null;
  private modelLocked = false;

  constructor(private readonly ui: Workspace) {
    const { el } = ui;
    this.video = new PilotVideo(el<HTMLImageElement>("pilot-video"), () => this.renderVideo());
    const select = el<HTMLSelectElement>("pilot-goal");
    for (const goal of SURVIVAL_PILOT_GOALS) select.add(new Option(goalNames[goal], goal));
    el("settings-dialog").addEventListener("close", () => { this.dialogStart = null; });
    el("pilot-form").addEventListener("submit", e => {
      e.preventDefault();
      const goal = SURVIVAL_PILOT_GOALS.find(g => g === select.value);
      if (goal && !el<HTMLButtonElement>("pilot-start").disabled) void this.submit(goal);
    });
    el("pilot-stop").addEventListener("click", () => {
      if (!el<HTMLButtonElement>("pilot-stop").disabled) void this.submit(null);
    });
    for (const id of ["pilot-check", "pilot-start-check"])
      el(id).addEventListener("click", () => this.check());
    el("pilot-video-retry").addEventListener("click", () => {
      if (!this.known || this.state?.phase !== "playing" || !this.state.run) return;
      this.video.setRun(this.state.run, true);
      this.renderVideo();
      el("run-controls").focus({ preventScroll: true });
    });
    el("pilot-choose").addEventListener("click", () => {
      ui.openSettings();
      select.focus();
    });
    el("pilot-return").addEventListener("click", () => {
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
      const next = await fetchSurvivalPilot(AbortSignal.any([controller.signal, AbortSignal.timeout(6000)]));
      if (this.read !== controller) return;
      this.accept(next);
    } catch (error) {
      if (this.read !== controller) return;
      this.known = false;
      this.readError = error instanceof Error ? error.message : "Pilot status unavailable.";
    } finally {
      if (this.read === controller) {
        this.read = null;
        this.render();
        this.timer = window.setTimeout(() => this.check(), this.active || !this.known ? 1200 : 5000);
      }
    }
  }
  private async submit(goal: SurvivalPilotGoal | null) {
    if (!this.online || !this.known || this.command) return;
    const session = this.session;
    this.cancelRead();
    this.command = goal ? "start" : "stop";
    this.dialogStart = goal;
    this.startError = this.stopError = null;
    this.ui.el(goal ? "pilot-heading" : "run-controls").focus({ preventScroll: true });
    this.render();
    try {
      const next = goal ? await startSurvivalPilot(goal) : await stopSurvivalPilot();
      if (session !== this.session) return;
      this.accept(next);
    } catch (error) {
      if (session !== this.session) return;
      const detail = error instanceof Error ? error.message : "Pilot request failed.";
      if (goal) {
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
  private accept(next: SurvivalPilotSnapshot) {
    this.state = next;
    this.known = true;
    this.readError = null;
    this.unresolvedStart = false;
    if (this.active) {
      this.startError = null;
      this.show(true);
      if (this.dialogStart !== null && next.goal === this.dialogStart) this.ui.closeSettings();
    }
    else {
      this.stopError = null;
      if (next.phase === "idle") this.show(false);
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
    const blocked = this.command === "start" ? "Submitting pilot start…"
      : !this.online ? "Reconnect to the local service to start a pilot."
      : !this.known ? this.readError ? "Pilot status unavailable." : "Checking pilot status…"
      : s?.phase === "stopping" ? "Waiting for the pilot world to close."
      : this.active ? "Stop the current pilot before starting another."
      : this.conflict;
    const start = el<HTMLButtonElement>("pilot-start");
    start.disabled = !!blocked || this.locksModel;
    start.setAttribute("aria-busy", String(this.command === "start"));
    const select = el<HTMLSelectElement>("pilot-goal");
    select.disabled = this.locksModel;
    if (this.active && s?.goal && select.value !== s.goal) select.value = s.goal;
    const last = s?.phase === "ended" && s.goal ? `Last pilot: ${goalNames[s.goal]} · ${s.status || phaseLabel(s)}` : null;
    const detail = blocked ?? last;
    text("pilot-start-status", detail ?? "");
    el("pilot-start-status").hidden = !detail;
    errorText("pilot-start-error", this.startError ?? this.readError);
    el("pilot-start-check").hidden = !this.online || !this.readError;
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
      text("pilot-phase", this.command === "stop" ? "Requesting pilot stop" : this.known ? phaseLabel(s) : "Pilot status unavailable");
      text("pilot-hint", !this.known ? "Run state is unconfirmed."
        : ended ? `${elapsed} elapsed`
        : `${elapsed} elapsed · Stop closes this pilot’s world.`);
      text("pilot-goal-heading", s.phase === "ended" ? "Session goal" : "Current goal");
      text("pilot-task", !s.goal ? "Goal unavailable." : s.goal === "nether_portal"
        ? "Build a portal and enter the Nether." : s.goal === "diamond"
          ? "Mine and collect a diamond." : `Craft ${s.goal === "iron_pickaxe" ? "an" : "a"} ${goalNames[s.goal].toLowerCase()}.`);
      el("pilot-activity").hidden = ended;
      text("pilot-action-heading", this.known ? "Pilot activity" : "Last reported activity");
      text("pilot-action", s.status.trim() || "No activity reported.");
      text("pilot-player", `${ended || !this.known ? "Last reported · " : ""}Health ${s.health ?? "unknown"} · Food ${s.food ?? "unknown"}`);
      errorText("pilot-control-error", this.stopError ?? this.readError);
      el("pilot-check").hidden = !this.readError || !this.online;
      el("pilot-choose").hidden = el("pilot-return").hidden = !ended;
      const stop = el<HTMLButtonElement>("pilot-stop");
      stop.hidden = ended;
      stop.disabled = !this.online || !this.known || !this.active || s.phase === "stopping" || this.command !== null;
      stop.setAttribute("aria-busy", String(this.command === "stop"));
      text("pilot-stop", s.phase === "stopping" ? "Stopping pilot" : "Stop pilot");
      if (focus === stop && (stop.disabled || stop.hidden) || focus?.id === "pilot-check" && el("pilot-check").hidden)
        el("run-controls").focus({ preventScroll: true });
    }
    if (focus?.id === "pilot-start-check" && el("pilot-start-check").hidden)
      el(el<HTMLButtonElement>("pilot-start").disabled ? "pilot-heading" : "pilot-start").focus();
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
    el("pilot-empty").hidden = live;
    el("pilot-video-retry").hidden = !lost || !this.known;
    const ended = this.known && s?.phase === "ended";
    text("pilot-video-status", live ? "Live" : lost ? "Video unavailable" : "No live video");
    text("pilot-video-message", lost ? "Pilot video interrupted" : !this.known ? "Waiting for pilot status"
      : s?.phase === "starting" ? "Preparing the new world" : ended ? s.status.trim() || "Pilot session ended"
      : this.command === "stop" || s?.phase === "stopping" ? "Closing the pilot world" : "Waiting for pilot video");
    const image = el<HTMLImageElement>("pilot-video");
    text("pilot-video-detail", live ? `${image.naturalWidth} × ${image.naturalHeight} · Survival Pilot`
      : lost ? this.video.reason : "Survival Pilot");
  }
}
