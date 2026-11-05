import { afterEach, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  launchResidentBenchmarkChild,
  residentBenchmarkCleanupConfirmed,
  validateResult,
} from "../scripts/native-resident-benchmark.ts";
import {
  DEFAULT_RESIDENT_BENCHMARK_PROTOCOL,
  RESIDENT_BENCHMARK_SOURCE,
  residentBenchmarkSchedule,
  validateResidentBenchmarkDeclaration,
} from "../src/evaluation/resident-benchmark.ts";
import { StudyLedger } from "../src/evaluation/studies.ts";
import { liveStudyManifest } from "./helpers/study-manifest.ts";
import type {
  NativeClockCorrespondence,
  NativeRequestSpan,
} from "../src/server/performance.ts";
import type { ResidentTraceEvent } from "../src/shared/resident.ts";

type CapturedNativeTiming = {
  native_sequence: number;
  host_clock_id: string;
  span: NativeRequestSpan;
  correspondence: NativeClockCorrespondence | null;
};

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

for (const mode of [
  "late-open",
  "worker-rejected",
  "sandbox-close-rejected",
  "timing-ring-wrap",
  "timing-pending-overflow",
  "timing-pre-resident-close-reentry",
  "timing-observer-error",
  "timing-native-close-rejected",
  "timing-context-close-rejected",
  "timing-opportunity-omitted",
  "timing-opportunity-missing-terminal",
  "window-work-insufficient",
  "window-previously-insufficient-now-fits",
  "window-fits-root-maximum-outside-work",
  "window-equal",
  "window-one-ms-insufficient",
  "window-open-overhead",
] as const)
  test(
    mode === "late-open"
      ? "cancelled late native admission retains the actual resident retirement receipt without post-fence work"
      : mode === "worker-rejected"
        ? "rejected selected-worker acquisition is failed work, not unconfirmed cleanup after joined teardown"
        : mode === "sandbox-close-rejected"
          ? "rejected sandbox closure cannot confirm cleanup even when selected-worker acquisition already rejected"
          : mode === "window-work-insufficient"
            ? "actual slot refuses a full window that fits the root but exceeds original global work before native admission"
            : mode === "window-previously-insufficient-now-fits"
              ? "300-second slot admits the formerly insufficient 97-second preparation before an explicit cutoff, not a full-window PASS"
              : mode === "window-fits-root-maximum-outside-work"
                ? "actual slot admits a fitting mandatory window even when the unused root maximum extends beyond work"
                : mode === "window-equal"
                  ? "actual slot refuses full-window equality without positive work slack before native admission"
                  : mode === "window-one-ms-insufficient"
                    ? "actual slot refuses a mandatory window one millisecond beyond original work before native admission"
                    : ((
                        {
                          "timing-ring-wrap":
                            "actual slot retains early application stages beyond native ring wrap and terminal facts after joined native/context closure",
                          "timing-pending-overflow":
                            "actual bounded journal refusal under valid native stream pressure cannot claim complete timing evidence",
                          "timing-pre-resident-close-reentry":
                            "journal refusal before resident creation joins one native close despite terminal delivery of the same pending diagnostic",
                          "timing-observer-error":
                            "a real native timeline observer failure invalidates timing completeness despite successful owner drain",
                          "timing-native-close-rejected":
                            "an unresolved native owner cannot establish a complete terminal timing interval",
                          "timing-context-close-rejected":
                            "a rejected context-owner finalizer cannot establish a complete terminal timing interval",
                          "timing-opportunity-omitted":
                            "synthetic opportunity observation loss stays incomplete despite joined owners and a terminal batch",
                          "timing-opportunity-missing-terminal":
                            "missing opportunity terminal metadata stays unknown despite joined owners and retained close-tail replies",
                        } as Record<string, string>
                      )[mode] ??
                      "actual slot retains the acquired retirement ACK but admits no warmup work after asynchronous open exhausts the full window"),
    async () => {
      const windowCase = mode.startsWith("window-");
      const preResidentTimingCase =
        mode === "timing-pre-resident-close-reentry";
      const timingCase = mode.startsWith("timing-") && !preResidentTimingCase;
      const fittingWindow = mode === "window-fits-root-maximum-outside-work";
      const previouslyInsufficientWindow =
        mode === "window-previously-insufficient-now-fits";
      const admittedWindow = fittingWindow || previouslyInsufficientWindow;
      const overheadWindow = mode === "window-open-overhead";
      const expectedOpen =
        mode === "late-open" || admittedWindow || overheadWindow || timingCase;
      const root = mkdtempSync(join(tmpdir(), "resident-benchmark-ownership-"));
      roots.push(root);
      const manifest = liveStudyManifest(root, `ownership-${mode}`);
      const protocol = {
        ...structuredClone(DEFAULT_RESIDENT_BENCHMARK_PROTOCOL),
        mode: "calibration" as const,
      };
      const checked = (file: string, text: string) => {
        writeFileSync(join(root, file), text);
        return {
          path: file,
          sha256: createHash("sha256").update(text).digest("hex"),
        };
      };
      // Same real declaration pattern as resident-benchmark.test.ts; calibration
      // is explicitly labelled and bounded before measurement, never a full PASS.
      manifest.permission.record = checked(
        "permission.txt",
        "Isolated native-free ownership and window-admission regression; synthetic native and Docker boundaries, with declared child-only clock control.",
      );
      manifest.task.text =
        "Exercise resident slot cleanup ownership, not gameplay or competence";
      manifest.task.identity = checked("task.txt", manifest.task.text);
      manifest.task.verifier = checked(
        "protocol.json",
        JSON.stringify(protocol),
      );
      manifest.task.horizon_ms = 165000;
      manifest.identities.controller = checked(
        "controller.mjs",
        RESIDENT_BENCHMARK_SOURCE,
      );
      manifest.identities.model = null;
      manifest.execution = {
        ...manifest.execution,
        controller_mode: "resident_platform",
        adaptation: "none",
        start_mode: "evaluator_prepared_world",
        request_paths: [],
      };
      manifest.arms = [
        {
          id: "hertz_20",
          description: "Synthetic lifecycle only",
          model: null,
          helpers: [],
          profile: manifest.identities.profile,
        },
      ];
      manifest.initial_states = [
        {
          id: "delay_30000",
          mode: "evaluator_prepared_world",
          seed: null,
          save: null,
          settings: {
            difficulty: "normal",
            gamemode: "survival",
            cheats: true,
            level_type: "minecraft:normal",
            structures: true,
            hardcore: false,
            supplied_inventory: true,
            console_commands: true,
            fresh_world_per_slot: true,
          },
        },
      ];
      manifest.repetitions = 3;
      manifest.optional_blocks = [];
      manifest.schedule = residentBenchmarkSchedule(
        manifest.study_id,
        "calibration",
      );
      manifest.allowances = {
        per_attempt: {
          host_requests: 0,
          concurrent_requests: 0,
          workers: 1,
          wall_ms: 300000,
        },
        cohort: {
          host_requests: 0,
          concurrent_requests: 0,
          workers: 1,
          attempt_wall_ms: 300000,
          elapsed_ms: 10800000,
        },
      };
      validateResidentBenchmarkDeclaration(manifest, { projectRoot: root });
      const manifestPath = join(root, "manifest.json"),
        directory = join(root, "slot"),
        governanceRoot = join(root, "governance");
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const ledger = new StudyLedger(governanceRoot, { projectRoot: root });
      const processOwner: { child: ChildProcess | null } = { child: null };
      let launched: Promise<unknown> | undefined;
      try {
        const ref = ledger.registerStudy(manifest),
          reservation = ledger.reserveStudyAttempt(
            ref,
            manifest.schedule[0]!.slot,
          );
        const registered = ledger.readStudy(ref),
          attempt = registered.attempts[0]!;
        const deadline = Math.min(
          attempt.reservedAt + manifest.allowances.per_attempt.wall_ms,
          registered.registeredAt + manifest.allowances.cohort.elapsed_ms,
        );
        const protocolErrors: string[] = [],
          sdkSignals: unknown[] = [];
        let ready = 0,
          held = 0,
          finished = 0,
          unhandled: unknown,
          heldOwnership: unknown;
        const send = (
          value:
            | string
            | { type: "resident_benchmark_work_cutoff"; version: 1 },
        ) => {
          const child = processOwner.child;
          if (child?.connected)
            child.send(value, (error) => {
              if (error) protocolErrors.push(error.message);
            });
          else protocolErrors.push(`IPC closed before ${value}`);
        };
        const running = launchResidentBenchmarkChild({
          command: process.execPath,
          args: [
            "--no-env-file",
            join(
              process.cwd(),
              "tests/helpers/resident-benchmark-ownership.fixture.ts",
            ),
            mode,
            JSON.stringify({
              project: root,
              manifestPath,
              reservation,
              reportDirectory: directory,
            }),
            "--allow-native",
          ],
          cwd: process.cwd(),
          env: {
            ...process.env,
            GAMEHARNESS_NATIVE_PROOF: "1",
            GAMEHARNESS_PROOF_EXPECTED_JAR_SHA256:
              manifest.identities.build.sha256,
            GAMEHARNESS_EVALUATION_GOVERNANCE_ROOT: governanceRoot,
            GAMEHARNESS_EVALUATION_REPORTS_ROOT: join(root, "reports"),
            GAMEHARNESS_BENCHMARK_DEADLINE_EPOCH_MS: String(deadline),
          },
          // External test containment is shorter than the unchanged authenticated
          // production allowance. No production threshold or clock is shortened.
          deadlineEpochMs: Date.now() + 20000,
          cleanupMs: 10000,
          setChild(child) {
            processOwner.child = child;
            child?.on("message", (message) => {
              if (
                !message ||
                typeof message !== "object" ||
                !("fixture" in message) ||
                message.fixture !== "resident-benchmark-ownership" ||
                !("event" in message)
              )
                return;
              if (message.event === "ready") {
                ready++;
                if (timingCase) {
                  if (ready !== 1)
                    protocolErrors.push("Duplicate timing context open");
                  // Release admission; the real slot stops at the deliberately
                  // unsupported diagnostic seam, after actual resident anchoring.
                  // Overflow stops earlier through PrivateJournal's real callback.
                  send("release");
                } else if (windowCase) {
                  if (ready !== 1) protocolErrors.push("Duplicate native open");
                  // Fitting admission is established by the real context grant,
                  // then stopped at the production external cutoff. Refusal cases
                  // use the same containment if an unfixed slot wrongly opens.
                  if (!overheadWindow)
                    send({
                      type: "resident_benchmark_work_cutoff",
                      version: 1,
                    });
                  send("release");
                } else {
                  if (mode !== "late-open" || ready !== 1) {
                    protocolErrors.push("Unexpected native open");
                    send("release");
                    return;
                  }
                  if (!child.kill("SIGINT"))
                    protocolErrors.push("Owned child rejected SIGINT");
                }
              }
              if (message.event === "sdk-signal") {
                sdkSignals.push("reason" in message ? message.reason : null);
                send("check-held");
              }
              if (message.event === "held") {
                held++;
                heldOwnership =
                  "ownership" in message ? message.ownership : null;
                if (ledger.readStudy(ref).attempts[0]!.cleanup.confirmed)
                  protocolErrors.push("Ledger released before child drain");
                send("release");
              }
              if (message.event === "finished") {
                finished++;
                unhandled = "unhandled" in message ? message.unhandled : null;
              }
            });
          },
        });
        launched = running;
        const observed = await running;
        expect(observed).toMatchObject({
          close_observed: true,
          signal: null,
          deadline_requested: false,
          kill_requested: false,
          error: null,
          phase: "finalizing",
        });
        if (observed.exit_code === null)
          throw new Error("Expected numeric child exit code");
        expect(mode === "late-open" ? [0, 130] : [0]).toContain(
          observed.exit_code,
        );
        expect(protocolErrors).toEqual([]);
        expect(finished).toBe(1);
        expect(unhandled).toEqual([]);
        expect(ready).toBe(expectedOpen ? 1 : 0);
        expect(held).toBe(mode === "late-open" ? 1 : 0);
        expect(sdkSignals).toEqual(mode === "late-open" ? ["sigint"] : []);
        if (mode === "late-open")
          expect(heldOwnership).toMatchObject({
            held: true,
            released: false,
            worker_closed: true,
            native_closed: false,
            opens: 1,
            steps: 0,
            samples: 0,
            submissions: 0,
            renewals: 0,
          });
        const ownership = JSON.parse(
          readFileSync(join(directory, "ownership.json"), "utf8"),
        );
        expect(ownership).toMatchObject({
          native_closed: true,
          guardian_closed: true,
          context_closed: true,
          sandbox_closed: mode !== "sandbox-close-rejected",
          worker_creations: 1,
          opens: expectedOpen ? 1 : 0,
          steps: 0,
          samples: 0,
          submissions: 0,
          renewals: 0,
          diagnostic_queries:
            preResidentTimingCase ||
            (timingCase && mode !== "timing-pending-overflow")
              ? 1
              : 0,
          frame_listeners: 0,
        });
        if (
          mode === "late-open" ||
          windowCase ||
          timingCase ||
          preResidentTimingCase
        )
          expect(ownership.worker_closed).toBe(true);
        const report = JSON.parse(
          readFileSync(join(directory, "slot-report.json"), "utf8"),
        );
        const raw = JSON.parse(
          readFileSync(join(directory, "raw-timings.json"), "utf8"),
        );
        const validated = validateResult(directory, reservation, "e01");
        const confirmed = ![
          "sandbox-close-rejected",
          "timing-pending-overflow",
          "timing-pre-resident-close-reentry",
          "timing-native-close-rejected",
          "timing-context-close-rejected",
        ].includes(mode);
        expect(validated.result).toMatchObject({
          platform_status: confirmed ? "fail" : "unknown",
          cleanup_confirmed: confirmed,
        });
        expect(
          residentBenchmarkCleanupConfirmed(observed, validated.result),
        ).toBe(confirmed);
        expect(report).toMatchObject({
          native_fixture_created: true,
          full_window_completed: false,
          interrupted: mode === "late-open",
          actual_provider_calls: 0,
          selected_compile: {
            status:
              mode === "late-open" || windowCase || timingCase
                ? "ready"
                : "failed_or_interrupted",
          },
          cleanup: {
            confirmed,
            resident_worker_closed: true,
            resident_native_retired: true,
            history_reader_closed: true,
            native_closed: mode !== "timing-native-close-rejected",
            runtime_closed: mode !== "timing-context-close-rejected",
            sandbox_closed: mode !== "sandbox-close-rejected",
            store_closed: true,
            recorder_closed: true,
            journal_closed:
              mode !== "timing-pending-overflow" && !preResidentTimingCase,
            deadline_reached: false,
          },
          recording: {
            status: "complete",
            delivered_frames: 1,
            stored_frames: 1,
          },
        });
        expect(raw.steps).toEqual([]);
        expect(raw.submissions).toEqual([]);
        expect(raw.acks).toEqual([]);
        if (
          mode === "late-open" ||
          (windowCase && expectedOpen) ||
          timingCase
        ) {
          if (mode === "late-open")
            expect(report.failure).toContain("Slot interrupted by SIGINT");
          expect(report.final_resident).toMatchObject({
            cleanup: { worker: "closed", native: "retired" },
            counters: { steps: 0, submissions: 0 },
          });
          expect(raw.retirements).toHaveLength(1);
          expect(report.native_retirements).toEqual(raw.retirements);
          expect(raw.retirements[0].ack).toMatchObject({
            admission_revoked: true,
            input_application: "confirmed",
            retirement_applied_native_tick: 42,
            retirement_applied_native_ns: "42000000",
            unresolved_operation_refs: [],
          });
          expect(ownership.revokes).toBeGreaterThanOrEqual(1);
        } else if (!windowCase && !timingCase && !preResidentTimingCase) {
          expect(report.failure).toContain(
            "Synthetic selected-worker compilation rejected after joined guardian teardown",
          );
          expect(report.final_resident).toBeNull();
          expect(raw.retirements).toEqual([]);
          expect(ownership.revokes).toBe(0);
          if (!confirmed)
            expect(report.cleanup.errors).toContain(
              "owned work and sandbox: Synthetic sandbox closure receipt rejected",
            );
        }
        if (preResidentTimingCase) {
          expect(ownership.close_reentry).toEqual({
            native_close_starts: 1,
            termination_starts: 1,
            termination_spans: 1,
            pending_rejections: 1,
            pending_remaining: 0,
          });
          expect(ownership.timing).toMatchObject({
            native_close_receipt: true,
            context_close_receipt: true,
            observer_failures: 0,
          });
          expect(report.failure).toContain(
            "private_journal_pending_capacity_bound",
          );
          expect(report.final_resident).toBeNull();
          expect(raw.retirements).toEqual([]);
          expect(report.native_retirements).toEqual([]);
          expect(ownership.revokes).toBe(0);
          expect(report.trace_integrity).toMatchObject({
            collector_opened: true,
            collector_closed: true,
            complete: false,
            native_closed: true,
            runtime_closed: true,
            journal_complete: false,
            native: {
              observer_failures_start: 0,
              observer_failures_end: 0,
              observer_failures_delta: 0,
            },
            resident: { attempted: 0, accepted: 0, anchors: 0 },
          });
          expect(report.trace_integrity.native.refused).toBeGreaterThan(0);
          expect(report.trace_integrity.native.attempted).toBe(
            report.trace_integrity.native.accepted +
              report.trace_integrity.native.refused,
          );
          expect(raw.trace_integrity).toEqual(report.trace_integrity);
          const journalManifest = JSON.parse(
            readFileSync(report.journal.manifest, "utf8"),
          );
          expect(journalManifest.evidence_complete).toBe(false);
          expect(journalManifest.failures).toContain(
            "private_journal_pending_capacity_bound",
          );
        }
        if (timingCase) {
          expect(ownership.timing).toMatchObject({
            ring_samples: 512,
            earliest_in_ring: false,
            native_close_receipt: mode !== "timing-native-close-rejected",
            context_close_receipt: mode !== "timing-context-close-rejected",
            native_close_fact: mode !== "timing-native-close-rejected",
            context_close_fact: mode !== "timing-context-close-rejected",
            observer_failures: mode === "timing-observer-error" ? 1 : 0,
          });
          expect(ownership.timing.produced).toBeGreaterThan(513);
          expect(ownership.timing.omitted_samples).toBeGreaterThan(0);
          const journalManifest = JSON.parse(
            readFileSync(report.journal.manifest, "utf8"),
          );
          expect(journalManifest.limits).toMatchObject({
            max_text_bytes: 256 * 1024 ** 2,
            max_pending_bytes: 16 * 1024 ** 2,
          });
          expect(journalManifest.peak_pending_bytes).toBeLessThanOrEqual(
            16 * 1024 ** 2,
          );
          expect(journalManifest.evidence_complete).toBe(
            mode !== "timing-pending-overflow",
          );
          let nativeCount = 0,
            traceCount = 0,
            position = 0,
            endPosition = -1,
            nativeTerminalPosition = -1,
            contextTerminalPosition = -1;
          let early: CapturedNativeTiming | undefined,
            nativeTerminal: CapturedNativeTiming | undefined,
            contextTerminal: CapturedNativeTiming | undefined,
            opportunityTerminal: CapturedNativeTiming | undefined;
          let opportunityTerminalCount = 0,
            opportunityTerminalPosition = -1;
          let anchor:
            | Extract<ResidentTraceEvent, { stage: "anchor" }>
            | undefined;
          let captureStart: unknown, captureEnd: unknown;
          // Read the real bounded journal as a stream; never duplicate a pressured
          // full-window population in the test process or atomic raw artifact.
          const lines = createInterface({
            input: createReadStream(report.journal.journal),
            crlfDelay: Infinity,
          });
          for await (const line of lines) {
            const record = JSON.parse(line);
            position++;
            if (record.kind === "timing_capture_start")
              captureStart = record.value;
            if (record.kind === "timing_capture_end") {
              captureEnd = record.value;
              endPosition = position;
            }
            if (record.kind === "resident_trace") {
              traceCount++;
              expect(record.value.trace_sequence).toBe(traceCount);
              if (record.value.stage === "anchor") anchor = record.value;
            }
            if (record.kind !== "native_request_span") continue;
            nativeCount++;
            expect(record.value.native_sequence).toBe(nativeCount);
            const span = record.value.span;
            const opportunities = span.native_timing?.controller_opportunities;
            if (opportunities) {
              expect(span.method).not.toBe("controller_revoke");
              expect(opportunities.events).toEqual([]);
              expect(opportunities.identity).toEqual({
                owner_operation_id: "synthetic-native-operation",
                controller_generation: "1",
                source_hash: report.selected_source.canonical_sha256,
                native_boot_id: report.trace_integrity.native_boot_id,
              });
              expect(opportunities.counts).toMatchObject({
                accepted: "0",
                drained: "0",
                retained: 0,
              });
              if (opportunities.final_batch) {
                opportunityTerminalCount++;
                opportunityTerminal = record.value;
                opportunityTerminalPosition = position;
              } else expect(opportunities.complete).toBe(false);
            }
            if (span.request_id === 1) early = record.value;
            const trigger =
              span.native_timing?.controller_lease?.retirement_trigger;
            if (trigger === "fixture_native_owner_close") {
              nativeTerminal = record.value;
              nativeTerminalPosition = position;
            }
            if (trigger === "fixture_context_owner_close") {
              contextTerminal = record.value;
              contextTerminalPosition = position;
            }
          }
          expect(early).toMatchObject({
            native_sequence: 1,
            host_clock_id: report.trace_integrity.host_clock_id,
            span: {
              request_id: 1,
              source_hash: report.selected_source.canonical_sha256,
              native_boot_id: report.trace_integrity.native_boot_id,
              native_timing: {
                controller_application: {
                  sequence: 1,
                  admitted_native_ns: "900000000",
                  pending_ahead: 2,
                  admitted_preparation_ordinal: 4,
                  began_native_ns: "980000000",
                  began_preparation_ordinal: 6,
                  consumed_native_ns: null,
                  sampled_native_ns: null,
                  owner: {
                    scope: {
                      source_hash: report.selected_source.canonical_sha256,
                    },
                  },
                },
              },
            },
            correspondence: { clock_id: report.trace_integrity.native_boot_id },
          });
          expect(captureStart).toBeDefined();
          const opportunityFinalExpected = ![
            "timing-native-close-rejected",
            "timing-context-close-rejected",
            "timing-opportunity-missing-terminal",
          ].includes(mode);
          const opportunitiesComplete =
            opportunityFinalExpected && mode !== "timing-opportunity-omitted";
          expect(report.trace_integrity.controller_opportunities).toMatchObject(
            {
              complete: opportunitiesComplete,
              status: opportunitiesComplete
                ? "complete"
                : opportunityFinalExpected
                  ? "incomplete"
                  : "unknown_terminal_final_pending",
              identity_consistent_with_actual_root: true,
              events: 0,
              first_eventseq: null,
              last_eventseq: null,
              sequence_gaps: mode === "timing-opportunity-omitted" ? 1 : 0,
              sequence_errors: 0,
              identity_errors: 0,
              counter_errors: 0,
              counts_inconsistent_batches: 0,
              reported_attempted:
                mode === "timing-opportunity-omitted" ? "1" : "0",
              reported_accepted: "0",
              reported_omitted:
                mode === "timing-opportunity-omitted" ? "1" : "0",
              terminal_batches: opportunityFinalExpected ? 1 : 0,
              terminal_final_pending: !opportunityFinalExpected,
              terminal_complete: opportunitiesComplete,
            },
          );
          expect(report.trace_integrity).toMatchObject({
            schema_version: 1,
            collector_opened: true,
            collector_closed: true,
            complete: mode === "timing-ring-wrap",
            native_closed: mode !== "timing-native-close-rejected",
            runtime_closed: mode !== "timing-context-close-rejected",
            resident_worker_closed: true,
            resident_native_retired: true,
            journal_complete: mode !== "timing-pending-overflow",
            native: {
              attempted: ownership.timing.produced,
              accepted: nativeCount,
              observer_failures_start: 0,
              ...(mode === "timing-pending-overflow"
                ? {}
                : {
                    observer_failures_end:
                      mode === "timing-observer-error" ? 1 : 0,
                    observer_failures_delta:
                      mode === "timing-observer-error" ? 1 : 0,
                  }),
              metadata_missing: 0,
              clock_correspondence_missing: 0,
            },
            resident: {
              attempted: traceCount,
              accepted: traceCount,
              sequence_errors: 0,
              observer_errors: 0,
            },
          });
          expect(raw.trace_integrity).toEqual(report.trace_integrity);
          if (mode === "timing-pending-overflow") {
            expect(report.trace_integrity.native.refused).toBeGreaterThan(0);
            expect(report.trace_integrity.native.attempted).toBe(
              report.trace_integrity.native.accepted +
                report.trace_integrity.native.refused,
            );
            expect(journalManifest.failures).toContain(
              "private_journal_pending_capacity_bound",
            );
          } else {
            expect(captureEnd).toBeDefined();
            expect(report.trace_integrity.native.refused).toBe(0);
            expect(opportunityTerminalCount).toBe(
              opportunityFinalExpected ? 1 : 0,
            );
            if (opportunityFinalExpected) {
              expect(opportunityTerminal?.span.method).toBe("query_capability");
              expect(
                opportunityTerminal?.span.native_timing
                  ?.controller_opportunities,
              ).toMatchObject({
                final_batch: true,
                complete: opportunitiesComplete,
                counts: {
                  sealed: true,
                  attempted: mode === "timing-opportunity-omitted" ? "1" : "0",
                  omitted: mode === "timing-opportunity-omitted" ? "1" : "0",
                  drained: "0",
                },
              });
              // Whichever producer actually drains last owns the only terminal
              // ordinary carrier, still inside the real collector interval.
              expect(opportunityTerminalPosition).toBe(
                Math.max(nativeTerminalPosition, contextTerminalPosition),
              );
              expect(opportunityTerminalPosition).toBeLessThan(endPosition);
            } else {
              expect(opportunityTerminal).toBeUndefined();
              expect(report.trace_integrity.complete).toBe(false);
            }
            expect(anchor).toMatchObject({
              stage: "anchor",
              period_ms: 50,
              execution_id: "synthetic-owned-controller",
              source_hash: report.selected_source.canonical_sha256,
              host_clock_id: report.trace_integrity.host_clock_id,
              native_boot_id: report.trace_integrity.native_boot_id,
              operation_id: "synthetic-native-operation",
              owner_generation: 1,
              observer_errors: 0,
            });
            if (!anchor)
              throw new Error("Actual resident anchor was not retained");
            expect(anchor.anchor_host_ms).toBeLessThanOrEqual(
              anchor.host_monotonic_ms,
            );
            expect(report.trace_integrity.resident.anchors).toBe(1);
            if (mode !== "timing-native-close-rejected") {
              expect(
                nativeTerminal?.span.native_timing?.controller_lease,
              ).toMatchObject({
                event: "retirement",
                retirement_trigger: "fixture_native_owner_close",
                retirement_native_ns: "1001000000",
              });
              expect(nativeTerminalPosition).toBeLessThan(endPosition);
            } else expect(nativeTerminal).toBeUndefined();
            if (mode !== "timing-context-close-rejected") {
              expect(
                contextTerminal?.span.native_timing?.controller_lease,
              ).toMatchObject({
                event: "retirement",
                retirement_trigger: "fixture_context_owner_close",
                retirement_native_ns: "1001000000",
              });
              expect(contextTerminalPosition).toBeLessThan(endPosition);
            } else expect(contextTerminal).toBeUndefined();
          }
        }
        if (windowCase) {
          expect(report.failure).not.toBeNull();
          expect(report).not.toHaveProperty("warmup_started_host_ms");
          expect(report).not.toHaveProperty("measurement_started_host_ms");
          expect(report).not.toHaveProperty("measurement");
          expect(raw.initial_evaluator_diagnostics).toEqual([]);
          expect(ownership.clock.restored_before_finalization).toBe(true);
          const origin = ownership.clock.origin_host_ms;
          expect(report.root_admitted_host_ms - origin).toBe(
            ownership.clock.root_elapsed_ms,
          );
          expect(report.selected_compile.ended_host_ms - origin).toBe(
            ownership.clock.compile_elapsed_ms,
          );
          expect(report.deadlines.original_deadline_epoch_ms).toBe(deadline);
          expect(report.deadlines.total_deadline_host_ms - origin).toBe(300000);
          expect(report.deadlines.work_deadline_host_ms - origin).toBe(275000);
          expect(report.deadlines.cleanup_reserve_ms).toBe(25000);
          expect(
            report.original_root_deadline_host_ms -
              report.root_admitted_host_ms,
          ).toBe(165000);
          expect(report.protocol).toMatchObject({
            root_ms: 165000,
            warmup_ms: 30000,
            measurement_ms: 120000,
          });
          const initial = report.window_admission?.[0];
          expect(initial).toMatchObject({
            stage: "post_compile",
            needed_ms: 150000,
            admitted: admittedWindow || overheadWindow,
            original_work_deadline_host_ms:
              report.deadlines.work_deadline_host_ms,
            original_root_deadline_host_ms:
              report.original_root_deadline_host_ms,
          });
          expect(initial.checked_host_ms).toBe(
            report.selected_compile.ended_host_ms,
          );
          expect(initial.available_ms).toBe(
            mode === "window-work-insufficient"
              ? 116886
              : previouslyInsufficientWindow
                ? 164639
                : fittingWindow
                  ? 159500
                  : mode === "window-equal"
                    ? 150000
                    : mode === "window-one-ms-insufficient"
                      ? 149999
                      : 151000,
          );
          if (overheadWindow) {
            expect(report.window_admission).toHaveLength(2);
            expect(report.window_admission[1]).toMatchObject({
              stage: "warmup",
              needed_ms: 150000,
              available_ms: 149000,
              admitted: false,
              original_work_deadline_host_ms:
                report.deadlines.work_deadline_host_ms,
              original_root_deadline_host_ms:
                report.original_root_deadline_host_ms,
            });
            expect(report.window_admission[1].checked_host_ms - origin).toBe(
              126000,
            );
          } else {
            expect(report.window_admission).toHaveLength(1);
          }
          if (fittingWindow) {
            expect(report.original_root_deadline_host_ms).toBeGreaterThan(
              report.deadlines.work_deadline_host_ms,
            );
          } else if (previouslyInsufficientWindow) {
            expect(report.original_root_deadline_host_ms).toBeLessThan(
              report.deadlines.work_deadline_host_ms,
            );
          } else if (!overheadWindow) {
            expect(report.final_resident).toBeNull();
            expect(raw.retirements).toEqual([]);
            expect(ownership.revokes).toBe(0);
            expect(
              report.original_root_deadline_host_ms -
                report.selected_compile.ended_host_ms,
            ).toBeGreaterThan(150000);
          }
        }
        // Consume the real supervisor/result receipt at the existing ledger API.
        // Synthetic external owners establish lifecycle plumbing, never native proof.
        ledger.settleStudyAttempt(reservation, {
          outcome: {
            platform_status: validated.result.platform_status,
            agent_status: "not_run",
            provider_status: "not_called",
            goal_verified: null,
            classification_reason: [
              "Actual slot/resident lifecycle with explicit synthetic native/Docker boundaries",
            ],
          },
          usage: null,
          evidence: [validated.result.report],
          stop_reason: "invalid_platform",
        });
        if (residentBenchmarkCleanupConfirmed(observed, validated.result))
          ledger.confirmStudyResourceDrain(reservation, {
            requests_drained: true,
            runtime_closed: true,
            native_closed: true,
            evidence: [
              "Actual child OS close and slot cleanup receipts for synthetic external owners",
            ],
          });
        expect(ledger.readStudy(ref).attempts[0]!.cleanup.confirmed).toBe(
          confirmed,
        );
      } finally {
        // Release any held external admission, kill a surviving process, and join
        // OS close before releasing SQLite or afterEach removes private files.
        const child = processOwner.child;
        if (child) {
          if (child.connected) child.send("release", () => {});
          child.kill("SIGKILL");
        }
        if (launched) await launched;
        ledger.close();
      }
    },
    30000,
  );
