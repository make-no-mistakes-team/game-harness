# Learning and evaluation

This document specifies how GameHarness will retain experience, measure useful play, and compare cold and warm starts across game adapters. These are requirements for the planned implementation. Minecraft is the first concrete integration profile; additional games require their own adapters and evaluation profiles. No gameplay runs, policy effectiveness measurements, or cold/warm results have been produced by the repository yet.

The [PRD](prds/gameharness-v1.0-prd.md) owns product scope and acceptance. The [runtime contracts](runtime-contracts.md) own identifiers, lifecycle states, scheduling, policy activation, observations, and action semantics. [Operations and security](operations-and-security.md) owns isolation, credentials, recovery, and release verification. This document defines the evidence collected through those contracts; it does not create a second control API.

## What learning means here

Learning means that the strategic model writes, tests in ordinary play, and revises external artifacts that later runs can reuse. It does not mean reinforcement learning, fine-tuning, or changing model weights. The strategic model already has pretrained knowledge. Public game documentation and brokered wiki or internet retrieval are allowed sources, subject to the selected observation profile and security boundaries.

| Artifact | Purpose | Persisted content | Evidence needed before relying on it |
| --- | --- | --- | --- |
| Knowledge | Facts, hypotheses, explanations, and lessons | Human-readable statements, source references, scope, uncertainty, and supporting or contradicting events | Distinguish a documented fact, an observed result, and an untested inference; retain contradictions |
| Skill | A long-running program for a goal or subgoal | Agent-authored source, interface and preconditions, serializable state format, dependencies, version, and termination conditions | Runtime validity plus actual outcomes from invocations under stated conditions |
| Policy / reflex | A short reactive decision rule or fast-AI configuration | Agent-authored JS source or declarative typed AI configuration, declared inputs/actions, priority, deadlines, and applicability | Runtime validity plus observations from bounded trials and later uses |

A skill may use several actions over time. A policy proposes a response while strategic inference and an existing action continue independently. The executor retains ownership of effects. The [architecture overview](architecture/overview.md) explains the module boundaries; the runtime contracts define the single foreground action lease and cancellation rules.

All game strategies, skill programs, and reactive conditions must originate from the model. The adapter supplies declared mechanics and permitted observations; the generic runtime schedules actions without interpreting game-specific observation fields or supplying tactical routines. In the Minecraft profile, this excludes handwritten gathering, survival, combat, and completion routines. A developer can repair an executor bug or capability contract; adding a tactical rule by hand changes the provenance and must not be presented as agent learning.

Understandable high-level strategies are sufficient. There is no requirement to imitate human low-level thought, invent a strategy new to humanity, or run human-subject strategy trials.

## Libraries, provenance, and snapshot boundaries

### Cross-session library

The default library is per strategic model, with artifacts scoped to compatible game, adapter, and observation profiles. A run selects an immutable library snapshot before starting; later changes in another run cannot silently change that selection. Shared experience is portable only when its environment and capability assumptions still hold. No cross-game or cross-adapter portability is implied by sharing an artifact format.

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

An artifact rejected for version or permission/configuration incompatibility is reported as rejected; it must not quietly become an empty or different warm snapshot. Changed observation, navigation, or server permissions invalidate incompatible artifacts and cached validation. Reassess compatibility and revalidate under the new profile before use; stale evidence cannot certify the changed permissions. Migration creates a new version and requires a new comparison declaration. Do not relabel strict-profile evidence as `player-observable-structured` results; there are no historical gameplay results here to migrate. Cross-model transfer is an optional future experiment, not the default warm condition.

### Selective retrieval and autonomous promotion

The canonical `experience.*` tools are defined in the [runtime contracts](runtime-contracts.md). At a task or improvement boundary, the model uses `experience.search` to inspect bounded metadata, StrategyCard summaries, compatible exact-version references, and evidence summaries. It calls `experience.get` only for selected source, cards, or evidence, and `experience.getPerformanceHistory` for actual trial/invocation history, including failures, unknowns, context, and sample sizes. Bounded lexical/metadata search is sufficient initially; a vector database is not required. Search and reads cover only the selected immutable library and current run-private branch, filtered by model/game/adapter/profile/version/capabilities. They never expose another comparison arm or hidden evaluator data.

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

