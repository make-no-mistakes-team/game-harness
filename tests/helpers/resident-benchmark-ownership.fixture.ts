import { mock } from "bun:test";
import { mkdir, open, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as native from "../../src/evaluation/native-game.ts";
import type { NativeControllerContext } from "../../src/evaluation/native-game.ts";
import type { ResidentBenchmarkSlotOptions } from "../../scripts/native-resident-benchmark-slot.ts";
import type { ResidentWorker } from "../../src/shared/resident.ts";
import {
  NativeControlTimeline,
  type NativeControllerOpportunityBatch,
  type NativeRequestSpan,
} from "../../src/server/performance.ts";
import {
  revocationAckSchema,
  type ControllerInputChannel,
} from "../../src/shared/controller.ts";
import {
  minecraftObservationFixture,
  minecraftTestAdapter,
  minecraftTestBinding,
} from "./adapter-contract.ts";
import { nativeFrame } from "./native-frame.ts";

// Dedicated subprocess only. NativeFixture/native transport and Docker provisioning
// are explicit substitutes. Slot, ResidentController, SDK shutdown, validation,
// StudyLedger, Store, journal, recorder and durable publication remain production.
const [mode, optionsJson] = process.argv.slice(2);
const windowCases: Record<
  string,
  { root: number; compile: number; opened?: number }
> = {
  "window-work-insufficient": { root: 157753, compile: 158114 },
  "window-previously-insufficient-now-fits": { root: 97753, compile: 98114 },
  "window-fits-root-maximum-outside-work": { root: 115126, compile: 115500 },
  "window-equal": { root: 124000, compile: 125000 },
  "window-one-ms-insufficient": { root: 124000, compile: 125001 },
  "window-open-overhead": { root: 123000, compile: 124000, opened: 126000 },
};
const windowCase = mode ? windowCases[mode] : undefined;
const preResidentTimingCase = mode === "timing-pre-resident-close-reentry";
const timingCase = [
  "timing-ring-wrap",
  "timing-pending-overflow",
  "timing-observer-error",
  "timing-native-close-rejected",
  "timing-context-close-rejected",
  "timing-opportunity-omitted",
  "timing-opportunity-missing-terminal",
].includes(mode ?? "");
if (
  !["late-open", "worker-rejected", "sandbox-close-rejected"].includes(
    mode ?? "",
  ) &&
  !windowCase &&
  !timingCase &&
  !preResidentTimingCase
)
  throw new Error("Unknown ownership fixture mode");
if (!optionsJson || !process.send)
  throw new Error("Missing slot options or owned IPC");
const options: ResidentBenchmarkSlotOptions = JSON.parse(optionsJson);
const root = join(
  options.reportDirectory,
  "native-runtime",
  "synthetic-owned-native",
);
const evidenceDirectory = join(root, "evidence");
await mkdir(evidenceDirectory, { recursive: true });
process.env.GAMEHARNESS_DATA_DIR = root;
const ownership = {
  native_closed: false,
  guardian_closed: false,
  worker_closed: false,
  sandbox_closed: false,
  context_closed: false,
  worker_creations: 0,
  opens: 0,
  revokes: 0,
  steps: 0,
  samples: 0,
  submissions: 0,
  renewals: 0,
  frame_listeners: 0,
  held: false,
  released: false,
  diagnostic_queries: 0,
  timing: {
    produced: 0,
    ring_samples: 0,
    omitted_samples: 0,
    earliest_in_ring: false,
    native_close_fact: false,
    context_close_fact: false,
    observer_failures: 0,
    native_close_receipt: false,
    context_close_receipt: false,
  },
  close_reentry: {
    native_close_starts: 0,
    termination_starts: 0,
    termination_spans: 0,
    pending_rejections: 0,
    pending_remaining: 0,
  },
  clock: null as null | {
    origin_host_ms: number;
    root_elapsed_ms: number;
    compile_elapsed_ms: number;
    opened_elapsed_ms: number | null;
    restored_before_finalization: boolean;
  },
};
// Only window subprocesses replace the host clocks. A frozen, equally backdated
// wall/monotonic pair gives exact boundary arithmetic without a 150-second wait.
// Native startup/compile/open advance that pair at the actual consumer seams.
// Both clocks resume real time in context finally, before trusted finalizing IPC.
const realDateNow = Date.now.bind(Date),
  realPerformanceNow = performance.now.bind(performance);
const performanceNowDescriptor = Object.getOwnPropertyDescriptor(
  performance,
  "now",
);
let clockOrigin = 0,
  clockEpoch = 0,
  elapsed = 0,
  clockInstalled = false;
const advanceClock = (value: number) => {
  if (windowCase) elapsed = value;
};
const restoreClock = () => {
  if (!clockInstalled) return;
  if (
    realPerformanceNow() < clockOrigin + elapsed ||
    realDateNow() < clockEpoch + elapsed
  ) {
    throw new Error(
      "Synthetic elapsed time must not exceed real clock restoration",
    );
  }
  Date.now = realDateNow;
  if (performanceNowDescriptor)
    Object.defineProperty(performance, "now", performanceNowDescriptor);
  else Reflect.deleteProperty(performance, "now");
  clockInstalled = false;
  ownership.clock!.restored_before_finalization = true;
};
const persist = () =>
  writeFile(
    join(options.reportDirectory, "ownership.json"),
    JSON.stringify(ownership),
  );
const send = (value: Record<string, unknown>) =>
  process.send!({ fixture: "resident-benchmark-ownership", ...value });
const gate = Promise.withResolvers<void>();
const onMessage = (value: unknown) => {
  if (value === "check-held")
    send({ event: "held", ownership: { ...ownership } });
  if (value === "release") {
    ownership.released = true;
    gate.resolve();
  }
};
const onDisconnect = () => {
  ownership.released = true;
  gate.resolve();
};
process.on("message", onMessage);
process.once("disconnect", onDisconnect);

// The stand-ins own actual handles. Receipts follow joined close(), never a
// scheduled timer or an echoed cleanup boolean; the negative case rejects close.
const nativeHandle = await open(join(root, "native-boundary.owner"), "wx");
const guardianHandle = await open(join(root, "docker-boundary.owner"), "wx");
const contextHandle =
  timingCase || preResidentTimingCase
    ? await open(join(root, "controller-context.owner"), "wx")
    : undefined;
let nativeHandleClose: Promise<void> | undefined,
  contextHandleClose: Promise<void> | undefined;
const releaseNativeHandle = () =>
  (nativeHandleClose ??= nativeHandle.close().then(() => {
    ownership.native_closed = true;
  }));
const releaseContextHandle = () =>
  (contextHandleClose ??= (contextHandle?.close() ?? Promise.resolve()).then(
    () => {
      ownership.context_closed = true;
    },
  ));
let nativeClose: Promise<{ closed: boolean }> | undefined,
  guardianClose: Promise<void> | undefined;
let workerClose: Promise<void> | undefined,
  closeWorker: (() => Promise<void>) | undefined;
const closeGuardian = () =>
  (guardianClose ??= guardianHandle.close().then(() => {
    ownership.guardian_closed = true;
  }));
const adapter = minecraftTestAdapter();
const observation = minecraftObservationFixture(adapter);
const state = {
  status: "connected",
  username: "synthetic-owned-player",
  version: "1.21.4",
  world_id: observation.world_id,
  epoch: observation.epoch,
  session_id: observation.session_id,
  life: observation.life,
  binding: minecraftTestBinding(adapter),
  space: observation.space,
  screen: null,
  presentation: null,
  video: {
    status: "streaming",
    width: 2,
    height: 2,
    fps: 30,
    frames: 0,
    last_frame_at: null,
    error: null,
  },
  last_observation_at: null,
  error: null,
};
const timeline = new NativeControlTimeline();
timeline.bindBoot(observation.native_boot_id);
let timingOwner: ControllerInputChannel["owner"] | undefined;
const timingProducerDrained = { native: false, context: false };
const opportunityBatch = (
  terminal: "native" | "context" | null,
): NativeControllerOpportunityBatch => {
  if (!timingOwner)
    throw new Error("Opportunity identity requires the actual context owner");
  // This substitute runs no client preparation hooks or sampling. Empty batches
  // report that bounded synthetic population, not invented 20 Hz opportunities.
  // Only the last joined producer can seal it; a revoke ACK is never its carrier.
  const drained =
    terminal !== null &&
    timingProducerDrained.native &&
    timingProducerDrained.context;
  const final = drained && mode !== "timing-opportunity-missing-terminal";
  // One deliberate observation-loss fault exercises consumer accounting without
  // inventing a sampled/prepared event or claiming native capacity acceptance.
  const omitted = drained && mode === "timing-opportunity-omitted" ? "1" : "0";
  return {
    schema_version: 1,
    identity: {
      owner_operation_id: timingOwner.operation_id,
      controller_generation: "1",
      native_boot_id: timingOwner.scope.native_boot_id,
      source_hash: timingOwner.scope.source_hash,
    },
    counts: {
      attempted: omitted,
      accepted: "0",
      omitted,
      contended: "0",
      exhausted: omitted,
      closed_omitted: "0",
      drained: "0",
      retained: 0,
      sealed: final,
    },
    final_batch: final,
    unattached_retained: 0,
    counts_consistent: true,
    complete: final && omitted === "0",
    events: [],
  };
};
const requestSpan = (
  requestId: number,
  terminal: "native" | "context" | null = null,
): NativeRequestSpan => {
  if (!timingOwner)
    throw new Error("Timing requires the actual source-bound context owner");
  const ended = performance.now();
  return {
    request_id: requestId,
    // Synthetic ordinary close-tail replies stand in for the existing diagnostic
    // carrier. They do not emulate the reserved controller_revoke reply lane.
    method: terminal ? "query_capability" : "controller_submit",
    operation_id: timingOwner.operation_id,
    run_id: timingOwner.scope.run_id,
    execution_id: timingOwner.scope.execution_id,
    source_hash: timingOwner.scope.source_hash,
    native_boot_id: observation.native_boot_id,
    started_monotonic_ms: ended - 5,
    ended_monotonic_ms: ended,
    status: "ok",
    observation_seq: null,
    native_timing: {
      schema_version: 1,
      clock_id: observation.native_boot_id,
      received_ns: "1000000000",
      replied_ns: "1001000000",
      client_tick: 42,
      controller_opportunities: opportunityBatch(terminal),
      ...(terminal
        ? {
            controller_lease: {
              schema_version: 1 as const,
              event: "retirement" as const,
              owner: timingOwner,
              controller_generation: 1,
              checked_native_ns: "1000000000",
              requested_deadline_native_ns: null,
              previous_deadline_native_ns: "1100000000",
              effective_deadline_native_ns: "1000000000",
              task_deadline_native_ns: "2000000000",
              accepted: false,
              first_fence_reason: "fixture_owner_closed",
              first_fence_native_ns: "1000000000",
              retirement_trigger:
                terminal === "native"
                  ? "fixture_native_owner_close"
                  : "fixture_context_owner_close",
              retirement_native_ns: "1001000000",
            },
          }
        : {
            controller_application: {
              schema_version: 1 as const,
              owner: timingOwner,
              controller_generation: 1,
              sequence: requestId,
              frame_seq: requestId,
              admitted_native_ns: "900000000",
              pending_ahead: requestId === 1 ? 2 : 0,
              applying_ahead_sequence: 0,
              admitted_preparation_ordinal: 4,
              began_native_ns: requestId === 1 ? "980000000" : "990000000",
              began_native_tick: 41,
              began_preparation_ordinal: 6,
              prepared_native_ns: "995000000",
              consumed_native_ns: null,
              sampled_native_ns: null,
              settled_native_ns: "1001000000",
              settled_native_tick: 42,
            },
          }),
    },
  };
};
const produce = (terminal: "native" | "context" | null = null) => {
  // The joined handle precedes each caller's tail delivery. Mark at delivery,
  // not in the handle's promise, so concurrent closes cannot both emit a final.
  if (terminal) timingProducerDrained[terminal] = true;
  const id = ++ownership.timing.produced;
  timeline.record(requestSpan(id, terminal));
};
const updateTimingOwnership = () => {
  const retained = timeline.snapshot();
  ownership.timing.ring_samples = retained.samples.length;
  ownership.timing.omitted_samples = retained.omitted_samples;
  ownership.timing.earliest_in_ring = retained.samples.some(
    (span) => span.request_id === 1,
  );
  ownership.timing.observer_failures = retained.observer_failures;
};
// Model the real GameBridgeClient.terminate ordering at the substituted native
// boundary: emit each pending request's terminal span before removing requests
// or publishing the producer's own closing promise. NativeFixture.close has the
// same unpublished-IIFE window below. Reentrant slot Stop must not enter either
// owner again while that exact diagnostic request is still pending.
const pendingDiagnostics = new Map<
  number,
  { span: NativeRequestSpan; reject: (error: Error) => void }
>();
let diagnosticTermination: Promise<void> | undefined;
const terminatePendingDiagnostic = async () => {
  if (diagnosticTermination) return diagnosticTermination;
  ownership.close_reentry.termination_starts++;
  diagnosticTermination = (async () => {
    for (const [id, pending] of pendingDiagnostics) {
      ownership.close_reentry.termination_spans++;
      ownership.timing.produced++;
      timeline.record({
        ...pending.span,
        request_id: id,
        ended_monotonic_ms: performance.now(),
        status: "unknown",
        native_timing: null,
      });
      pending.reject(new Error("Native client emitter closed."));
      ownership.close_reentry.pending_rejections++;
    }
    pendingDiagnostics.clear();
    ownership.close_reentry.pending_remaining = pendingDiagnostics.size;
    await releaseNativeHandle();
  })();
  await diagnosticTermination;
};
const listeners = new Set<(packet: Uint8Array) => void>();
const bridge = {
  snapshot: () => structuredClone(state),
  adapter: () => adapter,
  observe: async () => observation,
  subscribeControlTiming(
    listener: Parameters<NativeControlTimeline["subscribe"]>[0],
  ) {
    return timeline.subscribe(listener);
  },
  performanceMetrics: () => ({
    control_timeline: timeline.snapshot(),
    video: { ...state.video },
  }),
  latestFrame: () => nativeFrame(),
  queryCapability: async () => {
    ownership.diagnostic_queries++;
    throw new Error("Synthetic native boundary admits no warmup diagnostic");
  },
  subscribeFrames(listener: (packet: Uint8Array) => void) {
    listeners.add(listener);
    ownership.frame_listeners = listeners.size;
    return () => {
      listeners.delete(listener);
      ownership.frame_listeners = listeners.size;
    };
  },
};
const properties = join(root, "minecraft/worlds", observation.world_id);
await mkdir(properties, { recursive: true });
await writeFile(
  join(properties, "server.properties"),
  "gamemode=survival\nforce-gamemode=true\ndifficulty=normal\nhardcore=false\nlevel-type=minecraft\\:normal\ngenerate-structures=true\n",
);
const nativeReport: Record<string, unknown> = {
  synthetic_boundary: "NativeFixture and transport; not native proof",
  cleanup: false,
};
const flush = async () => {
  await writeFile(
    join(evidenceDirectory, "report.json"),
    JSON.stringify(nativeReport),
  );
  await persist();
};
const closeNative = () =>
  (nativeClose ??= (async () => {
    if (preResidentTimingCase) {
      ownership.close_reentry.native_close_starts++;
      await terminatePendingDiagnostic();
    }
    if (mode === "timing-native-close-rejected") {
      // The owner handle remains open until independent fixture containment.
      await flush();
      return { closed: false };
    }
    await releaseNativeHandle();
    if ((timingCase || preResidentTimingCase) && timingOwner) {
      produce("native");
      ownership.timing.native_close_fact = true;
      updateTimingOwnership();
    }
    ownership.timing.native_close_receipt = true;
    nativeReport.cleanup = true;
    await flush();
    return { closed: true };
  })());
mock.module(
  resolve(import.meta.dir, "../../src/evaluation/native-game.ts"),
  () => ({
    ...native,
    NativeFixture: {
      create: async () => ({
        root,
        evidenceDirectory,
        bridge,
        commands: [],
        report: nativeReport,
        server: { snapshot: () => ({ world_id: observation.world_id }) },
        ownedClient: () => ({ session: { evaluation: null } }),
        start: async () => {
          if (windowCase) advanceClock(windowCase.root);
        },
        flat: async () => {},
        console: async () => {},
        observe: async () => observation,
        close: closeNative,
        flush,
        async withControllerContext<T>(
          sourceHash: string,
          deadlineHostMs: number,
          work: (context: NativeControllerContext) => Promise<T>,
        ) {
          const executionId = "synthetic-owned-controller";
          const owner = {
            operation_id: "synthetic-native-operation",
            generation: 1,
            scope: {
              session_id: observation.session_id,
              world_id: observation.world_id,
              epoch: observation.epoch,
              native_boot_id: observation.native_boot_id,
              run_id: "synthetic-native-run",
              run_generation: 1,
              life_id: observation.life.life_id,
              space_epoch: observation.space.space_epoch,
              execution_id: executionId,
              source_hash: sourceHash,
            },
          };
          timingOwner = owner;
          let retired = false;
          const channel: ControllerInputChannel = {
            owner,
            controllerGeneration: 1,
            sample: async () => {
              ownership.samples++;
              throw new Error("No post-fence sampling admitted");
            },
            submit: () => {
              ownership.submissions++;
              throw new Error("No post-fence input admitted");
            },
            renew: async () => {
              ownership.renewals++;
              throw new Error("No post-fence lease renewal admitted");
            },
            revoke: async () => {
              ownership.revokes++;
              retired = true;
              return revocationAckSchema.parse({
                owner,
                controller_generation: 1,
                admission_revoked: true,
                last_applied_sequence: 0,
                ordered_edge_prefix: 0,
                retirement_applied_native_tick: 42,
                retirement_applied_native_ns: "42000000",
                input_application: "confirmed",
                unresolved_operation_refs: [],
              });
            },
            snapshot: () => ({
              fenced: retired,
              retired,
              submitted_sequence: 0,
              applied_sequence: 0,
              ordered_edge_prefix: 0,
              pending_frames: 0,
              pending_edges: 0,
              last_input: null,
              reason: retired ? "synthetic-retired" : null,
            }),
          };
          try {
            return await work({
              execution_id: executionId,
              controller_generation: 1,
              deadline_host_ms: deadlineHostMs,
              open: async () => {
                ownership.opens++;
                ownership.held = true;
                if (timingCase) {
                  // Every ordinary span is typed, source-bound metadata. This
                  // synchronous finite burst cannot drain PrivateJournal's queue.
                  const count =
                    mode === "timing-pending-overflow"
                      ? Math.ceil(
                          (16 * 1024 ** 2) /
                            Buffer.byteLength(JSON.stringify(requestSpan(1))),
                        ) + 1
                      : 514;
                  const detachFailure =
                    mode === "timing-observer-error"
                      ? timeline.subscribe(() => {
                          throw new Error(
                            "Synthetic diagnostic observer rejected delivery",
                          );
                        })
                      : undefined;
                  produce();
                  detachFailure?.();
                  for (let request = 1; request < count; request++) produce();
                  updateTimingOwnership();
                }
                send({ event: "ready", seam: "context-open" });
                await gate.promise;
                if (windowCase?.opened !== undefined)
                  advanceClock(windowCase.opened);
                return channel;
              },
            });
          } finally {
            restoreClock();
            if (mode === "timing-context-close-rejected")
              throw new Error(
                "Synthetic context owner closure rejected before handle close",
              );
            await releaseContextHandle();
            if (timingCase || preResidentTimingCase) {
              produce("context");
              ownership.timing.context_close_fact = true;
              ownership.timing.context_close_receipt = true;
              updateTimingOwnership();
              await persist();
            }
          }
        },
      }),
    },
  }),
);
// Static loading would bind config before this subprocess installs its private
// paths. Preserve real sandbox exports before replacing only Docker ownership.
const sandboxModule = await import("../../src/server/sandbox.ts");
mock.module(resolve(import.meta.dir, "../../src/server/sandbox.ts"), () => ({
  ...sandboxModule,
  SandboxService: class {
    async prepare() {}
    snapshot() {
      return { status: "ready", error: null };
    }
    async createResidentWorker(): Promise<ResidentWorker> {
      ownership.worker_creations++;
      // A single real recorder delivery makes its independent cleanup meaningful.
      // No renderer, provider or external native process is started.
      for (const listener of listeners) listener(nativeFrame());
      if (
        mode !== "late-open" &&
        !windowCase &&
        !timingCase &&
        !preResidentTimingCase
      ) {
        await closeGuardian();
        throw new Error(
          "Synthetic selected-worker compilation rejected after joined guardian teardown",
        );
      }
      const handle = await open(join(root, "selected-worker.owner"), "wx");
      closeWorker = () =>
        (workerClose ??= handle.close().then(() => {
          ownership.worker_closed = true;
        }));
      if (preResidentTimingCase) {
        // Compilation is still pending: no ResidentController or native input
        // channel has been created. A real journal capacity failure initiates
        // Stop while this diagnostic request is owned by the native boundary.
        ownership.diagnostic_queries++;
        const pending = Promise.withResolvers<never>();
        const joined = pending.promise.finally(() => closeWorker!());
        pendingDiagnostics.set(900001, {
          span: {
            ...requestSpan(900001),
            method: "query_capability",
            native_timing: null,
          },
          reject: pending.reject,
        });
        ownership.close_reentry.pending_remaining = pendingDiagnostics.size;
        const count =
          Math.ceil(
            (16 * 1024 ** 2) /
              Buffer.byteLength(JSON.stringify(requestSpan(1))),
          ) + 1;
        for (let request = 0; request < count; request++) produce();
        updateTimingOwnership();
        return await joined;
      }
      if (windowCase) advanceClock(windowCase.compile);
      return {
        step: async () => {
          ownership.steps++;
          throw new Error("No post-fence worker step admitted");
        },
        close: closeWorker,
      };
    }
    async close() {
      await closeGuardian();
      if (closeWorker) await closeWorker();
      if (mode === "sandbox-close-rejected")
        throw new Error("Synthetic sandbox closure receipt rejected");
      ownership.sandbox_closed = true;
    }
  },
}));
const unhandled: string[] = [];
const onUnhandled = (error: unknown) => {
  unhandled.push(String(error));
};
process.on("unhandledRejection", onUnhandled);
// Deliberately load the actual slot and SDK graph after the isolated external
// boundaries above; static loading would bypass the subprocess-only mocks.
const { runResidentBenchmarkSlot } = await import(
  "../../scripts/native-resident-benchmark-slot.ts"
);
const postmortem = await import("@oh-my-pi/pi-utils/postmortem");
const unregister = postmortem.register(
  "resident-benchmark-ownership-observer",
  (reason) => {
    if (
      reason === postmortem.Reason.SIGINT ||
      reason === postmortem.Reason.SIGTERM
    )
      send({ event: "sdk-signal", reason });
  },
  { exitOnly: true },
);
try {
  if (windowCase) {
    clockOrigin = Math.floor(realPerformanceNow()) - 180000;
    clockEpoch = realDateNow() - 180000;
    ownership.clock = {
      origin_host_ms: clockOrigin,
      root_elapsed_ms: windowCase.root,
      compile_elapsed_ms: windowCase.compile,
      opened_elapsed_ms: windowCase.opened ?? null,
      restored_before_finalization: false,
    };
    Object.defineProperty(performance, "now", {
      configurable: true,
      value: () => clockOrigin + elapsed,
    });
    Date.now = () => clockEpoch + elapsed;
    clockInstalled = true;
  }
  await runResidentBenchmarkSlot(options);
  send({ event: "finished", unhandled });
} finally {
  restoreClock();
  gate.resolve();
  // Independent containment on fixture failure, not a substitute slot receipt.
  await Promise.allSettled([closeNative(), closeGuardian(), closeWorker?.()]);
  await Promise.allSettled([releaseNativeHandle(), releaseContextHandle()]);
  await persist();
  unregister();
  process.removeListener("message", onMessage);
  process.removeListener("disconnect", onDisconnect);
  process.removeListener("unhandledRejection", onUnhandled);
  if (process.connected) process.disconnect?.();
}
