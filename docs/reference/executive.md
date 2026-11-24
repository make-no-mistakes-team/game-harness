# Local executive and resident execution

The experimental desktop's run-creation HTTP route defaults to executive control; embedded Runtime callers retain legacy unless selected explicitly. Executive roots are `step` with session schema 1. Direct run and raw-only step playing roots require explicit legacy mode. Manifests record the mode.

[`control-session.ts`](../../src/shared/control-session.ts), [`resident.ts`](../../src/shared/resident.ts) and generated controller help own exact return/task/session/frame schemas. The host supplies no survival or targeting policy.

## Decisions and physical producers

Synchronous activate/step return choice, next state, status and events; activation can explicitly refuse. Terminal accepted returns retain validated software state/timing/events but **do not apply their final choice**. Stale, stopped, superseded or over-budget results publish no state. Terminal callbacks see terminal status before requesting another intent.

| Choice | Meaning |
| --- | --- |
| raw with input | Select raw producer; a switch retires old control and discards this switch-time input |
| raw with null input | Keep/open raw producer without submission; a fresh choice may renew its short lease |
| ensure task | Reserve one immutable keyed semantic action or pinned run child |
| continue | Supervise the exact live child; settled handles are lookups |
| cancel | Fence exact child and join physical retirement |
| observe | Observation-only decision; retires raw control without supervising a child |

An ensure-task reserves its key/request immediately even while raw retirement is pending. A later fresh continue or identical ensure starts it once. Deadline includes retirement. Cancelling before dispatch settles a nonreplayable no-emission handle. Keys advance monotonically; detail eviction never makes an old key executable. Unknown detail remains retained. Children share finite task/action/call/depth limits.

Software `frame.executive` is not game truth. Task summaries fit 24 KiB with durable history references and explicit omissions. No-input waits still consume frames/steps/time and scope/freshness checks; they have no input sequence, ACK, receipt, release or replay. They do not stop held keys/view rate.

Child settlement/confirmed retired unknown effects need not end the executive. Unconfirmed cleanup or reconnect need still contains it. Fresh keyed calls are not continuation of an async stack, and no restart or child start renews the original deadline.

## Sampling and leases

One independent read lane and latest-capture mailbox run beside one VM decision. New captures replace unused ones, not queue them. A fresh capture can wake an available opportunity immediately, but starts remain at least one configured period apart. Discard mailbox captures older than one sampling period or 150 ms, whichever is smaller, before source runs.

Pin read channel and producer-transition generation before await. Opening/retiring/superseded captures cannot enter a successor. Raw captures must be at least as new as the latest confirmed application ACK; late delivery does not freshen an older pose. Skipped captures consume read, not step, budgets. Stop fences/joins read, worker and exact retirement.

Controller reads compare **delivery-time** screen identity, not the starting screen. A screen-only superseded frame is discarded without source/state/audio-cursor/lease/input changes; scope/profile/life/space and transport faults retain failure handling. Existing leases still expire.

Fresh exact captures at most 150 ms old can supervise semantic work for 250 ms. Expiry fences motor/input/deferred GUI emission but permits reconciliation. Sampling alone never renews: a fresh accepted authored choice does. Independent reflex writers cannot preempt an executive; its own decisions choose interruptions.

Raw-only residents run absolute 1/5/20 Hz slots, skip missed slots without catch-up and permit one step at a time. One-hertz control cannot maintain the 250-ms lease. Resident reads await a newer render and tick, retain a two-second original read deadline and do not synchronize RGB/body. Read waiting and missed slots are cadence evidence, not application latency.

Step `step_ms` is guarded wall time beginning before Docker dispatch, including transport/evaluation/serialization, not CPU. Host response wait is separately bounded to 500 ms and root deadline. No waiting heartbeat. Returned decisions still pass capture age and pre/post-compute lease checks before state/renewal.

Heartbeat dispatch precedes ordered input without awaiting its ACK. Eight outstanding heartbeats is finite; saturation fences. Renewals cannot exceed the immutable native deadline accepted at open. Host expiry follows dispatch-owned authority, not an older flight or later ACK.

## State, intent and analysis

State/intent each fit 16 KiB; complete output fits 64 KiB/depth 32. Initial state defaults null; null and `{}` differ. Intent updates compare expected version (initial zero), increment it and discard old in-flight results.

One effect-free analysis job can run beside either controller with original cumulative job/time bounds. Intent changes mark its result stale. Optional activation/decision validation checks software shape after charging evaluation; refusal is valid activation shape, not live acceptance. Output never changes intent/control automatically.

Evaluation time excludes compile/removal; nullable post-evaluation time covers callback receipt through service settlement on the host clock. Root lifetime still includes all startup/cleanup. Stop joins actual analysis settlement; unknown cleanup stays unknown.

## Attribution and attention

`last_submission` identifies source frame and actual controller generation/sequence, not application. Null waits leave it unchanged; retirement clears it. Retain that pair before a later submission replaces it. `last_input` is latest ACK, not a delivery log; frames may skip ACKs. Attack callbacks may remain visible without their ACK. Correlate channels independently; submission/callback/ACK proves neither damage nor kill.

Historical execution's native-life relation compares known world/session/epoch/boot/life identities: same, different or unknown. Space-only transitions do not change life; matching life says nothing about alive status or effects.

Authored diagnostics remain bounded passive evidence without waking cognition. Attention requests one ordinary serialized decision; it cannot interrupt an admitted response, mint concurrent inference or renew bounds. Cumulative event limits include diagnostics; transition-gate reports instead of repeating completion. Main still owns unverified custom completion.

Mechanical advisories are separately attributed: five seconds of producerless no-input decisions, confirmed neutral/stationary input, or view/observe occupancy can request strategy. Each has distinct exclusions, freshness/gap checks and a one-per-interval latch. They infer neither uselessness, collision nor application where unconfirmed, and select no response. See [diagnostic sources](../../src/server/executive-incidents.ts).

See [input](input.md), [local recovery](resident-recovery.md), [handoff](handoff.md) and [scheduler](scheduler.md).
