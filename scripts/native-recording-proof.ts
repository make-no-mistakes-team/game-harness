import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as postmortem from "@oh-my-pi/pi-utils/postmortem";
import { ActorFrameSelector, type FrameScope } from "../src/server/actor-frames.ts";
import { EpisodeRecorder, type RecorderHealth } from "../src/server/recording.ts";
import { NativeFixture, bounded, requireProof } from "../src/evaluation/native-game.ts";
import { assertNativeArtifactFresh, requireTierOptIn } from "../src/evaluation/tiers.ts";
import { NATURAL_WORLD_CONDITIONS } from "../src/evaluation/scenarios.ts";
import { createEvaluationCaps, DEFAULT_EVALUATION_CAPS, loadEvidenceProfile } from "../src/evaluation/config.ts";
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
  const seen = new Set<string>();
  let jar: string | undefined, evidenceFilename: string | undefined, requestedDuration: number | undefined;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    requireProof(!seen.has(flag), "Duplicate recorder proof argument");
    seen.add(flag);
    if (["--jar", "--duration-ms", "--evidence-profile"].includes(flag)) {
      const value = args[++index];
      requireProof(value && !value.startsWith("--"), `Missing value for ${flag}`);
      if (flag === "--jar") jar = value;
      else if (flag === "--evidence-profile") evidenceFilename = value;
      else {
        requestedDuration = Number(value);
        requireProof(/^\d+$/.test(value) && Number.isSafeInteger(requestedDuration) &&
          requestedDuration >= 1000 && requestedDuration <= 1800000, "--duration-ms must be an integer from 1000 through 1800000");
      }
    } else requireProof(["--allow-native", "--natural-start", "--runtime-load", "--result-contract"].includes(flag),
      "Unknown recorder proof argument; no inference/auth/login flags are accepted");
  }
  requireTierOptIn("native-game", { allowNative: args.includes("--allow-native") });
  requireProof(jar, "Pass --jar <fresh-built.jar>");
  const naturalStart = seen.has("--natural-start"), runtimeLoad = seen.has("--runtime-load"), resultContract = seen.has("--result-contract");
  requireProof(!runtimeLoad || naturalStart, "--runtime-load requires --natural-start");
  requireProof(!resultContract || runtimeLoad, "--result-contract requires --runtime-load");
  const sustainedRuntime = runtimeLoad && requestedDuration !== undefined;
  requireProof((requestedDuration ?? 0) < 1200000 || evidenceFilename !== undefined,
    "A 20–30 minute proof requires an explicit complete evidence profile");
  const evidenceProfile = loadEvidenceProfile(project, evidenceFilename);
  const finalHoldMs = requestedDuration === undefined ? 0 : 100;
  const captureMs = requestedDuration === undefined ? (naturalStart ? 30000 : null) : Math.max(requestedDuration, resultContract ? 30000 : 0);
  const runMs = (captureMs ?? 0) + finalHoldMs + DEFAULT_EVALUATION_CAPS.observationMs * 8;
  const declaredCaps = requestedDuration === undefined
    ? naturalStart ? createEvaluationCaps({ runMs: 60000, totalMs: 300000 }) : createEvaluationCaps()
    : createEvaluationCaps({ runMs,
    totalMs: DEFAULT_EVALUATION_CAPS.startMs * (runtimeLoad ? 2 : 1) + runMs +
      DEFAULT_EVALUATION_CAPS.observationMs * 12 + evidenceProfile.profile.render_timeout_ms +
      DEFAULT_EVALUATION_CAPS.diagnosticsMs + DEFAULT_EVALUATION_CAPS.cleanupMs });
  // The recorder stays open through mandatory technical work, not only the
  // requested wait. The existing run allowance includes phase work and final
  // hold; use that same complete scope for duration and nominal frame admission.
  const captureScopeMs = declaredCaps.runMs;
  const minimumCaptureFrames = Math.ceil(captureScopeMs * 30 / 1000) + 1;
  requireProof(evidenceProfile.profile.recording.maxDurationMs >= captureScopeMs &&
    evidenceProfile.profile.recording.maxFrames >= minimumCaptureFrames,
  "Evidence profile cannot cover the complete admitted capture scope, phase allowance, final hold and nominal 30 Hz frames");
  const entireSampleStarted = performance.now();
  const artifact = assertNativeArtifactFresh(project, jar);
  if (process.env.GAMEHARNESS_PROOF_EXPECTED_JAR_SHA256)
    requireProof(process.env.GAMEHARNESS_PROOF_EXPECTED_JAR_SHA256 === artifact.sha256, "Dispatcher and recorder proof disagree about the built native artifact");
  process.env.GAMEHARNESS_NATIVE_PROOF = "1";
  process.env.GAMEHARNESS_PROOF_EXPECTED_JAR_SHA256 = artifact.sha256;
  const fixture = await NativeFixture.create("native-recording-proof", { projectRoot: project, caps: declaredCaps,
    ...(naturalStart ? { conditions: { ...NATURAL_WORLD_CONDITIONS, seed: "1" } } : {}) });
  fixture.report.native_artifact = artifact;
  fixture.report.evidence_profile = evidenceProfile;
  fixture.report.capture_declaration = { requested_duration_ms: requestedDuration ?? null, final_hold_ms: finalHoldMs,
    minimum_capture_ms: captureMs,
    admitted_capture_scope_ms: captureScopeMs, minimum_nominal_frames: minimumCaptureFrames,
    explicit_capture_setup_and_phase_allowance_ms: requestedDuration === undefined ? null : DEFAULT_EVALUATION_CAPS.observationMs * 8,
    natural_start_default_ms: naturalStart ? 30000 : null, caps: declaredCaps,
    entire_sample_allowance_ms: declaredCaps.totalMs, timing: "One entire-sample deadline including setup, capture, renderer, probe and cleanup" };
  if (naturalStart) {
    fixture.report.classification = "zero_provider_natural_start_recording_infrastructure_not_autonomous_gameplay";
    fixture.report.provider_calls = 0;
  }
  let recorder: EpisodeRecorder | undefined, failure: unknown, endedAt = 0;
  let captureTimer: ReturnType<typeof setTimeout> | undefined;
  let runtime: Runtime | undefined, store: Store | undefined, sandbox: SandboxService | undefined;
  let evidence: ModelProgramEvidence | undefined, runtimeRunId: string | undefined;
  const agents = new Set<Agent>();
  const requestContinuity: Array<{ observation_seq: number; subgoal: string | null; worksite: unknown }> = [];
  let failSyntheticRequest: (() => void) | undefined, completeSyntheticRequest: (() => void) | undefined, expectedProviderFailure = false;
  const proofScope = new AbortController();
  const pause = (ms: number) => new Promise<void>((resolve, reject) => {
    if (proofScope.signal.aborted) { reject(proofScope.signal.reason); return; }
    const aborted = () => { clearTimeout(timer); reject(proofScope.signal.reason); };
    const timer = setTimeout(() => { proofScope.signal.removeEventListener("abort", aborted); resolve(); }, ms);
    proofScope.signal.addEventListener("abort", aborted, { once: true });
  });
  const until = async <T>(read: () => T | Promise<T>, accepts: (value: T) => boolean, ms: number, message: string): Promise<T> => {
    const end = performance.now() + ms;
    while (performance.now() < end) {
      proofScope.signal.throwIfAborted();
      const value = await bounded(Promise.resolve().then(read), Math.max(1, end - performance.now()), message);
      proofScope.signal.throwIfAborted();
      if (accepts(value)) return value;
      await pause(Math.min(50, Math.max(1, end - performance.now())));
    }
    throw new Error(message);
  };
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
    const budget = Math.max(1, Math.min(fixture.caps.cleanupMs, signalExit ? 9000 : fixture.caps.cleanupMs,
      fixture.caps.totalMs - (performance.now() - entireSampleStarted)));
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
  const deadline = setTimeout(() => interrupted("entire_sample_deadline"),
    Math.max(1, fixture.caps.totalMs - (performance.now() - entireSampleStarted)));
  const assertOpen = () => requireProof(!proofScope.signal.aborted && !failure, "Recorder proof scope closed");
  try {
    assertOpen(); await flush(); assertOpen(); await fixture.start(); assertOpen();
    if (!naturalStart) { await fixture.flat(); assertOpen(); }
    fixture.report.native_configuration = await fixture.diagnostics();
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
        if (sustainedRuntime && !resultContract) {
          requireProof(++syntheticCalls === 1, "Long recording scope cannot chain synthetic idle requests");
          const message: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider,
            model: model.id, stopReason: "stop", timestamp: Date.now(),
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
          events.push({ type: "start", partial: message });
          events.push({ type: "done", reason: "stop", message }); events.end();
          mark("synthetic_tool_free_stream_completed", { actual_provider_calls: 0 });
          return events;
        }
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
        completeSyntheticRequest = () => {
          const message: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider,
            model: model.id, stopReason: "stop", timestamp: Date.now(),
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
          options?.signal?.removeEventListener("abort", abort);
          events.push({ type: "done", reason: "stop", message }); events.end();
          mark("synthetic_tool_free_stream_completed", { actual_provider_calls: 0 });
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
      evidence = new evidenceModule.ModelProgramEvidence(store, fixture.evidenceDirectory, fixture.caps, `offline-${randomUUID()}`, stop,
        { limits: evidenceProfile.profile.journal });
      evidence.observeAuthAgents(auth);
      runtime = new runtimeModule.Runtime(store, auth, fixture.bridge, sandbox, () => {}, { adapter: () => fixture.bridge.adapter(), actorFrames: fixture.bridge });
      await runtime.initialize(); evidence.bindRuntime(runtime);
      const goal = fixture.bridge.adapter()?.goals.find(goal => goal.goal_id === "custom" && goal.verifier === null);
      requireProof(goal, "Custom infrastructure goal unavailable");
      const run = await runtime.createRun({ task: "Disclosed zero-provider recorder workload; no gameplay objective or supplied strategy",
        goal, model_id: model.id, working_programs: "fresh" });
      runId = run.run_id; runtimeRunId = runId;
      fixture.report.runtime_load = { synthetic_provider_transport: true, actual_provider_calls: 0, real_sdk_runtime_store_journal: true,
        scope: sustainedRuntime ? "Initial normally completed real SDK synthetic context (plus disclosed result-contract mechanics when requested); then explicitly paused Runtime with sustained authorized observation/journal/actor-image/PNG workload, not continuous thinking or gameplay"
          : "Short real SDK/context workload with abortable synthetic transport",
        real_sandbox_prepared: true, worker_effects: resultContract ? "Evaluator-authored neutral look receipts, not gameplay" : 0,
        result_contract: resultContract, run_id: runId, model_descriptor_only: model.id };
    }
    let scope: FrameScope = { run_id: runId, world_id: initial.world_id, session_id: initial.session_id,
      epoch: initial.epoch, life_id: initial.life.life_id, generation: 1, native_boot_id: initial.native_boot_id,
      compatibility_hash: initial.compatibility_hash, space: initial.space, screen: initial.screen };
    const selector = new ActorFrameSelector({ latestFrame: () => fixture.bridge.latestFrame(), scope: () => scope });
    const entry: Record<string, unknown> = { name: runtimeLoad ? "natural_start_runtime_capture_load" : naturalStart ? "natural_start_capture_actor_observation_load" : "delivered_frames_menu_wait_interrupt_respawn",
      conditions: { provider_calls: 0, model_inference: "disabled", replay_timing: replayTiming,
        evidence_profile: evidenceProfile, requested_duration_ms: requestedDuration ?? null, final_hold_ms: finalHoldMs,
        classification: "Privileged evaluator-owned native recording/image infrastructure only; no natural gameplay or live vision claim" },
      status: "running", started_at: new Date().toISOString() };
    fixture.cases.push(entry);
    const caseStarted = performance.now();
    let firstCaptureReceivedAt: number | undefined;
    const healthSamples: Array<{ elapsed_ms: number; health: RecorderHealth }> = [];
    entry.recorder_health_samples = healthSamples;
    entry.recording_capture_mode = "live_compressed";
    // This proof owns its failure path. Do not enter NativeFixture.case's
    // synchronous failure-frame FFmpeg capture after the proof scope is revoked.
    try {
      assertOpen();
      if (requestedDuration !== undefined)
        captureTimer = setTimeout(() => interrupted("capture_scope_deadline"), fixture.caps.runMs);
      recorder = new EpisodeRecorder({ directory: path.join(fixture.evidenceDirectory, "recording"),
        bridge: { subscribeFrames(callback) {
          return fixture.bridge.subscribeFrames(frame => {
            firstCaptureReceivedAt ??= performance.now();
            callback(frame);
          });
        } },
        limits: evidenceProfile.profile.recording,
        identity: { episode_id: randomUUID(), run_id: runId, world_id: initial.world_id, session_id: initial.session_id },
        onIncomplete: why => { failure ??= new Error(why); proofScope.abort(); } });
      if (runtimeLoad) await runtime!.control(runId, "start");
      if (sustainedRuntime && !resultContract) {
        const turnQueryOptions = { signal: proofScope.signal, deadlineHostMs: Math.min(
          entireSampleStarted + fixture.caps.totalMs, performance.now() + fixture.caps.observationMs) };
        await until(() => evidence!.eventCount(runId, "scheduler.turn_finished", undefined, turnQueryOptions),
          count => count > 0, fixture.caps.observationMs,
          "Initial tool-free SDK turn did not settle normally");
        assertOpen();
        await runtime!.control(runId, "pause");
        mark("long_runtime_explicit_idle_after_settled_turn");
      }
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
          classification: resultContract ? "Zero-provider real Runtime/SDK/context/journal capture load with disclosed evaluator-authored neutral-look result/continuity mechanics, no gameplay or console commands"
            : runtimeLoad ? "Zero-provider real Runtime/SDK/context/journal capture load, no actions or console commands"
            : "Zero-provider fresh seed1 capture/actor-image load, no actions or console commands",
          capture_ms: captureMs, requested_duration_ms: requestedDuration ?? null, final_hold_ms: finalHoldMs,
          evidence_profile: evidenceProfile, observation_poll_ms: 100, actor_image_interval_ms: runtimeLoad && !sustainedRuntime ? null : 1000 };
        const samples: unknown[] = [];
        entry.actor_samples = samples;
        if (requestedDuration !== undefined)
          await until(() => firstCaptureReceivedAt, value => value !== undefined, fixture.caps.observationMs, "No first capture arrived");
        const untilAt = requestedDuration === undefined ? performance.now() + 30000 : firstCaptureReceivedAt! + captureMs!;
        let imageAt = performance.now();
        let healthAt = performance.now();
        let continuityChecked = false;
        while (performance.now() < untilAt) {
          assertOpen();
          const observation = await fixture.bridge.observe();
          requireProof(observation.life.status === "alive", "Natural-start capture lost its alive observation scope");
          evidence?.recordObservation(runId, observation);
          scope = { ...scope, life_id: observation.life.life_id, space: observation.space, screen: observation.screen };
          if (performance.now() >= healthAt) {
            healthSamples.push({ elapsed_ms: performance.now() - caseStarted, health: recorder.health() });
            healthAt = performance.now() + 1000;
          }
          if ((!runtimeLoad || sustainedRuntime) && performance.now() >= imageAt) {
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
            if (sustainedRuntime) {
              const turnQueryOptions = { signal: proofScope.signal, deadlineHostMs: Math.min(
                entireSampleStarted + fixture.caps.totalMs, performance.now() + fixture.caps.observationMs) };
              const previousTurns = await evidence!.eventCount(runId, "scheduler.turn_finished", undefined, turnQueryOptions);
              assertOpen();
              completeSyntheticRequest!();
              await until(() => evidence!.eventCount(runId, "scheduler.turn_finished", undefined, turnQueryOptions),
                count => count > previousTurns, fixture.caps.observationMs, "Recovered synthetic SDK turn did not settle normally");
              assertOpen();
              await runtime!.control(runId, "pause");
              mark("long_runtime_explicit_idle_after_settled_turn");
            }
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
          entry.runtime_journal = await evidence!.finalize(runId, { status: "stopped", reason: "declared_zero_provider_capture_completed" },
            { signal: proofScope.signal, deadlineHostMs: entireSampleStarted + fixture.caps.totalMs });
          assertOpen();
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
      if (requestedDuration !== undefined) {
        await until(() => firstCaptureReceivedAt, value => value !== undefined, fixture.caps.observationMs, "No first capture arrived");
        const captureDeadline = firstCaptureReceivedAt! + requestedDuration;
        let healthAt = performance.now();
        while (performance.now() < captureDeadline) {
          assertOpen();
          const observation = await fixture.bridge.observe();
          requireProof(observation.life.status === "alive", "Extended capture lost its alive observation scope");
          evidence?.recordObservation(runId, observation);
          if (performance.now() >= healthAt) {
            healthSamples.push({ elapsed_ms: performance.now() - caseStarted, health: recorder.health() });
            healthAt = performance.now() + 1000;
          }
          await pause(Math.min(100, Math.max(1, captureDeadline - performance.now())));
        }
        mark("requested_capture_window_completed", { requested_duration_ms: requestedDuration });
        await pause(finalHoldMs); assertOpen();
        mark("declared_final_hold_completed", { final_hold_ms: finalHoldMs });
      }
      endedAt = Date.now(); mark("capture_finished");
      clearTimeout(captureTimer);
      const recording = await recorder!.finish({ endedAt, reason: "declared_native_proof_completed" });
      entry.recording = recording;
      requireProof(recording.status === "complete", "Recording evidence is incomplete");
      assertOpen();
      entry.replay = await recorder!.renderReplay({ signal: proofScope.signal, timeoutMs: evidenceProfile.profile.render_timeout_ms });
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
      requireProof(records.length > 0, "No captured frames were durably indexed");
      const expectedMs = endedAt - records[0]!.captured_at;
      let interval = 0;
      for (let index = 1; index < records.length; index++)
        interval = Math.max(interval, records[index]!.captured_at - records[index - 1]!.captured_at);
      entry.replay_timing = { expected_ms: expectedMs, actual_ms: replayMs, ...replayTiming, maximum_observed_gap_ms: interval,
        requested_duration_ms: requestedDuration ?? null, final_hold_ms: endedAt - records.at(-1)!.captured_at,
        declared_final_hold_ms: finalHoldMs, indexed_frames: records.length, manifest_stored_frames: recording.stored_frames,
        index_agrees_with_manifest: records.length === recording.stored_frames,
        events, audio: "not_recorded", visual_inspection: "Parent must inspect actual replay/menu/wait/interruption/respawn; duration alone is not visual proof" };
      requireProof(Number.isFinite(replayMs) && Math.abs(replayMs - expectedMs) <= replayTiming.tolerance_ms, "Replay compressed or stretched capture time beyond the predeclared nominal 30 Hz interval plus 100 ms");
      requireProof(records.length === recording.stored_frames, "Durable frame index disagrees with recording manifest");
      requireProof(requestedDuration === undefined || expectedMs >= requestedDuration, "Actual indexed capture is shorter than the requested duration");
      entry.status = "passed";
    } catch (error) {
      entry.status = "failed"; entry.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally { entry.elapsed_ms = performance.now() - caseStarted; }
  } catch (error) { failure ??= error; }
  finally {
    clearTimeout(deadline); clearTimeout(captureTimer);
    proofScope.abort(failure ?? new Error("Recorder proof scope closed"));
    armCleanup();
    try {
      await runtime?.close();
      for (const agent of agents) { agent.abort(); await agent.waitForIdle(); }
      agents.clear();
      const evidenceErrors: unknown[] = [];
      try {
        if (runtimeRunId && evidence) fixture.report.runtime_journal = await evidence.finalize(runtimeRunId,
          { status: "stopped", reason: failure ? "capture_failed" : "declared_zero_provider_capture_completed" },
          { deadlineHostMs: cleanupDeadline });
      } catch (error) { evidenceErrors.push(error); }
      finally {
        // Runtime does not own the observer's independent readonly child.
        try { await evidence?.close({ deadlineHostMs: cleanupDeadline }); }
        catch (error) { evidenceErrors.push(error); }
      }
      if (evidenceErrors.length) {
        fixture.report.runtime_evidence_failures = evidenceErrors.map(error => error instanceof Error ? error.message : String(error));
        failure ??= evidenceErrors.length === 1 ? evidenceErrors[0] :
          new AggregateError(evidenceErrors, "Runtime evidence finalization and closure failed");
      }
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
      cleanup.confirmed = !cleanup.deadline_reached && !fixture.report.recorder_report_persistence_failed &&
        evidenceErrors.length === 0 && fixture.report.cleanup === true;
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
