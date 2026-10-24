import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as postmortem from "@oh-my-pi/pi-utils/postmortem";
import { controllerManifestHash, validateControllerManifest } from "../src/shared/controllers.ts";
import { evaluationPaths } from "../src/evaluation/paths.ts";
import { StudyLedger, readRegisteredStudy, validateStudyManifest, type AttemptReservation } from "../src/evaluation/studies.ts";
import { referenceFileIdentity, runReferenceScreen, type ReferenceGovernance } from "../src/evaluation/policy-reference.ts";

const help = `Original STEVE-1 synchronous reference, zero providers.
Register after trusted preparation and source freeze:
  bun scripts/policy-reference.ts register --study-manifest <private-study.json>
Execute exactly its declared slot:
  bun scripts/policy-reference.ts run --study <id> --study-manifest <same-study.json> --slot '<StudySlot JSON>' --controller <private-controller.json> --prepared-root <verified-inputs> --fixtures-root <private-world-zips> --output <new-private-directory> --allow-native --allow-inference
The trusted entry must run in an enforced cgroup-v2 scope: MemoryMax=512M, TasksMax=32, CPUQuota=100%.
The reference variant must be supported by the existing StudyLedger; this entry never bypasses its validator or creates another ledger.`;

export async function runPolicyReference(args: readonly string[], projectRoot = fileURLToPath(new URL("..", import.meta.url))) {
  const executingRoot = fileURLToPath(new URL("..", import.meta.url));
  if (resolve(projectRoot) !== resolve(executingRoot)) throw new Error("Reference source authority must be the executing CLI module tree; projectRoot overrides are unsupported");
  const input = [...args];
  const mode = input.shift();
  if (!mode || mode === "--help" || mode === "help") { console.log(help); return 0; }
  if (mode !== "register" && mode !== "run") throw new Error("Choose register or run; no implicit model/game execution");
  const values = new Map<string, string>();
  const flags = new Set<string>();
  while (input.length) {
    const key = input.shift()!;
    if (["--allow-native", "--allow-inference"].includes(key)) {
      if (flags.has(key)) throw new Error(`Duplicate ${key}`);
      flags.add(key); continue;
    }
    if (!["--study", "--study-manifest", "--slot", "--controller", "--prepared-root", "--fixtures-root", "--output"].includes(key)
      || values.has(key) || !input[0] || input[0]!.startsWith("--")) throw new Error(`Unexpected/missing/duplicate reference argument ${key}`);
    values.set(key, input.shift()!);
  }
  const required = (name: string): string => {
    const value = values.get(name); if (!value) throw new Error(`Provide ${name}`); return value;
  };
  const studyPath = resolve(projectRoot, required("--study-manifest"));
  await referenceFileIdentity(studyPath);
  const study = validateStudyManifest(JSON.parse(await readFile(studyPath, "utf8")), { projectRoot });
  if (study.admission_mode !== "live" || study.execution.controller_mode !== "released_policy_reference"
    || study.execution.start_mode !== "declared_reference_fixture" || study.execution.request_paths.length || study.identities.model !== null
    || study.arms.some(arm => arm.model !== null) || study.allowances.per_attempt.host_requests !== 0 || study.allowances.cohort.host_requests !== 0
    || study.schedule.length !== 1 || study.repetitions !== 1 || study.optional_blocks.length !== 0 || study.arms.length !== 1 || study.initial_states.length !== 1)
    throw new Error("Only the immutable one-slot original STEVE reference declaration is admitted here");
  const ledger = new StudyLedger(evaluationPaths(projectRoot).governanceRoot, { projectRoot });
  let reservation: AttemptReservation | undefined;
  let terminal = false;
  let entryCompletion: (() => void) | undefined;
  try {
    if (mode === "register") {
      if (values.size !== 1 || flags.size) throw new Error("Registration cannot enable external resources");
      console.log(JSON.stringify({ study: ledger.registerStudy(study), execution: "not_run" }));
      return 0;
    }
    if (!flags.has("--allow-native") || !flags.has("--allow-inference")) throw new Error("Reference execution requires both explicit native and local-inference opt-ins");
    const selection = { studyId: required("--study"), manifestPath: studyPath, slot: JSON.parse(required("--slot")) };
    const registered = readRegisteredStudy(ledger, selection, projectRoot);
    const controllerPath = resolve(projectRoot, required("--controller"));
    const controllerFile = study.identities.controller;
    if (!controllerFile || resolve(projectRoot, controllerFile.path) !== controllerPath
      || (await referenceFileIdentity(controllerPath)).sha256 !== controllerFile.sha256) throw new Error("Registered controller file identity mismatch");
    const manifest = validateControllerManifest(JSON.parse(await readFile(controllerPath, "utf8")));
    if (!manifest.execution) throw new Error("Reference controller has no frozen execution inputs");
    const abort = new AbortController();
    const completed = Promise.withResolvers<void>();
    const unregisterCleanup = postmortem.register(`reference-entry-${study.study_id}`, reason => {
      const signal = reason === postmortem.Reason.SIGINT ? "SIGINT" : reason === postmortem.Reason.SIGTERM ? "SIGTERM" : String(reason);
      abort.abort(new Error(`Operator ${signal}`));
      if (reservation && !terminal) { ledger.interruptStudyAttempt(reservation, `Operator ${signal}`); terminal = true; }
      return completed.promise;
    }, { exitOnly: true });
    entryCompletion = () => { completed.resolve(); unregisterCleanup(); };
    let wallTimer: ReturnType<typeof setTimeout> | undefined;
    const outputRoot = resolve(projectRoot, required("--output"));
    const governance: ReferenceGovernance = {
      async reserve(hash) {
        if (hash !== controllerManifestHash(manifest)) throw new Error("Controller changed before reservation");
        reservation = ledger.reserveStudyAttempt(registered.ref, selection.slot, { reportDirectory: outputRoot });
        const state = ledger.readStudy(registered.ref);
        const remaining = Math.min(study.allowances.per_attempt.wall_ms, state.registeredAt + study.allowances.cohort.elapsed_ms - Date.now(), manifest.limits.total_wall_ms);
        if (remaining <= 0) throw new Error("Study wall allowance already exhausted");
        wallTimer = setTimeout(() => abort.abort(new Error("Study wall allocation deadline")), remaining);
        return { reservationId: reservation.reservationId };
      },
      async settle(result, evidence) {
        if (!reservation) throw new Error("No durable reference reservation");
        if (terminal) return; // An SDK signal already durably interrupted this reservation.
        if (abort.signal.aborted && !/deadline|allocation|timeout/i.test(String(abort.signal.reason))) {
          ledger.interruptStudyAttempt(reservation, String(abort.signal.reason)); terminal = true; return;
        }
        const platformPass = result.setup_status === "passed" && result.terminal === "completed" && result.cleanup === "confirmed" && result.failures.length === 0;
        ledger.settleStudyAttempt(reservation, {
          outcome: { platform_status: platformPass ? "pass" : "fail", agent_status: result.reference_status === "passed" ? "goal_verified"
            : result.reference_status === "failed" ? "goal_not_verified" : result.setup_status === "failed" ? "not_run" : "unknown",
            provider_status: "not_called", goal_verified: result.reference_status === "passed" ? true : result.reference_status === "failed" ? false : null,
            classification_reason: [`original STEVE synchronous reference: ${result.reference_status}`, ...result.failures,
              `Local-compute/resource record (not provider consumption): ${JSON.stringify(result.actual)}`,
              `Scheduled reference outcomes: ${JSON.stringify(result.behaviors)}`] },
          usage: null, evidence, stop_reason: platformPass ? null : result.terminal === "limit" ? "allowance_exhausted" : "invalid_platform",
        });
        terminal = true;
      },
      async interrupt(reason) {
        if (!reservation) throw new Error("No durable reference reservation");
        if (terminal) return;
        ledger.interruptStudyAttempt(reservation, reason); terminal = true;
      },
      async confirmDrain(evidence) {
        if (!reservation) throw new Error("No durable reference reservation");
        ledger.confirmStudyResourceDrain(reservation, { requests_drained: true, runtime_closed: true, native_closed: true, evidence });
      },
    };
    try {
      const result = await runReferenceScreen({ manifest, governance, preparedRoot: resolve(projectRoot, required("--prepared-root")),
        fixturesRoot: resolve(projectRoot, required("--fixtures-root")), runnerRoot: resolve(projectRoot, "policies"), outputRoot, signal: abort.signal });
      console.log(JSON.stringify({ result, output: outputRoot }));
      return result.reference_status === "passed" ? 0 : 1;
    } finally {
      clearTimeout(wallTimer);
    }
  } finally {
    try {
      if (reservation && !terminal) ledger.interruptStudyAttempt(reservation, "Reference entry failed before a retained normal settlement; ownership remains unconfirmed");
    } finally {
      try { ledger.close(); } finally { entryCompletion?.(); }
    }
  }
}

if (import.meta.main) {
  try { process.exitCode = await runPolicyReference(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
