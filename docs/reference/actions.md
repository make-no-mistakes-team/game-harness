# Action authority and outcomes

The generic GameHarness arbiter is the only effect-admission owner. Registered adapter schemas define game-specific arguments, units, preconditions and completion evidence; a generated program never receives the raw client.

## Admission and deduplication

Validate adapter arguments before durable admission/preemption and again before native dispatch. New effects require a real owning execution or authored policy; direct strategic action-submit/cancel tools and ownerless effects are removed. Historical strategist-origin records remain readable without relabeling.

An action ID plus identical canonical content returns the existing ledger job without redispatch. Changed content conflicts. A revision cancels the old action and submits a new identity with a supersession link; it waits for safe transfer. Stable IDs do not make external effects exactly once.

Skill admission atomically stores `(run_id,start_key)`, canonical request/fingerprint, one execution identity and its event before any dispatch. Model-facing tools derive this identity from the actual tool-call ID; models do not supply internal keys. Names resolve to exact source once. Matching retries return historical identity even after closure or epoch change; changed args/limits/scope/preconditions conflict. Missing keys require current authority. Retain mappings with the run; retired runs reject starts rather than forgetting old keys.

Pre-commit crash dispatches nothing. Post-commit crash remains discoverable: accepted-undispatched work is cancelled, dispatched unfinished work is unknown, and no retry restores or extends execution.

## Effect scope and screens

[`control.ts`](../../src/shared/control.ts) owns scope, invocation and screen validators. Scope binds session/world/epoch/native boot/run generation/life/space and exact execution/source. Policies and diagnostics use real invocation owners without fabricated skill rows. Java counters remain nonnegative JavaScript-safe integers, not narrowed ints.

Live `expected_screen` is a **required discriminated union**:

- `absent`: there must be no screen.
- `transaction`: exact helper screen identity, incarnation and transaction revision.
- `layout`: visible-screen identity, incarnation and layout revision.

Null, untagged and omitted preconditions are not live authority. Host receive checks do not complete GUI validation: native application rechecks layout and local cursor/source predicates. A helper may follow its own UI transitions only after its initial checks and under continuous ownership. Queued work cannot inherit a replacement screen.

Targets carry incarnation, life and space, not an executable bare ID. Native world/player/position/block/entity/handler hooks invalidate stale references. Same coordinates do not establish the same block incarnation.

## Outcomes

| State | Meaning |
| --- | --- |
| `accepted` | Durable queued work without an executing lease |
| `running` | Only state that may hold the executing leaf lease |
| `cancel_requested` | Cancellation pending; actual completion may win |
| `succeeded` | Declared completion evidence observed, not larger-task success |
| `failed` | Known failure; partial effects may exist |
| `cancelled` | No emitter remains under the declared cancellation procedure; prior effects are not undone |
| `unknown` | Completion or safe cancellation/result could not be established; uncertainty remains after containment |

Accepted work can run, fail or enter cancellation. Running work can succeed, fail, become unknown or enter cancellation. Cancellation can settle as cancelled, succeeded, failed or unknown. A timeout never manufactures cancelled.

`world_effect_emitted` and `camera_changed` are distinct. Preparatory aiming alone does not make a refused world interaction unknown. Conversely, an emitted packet can remain unknown despite local pass/fail prediction. Neutralization establishes closure, never rollback, unchanged state, damage, removal or production.

Capabilities declare acknowledged neutralization or a documented fence/disconnect procedure, finite cancellation bounds and remaining effect window. No safe bounded fence means no admission. Only confirmed neutralization or actual emitter removal permits the next lease.

## Arbitration and freshness

Order: host Stop, descending permitted priority, then durable submission order. Equal priority is deterministic. A composite action may coordinate compatible movement/view/interaction inside one lease; independent channel writers cannot bypass exclusivity.

Policy `continue` leaves work without renewing it; `interrupt` cancels an exact active action; `replace` waits for its retirement or atomically acquires an observed idle lease; `replan` requests cognition without implicitly cancelling. Idle→busy→idle does not restore an old idle proposal's authority.

Final effect admission checks current run/session/world/epoch/alive life, authorized source/version/generation, target action/lease, input age/deadlines and mandatory domain dependencies. The adapter repeats immediate checks. **It does not require the latest observation sequence:** unrelated newer observations need not invalidate a still-fresh result, while changed dependencies invalidate it immediately.

Managed policy replacement joins cancellation and owning-worker drain, then waits for the captured action pump to clear current and advance its lease. It obtains settled lease/native neutralization and rechecks authority before admission. Cancellation must not await that pump (which itself awaits cancellation). This order also governs policy-to-policy replacement.

Finite queues/cadence, one evaluation per version, proposal rate limits and explicit busy/skipped/coalesced results constrain storms. Overload supplies no fallback tactic and cannot postpone Stop.

Sources: [`action-arbiter.ts`](../../src/server/action-arbiter.ts), [`session-effects.ts`](../../src/server/session-effects.ts), [`effect-contract.ts`](../../src/server/effect-contract.ts). See [recovery](recovery.md), [input](input.md) and [inventory](inventory.md).
