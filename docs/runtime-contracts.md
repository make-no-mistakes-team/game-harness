# Runtime contracts

This is the interface specification for the planned GameHarness implementation. No tools, endpoints, or records below are implemented in this repository yet. The [PRD](prds/gameharness-v1.0-prd.md) defines product acceptance; the [architecture](architecture/overview.md) assigns modules; [learning and evaluation](learning-and-evaluation.md) defines artifact evidence and measurements. [Operations and security](operations-and-security.md) specifies enforcement and recovery. [Upstream reuse](upstream-reuse.md) distinguishes reusable OMP interfaces from project work.

## Ownership and vocabulary

The trusted runtime owns scheduling, authorization, persistence, and the action ledger. A trusted GameAdapter owns game connection, observation filtering and effect admission. A generated program can propose actions through filtered capabilities; it cannot mutate the game directly. Strategic inference, action execution, and reactive evaluation proceed independently. A long action never holds a strategic model turn open. Minecraft is the first planned complete integration; no game adapter is implemented in this repository yet.

| Term | Contract |
|---|---|
| Run | One recorded attempt with a task, selected strategic model, world, initial library snapshot, and intervention history. Infrastructure recovery continues that run. |
| World | An environment lineage: a game world, level or session whose state and remembered facts share continuity. `world_id` remains the canonical identifier. Replacing the environment creates a new lineage; restoring an older checkpoint records a rollback branch within that lineage. |
| Epoch | A durable fencing generation within a run. Recovery, reconnect, or world reset advances it before new effects are admitted. |
| Observation | A filtered profile-authorized view with capture time and provenance. An observation is evidence, not permission to inspect hidden state. |
| Action | A bounded executor job with one stable identifier, explicit parameters, deadline, preconditions, and a recorded outcome. |
| Lease | Exclusive authority to issue foreground effects for the controlled actor/session, called the avatar here. There is at most one effectful foreground lease. |
| Skill | An LLM-authored long-running program that can submit bounded actions and consume feedback. It does not own the lease continuously. |
| Policy / reflex | A short LLM-authored reaction rule, implemented as isolated JavaScript or a declarative fast-model configuration. It proposes a scheduler decision. |
| Knowledge | Evidence-backed remembered facts or abstractions. It is separate from executable skills and policies. |
| Validation | Checks that an artifact is well-formed and can run within its declared capabilities and isolation limits. It does not establish gameplay effectiveness. |
| Trial | Bounded gameplay use of a validated candidate, with actual outcomes recorded. All normal security and scheduling rules apply. |
| Strategic turn | One serialized strategic decision, including its tool rounds, bounded context batch and durable outcome. There is never more than one strategic request in flight for the run. |
| Improvement opportunity | A durable, deduplicated request for the strategist to consider a change, linked to observed evidence rather than a runtime-authored tactic. |

No module supplies handwritten game strategy. An adapter exposes bounded mechanics with explicit agent-selected parameters, not developer-authored task solutions. Skills, strategies and reactive conditions originate from the model. Game-specific examples and the first integration's permitted mechanics appear below.

## GameAdapter descriptor and interface

The core handles typed envelopes, scheduling and authorization. Domain payloads remain opaque to core policy and scheduling logic: the adapter declares their schemas and performs domain validation. Payloads must be bounded serializable data, never raw engine objects or callbacks. Supporting another game changes its adapter, schemas, renderer and verifier; it must not require another scheduler or a game-specific branch in core policies.

| Descriptor field | Required declaration |
|---|---|
| `game_id`, `game_version` | Stable game identity and the supported game/protocol version or explicit compatibility range. |
| `adapter_id`, `adapter_version` | Stable adapter identity and immutable implementation version. The manifest pins the actual selected version. |
| `observation_profiles` | Supported `observation_profile_id` / `observation_profile_version` pairs, supported observation interfaces, `observation_schema_id` / `observation_schema_version`, schema hash, permission rules, configuration/bounds, freshness/reference semantics and dependency-token definitions. Declare any controller-only information permission separately from agent-visible payloads. |
| `capabilities` | Entries with `capability_id` and `capability_version`, argument/result schemas and hashes, permission requirements, effect/read-only classification, mandatory preconditions/dependencies, units/limits, duration bounds, completion evidence and cancellation guarantees. No action name is mandatory across games. |
| `live_view` | Supported or unsupported; for a supported view, declared source/transport, viewpoint, availability/staleness signals and authorization boundary. Renderer backing state is never an agent capability by implication. |
| `task_verifiers` | Supported task/schema identifiers, verifier versions, result/evidence schemas, evidence authority and whether privileged state is needed. Unsupported objectives remain unverified, not successful. |
| `lifecycle_support` | Connect/disconnect, effect fencing, cancellation, neutralization and recovery procedures, including what authoritative reobservation can establish. |
| `state_support` | Independent support declarations for checkpoint, reset, restore and world pause, with their exact consistency, lineage, operator and recovery requirements. |

A state operation declares `unsupported`, `operator_assisted`, or `adapter_managed`. An unsupported operation fails explicitly without pretending to create a recoverable snapshot. An operator-assisted operation returns pending status until attributed operator action and confirmation evidence exist. An adapter-managed operation returns completion evidence only after its declared protocol succeeds. Checkpoint support does not imply reset, restore, deterministic replay or world pause support. A declaration also distinguishes an agent-runtime checkpoint from an actual game-state checkpoint.

Effect capabilities declare cancellation as either `acknowledged_neutralization` or `fence_or_disconnect_required`. The first requires positive evidence that no further effects can be emitted, with any earlier partial effects recorded. The second requires the adapter's documented emitter fence/termination and recovery procedure before lease transfer. Both declare finite cancellation deadlines and their worst-case remaining effect window. Neither promises reversal of effects. A capability that cannot be safely bounded, neutralized or fenced cannot be admitted.

| Adapter operation | Contract |
|---|---|
| `connect` | Bind the selected game/profile and run/world/epoch to an authenticated trusted session. Return session/capability status and authoritative environment identity; start closed to effects. A reconnect cannot revive old leases. |
| `observe` | Return only the selected profile's authorized payload plus the common observation envelope. Bounded field selection cannot widen permissions. |
| `effect` | Receive an authorized capability invocation and lease fence; check scope, deadline and mandatory domain preconditions immediately before effects. Return execution evidence through the action ledger. |
| `cancel` | Request cancellation and later report neutralization or the required fence/recovery outcome. Receipt acknowledgement is distinct from safe completion. |
| `verify` | Evaluate a declared task using its separate evidence authority. Agent-visible progress must pass the observation profile; privileged verification records cannot enter planner or reusable-memory inputs. |
| `checkpoint`, `reset`, `restore` | Optional according to independent support declarations. Return explicit unsupported/pending/completed/failed operation status with consistency and lineage evidence. Reset/restore close admission, advance epoch and reconcile memory before any new effects. |

The runtime's cancellation request, action state and run lifecycle stay identical for every adapter. An adapter cannot reinterpret `cancelled` as “a stop message was sent,” weaken stale-response gates, or keep an old emitter alive while issuing a new lease.

### Run manifests and compatibility

Before bootstrap, a run manifest fixes `game_id`, `game_version`, `adapter_id`, `adapter_version`, selected observation profile/schema identities and versions, descriptor/schema hashes, enabled capability versions, verifier identity, state-support declarations, run/world/epoch, task, model/connection references, configuration and immutable library snapshot. Capture the actual negotiated support, not just a library's advertised features. Reconnection verifies these identities; an incompatible change requires an explicit migration/new attempt rather than silent continuation.

The manifest records `observation_profile_id`, `observation_profile_version`, full `observation_profile_config` and its `observation_profile_fingerprint`, plus `observation_interface`, `observation_schema_id`, `observation_schema_version` and schema hash. Information permissions and the observation interface are separate: structured state/events and future images are delivery choices, not evidence of fairness. The profile declares permitted facts and any private controller information; a structured interface still needs enforcement.

Knowledge, skills, policies and serializable state carry compatible game/adapter versions, observation profile/schema identities, profile configuration fingerprint, required capability versions and state schema alongside source provenance. World-local knowledge also carries `world_id` and rollback-branch provenance. Domain knowledge uses adapter-declared schemas, not universal block/entity/recipe fields. Cross-world abstractions can transfer only when declared compatible; a location or environment-specific handle cannot become generic experience. Core checks declarations and hashes; trusted adapter validators check domain payloads. A mismatch rejects selection/activation with evidence.

Freeze profile permissions/configuration, interface/schema, adapter/game versions and relevant server configuration across cold/warm and policy-capability comparisons. A profile or configuration change invalidates incompatible cached validation and artifact applicability; old strict-camera-profile evidence cannot be relabelled as evidence for the new profile. There are no historical gameplay results here to migrate.

## Identity, ordering, and time

All serialized records use `schema_version` and snake_case fields. IDs are opaque strings generated by the trusted runtime or accepted as caller idempotency keys; examples are illustrative. Their spelling must not encode secrets, seeds, or filesystem paths.

| Field | Meaning and invariant |
|---|---|
| `run_id`, `world_id` | Stable run and world-lineage identifiers. Neither authorizes access by itself. |
| `game_id`, `adapter_id`, `adapter_version` | Selected domain and trusted integration identity, pinned in the run manifest and referenced by observations/actions/artifacts. |
| `observation_profile_id`, `observation_profile_version` | Selected permission/profile identity; paired with the observation schema identity/version and hash. A broader profile is not a silent schema upgrade. |
| `epoch` | Persisted nonnegative integer, increased before activating a recovered adapter/session. Requests carry it; adapter effect admission checks it. |
| `event_seq` | Durable strictly increasing sequence per run, including across epochs. Gaps are permitted; reuse or reversal is not. |
| `observation_seq` | Increasing within an epoch; identifies the filtered snapshot on which a decision was based. Compare it together with run/world/epoch. |
| `action_id` | Stable idempotency key for submission and subsequent status/cancellation. Reusing it with different action content is a conflict. |
| `start_key` | Caller-stable idempotency key for one logical skill start, scoped to `run_id` and retained across retries, recovery epochs, and conversation compaction. |
| `execution_id` | Durable skill-execution identity allocated once at admission and returned for every matching start retry. Distinct from worker generations and child `action_id` values. |
| `turn_id`, `strategic_generation` | Durable strategic-turn identity and revocable generation. Task changes, pause, stop and recovery invalidate obsolete output without erasing its evidence. |
| `opportunity_id`, `trial_id` | Durable improvement and bounded-trial identities; link triggers, model decisions, exact candidate versions and outcome evidence. |
| `mutation_key`, `promotion_id` | Caller-stable experience-mutation key and durable promotion proposal/result identity. Neither authorizes a new effect or changes a selected snapshot. |
| `policy_id`, `policy_version` | Stable policy lineage and immutable positive-integer version. Updating source/configuration creates a new version. |
| `lease_generation` | Increasing executor fence within an epoch. A revoked generation cannot emit further effects. |
| `evaluation_id` | Correlates one policy evaluation with its input, selected version, deadline, and result or rejection. |
| `wall_time` | UTC timestamp for human correlation; never trusted as an effect-freshness clock. |
| `monotonic_ms` | Elapsed time within the identified process/epoch only. Never subtract values from different processes or boots. |

