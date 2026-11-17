// stdout is the private protocol, including during SDK/module initialization.
for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) console[method] = () => {};

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentTool, AgentToolResult, BeforeToolCallContext } from "@oh-my-pi/pi-agent-core/types";
import type { ResolvedApiKey } from "@oh-my-pi/pi-ai/auth-retry";
import type { Json } from "../shared/contracts.ts";
import type { PlanProjection } from "../shared/planning.ts";
import { StrategicPlanner, type StrategicHost } from "./strategic.ts";
import { CognitionAgentFactory } from "./cognition-inference.ts";
import { InlineCognitionContext } from "./cognition-context.ts";
import type { ContextOwner } from "./cognition-context.ts";
import type { ContextCustodyTransfer, PassiveContextState } from "./cognition-context-custody.ts";
import { CognitionWire, COGNITION_LIMITS } from "./cognition-wire.ts";
import { projectCognitionEvidence } from "./cognition-evidence.ts";
import { ReadonlyStore, type StoreReadLocation } from "./store-read.ts";
import type { StoredRun } from "./store.ts";
import type { StrategicOwnership, StrategicSpeculation } from "./cognition-ports.ts";
import type { CognitionMetadata, CognitionSnapshot, CognitionStart } from "./cognition-protocol.ts";
import { RuntimeFault } from "./runtime-fault.ts";
import { osMonotonicNs } from "./os-monotonic.ts";
import { createRuntimePrompt } from "./runtime-prompt.ts";
import { createMinecraftAdapter } from "./minecraft-adapter.ts";
import { runtimeToolDescriptors } from "./runtime-tool-catalog.ts";
import { usageCounter } from "./provider-usage.ts";
import { mainDecisionWindowStateSchema } from "./main-decision-window.ts";
import { validatePlayingAuthorityCeilings } from "./playing-authority.ts";
import { setTransports } from "@oh-my-pi/pi-utils/logger";

// The host's logger configuration is not inherited by a new process.
// Provider failures must not create an unowned home-directory transcript.
setTransports({ console: false, file: false });

let planner: StrategicPlanner | null = null;
let factory: CognitionAgentFactory | null = null;
let source: CognitionReadStore | null = null;
let snapshot: CognitionSnapshot | null = null;
let ownedRun: StoredRun | null = null;
let stopping = false;
let starting: Promise<void> | null = null;
let activeRequest = "";
let planningObservedAt = 0;
let observingSdk = false;
let observingDispatch = false;
let metadata: CognitionMetadata[] = [];
let metadataBytes = 0;
let metadataSequence = 0;
let flushing: Promise<void> = Promise.resolve();
let retained: InlineCognitionContext | null = null;
let custodySequence = 0;
let custodyFlushing: Promise<void> | null = null;
let custodyDirty = false;
let contextId: string | null = null;
let closing: Promise<void> | null = null;
const originalArguments = new WeakMap<AgentTool, Map<string, unknown>>();
type CognitionBoundary = "metadata_limit" | "snapshot_scope" | "tool_arguments" |
  "worker_unready" | "tool_admission" | "planning_scope" | "start_lifecycle" |
  "context_owner_missing" | "worker_fenced" | "context_cancelled" |
  "context_deadline" | "context_overlap" | "context_settlement" |
  "sdk_admission_deadline" | "protocol_inactive" | "protocol_method";
// Fixed host-selected categories only: never include resolver, provider,
// tool-argument or host-exception text in this public diagnostic.
const fail = (boundary: CognitionBoundary) => new RuntimeFault(`cognition_${boundary}`,
  `Ordinary cognition boundary failed (${boundary}).`);

