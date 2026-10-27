import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as postmortem from "@oh-my-pi/pi-utils/postmortem";
import { ActorFrameSelector, encodeNativeFramePng, type FrameScope } from "../src/server/actor-frames.ts";
import { EpisodeRecorder } from "../src/server/recording.ts";
import { NativeFixture, bounded, pause, requireProof, until } from "../src/evaluation/native-game.ts";
import { assertNativeArtifactFresh, requireTierOptIn } from "../src/evaluation/tiers.ts";
import { NATURAL_WORLD_CONDITIONS } from "../src/evaluation/scenarios.ts";
import { createEvaluationCaps } from "../src/evaluation/config.ts";
import type { Runtime } from "../src/server/runtime.ts";
import type { Store } from "../src/server/store.ts";
import type { SandboxService } from "../src/server/sandbox.ts";
import type { AuthManager } from "../src/server/auth.ts";
import type { ModelProgramEvidence } from "../src/evaluation/model-evidence.ts";
import type { Agent } from "@oh-my-pi/pi-agent-core/agent";
import type { StreamFn } from "@oh-my-pi/pi-agent-core/types";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";

/** Separate privileged infrastructure exercise. NEVER imported by natural acceptance. */
export async function runNativeRecordingProof(args: readonly string[], project = fileURLToPath(new URL("..", import.meta.url))) {
  requireTierOptIn("native-game", { allowNative: args.includes("--allow-native") });
  const flags = [...args], jarIndex = flags.indexOf("--jar");
  requireProof(jarIndex >= 0 && flags[jarIndex + 1], "Pass --jar <fresh-built.jar>");
  const artifact = assertNativeArtifactFresh(project, flags[jarIndex + 1]!);
  if (process.env.GAMEHARNESS_PROOF_EXPECTED_JAR_SHA256)
    requireProof(process.env.GAMEHARNESS_PROOF_EXPECTED_JAR_SHA256 === artifact.sha256, "Dispatcher and recorder proof disagree about the built native artifact");
  flags.splice(jarIndex, 2);
  const naturalStart = flags.includes("--natural-start");
  const runtimeLoad = flags.includes("--runtime-load");
  const resultContract = flags.includes("--result-contract");
  requireProof(!runtimeLoad || naturalStart, "--runtime-load requires --natural-start");
  requireProof(!resultContract || runtimeLoad, "--result-contract requires --runtime-load");
  requireProof(flags.every(flag => flag === "--allow-native" || flag === "--natural-start" || flag === "--runtime-load" || flag === "--result-contract"), "Recorder proof accepts only --allow-native, --jar, --natural-start, --runtime-load and --result-contract; no inference/auth/login flags");
  process.env.GAMEHARNESS_NATIVE_PROOF = "1";
  process.env.GAMEHARNESS_PROOF_EXPECTED_JAR_SHA256 = artifact.sha256;
  const fixture = await NativeFixture.create("native-recording-proof", { projectRoot: project,
    ...(naturalStart ? { conditions: { ...NATURAL_WORLD_CONDITIONS, seed: "1" },
      caps: createEvaluationCaps({ runMs: 60000, totalMs: 300000 }) } : {}) });
  if (naturalStart) {
    fixture.report.classification = "zero_provider_natural_start_recording_infrastructure_not_autonomous_gameplay";
    fixture.report.provider_calls = 0;
  }
  let recorder: EpisodeRecorder | undefined, failure: unknown, endedAt = 0;
  let runtime: Runtime | undefined, store: Store | undefined, sandbox: SandboxService | undefined;
  let evidence: ModelProgramEvidence | undefined, runtimeRunId: string | undefined;
  const agents = new Set<Agent>();
  const requestContinuity: Array<{ observation_seq: number; subgoal: string | null; worksite: unknown }> = [];
  let failSyntheticRequest: (() => void) | undefined, expectedProviderFailure = false;
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
    assertOpen(); await fixture.start(); assertOpen();
    if (!naturalStart) { await fixture.flat(); assertOpen(); }
    const initial = await fixture.bridge.observe();
    let runId: string = randomUUID();
    if (runtimeLoad) {
      // Match the failed pre-tool workload: real SDK/context/images/Store/journal,
      // replacing only provider transport with one abortable local stream.
      const [{ Agent }, { AssistantMessageEventStream }, { getBundledModels }, runtimeModule, storeModule, sandboxModule, evidenceModule] = await Promise.all([
        import("@oh-my-pi/pi-agent-core/agent"), import("@oh-my-pi/pi-ai/utils/event-stream"),
        import("@oh-my-pi/pi-catalog/models"), import("../src/server/runtime.ts"),
        import("../src/server/store.ts"), import("../src/server/sandbox.ts"), import("../src/evaluation/model-evidence.ts"),
      ]);
      const model = getBundledModels("openai-codex").find(model => model.input.includes("image"));
      requireProof(model, "Offline catalog lacks an image-capable descriptor");
      let syntheticCalls = 0;
      const stream: StreamFn = (_model, context, options) => {
        const events = new AssistantMessageEventStream();
        let retained: { authored_state?: { worksite?: unknown }; current_subgoal?: string } | undefined;
        for (const text of context.systemPrompt ?? []) {
          try { retained = JSON.parse(text).strategic_context ?? retained; } catch {}
        }
        const event = store!.latestEvent(runtimeRunId!, "adapter.evidence");
        const observation = (event?.details as { data?: { observation_seq?: number } } | null)?.data;
        requestContinuity.push({ observation_seq: observation?.observation_seq ?? 0,
          subgoal: retained?.current_subgoal ?? null, worksite: retained?.authored_state?.worksite ?? null });
        mark("synthetic_stream_entered", { images: context.messages.flatMap(message => Array.isArray(message.content)
          ? message.content.filter(part => part.type === "image") : []).length, provider_calls: 0 });
        if (resultContract && ++syntheticCalls <= 2) {
          const compact = syntheticCalls === 1;
          const source = compact
            ? 'const o=await game.observe(); const landmark=o.data.blocks[0]; await game.progress("Evaluator continuity landmark",{current_subgoal:"Check compact result",...(landmark?{worksite:landmark.position}:{})});let completed=0; for(let i=0;i<56;i++){const r=await game.action({kind:"look",yaw:o.data.player.yaw,pitch:o.data.player.pitch});if(r.status!=="succeeded")return {status:"blocked",summary:"Neutral mechanics refused",result:{completed}};completed++;}return {status:"completed",summary:"Many owned receipts retained by host",result:{completed}};'
            : 'const o=await game.observe(); await game.action({kind:"look",yaw:o.data.player.yaw,pitch:o.data.player.pitch});return {status:"completed",summary:"Oversize terminal fixture",result:{text:"😀".repeat(16384)}};';
          const call = { type: "toolCall" as const, id: randomUUID(), name: "program_submit",
            arguments: { name: compact ? "Evaluator compact result" : "Evaluator overflow result", source, args: null,
              limits: { duration_ms: 60000, max_actions: 64, max_calls: 128, max_depth: 1 } } };
          const message: AssistantMessage = { role: "assistant", content: [call], api: model.api, provider: model.provider,
            model: model.id, stopReason: "toolUse", timestamp: Date.now(),
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
          events.push({ type: "start", partial: message });
          events.push({ type: "toolcall_start", contentIndex: 0, partial: message });
          events.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(call.arguments), partial: message });
          events.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
          events.push({ type: "done", reason: "toolUse", message }); events.end();
          return events;
        }
        const abort = () => {
          const message: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider,
            model: model.id, stopReason: "aborted", errorMessage: "Zero-provider recorder scope closed", timestamp: Date.now(),
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
          events.push({ type: "error", reason: "aborted", error: message }); events.end();
        };
        failSyntheticRequest = () => {
          const message: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider,
            model: model.id, stopReason: "error", errorMessage: "Disclosed offline provider interruption", timestamp: Date.now(),
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
          events.push({ type: "error", reason: "error", error: message }); events.end();
        };
        if (options?.signal?.aborted) abort(); else options?.signal?.addEventListener("abort", abort, { once: true });
        return events;
      };
      const auth = {
        snapshot: () => ({ status: "ready", authenticated: true, provider: "openai-codex", account_label: "Offline recorder diagnostic",
          models: [{ id: model.id, name: model.name, provider: model.provider, input_modalities: ["text", "image"], context_window: model.contextWindow }], login: null, error: null }),
        createAgent: async (options: { systemPrompt: string[]; tools: Parameters<Agent["setTools"]>[0] }) => {
          const agent = new Agent({ initialState: { model, systemPrompt: options.systemPrompt, tools: options.tools }, streamFn: stream,
            getApiKey: () => "LOCAL_SYNTHETIC_PROVIDER_ONLY" });
          agents.add(agent); return agent;
        },
        releaseAgent: async (agent: Agent) => { agent.abort(); await agent.waitForIdle(); agents.delete(agent); },
      } as unknown as AuthManager;
      store = new storeModule.Store(fixture.root); sandbox = new sandboxModule.SandboxService(project, () => {});
      await bounded(sandbox.prepare(), fixture.caps.startMs, "Production isolation preparation timed out");
      const stop = (id: string, why: string) => {
        if (resultContract && expectedProviderFailure && why === "provider_failure_or_unsettled_no_repeat") return;
        failure ??= new Error(why); proofScope.abort(failure);
        void runtime?.control(id, "stop").catch(() => {});
      };
      evidence = new evidenceModule.ModelProgramEvidence(store, fixture.evidenceDirectory, fixture.caps, `offline-${randomUUID()}`, stop);
      evidence.observeAuthAgents(auth);
      runtime = new runtimeModule.Runtime(store, auth, fixture.bridge, sandbox, () => {}, { adapter: () => fixture.bridge.adapter(), actorFrames: fixture.bridge });
      await runtime.initialize(); evidence.bindRuntime(runtime);
      const goal = fixture.bridge.adapter()?.goals.find(goal => goal.goal_id === "custom" && goal.verifier === null);
      requireProof(goal, "Custom infrastructure goal unavailable");
      const run = await runtime.createRun({ task: "Disclosed zero-provider recorder workload; no gameplay objective or supplied strategy",
        goal, model_id: model.id, working_programs: "fresh" });
      runId = run.run_id; runtimeRunId = runId;
      fixture.report.runtime_load = { synthetic_provider_transport: true, actual_provider_calls: 0, real_sdk_runtime_store_journal: true,
        real_sandbox_prepared: true, worker_effects: resultContract ? "Evaluator-authored neutral look receipts, not gameplay" : 0,
        result_contract: resultContract, run_id: runId, model_descriptor_only: model.id };
    }
    let scope: FrameScope = { run_id: runId, world_id: initial.world_id, session_id: initial.session_id,
      epoch: initial.epoch, life_id: initial.life.life_id, generation: 1, native_boot_id: initial.native_boot_id,
      compatibility_hash: initial.compatibility_hash, space: initial.space, screen: initial.screen };
    const selector = new ActorFrameSelector({ latestFrame: () => fixture.bridge.latestFrame(), scope: () => scope });
    const entry: Record<string, unknown> = { name: runtimeLoad ? "natural_start_runtime_capture_load" : naturalStart ? "natural_start_capture_actor_observation_load" : "delivered_frames_menu_wait_interrupt_respawn",
      conditions: { provider_calls: 0, model_inference: "disabled", replay_timing: replayTiming,
        classification: "Privileged evaluator-owned native recording/image infrastructure only; no natural gameplay or live vision claim" },
      status: "running", started_at: new Date().toISOString() };
    fixture.cases.push(entry);
    const caseStarted = performance.now();
    const encodingMs: number[] = [];
    entry.recording_encode_ms = encodingMs;
    // This proof owns its failure path. Do not enter NativeFixture.case's
    // synchronous failure-frame FFmpeg capture after the proof scope is revoked.
    try {
      assertOpen();
      recorder = new EpisodeRecorder({ directory: path.join(fixture.evidenceDirectory, "recording"), bridge: fixture.bridge,
        identity: { episode_id: randomUUID(), run_id: runId, world_id: initial.world_id, session_id: initial.session_id },
        onIncomplete: why => { failure ??= new Error(why); proofScope.abort(); },
        encode: async (frame, receivedAt) => {
          const started = performance.now();
          try { return await encodeNativeFramePng(frame, receivedAt); }
          finally { encodingMs.push(performance.now() - started); }
        } });
      if (runtimeLoad) await runtime!.control(runId, "start");
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
      if (!runtimeLoad) entry.alive_image = await image("actor-alive");
      if (naturalStart) {
        entry.conditions = { provider_calls: 0, model_inference: "disabled",
          classification: runtimeLoad ? "Zero-provider real Runtime/SDK/context/journal capture load, no actions or console commands"
            : "Zero-provider fresh seed1 capture/actor-image load, no actions or console commands",
          capture_ms: 30000, observation_poll_ms: 100, actor_image_interval_ms: runtimeLoad ? null : 1000 };
        const samples: unknown[] = [];
        entry.actor_samples = samples;
        const untilAt = performance.now() + 30000;
        let imageAt = performance.now();
        let continuityChecked = false;
        while (performance.now() < untilAt) {
          assertOpen();
          const observation = await fixture.bridge.observe();
          requireProof(observation.life.status === "alive", "Natural-start capture lost its alive observation scope");
          evidence?.recordObservation(runId, observation);
          scope = { ...scope, life_id: observation.life.life_id, space: observation.space, screen: observation.screen };
          if (!runtimeLoad && performance.now() >= imageAt) {
            samples.push(await image(`actor-sample-${samples.length}`));
            imageAt = performance.now() + 1000;
          }
          if (resultContract && !continuityChecked && requestContinuity.length >= 3 &&
            store!.allSkillExecutions(runId).every(execution => ["succeeded", "failed"].includes(execution.status))) {
            const before = requestContinuity.at(-1)!;
            requireProof(before.worksite && before.subgoal === "Check compact result", "Authored site/subgoal absent before interruption");
            await runtime!.control(runId, "pause");
            const pausedRequests = requestContinuity.length;
            await pause(200);
            requireProof(requestContinuity.length === pausedRequests, "Paused fixture started strategic work");
            await runtime!.control(runId, "resume");
            await until(async () => requestContinuity.length, count => count > pausedRequests, fixture.caps.observationMs, "Explicit Resume did not produce a fresh SDK request");
            const resumed = requestContinuity.at(-1)!;
            requireProof(resumed.observation_seq > before.observation_seq && JSON.stringify(resumed.worksite) === JSON.stringify(before.worksite) &&
              resumed.subgoal === before.subgoal, "Pause/Resume lost authored continuity or fresh observation");
            expectedProviderFailure = true; failSyntheticRequest!();
            await until(async () => runtime!.snapshot()?.status, status => status === "paused", fixture.caps.observationMs, "Offline provider interruption did not pause");
            expectedProviderFailure = false;
            requireProof(runtime!.snapshot()?.operator.pause_cause === "provider_failure", "Offline provider interruption lost its typed cause");
            const failedRequests = requestContinuity.length;
            await pause(200);
            requireProof(requestContinuity.length === failedRequests, "Provider-paused fixture automatically retried");
            await runtime!.control(runId, "resume");
            await until(async () => requestContinuity.length, count => count > failedRequests, fixture.caps.observationMs, "Provider Resume did not produce a fresh request");
            const recovered = requestContinuity.at(-1)!;
            requireProof(recovered.observation_seq > resumed.observation_seq && JSON.stringify(recovered.worksite) === JSON.stringify(before.worksite) &&
              recovered.subgoal === before.subgoal, "Provider recovery lost authored continuity or fresh authority");
            entry.continuity = { before, resumed, recovered, no_automatic_retry: true,
              no_replayed_execution: store!.allSkillExecutions(runId).length === 2, actual_provider_calls: 0 };
            requireProof(store!.allSkillExecutions(runId).length === 2, "Continuity replayed a completed execution");
            continuityChecked = true;
          }
          await pause(100);
        }
        requireProof(fixture.commands.length === 0, "Natural-start capture used evaluator console commands");
        if (runtimeLoad) {
          requireProof(events.some(event => event.event === "synthetic_stream_entered"), "Real Runtime never reached the offline stream");
          if (resultContract) {
            requireProof(continuityChecked, "Integrated Pause/provider continuity was not exercised");
            const roots = store!.allSkillExecutions(runId).filter(execution => !execution.parent_execution_id);
            requireProof(roots.length === 2, "Result fixture did not execute exactly two owned roots");
            const compact = roots.find(execution => execution.result?.summary === "Many owned receipts retained by host");
            const overflow = roots.find(execution => execution.diagnostic?.code === "program_output_limit");
            requireProof(compact?.status === "succeeded" && compact.actions === 56 &&
              (compact.result?.result as { completed?: number })?.completed === 56, "Compact result lost preceding native work");
            requireProof(overflow?.status === "failed" && overflow.actions === 1 &&
              overflow.diagnostic?.output?.phase === "terminal_result", "Native overflow did not retain typed post-effect diagnostic");
            entry.result_contract = { compact, overflow, evaluator_authored: true, provider_calls: 0 };
          }
          await runtime!.control(runId, "stop");
          entry.runtime_journal = await evidence!.finalize(runId, { status: "stopped", reason: "declared_zero_provider_capture_completed" });
        }
      } else {
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
      }
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
      await runtime?.close();
      for (const agent of agents) { agent.abort(); await agent.waitForIdle(); }
      agents.clear();
      if (runtimeRunId && evidence) fixture.report.runtime_journal = await evidence.finalize(runtimeRunId,
        { status: "stopped", reason: failure ? "capture_failed" : "declared_zero_provider_capture_completed" });
      await evidence?.close();
      await sandbox?.close();
      store?.close();
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
