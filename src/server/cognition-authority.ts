import type { StoredRun } from "./store.ts";
import type { StrategicHost } from "./strategic.ts";
import type { StrategicStore, CognitionRequestIdentity, CognitionResponseIdentity } from "./cognition-ports.ts";
import type { ToolRole } from "../shared/tool-policy.ts";
import { isToolAllowed } from "../shared/tool-policy.ts";
import { osMonotonicNs } from "./os-monotonic.ts";
import { RuntimeFault } from "./runtime-fault.ts";
import { isCognitionJson, sameCognitionArguments } from "./cognition-json.ts";

interface Turn { id: string; deadline: bigint; scope: string; decision: boolean; root: string | null; intent: number | null; calls: number; tools: number }
interface Request { identity: CognitionRequestIdentity; scope: string; deadline: bigint; calls: Map<string, { name: string; arguments: unknown }>; valid: boolean; speculativePermit?: () => void }
const decisionWakes: Record<string, true> = { preflight_ready: true, policy_replan: true, policy_interrupt: true,
  policy_error: true, trial_decision_due: true, selected_attention: true, resident_attention: true, program_no_effect: true,
  skill_outcome: true, death: true, uncertainty: true, goal_review: true };
const scope = (run: StoredRun) => JSON.stringify([run.run_id, run.world_id, run.session_id, run.epoch,
  run.life_id, run.native_boot_id, run.space_epoch, run.compatibility_hash, run.task, run.goal]);

