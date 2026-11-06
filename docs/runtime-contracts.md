# Runtime contracts

This document distinguishes the current named program-workspace interface from the ordinary-module and recovery target. The [current program interface](#current-compact-program-interface) owns callable tools; later conceptual dotted names describe requirements, not aliases. The [integration guide](integration-spike.md) owns operating commands, source cohorts, observed evidence and limitations. Implementation below does not claim a new full proof. The [PRD](prds/gameharness-v1.0-prd.md), [architecture](architecture/overview.md), [evaluation](learning-and-evaluation.md), [operations](operations-and-security.md) and [upstream evidence](upstream-reuse.md) define the related boundaries.

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

The principal model owns strategy, procedure construction and repair. Disclosed mechanical helpers may execute a selected movement, aim, GUI transfer or recipe under the same broker and observation profile. They cannot hide recursive resource gathering or task completion behind a mechanics call. Richer authored controllers require their own declared assistance/comparator condition and provenance.

GameHarness must be language-agnostic at component boundaries. Performance-critical components may be implemented in native languages without modifying the agent runtime, skill format, or game adapter contracts. Versioned bounded data, explicit deadlines/cancellation and authority checks remain stable across language changes. TypeScript orchestration, Java Fabric perception/motors/capture and generated JavaScript skills are distinct responsibilities; an optional measured Rust optimization cannot introduce a second skill format or bypass the adapter.

The implementation separates `Runtime` lifecycle/observation/goal authority from `ActionArbiter` (`action-arbiter.ts`), `ReactiveRuntime` (`reactive.ts`), `StrategicPlanner` (`strategic.ts`), `RuntimeTools` (`runtime-tools.ts`), `SkillManager` (`skills.ts`), `ExperienceLibrary` (`experience.ts`) and program evidence (`program-evidence.ts`). Each owns its state and enforcement responsibilities; `runtime-prompt.ts` holds authoring instructions. The public runtime API remains the composition seam, not a per-tick gameplay engine.

## Ordinary modules and recovery target

The required program format is ordinary bounded JavaScript modules with relative local imports, a controlled resolver for declared pure libraries and a `run(game, args, checkpoint)` entry. Local pure calls share one isolated execution; a function call does not require another container. Source/bundle bytes, initialization transport, memory, CPU and capability budgets remain finite. These requirements do not grant generated code package installation, arbitrary imports, network, host files or process creation.

The agent can observe, write/edit, run, inspect and revise without filling out an artifact form first. The host supplies stable identities, timestamps and scope. Detailed cards remain useful views and reusable-artifact evidence, while a claimed intent is not a verified result. Optional Jev and registered reflexes may help execution; neither is mandatory ceremony for the first complete autonomous chain.

Checkpoint recovery uses versioned serializable task state and unresolved operation references, not saved JavaScript stacks or promises. Resume requires compatible source/state, fresh authorized game state, fenced prior owners and actual neutralization/drain. Preserve explicit Pause/Stop and uncertain effects; restoring source or conversation never rewinds the game. Ordinary modules and checkpoint recovery remain later implementation work. The current body and restart contracts below remain the delivered interfaces until their cutover.

The active perception profile is `minecraft_assisted_rgb_360_r8_control_v4`, with observation envelope 3, current-visible-screen and controller-feedback reads, and a separate typed actor PNG. World sampling retains the prior eight-block permissions; controller feedback includes own-body, actual-heard events and input-application facts. The broader perception target separates `assisted_rgb_frustum_v1`, an assisted 360-degree comparator and a later strict-visual condition. Those complete comparison profiles and atomic capture-time synchronization remain undelivered; the current eight-block profile does not stand in for them.

## Current compact program interface

Executable types live in [`src/shared/programs.ts`](../src/shared/programs.ts); model inputs in [`src/server/program-interface.ts`](../src/server/program-interface.ts). [`RuntimeTools`](../src/server/runtime-tools.ts) applies role/schema authority, [`ProgramOperations`](../src/server/program-operations.ts) owns use cases and [`ProgramWorkspace`](../src/server/program-workspace.ts) resolves names and bounded evidence. Each immutable program selects `run`, `step` or `analyze`. Actor authoring defaults an omitted entry to `run`; durable execution never infers a missing historical entry.

`run` remains an async JavaScript body with host-bound `game,args`. `step` and `analyze` are ordinary modules with one synchronous named function export: `step(frame,state,intent)` or `analyze(input)`. Pure helpers and constants are allowed; imports, packages and ambient host access are rejected. Original and canonical source each have a 16 KiB UTF-8 bound. These formats share the existing artifact store and exact-version publication path.

The ordinary default exposes these tools:

| Model tool | Purpose |
|---|---|
| `observe` | Obtain fresh authorized game state, a typed actor PNG and separate image metadata without caller-supplied session/life/epoch. |
| `program_write` | Create a named immutable `run`, `step` or `analyze` revision; omitted card/dependencies remain unspecified and untested. |
| `program_submit` | Explicitly write an immutable version and request its exact-version start through ordinary admission; report persistence separately from a refused or uncertain start. |
| `program_run` | Start a matching `run`/`step`, inspect or stop it, version-update resident intent, run a pure analysis job, activate prepared run work or select a finite attention wake. |
| `program_inspect` | Read catalog/source/execution/history/metric/evidence/trace/feedback/comparison/planning and mechanical reference views. |
| `program_review` | Record `keep` or `insufficient_evidence` for a named version's latest matching outcome, with reason. |
| `help` | Load generated game/program/planning reference or disclose optional advanced modules on demand. |
| `task_finish` | Request safe closure of a custom task with a model-authored completion summary; not independent goal verification. |

For a custom task, Main calls `task_finish({summary})` once authorized observations and execution evidence show that the whole requested task is done. A successful program return, completion prose or `game.progress` alone never closes a task. Do not rerun already-satisfied work or wait for the empty-turn limit to stop inference.

Ordinary task entry starts with **Custom / natural language**, without an automatic verifier. Built-in success checks are explicit presets: selecting one replaces the draft with its matching prompt and displays its exact early-stop condition. Editing that prompt switches to Custom, even if the original text is later restored; rebinding requires an explicit preset selection. UI, HTTP and Runtime accept the same trimmed task length of 1–4,000 characters. API callers remain responsible for binding a registered criterion to the whole request.

The host records `task.completion_reported` with `source:"model"`, `reported_outcome:"completed"` and `verification:"unverified"`. It synchronously fences further inference and effects, acknowledges `status:"stopping"`, then awaits ordinary neutralization and worker/planner/action drain before reaching `stopped`. It retains a healthy session/video and does not start post-goal review. The tool does not emit `goal.verified`, qualify experience or bypass a built-in verifier. Speculative and review roles cannot invoke it. Identical tool-call retries return the original acknowledgement without another closure request; changed arguments conflict.

Deterministic runtime regressions cover closure after a completed root and with another root still pending, held neutralization, stale effects, role restrictions and durable retries. A zero-provider replay through the real Runtime/Store/tools/scheduler reached `stopped` and admitted no further inference across the idle cooldown; game, provider and sandbox boundaries were synthetic. This establishes lifecycle behavior, not natural-model adoption of the tool or native gameplay success.

`help` is the schema/reference source of truth, generated by [`program-help.ts`](../src/server/program-help.ts) from host validators and interface schemas. `help` topic `game` supplies the canonical `GameAPI` reference; topic `programs` supplies authoring, execution, inspection and review contracts. No repeated full DTO declaration is required in prompts or this guide. Inventory fields are `name`, `display_name`, `count`, `slot`, not `.item`. Source validation does not typecheck all DTO access or prove behavior.

The tool factory explicitly sets `strict:false` at the provider boundary to preserve optional/discriminated input semantics. SDK parameter schemas use Zod's `io:"input"` direction so defaulted fields remain optional for callers; host schema parsing supplies those defaults and still rejects invalid arguments before execution. Every authority/source/isolation/admission fence remains in place. See the [transport reliability boundary](operations-and-security.md#provider-connections-and-credentials) and [scoped verification evidence](integration-spike.md#bounded-natural-wood-comparison).

For `program_submit`, `program_run` start and prepared successors, omitted `limits` or `{}` selects the documented defaults; valid partial objects override only supplied fields. The host records a complete strict effective limits object. Explicit invalid values, wrong types and unknown properties are rejected, not clamped. The installed SDK's supported lenient-validation hook preserves the actor's raw own properties for host validation before identity lookup or persistence; SDK coercion must not turn an invalid argument into an accepted operation or replay. Only proven failures of that tool's own input schema receive structured `invalid_request` diagnostics. Malformed SDK argument JSON remains SDK-owned; arbitrary host errors are not relabeled harmless validation failures.

A new `name` creates a family and omits `based_on`. An existing name requires `based_on` equal to its latest stored version, even if unexecuted, not its latest executed version. The host checks that parent before validation and before commit; stale-parent errors identify the current named version, never silently rebase. Revisions preserve the family name, canonical source/hash and parent lineage.

`card.reason` is ordinary descriptive motivation. Optional top-level `reason` on `program_write` or `program_submit` instead links an experimental revision to actual outcome feedback for that exact `based_on` parent. If that feedback is missing, the operation refuses before writing new source or starting execution with `precondition_failed` and issue `{code:"missing_parent_outcome",path:"reason"}`. To revise stored but unexecuted source normally, retain its latest `based_on` and omit top-level `reason`; motivation may remain in `card.reason`. No execution or review call is required to make that ordinary revision. An explicit experiment link is never silently discarded or attached to an older version's outcome; it records a candidate, not proven efficacy or promotion.

`program_submit` accepts a `run` or `step` definition with required JSON `args` and entry-specific finite limits. Pass `args:null` when unused; omission is invalid before source persistence or execution. For a step, `args` supplies initial intent, and `initial_state` is also accepted; only a run can select speculative `next`. Submission saves one validated version, then requests that exact version through ordinary admission. `program_write` remains save-only. Review and speculative roles cannot submit. The result separates `source:{status:"persisted",name,version}` from `start.status:"started"|"refused"|"unknown"`. A refused start does not roll back source. Inspect an unknown start rather than resubmitting it.

Source registration and its exact-version receipt share one Store transaction. Submission phase identities retain the original source and execution across duplicate delivery or lost acknowledgements; replay never selects a newer catalog revision. An interrupted submission cannot automatically start on redelivery. Stop/Pause, task, owner, generation and negotiated scope are rechecked between persistence and admission. Successful admission retains the scheduler's pending-work behavior instead of requiring a separate run-only model request.

Review with an explicit version stays exact. Without one, `program_review` selects the family's latest matching outcome, not an unexecuted latest source revision. A write experiment still requires its exact latest direct parent's own feedback. A prior `keep` or `insufficient_evidence` assessment stays immutable but does not block repair. Authoring does not require a review call.

Model selectors use human names and optional exact versions; the host resolves IDs, hashes and authority scope. Starting without `version` pins latest validated once before admission. Catalog pages expose the latest stored revision per family with cursors; execution/history/source lookup never rewrites an already captured reference. Inspection preserves explicit omissions and independent feedback cursors.

History, feedback, trace, comparison and review-context queries run in a trusted
readonly child process. The child performs retrieval, bounded projection previews
and paging within one short SQLite read snapshot per request. The host admits one
active request and up to eight queued requests, with absolute deadlines and
cancellation. Complete UTF-8 request and response frames, including their
envelopes and newline, are capped at 8 KiB and 64 KiB. A cancelled active query
settles only after the owned child exits and its output pipe drains. Stop fences
input independently before joining that drain; no query can restore effect or
provider authority.

SQLite schema 7 retains writer-owned source MVCC and versioned derived history.
Source changes to runs, actions, executions, events, traces, trace budgets and
immutable program metadata receive durable change sequences. The writer seals
prior raw values before mutation; an unchanged current value can remain backed
by its original row. A source snapshot reads as of an explicit sequence boundary,
preserving original ordinals, deletions and missing authority. Source-key
bootstrap and indexed source pages are bounded to 128 rows.

Preparation captures its desired source boundary once and never chases later
mutations within that invocation. A readonly preview computes at most 64 patches
and 16 opportunity captures within 128 work iterations. The writer validates
scope, progress, bounds and the prior checkpoint, rechecks candidate captures
against current evidence, then atomically commits patches and checkpoint progress.
Failure rolls back the batch; reopen resumes the last committed checkpoint.
Every continuation must fit the complete 8 KiB request frame, including its
envelope and newline, before it can be committed; fitting the reply alone is
insufficient.

Only complete derived generations become public. Their retained mappings pin the
derived revision and exact `source_through` across reopen; staged metrics and
opportunities stay hidden until publication. Indexed dependencies select affected
outcomes, action contributions, trace suffixes and goal links for bounded work.
Action and trace removal jobs persist forward `(order_seq,key)` cursors with
their patches, so later batches do not rescan a growing deleted prefix. Rollback,
discarded previews and reopen preserve committed progress; removal cursors clear
before contribution addition or replay.
Goal link/dependency clearing also commits forward progress with deletions.
Goal invalidation uses indexed dependencies and retained observation eligibility
cutoffs; qualified action changes consider the earliest old/new cutoff. Candidate
reads exclude executions ending after those observations, while evidence
associations retain their original terminal order.
Production reads use these materialized rows rather than rerunning whole-history
reducers or rewriting unrelated dependencies.

Preparation admits one active caller and eight FIFO waiters per run. Each keeps
its own cancellation and original absolute deadline; a waiting caller's
cancellation does not cancel the active caller. Its turn starts a separate pass,
without retrying a failed pass or extending a deadline.

Exact ID, version and family lookups are independent of presentation limits.
Named projections select their population before hydrating only returned rows
and explicit omission references. Feedback V2 uses independent
`opportunity_change_seq` and `metric_change_seq` cursors bound by `scope_hash` to
the run and selected family/version. It reports opportunity resolutions and
metric `replace` or `retract` updates after earlier pages, with exact program,
execution ordinal, revision and generation provenance. Removal from a named
scope retracts the prior metric with reason `execution_removed`; the execution
may still exist under another scope. A family/version move atomically retracts
the old scope and replaces the new scope, even when the execution ID is unchanged.
Executions removed before their first publication are not emitted.
Retraction never fabricates a replacement metric. Named actor views retain
program/ordinal references without exposing opaque execution IDs. These are live update streams,
not insertion-only cursors.
Comparison V2 instead pins both complete generations plus an offset and scope
hash; continuation retains those populations despite later updates or reopen.
Old cursor formats are rejected.

Live pages expose `generation`, `source_through`, `source_available` and
`has_pending`. Exhausting a page stream does not establish that pending source
work is published; before the first complete publication, derived reads conflict
rather than report empty success. Read-only inspection never starts preparation.
Committed source notifications schedule effect-free preparation, including
eventless changes and retained runs after reopen. Durable journals own progress;
a failure audit alone cannot schedule a retry. Revision and review bindings retain
their original outcome across retries.

The operator's `GET /v1/runs/:id/skill-evidence` returns an insertion-offset page
with records, continuation, omissions and projection provenance. It can include
running executions. The desktop retains one requested measurement page and links
records by execution ID. Oversized metrics and evidence are omitted as whole
records, with recoverable references; DTO fields are not truncated. Actors use
`program_inspect` views `metric` and `evidence` with an exact named version,
execution ordinal and generation. A retained prior generation remains readable
by that ordinal even after deletion from the live execution ledger. Operators use
`GET /v1/runs/:id/objective-metrics/:executionId` or
`GET /v1/runs/:id/skill-evidence/:executionId` with the required generation.
Both expose lossless archive continuation through `{record_index,chunk_index}`;
assemble ordered JSON-text chunks and verify their byte count and SHA-256.
Generated help and source schemas define the callable DTOs.

Write, start and prepare results are compact named status/experiment summaries. Execution inspection includes effective limits and the resident's current bounded snapshot; source inspection supplies code, card and validation details.

The strategist keeps a run-owned reference context outside its disposable Agent. Each actual SDK stream invocation, including tool-loop continuations, receives a supplement capped at 32 KiB serialized UTF-8: compact contracts, objective, model-authored recovery state, latest consequential obstruction, unresolved-operation references, relevant compatible immutable source and useful requested help. This is included in the actual request, not merely cached on the host. Source and its reuse metadata share an 18 KiB allowance; retained help has a 24 KiB ceiling. Both share the same 32 KiB request cap rather than additive reservations. Requested executable-format, temporal-view, resident and native-invocation mechanics take precedence, followed by complete native action alternatives, other reference prose, game-adapter metadata and observation/read/result schemas. Native method references keep their invocation fields separate from embedded result schemas. This ordering also applies when source and unresolved-effect history compete for the final request budget, independently of help-topic request order. Top-level action `anyOf`/`oneOf` alternatives stay whole: an alternative over the 6 KiB section bound is omitted, not split into detached properties. Other oversized documentation is split at schema/property boundaries. Retained help remains partial; omission references distinguish section, retained-help and final-request byte limits, while `omitted_records` counts details/notices that no longer fit. The supplement directs the model to re-request the corresponding `help` topic for the full current contract. Whole sources are either included or explicitly omitted, never truncated into executable fragments. This supplements, rather than replaces, bounded current observations, tool pairs and turn feedback.

Programs can report `current_subgoal`, `worksite`, `resource_requirements` and `recovery_reason` through existing `game.progress` details or their returned result. Selected bounded notes and up to four explicitly returned positions survive ordinary turns and safe Agent recreation; an unspecified program card is not a current subgoal. These are labelled model-authored notes, not current inventory, target authority or success proof. Current observations must supply resources and freshly reacquired handles. Session/life/native-boot/space changes clear current dynamic notes. Explicit subgoal/worksite notes can remain separately labelled historical references with their original scope; a task/world/fresh-run change clears that retained experience. A generic execution closure does not hide its actual action obstruction; selected mechanical receipt fields remain available without restoring old target handles or full observations.

Keep location meanings distinct: `worksite` records an observed task site and changes only when establishing or deliberately relocating that site. Omit it during travel or recovery to retain it. Current position comes from fresh observation; a temporary `recovery_position` belongs under its own structured root-result label. Existing returned-position retention preserves that label without inferring a worksite. This is an authoring contract, not evidence that a model followed it.

Requested documentation is invalidated when the actual request contract changes. Source selection checks executable/API/adapter/profile compatibility; a provider transport, root-prompt or tool-role change alone does not invalidate compatible source. Selected programs can include their last named/ordinal execution reference, bounded sanitized historical argument sample and outcome with original scope. These examples restore neither invocation inputs nor current targets and do not recommend rerunning blocked or unknown work. Construct current arguments from fresh observations.

Unresolved operations have their own bounded no-replay references, separate from the latest failure. Up to eight are retained with original scope and any containment event; older omissions are counted, not treated as resolutions. Containment and fresh observation do not prove that an earlier unknown effect never happened. Task/world/fresh-run changes clear this retained experience; within that scope historical unknowns can survive life/session changes without regaining authority. Declared cold episodes with fresh programs do not inherit prior run-private programs or experience; explicit same-session working-definition continuation remains separate.

The context reconstructs supported references from durable Store events, reading beyond a single event page. This supports ordinary turns, Agent recreation and inspection after Store reopen, not automatic gameplay continuation after application restart. Restart closes interrupted work safely; a stopped run cannot Resume. Source, notes and unresolved evidence do not restore a worker, JavaScript stack, target handle or world checkpoint, and retained context is not an unbounded transcript.

The structured gameplay projection of strategic `observe` omits known host world/session/epoch/life/death identities while retaining authorized gameplay fields, target IDs, freshness and death reason. Separate `image_metadata.host_selection_scope` identifies host run/world/session/epoch/life/generation authority with `alignment:"unsynchronized"`; it does not prove capture-time life, camera, space or synchronization with gameplay state. See [delivered actor images](#delivered-actor-images-and-recorded-episodes). This does not change native/SDK `Observation` or isolated guard input. Typed evidence projections preserve execution arguments/results and trace/event payload JSON, subject to explicit byte omissions; arbitrary user JSON is not recursively stripped by key name. Feedback retains exact program names/versions and durable execution ordinals, separate from event-sequence references.

`help` topics `reflex` and `memory` disclose optional lifecycle tools to the ordinary role. Reflex retains actual isolated JS and real Jev behavior; memory retains compatible snapshots, fresh load and explicit evidence-qualified promotion. [`src/shared/tool-policy.ts`](../src/shared/tool-policy.ts) is the single role/module registry for both provider catalog and dispatch. Pending-root authoring receives observe/read-only inspect/help and inactive `program_write` only. Speculation receives observe/read-only inspect/help plus `prepare_next` only. Post-goal review permits source/assessment artifacts and authorized reads, not gameplay or advanced mutation.

Inside a `run` program, common methods are `await game.observe()`, `await game.call({name,version?},args)` and `await game.progress(summary,details)`. The selected adapter supplies its registered native reads as direct positional `await game.<binding>(...parameters)` methods. `help` topic `game` generates each binding's invocation from its actual name and ordered parameter list. Its `capability_id` and `version` identify the trusted binding; they are not a `NamedProgramRef` or extra positional arguments. Native reads require no authored dependency declaration. When supported, `game.action(action)` returns the final action result and `game.respawn()` uses the same exclusive arbiter as `game.action({kind:"respawn"})`; it is no privileged recovery shortcut.

`program_write` and `program_submit` dependencies list only already authored named programs for `game.call`, never native binding names. The host resolves these declarations to exact validated versions when the parent is written. A running child lookup uses **only that parent's pinned closure**, never current latest; omitted child version requires an unambiguous declared name. A native read and an authored program with the same name remain separate authorities: the direct method invokes the binding, while `game.call` requires the captured authored dependency. Internal `SkillRef` identities remain evidence/enforcement details. Every return path, including early blocked/failed exits, supplies `{status:"completed"|"blocked"|"failed",summary,result}`; use `result:null` without a payload. Static validation does not prove every path returns correctly, and completion does not certify the operator's objective.

`game.actionAndObserve(action)` is a worker-local composition of one ordinary action and a fresh ordinary observation. It returns `{action,observation}` without changing the action result. Observation follows success, or a failed result with explicit `world_effect_emitted:false` and `neutralized:true`, provided reconnect is not required. Other outcomes return `observation:null`; unknown, cancellation and reconnect still encounter the host's execution fences. Validation and observation errors propagate; there is no stale fallback. Both calls consume existing budgets.

Authored callers should adopt the returned fresh observation and evaluate their intended postcondition before treating a failed status as a reason to abandon the procedure. The generated help example checks the postcondition before the first action and after feedback, then allows at most one distinct author-chosen alternative after confirmed neutralized no-effect failure. This is a disclosed authoring example, not an injected strategy or automatic recovery rule. The utility never retries an effect or decides task completion; unknown and cancelled work cannot use it to bypass reconciliation.

The Minecraft recipe read is the registered adapter binding `game.recipes(item)` → `minecraft.recipes@1`, advertised by `help` topic `game`. It is not a generic game requirement. The former `program_inspect` recipes view is retired, not an alias; retired and unknown views reject as `invalid_request` before dispatch. Inspect recipes through a named executable program using the registered read binding.

Recipe queries and semantic `craft.item` match an exact output item registry path
without its namespace. They do not expand material families, tags, display names
or ingredient names. `craft.executions` is the required number of recipe
executions, not an output-item count; each execution yields the recipe's output
count. The helper uses synchronized unlocked recipes. Missing helper access
does not establish that ordinary manual crafting is impossible.

Strategic `action_submit` and `action_cancel` tools and aliases are removed. All new game effects require an owning skill execution or model-authored reaction through the arbiter; ownerless admission is rejected. The root program must implement a bounded observe/action/check/recovery/composition task flow, not outsource each next step to another strategic call. Small leaf helpers remain valid declared dependencies. Historical `origin:"strategist"` records stay readable and are never relabeled.

A safely settled failed action or blocked/failed child returns to the authored caller for its own correction. It does not automatically kill the root. Unknown effects, reconnect requirements, actual cancellation/preemption, death, pause and stop fence the execution tree; generated error handling cannot bypass that fence.

Aggregate root action/call exhaustion records `RuntimeFault` / `budget_exceeded`
with the exhausted `max_actions` or `max_calls` limit and exact root
`calls=used/cap`, `actions=used/cap` counts. Children share those counters.
The rejected capability consumes no additional call or action. The sandbox's
independent local guard notifies the owner before closing, even when it rejects
the request before broker dispatch. The owner confirms exhaustion from its
aggregate counters and retains the trusted diagnostic before synchronously
revoking the tree, then waits for
worker and capability drain before closing it as failed; unconfirmed cleanup
remains unknown. Generated error handling cannot restore authority or turn that
failure into completion. Inspect execution evidence and adapt the bounded
program flow before a new execution. Arbitrary host errors remain redacted.

Registered capability schema rejection is `invalid_request` before action admission. Its bounded diagnostic names trusted schema parameters and numeric constraints where available, including a navigation range below its advertised minimum. This classification belongs to the registered request boundary; arbitrary backend validation exceptions remain redacted backend failures. Pre-admission rejection does not fabricate native neutralization or effect evidence.

For a safely settled no-effect target rejection, the running procedure may obtain a fresh observation and select fresh work within its existing budgets. This grants no stale-target reuse or replay of an unknown effect. A disappearing drop and an inventory increase alone do not establish that a particular interrupted pickup was confirmed.

The parser permits comments and coherent helper functions. It rejects imports/exports, dynamic imports, body escapes, invalid syntax and forbidden ambient APIs. Original and canonical source each have a 16,384-byte UTF-8 cap. Canonical line count, nesting and complexity remain descriptive metrics, not admission limits. Safe validation errors preserve bounded issues and source locations. Generated failures retain bounded exception type/message, exact source hash and an explicitly unmapped location when canonical mapping is unavailable; host stacks and arbitrary thrown objects are not serialized. Recorded acceptance retains bounded public capability code/message in correlated capability-result evidence before ordinary trace caps, even if generated code catches the rejection and later succeeds; arbitrary host exceptions, paths and stacks remain excluded. The host stores and executes exact canonical bytes/hash with the changed validator fingerprint. Ordinary `program_write` may omit its card and dependencies; host card defaults say unspecified/untested rather than supplying tactics or efficacy. Optimistic `based_on`, exact dependencies and promotion evidence still apply. Static validation is not OS isolation.

Terminal summaries contain 1–2,000 characters. Return compact semantic facts in `result`: relevant counts, task facts, selected failure information and authored continuity notes. The entire serialized output frame plus newline must fit **65,536 UTF-8 bytes** and JSON depth **32**; this is not a separate allowance for `result`, summary or each field. Leave room for the envelope. Do not return raw observation/receipt arrays, stringify them into the summary or invent evidence IDs. Raw authorized evidence stays in the host Store/trace/journal. Inspect it through `program_inspect` execution/action/trace/events views using returned named/ordinal references and cursors.

A genuine terminal-frame failure produces typed `ProgramOutputError` / `program_output_limit` evidence with phase `terminal_result`, reason `utf8_bytes`, `json_depth` or `json_serialization`, the 65,536-byte maximum, a nullable actual byte count and completed capability-call count. An authored exception whose message happens to say `output_limit` does not become this typed failure. No production bound is raised and no arbitrary result is truncated to fit. Completed effects remain applied: inspect retained evidence and fresh state before deciding what remains; serialization failure never authorizes replay.

A transported generated value that violates `SkillResult` instead produces `invalid_program_result`; a JSON-safe rejected payload up to 64 KiB can be retained at `result.rejected_result`. Malformed transport and other failures keep their own classifications. These diagnostics do not establish the exact cause of a historical failure whose rejected frame was not retained.

### Delivered actor images and recorded episodes

The application and actual acceptance runner use `Runtime.modelObservation()` for strategic prompts and `observe`: authorized structured observation, one typed PNG image and separate metadata. Worker `game.observe()` remains JSON-only. The shared asynchronous actor/recorder PNG codec corrects native bottom-up rows and preserves every RGB byte without a per-observation subprocess. It sets PNG alpha to 255: native framebuffer alpha does not describe display transparency, and the actual game viewer renders sampled RGB as opaque. Actor metadata declares `pixel_presentation:"opaque_rgb"`; these PNGs preserve visible native RGB, not the source framebuffer's alpha channel. Actor PNGs have a 2 MiB cap and explicit stale/malformed/oversize failures. Selection rechecks run/session/life/generation authority after encoding. Actor metadata identifies host selection scope and retains `alignment:"unsynchronized"` with structured observations. Richer GHV2 capture diagnostics remain outside this actor metadata; they neither expand the sensory profile nor restore input authority.

Live capture uses a fixed 328-byte little-endian GHV2 header and unchanged
RGBA pixels. The canonical [packet decoder](../src/shared/video.ts) binds
readback start/end, client tick, render invocation, capture life/space/native
generation and capture-tail screen to that exact packet sequence. Available
world-render metadata copies the actual camera, quaternion, position and
projection matrices passed to Fabric world rendering; it is not reconstructed
from later player pose. Missing, invalidated or different-invocation world
samples remain explicitly unavailable. Capture-tail screen identity is not
proof of the precise screen-render transaction. Recorders retain these
diagnostics, while actor PNGs omit them. GHV1 is not a live compatibility path;
retained historical artifacts are not rewritten.

The codec uses fast lossless deflate with a bounded 256 KiB output chunk. In the pinned Bun runtime, exhausting its default 16 KiB output buffer schedules another [worker/event-loop continuation](https://github.com/oven-sh/bun/blob/bun-v1.3.14/src/js/node/zlib.ts#L458-L495); a large PNG can otherwise accumulate many continuations under live raw-video I/O. This changes compressed bytes and storage cost, not pixels, permissions, the actor image cap or recorder queue limits. The selected zero-provider `scripts/native-recording-proof.ts --allow-native --jar <fresh.jar> --natural-start` case captures ordinary seed-1 startup with concurrent observations/actor-image selection and no setup commands or gameplay effects. It is recording infrastructure evidence, not model gameplay or a general throughput guarantee.

After rejecting an old buffered image, Runtime may wait for a new delivered frame through the bridge subscription within one 1500 ms preparation window. It rechecks run/session/life, native boot, profile, space and screen authority during that wait and cancels on generation fences. It does not substitute stale pixels, fall back to text or make another provider request. These are host selection checks, not capture-time synchronization.

Runtime accepts a bridge-delivered structured observation through its ordinary schema, run-authority, evidence and goal path without issuing an echo native read. Duplicate or older observation sequences do not create fresh evidence. Explicit observation requests still acquire current native state. The recording proof's optional `--natural-start --runtime-load` condition includes a real SDK Agent, Runtime, Store, actor image and private journal with an abortable local stream; it makes no provider calls or gameplay effects. A direct recorder-only pass does not establish throughput under that integrated workload.

Model choices project input modalities from actual discovered SDK descriptors. Image-enabled actors reject models without image input support before inference. Descriptor support is not a live vision result. Synthetic runtimes without an actor-frame source explicitly report image mode disabled. Store tool events contain metadata, not image binary.

The acceptance recorder subscribes directly to delivered bridge frames, independently of spectator latest-only backpressure. It retains PNGs, delivery-order index records, capture/receive times, identity and upstream sequence/time gaps. The default short profile allows 128 MiB pending raw packets, two concurrent asynchronous encodes, 12,000 frames, 32 GiB frame files and 600 seconds. A complete checked evidence profile can declare a different finite duration/frame allowance; acceptance rejects a profile that cannot cover its requested task horizon before external preparation.

Native capture reuses three fixed framebuffers. The socket writer drains pending
captures in order, retaining up to two successors while it owns a packet. If all
buffers are occupied, capture replaces the oldest waiting packet and increments
`latest_queue_replacements`; it never overwrites the socket-owned packet or
waits for network output on the render thread. This absorbs brief write stalls
at the cost of pending-image latency. Saturation and render stalls can still
leave explicit recording gaps.

Recorder and journal limits are defined in [`evidence-limits.ts`](../src/shared/evidence-limits.ts). Supplied profile files are regular project-local files, checked for size, identity and forbidden secret/database paths. Registered studies must pin a supplied profile's exact preprocessing identity. The selected profile and effective recorder/journal/renderer limits are retained before inference. Constructor overrides are normalized once; invalid or misspelled bounds never silently default or clamp.

Exhaustion or dimension/orientation changes stop capture as incomplete; the native producer can already omit renders. `finish()` drains durable frame evidence and writes a capture-time ffconcat timeline including the final hold. Current recording manifests use schema 1 and retain effective limits, actual stored PNG bytes, pending/encoder peaks and capture/end timing; old manifests are unchanged. `health()` reads current counters without filesystem work. Separate bounded offline rendering preserves waits; failure retains PNG/index/manifest evidence. Audio is not recorded. Replay rendering is not visual inspection.

Offline export preserves delivered images on a millisecond presentation time
base, including large terminal gaps and the final hold. It does not impose a
25 FPS image-demuxer grid or use B-frame reordering that can understate an MP4
endpoint. The renderer verifies the finalized concat against the capture owner's
sealed SHA256 before using per-image options and permits only local file
protocols; it is not an arbitrary concat script importer. Historical PNGs,
indexes and movies remain unchanged.

Offline H.264 export uses the `veryfast` preset and one filter thread for pixel
conversion. Decoder and encoder threading remain automatic. These throughput
settings preserve every delivered frame, presentation timestamp, final hold and
`yuv420p` output; they do not extend the declared render deadline. Abort or expiry
kills the owned encoder and joins its process-close barrier before returning.

The active boundary uses observation envelope **3**, executable API/validator/runtime **5**, native hello **4**, and `minecraft.action@4`. Isolated worker framing remains **1**; resident messages use their own version-1 namespace. Login admission proof remains **1**, live binary capture is **GHV2**, SQLite uses schema **7**, usage metrics remain **2**, and request-usage evidence remains **1**. Screen and controller-feedback reads use `minecraft.visible_screen@1` and `minecraft.controller_frame@2`. Semantic heard-event feedback is separate from audio recording, which remains absent. This cutover does not deliver larger source bundles, checkpoints or another supported game.

### Ordinary Minecraft world input

The registered action capability is `minecraft.action@4`. Its `world_input`
action accepts a bounded sequence of ordinary held-key, counted-press,
hotbar/swap/drop and view commands. The generated `help` game reference and
[`control.ts`](../src/shared/control.ts) define the exact request; versions 1
through 3 are not live aliases. Existing semantic actions remain separately disclosed
assistance in the current profile.

Each step declares all nine held movement/attack/use booleans. Ordered button
transitions must agree with that state; holding attack does not manufacture a
new entity click every tick. Declarative `selected_hotbar` applies at step
entry before normal vanilla slot synchronization; explicit hotbar edges
remain ordinary counted keys with vanilla consumption precedence.
Inventory opening is edge-only. World input
rejects an already open screen, and a screen opened by vanilla consumption
ends the world clip without closing that screen or applying later steps.
Arbitrary keys, chat/debug commands and generic GUI input are not admitted
through this action.

View commands are unchanged, a delta applied once at step entry, or a rate
integrated once per consumed client simulation tick at 0.05 seconds. Units
are radians or radians per second, with positive-up actor pitch. The native
look path applies ordinary pitch and vehicle constraints; receipts return
the actual pose. This is not the assisted target servo. Normal vanilla
crosshair, both-hand fallback, item-use/release and attack/use precedence
determine the interaction, rather than a stored observed target.

An action has at most 64 steps, 100 total native ticks and 256 expanded
edges. It has a finite tick-derived wall/receipt deadline independent of
legacy helper timeouts. Application receipts distinguish consumed ticks,
step/edge prefixes and actual native timestamps from later gameplay effects.
A completed input clip does not confirm damage, a projectile, production or
task success. Interrupted emitted work retains uncertainty and is never
replayed. Confirmed emitter closure establishes containment, not a fabricated
native release acknowledgement. The action is not resident streaming or an
input lease; those remain separate runtime work.

### Persistent visible Minecraft screens

`game.screen()` reads the current visible layout through
`minecraft.visible_screen@1`; it neither opens a container nor closes a screen
to answer. The snapshot includes visible empty slots, cursor custody, actual
logical-GUI bounds, current-page elements and visible progress. It does not
enumerate hidden offers, recipes, closed containers or item NBT.

`screen_input` requests bounded ordinary slot/button/key/text/scroll/close operations
against a screen identity and layout revision. Local source/cursor assumptions
are separate from content revision: an unrelated furnace-output update is
not a reason to reject an unchanged input-slot operation. A no-input frame,
read or normal operation settlement keeps the screen open. Explicit close
uses vanilla custody behavior, not a rollback promise. Replaced layouts and
handlers fence old presses/releases.

The ordinary GUI pointer keeps its last position between requests and during
idle frames on the same screen and handler. A new request moves from there,
without a fixed return point in the inventory. Retained position grants no
button or input ownership. Closing or replacing the screen, changing its
handler/window/viewport, or another inventory writer invalidates it; a fresh
context starts from the scaled vanilla mouse position.

Rendered choices include stonecutter recipes, loom patterns, enchantment rows
and beacon controls. Merchant offers expose at most seven rows on the
rendered page. An active `scroll_region` accepts horizontal and vertical
wheel components in `[-16,16]`, after moving the ordinary pointer to that
region. Page, input binding and geometry changes retire old element ids.
The projection does not enumerate off-page choices or expose enchantment
seeds or undisplayed hints. An unavailable operation rejects explicitly.

Effect envelopes now require a discriminated `expected_screen`: `absent`
means strictly no screen; `transaction` preserves exact helper
screen/incarnation/revision checks; `layout` carries visible-screen identity
and layout revision. Host/receive identity admission is not complete GUI
application validation: native layout and local values are checked again
before effects. Old null, untagged or omitted preconditions are not accepted
as live authority.

GUI transaction evidence is separate from helper receipts. Matched server
ARM/FINISH diagnostics and actual result-slot/furnace provenance can establish
a confirmed transaction or production source. Client prediction, input
acknowledgement and possession alone cannot. Unmatched acknowledgements stay
unknown, and trades are not automatically repeated. The integration guide
records the exercised verification scope; registering these interfaces does
not establish every progression layout or a model's ability to use it.

### Basic controller feedback

`game.frame(audio_cursor)` reads current local own-body, vanilla crosshair,
visible GUI and audible feedback without a server inventory request. Pass
`null` initially, then retain the returned audible cursor independently for
each consumer. This read is not `game.observe()`: its inventory is explicitly
`client_prediction`, and cannot establish server-confirmed goal possession.
Cached world rows keep their original authorized observation time and an
explicit age flag; they are not a new live geometry sample.
Known screen close/replacement rejects an in-flight frame instead of
returning its obsolete GUI. Screen identity checks do not turn unrelated
slot-content revisions into a whole-inventory read barrier. An unavailable
view fails explicitly rather than pretending that its GUI is absent.

Own feedback includes velocity in blocks per client tick, fluids and air,
vehicle, active hand/use duration, equipment, status and attack indicator.
Component sampling is not atomic. Inventory has its own native timestamp;
render metadata names an actual GHV2 capture sequence and its original pose.
Capture sequences use the unsigned 32-bit wire counter, including wrap to
zero; camera yaw remains the actual unwrapped value. Native nanoseconds stay
signed decimal strings. Unavailable, wrong-scope or older-than-five-second
render metadata is null. The typed actor PNG remains unsynchronized.

Audible pages retain at most 128 events for one second and deliver up to
eight per read. Independent cursors do not drain each other's events;
expiry and overflow have explicit gaps. Scope changes invalidate old
cursors and queued old-scope playback. The original sound time is preserved
in legacy grouped observations too. An actually delivered creeper priming
sound may expose the `creeper_primed` cue and coarse direction/distance,
never a hidden fuse or inferred threat. This channel supplies neither a
subtitle-rendering feed nor recorded audio.

Native proof launches use OpenAL's silent `null` output backend by default.
The audio engine and in-game gains remain active, so permitted heard events
still reach the agent without playing through the host's speakers or
headphones. `GAMEHARNESS_NATIVE_AUDIO=silent` also selects this output for an
ordinary launch; `audible` opts a proof launch back into normal output.
Other applications and ordinary launches without that setting are unchanged.

Frame schema 2 includes `last_input`, the last actual controller-stream ACK
or null; finite actions retain their separate receipts. Its controller
generation, sequence, consumed ordered prefix,
actual tick/time, held keys and constrained pose describe input application.
They do not establish damage, production or another world consequence.
`effect_updates` retains up to eight later GUI receipts within 16 KiB,
with original native times and an explicit omitted count. Receipts can
remain unknown after confirmed input. Neither field exposes the private
owner/scope grant. Distant/frustum sensing, incremental live geometry and
multipart/nonliving effect attribution remain separate work.

### Native controller input transport

The host reserves the avatar through the same `ActionArbiter` used by finite
actions. Reservation records the exact source and scope before native
admission; no dummy action acquires a second writer. Finite actions and
context replacement wait for retirement. A submitted snapshot is not an
application ACK.

The authenticated control socket has separate bounded lanes: sixteen
ordinary host RPCs, four unresolved input frames, one controller sample,
one mechanical heartbeat and one reserved retirement. Native ordinary
dispatch remains bounded at 32 tasks. Stream admission does not enqueue a
game-thread task for every nominal input. At most 256 expanded ordered
edges remain unacknowledged. Only compatible unsent, edge-free held
snapshots may coalesce; sent frames, ordered edges, relative view deltas
and explicit selection are preserved.

Each input names its actual native capture, source, owner and generation.
New input must enter within 150 ms of that capture, including conservative
clock uncertainty. A separate 250 ms native lease expires mechanical
control; renewing it does not renew the task deadline or replay a decision.
Held use survives later snapshots without a release/repress. Vanilla
counted-press consumption and movement-key sampling establish the applied
prefix; adding a press to a queue does not. A fresh GUI intent enters the
existing bounded visible gesture driver. Its pointer travel and subsequent
server receipt keep their own timing rather than claiming a 150 ms gesture.

The game thread captures immutable replies and notices, then enqueues them
without waiting on a socket. One writer retains at most 256 messages and
1 MiB, including its in-flight message and reserved ACK headroom. Critical
messages retain FIFO order. Replaceable diagnostic progress can coalesce
with an omitted counter; it never confirms input or world effects.
Critical overflow fences the connection and leaves unresolved effects
unknown. Per-frame progress does not write Store events or fsync the disk.

Retirement stops admission first and clears actual inputs on the game
thread. The reserved ACK reports that thread's real tick and native time.
A stopped native thread cannot release keys on time; after resumption,
expired press backlog is rejected instead of burst-applied. Missing
retirement closes the emitter and remains uncertain. Confirmed process
containment is not a fabricated native retirement ACK, and never replays
earlier effects. The generated resident worker and scheduler use this
transport through the same arbiter.

### Resident steps and pure analysis

[`ResidentController`](../src/server/resident-controller.ts) runs one isolated
worker at absolute 1, 5 or 20 Hz. It skips missed slots without catch-up and
allows one step at a time. Compilation precedes native admission; the
original monotonic root deadline includes startup and never renews.
Every step returns `input`, explicit `next_state`, `status` and bounded
`events`. State and intent each fit 16 KiB of JSON; the complete worker
output, envelope and newline fit 64 KiB at depth 32.

Authoring guidance prefers useful persistent local taskflows over a new
inference for each target or short input interval. Attention and explicit
intent updates can preserve a useful controller during reasoning. This is
an instruction to the model, not proof of natural gameplay or elimination
of cold authoring time.

World `held` is the final state after applying ordered `edges` to the
previous submitted state, initially neutral. Every changed held boolean
needs its matching press or release edge. Track submitted state separately
from the potentially lagging `last_input` application acknowledgment.
Before screen input, submit neutral world state with the required releases.
A non-running result retires without submitting its returned input.

### Authored view motion

Ordinary `world_input` and resident world snapshots share the same raw
`view` actuator. `delta` uses relative radians and applies once at step or
snapshot entry. It is not divided across the step's duration. A delta
equal to the entire target error therefore turns immediately; selecting a
target does not create a trajectory.

`rate` uses radians per second. Each actual client simulation tick applies
`rate * 0.05`, independent of render frequency and elapsed wall time.
An ordinary action applies the rate for the step's declared `ticks`,
then applies the next step or releases control at action completion.
A stream retains its rate on subsequent ticks without another command,
including after the snapshot's application acknowledgment. It continues
until a replacement view input applies, a screen transition clears it,
or control retires or expires. There is no automatic stop at a target angle.
The 150 ms capture-age check, 250 ms native lease and original root
deadline remain separate bounds.

Positive yaw turns right: yaw zero faces `+Z`, `+pi/2` faces `-X`,
`-pi/2` faces `+X`, and `+/-pi` faces `-Z`. Positive pitch points up.
Actual body and input-acknowledgment `applied_pose` wrap yaw to `[-pi,pi)`
and report pitch clamped to `[-pi/2,pi/2]` under ordinary player and vehicle
constraints. Read those applied values rather than treating a requested
rotation as an achieved pose. Crossing the yaw wrap boundary does not
mean that the player made a full turn.

The common actor prompt and public program help require target transitions
to unfold over authored time. The model chooses targets and the rotation
schedule, using existing rates or successive small deltas to express
bounded temporal turns. Raw input does not smooth full-error deltas,
select targets or promise sub-tick interpolation.

To end a stream view rate, submit `unchanged` or a zero rate.
`unchanged` replaces the prior rate when applied; it does not restore an
earlier pose. Neutral held state alone, an input acknowledgment or no new
command does not stop a retained rate. Button releases still require the
matching edges against the previous submitted held state; unchanged holds
need no repeated edges, and intentional counted presses remain explicit.
Stop and trusted retirement clear owned held input and pending presses
and cease further authored rotation. They do not undo the applied pose or
earlier world effects, and confirmed neutralization does not resolve an
unknown effect.

### Resident sampling and application

Resident sampling waits for a render and a client tick newer than the
stream's last successful sample or grant. It constructs a fresh body with
its actual capture time; it does not synchronize that body with RGB pixels.
One pending resident read shares the native four-read bound with ordinary
controller reads. Ordinary `controller_frame` reads keep their separate
immediate/deferred behavior. Waiting retains the original two-second read
deadline and can end earlier on lease or authority loss. An invalidated
resident read waits for physical input release before its error; explicit
revoke also queues its genuine retirement ACK first. Sampling waits and
missed slots remain part of cadence evidence, not capture-to-applied latency.
A well-framed late sample received after retirement, or for a different
controller owner, receives an explicit request error without closing the
native connection or revoking a replacement owner. This does not admit
stale input or change the separate occupied-lane and framing rules.

`step_ms` bounds isolated worker/guardian evaluation, including serialization.
The host separately permits at most 500 ms for a step response, under the
unchanged root deadline. Host scheduling and IPC delay are not computation
time; the snapshot's `timings.step_ms` reports that round-trip wall interval,
not CPU. Waiting sends no lease heartbeat. A returned running decision must
still pass the original 150 ms native capture-age check before renewal or
state publication; an expired lease cannot be revived by a late response.

Fresh valid decisions renew the 250 ms native lease using their actual
retained capture. A stale decision cannot renew it. At 1 Hz, expiry before
the next step is expected. Empty visible-screen waits and unchanged neutral
world waits can process feedback without submitting another input; stopping
a prior view rate still requires a submission. Frames, steps, ordered edges,
events and pure jobs have separate cumulative limits. Resident frames do not
consume the legacy taskflow action/call allowance.

Processed state, submitted sequence, actual applied prefix and later GUI
receipts remain separate. GUI receipts retain their original controller
sequence and source, including confirmed prefixes with unknown suffixes.
They can contribute adapter-owned verification facts without a finite
`ActionView` or a second input owner.
Visible cursor or slot changes can precede gesture completion. A dependent
GUI operation waits for the matching application acknowledgment and terminal
effect receipt; empty screen operations keep sampling while it is pending.
An unknown result must not be replayed. Full execution inspection includes
`resident.reason` when a generic execution summary omits the rejection cause.

`args` supplies initial intent; `initial_state` defaults to null at actor
ingress. `update_intent` requires the current `expected_version` (initially
zero), increments only that version and discards an in-flight old-intent
result. `analyze` selects an immutable pure module and an expected intent
version. Its isolated job can run beside steps, has a separate finite
compute allowance and returns source/input/version provenance. Its output
does not change controls or intent automatically.

Analysis `elapsed_ms` and cumulative compute charges cover the trusted
evaluation interval, not compilation or later worker removal. The host reports
that boundary before joining teardown. Nullable `post_evaluation_ms` separately
measures callback receipt through service settlement on one host clock; it
includes delivery, cleanup and host delay, not pure CPU. Compilation that never
evaluates has no post-evaluation interval. Root lifetime still includes all
startup and cleanup.

Attention events reach the existing serialized strategist through a recognized
wake category, with bounded authored summaries and details. Diagnostic events
alone do not request replanning. Up to 32 pending attention records remain
available independently of the ordinary event page; overflow has an explicit
count and event range, and delivered triggers are not replayed from later pages.
Unknown controller receipts retain their input
identity, sequence, generation and original scope in no-replay context.
Confirmed retirement annotates emitter closure, not resolution of those effects.

Blocked, yielded and completed steps retire their execution. Stop fences
callbacks and input admission before draining the worker, jobs and native
writer. The arbiter retains its reservation until all actual barriers settle.
A confirmed native retirement can coexist with unknown computation cleanup;
neither clears prior world-effect uncertainty. Playing child composition and
prepared successors remain run-only.

### Evaluator-only native fault configuration

Normal launches serialize `NativeSession.evaluation:null`. The trusted launcher
can accept a strict `NativeOptions.evaluation` declaration only with explicit
native-proof authority; this is not a connection field, game capability or
model tool. Natural fixtures reject it before setup, and resident timing
studies require the actual launched session to remain disabled.

The optional declaration permits one owner-bound inventory-screen replacement
and/or a bounded native control-socket send buffer. Replacement is armed
against the exact controller, original screen/handler objects and visible
layout, then consumed once after the real second gesture enters its pressed
phase. It uses ordinary screen installation and incarnation hooks, never a
second input owner, fabricated GUI receipt or release into the new screen.
Raw arm/status methods reject normal mode; their metadata is not actor
perception. These facilities belong only in declared zero-provider fault
fixtures, not real-provider gameplay studies.

Trusted diagnostics separately report overlay presence and world-input callback
eligibility. Eligibility is not proof that a key was consumed, and does not
describe GUI gesture eligibility. The original application receipts, frame
freshness, lease and source/scope guards remain authoritative.

### Correlated control timing

Ordinary native replies carry request-correlated receive/reply nanoseconds
as decimal strings and a client-tick counter. Receive is the authenticated
application receive point; reply is before serialization/socket writes, not
flush completion. The host brackets each request on its own monotonic clock
and retains native-minus-host offset bounds with uncertainty. Existing
request traffic and diagnostics supply repeated samples without new
observation polls. Clock correspondence is measurement evidence, not input
permission or a guarantee against drift. It resets across native boots and
is unavailable after its bounded age.

Controller replies can also carry a trusted `controller_lease` timing record.
It binds the actual queue check to its request, owner and controller generation,
retaining requested, previous, effective and task deadlines. The first fence
is stamped at its synchronized transition; an earlier validation timestamp is
not its occurrence time. Retirement initiation and trigger remain separate
from the post-release ACK and ordinary input application.

Completed controller submissions can carry `controller_application` timing:
actual admission and begin times, queue entries ahead at admission, preparation
ordinals, and the first completed preparation, input-consumption and movement
sampling hooks. Missing hooks remain null. The snapshot binds to the original
request, owner, controller generation and frame. Its settlement timestamp
records queue completion separately from the original ACK application time;
an empty GUI snapshot can use an earlier ACK sample. GUI dwell remains part of
application time. These records distinguish queue waiting from later input
phases without changing FIFO ordering or treating progress telemetry as
confirmed input.

Ordinary replies can carry bounded `controller_opportunities` batches: actual
preparation entry/exit, empty or skipped queue decisions, predecessor/completion
state and sample/render readiness. Producers record evaluated decisions without
replaying predicates; nonblocking buffers retain accepted prefixes and report
omissions. Identity, event sequence, native tick and preparation ordinal remain
distinct. Retirement ACKs keep their reserved size and ordering; final batches
use later existing ordinary replies, never extra queries. Missing final carriers,
unattached events and omissions leave coverage incomplete. These diagnostic
hooks do not replace capture-to-applied age: authoritative ACK time minus the
matching native capture time.

Trusted resident tracing optionally records the absolute slot anchor, scheduled
deadline, actual wake, sample, worker return, validation, renewal and submission.
An early timer notification re-arms the same slot; a result settling exactly at
the next available boundary does not skip it. Trace sequence gaps, observer
errors and finite-history omissions make evidence incomplete. Streamed timing
subscribers can retain their own bounded population beyond the diagnostic ring;
exported lease and application-stage snapshots are detached. These diagnostics
grant no actor read or input authority.

Operator diagnostics retain at most 512 request samples, with explicit
omitted, missing and invalid counts. Source validation/publication, model
admission/first response/settlement, capability waits and worker startup or
cleanup have correlated host-clock endpoints. Worker startup witnesses the
supervisor ready boundary, not completion of every source computation.
The supported SDK exposes the prepared request and first complete received
SSE event, not a raw network-first-byte hook; that unavailable endpoint is
explicit rather than inferred from the event timestamp.
Failed validation publishes no revision; unconfirmed cleanup is not a
successful barrier. Source timing also covers exact-snapshot revalidation
and import for working programs and experience; a refused import publishes
no source identity. Native input receipts separately identify actual
movement-key sampling, camera setter changes and retiring-owner key release;
none proves a gameplay effect or that a camera update was rendered.

Durations stay in their originating clock domain. Overlapping spans are not
additive idle time. Required game waits, authored deliberate waits and
infrastructure stalls are separate categories when supported by evidence;
unclassified time is not automatically inference delay or wasted motion.

Root defaults are 120,000 ms, 64 actions, 256 host calls and depth eight; hard maxima are 600,000 ms, 512 actions, 2,048 calls and depth eight. Child calls require declared exact dependencies and an acyclic bounded graph. The tree shares consumed budgets and deadline; children cannot reset them. One worker has at most one host capability outstanding. Parents never hold the avatar lease while awaiting children. Only leaf actions own effects, with `origin:"skill"` and their `execution_id`.

Durable `(run_id,start_key)` admission commits the original request fingerprint and identity before dispatch. Identical retries return that identity even after epoch changes; changed requests conflict. Historical lookup grants no renewed authority. Pause, stop, death and recovery fence roots, descendants and leaf work before closure. Restart reconciles accepted-undispatched work as cancelled and dispatched unfinished work as unknown, then closes a nonterminal interrupted run as stopped. Durable source/events/evidence remain inspectable; continuation requires a new run and fresh admission. Restart never restores JS stacks, world state or replays programs.

Each execution uses a dedicated restricted Docker container. Runnable computation has an external deadline; only a trusted host-known bounded capability wait suspends it. Worker heartbeats cannot extend authority. Cancellation fences capabilities first and waits for confirmed cleanup. Emitter closure cannot establish that prior game effects never occurred.

Keep closure barriers separate from outcome classification. An action/root can remain `unknown` after confirmed input neutralization and sandbox cleanup; historical uncertainty alone is not a live writer. `GameBridge.neutralize(expectedOwner): Promise<void>` compares the operation owner before requesting its native input barrier. Trusted lifecycle fences use the separate global `emergencyStop(reason)` operation. Pause/Stop await native/worker/planner/action drain, including worker closure when cancellation fails, without rewriting unknown effects. A missing acknowledgement cannot establish safety; unconfirmable transport/emitter failure still closes the owned client fail-closed.

A healthy, connected, alive session can reconcile an unknown effect autonomously rather than requiring operator Resume. Synchronously fence the affected root, planner, policies and leases; retain the unknown ledger without replay; await actual native neutralization and every worker's closure; then obtain a fresh authorized observation matching that session and life. Only after these gates pass create one new strategic generation and one `uncertainty` wake with compact outcome/reconciliation evidence. The model chooses whether to revise or admit new work; infrastructure never repeats the uncertain effect.

If the barrier, worker closure or fresh observation cannot be confirmed, keep effects closed and enter paused/fail-closed handling without treating a healthy connection as an error merely because past effects are unknown. A real transport error still follows owned-emitter teardown. Death during reconciliation transfers to the existing once-per-death recovery path. Operator Pause/Stop intent takes precedence throughout.

`RunView.skills` and `RunView.executions` expose immutable versions and linked execution history. `usage` and `usage.by_purpose` expose `uncached_input`, `cache_read`, `cache_write`, `output`, `calls`, nullable `known_cost` and explicit `legacy_input`. Historical aggregate-only input is not relabeled as known uncached usage. Default strategic context contains the task, adapter-owned state/metadata, execution progress/closure and selected actionable failures; `observe` and read-only inspection retain authorized detail on demand. Minecraft supplies its own player and inventory projections. Pending programs suppress idle/tick strategy polling.

Runtime `usage.accounting_basis:"sdk_reported_subtotal"` identifies those accumulators as observed SDK/provider-message subtotals. All four token categories, including `output`, can be null. The schema and UI preserve null as Unknown and distinguish explicit zero; visible usage rows say reported subtotal rather than implying proven full consumption. Earlier valid contributions survive a later missing field. Legacy null breakdowns and `legacy_input` remain readable, and Store startup does not rewrite historical run payloads to add this accounting label.

New `model.usage` records carry `usage_evidence.schema_version:1`, the host `request_id`, separate `sdk_reported` counters, nullable `provider_terminal` metadata and bounded unaccounted-response identities. [`provider-usage.ts`](../src/server/provider-usage.ts) recognizes the supported OpenAI/Codex Responses terminal events; Jev supplies the same evidence contract from its actual response body. The strategic stream wrapper captures the admitted request for that invocation and preserves the existing provider/auth options and raw observer. Duplicate or late predecessor observations cannot certify another request. Only allowlisted terminal type, source, correlation and counter metadata enter accounting evidence; raw events, request payloads, headers, credentials and hidden reasoning are excluded.

SDK usage presence, response IDs and stop reasons are not terminal-counter proof. Missing or inconsistent categories stay null, and uncertain orchestration/cache subdivisions cannot become qualified numeric totals. Explicit terminal zero can be evidence without a response ID when invocation binding is established. Collected terminal counters also survive local abort and unsettled-request finalization; this preserves accounting facts without manufacturing a message, successful outcome or resource-drain acknowledgement. Evaluation derives separate event and consumption coverage from these records, as defined in [learning and evaluation](learning-and-evaluation.md#model-choice-usage-and-cost-to-result).

Request purpose is host accounting; no model tool or accounting-only inference request is required, and the old purpose-setting tool has no alias. At admission, `model.call` records the provisional role with `purpose_source:"host_turn_role_v1"` and `purpose_final:false`. After the assistant response, final accounting uses `purpose_source:"host_role_and_tools_v1"`. The precedence in [`strategic.ts`](../src/server/strategic.ts) uses host review/speculation/recovery/authoring role before visible requested tool operations; source/assessment activity is classified without asking the model to label itself.

`model.purpose_classified`, usage and settled-request evidence retain the final classification. If it changes, reattribute the purpose buckets without changing total calls, token counts or cost; pricing/unknown-cost semantics remain unchanged. A request without an assistant response retains its explicitly non-final provisional role. Existing purpose enums and historical accounting stay readable; host-source attribution remains distinguishable from immutable historical model-declared events. Classification never inspects model prose, source semantics or hidden reasoning and is not a causal explanation of the request.

Policies declare `backend:"javascript"|"jev"` and finite `choices:[{id,decision}]` or `null`. JavaScript source is a compact async body with `context,state`; Jev uses the real trusted OMP NativeJudge/TypeSafe broker. Missing credentials, failure and stale output remain explicit; local JS never impersonates Jev.

Promoted snapshots retain exact source/cards/dependencies, model/profile and source-run/world provenance, and attributable useful gameplay evidence. Portable declarations cannot include retained world data; world-local snapshots require the same world. Fresh hydration excludes old invocation arguments, observations, worker state and stacks. These checks do not prove semantic portability or generalization. Broader knowledge/search/history and comparison obligations below remain release requirements.

Explicit compatible cross-model product imports must preserve authoring provider/model provenance and recheck applicability, source, profile and capabilities. This target is separate from sealed experiment partitions. It does not make the current model-scoped library an implicit shared catalog, and initial study execution refuses inherited-library conditions.

### Evaluation governance

`StudyLedger` shares the protected `attempts.sqlite` authority with diagnostic admission while retaining separate declarations, immutable slots, reservations, request ownership, outcomes and closures. Diagnostic history and its two-unsuccessful rule are unchanged. The actual acceptance lifecycle reserves a live study slot before auth discovery/native preparation; its optional `StrategicRequestAdmission` hook reserves each strategic request before transport and checks the frozen actual model identity.

Per-attempt request/wall allocations, summed cohort allocations, simultaneous requests/workers and elapsed cohort deadline are separate finite bounds. Unknown/interrupted reservations retain their slot and allocation. A terminal SDK event alone is not transport drain: the owner joins the actual stream iterator and later Agent/turn/auth scope closure. Confirmed resource release is a separate durable fact and never rewrites unknown consumption or an interrupted outcome. The database owner explicitly finalizes its fixed prepared statements before synchronous close.

Whole-agent live studies use cold fresh seeded Normal Survival with private Store/program state and no global experience/publication path. Seed/settings and actual profile/verifier/native/model identities are checked; seed equality does not establish a matched save. That route rejects restored/prepared starts, inherited libraries, alternative controllers and Jev before external preparation. Admission-only runs exercise governance without a game or provider.

The separate `resident_platform` route admits checked evaluator-authored native
timing fixtures. It requires an explicitly prepared Normal Survival arena,
declared cheats/resources, null model identities and zero provider allowances.
Immutable slots retain technical outcomes and actual resource drain;
`agent_status:"not_run"` and null goal/usage prevent a platform pass from
becoming a gameplay result. Its declared calibration and full E01 cohort
remain separate.

New E01 declarations require capture-to-applied-input p95 <=50 ms and p99
<=100 ms at 20 Hz during healthy native tick progress, with no
infrastructure-caused gap >=1,000 ms while a valid fixture has input ready.
Lower rates are exploratory but remain subject to load independence.
Expiration does not establish continuity. Retain maxima, missed slots,
expiries, native stalls and clock uncertainty, including failed or incomplete
windows. A new frozen build and protocol gets a separate 27-slot series;
earlier results cannot be pooled into it.

The fixed E01 runner supports a normal generator with structures enabled,
and checks selected safe properties from its actual owned server before task
admission. Measurement-frame decisions retain late confirmed ACKs and explicit
unconfirmed or censored dispositions; conditional latency quantiles do not
claim those omitted decisions were confirmed. Before choosing its planned
post-window Stop, the evaluator joins measured ACKs within the original root
and work deadlines. It rechecks deadline, abort and original native scope after
synchronous population reads and immediately before that Stop. Actual operator
or authority Stop is never delayed by this wait. Later post-window submissions
cancelled during Stop stay explicitly unconfirmed with unknown effects; they
do not enter the fixed measured population. Each native child retains its
240-second wall and 25-second cleanup reserve. A trusted finalizing transition
does not extend that deadline; resource release requires actual process close
and separately confirmed drain. After all native children close, the parent
derives replays from their sealed captures, with at most 30 seconds per encoder
clipped to the original registered cohort deadline. Derived-media records stay
separate from immutable child outcomes. Missing or failed derivatives prevent
technical cohort completion; full original-speed inspection remains required.

Current `run.adapter` provenance records `{descriptor,compatibility_hash}` from the actually negotiated adapter. The immutable descriptor pins game/version, adapter/version/build-input hash, envelope/payload schema identities and hashes, complete materialized profile configuration/hash, actual capability schemas/hashes, actuator and executable API/validator/runtime5. The built JAR contains `gameharness-native-contract.json`; the host reads that actual ZIP entry and final artifact hash, checks actual build inputs, and compares the native process's descriptor rather than supplying an expected hash for it to echo. Runtime receives the registered adapter object/getter, never an adapter-id string heuristic.

Historical schema2/API1–4 sources, observations, reports, outcomes and original identities remain read-only and are not relabeled, restored as live controllers or silently imported. Active source validation, dependency import, working libraries, experience hydration, policy activation and effect admission require the complete API5 stamp, selected entry where applicable, stable compatibility hash and source/configuration fingerprint. Boot/session/run/life/space identities do not affect reusable source compatibility. Explicit revalidation creates a new immutable validation identity. There is no old active shim, child-calling alias or fallback adapter. Mineflayer and synthetic-adapter evidence cannot be relabeled native.

Native inventory-gain promotion evidence requires `inventory_receipt_confirmed:true` and trusted own before/after counts. The trusted predicate event must occur within the closed root's bounded execution interval. Exact craft/dig `target_name` plus trusted task verification can qualify delayed pickup only within that interval; later gain cannot extend it retroactively. A trusted-goal cancellation can close an eligible root without pretending it self-completed; local predictions/assertions cannot qualify. These rules define evidence eligibility, not generalization.

Current goal-evidence projections validate the adapter/verifier identity and version, then resolve the verdict's `evidence_refs` to retained typed observations and confirmed action receipts. A referenced removal/final-product receipt is `direct_receipt`; a positive own inventory receipt supported by the referenced collection observation is `inventory_collector`. For combined wood acquisition and table production, a prerequisite production receipt can establish pre-consumption wood possession (for example, oak planks made from a log); it remains an acquisition witness, not the final table receipt. The retained witnesses must establish acquisition before production and possession afterward in the same life. An independently confirmed wood removal can remain `block_removal_contributor` without qualifying its root as the collector. All associations retain `causal_item_origin:"unknown"`; missing references, foreign scope and unconfirmed receipts do not supply verified-goal proof. Historical v1 `{goal,item,action_id}` payloads keep their explicit read-only decoding.

The operator's promotion selector reads current inventory counts from the typed `adapter.evidence` observation payload and checks run/execution scope and interval before offering a candidate. A recovery root's immutable admission lineage is not rewritten: the selector follows retained `skill.life_adopted` evidence only when linked to that root's successful confirmed respawn and the matching authoritative new-life observation. Missing or omitted adoption proof cannot authorize arbitrary foreign life/space. The selector does not require a built-in goal, so custom-task inventory gains remain selectable. Historical `observation.inventory` counts stay inspectable as historical records, not current adapter qualification. Selection does not bypass the backend's baseline-gain and attributable-effect checks.

### Session, run and player-life gates

Live `ObservationV3` has world/session/epoch/native-boot identity, life, `space:{dimension_id,space_epoch}`, `screen:{screen_id,incarnation,revision}|null`, sequence/capture time, compatibility/profile/configuration hashes, freshness and adapter-owned `data`. Generic Runtime, prompts, tools and browser state do not require player/inventory/block/recipe fields. Adapter projections supply actor-facing state/metadata. Before readiness, binding/life/space may be null. Historical authority stays null when absent; new admission never invents legacy identity.

Effects carry `{operation_id,compatibility_hash,scope,invocation,action,expected_screen}`. `expected_screen` is **required `ScreenRef|null`**: null means the view must still be absent, not “skip this check”; omission is invalid. Scope is exactly `session_id,world_id,epoch,native_boot_id,run_id,run_generation,life_id,space_epoch,execution_id,source_hash`. Invocation is a real host-created skill, policy or diagnostic source owner; diagnostics and policies do not create fabricated skill-execution rows. The single existing arbiter attaches authority, and native code checks it at receive, game-thread dispatch, baseline application and subsequent input/ticks. An already-applied helper can follow its own UI transitions under separate owner/scope continuity checks; this does not waive the initial screen-absence check. Cross-language counters are checked nonnegative JavaScript-safe integers represented as Java longs, never narrowed Java ints. Ordinary cleanup compares the expected operation owner; global `emergencyStop` is explicit.

Minecraft targets use `target:{target_id,incarnation,space,life_id}` (and craft `table`, gaze/interaction `target`), not executable `target_id`/`table_id` strings. Actual pinned world/join/respawn/position, block/entity replacement and screen/handler transaction hooks revoke stale references; short authoritative teleports fence space without a coordinate-jump heuristic. Dimension travel changes space, not life. Screen revision is a view/transaction precondition, not an animation clock. A helper may change its own UI only after its original apply-time checks; queued work cannot inherit the replacement screen.

`PlayerLife` is `{life_id:number,status:"loading"|"alive"|"dead"|"respawning",can_respawn:boolean,death:{death_id,at,message}|null}`. Native evidence owns transitions. Death retains the deceased ID; a confirmed new physical incarnation advances it once, separately from the full readiness gate that permits gameplay. Respawn preserves session ID, world and connection epoch.

Minecraft connection readiness requires an authorized alive observation with `screen:null`, or an authorized dead observation. An alive snapshot behind the loading screen is not ready for initial gameplay. This uses the existing bounded connection wait; stale observation, screen and life checks remain unchanged.

While dead, actual vanilla DeathScreen readiness changes publish a normal life notice so `can_respawn` can become true without an observation call, action or reconnect. This preserves the same session, epoch, life, death episode and native generation; it neither duplicates the death event nor requests respawn. Saved-dead startup retains `death:null` when no new death episode was observed.

On normal death, immediately revoke old-life commands and pending policy/planning results, clear target bindings, release held buttons/camera and drain affected workers. Interrupted unconfirmed effects remain `unknown`. Keep the client connected, `game.error:null` and authentic vanilla DeathScreen frames streaming. The run stays active and wakes the strategist once with compact death evidence and last authorized context; the runtime supplies no survival or respawn policy.

Ordinary effects require an alive matching session/life. Observation, recipes and authorized read-only tools remain available while dead/loading/respawning. An explicit `game.respawn()` requests vanilla respawn at most once per admitted action, checks death-screen readiness and awaits authoritative new-life health/world readiness. Timeout preserves uncertainty and never replays. Only the recovery root correlated with its own confirmed successful respawn may atomically adopt the new life before continuing from fresh observations; every other old-life root/proposal stays fenced. A late authoritative new-life observation can update life status after an unknown respawn result but cannot rewrite or revive that unknown execution. Startup in a saved-dead world never respawns automatically.

A confirmed player replacement with authoritative positive health and pose establishes a distinct incarnation even if it dies before the inventory-readiness receipt. Record that replacement as a new dead life, fence its generation/handles/inputs and retain the emitted respawn result as `unknown`; no successful alive admission or root adoption follows. Another explicitly authored recovery may target that new dead life. Player replacement invalidates receipts from the previous player instance, and a neutralization acknowledgement must bind the actual sent generation/session and owned process rather than falsely treating a later death generation as transport failure.

Goal completion, model-requested custom-task closure, Pause and Stop run close run authority and await actual neutralization/drain while retaining a healthy session and video. No effects are admitted while paused, stopped or reviewing. Stop world, world replacement and app close own explicit connection/process shutdown; unconfirmable control failure may require safe disconnection. Neither death nor an unknown historical effect alone is a reason to tear down a healthy session.

Same-session working definitions are selected by `working_programs:"continue"|"fresh"` at run creation. Continue can import exact validated definitions/dependencies only for the same `session_id` and model; fresh omits them. These `working_candidate` records carry no old args, observations, private state or JS stacks and do not qualify cross-session experience.

Retention keeps one coherent latest run snapshot and its exact dependency closure for that session/model. A freshly authored same-name definition with a new ID replaces the working selection coherently; it never edits original source or mixes incompatible closures.

## GameAdapter descriptor and interface

The implemented descriptor/schema negotiation and generic observation/action boundary keep scheduling and authorization independent of adapter-owned payloads. `RegisteredAdapterContract` validates the actual trusted registered JSON schema documents, not just peer-supplied hashes. Only declared implemented capabilities/read bindings are exposed; missing support rejects explicitly. The broader extension requirements below remain requirements rather than claims of additional supported profiles, games or state operations. No synthetic counter adapter certifies Freedoom, and no declaration creates a success stub.

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

The manifest records `observation_profile_id`, `observation_profile_version`, full `observation_profile_config` and its `observation_profile_fingerprint`, plus `observation_interface`, `observation_schema_id`, `observation_schema_version` and schema hash. Information permissions and the observation interface are separate: structured state/events and authorized actor images are delivery choices, not evidence of fairness. The profile declares permitted facts and any private controller information; a structured interface still needs enforcement.

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

Rejected native observation reads emit bounded host diagnostics identifying the first failed authority fence, correlated request/response monotonic times, observation sequence/capture time and last accepted scope-notice generation. They retain the original rejection and issue no extra native read. Raw observations, targets and credentials are not included.

| Observation content | Required representation |
|---|---|
| Identity and timing | Manifest/game/adapter/profile/schema identity, run/world/epoch, observation sequence, capture time and local age, envelope schema version. |
| Domain payload | Bounded adapter-declared snapshot/delta data. Profile rules specify which current state may be exposed and how each field's provenance is represented. |
| Unknown information | Explicit unknown/unobserved semantics defined by the profile. Omitted records do not establish absence unless the profile explicitly supplies authorized completeness evidence. |
| Remembered facts | World identifier, original observation references, last-seen time, and uncertainty. They cannot masquerade as current visibility. |
| Relevant revisions | Trusted revision tokens for capability-declared dependencies, with meaning and invalidation rules supplied by the adapter. Generated content cannot forge them or omit mandatory dependencies. |

Domain references expire with their epoch and profile-defined visibility/validity semantics; legitimate rediscovery can assign a new reference. Remembered facts do not grant a current effect handle. Every effect rechecks its declared present-time domain constraints at the adapter gate. Mechanics and navigation must respect the selected profile's agent-facing and controller-only permissions, including internal helper libraries, errors and result timing. A declared private controller permission does not authorize returning its inputs to the agent.

Filter before exposing counts, ranking/order, cursors, pagination/truncation metadata or error details. Omitted/unobserved records mean unknown, not absent. Agent-facing searches operate on an authorized observation index; raw candidate discovery is internal adapter work. A raw type-specific search capped at `k` candidates followed by filtering is not automatically a safe or complete search: hidden matches must not determine visible omissions or metadata.

Human viewing is a separate permission. The narrow authorized image path is [`Runtime.modelObservation()`](#delivered-actor-images-and-recorded-episodes), which supplies a typed actor PNG on the initial strategic prompt and `observe`. It grants no agent HTTP access, arbitrary image/viewer-route retrieval, raw renderer buffers, protocol objects or hidden state. A human live view does not widen agent observation permissions.

## Tools and error results

The [model-facing interface](#current-compact-program-interface) and its generated help own callable names and schemas. Dotted names in the later experience, trial and adapter sections label broader release obligations, not additional model tools or compatibility aliases.

Inputs require schema validation and role/capability authorization. Errors must not expose raw game objects, credentials, host stacks or forbidden facts. A retryable error permits bounded reconsideration, never blind effect replay. Registration/source revision stores an immutable artifact without gameplay effects; observation, catalog/source/history and comparison reads grant no activation authority.

An undeclared or ambiguous named `game.call` dependency is refused as `precondition_failed`, before child admission or native effects. Its bounded diagnostic identifies the pinned-program contract; it is not a backend outage. Unexpected host exceptions remain redacted rather than exposing their original messages.

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
| Pending-root authoring | `3` admitted SDK calls, `12` tools, `60000` ms per actual foreground root, clipped to the original turn/root deadlines |
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

### Ordinary authoring while a root runs

An admitted foreground root opens one authoring window bound to its actual Store execution, exact source hash and run/generation/session/life/boot/space scope. The next supported SDK request boundary selects the authoring catalog after the original submit/start tool group returns. The same strategic agent can then continue naturally for at most three admitted calls, twelve tools and 60,000 ms, within the original turn and root deadlines. The actual provider request receives the phase contract, named source/version/hash and remaining allowance inside the existing 32 KiB context supplement.

Authoring allows `observe`, `help`, read-only `program_inspect` and pure `program_write`. A successful write saves an immutable inactive version; it cannot submit, start, activate, stage a successor, finish the task, mutate memory/reflexes or record a review. The playing root and its effect lease continue under their original budgets. No polling timer, keepalive request, second actor or additional transport owner is introduced.

Calls and tools share the root's allowance across selected/resident wakes, child/leaf admissions, inactive revisions and intent updates. Exhaustion stays latched until a genuinely new root or a new run; repeated admission does not reset counts or time. Root settlement, scope loss, Stop and the finite window timer fence captured asynchronous tool commits and late results. Host window expiry cancels/drains authoring transport without pausing a healthy body or labeling expiry as a provider outage. A genuine provider failure still follows normal pause handling; absent usage remains unknown. Entry/exit events retain the reason, root/source identity and counters.

Root outcomes and attention remain queued behind the existing single-flight owner. Explicit selected/resident attention and meaningful recovery/outcome signals retain their existing bounded ordinary decision request, including current-root intent updates and stop. That decision remains available after inactive authoring is exhausted; its later natural continuation must use the remaining authoring allowance and cannot renew it. A gate that admits zero calls does not consume the evidence cursor. Explicit speculative lookahead and post-goal review keep their own roles and finite allowances; neither renews or lends calls to ordinary authoring.

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

Recoverable guard source-validation errors may carry a bounded `stage_correction` allowance for an explicitly authored correction on the same flight. Only the whitelisted source-validation issues qualify; unsafe ambient access, stale authority and expiry remain terminal. Correction resets neither counters nor deadline. Rejected guard chunks/hashes, issues and omissions remain evidence; missing historical source cannot be reconstructed from a syntax location.

`PlanProjection` retains guard omission/result, activation mode/permit/trigger, predecessor closure, pinned candidate, observation and activation evidence. Read it through planning inspection. Record requests, overlap, validation/rejection, admission and usage; `overlap_ms` is not causal speedup. The [integration evidence](integration-spike.md#verification-scope-after-the-published-checkpoint) separately scopes the old manual baseline that opened the edit gate and the later zero-inference native continuation proof; neither establishes natural-model efficacy.

After a verified goal, one bounded effect-free review can use at most three calls, twelve tools and 30,000 ms under the improvement request purpose. It can inspect evidence/source and author linked candidates before completion. It cannot start further gameplay trials after the user's goal is satisfied.

### Action admission and outcomes

An action request records:

- Identity and scope: schema version, manifest/game/adapter/profile identity, run/world/epoch and action ID.
- Origin: owning skill execution or policy/version/evaluation; declared capability/schema and explicit arguments. Historical strategist-origin records remain evidence only; new ownerless or direct-strategist effects are rejected.
- Scheduling: bounded declared priority, submission order assigned by runtime, finite queue deadline, finite execution duration, and preemption/cancellation rules.
- Basis: observation sequence, maximum basis age, relevant revision tokens, and typed preconditions.
- Evidence: admission/start/end timestamps, lease generation, state, partial effects and result references.

Each internal action invokes a bounded registered adapter capability. Generic `GameAction` retains a bounded JSON kind/payload, while `minecraftActionSchema` owns Minecraft units, limits, target references and semantics. Actual adapter validation occurs before durable admission/preemption and again before native dispatch. Skill invocation remains a distinct core operation whose leaf effects cross this interface.

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

Source publication prepares durable artifact bytes asynchronously: verify an
existing file, or write and sync a temporary file, rename it and sync the
directory. Before the single synchronous SQLite publication transaction, the
caller rechecks authority. A revoked call or closed Store cannot publish a
revision or registration receipt after preparation; an unreferenced durable
artifact may remain. Inputs are detached before preparation so concurrent
caller mutation cannot change the published source, metadata or receipt.
SQLite WAL/FULL durability is unchanged. This removes filesystem persistence
from the control event loop; synchronous database commits and history reads
still need separate timing evidence.

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
| `GET /v1/runs/{run_id}/skill-evidence` | Insertion-offset `after`, `limit`; records, continuation, omissions and published projection provenance. |
| `GET /v1/runs/{run_id}/objective-metrics/{execution_id}` | Required `generation`; lossless full metric archive with `record_index`, `chunk_index`, `limit` continuation. |
| `GET /v1/runs/{run_id}/skill-evidence/{execution_id}` | Required `generation`; lossless full evidence archive with the same chunk cursor. |
| `GET /v1/runs/{run_id}/trace` | Cursor `after`, `limit`, optional `execution_id`; bounded actual execution/root trace. |
| `GET /v1/runs/{run_id}/improvements` | Optional JSON-encoded V2 `after`, `limit`; independent opportunity/metric update streams, structured `next_after`, omissions and projection provenance. Legacy insertion cursors are rejected. |
| `GET /v1/runs/{run_id}/deaths` | Cursor `after`, `limit`; `{episodes,next_after,has_more}` with last authorized context. |
| `GET /v1/runs/{run_id}/planning` | `{plan}` bounded lookahead projection. |
| `POST /v1/program-comparisons` | Exact `before`/`after` versions; nullable V2 `after_sample` pins both published generations, offset and caller scope. Returns comparison, continuation, omissions and projection provenance. Read-only computation behind mutation authorization, not gameplay. |
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
| `paused` | `running` on deliberate Resume after confirmed prior-owner drain and fresh observation; unconfirmed emitter/native drain also requires a fresh epoch. Otherwise `recovering`, `stopping`, `failed`. Resume restores neither old JS stacks nor a fresh evaluation allowance. |
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

Durable opportunities link death/failure/outcome evidence to exact versions. `program_inspect` feedback selects authorized named evidence with independent opportunity/execution cursors. `program_review` records `keep` or `insufficient_evidence` for the latest matching named outcome. `program_write` with `based_on` and an explicit experiment `reason` links an actual direct-child revision to the latest parent feedback, without a second bookkeeping-only request. Unresolved feedback receives the existing `revise` resolution. Already-assessed feedback retains its resolution; a separate `learning.candidate_written` event records the exact opportunity, execution, parent and revision references, source events and new reason. The candidate is unmeasured at authoring.

Persisted resolution records retain `revise`, `keep` and `insufficient_evidence`: the host supplies exact parent/revision/model/hash and source events rather than asking the model to copy them. A linked revision is a chosen/performed candidate experiment, not verified improvement, adoption or promotion. Internal `revise` requires an exact revision reference; assessments carry no revision. Invalid linkage cannot persist a fabricated resolution, and an immutable conflicting decision is rejected. Historical resolution records retain their original IDs and semantics. Opportunity and feedback storage remain bounded; the broader release detector remains a requirement where not delivered.

`insufficient_evidence` limits the strength of an improvement claim, not permission to author and try a bounded candidate while the goal remains unsatisfied. Repeating an unchanged blocked program under unchanged conditions supplies no new outcome evidence. Generic experiment guidance does not supply game tactics, relax source limits, modify the model's historical source or permit effects after goal success.

Objective comparison reports confirmed block removals by registry identity, receipted own-inventory deltas, target-ID/position switches, sampled and receipted travel/rotation, attributed timings, sample counts, outcomes and trace limitations. No generic rule labels every extra block unnecessary, infers tree identity or invents a reason for changing target. `VersionComparison` includes exact source/card differences and bounded sample pages; its conclusion is `descriptive_only_no_causal_improvement_claim`. Unmeasured revisions are candidates; measured observations still do not establish causal benefit.

Measured status requires actual dispatch (`started_at`), not merely an accepted then cancelled execution. Sampled native yaw/pitch are converted from radians to degrees using shortest-angle deltas. Strategic comparisons use trusted current-run/model scope before source reads; the separately authorized operator route explicitly selects operator scope rather than trusting caller-supplied scope.

`feedback.read` and UI events expose source-linked progress and failure, not inferred success from fluent explanation. Records distinguish model decision latency, provider attempts/retries, runtime dispatch and reaction latency, action duration/outcome, blocked planning, interrupts, meaningful game waits, LLM-induced idle time, queue pressure, backend errors and actual usage. Gameplay evidence includes objective/subgoal changes, failed actions, deaths and observed consequences. [Learning and evaluation](learning-and-evaluation.md) defines aggregation and Time to Fluidity.

Record unavailable measurements as unknown. Include active policy/skill versions, action IDs, observation basis, evaluation rejection reasons, intervention/downtime intervals and unknown effects so investigators can reconstruct why a control was or was not issued. Diagnostics must not bypass observation permissions; privileged result verification remains separate from planner context, generated programs and reusable memory.

Timing evidence records accepted start, transition to running, strategic authoring-request admission, opportunity creation/delivery/acknowledgement/deferral, source/card authoring, validation admission/completion, activation-request acceptance/effective switch, trial bounds/decision/closure and first confirmed current-run effect/outcome. Link each timestamp to its event/process/epoch clock and record clock discontinuities rather than subtracting unrelated monotonic values. Track trigger opportunities, actual admitted policy uses, rejected proposals, revision counts, retrieval/cache outcomes and full sample sizes. The [learning protocol](learning-and-evaluation.md#policy-acquisition-and-revision-evidence) defines derived metrics and useful-policy evidence; control timing and task efficacy stay separate, with before/after correlations explicitly distinguished from controlled evidence.

## First integration: Minecraft Java Normal Survival

The profile targets Minecraft Java 1.21.4 Normal Survival, one avatar, ordinary spawn/inventory/death rules and no agent cheats/operator privileges. An actual Java 21 Fabric client owns raw state, filtered perception, smooth motors and post-HUD video. The managed Fabric server requires session proof; matching names, offline whitelists or player caps are insufficient. Control binds private session/world/epoch authority separately from video. Transport loss fences effects and neutralizes controls before renewed authority. No old-adapter fallback is allowed.

### Current player-observable structured profile

The active profile is **`minecraft_assisted_rgb_360_r8_gui_v2`**, version 2. The descriptor declares observation envelope **3** and payload schema **`minecraft_observation_v1@1`**, with separate schema hashes. Its materialized configuration is radius 8, at most 144 blocks/32 entities, maximum age 1,000 ms, camera-independent native raycast occlusion, opaque RGB PNG with unsynchronized alignment, the actual `balanced`/`precise`/`fast` motor setting and semantic helpers enabled. The explicit visible-GUI read adds current visible layout with at most 128 slots, 64 elements and 32 progress entries in logical GUI coordinates. The world payload additionally bounds own inventory to 64 entries, sounds to eight and all collections together to 256 entries. These identities and values come from [`native-contract.ts`](../src/server/native-contract.ts) and [`minecraft.ts`](../src/shared/minecraft.ts); the configuration and compatibility hashes bind the actual contract. Earlier r8-v1 episodes retain their original profile and evidence.

The active profile does not implement the 32-block scheduled sampler target below or a frustum/strict-visual condition. Actor images remain unsynchronized with structured observations, and their host selection scope is not capture metadata. GHV2 packet render/scope diagnostics are retained separately rather than silently exposed through this profile. Structured assistance is not human-identical perception, and older r2 history is not relabelled.

Nearby unobstructed blocks/objects and entities may be observed within the configured finite range, regardless of camera yaw/pitch. A nearby tree behind the camera is eligible; rotating the camera alone does not revoke it. Obstruction/occlusion, range, loaded-client availability and bounded sampling still apply. This permission neither reveals all loaded chunks nor removes walls. The initial sampling rules below have no camera cone.

The profile permits normal F3 position, own health/status, inventory/UI, public recipes/docs and legitimate world-local memory. Hidden resources/structures, exact live concealed entity state, seeds, saves and evaluator state remain unavailable. Raw native world/chunk/entity collections and renderer buffers are not agent APIs. The trusted adapter's possession of client state for perception/physics grants no broader strategist, generated-program, retrieval, library, log or error access.

| Profile configuration field | Documented scheduled-sampler target; not the active native profile |
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

These are proposed engineering settings, not current native defaults or measured performance. Their implementation needs a new profile/preset identity rather than silently widening the active eight-block permission. Before admitting a run, retain its actual effective configuration, algorithms, game/registry/geometry revisions and overrides; do not fill missing current or historical values from this future table. Fingerprint the materialized configuration with SHA-256 over RFC 8785 canonical JSON. Configuration changes require a new identity and separate comparison condition. Loaded state and eligibility further restrict access; neither radius authorizes its whole volume.

Historical revision r2 added schema-2 session/life lineage and optional `item_name` on eligible item entities without introducing camera-frustum filtering. Active envelope 3 / Minecraft payload 1 retains that permitted projection: `item_name` is only the registry identity of a visibly represented nonempty ItemEntity stack. Other entities cannot carry it. Exact dropped-stack count, NBT, custom/lore data and concealed item identity remain unavailable.

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

`look` and `move.look` remain explicit free orientation. `navigate.gaze` is optional: `{kind:"navigation"}` by default, `{kind:"target",target}` with a fresh `TargetRef`, or `{kind:"free",yaw,pitch}`. Default gaze samples bounded actual local route geometry, interpolates a near-route point and adds eye height so flat ground stays level and slopes affect pitch mechanically. Target interactions use target gaze. Movement gating uses yaw rather than pitch; free/target gaze must preserve world-direction travel through legal strafe synthesis. `navigate.range` allows 0.5–4 blocks for ordinary approach precision, not an automatic pickup tactic. Camera/navigation speed and useful-play improvements require new measured evidence.

`navigate.arrival` distinguishes two completion conditions. Omission or
`"position"` retains full three-dimensional distance from the player's feet to
the last-authorized target location. For a block, `"interaction"` instead requires
eye-to-block-centre distance within the requested range **and** the existing
native reach and line-of-sight checks. It does not increase interaction reach or
mine the block. Entity targets support position arrival only. Horizontal
proximity alone never establishes either condition.

Unless arrival already holds, navigation also requires initial feet-to-target
distance at most 8 blocks and current distance at most 10. These are separate
from the sampler's integer offsets around `floor(feet)`: a freshly observed
block centre can still exceed the initial distance bound. Refusals expose
`start_distance_limit` or `current_distance_limit` with actual distances and
limits. Repeating the same request without a changed local approach cannot
make it eligible.

The local motor stops after 750 ms without a supported route, or 1,500 ms
without improving the best remaining arrival gap by more than 0.1 block. One
initial camera-settling allowance is capped at 750 ms; circling cannot renew it.
Results expose coarse `blocked`/`no_progress` feedback, the arrival mode and
tested reach information, not private route geometry. A stop after emitted
movement remains `unknown` unless independently confirmed; early termination
does not make the movement safe to replay.

Raw `move` success means that its requested input interval completed, not that
the player travelled or escaped. Receipts distinguish net/horizontal
displacement and height change from cumulative travel, and report own-body
grounded, support, headroom and collision feedback without revealing terrain
materials or a route. Intentional stationary movement remains valid. A
purposeful travel/ascent procedure must compare fresh settled positions over
a small bounded sequence, allowing detours but stopping after at most three
ineffective bursts to reobserve and change approach or return blocked.
Accumulated jumping distance is not ascent. Forward input follows the camera
while `move.look` turns; in confined geometry, an ordinary completed `look`
can establish orientation before moving. A separate completed jump does not
keep the player airborne through a later observation, aim and placement.

Placement preflight checks the requested visible face and vanilla block-item
placement state, replacement and collision before equipping or dispatching
the placement interaction. Refusals identify the failed precondition.
Receipts distinguish actual equipment and placement packet emission and
report vanilla's local accepted/pass/fail result. Local prediction does not
establish server effect certainty: vanilla can send an interaction even
after local pass/fail. Equipment effects remain legitimate partial outcomes;
unconfirmed emitted operations remain unknown and fenced. Aggregate item
counts alone cannot distinguish consumption offset by a simultaneous pickup.

An admitted motor retains only its initially validated target bindings.
Observation projection refreshes do not revoke an unchanged in-flight binding:
actual incarnation, life, space and bounded-retention checks still apply at
camera/input/effect application. New actions still require currently projected
handles. Predicted client-side block disappearance is not authoritative removal;
digging waits within its existing bound for the own server-removal evidence.
Actual replacement still revokes the old handle, including replacement at the
same coordinates.

For native movement, release motor controls at the declared duration before one ordered own-server inventory receipt. Only an actual authenticated receipt can mark inventory confirmation. A missing receipt at the bounded three-second deadline leaves the effect `unknown`; it cannot be replaced by local prediction or a fabricated confirmation flag. A separately confirmed native neutralization barrier can retain a healthy session/video without claiming effect certainty. Only unconfirmable control/emitter safety requires fail-closed client closure before renewed authority.

Navigation toward a selected visible item can outlive the entity when pickup removes it before the requested range is sampled. If it disappears within two blocks after movement was emitted, the native helper neutralizes immediately and allows at most 1,500 ms for an authoritative own inventory gain of the selected item type. That gain can confirm completion; disappearance alone, despawn, no gain or a late/missing receipt remains unknown. The helper does not select a resource or replay an uncertain effect.

Once a requested table opens its crafting grid, recipe transfers bind to that exact `CraftingScreenHandler`. Vanilla interaction updates still revoke old block handles, but do not invalidate an already-owned open grid. Replacing the handler stops further recipe clicks; life, space, owner and finite action limits remain enforced.

Craft/equip use the bounded native [`VisibleInventory`](../native/minecraft/src/client/java/io/gameharness/nativeclient/VisibleInventory.java) controller beneath the existing semantic actions; [`Recipes`](../native/minecraft/src/client/java/io/gameharness/nativeclient/Recipes.java) owns manual recipe transfers. Crafting opens the real 2×2 inventory or reachable 3×3 table screen, manually places ingredients through vanilla pickup/right-click gestures, retrieves output and returns remainders. There is no hidden recipe autofill. One virtual pointer supplies screen hover, carried-stack rendering and actual press/release coordinates before native capture. Gestures advance on ticks/rendered frames, without game-thread sleep or catch-up click bursts; world time continues.

Ingredient assignments are grouped by their actual source slot. The controller picks up that stack once, distributes single items with separate ordinary right-clicks and returns surplus once before changing material or collecting output. The mouse button is released between placements; the remaining stack stays on the cursor. Source/cursor/grid components and counts remain checked throughout, including split sources and mixed materials. Vanilla ingredient eligibility matches permitted item alternatives; it does not require a material's incidental components to equal the recipe display's default stack. This does not relax actual custody checks or implement drag distribution.

Pointer plans sample a stable inset landing, modest path/profile variation and bounded category timing at gesture/group boundaries. Short placements share a coherent group tempo; acquisitions, transfers and output transitions have distinct timing. A recorded seed reproduces the motion plan, not operating-system or game-loop scheduling. Bounded gesture evidence retains actual press/release times and exact role totals so tick/render quantization can be measured rather than inferred from nominal delays. The normal pointer stays white; no decorative noise, forced overshoot or click-state tint is added.

Each semantic operation owns one screen session. Equipment already in the hotbar is selected directly; inventory equipment is visibly transferred to a suitable hotbar/equipment slot. Placement uses that same controller and rechecks placement after the owned transfer closes, not while the item is legitimately on the cursor. Handler/sync identity, current layout, source/destination capacity, cursor and grid are checked before consequential gestures. Resize retargets pending slot travel; a held gesture or pending recipe-book button with changed geometry is revoked instead of clicking stale coordinates.

Native craft is bounded to 16 executions and `10,000 + 35,000 × executions` ms; equip to 12,000 ms and place, including equipment, to 20,000 ms. Host action deadlines include a 3,000 ms receipt margin, and transport covers those negotiated bounds. Root/parent/task budgets are unchanged and may expire first. These are safety bounds, not intentional gesture delays or promised completion times.

Successful inventory receipts include authoritative selected slot, cursor and crafting-grid custody. Stop/replacement/correction revokes pending gestures without committing a mouse release into another handler. Trusted cleanup may close only its exact owned handler; closing is not rollback. A detached handler's last carried stack remains historical evidence even when fresh current-handler custody is empty. Emitted but unconfirmed outcomes stay unknown and fenced.

Selected zero-provider Runtime/Docker/native verification exercised 2×2 planks/table/sticks, 3×3 wooden-pickaxe/furnace output, inventory-to-hotbar equipment, direct hotbar selection and implicit equipment for table/furnace placement. Focused native negatives covered full output capacity, Stop while carrying, handler replacement and an authoritative slot correction. This is evaluator-authored mechanics evidence, not model competence, human-like presentation approval or resolved model latency; visual acceptance remains a human gate.

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