function enqueue(operation: CognitionMetadata): void {
  const bytes = Buffer.byteLength(JSON.stringify(operation));
  if (metadata.length >= COGNITION_LIMITS.metadata || metadataBytes + bytes > COGNITION_LIMITS.metadataBytes)
    throw fail("metadata_limit");
  metadata.push(operation); metadataBytes += bytes;
}
async function flush(): Promise<void> {
  if (!metadata.length) { await flushing; return; }
  const operations = metadata; metadata = []; metadataBytes = 0;
  const sequence = ++metadataSequence;
  flushing = flushing.then(() => wire.call<void>("metadata", { sequence, operations })).catch(error => { wire.fail(); throw error; });
  await flushing;
}
async function transferCustody(kind: ContextCustodyTransfer["kind"], state: PassiveContextState,
  context_id: string | null = null): Promise<void> {
  await wire.call<void>("context_custody", { sequence: ++custodySequence, kind, context_id, state } satisfies ContextCustodyTransfer);
}
function journalCustody(): Promise<void> {
  custodyDirty = true;
  if (custodyFlushing) return custodyFlushing;
  if (contextId || !retained) return Promise.resolve();
  const work = (async () => {
    while (custodyDirty && !contextId) {
      custodyDirty = false;
      await transferCustody("journal", retained!.capture());
    }
  })();
  custodyFlushing = work;
  void work.finally(() => { if (custodyFlushing === work) custodyFlushing = null; }).catch(() => wire.fail());
  return work;
}
class CognitionReadStore extends ReadonlyStore {
  constructor(private readonly location: StoreReadLocation) { super(location); }
  readLocation(): StoreReadLocation { return this.location; }
  event(run_id: string | null, type: string, summary: string, details: Json = null): void {
    enqueue({ kind: "event", run_id, type, summary, details });
  }
}
function acceptSnapshot(next: CognitionSnapshot): void {
  if (ownedRun && ownedRun.run_id !== next.run.run_id) throw fail("snapshot_scope");
  if (ownedRun) Object.assign(ownedRun, next.run);
  else ownedRun = next.run;
  snapshot = next; snapshot.run = ownedRun;
  planningObservedAt = performance.now();
}
async function synchronize(): Promise<void> {
  await flush();
  acceptSnapshot(await wire.call<CognitionSnapshot>("synchronize", null));
}
function restoreOriginalArguments(context: BeforeToolCallContext): void {
  const calls = originalArguments.get(context.tool);
  if (!calls) throw fail("tool_arguments");
  const raw = context.toolCall.arguments;
  calls.set(context.toolCall.id, raw);
  // The actual supported SDK hook owns this original, not a forged RuntimeTools
  // WeakSet entry. execute transports it without the SDK's healed args object.
  if (context.args !== raw && context.args && typeof context.args === "object") {
    for (const key of Object.keys(context.args)) delete context.args[key];
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw))
      for (const key of Object.keys(raw)) Object.defineProperty(context.args, key,
        { value: raw[key], enumerable: true, configurable: true, writable: true });
    else Object.defineProperty(context.args, "__invalid_runtime_arguments", { value: true, enumerable: true, configurable: true });
  }
}
function tools(): AgentTool[] {
  if (!snapshot || !planner) throw fail("worker_unready");
  return runtimeToolDescriptors(planner.toolRole(), new Set(snapshot.modules)).map(descriptor => {
    const calls = new Map<string, unknown>();
    const tool: AgentTool = { ...descriptor,
      execute: async (callId, _healed, signal) => {
        if (signal?.aborted || !calls.has(callId)) throw fail("tool_admission");
        const raw = calls.get(callId); calls.delete(callId);
        await flush();
        const result = await wire.call<AgentToolResult<unknown>>("tool", {
          request_id: activeRequest, call_id: callId, name: descriptor.name, arguments: raw,
        });
        await synchronize();
        return result;
      },
    };
    originalArguments.set(tool, calls);
    return tool;
  });
}
function speculation(): StrategicSpeculation {
  return {
    projection: () => snapshot?.planning ?? null,
    remainingMs: () => Math.max(0, (snapshot?.planning_remaining_ms ?? 0) - (performance.now() - planningObservedAt)),
    pendingActivation: async () => {
      await flush();
      const result = await wire.call<{ view: PlanProjection | null; snapshot: CognitionSnapshot }>("planning_pending", null);
      acceptSnapshot(result.snapshot); return result.view;
    },
    begin: async () => {
      await flush();
      const result = await wire.call<{ view: PlanProjection | null; snapshot: CognitionSnapshot }>("planning_begin", null);
      acceptSnapshot(result.snapshot); return result.view;
    },
    requestCall: async () => { await flush(); return await wire.call<boolean>("planning_call", null); },
    finish: id => enqueue({ kind: "speculation_finish", id }),
    invalidate: reason => enqueue({ kind: "speculation_invalidate", reason }),
    assertToolAuthority: () => {
      if (!snapshot?.planning?.planning_active) throw new RuntimeFault("stale_context", "Speculative projection is closed");
    },
    authority: () => {
      const id = snapshot?.planning?.plan_id;
      return () => { if (!id || snapshot?.planning?.plan_id !== id || !snapshot.planning.planning_active) throw fail("planning_scope"); };
    },
  };
}
async function start(input: CognitionStart): Promise<void> {
  if (planner || starting || stopping) throw fail("start_lifecycle");
  acceptSnapshot(input.snapshot);
  observingSdk = input.observeSdk; observingDispatch = input.observeDispatch;
  const current = ownedRun!;
  source = new CognitionReadStore(input.location);
  const contextOwner = new InlineCognitionContext(input.location, osMonotonicNs, async (state, deadline, signal) => {
    if (!contextId) throw fail("context_owner_missing");
    if (stopping) throw fail("worker_fenced");
    if (signal?.aborted) throw fail("context_cancelled");
    if (osMonotonicNs() >= deadline) throw fail("context_deadline");
    await transferCustody("assembled", state, contextId);
  });
  retained = contextOwner;
  contextOwner.restore(input.retained_context);
  const context: ContextOwner = {
    open: () => contextOwner.open(), reset: () => contextOwner.reset(),
    rememberHelp: (topic, value) => { contextOwner.rememberHelp(topic, value); void journalCustody().catch(() => wire.fail()); },
    selectProgram: (name, version) => { contextOwner.selectProgram(name, version); void journalCustody().catch(() => wire.fail()); },
    assemble: async (assembly, options) => {
      const now = osMonotonicNs(), ceiling = now + 5_000_000_000n;
      const deadline = options.deadlineOsNs < ceiling ? options.deadlineOsNs : ceiling;
      if (contextId) throw fail("context_overlap");
      if (stopping) throw fail("worker_fenced");
      if (options.signal?.aborted) throw fail("context_cancelled");
      if (deadline <= now) throw fail("context_deadline");
      const id = randomUUID();
      await wire.call<void>("context_begin", { id, deadline_os_ns: deadline.toString() });
      let successful = false;
      try {
        await flush();
        await journalCustody();
        contextId = id;
        options.signal?.throwIfAborted();
        const result = await contextOwner.assemble(assembly, { ...options, deadlineOsNs: deadline });
        successful = true;
        return result;
      } finally {
        const current = successful && !stopping && !options.signal?.aborted && osMonotonicNs() < deadline;
        try {
          await wire.call<void>("context_end", { id, successful: current });
          // If a locally completed candidate lost scope before settlement,
          // retain the host's earlier journal; never publish it as a close.
          if (successful && !current) throw fail("context_settlement");
        } catch (error) { wire.fail(); throw error; }
        finally { contextId = null; }
        await journalCustody();
      }
    },
    close: () => contextOwner.close(),
  };
  factory = new CognitionAgentFactory(input.grant, {
    resolveKey: async (model, encoded, signal) => {
      const id = randomUUID();
      const cancel = () => { void wire.call("key_cancel", { id }).catch(() => {}); };
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        signal?.throwIfAborted();
        return await wire.call<ResolvedApiKey>("key", { id, model, context: encoded });
      } finally { signal?.removeEventListener("abort", cancel); }
    },
    release: async () => { await wire.call<void>("inference_release", null); },
  });
  // This is the actual registered default adapter, reconstituted from its exact
  // descriptor inside cognition. Its observation/context CPU is never host RPC.
  const adapter = createMinecraftAdapter(input.snapshot.adapter.descriptor);
  const host: StrategicHost = {
    mainDecisionWindow: input.mainDecisionWindow,
    ...(input.playingAuthorityCeilings === undefined ? {} : {
      playingAuthorityCeilings: validatePlayingAuthorityCeilings(input.playingAuthorityCeilings),
    }),
    run: () => current,
    generation: () => snapshot!.generation,
    assertCurrent: (generation, epoch) => {
      if (stopping || generation !== snapshot!.generation || epoch !== undefined && epoch !== current.epoch ||
        !["running", "reviewing"].includes(current.status)) throw new RuntimeFault("stale_context", "Cognition scope changed");
      return current;
    },
    tools,
    rootPrompt: () => createRuntimePrompt(current, input.goal),
    adapter: () => adapter,
    observe: async () => { await flush(); return await wire.call("observe", null); },
    modelObservation: async () => { await flush(); return await wire.call("model_observation", null); },
    projectObservation: (observation, previous) => adapter.projectObservation(observation, previous),
    policies: () => snapshot!.policies,
    action: () => snapshot!.action,
    programPending: () => snapshot!.programPending,
    busy: () => snapshot!.busy,
    persist: summary => enqueue({ kind: "progress", model_status: current.model_status, ...(summary === undefined ? {} : { summary }) }),
    pause: (message, cause) => { void flush().then(() => wire.call("pause", { message, cause })).catch(() => wire.fail()); },
    terminal: (status, message) => { void flush().then(() => wire.call("terminal", { status, message })).catch(() => wire.fail()); },
    speculation,
    reviewContext: async options => {
      const remaining = Math.max(0, options.deadlineHostMs - performance.now());
      return await wire.call("review_context", { deadline_os_ns: (osMonotonicNs() + BigInt(Math.floor(remaining)) * 1_000_000n).toString() });
    },
    reviewComplete: () => { void flush().then(() => wire.call("review_complete", null)).catch(() => wire.fail()); },
    requestAdmission: {
      reserve: (request_id, model) => enqueue({ kind: "request_reserve", request_id,
        model: { id: model.id, provider: model.provider, api: model.api } }),
      transportEnded: (request_id, closed) => enqueue({ kind: "transport_ended", request_id, closed }),
      drained: request_ids => enqueue({ kind: "requests_drained", request_ids: [...request_ids] }),
      ...(input.admitSdkFetch ? {
        beforeSdkFetch: async (request, options) => {
          const id = randomUUID();
          const cancel = () => { void wire.call("sdk_fetch_cancel", { id }).catch(() => {}); };
          options.signal.addEventListener("abort", cancel, { once: true });
          try {
            options.signal.throwIfAborted();
            await wire.call<void>("sdk_fetch", { id, identity: request.identity, model: request.model });
            options.signal.throwIfAborted();
            if (stopping) throw fail("worker_fenced");
            if (osMonotonicNs() >= options.deadlineOsNs) throw fail("sdk_admission_deadline");
          } finally { options.signal.removeEventListener("abort", cancel); }
        },
      } satisfies Pick<NonNullable<StrategicHost["requestAdmission"]>, "beforeSdkFetch"> : {}),
    },
  };
  const ownership: StrategicOwnership = {
    synchronize, flush,
    ...(input.mainDecisionWindow ? { decisionWindowState: async () => {
      // Settle every preceding real reservation before reading the host count.
      // The closed tag is data, never an exception in an atomic metadata batch.
      await flush();
      return mainDecisionWindowStateSchema.parse(await wire.call("decision_window", null));
    } } : {}),
    beginTurn: async (id, deadline) => { await flush(); await wire.call("turn", { id, deadline_os_ns: deadline.toString() }); },
    endTurn: async id => { await flush(); await wire.call("turn_end", { id }); },
    dispatch: async (identity, request) => {
      await flush();
      await wire.call("dispatch", { identity,
        ...(observingDispatch ? { model: request.model, context: request.context } : {}) });
      activeRequest = identity.request_id;
    },
    evidence: (kind, body) => {
      if (observingSdk) enqueue({ kind: "sdk_evidence", evidence_kind: kind, body: projectCognitionEvidence(kind, body) });
    },
    response: response => enqueue({ kind: "response", response: { ...response, calls: response.calls.map(call => ({ ...call, arguments: call.arguments as Json })) } }),
    beforeTool: async context => { restoreOriginalArguments(context); await flush(); },
    call: (_run, purpose, request_id) => enqueue({ kind: "call", request_id, purpose }),
    classify: (_run, previous, purpose, request_id) => enqueue({ kind: "classify", request_id, previous, purpose }),
    usage: (_run, purpose, usage, request_id) => enqueue({ kind: "usage", request_id, purpose,
      usage: { input: usageCounter(usage.input), cacheRead: usageCounter(usage.cacheRead),
        cacheWrite: usageCounter(usage.cacheWrite), output: usageCounter(usage.output) } }),
    timing: { clockId: input.timing.clock_id,
      now: () => input.timing.host_origin_ms + Number(osMonotonicNs() - BigInt(input.timing.os_origin_ns)) / 1e6 },
  };
  planner = new StrategicPlanner(source, factory, host, { context, ownership });
  const work = planner.start(input.snapshot.generation); starting = work;
  try { await work; } finally { starting = null; }
}
async function close(): Promise<void> {
  if (closing) return await closing;
  stopping = true; factory?.revoke(); planner?.fence();
  closing = (async () => {
    await starting?.catch(() => {});
    await planner?.close();
    await factory?.close();
    await flush();
    if (retained) {
      await retained.close();
      await journalCustody();
      await transferCustody("closed", retained.capture());
    }
    source?.close(); source = null;
  })();
  return await closing;
}
const wire = new CognitionWire(process.stdin, process.stdout, async (method, body) => {
  if (method === "start") { await start(body as CognitionStart); return { pid: process.pid }; }
  if (method === "close") { await close(); return null; }
  if (method === "fence") { stopping = true; factory?.revoke(); planner?.fence(); return null; }
  if (method === "turn_cancel") {
    const input = z.object({ id: z.string().min(1).max(512) }).strict().parse(body);
    planner?.cancelTurn(input.id); return null;
  }
  if (method === "evidence") {
    const input = z.object({ sdk: z.boolean(), dispatch: z.boolean() }).strict().parse(body);
    observingSdk = input.sdk; observingDispatch = input.dispatch; return null;
  }
  if (!planner || stopping) throw fail("protocol_inactive");
  if (method === "wake") {
    const input = body as { reason: string; snapshot: CognitionSnapshot };
    acceptSnapshot(input.snapshot); planner.wake(z.string().max(160).parse(input.reason)); return null;
  }
  if (method === "admitted") { acceptSnapshot(body as CognitionSnapshot); planner.admitted(); return null; }
  if (method === "attention") { const input = body as { ms: number; reason: string }; planner.attentionAfter(input.ms, input.reason); return null; }
  throw fail("protocol_method");
}, () => { stopping = true; factory?.revoke(); planner?.fence(); process.exitCode = 1; process.stdin.destroy(); });
void wire.ended.then(async () => { await close().catch(() => {}); process.stdin.destroy(); }).catch(() => {});
process.stdout.on("error", () => {});