/** Synchronous physical-host authority. A stalled child cannot keep or renew a grant. */
export class CognitionAuthority {
  #revision = 0;
  #fenced = true;
  #run: StoredRun | null = null;
  #generation = 0;
  #turn: Turn | null = null;
  #request: Request | null = null;
  #wakes = new Set<string>();
  #authoring: { root: string; source: string; turn: string; deadline: bigint; calls: number; tools: number; closed: boolean } | null = null;
  #active: { role: ToolRole; assert(): void } | null = null;
  constructor(private readonly store: StrategicStore, private readonly host: StrategicHost) {}
  start(run: StoredRun, generation: number): void {
    this.fence(); this.#run = run; this.#generation = generation; this.#fenced = false; this.#authoring = null;
  }
  wake(reason: string): void {
    if (Object.hasOwn(decisionWakes, reason)) this.#wakes.add(reason);
    if (Object.hasOwn(decisionWakes, reason) && reason !== "program_no_effect") {
      const planning = this.host.speculation?.();
      const speculativeRequest = this.#turn !== null && this.#request?.valid === true &&
        this.#request.identity.role === "speculative";
      if (speculativeRequest || planning?.projection()?.planning_active === true) {
        // The cognitive process may be stalled while a host tool awaits source
        // validation. Fence its captured permit before sending any wake over IPC.
        if (this.#request?.identity.role === "speculative") this.#request.valid = false;
        planning?.invalidate("cancelled");
      }
    }
    if (reason === "policy_interrupt" || reason === "resident_attention") {
      const authoring = this.#request?.identity.role === "authoring";
      const event = this.#run && reason === "resident_attention" ? this.store.latestEvent(this.#run.run_id, "controller.event") : null;
      const details = event?.details;
      const urgent = reason === "policy_interrupt" || details !== null && typeof details === "object" && !Array.isArray(details) &&
        details.event !== null && typeof details.event === "object" && !Array.isArray(details.event) && details.event.urgency === "urgent";
      if (authoring && urgent) { this.#request!.valid = false; if (this.#authoring) this.#authoring.closed = true; }
    }
    // Outcome/root identity is checked below at every tool commit, not via IPC.
  }
  fence(): void {
    this.#fenced = true; this.#revision++; this.#turn = null;
    if (this.#request) this.#request.valid = false;
    this.#active = null; this.#wakes.clear();
  }
  beginTurn(id: string, offered: bigint): bigint {
    const run = this.#current();
    const now = osMonotonicNs();
    const maxMs = run.status === "reviewing" ? 30_000 : 120_000;
    const maximum = now + BigInt(maxMs) * 1_000_000n;
    if (offered <= now || offered > maximum + 1_000_000n) throw new RuntimeFault("stale_context", "Invalid original cognition deadline");
    const root = this.store.latestRootExecution(run.run_id);
    this.#turn = { id, deadline: offered < maximum ? offered : maximum, scope: scope(run),
      decision: this.#wakes.size > 0, root: root?.execution_id ?? null,
      intent: root?.entry === "step" ? root.resident?.intent_version ?? 0 : null, calls: 0, tools: 0 };
    this.#wakes.clear();
    if (this.#request) this.#request.valid = false;
    return this.#turn.deadline;
  }
  endTurn(id: string): void {
    if (this.#turn?.id !== id) return;
    if (this.#request) this.#request.valid = false;
    this.#turn = null;
  }
  grant(identity: CognitionRequestIdentity): bigint {
    const run = this.#current(), turn = this.#turn, now = osMonotonicNs();
    const deadline = BigInt(identity.deadline_os_ns);
    let effectiveDeadline = deadline;
    if (!turn || turn.id !== identity.turn_id || turn.scope !== scope(run) || identity.generation !== this.#generation ||
      identity.phase !== run.status || deadline > turn.deadline || deadline <= now ||
      turn.calls >= (run.status === "reviewing" ? 3 : 12))
      throw new RuntimeFault("stale_context", "Cognition request authority expired");
    const root = this.store.latestRootExecution(run.run_id);
    const role = identity.role;
    let speculativePermit: (() => void) | undefined;
    if (run.status === "reviewing" ? role !== "review" : role === "review")
      throw new RuntimeFault("stale_context", "Cognition phase changed");
    if (role === "speculative") {
      const planning = this.host.speculation?.();
      if (!planning || planning.projection()?.plan_id !== identity.plan_id)
        throw new RuntimeFault("stale_context", "Speculative request belongs to a different flight");
      planning.assertToolAuthority();
      speculativePermit = planning.authority();
    }
    if (role === "ordinary" && this.host.programPending()) {
      if (!turn.decision || !identity.pending_decision || root?.execution_id !== turn.root ||
        (root?.entry === "step" ? root.resident?.intent_version ?? 0 : null) !== turn.intent)
        throw new RuntimeFault("stale_context", "Pending root has no current decision authority");
    }
    if (role === "authoring") {
      const settling = root?.status === "succeeded" && this.#authoring?.root === root.execution_id &&
        this.#authoring.turn === turn.id && this.#authoring.calls > 0;
      if (!root || !this.host.programPending() && !settling || !root.source_hash || root.execution_id !== identity.root_execution_id ||
        root.source_hash !== identity.source_hash || !["accepted", "running"].includes(root.status) && !settling ||
        root.parent_execution_id !== null || root.root_execution_id !== root.execution_id || root.run_generation !== this.#generation ||
        root.run_id !== run.run_id || root.world_id !== run.world_id || root.session_id !== run.session_id ||
        root.epoch !== run.epoch || root.life_id !== run.life_id || root.native_boot_id !== run.native_boot_id ||
        root.space_epoch !== run.space_epoch || root.compatibility_hash !== run.compatibility_hash)
        throw new RuntimeFault("stale_context", "Root-bound authoring was revoked");
      if (!this.#authoring || this.#authoring.root !== root.execution_id) {
        const remaining = Math.max(0, Math.min(60_000, Date.parse(root.deadline_at) - root.limits.duration_ms + 60_000 - Date.now(), Date.parse(root.deadline_at) - Date.now()));
        this.#authoring = { root: root.execution_id, source: root.source_hash, turn: turn.id,
          deadline: now + BigInt(Math.floor(remaining)) * 1_000_000n, calls: 0, tools: 0, closed: false };
      }
      const authoring = this.#authoring;
      if (authoring.closed || authoring.source !== root.source_hash || authoring.calls >= 3 || authoring.tools >= 12 ||
        now >= authoring.deadline || deadline > authoring.deadline + 2_000_000n ||
        identity.authoring_deadline_at === null || identity.authoring_deadline_at > Date.now() + Number(authoring.deadline - now) / 1e6 + 2)
        throw new RuntimeFault("stale_context", "Finite authoring allowance ended");
      authoring.calls++;
      if (effectiveDeadline > authoring.deadline) effectiveDeadline = authoring.deadline;
    }
    if (this.#request) this.#request.valid = false;
    turn.calls++;
    this.#request = { identity, deadline: effectiveDeadline, scope: scope(run), calls: new Map(), valid: true, speculativePermit };
    return effectiveDeadline;
  }
  response(response: CognitionResponseIdentity): void {
    const request = this.#request;
    if (!request || request.identity.request_id !== response.request_id) {
      // A refused pre-dispatch grant may still produce a failed SDK terminal
      // message. Keep its accounting, but it can never establish tool custody.
      if (!response.successful && response.calls.length === 0) return;
      throw new RuntimeFault("stale_context", "Response has no admitted request owner");
    }
    request.calls.clear();
    if (!response.successful) { request.valid = false; return; }
    if (response.calls.length > 48) throw new RuntimeFault("invalid_request", "Response tool allowance exceeded");
    const calls = new Map<string, { name: string; arguments: unknown }>();
    for (const call of response.calls) {
      if (!call.id || call.id.length > 512 || !isToolAllowed(request.identity.role, call.name) || request.calls.has(call.id) ||
        !isCognitionJson(call.arguments))
        throw new RuntimeFault("invalid_request", "Invalid response tool identity");
      if (calls.has(call.id)) throw new RuntimeFault("invalid_request", "Duplicate response tool identity");
      calls.set(call.id, { name: call.name, arguments: call.arguments });
    }
    request.calls = calls;
  }
  assertRequest(requestId: string): void {
    const run = this.#current(), request = this.#request;
    if (!request || !request.valid || request.identity.request_id !== requestId || request.scope !== scope(run) ||
      osMonotonicNs() >= request.deadline || run.status !== request.identity.phase)
      throw new RuntimeFault("stale_context", "Original cognition request grant was revoked");
    if (request.identity.role === "authoring") {
      const root = this.store.latestRootExecution(run.run_id), authoring = this.#authoring;
      if (!authoring || authoring.closed || osMonotonicNs() >= authoring.deadline || root?.execution_id !== authoring.root ||
        root.source_hash !== authoring.source || !["accepted", "running", "succeeded"].includes(root.status) ||
        root.run_generation !== this.#generation || root.world_id !== run.world_id || root.session_id !== run.session_id ||
        root.epoch !== run.epoch || root.life_id !== run.life_id || root.native_boot_id !== run.native_boot_id ||
        root.space_epoch !== run.space_epoch || root.compatibility_hash !== run.compatibility_hash)
        throw new RuntimeFault("stale_context", "Original root-bound request grant ended");
    } else if (request.identity.role === "speculative") request.speculativePermit?.();
  }
  /** Capture the original grant, not a renewable request-id-only lookup. */
  sdkFetch(identity: CognitionRequestIdentity): () => void {
    const request = this.#request, revision = this.#revision;
    const assert = () => {
      if (!request || this.#request !== request || this.#revision !== revision ||
        Object.keys(request.identity).some(key =>
          request.identity[key as keyof CognitionRequestIdentity] !== identity[key as keyof CognitionRequestIdentity]))
        throw new RuntimeFault("stale_context", "SDK fetch does not match the original cognition request");
      this.assertRequest(identity.request_id);
    };
    assert();
    return assert;
  }
  /** Admits one actual successful-response call; its closure stays local through awaits. */
  tool(requestId: string, callId: string, name: string, raw: unknown): { role: ToolRole; assert(): void; release(): void } {
    const request = this.#request, revision = this.#revision;
    if (!request || request.identity.request_id !== requestId || this.#active)
      throw new RuntimeFault("stale_context", "Tool has no exclusive response owner");
    const call = request.calls.get(callId);
    if (!call || call.name !== name || !sameCognitionArguments(call.arguments, raw))
      throw new RuntimeFault("stale_context", "Tool does not match the original provider arguments");
    request.calls.delete(callId);
    const root = this.#run ? this.store.latestRootExecution(this.#run.run_id) : null;
    const capturedRoot = root?.execution_id ?? null;
    const permit = { role: request.identity.role, assert: () => {
      const run = this.#current(), current = this.store.latestRootExecution(run.run_id);
      if (revision !== this.#revision || this.#request !== request || !request.valid || scope(run) !== request.scope || osMonotonicNs() >= request.deadline ||
        !this.#turn || this.#turn.id !== request.identity.turn_id || run.status !== request.identity.phase)
        throw new RuntimeFault("stale_context", "Local cognition tool authority was revoked");
      if (permit.role === "authoring") {
        const authoring = this.#authoring;
        if (!authoring || authoring.closed || osMonotonicNs() >= authoring.deadline || current?.execution_id !== authoring.root ||
          current.source_hash !== authoring.source || !["accepted", "running", "succeeded"].includes(current.status) ||
          current.run_generation !== this.#generation || current.world_id !== run.world_id || current.session_id !== run.session_id ||
          current.epoch !== run.epoch || current.life_id !== run.life_id || current.native_boot_id !== run.native_boot_id ||
          current.space_epoch !== run.space_epoch || current.compatibility_hash !== run.compatibility_hash)
          throw new RuntimeFault("stale_context", "Local authoring root authority ended");
      } else if (permit.role === "speculative") {
        request.speculativePermit?.();
      }
      else if ((current?.execution_id ?? null) !== capturedRoot && name !== "program_submit" && name !== "program_run" && name !== "task_finish")
        throw new RuntimeFault("stale_context", "Local decision root changed before commit");
    }, release: () => { if (this.#active === permit) this.#active = null; } };
    permit.assert();
    if (!this.#turn || ++this.#turn.tools > (this.#run?.status === "reviewing" ? 12 : 48))
      throw new RuntimeFault("stale_context", "Finite host tool allowance ended");
    // This method consumes a speculative tool, unlike the captured pure permit.
    // Charge exactly once; validation and commit may recheck authority repeatedly.
    if (permit.role === "speculative") this.host.speculation?.().assertToolAuthority(name);
    if (permit.role === "authoring" && this.#authoring && ++this.#authoring.tools > 12)
      throw new RuntimeFault("stale_context", "Finite authoring tool allowance ended");
    this.#active = permit;
    return permit;
  }
  toolRole(): ToolRole { return this.#active?.role ?? (this.host.run()?.status === "reviewing" ? "review" : "ordinary"); }
  toolAuthority(): () => void {
    const permit = this.#active;
    if (!permit) throw new RuntimeFault("stale_context", "No host-admitted cognition tool");
    permit.assert();
    return () => { if (this.#active !== permit) throw new RuntimeFault("stale_context", "Cognition tool owner ended"); permit.assert(); };
  }
  #current(): StoredRun {
    const run = this.host.assertCurrent(this.#generation);
    if (this.#fenced || this.host.run() !== this.#run || run !== this.#run)
      throw new RuntimeFault("stale_context", "Cognition authority is fenced");
    return run;
  }
}
