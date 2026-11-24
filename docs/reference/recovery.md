# Recovery, checkpoints and restoration

Current generic GameHarness provides live safe reconciliation and retained evidence after restart. General whole-process continuation, ordinary async-module checkpoints and game restore are broader requirements, not implied by database/world files.

## Healthy-session uncertainty

Historical unknown outcome and live emitter are different facts. For a healthy alive connected session, synchronously fence affected roots/planner/policies/leases, retain unknown ledger, join real native neutralization plus every worker/history-owner closure, then obtain fresh same-session/life authorized observation.

Only confirmed gates admit one new strategic generation/uncertainty wake. The model chooses new work; infrastructure never replays the uncertain effect. Operator Resume is unnecessary for this successfully reconciled case. Original outcome remains unknown.

Missing safety/readiness keeps admission closed in paused/fail-closed handling. Failed native/emitter drain requires new epoch. History-only failure does not confer input/reconciliation authority. Actual transport loss follows owned-emitter containment; death transfers to life recovery. Explicit Pause/Stop intent takes precedence.

## Pause, provider failure and application restart

Live Resume needs confirmed prior drain and fresh authorized state/new generations. A provider-only failure does not itself require new session/epoch; current strategic failure records cause and pauses. Restore readiness and deliberately Resume; silent provider replacement is not success of failed request.

Application restart marks accepted-undispatched cancelled, dispatched unfinished unknown and closes interrupted nonterminal run stopped. Source/objective/events remain inspectable. Create a **new run** for subsequent gameplay; stopped cannot Resume. No automatic old program replay, saved stack/conversation continuation, worker restoration or world rewind.

## Required same-run infrastructure recovery

Broader release continuation must preserve run ID, outage/intervention and unknown history:

1. Close admission; preserve Pause/Stop; revoke and actually fence/join old workers/connections.
2. Reopen compatible durable state and reconcile last committed run/action/events and incomplete writes.
3. Reconnect closed-to-effects, verify manifest, advance/persist epoch before effects and reobserve. Old-process monotonic deadlines do not establish freshness.
4. Mark no-start jobs invalidated; dispatched unproven effects unknown. Current state can inform new decisions without inventing exactly-once history.
5. Hash-verify compatible source/serializable state and reconcile world-local memory/branch uncertainty.
6. Record old/new epoch, outage, unresolved effects, artifact/memory choices and interventions. Honor pause/stop, resume only after gates, or fail with evidence.

This is a requirement, not delivered transparent application restart.

## Runtime and game checkpoints

Task recovery uses versioned serializable JSON plus unresolved operation references, never stacks/promises/closures. Compatible source/state, fresh state and closed prior owners are mandatory. Unknown effects are never repeated because a checkpoint predates their result.

Runtime checkpoint binds manifest/run/world/epoch/branch, event boundary, ledger, source/state schemas and memory. It does not capture game. Incomplete checkpoint is not recoverable. Derived-history checkpoint is only projection bookkeeping.

Immutable bytes persist before registry references; related state/event changes transact together. Lossy summaries cannot replace ledger/source/world. Consistent SQLite backup must include live WAL state through supported backup procedure, not copy main file alone.

Each adapter independently declares checkpoint/reset/restore/world-pause unsupported, operator-assisted or adapter-managed. Unsupported fails; assistance stays pending until attributed confirmation. Declaration specifies consistency boundary, needed neutralization, whether environment evolves and completion evidence. No database transaction atomically commits external game effects.

## World restoration and rollback

Close admission/fence old work before reset/restore. Older checkpoint restore keeps world lineage, allocates rollback branch, records parent checkpoints and advances epoch. Invalidate/mark uncertain post-restore facts, locations/inventory/UI assumptions and branch-provenance memory. Compatible abstract experience may remain but evaluation attributes intervention/advantage.

Replacement environment receives new world ID and invalidates local memory. Reobserve/check compatibility before resumed effects. Policy rollback only selects prior source for future decisions; it restores neither game nor elapsed time. Video playback is not deterministic rewind.

## Minecraft saves

When supported, coordinated backup neutralizes, requests save/flush and captures separate world/runtime checkpoints with their own acknowledgement/event bounds. World may tick between boundaries; record interval, never atomic snapshot. Stricter backup may need explicit attributed server shutdown.

Directories alone do not establish valid restorable backup. Trusted verifier may inspect actual task state through separate privileged path; that state cannot enter planner or experience. Existing data is not automatically deletion-owned; [development policy](../development/model-runs.md) governs new work separately from [frozen evaluation](../evaluation/policy.md).

See [lifecycle](lifecycle.md), [resident recovery](resident-recovery.md), [history](history.md), [security](security.md).