Backend-to-adapter requests include the selected manifest identity, run/world/epoch and current lease generation. On reconnect, the adapter starts closed to effects, binds the newly authorized session, and rejects queued messages from old connections. A backend crash or restart cannot revive a previous lease. Old callbacks may add historical diagnostic evidence only; they cannot alter the current action or issue effects.

Durable events wrap a versioned payload:

```json
{
  "schema_version": 1,
  "run_id": "run_example",
  "world_id": "world_example",
  "epoch": 3,
  "event_seq": 418,
  "wall_time": "2026-10-20T12:00:00Z",
  "monotonic_ms": 9320,
  "process_id": "backend_instance_example",
  "event_type": "action.state_changed",
  "payload": {
    "action_id": "action_example",
    "previous_state": "running",
    "state": "cancel_requested",
    "reason_code": "operator_pause"
  }
}
```

This example is documentary data, not an observed event. State mutation and its durable event must commit together. High-rate viewer frames use the renderer's own transport, not the durable event ledger.

## Observation interface

`observation.read` returns a bounded filtered snapshot or delta. A caller may select supported fields and a maximum age; it cannot request a broader authority. The selected adapter profile defines information permission for that game and supplies a domain payload validated against its declared schema. Core requires no position, health, blocks, entities, inventory or recipes. Previously observed facts may be returned as memory, explicitly marked with their last legitimate observation.

| Observation content | Required representation |
|---|---|
| Identity and timing | Manifest/game/adapter/profile/schema identity, run/world/epoch, observation sequence, capture time and local age, envelope schema version. |
| Domain payload | Bounded adapter-declared snapshot/delta data. Profile rules specify which current state may be exposed and how each field's provenance is represented. |
| Unknown information | Explicit unknown/unobserved semantics defined by the profile. Omitted records do not establish absence unless the profile explicitly supplies authorized completeness evidence. |
| Remembered facts | World identifier, original observation references, last-seen time, and uncertainty. They cannot masquerade as current visibility. |
| Relevant revisions | Trusted revision tokens for capability-declared dependencies, with meaning and invalidation rules supplied by the adapter. Generated content cannot forge them or omit mandatory dependencies. |

Domain references expire with their epoch and profile-defined visibility/validity semantics; legitimate rediscovery can assign a new reference. Remembered facts do not grant a current effect handle. Every effect rechecks its declared present-time domain constraints at the adapter gate. Mechanics and navigation must respect the selected profile's agent-facing and controller-only permissions, including internal helper libraries, errors and result timing. A declared private controller permission does not authorize returning its inputs to the agent.

Filter before exposing counts, ranking/order, cursors, pagination/truncation metadata or error details. Omitted/unobserved records mean unknown, not absent. Agent-facing searches operate on an authorized observation index; raw candidate discovery is internal adapter work. A raw type-specific search capped at `k` candidates followed by filtering is not automatically a safe or complete search: hidden matches must not determine visible omissions or metadata.

Human viewing is a separate permission. Renderer buffers, routes, protocol objects and screenshots are not an alternate agent observation interface. An agent image capability requires its own explicitly authorized profile; a human live view does not grant it.

## Tools and error results

These are chosen interface names for implementation, not existing OMP tools. All inputs pass runtime schema validation and capability authorization. Tools return structured errors with `code`, safe `message`, `retryable`, and relevant IDs; they never expose raw game-engine objects, credentials, host stack dumps, or forbidden environment facts. Expected codes include `invalid_request`, `unauthorized`, `not_found`, `stale_epoch`, `stale_context`, `precondition_failed`, `conflict`, `busy`, `deadline_exceeded`, `backend_unavailable`, `unsupported`, and `unknown_effect`. A retryable error is permission to reconsider within a bounded retry policy, not an instruction to repeat an effect blindly.

| Interface | Input / immediate result | Effect authority |
|---|---|---|
| `capabilities.read` | Versioned tools, parameter limits, model/backend availability, observation restrictions, current reliability limits, safe auth status. | Read-only. |
| `observation.read` | Field selection and maximum age; filtered snapshot/delta with provenance. | Read-only. |
| `action.submit` | Stable action ID, scope, adapter-declared effect capability, parameters, priority, deadline, basis and preconditions; returns accepted record or rejection promptly. | Admission only; executor later acquires lease. |
| `action.get` | Action ID; current ledger state, known partial effects, outcome evidence. | Read-only. |
| `action.cancel` | Action ID and reason; returns durable cancellation-request acknowledgement or current terminal record. | Requests neutralization; acknowledgement alone is not completion. |
| `skill.register` | Source artifact, content hash, metadata, capability declaration, compatibility, provenance; returns immutable candidate/version and validation result. | No gameplay effect during registration. |
| `skill.start` | Caller-stable `start_key`, run/world/manifest scope, compatible validated skill version, arguments, finite execution limits and admission preconditions; optional linked improvement `trial` descriptor. Returns the durably admitted execution record promptly, including `trial_id` when applicable. Matching retries return the original `execution_id` and current status. | Admission occurs once per run/key before worker dispatch; a retry never launches another execution. |
| `skill.get` | `run_id` and exactly one of `start_key` or `execution_id`; returns the durable admission record, current status, child action references and closure/uncertainty evidence, or `not_found`. | Read-only authorized lookup; never starts or resumes work. |
| `skill.cancel` | Execution ID and reason; returns cancellation-request acknowledgement, then execution closure evidence. | Fences new child submissions and cancels outstanding child actions; closure waits for safe neutralization or recovery. |
| `policy.register` | JS artifact or typed AI configuration, immutable metadata and provenance; returns draft version. | No activation. |
| `policy.validate` | Candidate/version; validation report or quarantine evidence. | Isolated checks only; no unrestricted gameplay authority. |
| `policy.activate` | `run_id`, `epoch`, exact compatible version, expected current run-selected version, optional linked improvement `trial` descriptor or existing `trial_id`; returns pending switch acknowledgement, `trial_id` when applicable and later switch event. | Run-local switch at a scheduler boundary only. Warm-bundle reuse must pass the separate eligibility gate below. |
| `policy.retire` | Version and reason; retires at a fenced boundary and revokes outstanding evaluations. | No hidden world rollback. |
| `feedback.read` | Bounded event/metric cursor and filters; source-linked runtime and gameplay outcomes. | Read-only. |
| `experience.search` | Bounded query and compatibility filters; paginated metadata, StrategyCard and performance summaries with exact refs. | Read-only selected-library/current-run scope. |
| `experience.get` | Exact immutable artifact/card/source/evidence/bundle ref and pagination bounds; returns only the requested authorized content. | Read-only; no privileged evaluator inputs. |
| `experience.saveKnowledge` | Stable `mutation_key`, versioned knowledge content, provenance, confidence, scope and evidence refs; returns durable entry/version or rejection. | Appends run-private knowledge; does not export it automatically. |
| `experience.proposePromotion` | Stable `mutation_key`, exact artifact set or startup bundle, target model/library lineage and evidence refs; returns durable proposal/result. | Trusted eligibility gate may create a new immutable library snapshot, never change the current run's selected snapshot. |
| `experience.getPerformanceHistory` | Exact artifact/version or trial ref, bounded filters and cursor; actual invocation/trial outcomes including failures and unknowns. | Read-only authorized history. |
| `docs.retrieve`, `web.retrieve` | Public documentation query/URL through trusted retrieval broker; bounded attributed text. | No worker network or local-resource access. |

The strategic model uses these tools without waiting for an action to finish. `skill.start` and `skill.cancel` are the only skill-execution path: a skill has a separate `execution_id` and does not acquire a foreground lease itself. Each child effect is submitted through `action.submit` under its own `action_id`, linked to that execution. This prevents a parent skill from holding the lease that its children need.

Program revision cancels the previous execution through the same action/lease rules and starts an explicit new immutable version under a new `start_key`; an in-flight program is never mutated in place. Stopping a skill prevents new child submissions, cancels its outstanding child actions, and waits for confirmed neutralization or enters recovery. Per-execution limits cover elapsed time, steps, child submissions and concurrent outstanding work. Authorized checkpoint recovery creates a new fenced worker generation under the existing `execution_id`, after reconciling child effects; it does not reset execution limits or replay the skill from its beginning.

### Idempotent skill admission and lost acknowledgements

The caller creates and retains `start_key` before sending a logical start. Transport retries, model-tool delivery retries, and lookup after an uncertain response reuse that key; a newly generated provider tool-call identifier is not a substitute. The runtime enforces durable uniqueness of `(run_id, start_key)`. In one transaction it stores the key, canonical original request and its fingerprint, one `execution_id`, admission status, and admission event. No worker dispatch or child action is allowed before that transaction commits.

After authenticating the caller's run scope, an existing key is compared with its original request. Identical content returns the original execution record without new dispatch, even if the first response was lost, the execution has finished, or recovery advanced the epoch. Different skill/version, arguments, limits, scope, or admission preconditions return `conflict`; they do not amend the original request. This historical lookup grants no current effect authority. A missing key must pass current epoch, lifecycle, compatibility, and precondition checks before new admission. An old-epoch request with no committed admission is rejected rather than dispatched after recovery.

After a lost response, the caller uses `skill.get` with the same run/key or resends the unchanged start request. Concurrent matching starts converge on the same committed record. A crash before commit leaves no admitted execution and no dispatched work; a crash after commit leaves a discoverable admission for recovery. Recovery fences any previous worker generation and reconciles its children before deciding whether work can continue. Repeating `skill.start` itself never resumes, restarts, or extends an execution.

Retain start-key mappings for the lifetime of the durable run record, including terminal executions and compacted conversation history. If that record is retired or deleted, the old run must reject starts rather than accepting a forgotten key as new work. A deliberate fresh execution requires a new key and normal admission; it cannot bypass unresolved prior effects or the foreground lease.

