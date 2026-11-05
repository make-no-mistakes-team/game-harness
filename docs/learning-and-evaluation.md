# Learning and evaluation

This document specifies retained experience, useful-play measurement and cold/warm comparisons across game adapters. The [integration guide](integration-spike.md) separates scoped native and old-spike evidence from outstanding interface, effectiveness and comparison proof. Requirements below are not completed experiment claims. Additional games need their own adapters and evaluation profiles.

The [PRD](prds/gameharness-v1.0-prd.md) owns product scope and acceptance. The [runtime contracts](runtime-contracts.md) own identifiers, lifecycle states, scheduling, policy activation, observations, and action semantics. [Operations and security](operations-and-security.md) owns isolation, credentials and recovery. This document owns verification policy and the evidence collected through those contracts; it does not create a second control API.

## Verification and live-evaluation policy

Choose the lowest tier that can answer the changed contract. Higher tiers add evidence; they do not replace cheaper checks or erase earlier failures.

| Tier | Boundary and when to use it | What it cannot establish |
| --- | --- | --- |
| Unit | Pure/local deterministic contracts: parsing, schemas, name resolution, policy decisions, accounting and result classification. Use after a change to those rules. | Real storage, isolation, game effects or model behavior. |
| Integration | Real storage/runtime/sandbox protocol, with external dependencies substituted only at their actual seam. Use for admission, persistence, cancellation, role authority and broker changes. | Native Minecraft behavior or natural-task effectiveness. |
| Native game | Real Minecraft with production Docker isolation and zero inference. Use for game mechanics, native receipts, lifecycle fences and real planning/admission integration. Mark a synthetic strategic caller explicitly. | Actual model decisions or ordinary gameplay efficacy. |
| Agent acceptance | An actual selected model receives a natural task through the production interface. Use only when the question requires model behavior, under predeclared finite limits. | General improvement, release readiness or causal savings from one technical control. |

Workers do not run tests, typechecks, formatters, builds, providers or services while edits are in flight. After handoff, the parent runs the smallest affected check. Run one combined final regression/build when relevant source changed; documentation-only work does not require it. Rebuild Java or the UI only when their inputs changed. A previously reported failure is evidence to diagnose, not a reason to rerun the same check for confirmation.

Report `platform_status` independently of `agent_status`, provider status and semantic goal verification, with classification reasons. Correct admission, isolation, cancellation and evidence can pass while the agent fails its task. A failed goal alone is not a platform defect. Conversely, a successful game action does not excuse a platform failure.

An authorized image/observation preparation failure is a confirmed platform fault, including before the first request or after earlier requests settled. Its durable `runtime.model_observation_failed` event does not admit a request or turn a settled provider result into a provider error. Acceptance retains that fault when Stop safely drains the paused run.

### Current adapter-owned goal verification

The active adapter boundary selects an exact `{adapter_id,goal_id,parameters,verifier:{id,version}|null}`. Runtime and independent acceptance call the same registered `verifyCompletion(manifest,events)` interpreter with distinct manifest objects, accumulated evidence and authority; acceptance never reads Runtime's verdict as independent proof. Results retain the exact adapter/verifier version, `verified|failed|incomplete|unknown`, reason and evidence refs. Only `verified` establishes the goal. Custom `task_finish` remains explicitly model-reported/unverified.

Minecraft current criteria are `minecraft_possession_v2`, `minecraft_collection_craft_v2` and `minecraft_block_removal_v2`. Crafting requires authoritative own production evidence and retained fresh alive possession, not universal `action.kind==="craft"` or possession alone. Native recipe execution now uses visible inventory/crafting screens; its server-confirmed production evidence feeds the existing verifier. Visible gestures alone do not prove production. The combined criterion preserves prior own wood acquisition through authoritative pre-consumption inventory when logs were consumed between independent polls. Baseline/world/session/epoch/boot, current life and observation freshness remain enforced. Original `natural_inventory_v1` / `natural_collection_craft_v1` schema2 reports and predicate readers remain explicitly historical and unchanged in meaning.

The registered whole-agent study profile is the actual observation3 descriptor with complete materialized configuration, schema/build/capability hashes and actual native motor settings; its verifier source is `src/server/minecraft-adapter.ts`. A changed profile/build/source is a new immutable declaration, not a rewritten earlier study. Released-policy-reference admission is a separate already-declared variant with its own original-RGB/schema1 profile; it does not inherit the Minecraft structured profile or weaken whole-agent provider/request gates.

### Current native verification

The delivered workflow has three distinct evidence layers:

| Layer | Exercised boundary | Limit |
| --- | --- | --- |
| Zero-provider native mechanics | Runtime → isolated worker → Minecraft: both crafting grids, held-stack distribution, transfers, hotbar/implicit placement equip, partial-distribution interruption and custody checks | Evaluator-authored setup and procedures, not autonomous gameplay |
| Result and continuity integration | Real worker/native execution with compact terminal results; genuine terminal overflow after an effect; explicit Pause/Resume and a disclosed synthetic provider interruption with fresh observations | Supports these mechanisms, not a live-provider outage or transparent process/world restoration |
| Reviewed actual-model task | Sol established its own table, collected two new distant logs and returned, then collected four additional distant logs and returned alive on the surface | One descriptive custom episode; independent clause assessment does not create an automatic verifier |

The final 203.44-second episode used explicit supported low reasoning, fresh
seed `1` Normal Survival, empty inventory and fresh programs/experience,
`minecraft_assisted_rgb_360_r8_v1`, balanced motor, visible inventory and
single-dispatch SSE. Its prospective caps were 30 logical admissions,
360,000 ms gameplay and 900,000 ms total. It stopped through `task_finish`
with platform pass/provider ok/custom model-reported-unverified and seven logs
retained. Independent observations, native receipts, the stopped save and
footage support each requested acquisition window and both original-site
returns. The initial leftover setup log was excluded from the trip gains.

All 6,082 delivered frames were retained. This is not every native render;
capture/state are unsynchronized and audio is absent. All request owners
drained and native processes closed. Earlier failed attempts remain retained.

Compact results avoided the preceding terminal `output_limit`: five non-null
results were 186–744 UTF-8 bytes before their envelopes. Reuse was narrower than
intended: local walking helpers and two actual revisions were used, but the
four-log trip received new source even though the successful two-log source,
argument sample and outcome were present in the actual model request.
Changed-quantity gathering reuse was not demonstrated.

Two partially applied navigation operations remained unknown, fenced and
reconciled before fresh model-authored approaches. No safely settled failed
action exercised same-program refusal recovery; generated wrappers still
checked status before adopting returned observations. The task-independent
postcondition-first example is guidance and tested control flow, not proof that
the gameplay model followed it.

Pacing did not improve against the preceding accepted episode: 11 versus nine
logical admissions, 100.825 versus 91.213 seconds in model-admission spans,
and an 18.604 versus 16.586-second longest action-free interval. Seven source
submissions occupied 84.481 seconds. Fresh canopy versus surface starts and
different decisions prevent a controlled causal comparison. Provider queuing,
reasoning, generation and network shares remain unclassified. Reported cache
usage does not establish a caching improvement.

The following snapshots retain earlier source/build cohorts and failures;
their pending gates describe those dates, not current scheduling instructions.

The current hello3/API4 eight-case Runtime/Store/Docker planning baseline passed with confirmed cleanup and zero provider calls. Real native checks exercised matching and incompatible descriptor negotiation, the JavaScript safe-integer endpoint through Java application/receipts, replacement-target rejection and dimension changes that preserve life. A selected continuation passed after correcting its fixtures: an actual player-relative one-block teleport fenced queued old-space work without erasing the preceding unknown effect, and distinct instances of the same screen class rejected stale view preconditions. Explicit null-screen admission was checked in host/Java regressions and in a live queue that began with the view closed. Earlier failed reports retain their original outcomes and build identities.

The actual recording proof also passed with confirmed cleanup and no provider calls. Independent inspection found 139 indexed frames and 139 present PNGs with valid signatures, matching 139 delivered and stored frames. A preview of the 4.7-second replay showed the alive HUD, death menu and respawn HUD. Frame/state timing remains unsynchronized, audio is absent, and upstream renders may be omitted. These results establish the exercised native control, lifecycle and recording boundaries; they do not establish model gameplay efficacy, a general GUI input primitive, desktop control or another supported game.

The 2026-10-26 delivery slice separately exercised empty-inventory wood-to-table, placement/wooden-pickaxe and stone-pickaxe mechanics through real Runtime/Docker/native execution. The stone fixture retained a stone pickaxe with independent production-and-possession verification. These procedures and their dry platform/resources were evaluator-authored and disclosed.

Two bounded actual-model development episodes then used fresh curated natural starts, no supplied program or inventory, and continuous Survival time. Luna's wood/table task acquired neither wood nor a table before its five-minute limit. Sol's different custom request autonomously acquired wood, crafted planks and a table, placed the table, crafted/equipped a wooden pickaxe, and revised its own procedure after an uncertain approach. Fresh independent observations retained the wooden pickaxe and showed the placed table. Stone acquisition remained incomplete; a later provider rate-limit error ended the attempt. Custom completion stayed unverified. Both unsuccessful outcomes and uncut recordings remain retained; changed model/start conditions do not establish comparative improvement or generalization.

A later single, legitimately admitted Sol follow-up used the corrected native
build, the same selected account/assisted balanced profile, fresh seed `1` and the
explicit single-dispatch SSE condition. An owned-server craft receipt confirmed
stone-pickaxe production; fresh final evaluator observations retained that tool
and the table placed on grass. The model called `task_finish`, but the declared
custom goal remained model-reported/unverified: platform pass, provider ok,
agent unknown, `goal_verified:null`. The run used 20 logical admissions and 42
actions, including two unknown outcomes and one stale-target rejection. Sol
authored recovery from a blocked excavation approach and volatile item handles;
frequent pickup turns and roughly 23–37-second action-free gaps remained. This
one episode does not establish general task competence, human-like movement or
a measured improvement. The earlier Luna failure and provider-interrupted Sol
partial result, including unknown consumption, are not replaced.

The episodes exposed a repair-admission conflict after immutable outcome assessment and, in a quick custom-task integration check, lazy SQLite closure. The corrections permit separately linked immutable child revisions and explicitly finalize Store statements before strict close. They preserve prior assessments, usage uncertainty, effect fences and existing attempt counts.

The subsequent pacing slice adds bounded run-owned context at the actual SDK
stream boundary and an explicit ordinary-only immutable `program_submit`.
Offline installed-Agent checks exercised next-turn and recreated-Agent requests,
compatible source/help retention, fresh observations, incompatible-contract
invalidation, cold-run isolation and failed-response tool ineligibility.
Store/tool checks exercised exact-version submission, duplicate delivery,
lost acknowledgements and authority loss between saving and starting.
These checks establish request/admission behavior, not faster model decisions.
The ordinary strategist also rejects the installed SDK's recovered
`stream_interrupted_after_content` tool turn; completed streamed arguments
from that failed response cannot become effects or retained documentation.
Private journals distinguish preassembly context from the supplemented
context actually delivered to the SDK stream. Neither record is a wire
payload or evidence of provider-internal attempt counts.

A selected zero-provider Runtime/Docker/native fixture then used `program_submit`
for one root. The evaluator removed a prepared drop before application; native
rejected its stale handle without camera/world effects and confirmed
neutralization. The same root reobserved, selected a different prepared drop
and received an authoritative one-cobblestone pickup receipt. Cleanup passed.
This proves bounded recovery after a safely settled no-effect refusal, not
recovery from unknown effects or autonomous task strategy. Native certainty,
reach, inventory behavior and life/space/target checks were unchanged.

The one finite pacing follow-up used the same Sol/account, seed, assisted
balanced profile and unchanged native inventory behavior. It made a table
and wooden pickaxe, collected stone, then failed to escape its excavation
before the five-minute limit. No stone pickaxe was crafted; independent
inspection of the stopped-server save retained the placed table. Platform
passed with cleanup confirmed; custom goal and provider status stayed unknown
after deadline cancellation. Thirteen admissions included one help and ten
combined submissions, with no run-only request. First movement began at
17.668 seconds versus 37.397 in the retained successful episode, and the
longest measured action-free gap was 22.475 versus 37.397 seconds. Total
admission time remained about 159 versus 156 seconds. These are descriptive
observations from different fresh episodes, not causal improvement or task
reliability evidence. The attempt is consumed; no automatic repeat follows.

The subsequent focused movement correction preserves that failure. Native
feedback now states the unchanged navigation envelope and distinguishes raw
input completion from grounded/net progress. Placement preflight checks the
requested face and vanilla collision/placement state before equipment or
interaction dispatch; sent but unconfirmed effects still fence the owner.
Bounded model-authored subgoal, worksite, resource and obstruction notes remain
available across ordinary turns without restoring stale target authority.

Selected zero-provider Runtime/Docker/native fixtures demonstrated ordinary
one-block ascent, bounded termination under an own-column ceiling, underfoot
and corner-collision placement refusals, an invisible-face refusal, permitted
adjacent placement and an observed target outside navigation's initial bound.
A translated minimal reproduction of the failed tunnel's final bottleneck
first retained three ineffective jump bursts, then mined the observed
own-column ceiling through ordinary controls and reached a stable standing
position one block higher. It does not prove return from the entire shaft to
the surface. The evaluator supplied the pickaxe; a separate readable recording
used disclosed night vision without changing collision or movement rules.
These are mechanical fixtures, not model intelligence or human gameplay approval.

