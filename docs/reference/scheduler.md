# Strategic scheduling and request ownership

The experimental scheduler drives one strategic agent. It is not a second agent or game engine. Local execution and eligible policies proceed independently while inference waits, within existing effect authority.

## Wakes and finite turns

Preflight readiness, task change, root closure/meaningful outcome, policy replan, reconciled recovery/uncertainty, genuinely absent runnable work and due improvement can wake strategy. Leaf results inside a pending program return to that program, not another prompt. Tick/observation polling is not a wake source.

Durable state retains selected event boundary, pending reasons/source references, turn/generation, attempts, empty-turn count and finite wait/backoff. Coalescing merges redundant reasons without dropping unconsumed intervals. A successful turn commits decisions and cursor together; later events stay pending. A tool rejection the model handled is evidence, not automatically whole-turn failure.

One request remains in flight through actual prior transport settlement. Pause/Stop/task/recovery revoke output and request cancellation where supported; they do not authorize concurrent replacement inference. Late results remain historical, never current tools/effects.

An empty successful response with no work/meaningful wait arms one cooldown, then automatically wakes once. At the consecutive-empty limit, planning stalls and safely fails. Declared waits need an observable condition and finite deadline. Another empty response/retry renews no allowance. Unhandled provider/transport or missing required opportunity decision leaves selected feedback unconsumed.

Broader release configuration selects 100-ms coalescing, 32 reasons/64 context events, three actual attempts with 1,000/5,000-ms backoff, 12 provider invocations and 120,000 ms/turn, 5,000-ms empty cooldown and three consecutive empty turns. These are chosen settings, not measurements; freeze actual configuration equally across matched arms. Current ordinary decisions also have a 48-tool bound.

## Inactive authoring beside a root

A live admitted root opens at most three SDK calls, twelve tools and 60,000 ms of inactive authoring, clipped to original turn/root deadlines. Entry begins at the next request after the starting tool group returns. One shared [`tool-policy.ts`](../../src/shared/tool-policy.ts) registry governs catalog **and** dispatch.

Allowed: observe, help, readonly inspect, inactive write/edit. It cannot play, change intent, stage successor, finish task, assess outcomes or mutate reflex/memory. Top-level experiment reason is unavailable; card motivation remains inert. Hiding a tool is not an authority check.

Scope/root/source/generation and original bounds are rechecked before/after awaits and publication. Revisions, child admissions, passive continuations and intent changes do not replenish this root's authoring window. Already admitted pure authoring can finish after successful predecessor settlement, within its original window, without inheriting effects. Failure revokes it at the outcome wake; urgent authored attention/policy interruption revokes immediately, retaining saved drafts and joining actual request before ordinary decision.

Explicit ordinary attention/outcome/recovery decisions retain normal authority through intermediate reads/writes until primary root replacement/retirement or intent change settles the decision. Worker readiness alone does not consume it. Selecting delayed attention ends the current loop after its tool group; the timer owns a fresh turn. No ordinary allowance renews root authoring bounds.

## Cancellation classification

Before SDK abort, a private exact-request owner records first cancellation intent. Repeated fences cannot replace it; terminal-received latch prevents after-the-fact provenance.

Only an actual final SDK aborted response with prior intent is trusted host cancellation. Root-bound authoring carries its original request/root/reason; other lifecycle/preemption/deadline cancellations use strategic-host identity and admitted role. Fencing/preemption is obsolete; deadline can cancel still-current work.

This prevents a deliberate host abort being called provider outage while retaining raw recovery metadata and unknown usage. Provider errors, recovered non-aborts, unmarked aborts, unsettled requests and unconfirmed drain remain failures. Cancellation never grants tools, successful progress or consumed feedback.

Expiry of a decision window can defer cognition **only after transport joins** when a running unended step executive has processed a frame, open worker/native owners, exact current scope and future original deadline. It records deferred/idle cognition with selected feedback unconsumed. No retry, renewal, restart or automatic wake occurs; a later ordinary signal can request a new turn. Otherwise ordinary pause behavior applies.

## Main request windows and transport

Optional `mainDecisionWindow.maxRequests` is a positive safe integer, no global default. Charge logical Main requests once at reservation across turns/roles; exclude Source preparation and do not count SDK retries as logical requests. Final admitted response/tools and transport finish before sticky request-limit closure. Later wakes cannot reopen it.

Closure joins cognition/auth owners without logout or changing selected account. A valid executive may continue only under its original scope/deadlines/budgets and the same continuation gates above. Stop still revokes it. Provider/external admission/scope faults remain failures.

Main receives configured max/admitted/remaining counts **after its own reservation**. A 24-request window yields 1/23 first and 24/0 last; these are not inclusive run usage. Readonly window query is not atomic reservation.

Cognition preserves selected SDK transport options; no added session cache silently enables persistent WebSockets. Optional before-fetch admission runs for each actual SDK fetch/retry under original identity/deadline without credentials/transport args. Fetch counts are not WebSocket, redirect, wire-attempt or consumption counts.

Cross-process deadlines use Linux CLOCK_MONOTONIC. Expiry immediately revokes authority; up to one second is cancellation/settlement only. Unresponsive ownership is contained and pauses for operator recovery without automatic process restart, model retry or embedded fallback.

## Tool argument resource guard

Actual advertised tool schemas bound decoded property names/string prefixes before SDK parsing. Unknown/unbounded alternatives decline the corresponding guard; nested free JSON is not generally restricted. Duplicate-key overwrites renew no prefix budget.

First overrun latches exact request and records only tool/schema path/numeric limits. Every tool in the response is refused, even completed siblings or terminal races. Join interrupted owner before explicit correction within original remaining turn calls/tools/role/deadline; gameplay need not retire. No truncation/coercion/early execution. Real provider failure retains its classification.

Sources: [`strategic.ts`](../../src/server/strategic.ts), [`cognition-authority.ts`](../../src/server/cognition-authority.ts), [`strategic-cancellation.ts`](../../src/shared/strategic-cancellation.ts). See [context](strategic-context.md), [reactions](reactions.md), [improvement](improvement.md).
