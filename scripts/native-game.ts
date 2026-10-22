import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DiagnosticAgent, DIAGNOSTIC_PROGRAMS, type PlanningDiagnosticProbe } from "../src/evaluation/diagnostic-agent.ts";
import { DEFAULT_EVALUATION_CAPS } from "../src/evaluation/config.ts";
import { NativeFixture, bounded, pause, requireProof, until } from "../src/evaluation/native-game.ts";
import { assertNativeArtifactFresh, requireTierOptIn } from "../src/evaluation/tiers.ts";
import type { Runtime } from "../src/server/runtime.ts";
import type { SandboxService } from "../src/server/sandbox.ts";
import type { Store } from "../src/server/store.ts";
import type { GameAction, GameActionResult, Json, Observation } from "../src/shared/contracts.ts";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
requireTierOptIn("native-game", { allowNative: args.includes("--allow-native") });
const jarFlag = args.indexOf("--jar");
const jar = jarFlag < 0 ? "native/minecraft/build/libs/gameharness-native-1.0.0.jar" : args[jarFlag + 1];
requireProof(jar, "Provide --jar <fresh-built.jar>");
const artifact = assertNativeArtifactFresh(projectRoot, jar);
if (jarFlag >= 0) args.splice(jarFlag, 2);
requireProof(args.every(argument => argument === "--allow-native"), "Native-game accepts only --allow-native and optional --jar; no inference is available");
if (process.env.GAMEHARNESS_PROOF_EXPECTED_JAR_SHA256)
  requireProof(process.env.GAMEHARNESS_PROOF_EXPECTED_JAR_SHA256 === artifact.sha256, "Dispatcher and native entry disagree about the actual built JAR");
process.env.GAMEHARNESS_NATIVE_PROOF = "1";
process.env.GAMEHARNESS_PROOF_EXPECTED_JAR_SHA256 = artifact.sha256;