The first fixture continuation failed because forward input followed a turning
camera after overhead mining; a completed ordinary `look` before movement
corrected that fixture. Two navigation fixture preparations did not project
their intended target; a separate observable-log case passed. Those failed
captures remain evidence, not passing cases. Selected successful continuations
do not convert the first combined report into a full-suite pass.

One newly authorized prospective episode then retained a stone pickaxe and
left its own crafting table on supported ground, independently checked through
native receipts and the stopped world/player save. It ended through
`task_finish`; runtime labels remain platform pass, provider ok and custom
model-reported/unverified. The model entered another shaft, recognized its
rim/reach problem, and later used model-authored jump/use with fresh settled
height checks after an uncertain targeted interaction was fenced and
reconciled. It reached a usable crafting position at Y68, not the original
Y70 surface, and finished with an empty selected hand.

The 188.560-second recording retains 13 admissions and 44 admitted actions.
Admission spans total 122.572 seconds, but first movement took 22.644 seconds
and the longest action-free gap was 32.147 seconds. These mixed descriptive
results do not establish causal speedup or general recovery reliability. A
generated navigation range below the declared minimum was rejected before
native admission but misleadingly reported as a backend failure; offline
schema/error-boundary reproduction confirms that remaining feedback defect.
Both earlier outcomes and this consumed allocation remain retained. At that
snapshot the gameplay review and visible-inventory work were still pending;
later delivered behavior is described above.

Earlier zero-provider M1 probes reproduced overhead travel circling and
adjacent excavation failures through Runtime, Docker and native Minecraft with
concurrent observation polling. Instrumented failures distinguished omitted
projection membership from a still-current target incarnation while the client
predicted air and the server-removal receipt had not arrived. The first corrected
native proof passed nine cases: explicit interaction arrival and direct mining,
unchanged full-3D position nonarrival, an out-of-reach overhead target, adjacent
stone acquisition and grass/dirt mining during polling, blocked-route feedback,
active replacement and a new action using the replaced handle. The stone case
retained two cobblestone after two authoritative removals, with 70 observations
spanning an active motor. All owners drained. These are prepared,
evaluator-authored mechanics results, not model task success or human approval
of the resulting camera behavior. A later selected continuation, after
short-circuiting unnecessary reach probes, confirmed overhead arrival and
out-of-reach rejection, rejected entity interaction arrival without movement or
camera effects, and replaced a target only after observation-bracketed native
diagnostics witnessed emitted world input. That interrupted dig remained
`unknown`, the replacement remained intact, and a new action on the old handle
was rejected. The selected continuation does not replace the earlier full proof
or claim that every case was rerun on its artifact.

The zero-inference entries are `GAMEHARNESS_NATIVE_PROOF=1 bun scripts/native-game.ts --allow-native`, `GAMEHARNESS_NATIVE_PROOF=1 bun scripts/native-contract-game.ts --allow-native`, and `GAMEHARNESS_NATIVE_PROOF=1 bun scripts/native-recording-proof.ts --allow-native --jar native/minecraft/build/libs/gameharness-native-1.0.0.jar`. They require an explicitly rebuilt, fresh Java21 artifact. The contract driver accepts exact `--case` selections for scoped continuations; a selected result does not replace a full earlier report. Pure Java proofs, synthetic transport tests and renderer preflight remain separate from live-hook evidence.

### Attempt admission and stopping

Before inference, freeze the model selection, purpose, diagnostic hypothesis or registered study/slot identity, platform-evidence revision, finite limits, task/verifier and source/configuration provenance. Diagnostic and study admission share private governance storage but retain separate allowances and histories. Reserve an attempt atomically and settle it with independent platform, agent and provider outcomes, actual usage and evidence. Interrupted or unresolved reservations remain counted across restarts and output directories.

The acceptance runner owns its work through postprocessing and shutdown. Interruption cancels replay rendering, durably interrupts an unsettled reservation, retains already-observed goal verification in `interrupted_case`, and prevents later normal settlement or another case. It joins the original work before closing evidence, Store and ledger; cleanup does not start a replacement renderer. Replay aborts and timeouts kill the owned encoder and await its actual process-close event, retaining PNG/index/timeline evidence. Recorder and private-journal finalization close their file handles even when storage fails; incomplete evidence remains explicit.

Acceptance and the separate zero-inference native-recording proof register shutdown through the SDK's supported postmortem API. The SDK exits with 130/143 after SIGINT/SIGTERM cleanup and has a ten-second hard cleanup deadline. These entries budget at most nine seconds on signals, not 25 seconds for each resource. Their early report starts with cleanup unconfirmed; deadline expiry remains unconfirmed even if some resources later drain.

Resident benchmark slots also register before their first asynchronous operation and retain that registration through durable final-result publication. A signal fences work immediately and shortens active waits to a single, non-renewable horizon of at most nine seconds, clipped by the original slot and cleanup deadlines, with one second reserved inside it for publication. Pending startup or cleanup remains unconfirmed; a timeout does not cancel the actual owner or establish closure. A signal after the slot outcome snapshot has committed still joins final-result persistence, while the parent separately records the cohort interruption. If an owner cannot finish before forced exit, the interrupted reservation and retained partial evidence remain auditable rather than claiming clean shutdown. Ordinary return waits for owned drain. An outer interruption or failure makes overall platform completion false even when an earlier case passed.

Before native resident admission, the benchmark checks that the full remaining warmup and measurement fit before both the original root deadline and the slot work cutoff. It checks again after asynchronous admission, before warmup, and before starting the full measurement. Equality refuses: cleanup time is not available for measurement. Refusal records the required and available budgets and fails the consumed slot without shortening a window or granting a replacement attempt. These are necessary-fit checks, not a guarantee that later work will finish in time.

New technical E01 declarations use a 300-second overall slot allowance and a three-hour series limit including overhead. The 165-second root, 30-second warmup, 120-second measurement and 25-second overall cleanup reserve are unchanged; that reserve does not extend Stop or signal-cleanup deadlines. Earlier declarations and results retain their original limits. Preparation durations and failure stages remain part of the evidence; repeated slowdowns, growth across slots or preparation exceeding the allowance require investigation before another increase.

New technical E01 declarations require protocol schema 3 and `timing_capture:"full_window_native_and_resident_streams"`. The bounded private journal streams native request spans and absolute-scheduler traces from source-bound subscription through Stop and actual native/controller-context drain. Reports retain stream references and `trace_integrity`: accepted/refused counts, sequence and anchor checks, observer failures, actual owner endpoints and journal completeness. A full-window pass requires complete capture; complete evidence of a partial lifecycle does not establish a full window. Missing native stages or clock correspondence remain unknown, and applied ACKs retain input authority. The 256 MiB journal text, 16 MiB pending and 32 MiB atomic-JSON bounds are unchanged. Earlier protocol 2 results keep their original declarations.

Observer-triggered Stop fences immediately and joins pending acquisition, step and native-close ownership before claiming drain. A stopping timing callback cannot dispatch a fresh sample, worker step or lease renewal, or publish a later result event. Already-dispatched input and its later ACK remain attributable.

For **diagnostic attempts**, after **two unsuccessful real live attempts on the same technical hypothesis**, stop and preserve the outcome unless there is **new concrete platform evidence**. A different prompt, model, run directory or fresh conversation alone does not reset the count. An explicit evidence revision needs a reason and a concrete source/schema correction, native artifact or reproducible platform result; it preserves the preceding failures. Inspect existing evidence and use lower tiers before authorizing another diagnostic attempt. Do not loop until a preferred PASS appears.

The ledger checks new evidence hashes against the initial baseline and all earlier revisions; moving a report or restoring old bytes is not novelty. A reproduction reference uses a typed platform-failure finding with a reproduction command and hash-matched supporting files, as defined in `policy.ts`. Attribution of a real platform defect remains the operator's judgment; schema/hash checks cannot prove causality. Settle or explicitly interrupt in-flight reservations before authorizing a new revision.

**Predeclared finite studies** are a separate admission mode for controlled comparisons, learning experiments and held-out cohorts. Their declared sample may exceed two unsuccessful outcomes; the diagnostic limit must not truncate a valid study or encourage selective reruns. Before the first inference, record an immutable study identity, research question, arms, source/model/profile/helper/library identities, task/verifier, initial-state groups, sample size, order, per-attempt and total finite limits, permitted interventions, analysis, and stopping rules. A repetition or expansion is allowed only if its rule was declared before outcomes were observed. Retain all scheduled outcomes, including failures, interruptions, unknown verification and attempts that never reach a perturbation.

Study admission must reserve each `(study_id, arm, initial_state_id, repetition)` durably and enforce the remaining cohort allowance across restarts and output directories. Stop for safety, compromised authority, leaked evaluation state, exhausted limits or a platform defect that invalidates the experiment. An ordinary failed gameplay objective is an outcome, not by itself a reason to abandon the remaining fixed cohort. Developer changes to the frozen harness, initial prompts, supplied helpers, model settings, inherited libraries or scoring after inspecting results close that cohort for its original claim; retain it as development evidence and register a new comparison with appropriate untouched initial states. A diagnostic retry cannot be converted retrospectively into a study member to escape its stop rule.

Whole-agent and acquisition studies may allow the agent to author and repair its own run-private programs, notes and policies during each attempt, under predeclared limits and normal authority/checkpoint rules. This adaptation is part of the evaluated system, not a developer configuration change. Record its lineage and cost, and prevent it from entering another attempt or a reusable champion before batch closure. Explicit frozen-controller assays instead keep the named controller fixed; the manifest must distinguish these conditions.

The evaluator now implements separate immutable study declarations, scheduled slots, reservations, outcomes, optional whole-block dispositions and admission closures in the existing governance SQLite database. Live study reservation precedes auth discovery and native preparation. A durable request gate runs before strategic transport; per-attempt and cohort request, wall and concurrency allocations remain separate from actual usage. Unknown consumption and unknown ownership are distinct: a completed outcome does not prove resource drain, a dead PID does not release capacity, and later confirmed cleanup cannot rewrite an interrupted outcome.

Whole-agent live study support is cold, fresh seeded Minecraft Normal Survival through the supported natural tasks, with declared whole-agent run-private program/policy repair. Each slot gets a fresh private fixture Store and fresh working programs; no global experience library or reusable promotion path is exposed. Exact seed/settings are recorded, but a fresh seed is not a restored matched save. That route refuses restored/prepared saves, inherited libraries, frozen or alternative controllers, prepared development-task execution and Jev study paths before external preparation. The separately declared original STEVE-1 reference uses the dedicated entry below; it does not enable arbitrary controllers or substitute its simulator/profile for the production adapter.

`register-study` freezes a complete manifest; `study` selects its exact manifest and immutable slot. Explicit admission-only mode performs real durable reservation/settlement without an actor, provider or game and rejects external-resource flags. A parent-run real CLI smoke exercised registration, settlement, restart duplicate refusal and incompatible-flag refusal with zero host request admissions, `agent_status:"not_run"`, `provider_status:"not_called"` and `goal_verified:null`. This is governance evidence, not gameplay or a comparative result. A research plan alone still grants no inference permission, and studies never mint diagnostic hypothesis aliases.

Before changing activation semantics, the parent must complete the deterministic real Fabric/Docker/Runtime/Store manual-planning baseline, with an explicitly synthetic strategic caller and a real isolated guard. Only the parent's baseline result opens the integration-edit gate; a prepared fixture or source inspection does not.

