import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as postmortem from "@oh-my-pi/pi-utils/postmortem";
import { ActorFrameSelector, type FrameScope } from "../src/server/actor-frames.ts";
import { EpisodeRecorder } from "../src/server/recording.ts";
import { NativeFixture, bounded, pause, requireProof, until } from "../src/evaluation/native-game.ts";
import { assertNativeArtifactFresh, requireTierOptIn } from "../src/evaluation/tiers.ts";

/** Separate privileged infrastructure exercise. NEVER imported by natural acceptance. */
export async function runNativeRecordingProof(args: readonly string[], project = fileURLToPath(new URL("..", import.meta.url))) {
  requireTierOptIn("native-game", { allowNative: args.includes("--allow-native") });
  const flags = [...args], jarIndex = flags.indexOf("--jar");
  requireProof(jarIndex >= 0 && flags[jarIndex + 1], "Pass --jar <fresh-built.jar>");
  const artifact = assertNativeArtifactFresh(project, flags[jarIndex + 1]!);
  if (process.env.GAMEHARNESS_PROOF_EXPECTED_JAR_SHA256)
    requireProof(process.env.GAMEHARNESS_PROOF_EXPECTED_JAR_SHA256 === artifact.sha256, "Dispatcher and recorder proof disagree about the built native artifact");
  flags.splice(jarIndex, 2);
  requireProof(flags.every(flag => flag === "--allow-native"), "Recorder proof accepts only --allow-native and --jar; no inference/auth/login flags");
  process.env.GAMEHARNESS_NATIVE_PROOF = "1";
  process.env.GAMEHARNESS_PROOF_EXPECTED_JAR_SHA256 = artifact.sha256;
  const fixture = await NativeFixture.create("native-recording-proof", { projectRoot: project });
  let recorder: EpisodeRecorder | undefined, failure: unknown, endedAt = 0;
  const proofScope = new AbortController();
  const completed = Promise.withResolvers<void>();
  let nativeDrain: ReturnType<NativeFixture["close"]> | undefined;
  let cleanupDeadline = Infinity, cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  const cleanup = { confirmed: false, deadline_reached: false, budget_ms: fixture.caps.cleanupMs };
  fixture.report.recorder_cleanup = cleanup;
  const replayTiming = Object.freeze({ nominal_capture_hz: 30, tolerance_ms: Math.ceil(1000 / 30 + 100) });
  const events: Array<{ event: string; wall_ms: number; monotonic_ms: number; details?: unknown }> = [];
  fixture.report.recorder_events = events;
  fixture.report.actual_provider_calls = 0;
  let reportTail: Promise<void> = Promise.resolve();
  const flush = () => {
    const writing = reportTail.then(() => {
      // Read the current verdict at serialization, not when this write queued.
      if (failure) { fixture.report.pass = false; process.exitCode = 1; }
      return fixture.flush();
    });
    reportTail = writing.catch(() => { fixture.report.recorder_report_persistence_failed = true; });
    return writing;
  };
  const mark = (event: string, details?: unknown) => events.push({ event, wall_ms: Date.now(), monotonic_ms: performance.now(), details });
  const armCleanup = (signalExit = false) => {
    const budget = Math.min(fixture.caps.cleanupMs, signalExit ? 9000 : fixture.caps.cleanupMs);
    const end = performance.now() + budget;
    if (end >= cleanupDeadline) return;
    cleanupDeadline = end; cleanup.budget_ms = budget; clearTimeout(cleanupTimer);
    cleanupTimer = setTimeout(() => {
      cleanup.deadline_reached = true; cleanup.confirmed = false;
      failure ??= new Error("Recorder proof cleanup deadline reached");
      fixture.report.pass = false;
      fixture.report.recorder_failure = "Owned recording/native cleanup remains unconfirmed at its deadline";
      void flush().catch(() => {});
    }, budget);
  };
  const interrupted = (why: string, signalExit = false) => {
    failure ??= new Error(`Recorder proof interrupted: ${why}`);
    fixture.report.pass = false; process.exitCode = 1;
    proofScope.abort(failure); mark("operator_interrupt", { reason: why });
    fixture.report.recorder_failure = failure instanceof Error ? failure.message : String(failure);
    armCleanup(signalExit);
    void flush().catch(() => {});
    // Wake pending native work as well as the scope-owned renderer/probe.
    nativeDrain ??= fixture.close();
    void nativeDrain.catch(() => {});
  };
  const unregisterCleanup = postmortem.register(`native-recording-proof-${randomUUID()}`, why => {
    interrupted(why, true);
    return completed.promise;
  }, { exitOnly: true });
  const deadline = setTimeout(() => interrupted("entire_sample_deadline"), fixture.caps.totalMs);
  const assertOpen = () => requireProof(!proofScope.signal.aborted && !failure, "Recorder proof scope closed");
  try {
    assertOpen(); await fixture.start(); assertOpen(); await fixture.flat(); assertOpen();
    const initial = await fixture.bridge.observe(), runId = randomUUID();
    let scope: FrameScope = { run_id: runId, world_id: initial.world_id, session_id: initial.session_id,
      epoch: initial.epoch, life_id: initial.life.life_id, generation: 1, native_boot_id: initial.native_boot_id,
      compatibility_hash: initial.compatibility_hash, space: initial.space, screen: initial.screen };
    const selector = new ActorFrameSelector({ latestFrame: () => fixture.bridge.latestFrame(), scope: () => scope });
    const entry: Record<string, unknown> = { name: "delivered_frames_menu_wait_interrupt_respawn",
      conditions: { provider_calls: 0, model_inference: "disabled", replay_timing: replayTiming,
        classification: "Privileged evaluator-owned native recording/image infrastructure only; no natural gameplay or live vision claim" },
      status: "running", started_at: new Date().toISOString() };
    fixture.cases.push(entry);
    const caseStarted = performance.now();
    // This proof owns its failure path. Do not enter NativeFixture.case's
    // synchronous failure-frame FFmpeg capture after the proof scope is revoked.
    try {
      assertOpen();
      recorder = new EpisodeRecorder({ directory: path.join(fixture.evidenceDirectory, "recording"), bridge: fixture.bridge,
        identity: { episode_id: randomUUID(), run_id: runId, world_id: initial.world_id, session_id: initial.session_id },
        onIncomplete: why => { failure ??= new Error(why); proofScope.abort(); } });
      const image = async (name: string) => {
        const selected = await until(async () => {
          assertOpen();
          try { const current = await selector.select(); assertOpen(); return current; }
          catch { assertOpen(); return null; }
        }, value => value !== null,
          fixture.caps.observationMs, "No current-scope actor image arrived");
        requireProof(selected, "Missing actor image");
        assertOpen();
        await writeFile(path.join(fixture.evidenceDirectory, `${name}.png`), Buffer.from(selected.images[0]!.data, "base64"), { mode: 0o600, flag: "wx" });
        mark(name, selected.metadata); return selected.metadata;
      };
      entry.alive_image = await image("actor-alive");
      mark("deliberate_wait_started"); await pause(1600); assertOpen(); mark("deliberate_wait_ended");
      const motorAbort = new AbortController();
      assertOpen();
      const motor = fixture.action({ kind: "move", controls: { forward: true, sneak: true }, duration_ms: 1000 },
        fixture.caps.observationMs, AbortSignal.any([proofScope.signal, motorAbort.signal]));
      void motor.catch(() => {});
      await until(() => { assertOpen(); return fixture.diagnostics(); }, value => value.motor_active, fixture.caps.diagnosticsMs, "Native motor did not become active");
      assertOpen(); mark("explicit_effect_interruption"); motorAbort.abort();
      entry.interrupted_motor = await bounded(motor.then(native_receipt => ({ native_receipt }),
        () => ({ native_receipt: null, effect_outcome: "unknown", transport_settlement: "rejected_no_host_error_dump" })),
        fixture.caps.cleanupMs, "Interrupted native motor did not settle");
      await fixture.drainEffects("Explicit recording-proof motor interruption drained");
      const afterInterruption = await fixture.diagnostics();
      entry.after_interruption = afterInterruption;
      requireProof(afterInterruption.controls_neutral && !afterInterruption.motor_active, "Native interruption did not neutralize controls");
      assertOpen();
      await fixture.console(["kill @a"]);
      assertOpen();
      const dead = await until(() => { assertOpen(); return fixture.bridge.observe(); }, observation => observation.life.status === "dead", fixture.caps.observationMs, "Visible vanilla death was not observed");
      scope = { ...scope, life_id: dead.life.life_id, space: dead.space, screen: dead.screen, generation: scope.generation + 1 };
      entry.death_screen = await until(() => { assertOpen(); return fixture.diagnostics(); }, value => value.death_screen, fixture.caps.diagnosticsMs, "Native DeathScreen not visible");
      mark("visible_death_menu_started", entry.death_screen);
      entry.menu_image = await image("actor-death-menu");
      await pause(1400); assertOpen();
      mark("explicit_respawn_requested");
      entry.respawn = await bounded(fixture.action({ kind: "respawn" }, fixture.caps.observationMs,
        AbortSignal.any([proofScope.signal, AbortSignal.timeout(fixture.caps.observationMs)])),
        fixture.caps.observationMs + fixture.caps.cleanupMs, "Native respawn did not settle after cancellation");
      assertOpen();
      const alive = await until(() => { assertOpen(); return fixture.bridge.observe(); }, observation => observation.life.status === "alive" && observation.life.life_id > dead.life.life_id,
        fixture.caps.observationMs, "Explicit native respawn did not confirm a new alive life");
      scope = { ...scope, life_id: alive.life.life_id, space: alive.space, screen: alive.screen, generation: scope.generation + 1 };
      mark("respawn_ready", { life_id: alive.life.life_id });
      entry.respawn_image = await image("actor-respawn");
      await pause(600); assertOpen();
      endedAt = Date.now(); mark("capture_finished");
      const recording = await recorder!.finish({ endedAt, reason: "declared_native_proof_completed" });
      entry.recording = recording;
      requireProof(recording.status === "complete", "Recording evidence is incomplete");
      assertOpen();
      entry.replay = await recorder!.renderReplay({ signal: proofScope.signal });
      assertOpen();
      const records = (await readFile(path.join(fixture.evidenceDirectory, "recording/frames.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line)).filter(record => record.kind === "frame");
      assertOpen();
      const probe = Promise.withResolvers<number | null>();
      const child = spawn("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", "replay.mp4"], { cwd: path.join(fixture.evidenceDirectory, "recording"), stdio: ["ignore", "pipe", "ignore"] });
      let output = "", probeFailure: Error | undefined;
      const terminateProbe = (error: Error) => { probeFailure ??= error; child.kill("SIGKILL"); };
      const abortProbe = () => terminateProbe(new Error("Replay duration probe interrupted"));
      child.stdout?.on("data", chunk => {
        output += chunk.toString();
        if (output.length > 4096) terminateProbe(new Error("Replay duration probe output bound exceeded"));
      });
      child.once("error", () => { probeFailure ??= new Error("Replay duration probe unavailable"); });
      child.once("close", probe.resolve);
      proofScope.signal.addEventListener("abort", abortProbe, { once: true });
      if (proofScope.signal.aborted) abortProbe();
      const probeTimer = setTimeout(() => terminateProbe(new Error("Replay duration probe timed out")), fixture.caps.diagnosticsMs);
      let replayMs: number;
      try {
        const code = await probe.promise;
        if (probeFailure) throw probeFailure;
        requireProof(code === 0 && child.stdout, "Replay duration probe failed");
        assertOpen();
        replayMs = Number(output.trim()) * 1000;
      } finally {
        clearTimeout(probeTimer); proofScope.signal.removeEventListener("abort", abortProbe);
      }
      const expectedMs = endedAt - records[0]!.captured_at;
      const interval = Math.max(0, ...records.slice(1).map((record, index) => record.captured_at - records[index]!.captured_at));
      entry.replay_timing = { expected_ms: expectedMs, actual_ms: replayMs, ...replayTiming, maximum_observed_gap_ms: interval,
        events, audio: "not_recorded", visual_inspection: "Parent must inspect actual replay/menu/wait/interruption/respawn; duration alone is not visual proof" };
      requireProof(Number.isFinite(replayMs) && Math.abs(replayMs - expectedMs) <= replayTiming.tolerance_ms, "Replay compressed or stretched capture time beyond the predeclared nominal 30 Hz interval plus 100 ms");
      entry.status = "passed";
    } catch (error) {
      entry.status = "failed"; entry.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally { entry.elapsed_ms = performance.now() - caseStarted; }
  } catch (error) { failure ??= error; }
  finally {
    clearTimeout(deadline);
    proofScope.abort(failure ?? new Error("Recorder proof scope closed"));
    armCleanup();
    try {
      if (recorder) {
        try { await recorder.finish({ endedAt: endedAt || Date.now(), reason: failure ? "interrupted_or_failed" : "completed" }); }
        catch { failure ??= new Error("Recorder finalization failed"); }
      }
      if (nativeDrain) await nativeDrain;
      fixture.report.recorder_events = events; fixture.report.actual_provider_calls = 0;
      fixture.report.native_artifact = artifact;
      // A late actual drain does not retroactively claim the declared cleanup
      // deadline was met. The SDK can force signal exit with this still false.
      await fixture.finish(failure);
      if (performance.now() >= cleanupDeadline) cleanup.deadline_reached = true;
      cleanup.confirmed = !cleanup.deadline_reached && !fixture.report.recorder_report_persistence_failed && fixture.report.cleanup === true;
      // finish captured its argument before awaiting native close. A signal
      // during that await must still defeat its restored passing case result.
      if (failure || !cleanup.confirmed) { fixture.report.pass = false; process.exitCode = 1; }
      clearTimeout(cleanupTimer);
      await flush();
    } finally {
      clearTimeout(cleanupTimer);
      try {
        // Interruption can append a write while the original final flush is
        // awaited. Completion owns the latest tail, including those additions.
        let joined: Promise<void>;
        do {
          joined = reportTail;
          await joined;
        } while (joined !== reportTail);
      } finally {
        completed.resolve();
        unregisterCleanup();
      }
    }
  }
  return { private_report: fixture.evidenceDirectory, pass: !failure && fixture.report.pass === true, actual_provider_calls: 0 };
}
if (import.meta.main) {
  try { console.log(JSON.stringify(await runNativeRecordingProof(process.argv.slice(2)), null, 2)); }
  catch { console.error("Native recording proof failed; inspect private evidence. No inference or fallback was attempted."); process.exitCode = 1; }
}
