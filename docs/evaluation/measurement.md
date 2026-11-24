# Measurement and useful continuity

Freeze task/verifier, progress/non-regression predicates, horizon/stops/scoring,
model/provider/settings/auth category, allowed references/backends, helpers,
snapshot and actual initial-state/reset/rollback identity before play. Pin the
negotiated game/adapter/build, schemas/capabilities, complete materialized
observation settings/fingerprint and interface—not merely a profile label.
Minecraft records server flavor/build and effective per-dimension Anti-Xray
configuration privately. Hidden evaluator state never enters actor feedback.
Changed permissions/settings start a new series.

Source definitions/validators own manifest and result fields. Relevant code is
[scenarios](../../src/evaluation/scenarios.ts),
[results](../../src/evaluation/results.ts) and the
[adapter boundary](../reference/adapters.md).

## Verification

Runtime and independent acceptance use the same registered
`verifyCompletion(manifest,events)` interpreter with distinct manifests,
accumulated evidence and authority. Acceptance never adopts Runtime's verdict
as independent proof. Retain adapter/verifier identity/version, evidence/reason
and `verified|failed|incomplete|unknown`; only verified establishes completion.
`task_finish` on custom tasks is model-reported/unverified.

Minecraft possession/collection-craft/block-removal v2 criteria retain baseline,
world/session/epoch/boot, life and observation freshness. Crafting tables and
stone/iron pickaxes require authoritative own production ordered before fresh
alive retained possession; gifted/preexisting tools and uncertain receipts fail.
Visible GUI gestures alone do not prove production. Combined wood/table evidence
can use an authoritative pre-consumption inventory receipt ordered before craft;
spare final logs or an intermediate poll are unnecessary. Death does not reset
the run baseline. Historical natural-inventory/collection-craft v1 schema2
reports keep their original meaning.

`break_log` proves eligible server removal; `collect_wood` proves fresh alive
own-inventory gain over baseline. Removal is not collection; later gain cannot
retroactively qualify a closed execution. Recipe reads expose only synchronized,
currently unlocked matching shaped/shapeless displays; empty means unexposed,
not impossible recipe/resources. Unmet prerequisites are subgoals, not proof the
operator's task is impossible. Program `completed`/`blocked` is not whole-task
completion.

## Clocks and attribution

Use UTC wall time for chronology and identified process/epoch-local monotonic
spans for duration. Never subtract unrelated processes/boots. Join clocks via
trusted dispatch/receipt anchors and retain missing/cross-clock uncertainty,
event lineage, action/version identity and historical null life IDs.

| Metric | Endpoints |
| --- | --- |
| Startup | Accepted start → connected, observed, control-ready session; include launch/preflight, exclude one-time install |
| Historical explicit bootstrap | Actual bootstrapping entry → running; never fabricate this phase for current preflight |
| Time to gameplay | Accepted start → first running, without double-counting preparation |
| Strategic decision | Logical admission → usable output or terminal failure; queue, exposed attempts/first token/retries apart |
| Dispatch | Eligible proposal → first effect dispatch; separate lease/cancellation wait from dispatch |
| Policy reaction | Observation admission → usable proposal executor admission; local/Jev and provider/executor parts apart |
| Reaction-to-effect | Observation admission → confirmed relevant effect; uncertain effects are not successes |
| Time to objective | First running → verified success; report wall and active gameplay, including censored runs |

Partition start-to-terminal/cutoff wall time into startup/bootstrap, active
gameplay, explicit pause, infrastructure downtime/recovery and unclassified
lifecycle. Death/respawn are gameplay, not infrastructure downtime.

Within active play label intervals once: useful execution, legitimate mechanical
wait, model-induced idle, runtime idle or unclassified. Model latency overlapping
useful work is not idle. Model-induced idle requires no useful work/required wait
and the next useful action actually blocked on a model. Attach action/precondition
witnesses; unexplained “intentional” waiting stays unclassified. Never sum
overlapping spans as wall time.

Report run counts/medians/ranges; per-call p50/p95 and sample counts, sparse
percentiles descriptive. Retain progress/current possessions, failures,
cancellations/unknowns, deaths, interventions, action/policy opportunities/use,
qualified usage and backend availability. Separately measure host/native CPU,
event-loop delay, capture/query/serialization, input-to-effect, FPS/staleness and
root/child durations before choosing native optimization.

## Ordinary-play pause review

The bounded native gameplay journal separates startup/first observed input from
the initial gameplay pause, which still counts. Changing requests, unavailable
actions or unsupported camera movement do not split a pause. Advancing cracks,
anchored travel, witnessed GUI transactions and task-relevant novelty can prove
work; stationary mechanics stay separately visible and do not suppress raw flags.
Missing samples/unsealed tails are censored, never zero. Only a matching native
tick seals a requested terminal boundary; a hung client still drains boundedly.
Loss of model authority alone neither stops the client nor closes the journal.

Initial review flags are pauses **>3,000 ms**, **more than one >500 ms onset in
20,000 ms**, or **more than one >1,000 ms onset in 30,000 ms**. Windows are
half-open and exact threshold equality does not qualify; one long pause can
qualify in both windows. Provider overlap uses actual dispatch and observed
terminal/local settlement, not a network deadline/planning marker. Overlap is
not cause. Review original-speed witnesses; flags are not a human-likeness score.

## Control-only Time to Fluidity

Initial engineering settings, not measured/user-mandated quality thresholds:
evaluate a contiguous **120-second active-play window every 1 second**.
Qualify only with ≤10% model-induced idle, no single such interval >5 seconds,
coverage sufficient to classify the whole window, evidence-linked control or
meaningful wait, and no human tactical intervention. Unclassified time prevents
qualification. Standing idle, camera/padding movement or circles do not establish
meaningful activity.

`control_ttf_active_ms` ends at the **end** of the first qualifying window,
measured from first running; `control_ttf_wall_ms` starts at accepted start.
Never backdate to window start. Pause/outage breaks continuity; begin a new
window after resume while retaining accumulated active elapsed time.

Progress/non-regression/deaths are not prerequisites for this control number;
report them and all idle categories for that exact window. Good control is not
task efficacy/human equivalence. No qualifying window means “not reached” with
horizon; insufficient evidence means unmeasurable. Success before 120 seconds
has censored TTF, never zero/instantaneous fluidity.

## Observation pipeline

Keep perception separate from inference: scheduled queue delay; enumeration/
occlusion/index work versus yields; query/pagination/serialization/bytes;
processed candidates/rays/cells/deferred work/sweep time/age/reveal delay;
guard exhaustion/missed refresh/expiry; local geometry/search/replan cost; and
host CPU/memory/event-loop/queue pressure alongside reaction/view freshness.
Fast empty output does not establish coverage.

Initial procedure is **30-second warmup +120-second measurement, three repeats
per case**: quiet terrain, dense/occluded terrain, movement/chunk invalidation
and bounded entity/update pressure. Separate cold cache from steady state,
report p50/p95/p99/counts/throughput/age/bytes/resources and every miss. Retain
paired reveal/hide checks and ordinary-world inference/policy load alongside
privileged stress fixtures. Missing coverage/expiry cannot pass on latency alone.
Raw hidden-object/geometry counters stay evaluator-only; actor aggregates must
not reveal them. Current eight-block on-demand and future 32-block scheduled
sampling are distinct conditions. Revise openly and rerun matched cases without
dropping slow samples, weakening filtering or pooling fingerprints.
