# Resident recovery and fault evidence

These are explicit local executive recovery modes, not application restart, whole-game checkpoint restore or a retry policy for arbitrary JavaScript exceptions. Original deadlines, counters, task keys, audio cursor and unknown outcomes survive.

## Recovery modes

`reset_safe` with finite max restarts creates a clean invocation with reset explicit state only after confirmed retirement and old-worker closure. Fresh activation decides applicability. It does not replay edges or restore a transactional checkpoint.

`checkpoint_safe` passes only the last committed validated JSON state. Pending decisions, events, input, module globals and stacks are discarded. Activation reconciles that JSON with fresh state and retained receipts; JSON cannot establish whether past effects happened.

Checkpoint-safe recovery may additionally handle trusted exact-owner native world-input timing faults whose first fence is `native_input_lease_expired` or `queued_frame_expired_before_application`. Untyped/foreign/unrelated faults or unconfirmed retirement refuse. Owners that saw an open screen or submitted screen/use/inventory input are excluded. Native retirement retains its unresolved owner reference and proves containment, not absent effects. No GUI transaction/input is replayed.

An exact-owner heartbeat-admission stale capture explicitly marked not dispatched may use either declared allowance. Dispatched faults follow the separate checkpoint-safe restrictions. No old heartbeat/decision is retried.

Before recovery, invalidate pending old-worker results; late state/events/effects cannot publish. Stop joins a pending factory and closes any late candidate. Unconfirmed candidate cleanup stays unknown. Fresh activation sees producer none after actual old retirement, preserving settled child outcomes/high-water mark.

Pre/post-computation checks prevent a raw lease expiring during evaluation from being renewed. Recovery-disabled/unavailable known expiry retains `session_recovery_refused` with `known_expired_raw_lease`; exhausted restart allowance retains `session_recovery_exhausted`. Neither reserves tasks nor extends a lease. Rejected task choices do not advance task keys.

## Fault origins

Trusted watchdog, source throw, invalid JSON return, transport, opaque and cleanup faults are distinct. Source exception text and mutable structural lookalikes cannot select host recovery categories. Source/opaque faults remain quarantined, and cleanup failure is containment.

Live branded diagnostics include resident watchdog/source-throw/invalid-return categories. Trusted channel faults project `native_controller_fault`, or cause unavailable if no channel evidence exists, with fixed public messages. They identify boundaries, not historical opaque causes or gameplay incapability.

Malformed authored shape is a result-validation failure, not proof of native cleanup failure. Rejected bounded plain data can reach the decoder for safe field/code hints; native retirement and worker closure stay separate. Nonfinite/unsupported JSON fails before commit with fixed `invalid_return_json`; getters/proxies/serialization hooks are not invoked, and valid null is data.

The first structured controller fault is immutable **per exact native owner/generation**. A deliberately retired owner's pending rejection cannot hide a later owner's fault. Records distinguish unsent admission, dispatched uncertainty, ACK validation and partial application; fault, retirement trigger and post-release ACK remain separate.

## Source diagnostic boundary

Source failures can retain an advisory validated JS error type and up to 1,000 code units of its own message, complete pinned realm hash and explicitly unmapped location. Non-error throws use constant text. No host path, stack, stderr, environment or arbitrary thrown properties cross.

Every boundary checks exact shape/current realm hash. The advisory is source-authored, untrusted and grants no native truth or authority. Only source-throw origin can carry it; forged host diagnostic objects remain redacted. Extraction stays inside original guarded compute allowance. Failure timing settles once; cleanup uncertainty stays separate.

Compile-once workers retain module globals during ordinary decisions. Explicit state is not automatic rollback. Shadow probes use disposable globals and cannot substitute for a fresh live activation.

Sources: [`control-session.ts`](../../src/server/control-session.ts), [`resident-controller.ts`](../../src/server/resident-controller.ts), [`resident-worker-fault.ts`](../../src/server/resident-worker-fault.ts). See [executive](executive.md), [recovery](recovery.md), [evidence](evidence.md).