| Admission scenario | Required result |
|---|---|
| Committed start, acknowledgement lost | Lookup/retry returns the original execution; no second worker generation or child-action tree is created by the retry. |
| Concurrent identical starts | One durable admission and one execution identity; both callers observe that record. |
| Same key, different request | `conflict`, with no new execution or change to the admitted one. |
| Crash before admission commit | No execution is dispatched; any later admission still requires a current valid request. |
| Crash after admission commit, before or after dispatch | Original identity remains discoverable. Only fenced recovery can continue it after reconciling possible child effects. |

### Selective experience interface

Every experience call is authenticated to `run_id`; the server derives the pinned model, game/adapter/profile, capability versions, selected `library_snapshot_id` and current run-private branch from its manifest. Caller filters can narrow that scope, not select sibling runs, comparison arms, another model's library or an unrestricted database. Shared source bytes do not grant access to other runs' evidence. Exact refs include a `ref_kind` and immutable identity: artifact ID/version/source hash, card ID/version, bundle ID/version, knowledge ID/version, or authorized evidence record ID. The learning protocol owns the [required StrategyCard schema](learning-and-evaluation.md#human-readable-strategy-artifacts) and [promotion evidence rules](learning-and-evaluation.md#selective-retrieval-and-autonomous-promotion).

| Tool | Required input fields and bounded result |
|---|---|
| `experience.search` | `run_id`, `query`, optional `kinds`, `artifact_ids`, `tags`, `cursor`, `limit`. Lexical/metadata ranking is sufficient. Return `status`, `items`, `next_cursor`, `scope_ref`; each item has exact refs, compatibility, bounded purpose/applicability/limitations and measured-or-unknown outcome summaries with sample sizes/evidence refs. Do not include all source programs. |
| `experience.get` | `run_id`, `ref`, optional `cursor`, `limit`, `max_bytes`. Return the exact requested immutable content/hash, provenance and `next_cursor`; never substitute a newer or unrelated version. Source and evidence are fetched on demand, not injected by search. |
| `experience.saveKnowledge` | `run_id`, `epoch`, `mutation_key`, `content`, `provenance`, `confidence`, `scope`, `evidence_refs`, compatibility and optional exact `parent_ref`. `scope` declares run/world/portable intent; portable intent does not establish promotion eligibility. Return `status`, `knowledge_ref`, `mutation_key`, reason/evidence refs. Corrections append a version rather than rewriting evidence. |
| `experience.proposePromotion` | `run_id`, `epoch`, `mutation_key`, `artifact_refs`, optional exact `startup_bundle_ref` or model-authored `startup_bundle` content (not both), `target_library_id`, `base_snapshot_id`, `evidence_refs`, `rationale`. Persist new bundle content as an immutable bundle version with runtime-assigned identity/hash linked to this proposal. Return `promotion_id`, `status` (`proposed`, `accepted`, `rejected`, `deferred`), `bundle_ref` when supplied, `snapshot_ref` when accepted, and structured `reason_codes`/evidence refs. The exact compatible dependency closure is part of the proposal. |
| `experience.getPerformanceHistory` | `run_id`, exact `artifact_ref` or `trial_id`, optional outcome/context/time filters, `cursor`, `limit`. Return actual records with invocation/trial IDs, context, bounds, attempts, failures/unknowns, source refs and aggregate sample sizes. Empty history means unmeasured, not successful. |

Read results use `status: ok`, `empty`, or `compatible_not_found` as applicable; pagination never widens scope. Invalid or incompatible exact refs return `not_found` or `incompatible`, not a “close enough” program. `rejected` and `deferred` are durable domain outcomes with reasons, not silent empty success. Source/evidence reads apply the same observation and provenance filtering as live tools; raw privileged verifier data is never returned.

Experience mutations use durable uniqueness of `(run_id, tool_name, mutation_key)`. The caller retains the key before sending. Store the canonical request/fingerprint and proposal or knowledge-version outcome before acknowledging; matching retries return the original identity/current outcome, including after recovery or a lost acknowledgement. Different content returns `conflict`. Historical matching lookup grants no new authority; a missing key requires current epoch and authorization. Retain mappings with the run record and reject writes to retired runs rather than forgetting keys and duplicating versions. Snapshot creation and its accepted proposal result commit atomically. A deferred proposal is reevaluated under the same `promotion_id`, without creating another snapshot on a retry.

The model proposes promotion; the trusted gate applies the learning protocol's eligibility conditions and returns explicit reasons. Eligible proposals need no human approval. During a sealed comparison, record the proposal as `deferred` until batch closure; no arm can retrieve another arm's new artifacts. Acceptance creates a new immutable per-model snapshot for future selection, not an update to an existing snapshot, current activation pointers, or the current run's retrieval scope. No static validator or model self-rating substitutes for the required real evidence.

### Strategic Turn Scheduler

The Strategic Turn Scheduler is an internal trusted-backend module driving the existing single strategic agent. It consumes durable signals, selects a bounded context batch and starts a turn automatically. It is not an additional agent or service. Game execution, local policies and Jev continue independently while inference runs, subject to the existing lease and freshness gates.

| Wake reason | Eligibility |
|---|---|
| `bootstrap` | Start admitted; warm hydration results and current permitted observations are available. |
| `task_changed` | Attributed task change has fenced prior strategic work. |
| `work_decision_needed` | An action/skill completed or failed and no already-authorized skill/queue determines the next permitted step. Completion alone does not force a prompt. |
| `policy_replan` | A valid policy requests a strategic decision with source evidence. |
| `recovery_completed` | Reconciliation permits decisions; old epoch work remains fenced. |
| `no_runnable_work` | No authorized work or meaningful wait can proceed without a decision. A continuing empty queue is not a fresh signal every tick. |
| `improvement_due` | A pending opportunity or bounded trial reaches its next eligible delivery/decision boundary. |

Persist scheduler `state` (`waiting`, `coalescing`, `in_flight`, `backoff`, `suspended`, `terminal`), `consumed_event_seq`, pending wake reasons/source refs, `turn_id`, `strategic_generation`, selected `context_through_event_seq`, attempt count, `consecutive_empty_turns` and any `next_eligible_at`/wait condition. `suspended` follows pause/recovery admission fences; `terminal` follows terminal run state. A successful turn records its decisions and advances the selected cursor in one durable commit. Events arriving after that selection remain pending. Cursor consumption does not erase unresolved opportunities or imply that an effect completed.

Signals within the coalescing window merge by reason/target. If a turn is in flight, signals join the next boundary; they never launch a concurrent prompt. A batch records its exact event interval, filtered observation basis, selected opportunity IDs, compatible experience summaries and truncation/pagination refs. Bounded context never means silently dropping an unconsumed interval. Drain a durable backlog in finite batches; coalesce redundant reasons, and retain source ranges for later reads. Do not poll the LLM on observations/ticks.

Pause, stop, attributed task change and recovery revoke the strategic generation and request provider cancellation where supported. A replacement strategic request waits until the old broker request completes, confirms cancellation or reaches its finite deadline; revocation does not permit concurrent strategic requests. Late output remains attached to its original turn and is rejected as obsolete; any already-admitted skill/action retains its durable identity and follows normal cancellation/recovery. A recovered unfinished turn is reconciled before retry: do not replay acknowledged mutations or effects under fresh keys. Stable `start_key`, action IDs and experience `mutation_key` survive retries and compaction.

An unhandled provider/tool-transport failure that prevents a valid turn outcome, or a missing required opportunity decision, leaves the selected cursor unconsumed. An ordinary tool rejection or failed game action that the model processes and responds to is outcome evidence, not an automatic failure of the whole turn. Retry only retryable turn failures within the configured finite attempt policy, with backoff. Exhaustion records an explicit external waiting condition (`provider_available`, new task/evidence, or operator intervention), not an immediate new `no_runnable_work` prompt.

A successful turn with neither runnable work nor a declared meaningful wait increments `consecutive_empty_turns` and arms one cooldown timer. Its expiry supplies an automatic `no_runnable_work` wake with the empty-turn evidence; no unrelated game event or human prompt is required. At the configured consecutive-empty limit, record `planning_stalled` and follow normal safe failure closure instead of waiting forever or repeatedly starting another allowance. Admitted work, a validated meaningful wait, or an attributed new task resets the counter; another empty response or retry does not. A declared meaningful wait has an observable condition and a finite deadline: satisfaction or expiry wakes the scheduler once. Repeated empty output cannot create a tight call loop, and quiet game state cannot strand an unfinished planning obligation. Reliability limits and safety deadlines are not dollar caps.

#### Autonomous Improvement Loop

The Autonomous Improvement Loop is another internal module of the same backend. It derives game-neutral opportunities from permitted timing/capability/error evidence and delivers them at the next eligible strategic turn; the strategist need not call `feedback.read` first. Runtime logic detects repetition and reports facts. It never chooses a game tactic or launches a second strategic model.

An opportunity records `opportunity_id`, `run_id`, `epoch`, `reason_code`, exact `artifact_refs` where present, `evidence_window_id`, `window_start_event_seq`, `window_end_event_seq`, `evidence_refs`, counts/timings/unknowns, `state`, `next_eligible_at`, delivery/decision turn refs and optional `trial_id`. Its deduplication key is `(run_id, epoch, reason_code, artifact_refs, evidence_window_id)`. Repeated evidence in that window updates the same opportunity. Capability sequences use ordered capability IDs/versions, never adapter-specific tactical labels; pattern/sequence signatures are part of the generic `reason_code` identity so unrelated patterns do not merge.

The following table is the canonical chosen initial configuration, not measured behavior or a claim of sufficient tuning. Freeze actual values in the run manifest; per-model settings are allowed and must be identical across matched comparison arms.

| Configuration field | Initial default |
|---|---|
| `strategic_coalesce_ms` | `100` |
| `strategic_max_wake_reasons`, `strategic_context_event_limit` | `32`, `64`; additional source intervals remain durably pending |
| `strategic_max_attempts`, `strategic_retry_backoff_ms` | `3` actual attempts for one provider request; retry delays `[1000, 5000]` |
| `strategic_turn_max_calls`, `strategic_turn_max_ms` | `12` actual provider invocations including retries/tool continuations, `120000` ms per turn; neither limit resets on a failed response |
| `strategic_empty_turn_cooldown_ms`, `strategic_max_empty_turns` | `5000`, `3`; one automatic continuation per cooldown, then explicit `planning_stalled` failure if still empty |
| `improvement_window_ms` | `120000`; fixed run/epoch windows, with event-range evidence |
| `improvement_llm_gap_count`, `improvement_llm_gap_min_ms` | `3` gaps each at least `1000` ms in the window |
| `improvement_pattern_count` | `3` occurrences of the same capability/error code or interruption pattern in the window |
| `improvement_sequence_count`, `improvement_sequence_length` | `3` occurrences of an ordered sequence of `2–4` capability invocations in the window |
| `improvement_boundary_evidence_count` | `5` new relevant invocation/outcome records since the last acknowledged task/skill-boundary opportunity |
| `improvement_delivery_cooldown_ms`, `improvement_default_defer_ms` | `30000`, `30000`; genuinely new urgent safety facts use normal safety handling, not this throttle |
| `improvement_pending_limit`, `improvement_max_active_trials` | `32` pending opportunities, `1` active improvement trial per run |
| `improvement_trial_max_ms`, `improvement_trial_max_actions`, `improvement_trial_max_evaluations` | `120000`, `20`, `100`; first reached ends the trial; model may select lower bounds |
| `experience_default_limit`, `experience_max_limit`, `experience_max_bytes` | `10`, `50`, `65536` per response; `max_bytes` can only lower the bound |
| `bootstrap_max_strategic_calls`, `bootstrap_max_ms` | `3` logical inference calls, `60000` ms in the bootstrap phase; one allowance per run, with actual provider attempts also recorded |

Triggers are repeated LLM-induced gaps; repeated capability/error or interruption patterns; repeated short capability sequences; a task/skill boundary with accumulated evidence; and a trial reaching its decision point. Count sequences as nonoverlapping occurrences in the contiguous ordered invocation stream. Missing timing classification stays unknown, not an invented LLM gap. The delivery cooldown applies per run to new analysis opportunities; a trial decision already due is not held behind that cooldown. Pattern detection and retrieval run in bounded batches outside the foreground effect path; gameplay is not paused for analysis. If pending capacity is full, retain the unprocessed detector cursor/source interval and record pressure; drain it as slots become available rather than dropping opportunities or prompting repeatedly.

Opportunity states are `pending`, `offered`, `in_trial`, `deferred`, `resolved`, `rejected`, or `superseded`. Delivery records `offered` and its `turn_id`; it is not acknowledgement. The strategic turn must return an `opportunity_decisions` entry for each offered ID: `decision` (`reuse`, `trial`, `keep`, `revise`, `retire`, `revert`, `defer`, `reject`), `reason`, `evidence_refs`, exact relevant artifact refs, and `trial_id` or `defer_until` when applicable. Retrieval through experience tools supports reuse; authoring/revision uses ordinary registration/validation and supplies a model-authored `hypothesis`, intended outcome/measurement refs, finite trial bounds and explicit prior-version-or-no-policy return selection. A keep/retire/revert decision cites actual trial outcomes or explicitly records missing evidence. A runtime or safety rejection is returned with reasons rather than fabricated success.

The optional `trial` descriptor on `skill.start` or `policy.activate` contains `opportunity_id`, `hypothesis`, `measurement_refs`, `max_ms`, `max_actions`, `max_evaluations`, and `return_selection` (exact compatible prior policy refs or explicit `none`). Admission allocates `trial_id` and stores its exact candidate/descriptor with the execution or switch intent before dispatch. At most one improvement trial may be open per run, including cancellation/closure pending; another returns `busy`. A matching skill-start retry returns its original trial as well as execution. A repeated activation for the same pending trial/version/expected selection returns its existing switch intent; different trial content conflicts. Host bounds cap model-requested limits, and a terminal trial ID cannot be reused to extend its allowance.

Persist acknowledgement/state changes with the turn outcome. `defer` records a finite next boundary/time and source evidence; it does not recreate the same opportunity every turn. `reject`/`resolved` consume that evidence window; only new evidence can create another. A task change or epoch transition marks obsolete opportunities `superseded` with reasons and retains their evidence. Restart restores offered-but-unacknowledged opportunities and acknowledged deferrals without rediscovering them from scratch.

One validated candidate may enter a bounded real gameplay trial without already having effectiveness evidence. Trial start durably links its hypothesis, exact source/card versions, opportunity, prior selection, measurement plan, start cursor and limits. Normal lease, cancellation, quarantine and stale-output rules apply throughout. At the first bound or declared decision point, stop new trial proposals/child submissions, fence outstanding evaluations, cancel trial skill execution through its ordinary closure handshake and restore the declared compatible prior policy selection or no policy. Record `improvement.trial_decision_due` and automatically wake the strategist to retrieve outcomes and keep, revise, retire or revert; decision-making may overlap cancellation, but new effects cannot bypass safe lease transfer. No automatic deadline extension or self-promotion is permitted. Safety quarantine remains host authority.

At that decision turn, the model also considers cross-session reuse: submit `experience.proposePromotion` for an intended reusable artifact set/startup bundle, or record an evidence-linked ineligibility, rejection or deferral reason. The trusted gate returns its durable result without requiring a human prompt or approval; a later warm run can select the resulting snapshot through its ordinary start configuration. Promotion never mutates the current run's selected snapshot. The learning protocol governs eligibility, and a before/after change alone does not establish causality.

### Action admission and outcomes

An action request records:

- Identity and scope: schema version, manifest/game/adapter/profile identity, run/world/epoch and action ID.
- Origin: strategic decision, skill execution, or policy/version/evaluation; declared capability ID/version and explicit schema-validated argument payload.
- Scheduling: bounded declared priority, submission order assigned by runtime, finite queue deadline, finite execution duration, and preemption/cancellation rules.
- Basis: observation sequence, maximum basis age, relevant revision tokens, and typed preconditions.
- Evidence: admission/start/end timestamps, lease generation, state, partial effects and result references.

Each action invokes an adapter-declared effect capability; there is no universal game-action enum. Its capability catalog defines argument/result schemas, limits, mandatory dependencies, cancellation behavior and success evidence. Callers choose tactical parameters explicitly. Limits are mechanics/reliability constraints, not developer-authored decisions about when to use them. A skill invocation is a core program-execution operation whose child effects still use this catalog.

Revising an action means cancelling it and submitting a new ID with `supersedes_action_id`; the new job waits for safe lease transfer. Submitting the same ID and identical canonical request returns its existing ledger record without redispatch. Different content under that ID returns `conflict`. Retrying a lost submission first looks up that ID. Neither deduplication nor SQLite can guarantee exactly-once game effects across a crash.

| Action state | Allowed next states / meaning |
|---|---|
| `accepted` | `running`, `cancel_requested`, `failed`. The job is durable but owns no effect lease yet. Expired or invalidated queued work fails with a reason. |
| `running` | `succeeded`, `failed`, `cancel_requested`, `unknown`. Only this state may hold an executing lease. |
| `cancel_requested` | `cancelled`, `succeeded`, `failed`, `unknown`. A completion may win the race; evidence determines the result. |
| `succeeded` | Terminal: declared completion evidence was observed. It does not prove the larger task succeeded. |
| `failed` | Terminal: known failure with partial effects recorded. Failure does not imply zero effects. |
| `cancelled` | Terminal: no more effects can be emitted by that action; controls are neutralized. Prior effects remain recorded. |
| `unknown` | Terminal uncertainty: evidence cannot establish the effect outcome or safe cancellation. Recovery fences the emitter; uncertainty remains in the ledger. |

Cancelling a queued action can move through `cancel_requested` to `cancelled` without a game effect. Cancelling a running action invokes the capability's declared neutralization or fence/recovery procedure. The next lease is unavailable until positive neutralization acknowledgement or a recovery fence has removed the old emitter. A timeout does not manufacture `cancelled`. Reobservation after a disconnect may establish current domain state, but cannot invent an exactly-once history; attach reconciliation evidence to the original `unknown` record and issue any new action under a new ID.

### Arbitration and reaction proposals

Read-only observations, strategic inference, and policy evaluation can overlap. A declared bounded composite action may coordinate multiple control channels; independent jobs cannot split channels to bypass the foreground lease.

The scheduler orders work by host stop first, then descending declared priority, then ascending durable submission order. The runtime limits the priority range and permitted priority of each capability; generated content cannot claim host authority. Pause and recovery close admission before normal arbitration. Equal-priority proposals are deterministic, and losing or redundant proposals produce recorded decisions rather than repeated interrupts.

Policies produce exactly one of `continue`, `interrupt`, `replace`, or `replan`:

| Proposal | Executor interpretation |
|---|---|
| `continue` | Leave current job unchanged. It does not extend its deadline or refresh a stale lease. |
| `interrupt` | Request cancellation of the referenced action. No replacement effect is implied. An idle target is invalid because there is no action to cancel. |
| `replace` | For an action target, cancel it and wait for safe transfer. For an idle target, skip cancellation. In either case admit the declared replacement through ordinary validation, freshness checks, and arbitration. |
| `replan` | Notify strategist with source evidence. Existing action continues unless separately cancelled or expired. |

Every proposal names its target action or explicit idle state, the observed lease generation, policy/version, evaluation ID, basis and expiration. An idle replacement checks and acquires the lease atomically: if another action has acquired it since that observation, the proposal is stale, even if the avatar has since become idle again. It cannot cancel a newly started job. Interrupt storms are limited by per-policy evaluation cadence, one in-flight evaluation per version, finite proposal/action queues, rate limits, and finite retry/deadline rules. Overload returns `busy` or skips/coalesces an evaluation with evidence. It does not postpone host stop or silently install a universal gameplay fallback.

### Freshness at dispatch

A response is eligible only when all of these hold at the final effect gate:

1. Run, world and epoch still match the authorized live session.
2. The originating policy version/execution is still authorized, and its evaluation or execution generation has not been revoked.
3. The referenced action and lease generation still match the intended job, or the declared idle precondition still holds.
4. The input age and proposal/action deadlines remain within their declared bounds, measured by the responsible process's local monotonic clock.
5. Relevant revision tokens and typed action preconditions still hold. The adapter repeats the relevant immediate domain checks before sending a game effect.

**Do not require `observation_seq` to equal the newest observation.** A Jev response based on an older observation may remain useful when unrelated observations arrived during inference. A changed domain dependency or revoked lease can invalidate it even before its age limit. Relevant dependencies are declared by the capability and checked through trusted adapter validation; if they cannot be established, the runtime rejects and requests a fresh decision. Policy authors cannot omit mandatory dependencies.

On restart, all old requests are fenced regardless of apparent timestamp freshness. Within an epoch, a broker records its own request-start monotonic time and returns trusted elapsed time; it does not compare a provider's clock with the backend's. A process restart cannot reuse another process's monotonic deadlines.

## Skills and policy artifacts

Artifact bytes are immutable and content-addressed; the trusted backend stores registry metadata and references. Registration stores JS source or declarative typed AI configuration, never only an unserializable closure. Metadata includes artifact ID/version and hash, kind, authoring model/decision references, source run/world where applicable, game/adapter/profile/schema compatibility and capability requirements as defined above, source compatibility, state schema, limits, and validation/evidence references. Skills and policies have separate identifiers and registries even if they share an artifact format.

Each reusable skill/policy version links its exact immutable StrategyCard version and source/configuration hash under the [required card schema](learning-and-evaluation.md#human-readable-strategy-artifacts). A revision appends linked source/card versions; it cannot leave a card describing different source bytes. Untested status and unknown outcomes remain explicit.

Per-model libraries and pre-run immutable library snapshots follow [learning and evaluation](learning-and-evaluation.md). Compatibility is checked when selected and again when activated; a model/library mismatch is explicit, not silently repaired. Serializable private state belongs to one execution and can contain only authorized observations or derived information. Restoring it requires schema compatibility, world provenance checks and a new execution fence.

Artifact bytes, card versions and validation reports are immutable shared records. The following lifecycle is a **run-local selection state**, keyed by `(run_id, policy_id, policy_version)`, not a mutable field on inherited snapshot entries. Each run owns its selected-version pointer, evaluation generation, trial counters and private state. Two runs inheriting the same source cannot activate, retire, quarantine, or modify state for one another. A host security revocation may make an artifact unavailable across runs, but is a separately audited safety decision, not shared gameplay activation state.

| Policy state | Allowed transitions and conditions |
|---|---|
| `draft` | `validated`, `quarantined`, `retired`. Source/configuration is immutable even before validation. |
| `validated` | `trial`, `quarantined`, `retired`; also `active` after an evidence-linked keep of a completed trial or eligible inherited warm-bundle reuse. Schema, capability and isolation checks passed; validation alone does not establish gameplay effectiveness. |
| `trial` | `active`, `validated`, `quarantined`, `retired`. Trial bounds end use automatically; evidence remains even if promotion is declined. |
| `active` | `validated`, `quarantined`, `retired`. Demotion to validated removes activation without deleting prior evidence. |
| `quarantined` | `retired`. Invalid/nonterminating versions cannot be directly reactivated; a corrected artifact is a new version. |
| `retired` | Terminal for that version. A fresh version requires its own validation/trial. |

The registry has a selected-version pointer per `(run_id, policy_id)`. Activation uses an expected-current-version check in that run to prevent concurrent lost updates. At the next scheduling boundary, the runtime revokes the old evaluation generation, atomically commits the new pointer/state changes and `policy.activation_effective` event, and only then admits evaluations of the new version. Outstanding old provider responses are rejected. An action already running is not magically undone by a switch: it keeps its original recorded origin and bounded lease unless the switch explicitly requests normal cancellation. The replacement policy's evaluations see the current action.

A trial occupies that lineage's selected-version slot during bounded gameplay use. At its declared elapsed/action/evaluation bound, the runtime stops new trial proposals, fences outstanding evaluations, and returns to a specifically selected compatible prior version or no policy; any necessary action cancellation uses the normal handshake. Promotion requires explicit evidence-linked selection; a policy's own claim of success is insufficient. Restoring a prior compatible version is an audited atomic switch, not a world rollback. Quarantine removes selection, fences evaluations, safely cancels affected execution where necessary, retains source/evidence, and notifies the strategist.

## Fast decisions and model capabilities

`FastDecisionProvider` is the seam for remote fast-model decisions, including required Jev support. Local JS evaluation is a separate policy backend, not an imitation provider response. Both return the same bounded proposal contract; the executor alone issues effects.

A fast-model configuration declares provider/model references, instruction artifact hash, authorized input projection, finite output choices referencing adapter capability schemas, maximum input/output size, maximum input age and response deadline, and bounded retry/attempt policy. A fast-provider request carries evaluation ID, policy/version and generation, filtered input, permitted choices, and a broker-enforced deadline. Its result contains selected choice and validated parameters, timing/attempt/usage metadata, or an explicit error. Provider output never supplies an arbitrary tool name, host command, network request, or direct game-engine call.

| Capability record | Required meaning |
|---|---|
| Model identity | Provider ID, model ID, role (strategic or fast), provider-adapter identity/version, context and output limits where known. This is separate from GameAdapter identity. One strategic model controls the avatar. |
| Supported features | Tool/schema support, cancellation/deadline behavior, structured output and streaming support when available. Unknown support is explicit. |
| Connection | Opaque trusted `connection_id`, supported auth mode, availability and redacted status. No key, access token, refresh token or browser session value. |
| Usage | Logical decision ID, actual attempt count, tokens where reported, known cost or explicit unknown cost, provider error category. |
| Reliability | Concurrency/rate limits, per-request deadline, finite attempts, queue capacity and backend health. No monetary stop threshold. |

API-key connections and supported subscription/OAuth connections are required paths through legitimate provider-supported adapters. Subscription ownership alone does not establish API entitlement. The trusted broker owns provider authentication and token refresh; models and workers see opaque references only. Initial run selection freezes strategic model and library snapshot for interpretable comparisons. Midrun model switching is optional future UI scope; it cannot be assumed by core recovery. The strategist may replace a JS policy with Jev or the reverse based on evidence. Jev unavailability is visible and recorded; code-only operation remains possible when selected, without relabeling failed fast-model attempts as code results.

## Bootstrap and finite execution

Bootstrap tells the strategist about inference latency, observation constraints, task, capabilities and policy-authoring tools. It contains no developer-supplied game tactics. Its configured allowance is fixed in the manifest before start; the [canonical defaults](#autonomous-improvement-loop) are initial calibration choices, not measured sufficiency or a financial budget. A logical strategic call is one inference request for a chosen context; a tool continuation requesting another inference is a new logical call. Transport retries for the same request retain its logical identity, count as separate provider attempts, and cannot reset the time allowance. Per-request attempt and per-turn attempt limits still apply.

The bootstrap clock begins on entry into `bootstrapping` after environment readiness, includes hydration/retrieval/validation, and never restarts after failure, cache miss, pause or recovery. Record accepted-start-to-bootstrap readiness time separately as startup elapsed; total time to gameplay includes both phases. This matches the measurement clocks rather than consuming the preparation allowance while connecting the game.

Bootstrap may register and validate initial candidates. A runtime-valid candidate can enter a bounded gameplay trial; no prior effectiveness proof is required. If no eligible version is selected at expiry, the run enters gameplay with no policies and a visible reason; it cannot call an unmeasured candidate useful merely because validation passed. Later authoring uses ordinary autonomous gameplay turns without resetting bootstrap. Cold and warm runs have the same configured allowance, tools, documentation and backend availability; only inherited experience differs. Per-model calibration settings are frozen equally across matched arms.

### Warm startup hydration

A selected warm snapshot may contain an immutable **model-authored startup bundle**: `bundle_id`, `bundle_version`, `source_hash`, `authoring_model_ref`, `authoring_turn_ref`, `provenance_refs`, exact `policy_refs` with `card_ref`, `task_applicability`, `profile_refs`, `dependency_refs`, `required_capabilities`, intended run-local `selection`, and `evidence_refs`. The bundle records the model's selection, not a runtime rule choosing game tactics. Unselected programs stay behind selective search. Initial context contains only a bounded library index, selected bundle and applicable summaries, with retrieval refs for the rest.

After accepted start, the host checks snapshot/model identity, bundle hashes/provenance, current task/profile applicability, dependency compatibility, source security, current quarantine/security-revocation status and permitted information scope. A frozen snapshot cannot override a current safety rejection. Rehydrate eligible exact versions into fresh run-local state; never restore another run's evaluation generation, effect lease or world-local state. Cached validation is reusable only if source/configuration hashes, runtime version, isolation configuration, adapter version, observation profile ID/version/configuration fingerprint, interface/schema identities and capability versions match the validation record. Otherwise revalidate within the same bootstrap allowance and record the miss/rejection. Revalidation does not convert evidence gathered under incompatible information permissions into current-profile gameplay evidence.

For entries whose prior real evidence meets the [reuse/promotion policy](learning-and-evaluation.md#selective-retrieval-and-autonomous-promotion), request ordinary fenced activation in the current run without regenerating source or repeating already-satisfied tactical trials. Activation checks current permitted observation and declared preconditions; selection itself emits no game effect. Bootstrap permits registration, validation and activation readiness, not gameplay effects: effect admission and gameplay trials require `running` plus current authorized observation/preconditions, freshness, lease and adapter checks. A warm bundle can therefore activate with zero strategic authoring calls. Inherited evidence does not claim useful current-run use before a real eligible effect/outcome is observed.

Emit per-entry hydration, validation/cache and activation outcomes. Missing, incompatible, quarantined, inapplicable or time-expired entries remain visibly unselected with reasons; normal scheduled bootstrap may author alternatives with the remaining allowance. Never silently swap the snapshot, manufacture an empty warm library, restart the allowance or install handwritten fallback behavior. Record total time, actual calls/attempts, retrieval, validation/cache status, activation request/effective times and first confirmed effect for both arms.

Every worker invocation, skill execution, action, provider request and trial has a finite deadline and finite admission limits. Queue capacity, CPU/memory/output limits, dispatch/evaluation rates and provider concurrency are reliability controls, distinct from monetary accounting. Expiration fences late output and triggers cancellation, quarantine or explicit failure as appropriate. The runtime never waits indefinitely for generated code, a provider, or a policy-registration loop.

## Run controls and UI events

HTTP JSON controls and Server-Sent Events connect the local browser UI to the backend; the adapter-supplied live view has its own documented transport. The UI exposes task, run selection, provider connection status/selection, start, pause, resume and stop. Auth exchanges stay in trusted flows described in [operations](operations-and-security.md). Start captures the full game/adapter/profile manifest, task, world, model, capability/configuration versions and immutable library snapshot. Once started, a task edit is an attributed intervention that fences pending strategic work; it must not rewrite the original task history.

Mutating controls carry a request ID for idempotency and the expected run/epoch/state. An authenticated local session is required; repeated identical requests return the prior acknowledgement. Conflicting payloads or stale state return a conflict and current safe status. Acknowledgement means admitted, not completed. Status and events establish when a transition actually finishes.

The chosen future HTTP surface is:

| Method and route | Contract |
|---|---|
| `GET /v1/capabilities` | Safe capability catalog and supported connection modes; no secrets. |
| `GET /v1/connections` | Opaque connection references, provider/model availability and redacted status. |
| `POST /v1/connections` | Initiate a trusted supported connection flow; credentials or authorization exchanges remain outside run events and worker tools. |
| `GET /v1/runs` | Local run selection/status summaries, including terminal attempts and recovery/intervention flags. |
| `POST /v1/runs` | Create a `created` run from game/adapter/profile selection, task, world selection, strategic connection/model and compatible library snapshot. No game effects until start. |
| `GET /v1/runs/{run_id}` | Authoritative safe status, manifest references and latest durable event cursor. |
| `GET /v1/runs/{run_id}/improvements` | Bounded paginated improvement-card summaries for the authorized run, filtered by cursor/state; no other run or comparison-arm discovery. |
| `GET /v1/runs/{run_id}/improvements/{opportunity_id}` | Exact opportunity, model decisions, actual version change, trial/measurement status and authorized StrategyCard/source-event refs. |
| `GET /v1/runs/{run_id}/experience?ref=...` | Bounded read-only expansion of an exact authorized card, source or evidence ref under the same selected-library/run-private visibility rules as `experience.get`; no database browsing or privileged evaluator inputs. Authorized generated source is displayed only as escaped, inert text; this route grants no execution, installation or activation authority. |
| `POST /v1/runs/{run_id}/controls` | Idempotent command: `start`, `pause`, `resume`, `stop`, or attributed `set_task`. Provider/model selection is frozen at start; reconnecting its trusted connection does not change model identity. |
| `GET /v1/runs/{run_id}/events` | Authorized SSE stream, using `Last-Event-ID` for the durable cursor. |

A control body has this documentary form:

```json
{
  "schema_version": 1,
  "request_id": "control_example",
  "expected_epoch": 3,
  "expected_state": "running",
  "command": "pause"
}
```

The route supplies `run_id`; a created run uses its manifest's initial epoch. `set_task` additionally supplies the new task text and intervention reason, is permitted only in nonterminal states outside `stopping`, and revokes outstanding strategic/evaluation generations before new decisions use the task. It neither rewrites the original task nor resets bootstrap limits. Start/resume return an admission acknowledgement, pause/stop remain pending until their safety conditions hold, and invalid state transitions return a conflict. Unknown run IDs do not create runs implicitly.

| Run state | Permitted transitions |
|---|---|
| `created` | `bootstrapping` after admitted start establishes environment readiness; `stopping` on stop; `failed` on unrecoverable admission failure. |
| `bootstrapping` | `running` on completion/expiry; `pausing`, `recovering`, `stopping`, `failed`. |
| `running` | `pausing`, `recovering`, `stopping`, `completed`, `failed`. Completion requires objective evidence and no live effect lease. |
| `pausing` | `paused` only after admission is fenced and controls neutralized or the declared adapter safety fence is established; otherwise `recovering`, `stopping`, `failed`. |
| `paused` | `running` on deliberate resume after fresh observation; `recovering`, `stopping`, `failed`. Pausing during bootstrap ends that bootstrap; resume grants no new bootstrap allowance. |
| `recovering` | `running` or `paused` after reconciliation; `stopping`, `failed`. Prior pause/stop intent is preserved. |
| `stopping` | `stopped` after fencing/neutralization, confirmed adapter-session closure and durable closure; `recovering` if fencing certainty is lost; `failed` if recovery cannot establish safe closure. Stop intent survives recovery. |
| `stopped`, `completed`, `failed` | Terminal run records. A later new attempt has a new run ID; evidence can still be appended as reconciliation/intervention events without reopening effects. |

Pause stops action admission, revokes pending inference/evaluations, cancels skill/action execution, establishes neutralization or the adapter's required safety fence, and records the operator intervention. `paused` describes agent-control safety, not a universal game-world freeze. The adapter declares whether the environment keeps running, disconnects, or supports an explicit world-pause operation; the UI displays the actual behavior and consequences. No hidden survival behavior is installed. An explicit world pause is an attributed intervention and must never hide inference latency or be used automatically during ordinary model waits. Resume reobserves authoritative game state, obtains new execution generations, and requires new decisions rather than replaying queued commands. Pausing during bootstrap records its early termination; subsequent policy authoring uses ordinary gameplay tools, without restarting the bootstrap allowance. Model latency during normal play is not recorded as manual pause.

Stop has highest priority, closes admission, fences generated work and provider callbacks, establishes neutral controls or the declared safety fence, and closes the adapter's playing session with confirmation evidence. A transport disconnect or crashed emitter is recovery, not proof of immediate neutralization; the implementation must establish its fence/termination before claiming safe closure. Separately owned game processes or servers are not silently destroyed by stopping a run.

Required event families are run state/intervention, observation availability, action admission/state/outcome, skill execution, policy validation/trial/switch/quarantine, model decision/attempt, provider availability/auth status, runtime feedback, checkpoint/recovery/rollback and diagnostic status. Each event links to source records. The activity feed distinguishes queued, executing, awaiting inference, meaningful game wait, cancellation pending, disconnected/recovering and paused states. UI explanations cite plans, tool decisions and actual events; they do not claim access to hidden chain of thought.

The live activity surface includes a minimal improvement card: `opportunity_id`, `reason_code`, model-authored `reason`, exact `previous_artifact_ref`/`candidate_artifact_ref`/`selected_artifact_ref` when present, exact `card_ref`, model-authored `semantic_change_summary`, `trial_id`, `measurement_status` (`not_yet_measured`, `measured`, `unknown`), outcome summary and authorized `evidence_refs`/source-event refs. Show the actual switch state, not a proposed edit as an effective change. Keep/revert/failure/no-effect outcomes remain visible. Expand the StrategyCard and permitted evidence inline or through the read routes; a full library browser/editor/replay is not required. The UI may show authorized generated source as bounded, escaped, non-executable text. Viewing it cannot run code, install or activate a policy, widen capabilities, or disclose another run's data, secrets or privileged evaluator inputs. Model-authored markup/scripts must not execute in the operator origin; a ref is not filesystem or arbitrary URL authority.

Canonical additional events are `improvement.opportunity_created`, `improvement.opportunity_updated`, `improvement.opportunity_delivered`, `improvement.opportunity_decided`, `artifact.authored`, `policy.validation_completed`, `improvement.trial_started`, `improvement.trial_decision_due`, `improvement.trial_decided`, `policy.activation_effective`, `experience.bundle_hydration_started`, `experience.bundle_validation_completed`, `experience.bundle_activation_completed`, and `experience.promotion_decided`. Each carries its applicable turn/opportunity/trial, exact artifact/card/bundle refs, status/reason and source evidence refs in the common durable envelope. A trial-decision event records the model's keep/revise/retire/revert choice separately from the eventual activation-effective event. Bundle validation events include `cache_hit` and validation identity refs; bundle completion lists per-entry effective or rejected outcomes, not an unconditional “warm success.”

SSE uses durable `event_seq` as its reconnect cursor and delivers at least once. The browser deduplicates by run/event sequence and treats events as ordered evidence, not executable instructions. On an unavailable/expired cursor the backend returns an explicit resynchronization requirement and current status plus a new event cursor; it does not imply uninterrupted delivery. Browser disconnection alone is not a pause; backend health and authoritative controls govern the run, and the UI marks its view stale.

## Feedback and evidence

`feedback.read` and UI events expose source-linked progress and failure, not inferred success from fluent explanation. Records distinguish model decision latency, provider attempts/retries, runtime dispatch and reaction latency, action duration/outcome, blocked planning, interrupts, meaningful game waits, LLM-induced idle time, queue pressure, backend errors and actual usage. Gameplay evidence includes objective/subgoal changes, failed actions, deaths and observed consequences. [Learning and evaluation](learning-and-evaluation.md) defines aggregation and Time to Fluidity.

Record unavailable measurements as unknown. Include active policy/skill versions, action IDs, observation basis, evaluation rejection reasons, intervention/downtime intervals and unknown effects so investigators can reconstruct why a control was or was not issued. Diagnostics must not bypass observation permissions; privileged result verification remains separate from planner context, generated programs and reusable memory.

Timing evidence records accepted start, transition to running, strategic authoring-request admission, opportunity creation/delivery/acknowledgement/deferral, source/card authoring, validation admission/completion, activation-request acceptance/effective switch, trial bounds/decision/closure and first confirmed current-run effect/outcome. Link each timestamp to its event/process/epoch clock and record clock discontinuities rather than subtracting unrelated monotonic values. Track trigger opportunities, actual admitted policy uses, rejected proposals, revision counts, retrieval/cache outcomes and full sample sizes. The [learning protocol](learning-and-evaluation.md#policy-acquisition-and-revision-evidence) defines derived metrics and useful-policy evidence; control timing and task efficacy stay separate, with before/after correlations explicitly distinguished from controlled evidence.

## First integration: Minecraft Java Normal Survival

This profile specifies the first complete integration target, not implemented compatibility or generic core fields. It targets Minecraft Java 1.21.4, Survival, Normal difficulty, one avatar, ordinary spawn/inventory/death rules, and no agent cheats or operator privileges. A trusted Node.js 24 Mineflayer bridge implements the adapter; it owns raw bot/protocol access and a filtered observation cache. prismarine-viewer supplies the planned live first-person view. Its actual fidelity and compatibility must be established on the target stack.

### Player-observable structured profile v1

The one required initial profile is `observation_profile_id: player-observable-structured`, `observation_profile_version: 1`, using a structured state/event observation interface. This is a chosen specification, not implemented support. It provides a declared structured-information advantage/approximation, not human-identical perception or a formal zero-leakage guarantee. A stricter camera-based profile may be explored later; it is not required for the first playable slice.

Nearby unobstructed blocks/objects and entities may be observed within the configured finite range, regardless of camera yaw/pitch. A nearby tree behind the camera is eligible; rotating the camera alone does not revoke it. Obstruction/occlusion, range, loaded-client availability and bounded sampling still apply. This permission neither reveals all loaded chunks nor removes walls. The initial sampling rules below have no camera cone.

The profile also permits normal F3 position, own health/status, inventory and interaction UI, public recipes/docs and legitimately retained world-local memory. Hidden ore/resources, undiscovered structures, exact current state/coordinates/identity of occluded entities, seed, saves and privileged evaluator state remain unavailable to the agent. Raw Mineflayer bot/world/chunks, `findBlocks`/`blockAt` access and entity enumeration are not agent APIs. The trusted adapter may possess raw client state for perception and physics, but the strategist, generated skills/policies, retrieval, reusable library, agent-visible logs and errors receive only permitted projections. Renderer backing data and evaluator inputs remain separate.

| Profile configuration field | Initial preset: `minecraft-observable-initial-r1` |
|---|---|
| `observation_radius_blocks` | `32`, Euclidean distance from the exact current avatar eye position |
| `navigation_geometry_radius_blocks` | `8`, Euclidean controller-only bound from the current avatar feet position |
| Refresh | One sampling batch every `200 ms` of bridge monotonic time while observations are admitted; first batch immediately after admission/reconnection. No overlapping batches or catch-up burst; a late batch starts once, then schedules the next `200 ms` after its start. |
| Block scan | At most `128` consecutive discovery-ray slots per batch from a fixed `354`-direction cycle; at most one block candidate per direction, hence at most `128` considered block candidates per batch |
| Entity scan | At most `64` registry candidate slots per batch, irrespective of type, including unavailable/out-of-range candidates; resumable order below |
| Raw observation cell visits | At most `65,536` per batch, partitioned into `57,344` for block sampling and `8,192` for entity sampling; no borrowing. Candidate-cell reads and every ray cell lookup count, including cached, repeated and unavailable lookups. |
| Occlusion samples | One eye origin, up to `6` target points per candidate, at most `128` cell visits per discovery or target ray; fixed construction/order below |
| Refresh elapsed guard | `10 ms` total sampling work per batch, checked before each candidate and cell lookup; blocks on even-numbered batches and entities on odd-numbered batches run first (first batch is `0`) |
| Current freshness | Maximum age `1,000 ms`; dependency invalidation can expire a record sooner |
| Authorized index | At most `4,096` current/remembered object and entity records combined; evict oldest last-authorized observation first, breaking ties by the authorized record order below |
| Search and read pages | Default `32`, maximum `128` records; positive integer limits only, larger values rejected. Searches never trigger a raw resource scan. |
| Observation output | At most `256` records across all collections in one snapshot/delta, `2,048` UTF-8 bytes per record and `65,536` UTF-8 bytes for the entire response, including an envelope of at most `4,096` bytes |
| Sound | At most `8` coarsened records per batch, expiry after `1,000 ms`; whitelist, grouping and bins below |
| Private local planning | At most `4,913` distinct cells, `8,192` cell visits, `2,048` expanded nodes and `4,096` queued nodes per plan; minimum replan interval `100 ms`, elapsed guard `5 ms` |

These are chosen engineering defaults, not measured performance or a claim of universal adequacy. Before bootstrap, expand the preset into the full effective `observation_profile_config`; fill omitted optional settings from this preset, never leave a limit unspecified. Record the preset ID, profile version, exact values and algorithms below, target game/registry and geometry-data revisions, and any explicit overrides. Fingerprint that expanded configuration with SHA-256 over RFC 8785 canonical JSON, and retain both configuration and fingerprint in the manifest. Overrides change the fingerprint and must remain fixed in matched comparisons; a changed algorithm needs a new preset revision. Loaded state and eligibility further restrict access; neither radius authorizes its whole volume.

#### Sampling schedule and eligibility

Block discovery uses a fixed camera-independent cycle of `354` world-aligned ray directions. Enumerate elevation `e = −75°, −60°, …, +75°` ascending; within each elevation enumerate azimuth `a = 0°, 11.25°, …, 348.75°` ascending. The unit direction is `(sin(a) cos(e), sin(e), −cos(a) cos(e))`: azimuth zero is north (`−Z`), increasing clockwise toward east (`+X`), and positive elevation points up. Append straight up `(0,1,0)` and then straight down `(0,−1,0)`. Each batch starts or resumes at most `128` consecutive directions, wrapping after direction `353`; no resource query or avatar movement restarts the cycle prefix.

For each discovery direction, traverse the segment from the exact current eye position to `eye + 32 × direction`, using the supercover cell order below and at most `128` cell visits. Stop at the first loaded non-air cell: it is only a candidate, not yet an authorized observation. Require its block center to be within radius `32` and run the target checks below; whether they succeed or fail, do not continue through it to discover another block. An unavailable cell stops discovery as unknown without chunk loading. An all-air segment produces no candidate and no object-absence certificate. Repeated hits on the same block still consume direction/candidate budgets; authorized records are upserted by block position. Discovery and target checks both consume the block raw-visit partition.

Keep the direction cursor across batches and poses, advancing after that direction's discovery and any candidate check finish. A stationary observer completes a direction cycle within three nominal batches only when cell/time budgets do not interrupt it; this is schedule arithmetic, not measured latency or a guarantee of complete coverage. Thin objects, gaps between rays and conservative occlusion can leave otherwise visible objects unsampled indefinitely. Movement gives only actual sampled coverage at each pose, never a complete moving sphere.

The trusted entity registry maintains ascending protocol entity-ID order as packets arrive; a scan resumes strictly after its last examined ID and wraps at the end. New lower IDs wait until wrap. Every visited registry entry consumes one of the `64` slots before inspecting type, availability or range. The avatar itself is excluded, and an entity's current bounding-box center must be within radius `32`. Registry maintenance does not perform a separate type query, whole-registry sort or whole-world scan on each refresh. Raw entity IDs and registry counts remain private.

Each candidate is checked against the following conservative terrain-occlusion approximation:

1. Capture the exact avatar eye position as the sole origin; yaw/pitch have no effect. For a block, first construct the six unit-cell face centers, inset into the cell by `1/1024` block. For an entity, use the six current axis-aligned bounding-box face centers, inset along the face normal by `min(1/1024, normal-axis extent / 4)`. Order points `−X, +X, −Y, +Y, −Z, +Z`. Missing/degenerate entity bounds are unknown.
2. Resolve block target geometry from the pinned block-state geometry data. For known nonempty collision shapes, retain only face points lying inside at least one shape box. If none remain, substitute the first six distinct shape-box centers in ascending `(minX,minY,minZ,maxX,maxY,maxZ)` box order; use fewer when fewer exist. For a confirmed loaded non-air block with a known-empty collision-shape list, use the whole unit voxel as its declared target-selection volume and retain the original six face points. This keeps fluids and non-colliding plants eligible without a separate resource-type search. Missing/unsupported geometry remains unknown and cannot use this fallback. There are never more than six target points/rays per candidate. Whole-voxel selection for known-empty shapes and entity bounding boxes are structured approximations, not rendered silhouettes or human-equivalent vision.
3. Traverse the origin-to-target segment through unit cells with a supercover voxel traversal: include every cell whose closed cube touches the segment, including origin/endpoint cells; order by segment entry parameter, with simultaneous contacts ordered `(x,y,z)` ascending. Any non-air intervening block is conservatively opaque as a whole unit cube, including transparent blocks, foliage and fluids. Other entities do not occlude these terrain rays. Unknown/unloaded intervening cells fail the ray as unknown. For block targets, exempt only the target cell from this whole-cube obstruction rule; the endpoint must still satisfy step 2. No skipped cell is treated as air.
4. Stop on the first eligible clear ray and authorize only the permitted target projection. A blocked ray proceeds to the next point. A ray needing more than `128` visits is unknown, not clear. Exhausting the at-most-six samples without a clear ray means not currently observed, not proof of absence or full invisibility. Stock `canSeeBlock` is not a substitute for this schedule or for the other permission gates.

Keep at most one unfinished block discovery/candidate and one unfinished entity candidate, including direction/point index and ray-cell cursor. When a partition, slot or elapsed budget ends, suspend before the next counted operation; resume unfinished work before advancing that source's scan. Completed checks can be reused only while eye position and all read-cell/target dependencies are unchanged and their capture is at most `1,000 ms` old. Otherwise discard partial work: restart the same block direction from discovery, or the same entity candidate from its first point, without restarting either cycle's prefix. A batch attempts a given slot at most once; resumed block work consumes one of its next batch's `128` direction slots, and resumed entity work consumes one of its `64` registry slots. On completion, advance regardless of success. This is a resumable fair scan for stable state, not a retry of raw resource-specific top-k results. Repeated state changes can prevent completion; record that actual coverage rather than relaxing checks.

The elapsed guards stop admission of more work; they neither preempt a slow individual operation nor promise deterministic wall time. Log exhaustion reason, actual duration, discovery-direction slots/completions, considered and completed/partial candidates, discovery/target ray attempts and raw cell visits in trusted diagnostics. Also retain sampled pose/time, direction/registry continuation, direction-cycle completion age and actual checked coverage there. No exhausted budget can authorize an unchecked target, turn unknown into absent or expose hidden candidate counts through response metadata. Measure the pipeline under [observation-pipeline performance](learning-and-evaluation.md#observation-pipeline-performance); these defaults are not benchmark results.

#### Freshness, search and bounded output

Current observations retain their capture time, eye position and target/read-cell dependencies. Recheck these dependencies before publishing a completed check and before returning a current record. An eye-position change, target-state change, relevant occluder update, dependent chunk unload or age over `1,000 ms` invalidates current eligibility immediately; camera-only rotation does not. Entity motion invalidates its current record without updating its last-seen position from raw tracking. Epoch/world/rollback-branch/profile changes invalidate current handles and partial scans. A new epoch/profile starts both scan cursors from the beginning; unavailable state, disconnected transport or uncertain dependency revisions remain unknown until freshly reconciled and sampled. Remembered facts retain only their last authorized projection and provenance. TTL expiry, record eviction or a missed sample is not evidence that an object disappeared.

Publish current records only from completed eligible checks. Sampling is always partial: even a completed direction cycle spans time, samples only fixed rays and is not an absence certificate. Read/search report this safe limitation and the capture age of returned facts; raw scan counts, hidden matches and private coverage maps stay out of agent-visible completeness/cursor/truncation fields. If the caller's requested maximum age cannot be met, return unknown/stale coverage, not a newer timestamp on old facts.

First project and filter eligible current records or explicitly requested last-seen memory; then apply the caller's search predicate, ordering, counts, pagination and byte limits. Sort blocks by `(x,y,z)` and entities by opaque authorized handle, with current blocks, current entities, remembered blocks, remembered entities in that order. Any count is only of matching authorized index records, never a world total. Cursors refer only to an authorized index revision and that ordering, expire after `1,000 ms`, and are rejected as stale if eligibility or the selected index revision changes. A page never continues a raw scan or discloses its cursor.

Encode compact JSON without insignificant whitespace, counting actual UTF-8 bytes. Never split a record; omit a projected record exceeding `2,048` bytes from the bounded view, and set safe authorized-output truncation. Append authorized records in order until the requested page limit, `256`-record aggregate cap or response byte cap would be exceeded; continuation is based only on authorized records. Reserve the `4,096`-byte envelope allowance before filling records. Oversized optional prose fields are omitted, not copied from raw protocol data to errors. Sound records count toward these output limits. Index eviction and output truncation preserve unknown/partial-coverage semantics.

#### Legitimate coarse sound

Use only sound events actually delivered as audible to this avatar, never inferred from entity state or an unrestricted world-event feed. The initial exact sound-ID whitelist maps `minecraft:block.grass.step` and `minecraft:entity.player.swim` to `movement`; `minecraft:block.stone.break`, `minecraft:block.stone.place`, `minecraft:block.wood.break` and `minecraft:block.wood.place` to `interaction`; `minecraft:entity.player.hurt`, `minecraft:entity.generic.hurt`, `minecraft:entity.generic.death`, `minecraft:entity.arrow.shoot` and `minecraft:entity.generic.explode` to `combat`; `minecraft:entity.zombie.ambient` and `minecraft:entity.skeleton.ambient` to `creature`; and `minecraft:entity.lightning_bolt.thunder` to `weather`. Drop other IDs. A protocol/source that cannot establish legitimate audible delivery cannot provide these observations.

Using the listener position at event delivery, discard events beyond Euclidean distance `32`; emit only distance bands `near: [0,8)`, `mid: [8,16)`, `far: [16,32]`. Horizontal direction has eight fixed world-relative sectors, nearest compass heading with exact halfway ties clockwise: north is `−Z`, east is `+X`. Horizontal distance below `1` yields `here`, without vertical direction. Group events received since the previous batch by `(category,direction,distance-band)` in a fixed `135`-bit presence set; emit one record per group, without multiplicity, exact sound ID, source coordinates, source identity/handle, volume or pitch. Do not queue raw sound events. Order by category `movement, interaction, combat, creature, weather`, then direction `here,N,NE,E,SE,S,SW,W,NW`, then distance `near,mid,far`; keep the first `8` groups and clear the set after each batch. Timestamp only with the batch capture time, expire after `1,000 ms`, and do not retain undelivered overflow or replay expired sounds as current. On late batches, discard events already more than `1,000 ms` old at capture; retain only the latest eligible delivery time per group (`135` timestamps maximum) to enforce this without a raw-event queue.

Remembered objects/entities retain world/rollback-branch provenance, last-authorized position/time and uncertainty. When an entity moves behind an obstruction, raw live tracking must not update its remembered location or identity/state. Observation-local target handles expire with epoch/profile validity; remembered locations can guide movement but do not authorize a current interaction. Only actual legitimate audible game events can yield sound observations, with the configured coarse direction/distance/category. Do not synthesize hearing from hidden entity enumeration or return precise sound-source coordinates/entity handles that enable concealed tracking.

Resource queries use the authorized observation index and the [filter-before-metadata contract](#observation-interface), not raw resource searches exposed as tools. Adapter-level evidence is required for obstruction, entity filtering, range, memory and candidate selection; `canSeeBlock` is only a candidate block-occlusion helper, not a complete permission check or proof that raw search followed by filtering is safe. See [verified upstream evidence and limitations](upstream-reuse.md#structured-observation-and-navigation-evidence).

### Bounded private navigation geometry

A trusted low-level controller may read bounded client-loaded terrain geometry for local movement toward an already authorized known target/waypoint. Local obstacle avoidance and detours inside the bounded execution envelope toward that same goal are allowed even when individual cells were not previously observed. It need not have an agent-observed record for every collision voxel. This exception is private execution support, not permission for the model or generated programs to inspect those voxels.

- Keep collision/passability/headroom geometry separate from the agent's observed-object and memory index. Project raw terrain to geometry only: no hidden block names/resource IDs, structures, container contents, entities, seed-derived facts, resource scoring or buried-target extraction. Any extra material/hazard semantics must already be authorized observations.
- Before private geometry lookup, validate the requested target/waypoint against authorized observed/remembered goals. A model-chosen bounded exploratory movement may specify mechanical direction/displacement, but cannot ask the private planner to locate an unknown target or select an undiscovered higher-level waypoint/route. Reject arbitrary hidden/unknown target probes. Record the authorized goal or mechanical-input basis, read/planning envelope, effective configuration, internal read audit and actual movement/outcome evidence in trusted diagnostics; raw geometry and audit details remain outside agent permissions.
- Reads and local planning remain inside the configured radius around the current avatar and client-loaded geometry. Higher-level goals/routes/corridors come from permitted observations/memory or model-chosen bounded exploration. Neither a global loaded-world planner nor the local controller may use hidden geometry to discover/select an unknown cave, entrance, corridor, shortcut or exploration route as a higher-level route. If progress requires such discovery, request further observation/replanning or stop with a neutral bounded-execution failure. This restriction does not forbid previously unseen local steering cells or bounded detours toward the same authorized goal.
- Apply the initial preset's per-plan caps before reads/expansions, counting cached/repeated cell lookups as visits. A cell is readable only if its center is within radius `8` and its integer offset from `floor(feet)` is in `[-8,8]³`; the `4,913`-cell cap is an upper bound, not permission to read that whole cube. No eager geometry prefetch outside an admitted plan. Replan at most once per `100 ms` during an authorized active movement, and discard a plan when its goal, pose/envelope or read dependencies cease to be valid. Pin the controller/physics revision in the effective configuration; for A*, order available neighbors by `(x,y,z)` and break open-set ties by `(f,g,x,y,z)` ascending. Stop before exceeding any read/node/queue cap or the `5 ms` admission guard; return only the safe coarse local-planning failure, never an unchecked route. Record actual reads, expansions, duration and exhaustion privately. These caps do not grant another effect lease, extend action duration or install autonomous replanning while no movement is authorized.
- Return only permitted actual movement/outcome feedback and safe coarse failure categories. Never expose private maps, raw path nodes, reachability grids or resource-dependent diagnostics. Local steering/path choice/timing may still benefit from private collision geometry; this declared limitation must be fixed equally across matched comparisons and must not eliminate exploration.

Stock mineflayer-pathfinder is not exempt. If its data path cannot enforce the geometry projection and local envelope/goal rules, wrap, constrain or replace it, or use bounded mechanical moves. Passing the full raw world and filtering only the returned route is insufficient. Conformance must audit internal reads and actual effects, including known-target movement without an all-voxels-observed map, same-geometry concealed ore/stone substitution, rejection of unknown-target probes before lookup, and refusal to choose a hidden cave/shortcut as a route. Controlled security fixtures are separate from ordinary-world gameplay evidence; fixture coordinates/tactics cannot enter reusable experience.

Paper Anti-Xray is optional defense in depth, never the sole filter; these permissions must hold with it disabled. It does not protect entity information or every hidden-data channel. Record vanilla/Paper flavor, exact game/server build, enabled status and effective per-world/dimension Anti-Xray settings (mode, block lists, heights and update options applicable to that version), ideally with a configuration snapshot/hash, in experiment evidence outside agent permissions. Freeze those settings in matched comparisons; masked/false ores are not genuine discoveries. No Paper setup or tested compatibility is claimed here; see [upstream evidence](upstream-reuse.md#structured-observation-and-navigation-evidence) for version-specific limits.

### Minecraft mechanics and lifecycle

Initial capability schemas cover bounded movement/input/look, interaction, dig, place, craft, equip and navigation under the profile above. Parameters explicitly select targets, recipe/item identifiers, quantities, slots and other tactical choices. The bridge rechecks reach, profile-authorized target validity, inventory, UI session and terrain constraints immediately before effects; any game-required aiming is an action constraint, not a camera-cone observation filter. Coordinated movement/look/attack may be one bounded composite action, never independent foreground leases. An A* motor must obey the private local-geometry contract; it cannot discover hidden targets or higher-level routes. No handwritten collect-wood, explore, survive, fight or complete-game routine is supplied.

Cancellation stops the motor/navigation task, releases held inputs and obtains neutralization acknowledgement; if that cannot be established, the bridge emitter must be fenced/terminated and recovery entered before a new lease. A lost craft/place/consume result stays uncertain rather than triggering blind repetition. Domain revision examples include pose, target validity, inventory-slot contents, UI session and the authorized navigation goal/corridor plus controller envelope; unrelated observation updates do not invalidate every slow result.

The default operator pause leaves the avatar connected and the world ticking; survival is not guaranteed. Stop confirms safe controls and avatar disconnect, without silently shutting down the operator's server. Minecraft save/flush, backups, reset and restoration require separately declared server support and consistency procedures in [operations](operations-and-security.md#first-integration-minecraft-server-and-saves). No universal atomic save or deterministic rewind is implied.

The task verifier may evaluate declared Minecraft subgoals and the long-horizon Ender Dragon objective. Completion requires actual verifier evidence; a useful workflow, intermediate task or attractive view is not proof of Dragon completion. Any privileged evaluator state remains isolated from planner inputs and experience.

## Adapter conformance and extension

Before enabling an adapter, its implementation must provide the descriptor, pinned schemas/profile permissions, connection/effect/cancel procedures, live-view declaration, task-verifier scope and honest state-support levels. Registration alone is not conformance.

Conformance evidence must cover:

- Bounded schema validation and rejection of unsupported capability/profile versions; run/artifact mismatch rejection without coercing foreign domain payloads.
- Player-observable filtering, unknown semantics and reference expiry through observations, navigation/helpers, errors, retrieval and live-view routes; privileged verifier output cannot leak to agent context.
- The unchanged run/action/policy transitions, single foreground lease, host-stop priority, acknowledged cancellation or documented fence/recovery, partial-effect evidence and lost-result `unknown` handling.
- Old epochs, revoked generations, expired responses and changed mandatory dependencies rejected at the final effect gate; slow responses with unchanged relevant dependencies remain eligible.
- Reconnect with admission closed, authoritative reobservation, ledger/memory reconciliation and preserved pause/stop intent; unsupported reset/checkpoint/restore/world-pause operations fail honestly.
- Live-view staleness/authorization and supported task evidence; any supported checkpoint/reset/restore operation demonstrates its stated consistency and lineage behavior.

Minecraft-specific profile conformance uses the planned [structured-observation and navigation security fixtures](operations-and-security.md#structured-observation-and-navigation): behind-camera observation within range, concealed-ore exclusion and discovery after actual removal of an obstruction with Anti-Xray disabled, hidden-entity stale memory/coarse real sound, alternate-endpoint isolation and audited local navigation. These are required future proofs, not checks run or gameplay results reported here.

Use synthetic states for infrastructure conformance, then real game operation for gameplay claims. To add a game, implement and document these adapter-owned pieces, supply compatible domain artifacts and run the same core conformance scenarios. Changes to generic scheduling, isolation, authorization or stale-response rules are not an adapter shortcut. A second game is not yet implemented or required to establish the first integration's actual status.