### Equal bootstrap for cold and warm runs

Both conditions receive the same task, capability descriptions, permitted reference access, policy-authoring tools, and explanation of inference latency. The explanation may describe runtime behavior; it must not supply game tactics. Cold does not disable programming, documentation, Jev, or any policy tool.

The initial configurable engineering default is a maximum of **3 strategic calls or 60 seconds elapsed, whichever comes first**. This is a reliability bound, not measured sufficiency, a user-imposed threshold, or a financial cap. Count a new strategic decision as one logical call; retain every provider attempt and retry separately. Retries do not reset the elapsed cap. A request still pending at expiration cannot extend bootstrap or activate a late result without the normal runtime admission rules.

A warm snapshot may contain a model-authored startup bundle naming exact compatible policy versions, task/profile applicability, and required capabilities. The host checks source hashes, compatibility, isolation, and present applicability, then rehydrates eligible entries through the ordinary fenced activation path. Reuse cached validation only when source, runtime, isolation, adapter, profile/version/configuration fingerprint, interface/schema, and relevant server permissions/configuration match; otherwise reassess compatibility, revalidate, and record the result. Already evidenced tactics need not be regenerated or retrialed merely because the process restarted under unchanged conditions. Activation permits no effects until current observations and preconditions allow them.

Startup context contains a bounded index, selected bundle, and summaries; unselected programs stay behind selective `experience.search`/`experience.get` retrieval. The bundle selection was authored by the model, not by a handwritten tactical runtime rule. A compatible bundle can activate with **zero strategic authoring calls**. Missing or inapplicable entries visibly use normal bootstrap, with no silently swapped library or developer fallback.

A cold run starts with an empty inherited library and may create candidates within the same allowance. Warm may inspect, select, or revise inherited artifacts. Per-model allowances may be calibrated in practice, then frozen equally across matched arms; three calls/60 seconds is not a universal adequacy claim. Log snapshot/bundle identities, actual logical calls and provider attempts, retrievals, validation/cache decisions, rehydration, activation, first effect, rejected entries, and elapsed time. Validation failures and retries do not restart the allowance. If no usable runtime-valid policy exists at expiration, gameplay starts visibly with no policies.

### Runtime validity is not behavioral success

