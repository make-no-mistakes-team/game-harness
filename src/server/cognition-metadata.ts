import type { UsagePurpose } from "../shared/contracts.ts";
import type { CognitionResponseIdentity, StrategicSpeculation } from "./cognition-ports.ts";
import { cognitionMetadataBatchSchema, type CognitionMetadata } from "./cognition-protocol.ts";
import { COGNITION_LIMITS } from "./cognition-wire.ts";
import type { Store, StoredRun } from "./store.ts";
import type { StrategicRequestAdmission } from "./strategic.ts";
import { recordCall, recordUsage } from "./usage.ts";
import { HOST_MONOTONIC_CLOCK_ID } from "./performance.ts";

const MAX_REQUEST_IDS = 4096;
const invalid = () => new Error("Invalid cognition metadata");
interface RequestState {
  reserved: boolean;
  purpose: UsagePurpose | null;
  classified: boolean;
  used: boolean;
  responded: boolean;
  transportEnded: boolean;
  drained: boolean;
  unsettled: boolean;
}

/** The child supplies ordered deltas, never a replacement run or usage snapshot. */
export class CognitionMetadataOwner {
  #sequence = 0;
  #requests = new Map<string, RequestState>();
  #applying = false;
  #failed = false;
  #finalized = false;
  #providerFailure = false;
  constructor(private readonly store: Store, private readonly run: StoredRun, private readonly hooks: {
    persist(summary?: string): void;
    response(response: CognitionResponseIdentity): void;
    speculation?: StrategicSpeculation;
    requestAdmission?: StrategicRequestAdmission;
    current(): boolean;
  }) {}