The [29 October native planning baseline](integration-spike.md#current-native-planning-baseline--29-october-2026)
passed all eight manual/automatic continuation cases with actual cleanup and
zero provider/Jev calls after correcting the synthetic caller's SDK hook
context. The initial failed attempt remains retained. This satisfies the
baseline prerequisite for that source cohort, not a resident-control,
gameplay-improvement or future changed-protocol acceptance result.

### Model choice, usage and cost-to-result

Luna is the conservative default for ordinary acceptance. GPT-6.1-Sol is authorized for an explicit API-control, comparison or justified higher-capability acceptance question with finite recorded bounds; no silent model fallback is permitted. Select on cost-to-result and the evidence needed, not token price alone. Include unsuccessful attempts when reporting time, requests, usage and estimated cost per result.

Record host request admissions and provider-reported usage messages separately. Actual wire-attempt counts remain unknown when the SDK/provider does not expose them; do not equate admissions or usage messages with transport attempts. Preserve uncached input, cache read/write and output as reported, missing categories, actual action receipts/counts, monotonic measured intervals, overlapping spans, unclassified waiting and omissions.

Usage-event coverage is distinct from provider-consumption coverage. An aborted SDK message can emit zero counters without a provider response ID; event presence does not prove zero consumption or complete token accounting. Preserve original subtotals and labels while qualifying that uncertainty. The [recorded negative collection-to-crafting episode](integration-spike.md#recorded-collection-to-crafting-attempt-goal-not-verified) retains this distinction, its branch-trace omissions and its scoped proxy-route evidence alongside the actual failed goal.

New evaluation `UsageMetrics` use `schema_version:2` and `consumption_scope:"observed_logical_admissions"`. Read the fields separately:

| Field | Meaning |
| --- | --- |
| `event_coverage:"complete"|"incomplete"` | Whether each admitted host request has its `model.usage` accounting event, without a relevant event-page omission. This does not establish provider consumption. |
| `consumption_coverage:"known"|"partial"|"unknown"` | Whether all, some or none of the four category totals are justified across the included logical admissions. Exact wire attempts and subscription cost remain `null`. |
| `reported_subtotal` | The valid observed SDK/provider-message contributions in each category. A later missing or invalid contribution does not erase an earlier one. |
| Top-level `uncached_input`, `cache_read`, `cache_write`, `output` | Qualified totals. A category is `null` if any included contribution to it is unproven. Never replace that null with its reported subtotal. |

Positive consumption evidence comes from supported provider-terminal metadata bound to the exact host request invocation, or Jev's actual response-usage envelope. A response ID, normal stop reason or truthy SDK usage object cannot supply that proof. Missing or contradictory wire categories stay unknown; an adapter may supply not-applicable zero only where its supported contract establishes it. Terminal evidence can survive a later abort or `model.request_unsettled` without inventing an SDK message or successful provider outcome. Such a request can have incomplete event coverage and known consumption. Observed abandoned responses with unaccounted usage prevent a full consumption claim; observation bounds can also leave consumption unknown.

Zero admissions have known logical zero without a fabricated provider event. Subscription money is still unknown.

`costToResult` includes preceding unsuccessful attempts through the first verified result. It propagates null qualified categories and preserves reported subtotals separately. An unknown failed attempt therefore remains part of the cost evidence even when a later attempt succeeds. Catalogue token-price estimates use qualified counters; an unproven category leaves the estimate unknown.

Study `study_usage` instead includes every reserved outcome, including failures and unknowns after a success. It retains scheduled/inactive slot dispositions, durable host admissions, qualified category totals and reported subtotals separately. It does not reuse a first-success cutoff or infer wire attempts or subscription money.

Historical `coverage:"complete"` means legacy event coverage only. The pure version-aware reader preserves its observed subtotal in a new view with unknown full consumption. It does not rewrite original labels, measurements, reports or settled rows. Post-hoc qualification uses a separate, private, exclusive-create artifact with the original attempt/report identity, report SHA-256 and reasons. Accounting qualification does not authorize a new platform-evidence revision or another inference attempt.

Catalogue prices are labeled estimates with their source and model descriptor. They are not an invoice, and actual subscription money remains unknown. Missing pricing is unknown, not zero. A cheaper token price does not establish a cheaper successful result.

The single authorized Sol control passed the **old model interface**, not natural gameplay efficacy or current-interface acceptance; its exact scope is in the [integration evidence](integration-spike.md#verification-scope-after-the-published-checkpoint). Do not repeat it automatically. Historical unsuccessful Luna attempts retain their original outcomes.

The later plain wood comparison consumed one Luna and one Sol attempt under one hypothesis; both goals remained unverified and incomplete usage stayed incomplete. That series exhausted the two-unsuccessful-attempt allowance, with no third live attempt authorized. Its [retained outcomes and transport uncertainty](integration-spike.md#bounded-natural-wood-comparison) must not be relabeled after a source correction or used to claim post-fix efficacy.

### Evaluation code and evidence ownership

Reusable evaluation modules live in [`src/evaluation`](../src/evaluation/); runnable entry points belong in `scripts`. `config.ts` validates finite caps and diagnostic model selection. `policy.ts` preserves diagnostic reservations/evidence revisions and the shared private database owner; `studies.ts` owns immutable declarations, slot/request accounting, outcomes and separate drain/closure records. `paths.ts` keeps governance independent of reports and runtime material. `scenarios.ts` declares natural tasks/verifiers, `results.ts` classifies outcomes and qualified usage/timing, and `tiers.ts` classifies checks and artifact freshness. Study execution reuses the actual acceptance lifecycle and narrow Runtime/strategic admission hook. Generated help and source schemas define the DTOs.

Evaluation summaries use readonly child calculations over the original retained
event prefix, including retrospective reads for a late observer. Tool frequencies
are counted entries; admissions remain distinct from wire attempts. Compact
exports stream sources, policies, executions, objective metrics, events and traces
under their existing logical-record and JSON-byte allowances. Archive continuation
uses `{record_index,chunk_index}`; `total` counts logical records rather than
transport chunks. Oversized retained records use ordered JSON-text chunks with
SHA-256 and byte-count verification. Raw collection pages have separate read
snapshots; they do not form one multi-page transaction. Objective metrics instead
pin one complete published generation and its exact source boundary across all
pages, retaining pending-source provenance even if newer work becomes available.
Before the first publication, compact exports report `objective_metrics:null`
with an explicit unavailable/pending omission, never an empty completed array.
A missing previously published generation conflicts as corruption.

The separately bounded private journal retains complete permitted evidence even
when the compact report omits it. Query, persistence and capacity failures remain
explicit, prevent a false platform pass, and do not bypass reader cleanup.
SQLite schema 7 incrementally materializes objective metrics and program evidence
from source MVCC through bounded readonly previews and atomic writer commits.
Only complete generations are visible; raw event/trace prefixes and usage
qualification retain their own semantics. Host checks of this mechanism do not
establish native-control timing, gameplay effectiveness, P06 acceptance or the
full E01 cohort. Original failed, late, interrupted and unrun slots remain part
of their original record.

`bun run check` now selects typechecking only. `bun run check unit <test-file>` and `bun run check integration <test-file>` select classified narrow suites; omit the file only when the whole tier is relevant. `bun test` remains the broad local aggregation. None of these commands builds Java/UI or grants permission to start a game/provider.

### Pull-request CI

The [CI workflow](../.github/workflows/ci.yml) runs one status check, **CI checks**, for pull requests targeting `main` and pushes to `main`. Its 20-minute infrastructure ceiling covers dependency setup, typechecking, the complete Bun suite, Python 3.10.22 reference-contract/process-boundary tests and the UI build. It does not extend individual test deadlines or native-study limits. The Python test extra includes NumPy for genuine observation-representation regressions; tests do not load Torch, MineRL, policy weights or the model stack. Pull requests use GitHub's default temporary merge snapshot to check compatibility with the base branch; this does not publish a merge commit. Superseded runs are cancelled.

Dependencies install from the frozen lockfile. CI does not start Minecraft, Docker, Electron or model providers, and does not build Java. Tests use temporary storage, subprocesses and loopback connections. Evidence-freshness fixtures set file times relative to the recorded baseline rather than relying on filesystem timestamp resolution or sleeps. Native-game and live-agent evaluation remain separate, explicitly admitted tiers.

The workflow does not configure branch protection: results are informational unless maintainers separately require **CI checks**. A green run covers its tested revision, not later changes to either branch. Inspect the failed step's log before review or integration; passing CI does not establish gameplay success or replace code review.

### Evaluation entry points

Read `bun run evaluate --help` for tier entry points and explicit native/inference opt-ins. Native tiers require an existing fresh built JAR and stop on a stale artifact rather than rebuilding it. `authorize-evidence` records a justified concrete evidence revision; it is not permission to rename a hypothesis after a prompt/model change.

`bun scripts/native-minecraft-mechanics.ts --allow-native --jar <fresh-built.jar>` exercises approach, mining, own pickup, planks and a retained crafting table through Runtime, a Docker worker and native effects, with zero inference. `--case tool` extends through table placement and a wooden pickaxe; `--case stone` adds a disclosed stone outcrop, equipment, cobblestone collection and a retained stone pickaxe. `--case repair` first assesses a blocked parent, then revises and executes its child through the same production tools. Setup supplies a dry platform and resources, clears inventory and fixes daylight; the evaluator authors every procedure. Recordings and consequences establish mechanics and repair plumbing only.

`--case controller-stream` exercises the native streaming transport through
the existing sole arbiter. Its eleven evaluator-authored cases cover held
movement/view, continuous bow use, ordinary selection/drop with independent
server retention, visible GUI application followed by a separate receipt,
stale-frame refusal, a stopped native process with saturated ordinary RPCs
and reserved retirement, and actual lease expiry. Additional cases exercise
retirement after GUI application but before its server receipt, fresh owner
admission after that barrier, truthful repeated movement/count consumption,
and a sixteen-operation GUI sequence beyond two seconds. The stopped-process case
records late physical retirement rather than claiming timely release.
The fixture owns and resumes only its native child, records the full
delivered feed, drains its writer and uses no provider. It does not run a
generated resident worker or establish model-authored play.

`--case resident` adds actual selected-module execution through the SDK,
Runtime, Docker worker and native arbiter. Its evaluator-authored source
holds a bow during a 15-second reasoning delay and inactive compilation,
crafts a table through visible GUI receipts, fails before admission on a
cold-module error, throws after applied input and exercises Stop during an
outstanding infinite computation. It retains source, actual sequence/prefix
and worker/native cleanup. This conformance fixture supplies no model
competence or timing-cohort result.

The resident fixture also injects declared death, same-life teleport and
dimension changes after actual held-input admission. A separate case suspends
the owned native process, loads the ordinary RPC lane and requests Runtime Stop.
Exact evaluator commands and actual cleanup remain in the private report;
these interventions are not agent decisions or natural gameplay.

`scripts/native-resident-benchmark.ts --allow-native --manifest <registered-private-study.json>`
uses the separate zero-provider `resident_platform` StudyLedger condition.
Register the complete immutable declaration first with `evaluate register-study`.
The runner checks source/build/profile/controller identities and reserves each
sequential slot before a fresh native child process. The prospective one-cell
calibration selects 20 Hz with a 30-second synthetic reasoning wait and logical
repetition label 2, matching that cell's declared cohort workload. Its schedule
contains one order-0 entry and permits one reservation, not two attempts.
Calibration cannot substitute for the prescribed 27-cell rate/delay cohort. Every cell
retains the full 30-second warmup and 120-second measurement, expected lower-rate
expiry, actual native application ages, logging/compile/capture load and
original-speed evidence. The initial 4096-row nonplaying history corpus is
committed in one durable Store transaction before warmup; its actual preparation
time is retained separately from the recurring measured history reads.
Each scheduled history read uses the same readonly query service as application
history: the original 500-row event pages, complete program-evidence reduction
and immutable-source hydration execute in the child. Corpus size, scheduled
measurement work and observation windows stay unchanged. Evidence retains query
start/end/error, actual observed child-exit and pipe-drain timestamps, and the
reader's cleanup barrier before Store closure. A host-only isolation check does
not establish native continuity or satisfy E01 acceptance.
Failed/interrupted slots remain consumed; unknown
cleanup retains ownership and closes admissions. Provider identities and
allowances are null/zero, and a technical pass never becomes agent completion.
A failed admission before native fixture creation can confirm that no native
owner was acquired; it does not invent a native cleanup report. Once a fixture
exists, confirmed drain requires its retained native report.

The same owned-slot runner also accepts a separately authorized P13 action-history
volume assay: protocol 4, `mode:"p13_volume"`, with exactly 30, 300, 3,000,
10,000 and 60,000 actions in five sequential slots. Each selects 20 Hz, a
30-second synthetic wait and logical repetition label 2. This is not an E01
mode or five relabelled calibrations; the strict protocol-3 E01 allocation,
source, windows, acceptance and original history workload remain unchanged.
P13 reports cannot establish E01 completion or model competence.

Raw actions are admitted and saved through Store in a separate, explicitly
synthetic nonplaying run before warmup. Preparation time is retained, not
reported as measured ingestion. The first derived publication occurs during
measurement, followed by five fixed receipt corrections and their separately
captured preparation frontiers at 20, 40, 60, 80 and 100 seconds. Bounded reads
and memory/queue samples retain pending work, misses and unknown values. Writer
evidence distinguishes synchronous call spans from asynchronous settlement.
The original 4,096-event run and its reader retain their declared work. Required
P13 work that cannot finish within measurement fails; safe input expiration is
not continuity.

The P13 workflow binds its original authorization wall and OS-monotonic clocks,
including preparation, registration, playback and final verification. Later
registration cannot restart the allowance. On supported 64-bit Linux, the
evaluator reads `clock_gettime(CLOCK_MONOTONIC)` directly: Bun 1.3.14's
process-relative `hrtime` cannot bind independent processes or OS witnesses.
These workflow clocks do not replace native capture-to-applied-input latency.
The dedicated P13 Learning/reader owner must drain before Store closure, and
every slot's owner is checked before any replay encoder starts. A trusted
sandbox namespace snapshot permits independent read-only guardian/container
release probes without exposing that identity to generated programs. Full
original-speed media review and noticeable-gameplay review remain separate gates.

The declaration must select normal generation and enabled structures; the
runner checks the actual owned world's safe settings before admission.
Latency populations include confirmed ACKs arriving after the measurement
window and retain unconfirmed decisions explicitly. Native measurement and
cleanup cannot extend the original slot deadline. The parent derives sealed
replays only after all native owners close, under the separately stated
[cohort derivation bounds](runtime-contracts.md#evaluation-governance).
Neither a timeout nor a kill request confirms resource drain.
Warmup, synthetic reasoning and scheduled load waits recheck their original
monotonic deadlines rather than treating a timer notification as elapsed time.
On failure, native fixture teardown follows resident drain settlement so it
cannot destroy the channel still needed for retirement; an unknown resident
drain remains unknown even if the fixture is later contained.

Synthetic fault fixtures may explicitly select the trusted native evaluation
configuration. The normal private session records `evaluation:null`; natural
conditions reject fault configuration before setup, and the resident timing
runner checks the actual launched disabled value. The configuration and its
raw arm/status requests are not offered to models as game tools.

GUI replacement proof must show a new same-class screen while the original
gesture is still pending, not only after old-owner drain. Slow-reader proof
must show actual native socket-write backpressure, not just unread replies or
a nominal full host queue. Bounded owned-socket buffer controls, permitted
reads and owned-JVM stack observations may establish that boundary without
changing the production writer. Retain the actual reserved Stop/retirement
ACK and pre-resume native capture clocks separately from prior world effects.
Lease expiry during an intentionally held reader is not continuous control.

`--case approach --mode baseline` retains observed approach/excavation faults
without treating evidence capture as semantic success.
`--case approach --mode fixed` asserts the corrected positive/negative
cases with real parent-side observation polling during native effects.
Optional `--stages <comma-separated names>` runs a disclosed selected
continuation, not the full proof. Each stage retains receipts, polling witnesses
and an uncut recording; privileged setup occurs between drained runs, except
the explicitly declared active-replacement negative.
The focused movement stages are `ascent`, `headroom`, `excavation`,
`placement-collision`, `placement-corner`, `placement-face`,
`placement-adjacent` and `navigation-envelope`. `excavation` discloses
evaluator-only night vision for legible footage. Its three unsuccessful bursts
and subsequent terrain change are authored by the evaluator and are never
supplied to a model episode as a solution.

`--case visible-gui` runs the complete 18-case persistent-screen conformance
set, including real GUI production receipts, a Runtime/Docker worker and
source/cursor, modifier, resize, replacement and acknowledgement races.
`--stages chest,furnace` is an explicit debugging subset, not full acceptance.
The fixture uses privileged setup and evaluator-authored choices; its source,
worlds and recordings must remain unavailable to actor retrieval or experience.
Resize evidence retains separate fixed-size replay segments and original
transition packets rather than synthesizing a constant-size capture.

`--case sensing` exercises eight basic-feedback cases: own state and vanilla
crosshair, exact delivered capture-sequence joins, reads during a stopped
server inventory request, use/movement, actual heard priming with independent
cursors, fluids/air/vehicle and scope fences. The production-used native
audibility proof separately covers mute, relative/stopped and attenuation
boundaries; these are not represented as live mute tests. The visible-GUI
`worker-api` stage also reads the new channel through the real isolated SDK.

`bun scripts/minecraft-development.ts --help` describes the thin finite Minecraft development entry. It reuses acceptance's Runtime, diagnostic AttemptLedger, pre-transport request admission, model evidence, episode recorder and cleanup. Declare plain task text, an optional registered `--criterion` (default `custom`), a fresh `--seed`, start disclosure, the existing account directory, an explicit image-capable model, and finite limits. It supports fresh Normal Survival with empty inventory and continuous time, not prepared/restored saves or setup commands. Seed curation must be disclosed. Custom `task_finish` remains model-reported/unverified; a stone-pickaxe request must explicitly select `craft_stone_pickaxe`, not the table criterion. This entry preserves existing diagnostic counts and does not create a study allowance.

Diagnostic acceptance/development can explicitly select
`--single-inference-dispatch`. This disclosed condition uses direct Codex SSE,
one pre-response attempt and a request-owned fetch fence shared by SDK recovery
and authentication replay. It rejects enabled `PI_CODEX_WEBSOCKET` and surfaces
redirects without following them, while retaining selected-account authority
and owned cleanup. The report records the condition before inference. SDK
recovery may schedule before reaching the fence, but cannot make another host
inference HTTP dispatch. Terminal errors retain the original SDK-parsed status,
category and retry delay when available, including after partial output.
Completed but unexecuted tool calls from a failed request are rejected rather
than promoted by SDK transient-error recovery; their original streamed evidence
remains in the private journal.
Truncated streams without an error frame retain unknown provider status and
consumption. Ordinary defaults and frozen studies remain unchanged. The limit
covers host HTTP dispatches under standard fetch/manual-redirect semantics, not
provider-internal attempts or independently retrying custom fetch implementations.

Use `register-study --manifest <private-study.json>` before `study --study <id> --manifest <same-file> --slot '<JSON slot>'`. The slot names the registered study, arm, initial-state identity and repetition. Add `--admission-only` only for an admission-only declaration; it rejects native, inference, auth, JAR, model and budget flags. Live study execution requires both resource opt-ins and the existing auth directory, and checks the manifest, actual supported artifact and static compatibility before reserving the slot.

#### Released-policy reference entry

`bun scripts/policy-reference.ts --help` describes the separate original STEVE-1 synchronous reference path. It uses the existing study ledger and one immutable slot, with an exact [controller manifest](../src/shared/controllers.ts), the original MineRL/Minecraft 1.16.5 contract, two declared fixture behaviors, null provider identities and zero provider request allowances. The whole-agent entry rejects this mode. Local policy computation is recorded separately from provider usage.

Register its complete declaration with `bun scripts/policy-reference.ts register --study-manifest <private-study.json>`. Registration validates actual controller/profile/dependency/configuration/fixture identities without launching a model or game. The study's `declared_reference_fixture` bundle pins real fixture bytes and the seed-before-reset sequence; it is not a claim of a matched restored save.

The dedicated `run` command additionally requires the same study and slot, the pinned controller, verified prepared and private fixture roots, a new private output directory, and both `--allow-native` and `--allow-inference`. It reserves before external preparation. The prepared image, source, dependencies, weights and locally built simulator must already have independently verified hashes and applicable component terms; the entry does not download replacements, switch checkpoints or fall back to another runtime.

The learned and trusted environment processes have separate network-none containers. Only the latter receives worlds, verifier state, recordings and its owned headless renderer. The supervisor checks actual container partitions/mounts, measured resources and its own kernel-enforced cgroup limits; unknown ownership or measurements fence work. A completed negative behavior preserves the next scheduled case, while an invalidating boundary/platform/resource failure stops safely. Outcomes and resource-drain confirmation remain independent.

This entry's code and admission tests do not establish a reproduced policy, memory fit, hardware compatibility or reference competence. Those require the separately admitted real load/action/behavior screen and retained recordings. Reference, independent live-clock and production-port outcomes are separate; synchronous step pacing and fixed-rate footage cannot establish a live player.

Native helper/proof code is infrastructure, not a model gameplay library. A synthetic caller or privileged fixture must remain identified in its report. Keep [private evaluation storage](operations-and-security.md#private-evaluation-storage) separate from compact reports; a report does not authorize publishing its private evidence tree.

## What learning means here

Learning means that the strategic model writes, tests in ordinary play, and revises external artifacts that later runs can reuse. It does not mean reinforcement learning, fine-tuning, or changing model weights. The strategic model already has pretrained knowledge. Public game documentation and brokered wiki or internet retrieval are allowed sources, subject to the selected observation profile and security boundaries.

| Artifact | Purpose | Persisted content | Evidence needed before relying on it |
| --- | --- | --- | --- |
| Knowledge | Facts, hypotheses, explanations, and lessons | Human-readable statements, source references, scope, uncertainty, and supporting or contradicting events | Distinguish a documented fact, an observed result, and an untested inference; retain contradictions |
| Skill | A long-running program for a goal or subgoal | Agent-authored source, interface and preconditions, serializable state format, dependencies, version, and termination conditions | Runtime validity plus actual outcomes from invocations under stated conditions |
| Policy / reflex | A short reactive decision rule or fast-AI configuration | Agent-authored JS source or declarative typed AI configuration, declared inputs/actions, priority, deadlines, and applicability | Runtime validity plus observations from bounded trials and later uses |

A coherent bounded skill is the primary gameplay unit and may call exact-version children and several bounded actions over time. A local-JS or real Jev policy proposes a response while inference and execution continue independently. Only the leaf action owns effects. Original/canonical UTF-8 byte limits remain admission rules; source line count, complexity and nesting are descriptive, not tactical quality, novelty or token savings. The [runtime contracts](runtime-contracts.md#current-compact-program-interface) define current tools and the single foreground lease.

The principal model owns resource strategy, progression, procedure construction and repair. Disclosed mechanical helpers may execute a selected route, recipe, slot transfer or aiming operation under the same authority and information rules; they do not recursively choose and gather missing prerequisites. A richer developer-authored player is a separately labeled assistance/comparator condition. Freeze helper provenance with each cohort; adding developer tactics cannot be reported as agent acquisition.

Understandable high-level strategies are sufficient. There is no requirement to imitate human low-level thought, invent a strategy new to humanity, or run human-subject strategy trials.

## Libraries, provenance, and snapshot boundaries

### Cross-session library

The default library is per strategic model, with artifacts scoped to compatible game, adapter, and observation profiles. A run selects an immutable library snapshot before starting; later changes in another run cannot silently change that selection. Shared experience is portable only when its environment and capability assumptions still hold. No cross-game or cross-adapter portability is implied by sharing an artifact format.

Current compatibility is the negotiated descriptor/content hash: observation envelope 3, the registered payload schema, complete profile configuration, game/adapter build and capability hashes, and executable API/validator/runtime 4. Minecraft currently uses `minecraft_assisted_rgb_360_r8_gui_v2`; earlier r8-v1 episodes retain their original declaration. Dynamic boot/session/run/life/space identities fence invocations without changing reusable source compatibility. Earlier schema2/r2 and API1–3 snapshots retain their original source and outcomes for read-only inspection; they cannot enter active execution without a new compatible validation identity.

Same-session working definitions are a separate, weaker retention channel. `working_programs:"continue"` (default) imports exact validated definitions/dependencies only for the same session and strategic model; `"fresh"` omits them. No previous args, worker state, observations or JS stacks cross the task boundary. Their qualification remains `working_candidate`, even if they have measured execution references. Retaining or revalidating a definition does not establish usefulness, portability or cross-session promotion eligibility. Frozen comparison arms must explicitly omit uncontrolled working definitions.

For each artifact version, retain:

- Its content hash, artifact kind, parent version or source artifact, authoring model/provider identity, and creation run/event references. Record model identifiers as reported by the provider rather than claiming reproducibility of unavailable model internals.
- The `game_id`/`game_version`, `adapter_id`/`adapter_version`, `observation_profile_id`/`observation_profile_version`, full `observation_profile_config` and `observation_profile_fingerprint`, `observation_interface`, and `observation_schema_id`/`observation_schema_version` with schema hash. Pin each required capability's `capability_id`, version, schema, and hash, plus policy backend, artifact schema, and serializable-state schema versions. Include runtime, adapter dependencies, and relevant environment settings in the associated manifest. Minecraft bridge/protocol versions and server flavor/build/effective configuration belong to its compatibility record; configuration contents follow the manifest requirements below.
- Source provenance: retrieved URL/document identifier, retrieval time, retained excerpt or content hash where permitted, and whether a statement came from documentation, model prior knowledge, gameplay observation, or model inference. A model's unsupported attribution is not a verified citation.
- Applicable preconditions, intended outcome, known limitations, and the runs/events that support or contradict it. An author-written explanation is a hypothesis until supported by outcomes.
- Validation findings, trial results, activation/quarantine/retirement history, and the reasons for revisions. Retain unsuccessful versions and the evidence that caused replacement.

Do not store credentials, private provider reasoning, or unrelated personal data in the library. The trusted backend stores registry metadata and immutable artifact references; persistence and retention follow [operations and security](operations-and-security.md).

### Separate reusable experience from world memory

Reusable knowledge can describe a general lesson within its declared game/profile scope. Remembered environment state belongs to the `world_id` lineage in which it was legitimately observed: a game world, level, or session. Locations, explored routes, entity encounters, container inventories, and maps are Minecraft examples. Such records carry lineage provenance and cannot be loaded as facts about a new environment.

Each comparison run must fix these boundaries before bootstrap:

| Boundary | Required isolation |
| --- | --- |
| Model | Exact reported strategic model and relevant fast-model configuration; separate default libraries for different models |
| Environment lineage | New run/world identity and empty environment-specific memory at the declared initial state; remembered observations may resume only for their own lineage |
| Game and version | Immutable library snapshot and compatible game, adapter, observation profile/version/configuration fingerprint, interface/schema, server permissions/configuration, capability schemas, implementation, and artifact versions |
| Run | Private conversation, summary, generated artifacts, serializable state, and retrieval caches; no reads from a sibling comparison run |
| Evaluator | Seeds or other hidden initial-state identifiers, hidden verification state, scoring annotations, and unrevealed environment data stay outside planner, worker, retrieval, and library inputs |

Warm runs inherit only the selected reusable snapshot. Cold runs inherit no project experience. Both may write new artifacts during their own run, but those writes remain in a private branch. Neither arm may read artifacts created by another repetition or earlier comparison arm. Promote experience into a later library only after the comparison batch closes, with provenance intact, and give the resulting snapshot a new identity.

An incompatible artifact is reported as rejected, not silently replaced. Changed observation, navigation, server or adapter permissions invalidate incompatible cached validation and applicability. Revalidation and migration create explicit new versions and comparison conditions; old Mineflayer or strict-profile evidence cannot certify Fabric behavior. Explicit compatible cross-model product reuse is a target requirement: preserve authoring provenance and rerun applicability/compatibility checks. It never permits silent library crossing in experiments. The current study runner admits no inherited-library condition.

### Selective retrieval and autonomous promotion

Qualified program experience is an on-demand `memory` module disclosed through `help`, separate from ordinary program tools and custom-task closure. It supports compatible snapshot catalog, fresh named load and explicit evidence-qualified promotion; run creation can separately select an exact experience snapshot. The [runtime contracts](runtime-contracts.md#current-compact-program-interface) and generated help own the interface. Dotted names below describe broader release retrieval/knowledge/history obligations, not callable aliases or completed delivery. At a task/improvement boundary, bounded metadata/card/performance search should precede selective exact-source retrieval. A vector database is not required. Reads stay within selected model/game/adapter/profile/capability scope and the current private branch, never another comparison arm or evaluator data.

Memory catalog pages select the latest durable version per name; named load can request an exact version or resolve latest once. Duplicate names retain their separate immutable snapshot versions rather than forcing a copied opaque ID or silently replacing old payloads.

The native compatibility gate records the actual negotiated `{descriptor,compatibility_hash}` in `run.adapter` and rechecks source/validator fingerprints on hydration. The host validates registered schema documents and the immutable contract resource inside the built native artifact; matching asserted hashes alone are insufficient. The [runtime contract](runtime-contracts.md#current-compact-program-interface) owns the current versions. Early native promotion evidence used observation schema1 and skill protocol1. Those cohort identities remain historical and do not become evidence for the current contract. Broader library, state and cross-game requirements below remain separate delivery gates.

The [integration evidence](integration-spike.md#accepted-coherent-root-result-and-useful-promotion) records one actual portable promotion qualified by same-root effects after earlier rejections. A subsequent exact-source warm hydration/invocation blocked with no observable eligible log; a newly authored program later ended in death. Retain that [unfavorable warm attempt](integration-spike.md#exact-warm-attempt-with-blocked-prerequisite-and-death). Promotion plus exact import is limited evidence, not warm task success, generalization or a controlled cold/warm benefit.

The model can append a scoped, sourced Knowledge version through `experience.saveKnowledge`. For reusable programs, it authors or revises an immutable skill/policy version and its required StrategyCard, validates it, and conducts a bounded ordinary-gameplay trial. It then uses `experience.proposePromotion` to propose an exact artifact set or authored startup bundle. Knowledge writes and promotion proposals use the runtime's idempotent mutation keys and durable results, so a lost acknowledgement cannot create duplicate versions or snapshots.

The trusted promotion gate applies requirements by artifact kind. `experience.saveKnowledge` alone writes only the run-private branch; a Knowledge version reaches a later run through an eligible `experience.proposePromotion`, just like other reusable experience.

| Promoted kind | Eligibility |
| --- | --- |
| Knowledge | Immutable content/version, compatible declared scope, permitted provenance, explicit confidence, and authorized supporting/contradicting evidence. A public documented fact may cite its retained source; an observed fact cites its observation; an inference remains labeled as a hypothesis rather than being promoted to verified fact. Apply the same portability and world-information checks below. No executable-program trial or StrategyCard is required for pure Knowledge. |
| Skill or policy | Every program condition in the following table, including the exact-version StrategyCard and eligible real gameplay use. |
| Startup bundle | Model-authored immutable selection and applicability metadata; every included program/card/dependency meets its respective gate. A bundle cannot qualify an otherwise ineligible policy. |

The program promotion gate applies all of these conditions automatically:

| Condition | Required evidence |
| --- | --- |
| Immutable, admissible program | Exact source/config hashes, runtime-valid version, complete StrategyCard, compatible pinned dependencies, and no unresolved quarantine |
| Permitted provenance | Model-authored gameplay method; documented source/observation/inference provenance; no credentials, privileged evaluator data, or handwritten tactical injection |
| Explicit scope and portability | Declared applicability, inputs, preconditions, limitations, and portability assessment; world-specific state remains tied to its observed `world_id` lineage |
| Actual eligible use | At least **one independently verified bounded real-gameplay trial or invocation** of the exact version, with a meaningful trigger/use, predeclared intended-outcome predicate, measured outcome satisfying that predicate, and the declared safety/non-regression conditions |
| Complete outcome history | Source-linked trial/invocation events and verifier results, including all failed, unknown, no-effect, and regressing outcomes; no promotion based solely on self-rated success |

One eligible trial is the **initial engineering evidence floor**, labeled **limited evidence**, not demonstrated generalization. Static validation or a semantic explanation does not prove portability. Unknown scope, seed-specific targets, maps, routes, remembered containers, and other world-bound facts stay run/world-local. A model may create a newly parameterized revision with an explicit scope and new evidence; the gate must not export the old world data by relabeling it general knowledge. Scoped Knowledge entries retain their confidence and provenance; saving one does not qualify an untested program for promotion.

An eligible proposal creates a new immutable per-model library snapshot **without human approval**. The result records eligibility, conditions, exact artifact/card/evidence references, snapshot identity, and any rejection reasons. Missing or incompatible experience returns explicit empty, `compatible_not_found`, or rejected results, not an unrelated substitute. During a sealed comparison, record the proposal and eligibility evidence but defer snapshot publication until batch closure; reapply the gate then. Promotion never mutates a snapshot already selected by a run or exposes within-batch outcomes to another arm.

## Bootstrap and policy revision

### Equal startup capabilities for cold and warm runs

Both conditions receive the same task, capability descriptions, permitted references and declared supported policy backends. The explanation of inference latency supplies no game tactics. Cold removes inherited experience, not programming or an otherwise enabled optional Jev path. The current cold-only study capability gate does not implement this complete cold/warm comparison.

Host preflight owns readiness and fresh authoritative state before ordinary scheduling; there is no mandatory multi-request model bootstrap. Earlier cohorts' three-call/60-second phase remains historical evidence, not a current quota. Freeze actual finite request/time limits equally across comparison arms. Retain logical requests and exposed provider attempts separately; retries do not reset an allowance.

A warm snapshot may contain a model-authored startup bundle naming exact compatible policy versions, task/profile applicability, and required capabilities. The host checks source hashes, compatibility, isolation, and present applicability, then rehydrates eligible entries through the ordinary fenced activation path. Reuse cached validation only when source, runtime, isolation, adapter, profile/version/configuration fingerprint, interface/schema, and relevant server permissions/configuration match; otherwise reassess compatibility, revalidate, and record the result. Already evidenced tactics need not be regenerated or retrialed merely because the process restarted under unchanged conditions. Activation permits no effects until current observations and preconditions allow them.

Startup context contains a bounded index and applicable selected summaries; unselected programs stay behind selective retrieval. The broader release bundle selection is model-authored, not a handwritten tactical rule. Compatible selections can need **zero strategic authoring calls**. Missing or inapplicable entries visibly use ordinary authoring, without a silently swapped library or developer fallback.

A cold run starts with an empty inherited library and may create candidates; warm may inspect, select or revise inherited artifacts. Per-model allowances may be calibrated in practice, then frozen equally across matched arms. Log snapshot/bundle identities, logical calls and exposed attempts, retrieval, validation/cache, hydration, activation, first effect, rejected entries and elapsed time. Policy absence is explicit and does not prevent ordinary program gameplay.

### Runtime validity is not behavioral success

Policy versions use `draft`, `validated`, `trial`, `active`, `quarantined` and `retired`. Immutable skill artifacts use `validated`, `quarantined` or `retired`; executions separately use `accepted`, `running`, `cancel_requested`, `succeeded`, `blocked`, `failed`, `cancelled` or `unknown`. These [runtime records](runtime-contracts.md#current-compact-program-interface) are not behavioral-effectiveness ratings.

Validation establishes that a candidate satisfies schemas, capabilities, isolation, bounded execution, and other runtime admission rules. It cannot establish that a combat, movement, or resource decision is effective. A validated candidate can enter a bounded trial in real gameplay without already having a successful tactical history. Trial behavior has exactly the same observation and security limits as active behavior.

For each trial or invocation, capture the triggering observation references, declared intent, chosen action, relevant preconditions, timing, actual action outcome, and subsequent game evidence. Record opportunities as well as successes: a policy that never encountered its trigger has no observed effectiveness rate. Unknown outcomes remain unknown. A successful action is evidence about that action, not proof that the entire policy generalizes.

The model may author local code or a Jev-backed AI policy, and replace either with the other after inspecting evidence. Jev is a real fast-decision provider path; local JS is a separate execution backend. An unavailable or failed provider must be reported explicitly. A run intentionally started in code-only mode is valid, but cannot be reported as a successful Jev evaluation.

Revise policies in this order:

1. Compare intended effects with runtime and game evidence; identify the specific failure, delay, or limitation.
2. Create an immutable candidate version and StrategyCard with a semantic change explanation and linked evidence. Keep the previous version.
3. Validate and, when admitted, trial it under bounded real-play conditions.
4. Let the model request activation, replacement, or retirement; apply the runtime's scheduling boundary and stale-generation fencing.
5. Retain the outcome, including regressions and quarantines, for later review and library selection.

Quarantine of invalid or nonterminating code is a runtime safety decision. Behavioral effectiveness remains an empirical claim with a stated sample and context. Restoring an earlier policy version does not restore the game environment.

### Two kinds of feedback

| Feedback | Examples | What the model can infer |
| --- | --- | --- |
| Runtime feedback | Strategic/provider latency, planning blocked by a tool, dispatch delay, interrupted actions, rejected stale results, deadline expiry, validation failures, actual action status | Whether its decomposition, backend, timing, or program needs revision |
| Game feedback | Adapter-defined progress, observable state changes, task failures, and verified milestones; Minecraft examples include health, inventory, observed threats, resource loss, and death | Whether its strategy worked in those observed conditions |

The runtime reports facts and constraints. It does not turn feedback into tactical rules. A policy can be runtime-valid and tactically poor; a game failure can occur despite correctly enforced runtime rules. Report both rather than assigning every failure to model reasoning.

The trusted Autonomous Improvement Loop proactively assembles evidence-backed opportunities and delivers them at an eligible strategic turn; the model need not discover every problem by polling feedback. Trigger names, thresholds, deduplication, acknowledgement/deferral, trial limits, and wakeup behavior belong to the [runtime contracts](runtime-contracts.md), not a second table here. The model must respond by retrieving/reusing experience, authoring/revising a candidate with a hypothesis and bounded trial, keeping/retiring/reverting a version with outcome evidence, or explicitly deferring/rejecting the opportunity with a reason. Gameplay can continue during this analysis. Before/after associations guide a revision but do not establish causality without a controlled comparison.

### Human-readable strategy artifacts

Every reusable skill or policy version **must** have a versioned **StrategyCard**. Library and run records pin the exact immutable program/card pair, using this required format:

| Field | Required content |
| --- | --- |
| Identity and source | `card_id`, `card_version`, card-format version, exact artifact kind/id/version, and immutable source/config reference with hash |
| Purpose | The intended gameplay outcome, stated in ordinary language |
| Applicability and limitations | Compatible task/game/profile/capabilities, required observations and preconditions, world/portable scope, and known failure cases or uncertainties |
| Gameplay method | A human-understandable account of what the program does and when; an opaque code name or JS diff is insufficient |
| Creation or revision reason | The motivating hypothesis and opportunity/event/evidence references; identify a retrospective explanation as retrospective |
| Parent and semantic changes | Parent card/version, or explicit no-parent status for an initial version; describe changes to method, preconditions, and intended outcome, including explicit unchanged items and why the revision should help |
| Evidence and outcomes | Exact trial/invocation/verifier references, conditions, trigger opportunities and actual uses, sample sizes, measured outcomes, failures/regressions, and unknowns |

An empty evidence list means **untested**, with “not yet measured” outcomes; do not fill it with illustrative or invented gameplay. A model's method and change explanation are claims. The trusted trace and verifier establish what happened independently. Evidence arriving later appends a new card version linked to the same immutable program; changing source/config creates a new program version with a matching card. Keep every prior card/source/evidence association addressable.

The required live activity surface must display an improvement card: actual skill/policy version change, why it changed, semantic changes, and trial/measurement outcome or “not yet measured,” with expansion or links to its StrategyCard and authorized source/events. At least one real authored improvement with linked trial evidence must be displayable; an improvement in timing or cost is not guaranteed. Authorized generated source may be shown as escaped, non-executable text, without execution, installation, activation, or additional data authority. Model-authored markup/scripts must not execute in the operator origin or disclose another run's private data, privileged state, or secrets. The feed also shows task, concise model-authored plan, action status, backend/version, observable interruption reason, and progress evidence. It does not expose or reconstruct hidden chain of thought. A full library browser, editor, replay, or analytics dashboard remains optional.

## Measurement protocol

### Declare the experiment before running it

Freeze a run manifest containing:

- The actual negotiated adapter descriptor: `game_id`/`game_version`, `adapter_id`/`adapter_version`, `observation_profile_id`/`observation_profile_version`, `observation_schema_id`/`observation_schema_version` and schema hash, and supported `capability_id`/version entries with schemas/hashes. Include runtime/dependency versions and relevant environment settings.
- The full `observation_profile_config` and `observation_profile_fingerprint`, plus `observation_interface` for structured/image interface identity. Record radii, occlusion rules, sound coarsening, sampling/candidate/output bounds, private navigation geometry projection/envelope, and authorized-goal/higher-route rules using the canonical [runtime profile](runtime-contracts.md#current-player-observable-structured-profile), without substituting a profile label for its effective settings.
- For Minecraft, server flavor (vanilla/Paper or another declared implementation), exact game/server build, Anti-Xray enabled status, and effective per-world/dimension Anti-Xray configuration: mode, block lists, heights, update options, and other settings applicable to that pinned version. Retain an effective configuration snapshot/hash in evaluator-owned evidence; neither server configuration nor raw diagnostic evidence grants agent access to hidden state. Current Paper documentation does not by itself establish behavior for the pinned build; use the [upstream evidence](upstream-reuse.md) and adapter fixtures.
- The task definition and versioned verifier, success/failure predicates, progress and non-regression predicates, horizon, stop conditions, and scoring rules.
- The practice/comparison/held-out designation, initial-state identity and permitted initialization procedure, `world_id` lineage, any `rollback_branch_id`, and checkpoint or reset capability actually available through the adapter.
- Model/provider identities and controllable sampling settings, authentication category and authorized access conditions, enabled backends, bootstrap settings, immutable library snapshot/bundle, and reference-access policy. Keep credentials out of the manifest.

Record the relevant initial player/environment state using profile-specific fields. Keep secrets and hidden evaluator inputs out of the agent-facing manifest. A public evidence manifest may retain opaque identifiers for withheld initial states; the trusted evaluator keeps their reproducibility records separately. Evaluator-only result verification must not feed hidden state into observations or control.

Freeze profile/version, full configuration/fingerprint, interface/schema, game/adapter versions, and server flavor/build/effective configuration across matched cold/warm and policy-capability arms. Camera-independent structured observation and private local navigation are declared information advantages/approximations, not human-equivalent perception. A changed permission or server configuration starts a separately declared series; never silently pool it with the old profile or attribute the difference to learning/policies.

### Adapter-defined task verification

The generic runtime records verifier results and evidence references; it does not hardcode game rules, Minecraft milestones, or a universal completion event. Each evaluation profile defines a task over an adapter's declared verifier capabilities, including:

- A stable task/verifier identity and version, required adapter capabilities, permitted starting conditions, and the evidence used to decide success, failure, or an unknown outcome.
- Task-relevant progress predicates, what must remain true for non-regression, and game-specific failure events reported alongside control timing.
- Whether verification uses filtered player observations or a separate trusted evaluator with hidden state. Only permitted observations may reach the agent; hidden verifier data cannot enter planning, policy feedback, retrieval, or reusable memory.
- What can be reproduced through fresh initialization, checkpoints, reset, or restore. An unsupported verifier or reset capability must be reported; it cannot be replaced silently with a weaker task or claimed deterministic replay.

A task may be a bounded subgoal or sustained behavior without a terminal game state. Infrastructure success, an accepted action, and a model's claim of success do not establish task success. Preserve the verifier decision, relevant event range, uncertainty, and version with the result.

Ordinary custom tasks have no built-in semantic verifier. Main can explicitly call `task_finish` to stop further inference and effects when it judges the requested task complete. This records model-reported, unverified completion and safely reaches run status `stopped`, without `goal.verified` or post-goal review. Evaluate semantic success separately through the declared scenario/verifier; neither that lifecycle status nor the model's summary replaces its evidence.

In the current Minecraft adapter, `break_log` requires one server-confirmed eligible log removal during the run; `collect_wood` requires fresh alive authorized own wood inventory gain relative to the run-start baseline. Their evidence variants remain distinct. A dig/removal receipt cannot be presented as inventory proof, and inventory gain cannot retroactively qualify a closed execution outside its evidence window. Death does not reset the inventory baseline; a new task/run creates a new one. Ordinary death is an outcome within a continuing session/run, followed only by a model-selected explicit vanilla respawn, not an automatic terminal infrastructure failure.

The numerical defaults below are **chosen initial engineering targets and measurement settings**. They are neither measured results nor user-mandated thresholds. Freeze them before comparison or held-out play. If practice reveals a poor setting, revise it openly and start a new measurement series; do not tune it after seeing held-out outcomes.

### Clocks and attribution

Use canonical event fields from the [runtime contracts](runtime-contracts.md): UTC `wall_time` for chronology and process/epoch-local `monotonic_ms` for elapsed durations. Never subtract monotonic readings from different processes or boots. Correlate cross-process spans through trusted backend receipt/dispatch events; label estimates and missing spans. Preserve `run_id`, `session_id`, `world_id`, `epoch`, `life_id`, `event_seq`, and relevant action/policy versions/hashes in the evidence. Historical missing life lineage remains null.

| Metric | Start and end | Reporting rule |
| --- | --- | --- |
| Startup elapsed | Accepted start request to connected, observed, control-ready player session | Include actual launch/connect/setup/preflight delay; identify already-running services and exclude one-time installation |
| Bootstrap elapsed, historical/explicit phase only | Actual entry into `bootstrapping` to entry into `running` | Retain the earlier phase's inference/validation/idle and request evidence; do not fabricate it for current host-preflight runs |
| Time to gameplay | Accepted start request to first `running` | Include actual startup and any distinct preparation/lifecycle interval without double counting; first confirmed effect remains separate |
| Strategic decision latency | Admission of one logical strategic request to usable final output or terminal failure | Report queue time separately from provider attempts; retain attempt start, first token if available, final result, retry, and failure timing |
| Runtime dispatch latency | Eligible action proposal received by executor to first corresponding adapter effect dispatch | Separate lease/cancellation wait from executable dispatch; do not count an entire long action as dispatch latency |
| Policy reaction latency | Relevant observation admitted for policy evaluation to executor admission of its usable proposal | Report local-code and Jev/AI backends separately; retain provider and executor components and rejected/expired responses |
| Observed reaction-to-effect | Observation admitted to first confirmed relevant game effect | Report separately from proposal latency; uncertain effects are not successful reactions |
| Time to objective | First gameplay `running` to first verified task success | Give total wall elapsed and active-gameplay elapsed; retain failed, stopped, and censored runs |

Total run wall time is start acceptance to terminal state or the reporting cutoff. Partition it into startup/bootstrap, active gameplay, explicit operator pause, infrastructure downtime/recovery, and any otherwise unclassified lifecycle interval. Active gameplay includes inference waits and legitimate game waits while the run can play. Profile-defined game failures and ordinary in-game recovery remain gameplay outcomes; Minecraft death and respawn are examples, not infrastructure downtime.

Within active gameplay, label each time interval once for idle analysis: meaningful action/execution, meaningful game-mechanical wait, LLM-induced idle, runtime/orchestration idle, or unclassified. An interval is LLM-induced idle only when no useful action or required game wait is in progress and the next useful action is blocked on strategic or fast-model output. Inference that overlaps useful execution is latency but not idle. Cooking or waiting for a relevant observed game condition can be a meaningful wait; an unexplained wait cannot be credited solely because the model calls it intentional. Attach the action or observed precondition supporting that classification. Report ambiguous intervals as unclassified.

Track these measures in addition to timing:

- Verified objective/milestone progress, currently retained task-relevant state, failed actions, cancellations, `unknown` outcomes, and profile-defined game failures with their event references.
- Logical strategic decisions and fast-policy decisions, provider attempts, retries, validation calls, policy evaluations, trigger opportunities, and action submissions. A cheap local evaluation is not an LLM call.
- Actual uncached input, cache read, cache write, output and provider-call counts separately, with available request/attempt IDs and host-attributed purpose (`authoring`, `planning`, `replanning`, `improvement`, `other`). Preserve provisional admission role and final visible-tool/host-role classification under the [accounting contract](runtime-contracts.md#current-compact-program-interface); a missing response leaves a non-final role. No accounting-only model call or hidden-reasoning inference is required. Record known cost and its price source/date; missing pricing stays unknown. Historical aggregate input stays explicitly unclassified, never fabricated into a cache breakdown. Subscription access is not proof of free requests.
- Strategic payload size, selected detail retrieval, program authoring/revision and warm-validation work. Compare total useful-task outcomes and actual usage under matched conditions; compact code or a provider cache hit does not guarantee lower total tokens, latency or cost.
- Host/backend/native CPU, event-loop delay, observation capture/query/serialization latency, command admission-to-effect latency, delivered native FPS/staleness and program/root/child durations, with sample counts and missing spans. Attribute bottlenecks before choosing a native-language optimization. Keep performance evidence separate from model token/cache accounting.
- Policy versions created, tested, activated, rejected, quarantined, or rolled back, plus actual backend availability and use.
- Human interventions, infrastructure failures, downtime, recovery epochs, environment restoration branches where supported, and missing evidence.

Report counts, sample sizes, medians and ranges for run-level measures. For per-call latency also give p50/p95 with sample counts; label sparse percentiles as descriptive. Do not merge retry attempts with logical decisions or sum overlapping spans into total wall time.

### Execution trace, review and descriptive comparison

The implemented bounded trace records actual API requests/results, authorized observation snapshots, instrumented JavaScript condition decisions/source locations, model-authored intent, attributed spans and explicit omissions. It is not a transcript of hidden reasoning. Branch instrumentation preserves canonical source/hash and evaluation semantics; a branch decision or `game.progress` statement does not establish why a model changed target or that an action succeeded. The [runtime trace contract](runtime-contracts.md#bounded-execution-trace-and-revision-evidence) owns record, storage and page budgets.

Classify apparent pauses from measured `native_action`, `dispatch`, `receipt`, `readiness`, `sandbox`, `capability_wait`, `strategic_request`, `scheduler_handoff` and `life_recovery` spans. Preserve missing/cross-clock uncertainty and overlapping intervals. The operator's slow-camera, roughly five-second-pause and three-tree/target-switch observations are ground truth about the reported experience; without the exact run/evidence, no cause or tactical explanation is established.

Compare actual confirmed block removals, receipted own inventory deltas, target-ID and target-position switches, sampled/receipted travel and rotation, timings, outcomes and sample counts. Extra blocks are not categorically waste: enabling access, movement and other legitimate work can require them. Do not infer tree membership from unrelated target handles or label a target change mistaken without authorized evidence.

Durable deduplicated death/failure/outcome opportunities reach the same strategic model. It inspects named source/feedback/trace through `program_inspect`, authors its own candidate and uses `program_write` with exact `based_on` plus a bounded experiment `reason` to link the actual revision to matching parent feedback. The host supplies exact evidence identities. If no revision is chosen, `program_review` records `keep` or `insufficient_evidence` with the reason; no bookkeeping-only second inference is required for a performed revision. Either assessment permits a later repair: the original resolution stays immutable, and `learning.candidate_written` separately retains the new candidate's exact lineage, outcome evidence and reason. No review call is required before authoring.

Feedback V2 delivers published opportunity/resolution updates and metric
`replace` or `retract` updates, including corrections to previously returned
executions. Removal from a named scope retracts the old metric with reason
`execution_removed`; it does not imply that the execution was deleted everywhere.
A family/version move atomically retracts the old scope and replaces the new
scope, even for the same execution ID. Retraction never invents a metric value.
Executions removed before their first publication are not emitted. Exact program,
execution ordinal, revision and generation retain the update's provenance. Its
independent change sequences and scope hash bind continuation to the selected
run/family/version. Projection provenance distinguishes the published source
boundary from available source work; `has_more:false` does not clear
`has_pending:true`. Preparation follows committed source changes and bounded
dependency work; an inspection read never advances publication.

A changed version is an unmeasured candidate until execution evidence exists. The comparison view exposes actual source/card differences and before/after raw samples with `descriptive_only_no_causal_improvement_claim`; even measured candidates are not automatically proven better. Comparison V2 pins both complete published generations, selected immutable versions and caller scope across continuation and reopen. It includes executions that started and ended, including unknown outcomes, but excludes undispatched cancellations. Samples retain before-side then after-side insertion order. Decisions record experimental disposition, not confidence in improvement. Eligibility and promotion remain separate; missing samples, invalid linkage and trace omissions remain explicit.

Page limits omit whole metric/evidence records with recoverable references,
rather than truncating their fields. Retrieve a full authorized record through
the actor's named `program_inspect` `metric` or `evidence` view using its exact
version, execution ordinal and generation, or through the corresponding
operator generation-pinned execution route in
[runtime contracts](runtime-contracts.md#current-compact-program-interface).
Retained prior generations remain readable by ordinal after live-ledger deletion.
Continue archive chunks and verify the complete record before interpreting an
omission as missing evidence or claiming a comparison population is complete.
Generated help and source schemas own the callable DTOs.

If the task remains unsatisfied, the model may revise and retry through ordinary bounded admission. After verified goal success, a single bounded effect-free review can inspect evidence and author linked candidates before completion, but cannot conduct extra gameplay trials. Goal closure retains the healthy game session. Optional bounded lookahead records actual overlap, validation/rejection/activation and usage; only fresh session/life/task/predecessor/source checks can activate it. Neither overlap nor the historical 31/13/7-call receipts establishes controlled efficiency or causal savings.

### Observation pipeline performance

Measure perception independently of LLM inference. Materialize the actual settings in the [Minecraft observation contract](runtime-contracts.md#current-player-observable-structured-profile) and retain their fingerprint with each result. The current native eight-block on-demand sampler and the documented future 32-block scheduled sampler are different configurations; the shared historical r2 label cannot certify equality. Do not substitute proposed defaults for unknown historical settings or claim the complete RGB/frustum profiles from a current PNG attachment.

| Measurement | Required evidence |
| --- | --- |
| Refresh queue delay | Time from a scheduled refresh becoming eligible to the adapter beginning its work; include skipped/coalesced refreshes. |
| Filtering work | Per-refresh enumeration, occlusion and authorized-index update elapsed time; record active work separately from cooperative yields or queue waits. |
| Query and publication | Authorized-index lookup, pagination and serialization time, UTF-8 output bytes, publication time, and record count. Never equate a fast empty response with complete coverage. |
| Coverage and freshness | Actual processed slots/candidates/rays/cell visits, deferred work, complete sweep time, last-check age of returned records, reveal-to-authorized-publication delay, and expired/unknown records. |
| Guard pressure | Count-cap exhaustion, elapsed-work-guard exhaustion, missed refresh periods, incomplete coverage, discarded stale work and bounded-query failures. |
| Local controller cost | Geometry reads, search expansions, planning elapsed time, replan cadence, and time until a newly admitted movement or stop reaches the adapter. |
| Host impact | Adapter CPU, memory, event-loop delay and queue growth, measured alongside policy reaction/effect latency and live-view freshness. |

Use process-local monotonic spans and canonical event references. Record an observation becoming available to the runtime separately from the later strategic/Jev request and game effect; filtering delay must not disappear into the model-latency measure. Raw scan/raycast/navigation counters and fixture truth remain trusted diagnostic evidence. Agent feedback may expose safe aggregate latency, age and pressure, never hidden-object counts, identities, coordinates or private geometry.

The initial measurement procedure is **30 seconds of warm-up followed by 120 seconds of measurement, repeated three times per case**. These are chosen engineering settings, not measured results. Exercise quiet ordinary terrain, dense/occluded terrain, movement with chunk arrivals and invalidations, and a bounded entity/update-pressure case. Report cold-cache behavior separately from warmed steady state. Controlled security/stress fixtures may exercise limits but cannot become gameplay-training evidence; also repeat the relevant measurements in a real ordinary-world run with strategic inference and policy execution active.

Report p50/p95/p99 and sample counts for the latency distributions, plus throughput, coverage age, bytes, CPU/memory and every exhaustion/miss rate. Check processing against the preset's refresh cadence and work guards, and show whether useful observations stay fresh while effects and stop handling remain responsive. Low latency with incomplete coverage or repeated expiry is not a successful performance result. Preserve paired reveal/hide checks so optimizing throughput cannot remove occlusion or stale-memory enforcement.

If the preset misses its goals, retain the results, revise the explicit configuration and rerun matched cases. Do not silently raise caps, weaken filtering, drop slow samples or pool fingerprints. Old-spike fixture timings are scoped conformance evidence, not native observation-performance measurements.

### Control-only Time to Fluidity

Control-only Time to Fluidity (TTF) measures the first sustained period of control without frequent inference stalls. It is not a human-equivalence score, task-success verdict, or synonym for continuous player movement.

The initial engineering definition uses a **120-second active-gameplay window**, evaluated at **1-second active-gameplay increments**. A qualifying window must:

1. Have LLM-induced idle occupying **at most 10%** of the window, with **no single LLM-induced idle interval longer than 5 seconds**. Require complete enough event coverage to classify the whole window; unclassified time prevents qualification.
2. Contain evidence of control activity or a meaningful game-mechanical wait, linked to actions, observations, and the declared task intent. Standing idle, repeated camera movement, or padding movement does not establish meaningful activity merely because a model labels it useful.
3. Have no human tactical intervention. Report runtime/orchestration idle separately; it cannot be relabeled as useful execution to satisfy the window.

Progress, non-regression, deaths, and game success are **not prerequisites for this control timing number**. For the **same qualifying window**, separately report newly verified task progress, retained state/non-regression, deaths and other failures, objective status, and all idle categories. Fast combat can have good control with an unresolved outcome. Running in circles may have low inference idle but no useful progress and cannot be reported as overall success; if padding is evident, it also fails the activity requirement. Preserve the evidence and classification rather than hiding either case.

For example, Minecraft's stone-pickaxe task can declare first possession of wood, a crafted table, a wooden pickaxe, and a retained stone pickaxe as progress predicates. Non-regression can require retaining an attained tool/capability tier and completed terminal milestones while allowing ordinary resource consumption. Death, health/inventory changes, lost progress, and subsequent recovery remain efficacy evidence even if the control window qualifies. These evaluator predicates are not a scripted action sequence supplied to the agent. Mere distance traveled or staying busy does not establish progress.

`control_ttf_active_ms` is active-gameplay elapsed from first gameplay `running` to the **end** of the first qualifying window. `control_ttf_wall_ms` runs from accepted start request to that same endpoint, including startup/bootstrap, pauses, and downtime. Retain the qualifying event range and window-level efficacy results. Do not backdate TTF to the window's beginning. A pause or infrastructure outage breaks continuity; after resume, begin a new contiguous window while retaining accumulated active elapsed time. Do not concatenate unrelated fragments into a smooth-looking window.

If no window qualifies before cutoff, report `not reached` with the observed horizon. A task completed before a full window is successful for its objective but has censored TTF; do not fabricate zero or instantaneous fluidity. Incomplete timing evidence makes TTF unmeasurable. A legitimate game wait can qualify on control timing while progress remains unchanged; report both. These configurable engineering windows do not assert human-level reaction or gameplay quality.

### Policy acquisition and revision evidence

Predeclare a policy's **usefulness predicate** before its trial: a real trigger opportunity, intended observable effect, permitted latency/idle target where relevant, and required safety/non-regression conditions. A policy becomes useful for this metric only when an independently verified real use satisfies that predicate. Registration, validation, activation, a model's assertion, and a trial with no trigger are insufficient. Retain failed/no-effect uses and unknown outcomes. Prior library evidence supports eligibility, but the current run must provide an actual useful use for its acquisition metric.

Use the following exact derived metric names. Event identities and timestamp fields come from the [runtime contracts](runtime-contracts.md); do not create parallel clocks:

| Metric | Evidence and endpoint |
| --- | --- |
| `time_to_first_useful_policy_active_ms` | Active-gameplay elapsed from first `running` to the first current-run verified useful-policy outcome; report the exact policy/card version, usefulness predicate, opportunity/use, and outcome evidence |
| `time_to_first_useful_policy_wall_ms` | Accepted start request to that same verified outcome, including startup/bootstrap, retrieval, validation, activation, and any downtime |
| `policy_creation_latency_ms` | Admission of the strategic request that first authors the candidate to `artifact.authored`; include provider attempts and link any `opportunity_id` |
| `policy_validation_latency_ms` | Validation admission to `policy.validation_completed`, including unsuccessful validation; distinguish executed validation from a matching cached result |
| `policy_revision_latency_ms` | `improvement.opportunity_delivered` to `artifact.authored` for a linked revision; include deferral/waiting and provider time, preserve the parent version, and report open/censored opportunities separately |
| `policy_activation_latency_ms` | Accepted activation request to `policy.activation_effective` for the exact version, including scheduling/fencing wait; rejected requests have a rejection outcome, not a successful latency |
| `policy_revision_count` | Number of authored immutable successor versions, separated from first versions, provider retries, and card-only evidence updates |
| `policy_trigger_opportunity_count` | Recorded eligible trigger opportunities for each exact version, including those yielding no proposal |
| `policy_actual_use_count` | Proposals from that version actually admitted by the executor; also report confirmed effects, no-effect, rejected, expired, failed, and unknown results separately |

Both first-useful-policy measures require actual gameplay evidence after effect admission during `running`. Warm hydration and activation establish readiness, not a useful current-run effect. Do not replace missing/censored endpoints with zero; report `not reached` or unmeasurable when appropriate, with the observed horizon and reason. Inherited qualification alone cannot produce a zero. A zero-authoring-call warm activation is possible and must remain distinguishable from time to a useful current-run effect.

Retain `improvement.opportunity_created`/`updated`/`delivered`/`decided`, `artifact.authored`, `improvement.trial_started`/`decision_due`/`decided`, validation, activation, and action/game-outcome evidence with `opportunity_id`, `trial_id`, exact artifact/card refs, and parent refs. Record the opportunity's evidence window, delivery/decision times, hypothesis, candidate creation, validation, trial decision, keep/revise/revert/retire disposition, and revision count. For warm startup, retain `experience.bundle_hydration_started`, `experience.bundle_validation_completed`, and `experience.bundle_activation_completed`, with `bundle_id`, cache decision/identities, rejected entries, and first confirmed effect. This separates retrieval/rehydration cost, authoring cost, activation readiness, and observed gameplay benefit.

For each revision, report matched, predeclared before/after windows with observation profile, backend, opportunities, actual uses, sample sizes, reaction/dispatch/effect latency, idle categories, progress, non-regression, and failures. A revision may improve response timing while worsening task outcomes. These within-run windows are descriptive because environment state and exposure change; the controlled experiment below supports attribution to the policy-capability package.

## End-to-end evaluation

### Environments and tasks

Use real end-to-end play under the selected profile's ordinary starting conditions to discover whether skills and policies help. Declare bounded tasks, sustained progression, and any long-horizon objective separately. A game need not have a single terminal completion state. Report workflow readiness and verified task outcomes independently; successful orchestration does not establish game completion, and an unfinished long-horizon objective does not erase evidence of a working workflow.

The bounded natural-task definitions live in [`src/evaluation/scenarios.ts`](../src/evaluation/scenarios.ts):

| Scenario | Model task | Predeclared semantic evidence |
| --- | --- | --- |
| `collect_wood` | Collect wood. | Fresh alive own-inventory gain of an eligible wood/log/stem/hyphae item over the run baseline. |
| `craft_crafting_table` | Craft a crafting table. | A successful craft with a confirmed positive native inventory receipt, plus a fresh alive observation retaining the table. Possession alone is insufficient. |
| `obtain_stone` | Obtain a stone or cobblestone item. | Fresh alive own-inventory gain of stone or cobblestone over the run baseline. A visible block or removal alone is insufficient. |
| `collect_and_craft_table` (explicit-only) | Collect wood and craft a crafting table. | Eligible own wood acquisition before consumption, then this run's confirmed positive crafting-table craft receipt and fresh alive retained table. Scoped prior native inventory receipts can prove wood acquired between polls; spare final logs are not required. |

Each case starts in its own ordinary isolated Normal Survival world with ordinary terrain/inventory, without console cheats, a flat arena, supplied resources or evaluator-authored gameplay code. Tasks do not prescribe a program count, planner/tool sequence, predicate, fixed sleep or copied IDs. Declare verifier and finite limits before inference, retain the bounded sample including failures, and do not tune the backend merely to win. Cross-model comparisons retain declared conditions and label any uncontrolled differences. These scenario definitions are implementation, not new run results.

Default selection and `--scenario all` retain the original three-case cohort; the combined collection/crafting case requires `--scenario collect_and_craft_table`. It uses runtime goal `craft_crafting_table`, so acquiring wood does not end the run early. The acceptance case owns explicit per-run verifier progress and persists observed-wood provenance alongside final action/observation references. Foreign, stale, unconfirmed and unknown receipts cannot establish the milestone.

For the combined case, eligible wood in a confirmed own native receipt's `inventory_before`, above the run-start baseline, proves possession before consumption. The receipt must precede the confirmed table craft in the current session/life and run time window. This permits native planks crafting to establish the wood milestone without a dig inventory receipt or intermediate evaluator poll; the result retains references to both receipts.

Recorded acceptance now keeps a separately bounded private append-only journal as events occur. It observes final SDK-visible context through an additive `Agent.addBeforeModelCall` callback, visible assistant partials/messages, original tool arguments and results, authorized observations, source snapshots and native receipts. A trusted Store tap records authorized root observations/capability data before ordinary trace payload/aggregate caps; the compact report and ordinary Store are not complete substitutes. Typed images become deduplicated private artifacts. Private provider reasoning is explicitly redacted; credentials, auth headers and secret-store contents are outside the observer. SDK-visible context is not a wire payload or proof of hidden transport attempts.

The default text journal allows 256 MiB total and 16 MiB pending asynchronous writes. A complete checked `--evidence-profile` declares effective recording, text/image journal and renderer bounds; a registered study must pin that file's exact preprocessing identity. Manifests distinguish actual durable bytes/artifacts from accepted reservations and report pending peaks. Capacity/persistence failures stop the attempt visibly. Completion and interruption join the actual journal, recorder and handles before observer/Store closure. A replay must be rendered and inspected for recorded acceptance.

`bun run evaluate native-recording --allow-native --jar <fresh-built.jar>` is a separate zero-inference infrastructure proof. It uses the existing private evaluation paths and fresh-artifact gate, records a deliberate wait, native effect interruption/neutralization, visible vanilla DeathScreen and explicit respawn, and compares replay duration against capture time within a predeclared 134 ms tolerance (one nominal 30 Hz interval plus 100 ms, rounded up). Observed frame gaps are diagnostic and cannot enlarge that tolerance. Actor and recorder PNGs preserve visible native RGB with opaque alpha, matching the actual game viewer rather than treating framebuffer alpha as display transparency. Inspect its replay and actor PNGs manually. Its privileged setup never enters a natural acceptance case; direct effect interruption is not a new proof of Runtime Stop. This entry point does not log in or replace account authority.

[`scripts/agent-acceptance.ts`](../scripts/agent-acceptance.ts) uses actual `AuthManager` discovery and an existing private auth store opened in place, without login/logout, credential copying, account fallback or a synthetic strategic caller. Live execution requires both resource opt-ins. Diagnostics retain their hypothesis/evidence revision and justified nonordinary model selection; study execution binds the registered manifest/slot directly and confirms its exact arm model. Natural tasks are not `api_control` work. Full evidence and compact reports remain private by default; the entry point and generated help own current arguments.

The recording proof accepts `--duration-ms` through 1,800,000 ms. A 20–30-minute
sample requires an explicit complete profile with enough duration/frame
capacity for the complete admitted capture scope, including existing technical
phase allowances, not just the requested window. Duration and nominal frame
capacity are checked before native preparation. Its declared window, final hold, actual index/replay duration,
gaps and owner drain are checked; a short clip is not a long-run pass.
The controlled technical arena and natural-start/runtime-load conditions
remain separately labelled. Long synthetic SDK captures finish their
initial request normally and retain the evidence workload while idle,
without chaining requests or claiming continuous model reasoning.

Replay verification checks frame inventory and presentation timestamps, not
duration alone. The local FFmpeg/FFprobe integration tests cover 30 Hz capture,
a large terminal gap, final hold and refusal of a changed finalized manifest.
Keep an old render when deriving a corrected export from its original PNGs;
label the new render's source and options rather than rewriting capture history.

Ordinary-world efficacy and fresh-world completion use ordinary environments. A prepared development or mechanical task is allowed as a separately declared condition, with initialization, human feasibility preflight, interventions and claim limits retained; it cannot pass as ordinary fresh-world acquisition. Keep setup coordinates, scoring and privileged truth outside actor feedback and reusable experience. Whole-agent study execution still refuses prepared/restored starts; the dedicated resident-platform runner admits only declared technical timing fixtures.

Controlled security and synthetic/replayed event fixtures establish infrastructure behavior, not tactical efficacy, transferred learning or end-to-end completion. The [observation/navigation proof](operations-and-security.md#structured-observation-and-navigation) exercises range/behind-camera permission in its current assisted condition, reveal/conceal, stale memory, coarse audio, alternate-route isolation, private geometry and unknown-target/error leakage. Retain raw diagnostics privately and record any optional Paper configuration separately. Event/video playback is not deterministic environment rewind.

### Environment separation and leakage controls

Maintain three evaluator-owned groups of initial environments:

- **Practice/training:** ordinary environments that may be revisited through fresh initialization or supported clean copies to create and revise reusable experience. Save the practice history and its library contributions.
- **Comparison:** declared initial states used for paired cold/warm comparisons. Freeze the warm library before this batch. Do not use results from this group to revise the library within the batch.
- **Held-out:** environments not used to create the evaluated library, tune scoring, or rehearse tactics. Keep hidden initialization inputs outside agent tools and retrieval. If exposure occurs, retain the incident and use a different environment for a later unseen-environment claim.

Declare how the adapter establishes equivalent starting conditions. Use identical clean snapshots where supported; otherwise record the supported reset/initialization procedure and any remaining variation. If equivalent starts cannot be established, report that limitation and do not describe the comparison as snapshot-controlled. Every fresh comparison instance has a new run/world lineage, rather than resuming another arm. Hidden initialization identifiers remain evaluator-owned, even if the game has no seed.

Before each repetition, reset conversations, summaries, worker state, run-private artifacts, environment-specific memory, and outcome-bearing retrieval caches. Reload only the declared immutable warm snapshot, or an empty inherited snapshot for cold. Reference access remains identical. The trusted evaluator may retain results from every arm; those results cannot enter another arm's context. Keep hidden initialization identifiers opaque to the agent and prevent lookup through retrieval.

### Required cold/warm procedure

1. Freeze a warm library produced from recorded practice, its model/game/adapter/profile compatibility, and all experiment settings. Record the cold library as empty.
2. Prepare equivalent clean initial environments for both arms using the declared adapter-supported procedure. Fix the same task text, capabilities, bootstrap limits, model/provider versions and settings, authorized authentication conditions, backends, observation profile/version/configuration fingerprint and interface/schema, server flavor/build/effective configuration, reference access, and horizon. The same information/private-navigation permissions and Anti-Xray settings apply to both arms.
3. Declare a balanced order that alternates which arm runs first across pairs. Run arms serially on the same host so concurrent comparison workloads do not create avoidable contention. Record time of day, provider failures, and other unavoidable variation.
4. Start each attempt through the normal product lifecycle and collect the evidence defined above. Allow the model to create and revise policies within its own attempt. Do not provide tactical coaching, state edits, privileged actions, or other assistance outside the declared profile.
5. Stop at verified task success, the declared horizon, an operator safety stop, or a terminal failure. Preserve the reason and last verified state. If a failed run is repeated for diagnosis, keep the original in the table and mark the additional run as diagnostic.
6. Publish every scheduled attempt and its paired environment/repetition identity, arm, snapshot, objective status, control TTF status with same-window efficacy, policy-acquisition/revision measures, progress, latency/idle measures, profile-defined game failures, usage/cost status, and interventions. Compare paired deltas where both values exist; retain censored/unmeasurable cases rather than dropping them from averages.

A provider outage, startup failure, or incomplete trace is a result to report, with a specific classification. A run that recovers can continue with its audit trail; report wall time and downtime instead of discarding it. Where an adapter supports environment rollback, it creates a marked branch and requires memory reconciliation under [operations and security](operations-and-security.md). It cannot be hidden as uninterrupted play. Report both all-scheduled-attempt outcomes and any narrower gameplay-only analysis, with explicit denominators and exclusion reasons.

Small samples support engineering decisions about the declared configuration. They do not establish universal superiority across models, environments, adapters, or game versions. If warm is worse or indistinguishable, publish that outcome and inspect the evidence.

### Required policy-capability experiment

Alongside cold/warm, run at least **one controlled internal experiment** comparing the following capability conditions:

| Condition | Available programming and execution |
| --- | --- |
| Policy-disabled control | Strategic tools, ordinary bounded skills with loops/conditional code, the asynchronous executor, and the same permitted primitives; registered reactive-policy creation/activation and fast-policy requests are disabled |
| JS/Jev-policy-enabled treatment | All control capabilities, plus model-authored registered JS policies and Jev-backed fast-policy configurations/requests under the normal validation, trial, lease, and activation contracts |

Both arms are **cold**, with no inherited policies or reusable project experience. Both retain conditional bounded programs and therefore some ability to react; do not cripple the control into one-action-per-model-turn play or claim it has no possible reactivity. Availability is the assigned treatment. Record whether the model actually authored, triggered, used, or revised each backend; non-use, unavailable Jev, failed trials, no-effect results, regressions, and task failures stay in the result set.

Freeze the same strategic model/provider and sampling settings, task/verifier, fixed-seed ordinary-world clean spawn copies, observation profile/version/configuration fingerprint and interface/schema, server flavor/build/effective configuration including Anti-Xray, runtime/adapter/capability versions, primitives, bounded-skill interfaces, asynchronous scheduling, reference access, authorized authentication conditions, bootstrap/horizon, and comparable declared execution/request limits. Information permissions and private-navigation projection/envelope/goal rules cannot differ between arms. Declare repetition counts and balanced serial order before running. Apply the same lineage isolation, sealed-batch deferral, no assistance, evidence, censoring, and all-scheduled-attempt reporting rules as cold/warm. No staged encounters or synthetic tactical arenas supply efficacy evidence.

Compare control TTF and latency/idle **separately from** task progress, non-regression, deaths, success, and time to objective; include policy-acquisition and revision evidence for treatment. This estimates the effect of the **policy-layer capability package**, including any use of a helper model and its additional calls/usage. It does not isolate Jev's value, remove all code-level reactivity from control, or establish universal novelty. Report the additional helper usage and limitations rather than attributing every difference to faster decisions.

A treatment cold attempt may also serve as a cold/warm cold attempt only when identical conditions and this reuse were predeclared. List the same `run_id` in both analyses and do not count it as an independent new sample. The policy experiment must still include its matched policy-disabled arm; a cold/warm comparison alone cannot establish policy-layer benefit.

### Optional diagnostic experiments

Finer JS-only versus Jev-only versus mixed-policy comparisons, or asynchronous-versus-serialized execution, can help locate a bottleneck after the required cold/warm and policy-capability experiments are defined. Change one declared factor, use the same initial-environment and snapshot discipline, and report actual backend use. A serialized diagnostic must not become the shipped scheduler or delay the core workflow. These finer ablations remain optional; the policy-disabled versus JS/Jev-enabled experiment above is mandatory.

## Minecraft reference evaluation profile

Minecraft Java **1.21.4**, **Normal Survival**, one avatar, ordinary death/inventory rules, and no agent cheats/operator powers are the implemented first integration's tested conditions for the scoped episodes above. Those episodes used `minecraft_assisted_rgb_360_r8_v1`, with observation envelope 3 and hash-bound effective configuration; the [current GUI-v2 contract](runtime-contracts.md#current-player-observable-structured-profile) is a separate declaration, not a relabelled gameplay result. The broader perception requirements also distinguish assisted RGB/frustum and strict-visual alternatives; those conditions remain separate from delivered support. Information permission is independent of delivery: the application supplies [authorized typed actor PNGs](runtime-contracts.md#delivered-actor-images-and-recorded-episodes) alongside structured state. Audio and synchronized capture are not implemented by these profiles.

The profile permits bounded nearby unobstructed objects independent of camera direction, own status/inventory/UI, normal F3 coordinates, public recipes/docs and world-local memory. Freeze actual finite observation/query limits in manifests. Hidden resources/structures, exact live concealed entity state, seeds, saves, evaluator state, raw native world/chunk/entity access and video buffers cannot enter agent observations, logs, errors, retrieval or libraries. Last-seen memory stays stale; only real audio yields coarse sound signals. Filter before counts, ordering, truncation and errors; unobserved means unknown.

Trusted navigation has the runtime's [bounded client-loaded geometry-only exception](runtime-contracts.md#bounded-private-navigation-geometry) for local movement and bounded local detours toward the same authorized known target/waypoint, even through collision cells not individually observed. Private geometry is separate from observation/memory, cannot identify hidden resources/entities or support global loaded-world selection of undiscovered caves, corridors, shortcuts, or exploration routes, and cannot be exposed through raw paths, maps, reachability, or diagnostics. Goals/higher routes remain based on permitted observations/memory or model-chosen bounded exploration. No strict-FOV/all-voxels-observed map is needed; discovering a new route outside local execution requires observation/replanning or neutral bounded failure. Steering/path choice/timing may benefit from the declared local geometry, so matched runs must retain the same permission without claiming human-identical perception or formal zero leakage.

Paper Anti-Xray is optional defense in depth, not a substitute for GameHarness filtering or an entity-information boundary. Filtering must work with it disabled. Server flavor/build and effective per-world/dimension configuration remain fixed and recorded as above; masked/false ores are not genuine discoveries. No Anti-Xray deployment or test result is established here.

Practice and evaluation start from fresh ordinary spawn with ordinary starting inventory. The concrete task suite is:

| Task | Verified outcome | Why retain it |
| --- | --- | --- |
| Early resource progression | Craft and retain a stone pickaxe starting at fresh spawn, without operator gifts or world edits | A bounded end-to-end task covering observation, decisions, movement, resource use, and crafting |
| Sustained progression | In a declared longer horizon, remain operational and achieve the predeclared next prerequisite milestones toward full completion | Exposes repeated decisions, useful waits, adaptation, deaths, and policy revisions beyond one craft |
| Full completion | Autonomous Ender Dragon defeat from fresh spawn, with evidence of the whole run and any interruptions | Retains a distinct long-horizon objective rather than treating an early tool as completion |

Select an actually registered verifier for each supported predicate, or declare the task custom and retain model-reported completion separately from independent assessment. The current bounded verifiers do not establish sustained progression or Dragon defeat. If the dragon is not defeated, report the furthest verified milestone, elapsed exposure, deaths, interventions, failure causes, and remaining objective. A bounded task does not substitute for the Dragon objective; workflow readiness and full-completion status must remain separately reportable.

Use evaluator-owned seed groups for practice, comparison and held-out evaluation under the separation rules above. An eventual release comparison must predeclare its sample, seed groups, order and per-run horizon; no historical sampling proposal authorizes an immediate live batch. Current engineering acceptance follows the [shared attempt and stopping policy](#attempt-admission-and-stopping). Hidden seed values may remain withheld during held-out evaluation, but retain them privately for reproducibility.

A seed reproduces starting terrain, not model outputs, spawn-time scheduling, entity behavior, or every game event. Preserve the clean initial save and environment manifest for each pair. The evaluator may copy the initial ordinary spawn state; it must not stage items, mobs, prepared combat encounters, or favorable terrain. Each restored comparison copy is a new run/world lineage. Neither seed lookup nor maps from another world may enter the agent's tools, retrieval, or reusable library.

## Long-horizon evidence

Long-horizon attempts need their own predeclared multi-hour or multi-day horizon and stop conditions. Keep the initial-state identity, model/game/adapter/profile manifest, library snapshot, complete durable events/action ledger, artifact history, progress verification, and environment lineage. Retain checkpoints or saves where the adapter supports them; their absence must be explicit. Conversation summaries alone cannot establish task completion or explain a recovery gap.

Maintain a run table even when only a few long attempts are available: starts, completed objectives, cutoffs, profile-defined game failures, actual infrastructure uptime/downtime, restarts, human interventions, unknown action outcomes, and terminal status. Evidence for an autonomous completion must connect the declared initial state to verified success without concealed coaching, state edits, or unexplained gaps. For Minecraft Dragon completion, that means fresh spawn through the verified defeat event. A final-event excerpt alone is insufficient.

Release verification retains progressive soak, disconnect/restart, cancellation/stale-response and sandbox/observation checks under [operations](operations-and-security.md). The integration guide identifies exercised scenarios and their implementation generation. New Docker infrastructure proof and old adapter fixtures cannot establish native reliability or useful gameplay.

Recordings must show genuine observed behavior and identify the run, environment/profile, library snapshot, condition, timestamps, cuts, and playback speed. Preserve original events and full source recordings when publishing selected excerpts; disclose selection and do not imply highlights are typical outcomes. Label prerecorded footage explicitly. Missing or failed attempts remain in the result set, regardless of which recordings are shown.