Use the lifecycle defined in the [runtime contracts](runtime-contracts.md): `draft`, `validated`, `trial`, `active`, `quarantined`, and `retired`.

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
- The full `observation_profile_config` and `observation_profile_fingerprint`, plus `observation_interface` for structured/image interface identity. Record radii, occlusion rules, sound coarsening, sampling/candidate/output bounds, private navigation geometry projection/envelope, and authorized-goal/higher-route rules using the canonical [runtime profile](runtime-contracts.md#player-observable-structured-profile-v1), without substituting a profile label for its effective settings.
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

The numerical defaults below are **chosen initial engineering targets and measurement settings**. They are neither measured results nor user-mandated thresholds. Freeze them before comparison or held-out play. If practice reveals a poor setting, revise it openly and start a new measurement series; do not tune it after seeing held-out outcomes.

### Clocks and attribution

Use canonical event fields from the [runtime contracts](runtime-contracts.md): UTC `wall_time` for chronology and process/epoch-local `monotonic_ms` for elapsed durations. Never subtract monotonic readings from different processes or boots. Correlate cross-process spans through trusted backend receipt/dispatch events; label estimates and missing spans. Preserve `run_id`, `world_id`, `epoch`, `event_seq`, and relevant action/policy versions in the evidence.

| Metric | Start and end | Reporting rule |
| --- | --- | --- |
| Startup elapsed | Accepted start request to connected, observed, control-ready player session immediately before bootstrap | Include actual launch/connect/setup delay; identify already-running services and exclude one-time installation from this metric |
| Bootstrap elapsed | Entry into `bootstrapping` to entry into gameplay `running` | Include inference, validation, and any idle within the bootstrap allowance; report calls and attempts alongside time |
| Time to gameplay | Accepted start request to first gameplay `running` | Startup plus bootstrap and any intervening lifecycle delay; do not double-count these intervals |
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
- Tokens and other metered usage as reported, known monetary cost and its price source/date, and unknown-cost usage explicitly. Subscription access or missing pricing is not evidence that a request is free. Bootstrap, concurrency, retries, and deadlines are reliability controls, separate from monetary accounting.
- Policy versions created, tested, activated, rejected, quarantined, or rolled back, plus actual backend availability and use.
- Human interventions, infrastructure failures, downtime, recovery epochs, environment restoration branches where supported, and missing evidence.

Report counts, sample sizes, medians and ranges for run-level measures. For per-call latency also give p50/p95 with sample counts; label sparse percentiles as descriptive. Do not merge retry attempts with logical decisions or sum overlapping spans into total wall time.

### Observation pipeline performance

Measure perception independently of LLM inference. Use the named initial preset in the [Minecraft observation contract](runtime-contracts.md#player-observable-structured-profile-v1), materialize every effective default, and retain its configuration fingerprint with each result. The preset is an implementation starting point, not evidence that the selected workload fits its budgets.

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

If the initial preset misses its operating goals, retain the results, change an explicit preset revision/configuration, and rerun the same cases. Do not silently increase candidate caps, weaken filtering, drop slow samples, or pool results from different fingerprints. No filtering-performance measurements have been obtained by this documentation-only repository.

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

Practice and gameplay-effect experiments use fresh ordinary environments, not staged training arenas. Controlled security fixtures and synthetic/replayed event fixtures may check infrastructure correctness, such as observation filtering or stale-result rejection. They do not demonstrate tactical effectiveness, transferred learning, or end-to-end task completion, and their coordinates/tactics cannot enter reusable experience. The [structured-observation and navigation proof](operations-and-security.md#structured-observation-and-navigation) covers behind-camera/range behavior, hidden then legitimately revealed ore with Anti-Xray disabled, hidden/revealed/reconcealed entities and stale memory, legitimate coarse audio, generated-code/alternate-endpoint bypass attempts, private local navigation reads/effects, unknown-target probes, and path/error/count leakage. Keep privileged raw diagnostics evaluator-only; optionally repeat on a pinned Paper configuration with its changed raw-data expectations recorded. Video/event replay is evidence playback; deterministic environment rewind exists only if an adapter explicitly supports and establishes it.

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

Minecraft Java **1.21.4**, **Normal Survival**, one avatar, ordinary death/inventory rules, and no agent cheats/operator powers are the first integration's compatibility target. These are planned conditions, not tested compatibility claims. The only required initial observation profile is `player-observable-structured`, version 1, defined by the [runtime contracts](runtime-contracts.md#player-observable-structured-profile-v1). Information permission is independent of the structured state/event interface; future images or a `strict_visual` camera profile are optional, not first-playable requirements.

The profile permits bounded nearby unobstructed objects independent of camera yaw/pitch, own inventory/status/UI, normal F3 coordinates, public recipes/docs, and legitimate world-local memory. Runtime owns the finite configurable ranges and query/output limits; this document records their actual frozen values in manifests. Occluded resources/structures, exact live hidden entity state, seeds, saves, privileged evaluator state, raw Mineflayer/chunk/entity access, and renderer buffers cannot enter agent observations, logs, errors, retrieval, or library content. Last-seen memory remains stale while an entity is concealed; only real audible events provide approved coarse sound signals. Filter the authorized observation index before search results, counts, ordering, truncation metadata, and errors; unobserved remains unknown rather than absent.

Trusted navigation has the runtime's [bounded client-loaded geometry-only exception](runtime-contracts.md#bounded-private-navigation-geometry) for local movement and bounded local detours toward the same authorized known target/waypoint, even through collision cells not individually observed. Private geometry is separate from observation/memory, cannot identify hidden resources/entities or support global loaded-world selection of undiscovered caves, corridors, shortcuts, or exploration routes, and cannot be exposed through raw paths, maps, reachability, or diagnostics. Goals/higher routes remain based on permitted observations/memory or model-chosen bounded exploration. No strict-FOV/all-voxels-observed map is needed; discovering a new route outside local execution requires observation/replanning or neutral bounded failure. Steering/path choice/timing may benefit from the declared local geometry, so matched runs must retain the same permission without claiming human-identical perception or formal zero leakage.

Paper Anti-Xray is optional defense in depth, not a substitute for GameHarness filtering or an entity-information boundary. Filtering must work with it disabled. Server flavor/build and effective per-world/dimension configuration remain fixed and recorded as above; masked/false ores are not genuine discoveries. No Anti-Xray deployment or test result is established here.

Practice and evaluation start from fresh ordinary spawn with ordinary starting inventory. The concrete task suite is:

| Task | Verified outcome | Why retain it |
| --- | --- | --- |
| Early resource progression | Craft and retain a stone pickaxe starting at fresh spawn, without operator gifts or world edits | A bounded end-to-end task covering observation, decisions, movement, resource use, and crafting |
| Sustained progression | In a declared longer horizon, remain operational and achieve the predeclared next prerequisite milestones toward full completion | Exposes repeated decisions, useful waits, adaptation, deaths, and policy revisions beyond one craft |
| Full completion | Autonomous Ender Dragon defeat from fresh spawn, with evidence of the whole run and any interruptions | Retains a distinct long-horizon objective rather than treating an early tool as completion |

The trusted Minecraft verifier establishes these predicates from authoritative game evidence, isolated from agent observations. If the dragon is not defeated, report the furthest verified milestone, elapsed exposure, deaths, interventions, failure causes, and remaining objective. A bounded task does not substitute for the Dragon objective; workflow readiness and full-completion status must remain separately reportable.

Use evaluator-owned seed groups for practice, comparison, and held-out evaluation under the separation rules above. The initial engineering sampling setting is **3 comparison seeds and 3 fresh repetitions per seed per condition** for the early-progression task. This gives **9 cold and 9 warm attempts**; it is a small engineering comparison, not a statistical-power claim. Freeze actual seed values, order, and per-run horizon before execution. Hidden seed values may remain withheld during held-out evaluation, but retain them for later reproducibility.

A seed reproduces starting terrain, not model outputs, spawn-time scheduling, entity behavior, or every game event. Preserve the clean initial save and environment manifest for each pair. The evaluator may copy the initial ordinary spawn state; it must not stage items, mobs, prepared combat encounters, or favorable terrain. Each restored comparison copy is a new run/world lineage. Neither seed lookup nor maps from another world may enter the agent's tools, retrieval, or reusable library.

## Long-horizon evidence

Long-horizon attempts need their own predeclared multi-hour or multi-day horizon and stop conditions. Keep the initial-state identity, model/game/adapter/profile manifest, library snapshot, complete durable events/action ledger, artifact history, progress verification, and environment lineage. Retain checkpoints or saves where the adapter supports them; their absence must be explicit. Conversation summaries alone cannot establish task completion or explain a recovery gap.

Maintain a run table even when only a few long attempts are available: starts, completed objectives, cutoffs, profile-defined game failures, actual infrastructure uptime/downtime, restarts, human interventions, unknown action outcomes, and terminal status. Evidence for an autonomous completion must connect the declared initial state to verified success without concealed coaching, state edits, or unexplained gaps. For Minecraft Dragon completion, that means fresh spawn through the verified defeat event. A final-event excerpt alone is insufficient.

The planned release verification includes progressive soak, controlled disconnect/restart, cancellation and stale-response checks, and sandbox/observation-leakage checks under [operations and security](operations-and-security.md). These checks have not been exercised here. Reliability evidence establishes runtime behavior; it does not substitute for the profile's task-success evidence.

Recordings must show genuine observed behavior and identify the run, environment/profile, library snapshot, condition, timestamps, cuts, and playback speed. Preserve original events and full source recordings when publishing selected excerpts; disclose selection and do not imply highlights are typical outcomes. Label prerecorded footage explicitly. Missing or failed attempts remain in the result set, regardless of which recordings are shown.