// Infrastructure-only evaluator sources. These bodies are never delivered to a model.
const guard = 'return typeof context === "undefined" && typeof state === "undefined" && observation.life.status === "alive" && observation.player.health > 0 && args.allow === true;';
const cases = [
  { name: "manual_positive", activation: "manual", allow: true, omitted: false, stop: false, late: false },
  { name: "manual_false_guard", activation: "manual", allow: false, omitted: false, stop: false, late: false },
  { name: "manual_stop_revokes", activation: "manual", allow: true, omitted: false, stop: true, late: false },
  { name: "automatic_staged_before_predecessor", activation: "on_predecessor_success", allow: true, omitted: false, stop: false, late: false },
  { name: "automatic_predecessor_before_staging", activation: "on_predecessor_success", allow: true, omitted: false, stop: false, late: true },
  { name: "automatic_false_guard", activation: "on_predecessor_success", allow: false, omitted: false, stop: false, late: false },
  { name: "automatic_omitted_guard", activation: "on_predecessor_success", allow: true, omitted: true, stop: false, late: false },
  { name: "automatic_stop_revokes_held_request", activation: "on_predecessor_success", allow: true, omitted: false, stop: true, late: false },
] as const;
const caps = DEFAULT_EVALUATION_CAPS;
const fixture = await NativeFixture.create("native-planning-verification", { projectRoot, caps });
let runtime: Runtime | undefined, store: Store | undefined, sandbox: SandboxService | undefined;
let diagnostic: DiagnosticAgent | undefined, activeProbe: PlanningDiagnosticProbe | undefined;
let failure: unknown;
let activeEffects = 0, peakEffects = 0;
const started = performance.now();
interface NativeCall { run_id: string | null; request: GameAction; start_ms: number; end_ms: number | null; result: GameActionResult | null; error: string | null }
interface GuardCall { run_id: string | null; start_ms: number; end_ms: number | null; source: string; source_sha256: string; input: { observation: Observation; args: Json }; result: boolean | null; error: string | null }
interface ObservationReceipt { run_id: string | null; at_ms: number; observation_seq: number; session_id: string; life_id: number }
const effects: NativeCall[] = [], guards: GuardCall[] = [], observations: ObservationReceipt[] = [];
const runIds: string[] = [];
const marks: Array<Record<string, unknown>> = [];
const interrupted = (signal: string) => {
  failure ??= new Error(`Native infrastructure verification interrupted by ${signal}`);
  activeProbe?.release.resolve();
  const current = runtime?.snapshot();
  if (runtime && current) void runtime.control(current.run_id, "stop").catch(() => {});
};
const sigint = () => interrupted("SIGINT"), sigterm = () => interrupted("SIGTERM");
process.once("SIGINT", sigint); process.once("SIGTERM", sigterm);
const totalTimer = setTimeout(() => interrupted("finite entire-process deadline"), caps.totalMs);
try {
  await fixture.start();
  // Intentional loading-boundary test: NativeFixture must set isolated config before these modules read it.
  const { Store } = await import("../src/server/store.ts");
  const { Runtime } = await import("../src/server/runtime.ts");
  const { SandboxService } = await import("../src/server/sandbox.ts");
  store = new Store(fixture.root);
  sandbox = new SandboxService(fixture.project, () => {});
  await bounded(sandbox.prepare(), caps.startMs, "Production Docker isolation preparation timed out");
  requireProof(sandbox.snapshot().status === "ready", "Native-game requires the actual production Docker isolation profile");
  diagnostic = new DiagnosticAgent(store);
  fixture.report.classification = "Infrastructure fixture: real Fabric/Docker/Runtime/Store, strategically synthetic caller, zero providers/Jev, evaluator-owned flat arena, no model authorship/gameplay/learning/promotion/efficiency claim";
  fixture.report.actual_provider_calls = 0;
  fixture.report.actual_jev_calls = 0;
  fixture.report.experience_promotions = 0;
  fixture.report.native_artifact = artifact;
  fixture.report.limits = caps;
  fixture.report.instrumentation = { clock: "same-process monotonic milliseconds only", native_calls: effects, isolated_game_guards: guards, authorized_observations: observations, marks };
  const observe = fixture.bridge.observe.bind(fixture.bridge);
  fixture.bridge.observe = async () => {
    const actual = await observe();
    observations.push({ run_id: runtime?.snapshot()?.run_id ?? null, at_ms: performance.now() - started, observation_seq: actual.observation_seq, session_id: actual.session_id, life_id: actual.life.life_id });
    return actual;
  };
  const execute = fixture.bridge.execute.bind(fixture.bridge);
  fixture.bridge.execute = async (request, signal) => {
    const receipt: NativeCall = { run_id: runtime?.snapshot()?.run_id ?? null, request: structuredClone(request), start_ms: performance.now() - started, end_ms: null, result: null, error: null };
    effects.push(receipt); activeEffects++; peakEffects = Math.max(peakEffects, activeEffects);
    try { receipt.result = await execute(request, signal); return receipt.result; }
    catch (error) { receipt.error = error instanceof Error ? error.message : String(error); throw error; }
    finally { activeEffects--; receipt.end_ms = performance.now() - started; }
  };
  const evaluateGuard = sandbox.evaluateGameGuard.bind(sandbox);
  sandbox.evaluateGameGuard = async (source, observation, args, signal) => {
    const receipt: GuardCall = { run_id: runtime?.snapshot()?.run_id ?? null, start_ms: performance.now() - started, end_ms: null,
      source, source_sha256: createHash("sha256").update(source).digest("hex"), input: structuredClone({ observation, args }), result: null, error: null };
    guards.push(receipt);
    try { receipt.result = await evaluateGuard(source, observation, args, signal); return receipt.result; }
    catch (error) { receipt.error = error instanceof Error ? error.message : String(error); throw error; }
    finally { receipt.end_ms = performance.now() - started; }
  };
  runtime = new Runtime(store, diagnostic.auth(), fixture.bridge, sandbox, () => {}, { adapter_id: "fabric-owned-client" });
  await runtime.initialize();
  for (const scenario of cases) {
    if (failure) break;
    await fixture.case(scenario.name, { verification_tier: "native_game_zero_inference", activation: scenario.activation,
      game_guard: scenario.omitted ? "explicitly omitted" : "original game-only observation,args body", provider_calls: 0,
      predecessor_first: scenario.late, stop_revokes: scenario.stop }, async entry => {
      await fixture.flat();
      const identity = fixture.identity(await fixture.bridge.observe());
      const run = await runtime!.createRun({ task: "Zero-provider native continuation infrastructure diagnostic, not ordinary gameplay", goal: "custom", model_id: diagnostic!.model_id, working_programs: "fresh" });
      runIds.push(run.run_id); entry.run_id = run.run_id;
      activeProbe = diagnostic!.preparePlanning(run.run_id, scenario.omitted ? undefined : guard, scenario.allow, { activation: scenario.activation });
      const probe = activeProbe;
      const rootChoice = diagnostic!.choose(run.run_id, "planning_root");
      await bounded(runtime!.control(run.run_id, "start"), caps.startMs, "Real Runtime could not start the synthetic diagnostic");
      entry.root_admission = await rootChoice;
      const root = store!.latestRootExecution(run.run_id);
      requireProof(root, "The named start did not create a real durable root execution");
      const independent = await bounded(probe.entered.promise, 10_000, "Scheduler did not open the restricted independent request during predecessor activity");
      const heldAt = performance.now() - started;
      entry.actual_speculative_catalog = independent.tools;
      await until(async () => ({ calls: effects.filter(call => call.run_id === run.run_id && call.request.kind === "move"), diagnostics: await fixture.diagnostics() }),
        value => value.calls.length === 2 && value.calls[1]!.end_ms === null && value.diagnostics.motor_active === true && value.diagnostics.controls_neutral === false,
        9_000, "Real predecessor did not continue a second native motor capability while the independent request was held");
      const releasedAt = performance.now() - started;
      const overlapEffects = effects.filter(call => call.run_id === run.run_id && call.start_ms >= heldAt && call.start_ms <= releasedAt);
      const overlapObservations = observations.filter(receipt => receipt.run_id === run.run_id && receipt.at_ms >= heldAt && receipt.at_ms <= releasedAt);
      requireProof(overlapEffects.length > 0 && overlapObservations.length > 0, "No actual root API activity overlapped the held independent request");
      entry.held_request_overlap = { held_at_ms: heldAt, overlap_sample_at_ms: releasedAt, native_calls: overlapEffects, observations: overlapObservations };
      if (scenario.activation === "on_predecessor_success" && scenario.stop) {
        const beforeStop = effects.length;
        await runtime!.control(run.run_id, "stop");
        probe.release.resolve();
        await pause(400);
        const plan = runtime!.planningView(run.run_id);
        entry.revoked_plan = plan;
        requireProof(plan?.state === "invalidated" && plan.activation_permit === "revoked" && effects.length === beforeStop
          && store!.allSkillExecutions(run.run_id).length === 1 && guards.filter(call => call.run_id === run.run_id).length === 0,
          "Stop failed to revoke the automatic permit and held planning request before guard/effect admission");
      } else {
        if (scenario.late) {
          await until(async () => store!.skillExecution(run.run_id, { execution_id: root.execution_id }), execution => execution?.status === "succeeded", 10_000, "Predecessor-first case lacked actual successful worker closure before staging");
          requireProof(store!.allSkillExecutions(run.run_id).length === 1, "No candidate existed yet, but a successor was admitted");
        }
        const lastBeforeValidation = observations.at(-1)?.observation_seq ?? 0;
        probe.release.resolve();
        entry.staged_receipt = await bounded(probe.staged.promise, 5_000, "Restricted prepare_next did not stage its named candidate");
        const pinned = runtime!.planningView(run.run_id);
        requireProof(pinned?.candidate, "Prepared next did not pin an exact validated source");
        const exact = store!.skill(run.run_id, pinned.candidate);
        requireProof(exact.hash === pinned.candidate.hash && exact.name === DIAGNOSTIC_PROGRAMS.followup && exact.dependencies.length === 0 && exact.state === "validated", "Prepared source/dependency closure differs from the selected named immutable source");
        if (scenario.activation === "manual") {
          await until(async () => store!.skillExecution(run.run_id, { execution_id: root.execution_id }), execution => execution?.status === "succeeded", 10_000, "Manual predecessor did not successfully close its real worker");
          await until(async () => runtime!.planningView(run.run_id), plan => plan?.state === "staged" && plan.planning_active === false, 5_000, "Manual independent request did not settle while retaining its prepared candidate");
          requireProof(store!.allSkillExecutions(run.run_id).length === 1 && effects.filter(call => call.run_id === run.run_id).length === 2, "Manual staging/predecessor closure activated effects without a deliberate main choice");
          if (scenario.stop) {
            entry.captured_activation = await diagnostic!.choose(run.run_id, "planning_capture");
            requireProof(probe.capturedActivate, "Actual main execution-control tool could not be captured");
            await runtime!.control(run.run_id, "stop");
            const count = effects.length;
            const result = await bounded(probe.capturedActivate(), 5_000, "Stale captured main tool did not settle after Stop") as { isError?: boolean };
            entry.stopped_activation_rejection = result;
            requireProof(result.isError === true && runtime!.planningView(run.run_id)?.state === "invalidated" && effects.length === count
              && store!.allSkillExecutions(run.run_id).length === 1 && guards.filter(call => call.run_id === run.run_id).length === 0,
              "Stop failed to fence the previously offered actual main activation tool");
          } else entry.manual_activation = await diagnostic!.choose(run.run_id, "planning_activate");
        }
        if (!scenario.stop) {
          const plan = await until(async () => runtime!.planningView(run.run_id), current => current?.state === (scenario.allow ? "activated" : "rejected"), 15_000, "Prepared continuation did not reach its declared bounded terminal admission result");
          requireProof(plan && plan.predecessor_closed && plan.observation_seq !== null && plan.observation_seq > lastBeforeValidation, "Activation lacked successful predecessor drain and a fresh authorized observation");
          entry.final_plan = plan;
          const actualGuards = guards.filter(call => call.run_id === run.run_id);
          requireProof(actualGuards.length === (scenario.omitted ? 0 : 1), "Omitted guard was invented or original guard was not evaluated exactly once");
          if (scenario.omitted) requireProof(plan.guard_status === "omitted" && plan.guard_hash === null, "Guard omission was not explicitly preserved");
          else {
            const actual = actualGuards[0]!;
            requireProof(actual.source === guard && actual.error === null && actual.result === scenario.allow
              && actual.input.observation.session_id === identity.session_id && actual.input.observation.life.life_id === identity.life_id
              && actual.input.observation.observation_seq === plan.observation_seq
              && JSON.stringify(actual.input.args) === JSON.stringify({ allow: scenario.allow }), "Actual isolated game guard lost source integrity, game-only input or fresh same-life authority");
          }
          if (scenario.allow) {
            requireProof(plan.activation_execution_id && plan.activation_trigger === (scenario.activation === "manual" ? "manual" : "automatic"), "Activation evidence does not identify the actual permitted trigger");
            if (scenario.activation === "on_predecessor_success") requireProof(plan.activation_permit === "consumed", "Automatic activation did not consume its one-use main authorization");
            const followup = await until(async () => store!.skillExecution(run.run_id, { execution_id: plan.activation_execution_id! }), execution => execution?.status === "succeeded", 10_000, "Exact admitted follow-up did not succeed through the real sandbox/arbiter/native stack");
            const actualEffects = effects.filter(call => call.run_id === run.run_id);
            requireProof(followup?.skill_id === exact.skill_id && followup.version === exact.version && followup.session_id === identity.session_id && followup.life_id === identity.life_id
              && actualEffects.length === 3 && actualEffects[2]!.request.kind === "look" && actualEffects[2]!.result?.status === "succeeded", "Actual successor source/session/life/native effect receipts differ from the prepared admission");
            entry.followup = followup;
          } else requireProof(plan.reason === "guard_failed" && plan.guard_status === "failed" && plan.activation_execution_id === null
            && store!.allSkillExecutions(run.run_id).length === 1 && effects.filter(call => call.run_id === run.run_id).length === 2, "False isolated game guard granted a successor or native effect");
          await runtime!.control(run.run_id, "stop");
        }
      }
      requireProof(!store!.eventsAfter(run.run_id, 0, caps.eventPageRecords).some(event => event.type === "goal.verified"), "Infrastructure completion was misreported as gameplay goal verification");
      const frames = fixture.frames;
      await pause(350);
      fixture.sameSession(identity, await fixture.bridge.observe());
      requireProof(fixture.frames > frames && peakEffects === 1 && activeEffects === 0 && (await fixture.diagnostics()).controls_neutral === true, "Native continuity, exclusive effect ownership or final input neutralization was not confirmed");
      entry.actual_new_frames = fixture.frames - frames;
      entry.goal_verified = false;
      entry.frame = await fixture.frame(scenario.name);
      marks.push({ phase: "case_pass", scenario: scenario.name, run_id: run.run_id, at_ms: performance.now() - started });
    });
    activeProbe?.release.resolve();
    const current = runtime.snapshot();
    if (current && !["stopped", "completed", "failed"].includes(current.status)) await bounded(runtime.control(current.run_id, "stop"), caps.cleanupMs, "Case cleanup could not fence the current real task");
    if (fixture.cases.at(-1)?.status !== "passed") break;
  }
} catch (error) { failure ??= error; }
finally {
  clearTimeout(totalTimer); process.off("SIGINT", sigint); process.off("SIGTERM", sigterm);
  activeProbe?.release.resolve();
  const originalFailure = fixture.cases.find(entry => entry.status === "failed")?.error;
  if (!failure && typeof originalFailure === "string") failure = new Error(originalFailure);
  try {
    const runtimeClosed = runtime ? await bounded(runtime.close(), caps.cleanupMs, "Runtime cleanup timed out").then(() => true, error => { fixture.report.runtime_cleanup_error = String(error); return false; }) : true;
    const dockerClosed = sandbox ? await bounded(sandbox.close(), caps.cleanupMs, "Docker cleanup timed out").then(() => true, error => { fixture.report.docker_cleanup_error = String(error); return false; }) : true;
    fixture.report.runtime_cleanup = runtimeClosed && dockerClosed && activeEffects === 0;
    fixture.report.peak_simultaneous_native_effects = peakEffects;
    if (!fixture.report.runtime_cleanup) failure ??= new Error("Runtime/Docker/effect cleanup was not confirmed");
    if (store) await writeFile(join(fixture.evidenceDirectory, "native-planning-ledger.json"), JSON.stringify({ classification: fixture.report.classification,
      runs: runIds.map(id => ({ run: store!.getRun(id), events: store!.eventsAfter(id, 0, caps.eventPageRecords), executions: store!.allSkillExecutions(id), planning: runtime!.planningView(id), trace: store!.tracePage(id) })), effects, guards, observations, marks }, null, 2), { mode: 0o600, flag: "wx" });
    if (diagnostic) {
      fixture.report.diagnostic = { actual_provider_calls: 0, actual_jev_calls: 0, synthetic_gate_admissions: diagnostic.synthetic_gate_admissions, sdk_setTools_used: diagnostic.transcript.some(entry => entry.type === "synthetic_sdk_tools_set"), usage_admissions_are_synthetic_not_provider_measurements: true };
      await writeFile(join(fixture.evidenceDirectory, "synthetic-caller-transcript.json"), JSON.stringify(diagnostic.transcript, null, 2), { mode: 0o600, flag: "wx" });
    }
  } catch (error) { fixture.report.cleanup_reporting_error = String(error); failure ??= error; }
  finally {
    try { store?.close(); } catch (error) { failure ??= error; fixture.report.store_cleanup_error = String(error); }
    await fixture.finish(failure);
    fixture.report.verification_result = fixture.report.pass === true && fixture.report.runtime_cleanup === true && fixture.cases.length === cases.length ? "PASS" : "FAIL";
    await fixture.flush();
    console.log(JSON.stringify({ verification_tier: "native-game", result: fixture.report.verification_result, report: join(fixture.evidenceDirectory, "report.json"), cleanup: fixture.report.cleanup, actual_provider_calls: 0 }));
    if (fixture.report.verification_result !== "PASS") process.exitCode = 1;
  }
}