  requestAdmitted(id: string): boolean {
    const request = this.#requests.get(id);
    return !!request && request.reserved && request.purpose !== null && !request.drained && !request.responded;
  }
  beginTurn(): void { this.#providerFailure = false; }
  providerFailureObserved(): boolean { return this.#providerFailure; }

  /** Only after actual process, pipes and auth ownership have joined. */
  finalizeUnsettled(): void {
    if (this.#finalized) return;
    this.#finalized = true;
    for (const [requestId, state] of this.#requests) {
      if (state.purpose === null || state.responded || state.unsettled) continue;
      this.store.event(this.run.run_id, "model.request_unsettled",
        "The owned cognition process closed without final response accounting; consumption and provider attempt count remain unknown", {
          request_id: requestId, clock_id: HOST_MONOTONIC_CLOCK_ID, ended_monotonic_ms: performance.now(),
          purpose: state.purpose, purpose_source: "host_turn_role_v1", purpose_final: false,
          usage_reported: false, cognition_process_closed: true, provider_attempt_count: null,
          usage_evidence: { schema_version: 1, request_id: requestId, sdk_reported: null, provider_terminal: null,
            unaccounted_response_ids: ["<cognition-process-state-unavailable>"] },
        });
    }
    this.#persist();
  }

  /** Completion is the RPC barrier: every operation and host hook has run before return. */
  apply(batch: unknown): void {
    if (this.#failed || this.#applying) throw invalid();
    const text = JSON.stringify(batch);
    if (text === undefined || Buffer.byteLength(text) > COGNITION_LIMITS.metadataBytes) throw invalid();
    const parsed = cognitionMetadataBatchSchema.safeParse(batch);
    if (!parsed.success) throw new Error("Invalid cognition metadata", { cause: parsed.error });
    if (parsed.data.sequence !== this.#sequence + 1) throw invalid();
    // Validate the whole batch before any host writes or externally visible hooks.
    const requests = this.#validate(parsed.data.operations);
    this.#applying = true;
    try {
      for (const operation of parsed.data.operations) this.#apply(operation);
      for (const [id, state] of requests) this.#requests.set(id, state);
      this.#sequence = parsed.data.sequence;
    } catch (error) {
      // A real owner may already have admitted a request or persisted a delta.
      // Never replay a partly applied batch after an owner failure.
      this.#failed = true;
      throw error;
    } finally {
      this.#applying = false;
    }
  }

  #validate(operations: CognitionMetadata[]): Map<string, RequestState> {
    const changed = new Map<string, RequestState>();
    let size = this.#requests.size;
    const request = (id: string, create = false): RequestState => {
      const pending = changed.get(id);
      if (pending) return pending;
      const previous = this.#requests.get(id);
      if (!previous && (!create || size >= MAX_REQUEST_IDS)) throw invalid();
      if (!previous) size++;
      const state: RequestState = previous ? { ...previous } : {
        reserved: false, purpose: null, classified: false, used: false,
        responded: false, transportEnded: false, drained: false, unsettled: false,
      };
      changed.set(id, state);
      return state;
    };
    for (const operation of operations) {
      switch (operation.kind) {
        case "event":
          if (operation.run_id !== null && operation.run_id !== this.run.run_id) throw invalid();
          if (operation.type === "model.request_unsettled" && operation.details !== null &&
            typeof operation.details === "object" && !Array.isArray(operation.details) &&
            typeof operation.details.request_id === "string")
            request(operation.details.request_id).unsettled = true;
          break;
        case "request_reserve": {
          const state = request(operation.request_id, true);
          if (state.reserved || state.purpose !== null || state.drained || state.transportEnded) throw invalid();
          state.reserved = true;
          break;
        }
        case "call": {
          const state = request(operation.request_id, true);
          if (state.purpose !== null || state.drained || state.transportEnded) throw invalid();
          state.purpose = operation.purpose;
          break;
        }
        case "classify": {
          const state = request(operation.request_id);
          if (state.purpose !== operation.previous || state.classified || state.used || operation.previous === operation.purpose) throw invalid();
          state.classified = true;
          state.purpose = operation.purpose;
          break;
        }
        case "usage": {
          const state = request(operation.request_id);
          if (state.purpose !== operation.purpose || state.used) throw invalid();
          state.used = true;
          break;
        }
        case "response": {
          const state = request(operation.response.request_id);
          if (state.purpose === null || state.responded) throw invalid();
          const ids = new Set<string>();
          for (const call of operation.response.calls) {
            if (ids.has(call.id)) throw invalid();
            ids.add(call.id);
          }
          if (!operation.response.successful && operation.response.calls.length) throw invalid();
          state.responded = true;
          break;
        }
        case "transport_ended": {
          const state = request(operation.request_id);
          if (state.transportEnded || state.drained) throw invalid();
          state.transportEnded = true;
          break;
        }
        case "requests_drained":
          for (const id of operation.request_ids) {
            const state = request(id);
            if (state.drained) throw invalid();
            state.drained = true;
          }
          break;
        case "speculation_finish":
        case "speculation_invalidate":
          if (!this.hooks.speculation) throw invalid();
          break;
        case "progress":
        case "sdk_evidence":
          break;
      }
    }
    return changed;
  }

  #persist(summary?: string): void {
    if (this.hooks.current()) this.hooks.persist(summary);
    else this.store.saveRun(this.run, summary);
  }

  #apply(operation: CognitionMetadata): void {
    switch (operation.kind) {
      case "event":
        this.store.event(operation.run_id, operation.type, operation.summary, operation.details);
        if (operation.type === "model.request_settled" && operation.details !== null &&
          typeof operation.details === "object" && !Array.isArray(operation.details) &&
          (operation.details.provider_failure === true ||
            operation.details.stop_reason === "aborted" && !operation.details.host_cancellation))
          this.#providerFailure = true;
        break;
      case "progress":
        if (this.hooks.current() && (this.run.status === "running" || this.run.status === "reviewing")) {
          this.run.model_status = operation.model_status;
          this.hooks.persist(operation.summary);
        }
        break;
      case "request_reserve":
        this.hooks.requestAdmission?.reserve(operation.request_id, operation.model);
        break;
      case "call":
        this.run.turns++;
        recordCall(this.run.usage, operation.purpose);
        this.#persist();
        break;
      case "classify": {
        // Preserve StrategicPlanner's exact provisional-to-final bucket mutation.
        const previous = this.run.usage.by_purpose[operation.previous];
        const classified = this.run.usage.by_purpose[operation.purpose];
        if (previous.calls !== null) previous.calls--;
        if (classified.calls === 0 && classified.legacy_input === null) {
          classified.uncached_input = null;
          classified.cache_read = null;
          classified.cache_write = null;
          classified.output = null;
        }
        if (classified.calls !== null) classified.calls++;
        this.#persist();
        break;
      }
      case "usage":
        recordUsage(this.run.usage, operation.purpose, operation.usage);
        this.#persist();
        break;
      case "response":
        this.hooks.response(operation.response);
        break;
      case "sdk_evidence":
        this.hooks.requestAdmission?.evidence?.({ run_id: this.run.run_id,
          kind: operation.evidence_kind, body: operation.body });
        break;
      case "speculation_finish":
        this.hooks.speculation!.finish(operation.id);
        break;
      case "speculation_invalidate":
        this.hooks.speculation!.invalidate(operation.reason);
        break;
      case "transport_ended":
        this.hooks.requestAdmission?.transportEnded(operation.request_id, operation.closed);
        break;
      case "requests_drained":
        this.hooks.requestAdmission?.drained(operation.request_ids);
        break;
    }
  }
}
