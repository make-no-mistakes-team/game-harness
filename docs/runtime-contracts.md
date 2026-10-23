# Runtime contracts

This document records the named program-workspace interface and broader release requirements. The [current program interface](#current-compact-program-interface) owns callable tools; later conceptual dotted names describe release obligations, not aliases. The [integration guide](integration-spike.md) owns operating commands, source cohorts, observed evidence and limitations. Implementation below does not claim a new full proof. The [PRD](prds/gameharness-v1.0-prd.md), [architecture](architecture/overview.md), [evaluation](learning-and-evaluation.md), [operations](operations-and-security.md) and [upstream evidence](upstream-reuse.md) define the related boundaries.

## Ownership and vocabulary

The trusted runtime owns scheduling, authorization, persistence, and the action ledger. A trusted GameAdapter owns game connection, observation filtering and effect admission. A generated program requests bounded actions through filtered capabilities; it cannot mutate the game directly. Strategic inference, program execution, smooth motor control and reactive evaluation proceed independently. Minecraft is the first native integration; its proof boundary is separate from old-spike evidence.

| Term | Contract |
|---|---|
| Run | One recorded attempt with a task, selected strategic model, world, initial library snapshot, and intervention history. Infrastructure recovery continues that run. |
| Game session | One owned native connection, identified by public `session_id`, `world_id` and connection `epoch`. It outlives individual runs and player lives. |
| Player life | An authoritative incarnation within a session: `life_id`, status, respawn readiness and optional death evidence. A confirmed new alive incarnation advances `life_id`, not the session or epoch. |
| World | An environment lineage: a game world, level or session whose state and remembered facts share continuity. `world_id` remains the canonical identifier. Replacing the environment creates a new lineage; restoring an older checkpoint records a rollback branch within that lineage. |
| Epoch | A durable connection-fencing generation. Recovery, reconnect or world reset advances it before new effects; an ordinary new run or respawn on the same connection does not. |
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

GameHarness must be language-agnostic at component boundaries. Performance-critical components may be implemented in native languages without modifying the agent runtime, skill format, or game adapter contracts. Versioned bounded data, explicit deadlines/cancellation and authority checks remain stable across language changes. TypeScript orchestration, Java Fabric perception/motors/capture and generated JavaScript skills are distinct responsibilities; an optional measured Rust optimization cannot introduce a second skill format or bypass the adapter.

The implementation separates `Runtime` lifecycle/observation/goal authority from `ActionArbiter` (`action-arbiter.ts`), `ReactiveRuntime` (`reactive.ts`), `StrategicPlanner` (`strategic.ts`), `RuntimeTools` (`runtime-tools.ts`), `SkillManager` (`skills.ts`), `ExperienceLibrary` (`experience.ts`) and program evidence (`program-evidence.ts`). Each owns its state and enforcement responsibilities; `runtime-prompt.ts` holds authoring instructions. The public runtime API remains the composition seam, not a per-tick gameplay engine.

## Current compact program interface

Executable types live in [`src/shared/programs.ts`](../src/shared/programs.ts); model inputs in [`src/server/program-interface.ts`](../src/server/program-interface.ts). [`RuntimeTools`](../src/server/runtime-tools.ts) applies role/schema authority, [`ProgramOperations`](../src/server/program-operations.ts) owns use cases and [`ProgramWorkspace`](../src/server/program-workspace.ts) resolves names and bounded evidence. Programs are immutable async JavaScript bodies with host-bound `game,args`, not modules or developer-authored gameplay routines.

The ordinary default has six program verbs and one custom-task lifecycle tool:

| Model tool | Purpose |
|---|---|
| `observe` | Obtain fresh authorized game state without caller-supplied session/life/epoch. |
| `program_write` | Create a named family or immutable revision, with JavaScript body, StrategyCard and named dependencies. |
| `program_run` | Start, inspect or stop current/latest execution; deliberately activate prepared next work; select one finite attention wake. |
| `program_inspect` | Read catalog/source/execution/history/trace/feedback/comparison/planning and mechanical reference views. |
| `program_review` | Record `keep` or `insufficient_evidence` for a named version's latest matching outcome, with reason. |
| `help` | Load generated game/program/planning reference or disclose optional advanced modules on demand. |
| `task_finish` | Request safe closure of a custom task with a model-authored completion summary; not independent goal verification. |

For a custom task, Main calls `task_finish({summary})` once authorized observations and execution evidence show that the whole requested task is done. A successful program return, completion prose or `game.progress` alone never closes a task. Do not rerun already-satisfied work or wait for the empty-turn limit to stop inference.

The host records `task.completion_reported` with `source:"model"`, `reported_outcome:"completed"` and `verification:"unverified"`. It synchronously fences further inference and effects, acknowledges `status:"stopping"`, then awaits ordinary neutralization and worker/planner/action drain before reaching `stopped`. It retains a healthy session/video and does not start post-goal review. The tool does not emit `goal.verified`, qualify experience or bypass a built-in verifier. Speculative and review roles cannot invoke it. Identical tool-call retries return the original acknowledgement without another closure request; changed arguments conflict.

Deterministic runtime regressions cover closure after a completed root and with another root still pending, held neutralization, stale effects, role restrictions and durable retries. A zero-provider replay through the real Runtime/Store/tools/scheduler reached `stopped` and admitted no further inference across the idle cooldown; game, provider and sandbox boundaries were synthetic. This establishes lifecycle behavior, not natural-model adoption of the tool or native gameplay success.

`help` is the schema/reference source of truth, generated by [`program-help.ts`](../src/server/program-help.ts) from host validators and interface schemas. `help` topic `game` supplies the canonical `GameAPI` reference; topic `programs` supplies authoring, execution, inspection and review contracts. No repeated full DTO declaration is required in prompts or this guide. Inventory fields are `name`, `display_name`, `count`, `slot`, not `.item`. Syntax/compactness validation does not typecheck all DTO access or prove behavior.

The tool factory explicitly sets `strict:false` at the provider boundary to preserve optional/discriminated input semantics. Host schema parsing and every authority/source/isolation/admission fence remain unchanged; this is not permission to accept invalid arguments. See the [transport reliability boundary](operations-and-security.md#provider-connections-and-credentials) and [scoped verification evidence](integration-spike.md#bounded-natural-wood-comparison).

A new `name` creates a family and omits `based_on`. An existing name requires its exact latest `based_on` version. The host checks that parent before validation and before commit; stale-parent errors identify the current named version, never silently rebase. Revisions preserve the family name, canonical source/hash and parent lineage. An optional bounded `reason` links an actual revision to latest unresolved matching feedback without a second bookkeeping-only model call; it records a candidate experiment, not proven efficacy or promotion.

Review with an explicit version stays exact. Without one, `program_review` selects the family's latest matching outcome, not an unexecuted latest source revision. A write experiment still requires its exact latest direct parent's own unresolved feedback.

Model selectors use human names and optional exact versions; the host resolves IDs, hashes and authority scope. Starting without `version` pins latest validated once before admission. Catalog pages expose the latest stored revision per family with cursors; execution/history/source lookup never rewrites an already captured reference. Inspection preserves explicit omissions and independent feedback cursors.

Write, run and prepare results are compact named status/experiment summaries, not repeated source/card dumps. Retrieve full source, card and validation details through the source inspection view when needed.

The strategic `observe` projection omits known host world/session/epoch/life/death identities while retaining authorized gameplay fields, target IDs, freshness and death reason. This does not change native/SDK `Observation` or isolated guard input. Typed evidence projections preserve execution arguments/results and trace/event payload JSON, subject to explicit byte omissions; arbitrary user JSON is not recursively stripped by key name. Feedback retains exact program names/versions and durable execution ordinals, separate from event-sequence references.

`help` topics `reflex` and `memory` disclose optional lifecycle tools to the ordinary role. Reflex retains actual isolated JS and real Jev behavior; memory retains compatible snapshots, fresh load and explicit evidence-qualified promotion. [`src/shared/tool-policy.ts`](../src/shared/tool-policy.ts) is the single role/module registry for both provider catalog and dispatch. Speculation receives observe/read-only inspect/help plus `prepare_next` only. Post-goal review permits source/assessment artifacts and authorized reads, not gameplay or advanced mutation.

Inside a program, capabilities are `await game.observe()`, `await game.action(action)` (final result), `await game.respawn()`, `await game.recipes(item)`, `await game.call({name,version?},args)` and `await game.progress(summary,details)`. Declared dependency names resolve to exact validated versions when the parent is written. A running child lookup uses **only that parent's pinned closure**, never current latest; omitted child version requires an unambiguous declared name. Internal `SkillRef` identities remain evidence/enforcement details. `game.respawn()` uses the same exclusive arbiter as `game.action({kind:"respawn"})`; it is no privileged recovery shortcut. Every return path, including early blocked/failed exits, supplies `{status:"completed"|"blocked"|"failed",summary,result}`; use `result:null` without a payload. Static validation does not prove every path returns correctly, and completion does not certify the operator's objective.

Strategic `action_submit` and `action_cancel` tools and aliases are removed. All new game effects require an owning skill execution or model-authored reaction through the arbiter; ownerless admission is rejected. The root program must implement a bounded observe/action/check/recovery/composition task flow, not outsource each next step to another strategic call. Small leaf helpers remain valid declared dependencies. Historical `origin:"strategist"` records stay readable and are never relabeled.

A safely settled failed action or blocked/failed child returns to the authored caller for its own correction. It does not automatically kill the root. Unknown effects, reconnect requirements, actual cancellation/preemption, death, pause and stop fence the execution tree; generated error handling cannot bypass that fence.

The parser rejects executable line/block comments, imports/exports, dynamic imports, invalid syntax and forbidden ambient APIs; comment-like strings remain data. Source is at most 16,384 UTF-8 bytes and 80 canonical nonblank lines, with statement nesting at most four and per-function cyclomatic complexity twelve. Safe validation errors preserve structured issues/locations/limits and body-only authoring guidance; there is no wrapper-format alias or parser fallback. The host stores and executes exact canonical bytes/hash with a validation fingerprint. StrategyCards remain separate. Static validation is not OS isolation.

Root defaults are 120,000 ms, 64 actions, 256 host calls and depth eight; hard maxima are 600,000 ms, 512 actions, 2,048 calls and depth eight. Child calls require declared exact dependencies and an acyclic bounded graph. The tree shares consumed budgets and deadline; children cannot reset them. One worker has at most one host capability outstanding. Parents never hold the avatar lease while awaiting children. Only leaf actions own effects, with `origin:"skill"` and their `execution_id`.

Durable `(run_id,start_key)` admission commits the original request fingerprint and identity before dispatch. Identical retries return that identity even after epoch changes; changed requests conflict. Historical lookup grants no renewed authority. Pause, stop, death and recovery fence roots, descendants and leaf work before closure. Restart reconciles accepted-undispatched work as cancelled and dispatched unfinished work as unknown; it never restores JS stacks or replays programs.

Each execution uses a dedicated restricted Docker container. Runnable computation has an external deadline; only a trusted host-known bounded capability wait suspends it. Worker heartbeats cannot extend authority. Cancellation fences capabilities first and waits for confirmed cleanup. Emitter closure cannot establish that prior game effects never occurred.

Keep closure barriers separate from outcome classification. An action/root can remain `unknown` after confirmed input neutralization and sandbox cleanup; historical uncertainty alone is not a live writer. `GameBridge.neutralize(): Promise<void>` resolves only after the actual native input barrier and does not disconnect. Pause/Stop await native/worker/planner/action drain, including worker closure when cancellation fails, without rewriting unknown effects. A missing acknowledgement cannot manufacture safety; genuinely unconfirmable transport/emitter failure still closes the owned client fail-closed.

A healthy, connected, alive session can reconcile an unknown effect autonomously rather than requiring operator Resume. Synchronously fence the affected root, planner, policies and leases; retain the unknown ledger without replay; await actual native neutralization and every worker's closure; then obtain a fresh authorized observation matching that session and life. Only after these gates pass create one new strategic generation and one `uncertainty` wake with compact outcome/reconciliation evidence. The model chooses whether to revise or admit new work; infrastructure never repeats the uncertain effect.

If the barrier, worker closure or fresh observation cannot be confirmed, keep effects closed and enter paused/fail-closed handling without treating a healthy connection as an error merely because past effects are unknown. A real transport error still follows owned-emitter teardown. Death during reconciliation transfers to the existing once-per-death recovery path. Operator Pause/Stop intent takes precedence throughout.

`RunView.skills` and `RunView.executions` expose immutable versions and linked execution history. `usage` and `usage.by_purpose` expose `uncached_input`, `cache_read`, `cache_write`, `output`, `calls`, nullable `known_cost` and explicit `legacy_input`. Historical aggregate-only input is not relabeled as known uncached usage. Compact default strategic context contains task/player/inventory changes, execution progress/closure and selected actionable failures; `observe` and read-only inspection retain authorized detail on demand. Pending programs suppress idle/tick strategy polling.

Request purpose is host accounting; no model tool or accounting-only inference request is required, and the old purpose-setting tool has no alias. At admission, `model.call` records the provisional role with `purpose_source:"host_turn_role_v1"` and `purpose_final:false`. After the assistant response, final accounting uses `purpose_source:"host_role_and_tools_v1"`. The precedence in [`strategic.ts`](../src/server/strategic.ts) uses host review/speculation/recovery role before visible requested tool operations; source/assessment activity is classified without asking the model to label itself.

`model.purpose_classified`, usage and settled-request evidence retain the final classification. If it changes, reattribute the purpose buckets without changing total calls, token counts or cost; pricing/unknown-cost semantics remain unchanged. A request without an assistant response retains its explicitly non-final provisional role. Existing purpose enums and historical accounting stay readable; host-source attribution remains distinguishable from immutable historical model-declared events. Classification never inspects model prose, source semantics or hidden reasoning and is not a causal explanation of the request.

Policies declare `backend:"javascript"|"jev"` and finite `choices:[{id,decision}]` or `null`. JavaScript source is a compact async body with `context,state`; Jev uses the real trusted OMP NativeJudge/TypeSafe broker. Missing credentials, failure and stale output remain explicit; local JS never impersonates Jev.

Promoted snapshots retain exact source/cards/dependencies, model/profile and source-run/world provenance, and attributable useful gameplay evidence. Portable declarations cannot include retained world data; world-local snapshots require the same world. Fresh hydration excludes old invocation arguments, observations, worker state and stacks. These checks do not prove semantic portability or generalization. Broader knowledge/search/history and comparison obligations below remain release requirements.

Current trusted `run.adapter` provenance records `adapter_id:"fabric-owned-client"`, `game_version:"1.21.4"`, `observation_schema:2`, `profile_id`, `preset_id:"minecraft-observable-initial-r2"` and `skill_protocol:3`. Named child calling increments `SKILL_API_VERSION` and source-validation/runtime fingerprints to 3; it does **not** change the native transport protocol or Observation DTO. The parent supplies the adapter identity through `RuntimeOptions.adapter_id`, not a universal native requirement.

Historical protocol-1/2 source, evidence and original IDs remain inspectable, including earlier ID-based `game.call` source. They are not rewritten, silently imported or executed as protocol 3. Fresh hydration retains exact source/dependency refs and must match canonical validation/runtime compatibility. There are no compatibility aliases for removed model tools or child calling conventions. Mineflayer evidence cannot be relabeled native. Native-build/capability-hash negotiation remains unimplemented; these checks are narrower than the normative descriptor.

Native inventory-gain promotion evidence requires `inventory_receipt_confirmed:true` and trusted own before/after counts. The trusted predicate event must occur within the closed root's bounded execution interval. Exact craft/dig `target_name` plus trusted task verification can qualify delayed pickup only within that interval; later gain cannot extend it retroactively. A trusted-goal cancellation can close an eligible root without pretending it self-completed; local predictions/assertions cannot qualify. These rules define evidence eligibility, not generalization.

### Session, run and player-life gates

Live `Observation` uses `schema_version:2` and requires `session_id` plus `life`. Before readiness, `GameState.session_id` and `GameState.life` may be null. Historical run/action/execution lineage may be null when not recorded; new admission never invents a legacy life identity.

`PlayerLife` is `{life_id:number,status:"loading"|"alive"|"dead"|"respawning",can_respawn:boolean,death:{death_id,at,message}|null}`. Native evidence owns transitions. Death retains the deceased ID; a confirmed new physical incarnation advances it once, separately from the full readiness gate that permits gameplay. Respawn preserves session ID, world and connection epoch.

While dead, actual vanilla DeathScreen readiness changes publish a normal life notice so `can_respawn` can become true without an observation call, action or reconnect. This preserves the same session, epoch, life, death episode and native generation; it neither duplicates the death event nor requests respawn. Saved-dead startup retains `death:null` when no new death episode was observed.

On normal death, immediately revoke old-life commands and pending policy/planning results, clear target bindings, release held buttons/camera and drain affected workers. Interrupted unconfirmed effects remain `unknown`. Keep the client connected, `game.error:null` and authentic vanilla DeathScreen frames streaming. The run stays active and wakes the strategist once with compact death evidence and last authorized context; the runtime supplies no survival or respawn policy.

Ordinary effects require an alive matching session/life. Observation, recipes and authorized read-only tools remain available while dead/loading/respawning. An explicit `game.respawn()` requests vanilla respawn at most once per admitted action, checks death-screen readiness and awaits authoritative new-life health/world readiness. Timeout preserves uncertainty and never replays. Only the recovery root correlated with its own confirmed successful respawn may atomically adopt the new life before continuing from fresh observations; every other old-life root/proposal stays fenced. A late authoritative new-life observation can update life status after an unknown respawn result but cannot rewrite or revive that unknown execution. Startup in a saved-dead world never respawns automatically.

A confirmed player replacement with authoritative positive health and pose establishes a distinct incarnation even if it dies before the inventory-readiness receipt. Record that replacement as a new dead life, fence its generation/handles/inputs and retain the emitted respawn result as `unknown`; no successful alive admission or root adoption follows. Another explicitly authored recovery may target that new dead life. Player replacement invalidates receipts from the previous player instance, and a neutralization acknowledgement must bind the actual sent generation/session and owned process rather than falsely treating a later death generation as transport failure.

Goal completion, model-requested custom-task closure, Pause and Stop run close run authority and await actual neutralization/drain while retaining a healthy session and video. No effects are admitted while paused, stopped or reviewing. Stop world, world replacement and app close own explicit connection/process shutdown; unconfirmable control failure may require safe disconnection. Neither death nor an unknown historical effect alone is a reason to tear down a healthy session.

Same-session working definitions are selected by `working_programs:"continue"|"fresh"` at run creation. Continue can import exact validated definitions/dependencies only for the same `session_id` and model; fresh omits them. These `working_candidate` records carry no old args, observations, private state or JS stacks and do not qualify cross-session experience.

Retention keeps one coherent latest run snapshot and its exact dependency closure for that session/model. A freshly authored same-name definition with a new ID replaces the working selection coherently; it never edits original source or mixes incompatible closures.

## GameAdapter descriptor and interface

This section specifies the game-extension contract. The current shared `Observation` and `GameAction` schemas implement the first Minecraft profile; the full descriptor and arbitrary adapter-schema negotiation are not implemented. Additional supported games require real adapter/schema/view/verifier integration and evidence. The intended boundary keeps scheduling/authorization independent of domain payloads: adapters declare and validate bounded serializable data, never export raw objects/callbacks or require tactical branches in the scheduler. Language-agnostic component seams do not by themselves establish game-neutral schema support.

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

The native Minecraft motor retains one action owner across aiming, held inputs and any declared interaction. Cancellation releases controls and waits for the actual native neutralization barrier before authority transfers. Unknown earlier effects remain unknown even when neutralization succeeds and a healthy client is retained. Missing control or an unconfirmed live emitter requires fail-closed owned-client termination before renewed authority; a sent cancel request is not acknowledgement.

Digging keeps cancellation separate from removal proof. Retain the owner until local motor channels are neutral and required native/server acknowledgement has settled; a cancelled initial look cannot emit a late dig. The effect gate checks current session/life, target dependencies and motor generation. Deadlines, missing effect acknowledgement or transport loss leave unconfirmed effects `unknown`; only actual server block-state evidence can establish removal. Historical SDK/ABORT fixture details belong to the integration history, not a second native API.

Outcome classification distinguishes preparatory camera change from world/input emission. Native result evidence uses `world_effect_emitted` and `camera_changed`; aiming alone cannot turn a rejected interaction into an unknown world effect. Dig/place preflight checks target type and reach before aiming; attack/interact likewise check existing mechanical range. Actual matching outgoing block-action packets, not an attempted update or rotation, establish dig emission. Unconfirmed world/input emission still yields `unknown` on failure, cancellation or death. An interrupted standalone camera-only action may retain a known failed/cancelled status with its actual rotation evidence; neutralization proves closure, never reversal of that rotation or any prior world effect.

Confirmed stopping does not establish the preceding game result. An input can break a block instantly or cause other effects, and a neutralization acknowledgement is not a block-state snapshot. Confirmed neutralization therefore claims no removal, unchanged state, rollback or policy-effect credit. Actual server removal evidence may establish successful completion instead. Raw protocol sequence values stay private. No old command is automatically replayed, and historical unknown records are not rewritten.

A long dig may retain the visibility proof captured at admission only while session/life, eye, supported pose, relevant chunk revisions, ray dependencies, block identity and reach remain valid. Unrelated chunk arrivals do not revoke that proof; unloading or replacing a depended-on chunk, resetting the world, changing life or losing revision history does. This proof does not refresh an observation or authorize a new target. Dig success still requires a subsequent server block update; local motor completion is insufficient.

### Run manifests and compatibility

Before strategic scheduling, a run manifest fixes `game_id`, `game_version`, `adapter_id`, `adapter_version`, selected observation profile/schema identities and versions, descriptor/schema hashes, enabled capability versions, verifier identity, state-support declarations, run/world/epoch, task, model/connection references, configuration and immutable library snapshot. Capture the actual negotiated support, not just a library's advertised features. Reconnection verifies these identities; an incompatible change requires an explicit migration/new attempt rather than silent continuation.

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

The [model-facing interface](#current-compact-program-interface) and its generated help own callable names and schemas. Dotted names in the later experience, trial and adapter sections label broader release obligations, not additional model tools or compatibility aliases.

Inputs require schema validation and role/capability authorization. Errors must not expose raw game objects, credentials, host stacks or forbidden facts. A retryable error permits bounded reconsideration, never blind effect replay. Registration/source revision stores an immutable artifact without gameplay effects; observation, catalog/source/history and comparison reads grant no activation authority.

Program admission returns durable execution evidence without holding the strategic turn open for the whole execution. A skill has its own `execution_id` and no foreground lease. `game.action` crosses the internal arbiter admission interface with a host-owned action ID linked to its execution. Parent programs never hold the leaf lease their children need. Policy activation uses a fenced scheduler boundary; promotion can create a later library snapshot but cannot mutate the current run's selected one.

Writing a revision does not mutate or automatically replace an in-flight execution. A deliberate replacement stops/drains the old execution through the normal action/lease rules and separately admits the immutable new version. Stopping a skill fences descendants and cancels outstanding leaf actions, waiting for neutralization or recovery. Tree-wide limits cover elapsed time, actions, calls and depth. Restart reconciles records without restoring JS stacks; later execution needs explicit new admission and cannot replay unknown effects.

### Idempotent skill admission and lost acknowledgements

The model supplies no `start_key`, execution/plan ID or idempotency field. The trusted facade derives retry identity from the actual tool-call ID and binds that call's validated input to one resolved exact request before admission. Repeat delivery of the same call reuses the binding/key; a new model decision is a new call, not a retry. Internal trusted callers retain their own stable admission key across transport retries and uncertain acknowledgements.

The runtime enforces durable uniqueness of `(run_id, start_key)`. In one transaction it stores the key, canonical original request and fingerprint, one `execution_id`, admission status and admission event. No worker dispatch or child action is allowed before that commit. Human-name selection is pinned in the original request rather than resolved again on retry.

After authenticating the caller's run scope, an existing key is compared with its original request. Identical content returns the original execution record without new dispatch, even if the first response was lost, the execution has finished, or recovery advanced the epoch. Different skill/version, arguments, limits, scope, or admission preconditions return `conflict`; they do not amend the original request. This historical lookup grants no current effect authority. A missing key must pass current epoch, lifecycle, compatibility, and precondition checks before new admission. An old-epoch request with no committed admission is rejected rather than dispatched after recovery.

After a lost response, lookup with the same run/key or an unchanged retry returns the committed identity. A pre-commit crash leaves no dispatched work; a post-commit crash leaves discoverable history. Recovery fences old generations and reconciles children, marking undispatched work cancelled and interrupted dispatched work unknown. It never restores stacks. A retry cannot resume, restart or extend execution.

Retain start-key mappings for the lifetime of the durable run record, including terminal executions and compacted conversation history. If that record is retired or deleted, the old run must reject starts rather than accepting a forgotten key as new work. A deliberate fresh execution requires a new key and normal admission; it cannot bypass unresolved prior effects or the foreground lease.

| Admission scenario | Required result |
|---|---|
| Committed start, acknowledgement lost | Lookup/retry returns the original execution; no second worker generation or child-action tree is created by the retry. |
| Concurrent identical starts | One durable admission and one execution identity; both callers observe that record. |
| Same key, different request | `conflict`, with no new execution or change to the admitted one. |
| Crash before admission commit | No execution is dispatched; any later admission still requires a current valid request. |
| Crash after admission commit, before or after dispatch | Original identity stays discoverable; reconcile cancelled/unknown without replay or stack continuation. Any later execution needs explicit new admission after fencing unresolved effects. |

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
| `preflight_ready` | Start admitted after host readiness and fresh authorized state; ordinary strategic work can begin. Historical cohorts used a `bootstrap` wake. |
| `task_changed` | Attributed task change has fenced prior strategic work. |
| `work_decision_needed` | A root program closes or another meaningful outcome requires strategy. A leaf result inside a pending program returns to its authored caller, not a strategic prompt. |
| `policy_replan` | A valid policy requests a strategic decision with source evidence. |
| `recovery_completed` | Reconciliation permits decisions; old epoch work remains fenced. |
| `uncertainty` | Same-session/alive unknown-effect reconciliation confirmed native neutralization, worker drain and fresh life-scoped observation; one new strategic generation may reconsider without replay. |
| `no_runnable_work` | No authorized work or meaningful wait can proceed without a decision. A continuing empty queue is not a fresh signal every tick. |
| `improvement_due` | A pending opportunity or bounded trial reaches its next eligible delivery/decision boundary. |

Persist scheduler `state` (`waiting`, `coalescing`, `in_flight`, `backoff`, `suspended`, `terminal`), `consumed_event_seq`, pending wake reasons/source refs, `turn_id`, `strategic_generation`, selected `context_through_event_seq`, attempt count, `consecutive_empty_turns` and any `next_eligible_at`/wait condition. `suspended` follows pause/recovery admission fences; `terminal` follows terminal run state. A successful turn records its decisions and advances the selected cursor in one durable commit. Events arriving after that selection remain pending. Cursor consumption does not erase unresolved opportunities or imply that an effect completed.

Signals within the coalescing window merge by reason/target. If a turn is in flight, signals join the next boundary; they never launch a concurrent prompt. A batch records its exact event interval, filtered observation basis, selected opportunity IDs, compatible experience summaries and truncation/pagination refs. Bounded context never means silently dropping an unconsumed interval. Drain a durable backlog in finite batches; coalesce redundant reasons, and retain source ranges for later reads. Do not poll the LLM on observations/ticks.

Pause, stop, attributed task change and recovery revoke the strategic generation and request provider cancellation where supported. A replacement strategic request waits until the old broker request completes, confirms cancellation or reaches its finite deadline; revocation does not permit concurrent strategic requests. Late output remains attached to its original turn and is rejected as obsolete; any already-admitted skill/action retains its durable identity and follows normal cancellation/recovery. A recovered unfinished turn is reconciled before retry: do not replay acknowledged mutations or effects under fresh keys. Stable `start_key`, action IDs and experience `mutation_key` survive retries and compaction.

An unhandled provider/tool-transport failure that prevents a valid turn outcome, or a missing required opportunity decision, leaves the selected cursor unconsumed. An ordinary tool rejection or failed game action that the model processes and responds to is outcome evidence, not an automatic failure of the whole turn. Retry only retryable turn failures within the configured finite attempt policy, with backoff. Exhaustion records an explicit external waiting condition (`provider_available`, new task/evidence, or operator intervention), not an immediate new `no_runnable_work` prompt.

A successful turn with neither runnable work nor a declared meaningful wait increments `consecutive_empty_turns` and arms one cooldown timer. Its expiry supplies an automatic `no_runnable_work` wake with the empty-turn evidence; no unrelated game event or human prompt is required. At the configured consecutive-empty limit, record `planning_stalled` and follow normal safe failure closure instead of waiting forever or repeatedly starting another allowance. Admitted work, a validated meaningful wait, or an attributed new task resets the counter; another empty response or retry does not. A declared meaningful wait has an observable condition and a finite deadline: satisfaction or expiry wakes the scheduler once. Repeated empty output cannot create a tight call loop, and quiet game state cannot strand an unfinished planning obligation. Reliability limits and safety deadlines are not dollar caps.

#### Autonomous Improvement Loop

The Autonomous Improvement Loop is another internal module of the same backend. It derives game-neutral opportunities from permitted timing/capability/error evidence and delivers them at the next eligible strategic turn; the strategist need not call `feedback.read` first. Runtime logic detects repetition and reports facts. It never chooses a game tactic or launches a second strategic model.

The detailed detector settings and opportunity lifecycle in this subsection specify the broader release contract. Delivered death/failure/outcome opportunities, named evidence inspection and source/assessment decisions are described under [bounded trace and revision evidence](#bounded-execution-trace-and-revision-evidence); the broader dotted catalogue is not a second callable API.

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

Triggers are repeated LLM-induced gaps; repeated capability/error or interruption patterns; repeated short capability sequences; a task/skill boundary with accumulated evidence; and a trial reaching its decision point. Count sequences as nonoverlapping occurrences in the contiguous ordered invocation stream. Missing timing classification stays unknown, not an invented LLM gap. The delivery cooldown applies per run to new analysis opportunities; a trial decision already due is not held behind that cooldown. Pattern detection and retrieval run in bounded batches outside the foreground effect path; gameplay is not paused for analysis. If pending capacity is full, retain the unprocessed detector cursor/source interval and record pressure; drain it as slots become available rather than dropping opportunities or prompting repeatedly.

Opportunity states are `pending`, `offered`, `in_trial`, `deferred`, `resolved`, `rejected`, or `superseded`. Delivery records `offered` and its `turn_id`; it is not acknowledgement. The strategic turn must return an `opportunity_decisions` entry for each offered ID: `decision` (`reuse`, `trial`, `keep`, `revise`, `retire`, `revert`, `defer`, `reject`), `reason`, `evidence_refs`, exact relevant artifact refs, and `trial_id` or `defer_until` when applicable. Retrieval through experience tools supports reuse; authoring/revision uses ordinary registration/validation and supplies a model-authored `hypothesis`, intended outcome/measurement refs, finite trial bounds and explicit prior-version-or-no-policy return selection. A keep/retire/revert decision cites actual trial outcomes or explicitly records missing evidence. A runtime or safety rejection is returned with reasons rather than fabricated success.

The optional `trial` descriptor on `skill.start` or `policy.activate` contains `opportunity_id`, `hypothesis`, `measurement_refs`, `max_ms`, `max_actions`, `max_evaluations`, and `return_selection` (exact compatible prior policy refs or explicit `none`). Admission allocates `trial_id` and stores its exact candidate/descriptor with the execution or switch intent before dispatch. At most one improvement trial may be open per run, including cancellation/closure pending; another returns `busy`. A matching skill-start retry returns its original trial as well as execution. A repeated activation for the same pending trial/version/expected selection returns its existing switch intent; different trial content conflicts. Host bounds cap model-requested limits, and a terminal trial ID cannot be reused to extend its allowance.

Persist acknowledgement/state changes with the turn outcome. `defer` records a finite next boundary/time and source evidence; it does not recreate the same opportunity every turn. `reject`/`resolved` consume that evidence window; only new evidence can create another. A task change or epoch transition marks obsolete opportunities `superseded` with reasons and retains their evidence. Restart restores offered-but-unacknowledged opportunities and acknowledged deferrals without rediscovering them from scratch.

One validated candidate may enter a bounded real gameplay trial without already having effectiveness evidence. Trial start durably links its hypothesis, exact source/card versions, opportunity, prior selection, measurement plan, start cursor and limits. Normal lease, cancellation, quarantine and stale-output rules apply throughout. At the first bound or declared decision point, stop new trial proposals/child submissions, fence outstanding evaluations, cancel trial skill execution through its ordinary closure handshake and restore the declared compatible prior policy selection or no policy. Record `improvement.trial_decision_due` and automatically wake the strategist to retrieve outcomes and keep, revise, retire or revert; decision-making may overlap cancellation, but new effects cannot bypass safe lease transfer. No automatic deadline extension or self-promotion is permitted. Safety quarantine remains host authority.

At that decision turn, the model also considers cross-session reuse: submit `experience.proposePromotion` for an intended reusable artifact set/startup bundle, or record an evidence-linked ineligibility, rejection or deferral reason. The trusted gate returns its durable result without requiring a human prompt or approval; a later warm run can select the resulting snapshot through its ordinary start configuration. Promotion never mutates the current run's selected snapshot. The learning protocol governs eligibility, and a before/after change alone does not establish causality.

### Bounded speculative planning

Lookahead is explicit opt-in for independent preparation while a root continues, not observation polling or a replacement for ordinary program substeps. Main selects it in the root-start `next` configuration. `after_ms` is 0–600,000; the flight permits 1–4 calls, 1–16 tools and 1,000–30,000 ms. There is at most one flight/draft per root and 256 opt-ins per run. Ordinary replanning takes priority and strategic provider requests remain serialized. Generated planning help owns the input schema.

After the selected delay, `budget.duration_ms` is one total deadline covering preparation, staging, predecessor wait, fresh guard evaluation and admission. Staging, correction, predecessor closure or automatic activation cannot extend it. Main must select timing that leaves enough actual predecessor work and time for fresh admission.

Root-start preparation checks live alive scope before durable admission, then arms once before execution handoff returns. Omission means no planning call or permit. A transport retry returns the original admitted execution without arming again. Internal late opt-in cannot mint automatic authority.

The speculative role can observe, inspect authorized evidence, read help and `prepare_next`. It selects an existing named candidate and optional exact version; it cannot write/revise programs, activate a successor, change policies/memory or emit game effects. Main authors candidates before starting the predecessor. One shared role registry controls advertised tools and dispatch authorization; hiding tools alone is insufficient.

Staging pins the selected exact version's canonical source hash and full bounded dependency closure inside current run/model scope. Names never rebind an admitted candidate to today's latest version. Validation checks exact identity, validated state, SHA-256 bytes and dependency hashes; missing, invalid or changed sources produce inspectable typed rejection. The host repeats closure checks around fresh observation, guard evaluation and durable admission.

`guard_source` is an **optional async JavaScript body** with only `observation` and `args` bindings. `observation` is freshly obtained and authorized; return a strict boolean. There is no outer function/arrow, task prose, runtime candidate/source reference, predecessor metadata or mutable policy-state binding. This is a model gameplay constraint, not a place to restate system safety.

Omission records `guard_status:"omitted"` and a null hash; it does not fabricate a successful evaluation. Host invariants and a fresh observation still apply. A supplied guard is statically validated, evaluated in isolated read-only execution and recorded as pending/passed/failed/error. False, nonboolean or error never grants effects, and the host never repairs source automatically.

The host exclusively checks current run/generation, unchanged task/goal, session/world/epoch/life, exact predecessor identity and successful outcome, confirmed predecessor worker/action drain, source/dependency closure, deadline, cancellation and exclusive admission/effect ownership. A program-return `completed` summary is not the execution's trusted `succeeded` outcome or goal verification.

Main chooses `activation:"manual"` (default) or `"on_predecessor_success"` in root-start configuration. Only that Main decision can mint one permit bound to the predecessor and full authority scope. The speculative role cannot mint, expand or renew it. Manual `program_run` activation remains a deliberate Main choice.

Automatic activation waits for both a validated staged candidate with planning settled and a successful predecessor with confirmed drain, in either arrival order. A trusted host task consumes the permit once, obtains fresh observation, evaluates any guard and uses ordinary durable admission. It rechecks authority after awaits and at admission. The scheduler joins this task rather than asking another model to activate or racing an obsolete predecessor-outcome turn.

Stop, Pause, death, task/session/generation changes, failed/unknown/cancelled predecessor, source changes or expiry revoke continuation authority. Rejections preserve evidence and wake ordinary planning once; they do not silently retry, admit an alternative or replay uncertain effects. New programs resolve targets from fresh observations rather than copied stale handles.

Recoverable guard syntax/compactness errors may carry a bounded `stage_correction` allowance for an explicitly authored correction on the same flight. Only the whitelisted source-validation issues qualify; unsafe ambient access, stale authority and expiry remain terminal. Correction resets neither counters nor deadline. Rejected guard chunks/hashes, issues and omissions remain evidence; missing historical source cannot be reconstructed from a syntax location.

`PlanProjection` retains guard omission/result, activation mode/permit/trigger, predecessor closure, pinned candidate, observation and activation evidence. Read it through planning inspection. Record requests, overlap, validation/rejection, admission and usage; `overlap_ms` is not causal speedup. The [integration evidence](integration-spike.md#verification-scope-after-the-published-checkpoint) separately scopes the old manual baseline that opened the edit gate and the later zero-inference native continuation proof; neither establishes natural-model efficacy.

After a verified goal, one bounded effect-free review can use at most three calls, twelve tools and 30,000 ms under the improvement request purpose. It can inspect evidence/source and author linked candidates before completion. It cannot start further gameplay trials after the user's goal is satisfied.

### Action admission and outcomes

An action request records:

- Identity and scope: schema version, manifest/game/adapter/profile identity, run/world/epoch and action ID.
- Origin: owning skill execution or policy/version/evaluation; declared capability/schema and explicit arguments. Historical strategist-origin records remain evidence only; new ownerless or direct-strategist effects are rejected.
- Scheduling: bounded declared priority, submission order assigned by runtime, finite queue deadline, finite execution duration, and preemption/cancellation rules.
- Basis: observation sequence, maximum basis age, relevant revision tokens, and typed preconditions.
- Evidence: admission/start/end timestamps, lease generation, state, partial effects and result references.

Each internal action invokes a bounded effect capability. Current `GameAction` types implement Minecraft; the extension target delegates schemas to each adapter rather than imposing a universal enum. Limits, cancellation and success evidence belong to that contract; tactical parameters come from the authored program/reaction, not infrastructure. Skill invocation remains a distinct core operation whose leaf effects cross this internal interface.

Revising an action means cancelling it and submitting a new ID with `supersedes_action_id`; the new job waits for safe lease transfer. Submitting the same ID and identical canonical request returns its existing ledger record without redispatch. Different content under that ID returns `conflict`. Retrying a lost submission first looks up that ID. Neither deduplication nor SQLite can guarantee exactly-once game effects across a crash.

| Action state | Allowed next states / meaning |
|---|---|
| `accepted` | `running`, `cancel_requested`, `failed`. The job is durable but owns no effect lease yet. Expired or invalidated queued work fails with a reason. |
| `running` | `succeeded`, `failed`, `cancel_requested`, `unknown`. Only this state may hold an executing lease. |
| `cancel_requested` | `cancelled`, `succeeded`, `failed`, `unknown`. A completion may win the race; evidence determines the result. |
| `succeeded` | Terminal: declared completion evidence was observed. It does not prove the larger task succeeded. |
| `failed` | Terminal: known failure with partial effects recorded. Failure does not imply zero effects. |
| `cancelled` | Terminal: the declared cancellation procedure established that no emitter remains and controls are neutralized. Prior effects remain recorded, including explicit unverified effects; cancellation is not successful completion or rollback. |
| `unknown` | Terminal uncertainty: declared completion or safe cancellation could not be established, or a submitted completion remains unresolved. Recovery fences the emitter; uncertainty remains in the ledger. |

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

Managed replacement waits beyond native cancellation and any owning worker drain: `ActionArbiter.awaitRetirement` observes the captured action pump actually clear `current` and advance its lease. Only then capture the settled lease, await final native neutralization and recheck generation, life, selected policy slot, worker state and lease before admission. The same retirement gate applies to direct policy-to-policy replacement without a skill worker. Cancellation itself must not await pump retirement, because the pump waits for cancellation; keeping these barriers ordered avoids a wait cycle. This is internal sequencing, not another GameAPI capability or a latency/effectiveness claim.

### Freshness at dispatch

A response is eligible only when all of these hold at the final effect gate:

1. Run, session, world, connection epoch and player life still match the authorized live session; ordinary effects require `life.status:"alive"`.
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

The implemented Jev caller uses the broker's selected bundled TypeSafe judge, never the strategic run's model ID. Trusted `JevBrokerOptions.model_id` can select another supported bundled judge (`api:"typesafe"`, `kind:"judge"`, TypeSafe base URL). `GET /v1/jev` reports `state:"unavailable"|"configured"|"closed"`, redacted `models`, and `selection:{model_id,request_timeout_ms}|null`; selection is present only when configured. Configured means an app-owned key is stored, not verified service connectivity or entitlement.

Current limits are two concurrent requests, 60 requests/minute, one actual attempt, no queue, broker maximum 10,000 ms and effective reactive deadline 2,000 ms (`selection.request_timeout_ms`). The maximum is not the effective policy timeout. Missing credentials fail `backend_unavailable` before sending; no local or fake-provider fallback is substituted. Cancelled requests retain their concurrency slot until actual transport settlement. Life changes synchronously fence and drain JS/Jev evaluations and execution state while preserving definitions, evidence and absolute trial budgets; old-life answers cannot activate after respawn.

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

The host performs readiness preflight: connected matching world/session, provider authorization, isolation readiness, a fresh authoritative observation and current life/scope. It enters `running` before ordinary strategic scheduling. The short system instruction states task, authority, program workflow and limits; generated help supplies details on demand. It contains no developer game tactic and requires no model ceremony to confirm host-known facts.

Earlier cohorts used an explicit `bootstrapping` phase capped at three calls/60 seconds. That history remains interpretable but is not a current mandatory preparation quota. Measure actual accepted-start, host preflight, entry to running, inference/authoring and first confirmed effect separately; do not invent a bootstrap interval for a run without one.

A logical strategic call is one inference request for a context; a tool continuation requiring inference is another logical call. Record transport attempts separately where actually exposed; otherwise preserve that uncertainty. Failed responses cannot reset finite request/turn/run allowances. Cold and warm conditions receive equal capabilities, reference access and declared bounds; only inherited compatible experience differs. Validation permits a bounded trial but proves no efficacy.

### Warm startup hydration

The broader release startup-bundle contract requires an immutable model-authored selection with exact programs/cards/dependencies, applicability, compatibility, provenance and supporting evidence. It is distinct from the current named program snapshot load; no arbitrary bundle implementation follows from this specification. The selection is the model's, not a runtime tactical rule. Initial context stays bounded; unselected source remains behind selective reads.

The host checks snapshot/model identity, hashes/provenance, current task/profile applicability, dependency compatibility, source security, current quarantine/security-revocation status and permitted information scope. A frozen snapshot cannot override a safety rejection. Rehydrate eligible exact versions into fresh run-local state; never restore another run's evaluation generation, effect lease or world-local state. Cached validation is reusable only when its source/runtime/isolation/adapter/profile/schema/capability identities match. Otherwise revalidate within declared finite limits and record the miss/rejection. Revalidation cannot turn incompatible historical evidence into current-profile gameplay proof.

For entries whose evidence meets the [reuse/promotion policy](learning-and-evaluation.md#selective-retrieval-and-autonomous-promotion), ordinary fenced activation need not regenerate source or repeat already-qualified tactical trials. Selection emits no game effect; effects require `running`, fresh authorized state, lease and adapter checks. A compatible warm selection can need zero strategic authoring calls. Inherited evidence does not establish useful current-run behavior before an eligible real outcome.

Emit hydration, validation/cache and activation outcomes. Missing, incompatible, quarantined, inapplicable or expired entries remain visibly unselected with reasons; ordinary scheduled authoring may choose alternatives within remaining limits. Never silently swap snapshots, manufacture an empty warm library, reset an allowance or install handwritten fallback behavior. Record total time, actual calls/available attempts, retrieval, validation/cache status, activation times and first confirmed effect for both arms.

Every worker invocation, skill execution, action, provider request and trial has a finite deadline and finite admission limits. Queue capacity, CPU/memory/output limits, dispatch/evaluation rates and provider concurrency are reliability controls, distinct from monetary accounting. Expiration fences late output and triggers cancellation, quarantine or explicit failure as appropriate. The runtime never waits indefinitely for generated code, a provider, or a policy-registration loop.

## Run controls and UI events

Authenticated HTTP JSON/SSE connect the Electron renderer to its owned backend. A separate same-origin authenticated `/v1/video` WebSocket carries native binary frames, never game input. The UI exposes task, run selection, providers, start, pause, resume and stop. Auth stays in the trusted [operating flows](operations-and-security.md). Start captures game/adapter/profile, task, world, model, capabilities and immutable snapshot identities. Task edits are attributed interventions that fence obsolete work, never rewrite task history.

Current controls require an authenticated local session, CSRF token and stable `request_id`. The host validates current lifecycle and fences effect generations. Matching retained request IDs return the same result; changed commands conflict. A sent request or pending acknowledgement does not establish safe completion.

Current HTTP interfaces include:

| Method and route | Contract |
|---|---|
| `GET /v1/ready` | Loopback desktop readiness `{ready,instance}`; the shell compares its private nonce. No control or run data authority. |
| `GET /v1/state` | Authenticated app snapshot including source/cards, skills, executions and usage. |
| `GET /v1/performance` | Authenticated operator CPU/RSS/sample-window, event-loop/observation/action-round-trip/video-forward diagnostics and native metadata. Not an agent capability or dispatch-latency claim. |
| `GET/POST /v1/config` | Persisted operator `{motor_profile:"precise"|"balanced"|"fast"}`; applies live independently of task/model gameplay. |
| `GET /v1/runs` | `{runs}` retained run summaries. |
| `POST /v1/runs` | `{task,goal,model_id,experience_id?,working_programs?}`; optional exact SHA-256 snapshot and same-session `"continue"|"fresh"` selection. Creates a run, not game effects. |
| `GET /v1/runs/{run_id}` | Authorized retained run projection. |
| `GET /v1/runs/{run_id}/events` | Bounded JSON history with cursor and explicit omitted details, not SSE. |
| `GET /v1/runs/{run_id}/skill-evidence` | `{evidence}` linked program/execution/action results. |
| `GET /v1/runs/{run_id}/trace` | Cursor `after`, `limit`, optional `execution_id`; bounded actual execution/root trace. |
| `GET /v1/runs/{run_id}/improvements` | Independent `after_opportunity=0`, `after_execution=0`, `limit=32` cursors; opportunities and objective metrics with structured `next_after`. Legacy numeric `after` is rejected with 400. |
| `GET /v1/runs/{run_id}/deaths` | Cursor `after`, `limit`; `{episodes,next_after,has_more}` with last authorized context. |
| `GET /v1/runs/{run_id}/planning` | `{plan}` bounded lookahead projection. |
| `POST /v1/program-comparisons` | Exact `before`/`after` `{run_id,skill_id,version,hash}`, optional `after_sample`, `limit`; `{comparison,next_after,has_more,omissions}`. Read-only evidence computation behind mutation authorization, not gameplay. |
| `POST /v1/runs/{run_id}/controls` | `{command,request_id}` with command `start`, `pause`, `resume` or `stop`. |
| `GET /v1/events` | Authenticated live SSE activity. |
| `GET /v1/video` | Authenticated same-origin binary RGBA WebSocket; no input forwarding. |
| `GET/POST/DELETE /v1/jev` | Private Jev configuration/status; existing keys never echoed. Configured is not connected. |
| `GET /v1/experience?model_id=…` | Compatible snapshot metadata `{experience}`. |
| `POST /v1/runs/{run_id}/experience` | Explicit evidence-gated promotion declaration, not arbitrary library mutation. |

A current control body is:

```json
{
  "request_id": "control_example",
  "command": "pause"
}
```

The route supplies `run_id`. Invalid transitions conflict; unknown IDs do not create runs implicitly. Pause/stop remain pending until safety conditions hold. The broader release contracts still require attributed task changes, durable improvement disposition and selective knowledge/history; this table does not invent routes for undelivered behavior.

| Run state | Permitted transitions |
|---|---|
| `created` | `running` after admitted host preflight establishes readiness and fresh state; `stopping` on stop; `failed` on unrecoverable admission failure. |
| `bootstrapping` | Retained historical phase, not entered by the current host-preflight start. Historical completion/expiry and lifecycle outcomes remain readable. |
| `running` | `pausing`, `recovering`, `stopping`, `reviewing`, `completed`, `failed`. Normal death changes player life, not run state. Verified completion requires objective evidence and no live effect lease; model-reported custom completion instead requests `stopping` → `stopped`. |
| `reviewing` | Effect-free bounded model review after verified goal; `completed`, `stopping` or `failed`. No further gameplay trial is admitted. |
| `pausing` | `paused` only after admission is fenced and controls neutralized or the declared adapter safety fence is established; otherwise `recovering`, `stopping`, `failed`. |
| `paused` | `running` on deliberate resume after fresh observation; `recovering`, `stopping`, `failed`. Resume restores neither old JS stacks nor a fresh evaluation allowance. |
| `recovering` | `running` or `paused` after reconciliation; `stopping`, `failed`. Prior pause/stop intent is preserved. |
| `stopping` | `stopped` after confirmed input neutralization, worker/planner/action drain and durable run closure, retaining a healthy game session. This includes operator stop and model-requested custom-task closure, not verified task success. `recovering` if fencing certainty is lost; `failed` if recovery cannot establish safe closure. Stop intent survives recovery. |
| `stopped`, `completed`, `failed` | Terminal run records. A later new attempt has a new run ID; evidence can still be appended as reconciliation/intervention events without reopening effects. |

Pause stops action admission, revokes pending inference/evaluations, cancels skill/action execution, establishes neutralization or the adapter's required safety fence, and records the operator intervention. `paused` describes agent-control safety, not a universal game-world freeze. The adapter declares whether the environment keeps running, disconnects, or supports explicit world pause; the UI displays actual behavior and consequences. No hidden survival behavior is installed. Explicit world pause is an attributed intervention and must never conceal inference latency. Resume reobserves authoritative state with new execution generations and decisions rather than replaying queued commands. Model latency during normal play is not manual pause.

Stop has highest priority, closes admission, fences generated work and provider callbacks, and confirms neutral controls plus run-emitter drain. It keeps a healthy playing session and video connected. A transport disconnect or crashed emitter is recovery, not proof of immediate neutralization; establish actual fence/termination before claiming safe closure. Explicit Stop world, world replacement and application close own session/process teardown; stopping a run does not silently destroy them.

Required event families are run state/intervention, observation availability, action admission/state/outcome, skill execution, policy validation/trial/switch/quarantine, model decision/attempt, provider availability/auth status, runtime feedback, checkpoint/recovery/rollback and diagnostic status. Each event links to source records. The activity feed distinguishes queued, executing, awaiting inference, meaningful game wait, cancellation pending, disconnected/recovering and paused states. UI explanations cite plans, tool decisions and actual events; they do not claim access to hidden chain of thought.

The live activity surface includes a minimal improvement card: `opportunity_id`, `reason_code`, model-authored `reason`, exact `previous_artifact_ref`/`candidate_artifact_ref`/`selected_artifact_ref` when present, exact `card_ref`, model-authored `semantic_change_summary`, `trial_id`, `measurement_status` (`not_yet_measured`, `measured`, `unknown`), outcome summary and authorized `evidence_refs`/source-event refs. Show the actual switch state, not a proposed edit as an effective change. Keep/revert/failure/no-effect outcomes remain visible. Expand the StrategyCard and permitted evidence inline or through the read routes; a full library browser/editor/replay is not required. The UI may show authorized generated source as bounded, escaped, non-executable text. Viewing it cannot run code, install or activate a policy, widen capabilities, or disclose another run's data, secrets or privileged evaluator inputs. Model-authored markup/scripts must not execute in the operator origin; a ref is not filesystem or arbitrary URL authority.

Canonical additional events are `improvement.opportunity_created`, `improvement.opportunity_updated`, `improvement.opportunity_delivered`, `improvement.opportunity_decided`, `artifact.authored`, `policy.validation_completed`, `improvement.trial_started`, `improvement.trial_decision_due`, `improvement.trial_decided`, `policy.activation_effective`, `experience.bundle_hydration_started`, `experience.bundle_validation_completed`, `experience.bundle_activation_completed`, and `experience.promotion_decided`. Each carries its applicable turn/opportunity/trial, exact artifact/card/bundle refs, status/reason and source evidence refs in the common durable envelope. A trial-decision event records the model's keep/revise/retire/revert choice separately from the eventual activation-effective event. Bundle validation events include `cache_hit` and validation identity refs; bundle completion lists per-entry effective or rejected outcomes, not an unconditional “warm success.”

SSE uses durable `event_seq` as its reconnect cursor and delivers at least once. The browser deduplicates by run/event sequence and treats events as ordered evidence, not executable instructions. On an unavailable/expired cursor the backend returns an explicit resynchronization requirement and current status plus a new event cursor; it does not imply uninterrupted delivery. Browser disconnection alone is not a pause; backend health and authoritative controls govern the run, and the UI marks its view stale.

## Feedback and evidence

### Bounded execution trace and revision evidence

[`src/shared/execution-evidence.ts`](../src/shared/execution-evidence.ts) defines the implemented trace, death episode, improvement, working-program and comparison records. Trace attributes execution/root/parent, exact program/version/hash, session/life and available call/action/observation/event IDs. Kinds are `capability_request`, `capability_result`, `observation`, `branch`, `intent`, `span` and `omission`. Only profile-authorized public observation snapshots enter it.

Branch records describe actual instrumented JavaScript condition decisions with source locations. Canonical model-authored source/hash remain immutable; instrumentation must preserve evaluation order, short-circuiting and await behavior and grants no authority. Trace is not chain of thought. `game.progress` produces labeled model-authored intent; neither intent nor a branch explains why the model chose a target or proves success.

`Store.tracePage(runId,after,limit,executionId?)` pages execution/root records within 65,536 bytes. Payloads over 24,576 bytes become explicit omissions with original size. Per-run storage is bounded to 8,192 records/8 MiB; counters retain omitted records/bytes. Default page size is 100. Death episodes retain last authorized context and action/root/event references through their own bounded pages.

Known source-branch omissions and uncertain `tail_incomplete`/`loss_reason` both mark diagnostics incomplete. Missing trace cannot erase independently confirmed gameplay receipts. Death episode and source event commit atomically before subscriber notification.

Attributed spans distinguish `native_action`, `dispatch`, `receipt`, `readiness`, `sandbox`, `capability_wait`, `strategic_request`, `scheduler_handoff` and `life_recovery`. Same-process monotonic durations are measurements; cross-process correlation and absent spans require explicit uncertainty. A long action round trip is not automatically dispatch delay or LLM idle.

Durable opportunities link death/failure/outcome evidence to exact versions. `program_inspect` feedback selects authorized named evidence with independent opportunity/execution cursors. `program_review` records `keep` or `insufficient_evidence` for the latest matching named outcome. `program_write` with `based_on` and an explicit experiment `reason` links an actual direct-child revision to latest unresolved parent feedback, without a second bookkeeping-only request.

Persisted resolution records retain `revise`, `keep` and `insufficient_evidence`: the host supplies exact parent/revision/model/hash and source events rather than asking the model to copy them. A linked revision is a chosen/performed candidate experiment, not verified improvement, adoption or promotion. Internal `revise` requires an exact revision reference; assessments carry no revision. Invalid linkage cannot persist a fabricated resolution, and an immutable conflicting decision is rejected. Historical resolution records retain their original IDs and semantics. Opportunity and feedback storage remain bounded; the broader release detector remains a requirement where not delivered.

`insufficient_evidence` limits the strength of an improvement claim, not permission to author and try a bounded candidate while the goal remains unsatisfied. Repeating an unchanged blocked program under unchanged conditions supplies no new outcome evidence. Generic experiment guidance does not supply game tactics, relax source limits, modify the model's historical source or permit effects after goal success.

Objective comparison reports confirmed block removals by registry identity, receipted own-inventory deltas, target-ID/position switches, sampled and receipted travel/rotation, attributed timings, sample counts, outcomes and trace limitations. No generic rule labels every extra block unnecessary, infers tree identity or invents a reason for changing target. `VersionComparison` includes exact source/card differences and bounded sample pages; its conclusion is `descriptive_only_no_causal_improvement_claim`. Unmeasured revisions are candidates; measured observations still do not establish causal benefit.

Measured status requires actual dispatch (`started_at`), not merely an accepted then cancelled execution. Sampled native yaw/pitch are converted from radians to degrees using shortest-angle deltas. Strategic comparisons use trusted current-run/model scope before source reads; the separately authorized operator route explicitly selects operator scope rather than trusting caller-supplied scope.

`feedback.read` and UI events expose source-linked progress and failure, not inferred success from fluent explanation. Records distinguish model decision latency, provider attempts/retries, runtime dispatch and reaction latency, action duration/outcome, blocked planning, interrupts, meaningful game waits, LLM-induced idle time, queue pressure, backend errors and actual usage. Gameplay evidence includes objective/subgoal changes, failed actions, deaths and observed consequences. [Learning and evaluation](learning-and-evaluation.md) defines aggregation and Time to Fluidity.

Record unavailable measurements as unknown. Include active policy/skill versions, action IDs, observation basis, evaluation rejection reasons, intervention/downtime intervals and unknown effects so investigators can reconstruct why a control was or was not issued. Diagnostics must not bypass observation permissions; privileged result verification remains separate from planner context, generated programs and reusable memory.

Timing evidence records accepted start, transition to running, strategic authoring-request admission, opportunity creation/delivery/acknowledgement/deferral, source/card authoring, validation admission/completion, activation-request acceptance/effective switch, trial bounds/decision/closure and first confirmed current-run effect/outcome. Link each timestamp to its event/process/epoch clock and record clock discontinuities rather than subtracting unrelated monotonic values. Track trigger opportunities, actual admitted policy uses, rejected proposals, revision counts, retrieval/cache outcomes and full sample sizes. The [learning protocol](learning-and-evaluation.md#policy-acquisition-and-revision-evidence) defines derived metrics and useful-policy evidence; control timing and task efficacy stay separate, with before/after correlations explicitly distinguished from controlled evidence.

## First integration: Minecraft Java Normal Survival

The profile targets Minecraft Java 1.21.4 Normal Survival, one avatar, ordinary spawn/inventory/death rules and no agent cheats/operator privileges. An actual Java 21 Fabric client owns raw state, filtered perception, smooth motors and post-HUD video. The managed Fabric server requires session proof; matching names, offline whitelists or player caps are insufficient. Control binds private session/world/epoch authority separately from video. Transport loss fences effects and neutralizes controls before renewed authority. No old-adapter fallback is allowed.

### Player-observable structured profile v1

The required profile is `observation_profile_id: player-observable-structured`, version `1`, delivered as structured state/events. Native conformance needs its own retained proof; old-adapter fixtures do not transfer automatically. It is a declared structured-information approximation, not human-identical perception or a zero-leakage guarantee. A stricter camera profile is optional.

Nearby unobstructed blocks/objects and entities may be observed within the configured finite range, regardless of camera yaw/pitch. A nearby tree behind the camera is eligible; rotating the camera alone does not revoke it. Obstruction/occlusion, range, loaded-client availability and bounded sampling still apply. This permission neither reveals all loaded chunks nor removes walls. The initial sampling rules below have no camera cone.

The profile permits normal F3 position, own health/status, inventory/UI, public recipes/docs and legitimate world-local memory. Hidden resources/structures, exact live concealed entity state, seeds, saves and evaluator state remain unavailable. Raw native world/chunk/entity collections and renderer buffers are not agent APIs. The trusted adapter's possession of client state for perception/physics grants no broader strategist, generated-program, retrieval, library, log or error access.

| Profile configuration field | Initial preset: `minecraft-observable-initial-r2` |
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

These are chosen engineering defaults, not measured performance or a claim of universal adequacy. Before run admission, expand the preset into the full effective `observation_profile_config`; fill omitted optional settings from this preset, never leave a limit unspecified. Record the preset ID, profile version, exact values and algorithms below, target game/registry and geometry-data revisions, and any explicit overrides. Fingerprint that expanded configuration with SHA-256 over RFC 8785 canonical JSON, and retain both configuration and fingerprint in the manifest. Overrides change the fingerprint and must remain fixed in matched comparisons; a changed algorithm needs a new preset revision. Loaded state and eligibility further restrict access; neither radius authorizes its whole volume.

Revision r2 adds schema-2 session/life lineage and the permitted optional `item_name` on current eligible item entities. It preserves the camera-independent structured line-of-sight permission and all existing range/occlusion/age/output bounds; it does not introduce camera-frustum filtering. `item_name` is only the registry identity of a visibly represented nonempty ItemEntity stack. Other entities cannot carry it. Exact dropped-stack count, NBT, custom/lore data and concealed item identity remain unavailable.

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

Current observations retain their capture time, eye position and target/read-cell dependencies. Recheck these dependencies before publishing a completed check and before returning a current record. An eye-position change, target-state change, relevant occluder update, dependent chunk unload or age over `1,000 ms` invalidates current eligibility immediately; camera-only rotation does not. Entity motion invalidates its current record without updating its last-seen position from raw tracking. Session/life/epoch/world/rollback-branch/profile changes invalidate current handles and partial scans. A new epoch/profile starts both scan cursors from the beginning; unavailable state, disconnected transport or uncertain dependency revisions remain unknown until freshly reconciled and sampled. Remembered facts retain only their last authorized projection and provenance. TTL expiry, record eviction or a missed sample is not evidence that an object disappeared.

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

Native pathfinding and every helper library must enforce geometry projection and local envelope/goal rules. Full raw-world access followed by filtering the returned route is insufficient. Conformance audits internal reads and real effects: known-target movement without an all-voxels-observed map, same-geometry concealed ore/stone substitution, unknown-target rejection before lookup, and refusal to select hidden caves/shortcuts as routes. Controlled fixtures are not gameplay evidence or reusable experience.

Paper Anti-Xray is optional defense in depth, never the sole filter; these permissions must hold with it disabled. It does not protect entity information or every hidden-data channel. Record vanilla/Paper flavor, exact game/server build, enabled status and effective per-world/dimension Anti-Xray settings (mode, block lists, heights and update options applicable to that version), ideally with a configuration snapshot/hash, in experiment evidence outside agent permissions. Freeze those settings in matched comparisons; masked/false ores are not genuine discoveries. No Paper setup or tested compatibility is claimed here; see [upstream evidence](upstream-reuse.md#structured-observation-and-navigation-evidence) for version-specific limits.

### Minecraft mechanics and lifecycle

Initial capability schemas cover bounded movement/input/look, interaction, dig, place, craft, equip and navigation under the profile above. Parameters explicitly select targets, recipe/item identifiers, quantities, slots and other tactical choices. The bridge rechecks reach, profile-authorized target validity, inventory, UI session and terrain constraints immediately before effects; any game-required aiming is an action constraint, not a camera-cone observation filter. Coordinated movement/look/attack may be one bounded composite action, never independent foreground leases. An A* motor must obey the private local-geometry contract; it cannot discover hidden targets or higher-level routes. No handwritten collect-wood, explore, survive, fight or complete-game routine is supplied.

Motor profiles are `precise`, `balanced` (default) and `fast`, configured by the operator independently of gameplay through `GameBridge.setMotorProfile(profile)`. Persisted selection applies live without restart. Balanced starts with yaw/pitch limits of 480°/s and 300°/s and adaptive large-turn/small-settle control; these are configured limits, not measured achieved speed. One render-monotonic integration clock avoids double tick/render integration, using shortest yaw and bounded settling without overshoot.

`look` and `move.look` remain explicit free orientation. `navigate.gaze` is optional: `{kind:"navigation"}` by default, `{kind:"target",target_id}` or `{kind:"free",yaw,pitch}`. Default gaze samples bounded actual local route geometry, interpolates a near-route point and adds eye height so flat ground stays level and slopes affect pitch mechanically. Target interactions use target gaze. Movement gating uses yaw rather than pitch; free/target gaze must preserve world-direction travel through legal strafe synthesis. `navigate.range` allows 0.5–4 blocks for ordinary approach precision, not an automatic pickup tactic. Camera/navigation speed and useful-play improvements require new measured evidence.

For native movement, release motor controls at the declared duration before one ordered own-server inventory receipt. Only an actual authenticated receipt can mark inventory confirmation. A missing receipt at the bounded three-second deadline leaves the effect `unknown`; it cannot be replaced by local prediction or a fabricated confirmation flag. A separately confirmed native neutralization barrier can retain a healthy session/video without claiming effect certainty. Only unconfirmable control/emitter safety requires fail-closed client closure before renewed authority.

Cancellation stops the motor/navigation task, releases held inputs and obtains neutralization acknowledgement; if that cannot be established, the bridge emitter must be fenced/terminated and recovery entered before a new lease. A lost craft/place/consume result stays uncertain rather than triggering blind repetition. Domain revision examples include pose, target validity, inventory-slot contents, UI session and the authorized navigation goal/corridor plus controller envelope; unrelated observation updates do not invalidate every slow result.

The default operator pause, Stop run and verified goal closure leave a healthy avatar session connected with neutral controls while the world keeps ticking; survival is not guaranteed. Ordinary death uses the separate life gates above, never automatic respawn or a terminal client error. Explicit Stop world, world replacement and application close end owned session/processes. Minecraft save/flush, backups, reset and restoration require separately declared server support and consistency procedures in [operations](operations-and-security.md#first-integration-minecraft-server-and-saves). No universal atomic save or deterministic rewind is implied.

The `break_log` goal requires one server-confirmed removal of an eligible log during the run. `collect_wood` requires own receipted wood inventory gain from that run's starting baseline; removal alone cannot satisfy it. Keep explicit verifier-evidence variants for block removal and inventory gain. Death does not reset the run-start inventory baseline; a new task/run creates its own baseline.

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
