# Operations and security

GameHarness is currently a documentation-only project. This document specifies the future local operating procedure and release checks; it is not evidence that installation, provider access, gameplay, isolation, or rendering works today. There is no application command to run yet. Minecraft is the first planned complete integration, not the boundary of the adapter-based product.

The [PRD](prds/gameharness-v1.0-prd.md) owns scope and acceptance. The [architecture](architecture/overview.md) assigns trusted modules; [runtime contracts](runtime-contracts.md) define identifiers, effects and state transitions; [learning and evaluation](learning-and-evaluation.md) defines experimental integrity. [Upstream reuse](upstream-reuse.md) records dependency, authentication and license evidence.

## Supported local reference deployment

The planned reference deployment targets a documented Linux x64 environment. Operators should receive understandable setup and operating instructions with actual supported runtime/dependency versions. This is not a universal-platform promise: arbitrary Linux distributions, other operating systems, public hosting, guest access and multiuser account administration are not established support.

| Item | Current evidence | Required future procedure |
|---|---|---|
| Application | No application, package manifest, implemented endpoints, or game integration exists in this repository. | Publish real installation/start/stop instructions only after those interfaces exist. Keep prerequisite checks separate from gameplay claims. |
| Backend | Bun 1.3.14+ is the chosen target with selected published OMP packages, initially exact 18.12.3 candidates. A prior temporary smoke imported selected packages and exercised a no-provider gate. | Pin actual package artifacts and native dependencies; establish their runtime/host compatibility and distribution notices. |
| GameAdapter | Descriptor/interfaces, observation profiles and capability schemas are specified, not implemented. | Pin game/adapter/profile/schema versions, enforce declared permissions, and establish connect/effect/cancel/recovery conformance before enabling effects. |
| Game environment | Acquisition, supported versions, privileges and operating requirements are adapter-specific. | Document legitimate acquisition/account/terms requirements and verify the selected profile. See the first Minecraft integration below. |
| Live view | Supplied by the adapter; no renderer has been exercised here. | Establish actual viewpoint/fidelity, transport, authorization and stale-view signaling without exposing backing data to the agent. |
| Model access | API-key and supported subscription/OAuth flows are planned. A prior package smoke made no provider request. | Verify each operator's entitlement and supported connection flow; exercise real Jev inference separately from package import success. |
| Security and persistence | OS-isolated generated workers, trusted brokers, SQLite and immutable artifacts are design requirements. | Establish isolation, recovery, redaction and observation permissions before trusting generated programs with gameplay. |

The future setup guide must identify actual installed versions, required local ports and persistent locations, permission requirements, provider/account setup, game acquisition and terms, and a real minimal smoke workflow. Do not replace missing implementation with invented executable commands or downloadable game/account credentials.

## Early real-integration proof

Use the [Implementation MVP Contract](implementation-mvp.md) to reach a complete playable loop before building every management or recovery feature. This is an intermediate integration gate, not reduced release acceptance. Keep isolation, observation permissions, effect ownership, stop, and stale-output checks in that first loop.

### A real strategic round trip

Connect one supported strategic model through an authorized API-key or subscription flow. From a real permitted game observation, let the OMP-backed model submit an action, observe its confirmed game result, and receive the resulting feedback in a subsequent autonomously scheduled turn. Retain correlated model/tool/action/event identities and the actual result. Library imports, a fabricated provider response, an operator issuing every action, or repeatedly pressing “continue” do not prove this path.

Then show an admitted skill or composite action continuing while strategic inference is in flight, and a model-authored policy responding to a real event in ordinary gameplay. A controlled transport delay is a valid scheduling fault injection, but must be identified separately from measured provider latency. Test the real Jev path early as a separate provider integration rather than assuming the package import exercised it.

The first loop may use one connection. Final acceptance still exercises both authentication categories and achieves the same bounded, verifier-defined task with strategic models from two different providers without editing the core or GameAdapter. Account reconnection and configuration changes do not count as changing the game implementation. Failed tasks remain failed evidence until the interoperability criterion is met.

### Structured observation and navigation

The first Minecraft profile is `player-observable-structured`. Its canonical permissions and finite settings belong in [runtime contracts](runtime-contracts.md). Prove the information boundary early without making strict camera-FOV simulation or a complete previously seen voxel map a prerequisite. Information fairness defines permitted facts; the structured state/event interface defines how those facts are delivered.

Nearby unobstructed objects may be observed regardless of camera orientation. Occlusion and range still apply. Keep authorized observations and last-seen memory separate from raw chunks and entity tracking. An occluded entity's remembered position must not update from the raw tracker. A legitimate audible event may produce the profile's coarse sound information, not exact hidden entity or sound-source tracking.

Maintain a second, private geometry-only view for trusted local movement execution. Within the profile's bounded local envelope, the controller may use client-loaded collision/passability/headroom geometry toward an already authorized known target or waypoint. Individual collision voxels need not have appeared in an agent observation; local obstacle avoidance and detours toward that same goal are allowed. This does not authorize hidden resource/material identifiers, entity queries, global loaded-world route planning, or selecting an undiscovered cave, entrance, shortcut, or exploration corridor as a higher-level route.

Check target authority before consulting private geometry. Instrument internal reads, route choices, and actual movement—not only returned path text. The controller must stay within its declared envelope and authorized route intent; otherwise it stops with safe bounded-execution feedback or requests observation/replanning. Do not return private geometry, raw path nodes, reachability grids, hidden-target diagnostics, or resource-dependent errors. Private geometry may affect local steering and timing; this declared advantage is not human-identical perception and must remain fixed across comparisons.

A stock pathfinder is not trusted merely because its output is filtered. Constrain or replace its data path if it cannot use the bounded geometry projection, or use bounded mechanical moves. Neither an unrestricted raw-world planner nor the obsolete all-voxels-previously-seen requirement is the selected design. Record the actual filtering/navigation latency and memory use; do not claim an upstream helper implements the entire profile. See [source evidence and limitations](upstream-reuse.md).

Start implementation with the complete initial preset in the runtime contract, rather than choosing missing limits independently. Materialize its defaults before computing the profile fingerprint. Exercise the [observation performance protocol](learning-and-evaluation.md#observation-pipeline-performance) alongside the information-boundary checks: sampling exhaustion, stale coverage, query/serialization cost and controller delay can undermine fluidity even when LLM latency is low.

Use the following controlled security fixtures in addition to ordinary-world integration:

| Fixture | Required evidence |
|---|---|
| Unobstructed object behind the camera | The in-range object is observable before and after camera rotation. Out-of-range objects remain excluded. Camera orientation alone is not an eligibility gate. |
| Ore behind an opaque wall, then exposed | On a controlled vanilla or Anti-Xray-disabled server, evaluator-only raw diagnostics establish the hidden ore in loaded client state. Agent observations, search results/counts and errors do not disclose it. Remove the occluder through game mechanics and verify authorized discovery. |
| Occluded entity, memory and sound | Exact current hidden position/state is absent. Reveal and hide/move the entity: last-seen memory becomes stale rather than following it. An actual audible event yields only approved coarse sound information, without exact coordinates or a tracking handle. |
| Alternate generated-code/data route | Raw bot/world/block queries, entity collections, renderer buffers, retrieval routes and diagnostic errors cannot bypass the agent-facing API. Filter before exposing result counts, ordering, pagination, or truncation metadata. |
| Local geometry and hidden-route probe | Movement and local detours to the same known target can use private bounded geometry. Swapping a concealed resource for same-geometry stone does not select a target or expose its identity. Unknown-target probes fail before private lookup, and a hidden corridor is not selected as a higher-level exploration route. |
| Optional server obfuscation | Adapter filtering passes with Anti-Xray disabled. If Paper protection is also tested, record its exact configuration and distinguish masked/fake raw block data from genuine observations. It does not replace entity or navigation checks. |

Fixture coordinates, setup instructions, privileged diagnostics and staged situations stay outside agent experience and gameplay comparison inputs. These tests establish information controls, not learned tactics, task success, or performance advantages. Ordinary-world end-to-end runs remain the learning/effectiveness evidence.

### Composite control

Exercise a bounded single-lease action that overlaps movement, camera change, and a permitted interaction or attack on an observed target. Record actual input/effect intervals and show overlap, rather than inferring it from three queued commands. The adapter declares which channels can be combined and the constraints on that combination.

Repeat while a strategic request is pending. Preempt or stop the composite action and confirm neutralization of every included channel before lease transfer. Two independent writers must not be used to manufacture overlap, and a correct ownership check must not serialize every compatible input into separate actions. This is an early integration check, not a handwritten combat strategy.

## Trust and data access

The operator trusts the backend, provider/authentication brokers, GameAdapter observation/effect gates, persistence code and selected upstream dependencies. Generated JavaScript, model output, downloaded documentation, browser content and third-party tool results are untrusted. A local browser UI has operator control authority only through its authenticated session. Authentication is not granted merely because a request arrives on loopback.

| Data or capability | Allowed holder | Forbidden exposure |
|---|---|---|
| Raw game engine/protocol state and privileged queries | Trusted adapter only; narrowly scoped privileged evaluator where necessary for result verification. | Strategic context, skills, policies, generated workers, ordinary tools and their errors. |
| Profile-authorized state and legitimate remembered observations | Adapter filter, backend, authorized planner/workers and environment-scoped memory. | Promotion of unobserved content to current facts; cross-environment transfer of local maps or handles. |
| Profile-permitted private terrain geometry | Trusted low-level controller, through a bounded geometry-only projection for authorized local movement. | Agent context, generated code, remembered-object index, raw path/reachability output, resource targeting, or undiscovered route selection. |
| Hidden targets/semantic world facts, environment identifiers, save files and backups | Operator/game storage; isolated result-verification path only when necessary. | Planner context, resource/structure/entity navigation queries, reusable agent memory, public diagnostics, renderer-to-agent shortcuts or retrieval results. The private geometry allowance does not include these facts. |
| API keys, OAuth access/refresh tokens and provider sessions | Trusted provider/authentication broker and protected credential store. | Worker environment/files, model prompts, events, URLs, frontend state, generated artifact metadata or logs. |
| Game account credentials/session | Trusted operator-owned game login path/adapter as required. | Generated code, project distribution, browser activity feed or model context. |
| SQLite database, artifact store and host files | Trusted backend with least necessary access. Workers may receive bounded copies of their own authorized serializable state. | Worker mounts, direct SQL tools, arbitrary paths or host filesystem access. |
| Live-view backing data | Trusted adapter/renderer transport and authorized human browser. | Agent HTTP access, backing-state/image route retrieval, hidden-state export through viewer errors. |
| Public documentation/web content | Trusted retrieval broker returns bounded attributed text. | Ambient worker networking or access to local/private resources through URL redirects. |

Privileged verification must use a separate output path. Its hidden-state evidence may establish an objective result for the evaluator, but cannot flow back into planning, policy inputs, skill memory, generated code logs or experience libraries. Filtered agent telemetry and privileged evaluator records need distinct access rules even on a single-user host.

## Provider connections and credentials

Support both API-key connections and legitimate provider-supported subscription/OAuth connections. This is not a promise that every consumer subscription grants arbitrary model access. The provider adapter determines the supported connection mechanism and entitlement. Reuse only authentication interfaces whose exports and storage behavior have been verified, as recorded in [upstream reuse](upstream-reuse.md).

The operator initiates connection from the trusted local UI. For an API key, the backend receives it through an authenticated same-origin flow, stores it using the chosen protected host credential mechanism, and returns only an opaque connection reference and redacted status. It must never echo the value to the UI or event ledger. Provider-account secrets must not be submitted to generated tools.

For OAuth/subscription access, the trusted provider adapter owns authorization initiation, callback/device exchange, state validation, PKCE where the provider flow requires it, token storage and refresh. Any callback listener has a narrow purpose, expected redirect binding and finite lifetime; it does not expose game-control routes. Device codes and authorization URLs are displayed only in the trusted operator flow and are not recorded in shared diagnostics. Unsupported or failed entitlement is an explicit connection error, not a reason to scrape browser sessions or bypass a provider's terms.

At run start the backend resolves an opaque connection to the selected model and role. Workers can request a permitted provider operation through a broker; they never receive the secret or a general-purpose HTTP client. The broker checks capability, role, model, input projection, deadline, concurrency, finite attempts and output schema. It records logical decisions separately from actual attempts, usage where reported and known/unknown cost. Reliability deadlines, concurrency and attempt bounds are distinct from monetary accounting; they do not imply a dollar-based stop gate.

Revocation or expired refresh credentials marks the connection unavailable, rejects new requests and fences late callbacks. The UI asks the operator to reconnect through the trusted flow. Already admitted bounded gameplay can finish or be cancelled according to its normal contract; no extra strategy or substitute backend is silently selected. The agent can choose validated local-code policies when available. Jev failure remains a Jev failure in evidence, even if later code-only operation proceeds.

## Browser and local transport controls

Bind backend controls, adapter control transport and viewer to loopback by default. The reference deployment has a native host backend/adapter and private isolated worker processes or containers; it does not require containerizing the game or the entire application. A development frontend port is a distinct origin and needs an explicit temporary allowlist; production should serve the UI from its configured local origin where practical.

The backend must validate expected `Host` and `Origin` values to resist hostile pages and DNS rebinding, issue a local session through a trusted bootstrap path, and require authenticated command authorization. Use explicit allowed origins, never reflected origins or a wildcard. Cookie-based sessions require the appropriate SameSite/HttpOnly settings and anti-CSRF validation for mutations; a bearer-based local mechanism must protect its token from URLs, history and logs. Read endpoints and SSE also require authorization. No control mutation is allowed through a GET request.

UI text, retrieved material, model explanations and source snippets are untrusted display data. Render as text or sanitize through a deliberately restricted renderer; do not execute embedded HTML, scripts or event handlers. Choose a content security policy and origin separation that keep generated content from executing with operator control authority. A malicious activity-feed entry must not become a start/stop/provider command.

Authorized generated source code may be displayed as escaped, non-executable text. Viewing it grants no permission to execute a program, install or activate a policy, or retrieve another run's data or secrets. Source and evidence reads retain their existing authorization and information-filtering rules.

Apply equivalent authorization/origin checks to the viewer's actual transport, including HTTP/WebSocket where used. A human may view rendered game state, but the agent capability broker cannot request those routes. Internal adapter control messages use private authenticated transport, not a browser-reachable raw-engine interface. Port secrecy and browser CORS alone are not authorization. Browser disconnects show a stale-view warning; they do not silently stop or pause an otherwise healthy run.

## Generated-code isolation

JavaScript evaluation in a regular process, Bun/Node worker, `eval`, or a VM context is not a security sandbox. The release must run generated code inside an enforced OS isolation profile: a restricted child process with actual OS security controls, or a private container with equivalent controls. Unrestricted upstream coding-agent execution is not reusable as this sandbox.

The isolation profile must enforce:

- A dedicated unprivileged identity; no privilege escalation, host namespaces, host sockets, container-management socket or other route to privileged processes.
- No network access, including loopback, private subnets, link-local/cloud metadata, DNS tunneling and viewer/provider endpoints. Approved provider/docs/web requests cross trusted brokers.
- A read-only minimal runtime with no mounted source checkout, home directory, credentials, database, world/save directory, host `/proc` view, or unrelated process environment. Only the immutable selected artifact and bounded private scratch/state are provided.
- A narrow framed IPC interface that accepts only serialized, schema-checked capabilities. No object handles, callbacks, raw adapter references, arbitrary imports, host commands or arbitrary path reads.
- Finite wall-time and CPU/memory/process/output/IPC limits. Nontermination or flooding terminates the worker, revokes its execution generation, records evidence and quarantines the offending policy version where applicable.
- Cleanup of descendants and ephemeral state on termination. Lease safety is maintained by the trusted executor even if a worker is killed mid-request.

Isolation and observation filtering solve different problems. A perfectly isolated worker could still cheat if a broker returns forbidden game state. Every action, tool, error and retrieval result must pass the selected adapter profile's data policy. No transient debugging mode may expose secrets or hidden state to an agent run whose evidence is presented as ordinary-player performance.

### Brokered documentation and web

The broker accepts only supported public documentation/web retrieval, bounds response size and elapsed time, records URL/source/time and returns text marked as untrusted external content. It rejects local files, non-public addresses, loopback, private/link-local addresses, credential-bearing URLs and privileged viewer/control routes. Resolve and validate the destination at connection time and after every redirect; apply equivalent restrictions to proxy behavior and alternative address forms. Workers do not supply arbitrary headers, cookies or authentication material.

Queries must not leak account secrets, hidden environment identifiers/state or private run data. Public game documentation, API references and general pretrained knowledge are allowed; looking up a hidden environment or uploading its save for privileged analysis is not. Retrieved text cannot grant new capabilities or override system/task instructions. A retrieved instruction to read a credential file is content to ignore, not an authorized tool call.

## Operating lifecycle

These procedures become release obligations when implementation exists. Their completion must be observable through status and durable events rather than operator guesses.

### Startup

1. Check the supported host runtime/dependency versions, isolation availability, writable trusted persistence locations, private transport configuration and required local resources. Fail clearly before gameplay if a mandatory security control is unavailable; never substitute unsandboxed execution.
2. Load protected connection references and report redacted provider capability/availability. Actual account secrets stay in their trusted flow. An unavailable optional fast backend is visible; Jev support itself remains a delivery requirement.
3. Open SQLite with foreign keys, WAL and the selected durability settings; check migration/version compatibility and immutable artifact hashes. A single trusted backend owns writes. Refuse competing owners rather than creating two schedulers for one avatar.
4. Start/connect the selected game and trusted adapter under operator-owned configuration and terms. Check descriptor, game/adapter/profile/schema identity and actual capability/support levels. Keep effect admission closed until a new authorized session/epoch and authoritative permitted observation exist. Verify profile rules without exposing privileged configuration to the planner.
5. Establish the adapter's declared live view and authenticated UI, select the task/model/connection/world and compatible immutable library snapshot, and create the full run manifest defined in [runtime contracts](runtime-contracts.md#run-manifests-and-compatibility). A held-out environment must not inherit its local map from practice.
6. Begin bounded bootstrap with the same capabilities for cold and warm runs. Record its elapsed time/calls and actual outcome, including entry into gameplay with no selected policy. Start normal scheduling only after current observation and admission checks succeed.

The release must provide meaningful readiness errors: unsupported game/profile version, adapter protocol failure, port/origin/session failure, missing isolation, persistence incompatibility and provider entitlement failure are different conditions. Do not call readiness failure a gameplay defeat.

### Pause, resume, stop

Pause closes effect admission, revokes pending generated evaluations and strategic callbacks, cancels active skill/action work, and waits for acknowledged neutralization or the adapter's documented safety fence. The UI stays in `pausing` until safety is established. Agent pause does not imply world pause: the selected adapter declares whether the game keeps running, disconnects, or supports an explicitly requested world-pause operation. Display actual behavior and consequences. A world pause must be attributed and must never conceal inference latency or occur automatically for ordinary model waits. No developer strategy is inserted during pause.

Record operator pause intervals separately from LLM waits, meaningful game waits and infrastructure downtime. Resume requires an authoritative fresh observation and new execution generations. Do not replay pre-pause queued actions. Pause during bootstrap ends that bootstrap early; resume enters ordinary gameplay without a fresh bootstrap allowance, while normal policy-authoring tools remain available.

Stop has highest priority. It closes admission, revokes generated work/provider callbacks, cancels actions, establishes neutral controls or the declared safety fence, durably records the outcome, and closes the adapter's playing session with confirmation. Separately owned game processes/servers remain operator-owned. If the adapter has lost contact and cannot confirm effect safety, enter recovery and preserve stop intent. `stopped` means safe closure was established, not merely that the stop button was clicked.

The emergency procedure must include a trusted path independent of generated workers and ordinary inference: fence adapter effect admission, terminate the emitting worker/adapter process if necessary, and establish session disconnect or neutralized controls according to the declared game protocol. Closing the browser is not this procedure. A graceful shutdown first requests normal stop, then closes trusted storage and owned processes. An abrupt process kill is recorded as a failure/recovery event; it is not evidence of cancellation.

### Recovery without erasing the attempt

Infrastructure failure is compatible with a valid run history. Preserve the same `run_id`, advance `epoch`, record outage/intervention intervals, and keep unknown outcomes visible. Do not restart the experiment under a new name to hide downtime or deaths.

1. Close effect admission. Preserve pause/stop intent. Revoke old request, evaluation and lease generations; terminate or demonstrably fence old workers and adapter connections. A timed-out promise alone is not a fence.
2. Reopen compatible durable storage and reconcile the last committed run/event/action records. Detect incomplete checkpoint/artifact writes. Do not infer successful effects from an action's recorded intention.
3. Reconnect the trusted adapter, verify manifest compatibility, advance/persist the epoch before admitting effects, and obtain authoritative profile-filtered observations. Recreate deadlines from new local clocks; old-process monotonic values cannot establish freshness.
4. Reconcile actions. No-start admitted jobs can fail as invalidated. In-flight effects without conclusive completion evidence become `unknown`. Never blindly repeat an effect because its result was lost. Current observed domain state can inform a new decision without pretending to prove the old history.
5. Load hash-verified compatible artifact versions and serializable state. Reconcile world-local memory with current observations and any rollback branch; retain uncertain facts as uncertain or invalidate them. Summaries do not override source events or current game state.
6. Emit a recovery report with outage cause, old/new epoch, unknown effects, memory/artifact decisions, interventions and authoritative state changes. Return to `paused` if pause intent was present, finish stop if stop intent was present, otherwise resume only after safety and freshness gates pass. If safe fencing or compatible recovery cannot be established, mark `failed` with evidence.

A provider-only failure need not restart the entire run or advance its epoch if adapter/session authority remains intact. Record the failed attempt, enforce its deadline and reject stale output; pause or recovery is required only when the control contract or operator intent demands it. Silent backend substitution is never evidence that the failed provider succeeded.

## Checkpoints, reset and restoration support

The backend owns local SQLite records for runs, events, action ledger and artifact metadata. Immutable source/configuration files use content hashes. Store source/event evidence independently of lossy conversation summaries. A runtime checkpoint identifies its game/adapter/profile/schema manifest, run/world/epoch/branch, durable event cursor, action-ledger state, selected artifact hashes and state-schema versions, and serializable memory references. It does not by itself capture game state. An incomplete checkpoint is not advertised as recoverable.

Commit an artifact's durable immutable bytes before committing registry metadata that references them. Commit related run/action state and events in one database transaction. Conversation compaction can produce an additional derived artifact with provenance; it cannot replace the action ledger, source programs or world state. Avoid copying a live WAL database as if its main file alone were a backup; use an appropriate SQLite consistent-backup procedure and verify it as part of future release work.

Game-state checkpoint, reset, restore and world pause are independent adapter capabilities, each declaring `unsupported`, `operator_assisted` or `adapter_managed` as defined in [runtime contracts](runtime-contracts.md#gameadapter-descriptor-and-interface). The UI and recovery procedure use actual negotiated support. A runtime checkpoint cannot upgrade an unsupported game save/restore mechanism. If a game requires an operator-controlled restart, that intervention and its confirmation remain pending until observed; no synthetic success or fake fallback is recorded.

A database transaction cannot atomically commit external game effects. A game-state checkpoint declaration must state consistency boundaries, required neutralization, whether the environment continues evolving, and what durable acknowledgement/evidence exists. Record separate game/runtime checkpoint identifiers and event bounds; do not imply an atomic snapshot where the adapter cannot provide one.

Reset and restore first close effect admission and fence old work. Restoring an older environment checkpoint is an explicit rollback branch: retain the original `world_id`, allocate `rollback_branch_id`, record parent checkpoint identifiers and advance epoch. Agent world-local memory records branch provenance. Invalidate or mark uncertain facts and domain assumptions acquired after the restored point; summaries do not preserve facts contradicted by restored state. Compatible abstract experience may remain, but evaluation labels the intervention and any advantage. A reset that creates a replacement environment gets a new `world_id`; invalidate prior environment-local memory. Authoritative reobservation and compatibility checks precede resumption.

Policy rollback is different: selecting a previous immutable policy version changes future decisions through the runtime's atomic switch; it does not restore game state or elapsed time. Event/video replay, if later implemented, is a playback feature and cannot promise deterministic environment rewind.

## First integration: Minecraft server and saves

The first complete integration targets Minecraft Java 1.21.4 in Survival, Normal difficulty, with one avatar, ordinary spawn/inventory/death rules and no agent cheats/operator privileges. Java 21 is the chosen compatibility target, not an exercised result here. Operators must obtain server software legitimately, accept its EULA and provide any required game account through a trusted login path. Verify actual versions, server rules and avatar privileges before collecting evidence; keep seed and account credentials out of agent context.

A separate trusted Node.js 24 Mineflayer bridge owns raw bot/protocol state, loaded chunks and the global entity collection. Do not assume unmodified Mineflayer works under Bun or that its client-known data is safe for an agent. The required `player-observable-structured` profile permits bounded unobstructed observations without camera-FOV gating, own status/inventory/UI, permitted debug coordinates, public recipes/docs, coarse legitimate sound events, and world-local remembered observations. Hidden resource/structure targets, exact live occluded-entity state, seeds, saves and raw client objects remain unavailable through agent tools, generated programs, errors, logs or retrieval. The trusted controller's separate local geometry permission is defined above; it cannot become an alternate observation interface.

prismarine-viewer firstPerson mode and its documented 1.21.4 support are upstream evidence only. Establish actual first-person fidelity and the renderer's real transport on the target stack. Human access to rendered chunks grants no agent access to viewer backing data/routes. Java/server mismatch, bridge protocol failure and viewer failure must have distinct readiness errors.

The default pause leaves the avatar connected and the world ticking; warn that survival is not guaranteed. Cancellation stops motor/navigation work, releases held inputs and obtains neutralization acknowledgement, or enters the declared bridge fence/recovery path. Stop confirms neutralization and avatar disconnect without shutting down the separately owned server. Lost craft/place/consume results must never be blindly replayed.

Minecraft saves are a separate consistency domain. Where server save/flush support is available, a coordinated backup stops admitting actions, neutralizes the avatar, obtains supported save/flush acknowledgement, then captures the world backup and agent checkpoint with their respective identifiers and acknowledgement/event bounds. The world may keep ticking between boundaries; record the interval instead of claiming one atomic snapshot. A stricter backup may require an explicitly recorded operator server shutdown after safe agent stop. Neither is an invisible gameplay pause.

The adapter must declare whether each environment's backup/reset/restore procedure is operator-assisted, adapter-managed or unsupported; possessing a directory of files is not proof of a valid restorable backup. Restoration follows the generic rollback-branch procedure and invalidates post-restore location, inventory and UI assumptions. Policy rollback cannot restore inventory, health or terrain. A trusted Minecraft task verifier may establish subgoals or actual Ender Dragon completion, but its privileged evidence remains outside agent context.

### Optional Paper Anti-Xray

Paper Anti-Xray is optional defense in depth, not a prerequisite or a replacement for GameHarness filtering. The required adapter checks must pass with server obfuscation disabled. Protection against hidden blocks does not establish protection against hidden entities, private navigation data, or other indirect information channels. The [upstream evidence](upstream-reuse.md) records documented defaults and limitations; no Paper deployment has been exercised here.

If used, retain server flavor and exact build/game version, effective per-world/dimension Anti-Xray enabled status and configuration, and a configuration snapshot/hash in the experiment manifest. Record applicable engine mode, block lists, height and update settings for that actual build. Do not assume current Paper documentation exactly describes a pinned older build, and do not change obfuscation or observation/navigation permissions between matched runs. Seeds and privileged raw diagnostics remain evaluator-only. Masked or fabricated client blocks must not be reported as genuinely discovered resources.

## Diagnostics and evidence retention

The operator needs actionable causes without a second channel for secrets or hidden state. Use structured safe error categories and correlation IDs. The trusted runtime records sanitized version/configuration manifests, admission decisions, provider attempt/latency/usage metadata, cancellation acknowledgements, rejected stale responses, quarantines, lifecycle transitions and recovery reports. Preserve actual objective evidence and known partial effects. See [runtime feedback](runtime-contracts.md#feedback-and-evidence) for record semantics.

Redact before persistence and display, not only when exporting. Exclude keys/tokens/device codes, authorization headers, credential-bearing URLs, account session payloads, hidden environment identifiers/state, raw protocol dumps, save-file contents, private filesystem paths and arbitrary dumps of worker/provider objects. Use allowlisted diagnostic fields; untrusted error strings and model output require the same sanitization. Do not log every environment variable or HTTP body to investigate an authentication failure. Renderer/game visuals can reveal legitimate visible gameplay; storage and sharing remain operator decisions.

Keep privileged evaluator evidence apart from agent-visible logs. Source programs and authorized events are evidence, while lossily compacted summaries are derived memory. The UI must accurately label incomplete observations, stale views, unavailable metrics, unknown effects, rejected responses and absent cost data. Unknown pricing is not zero cost.

Record interventions by kind: infrastructure restart/reconnect, manual pause, task change, world restore, account reconnection, and tactical human coaching. Coaching is separately labeled from ordinary infrastructure maintenance. Preserve wall-time, active gameplay and downtime as distinct intervals. A recovered run remains reportable with its full history; do not delete its failed segment or reset its metric origin. Retention/deletion choices must be explicit to the operator and must not silently remove evidence supporting a reported comparison.

## Required smoke and failure scenarios

These are future release exercises, not checks executed during documentation work. Synthetic inputs establish infrastructure correctness only; they are not gameplay-training or policy-effectiveness evidence. Progressive real-game soak and the cold/warm held-out protocol are specified in [learning and evaluation](learning-and-evaluation.md).

| Scenario | Required observable result |
|---|---|
| Supported-host first startup | Real documented setup reaches authenticated UI, selected game/session, profile-filtered observations and the adapter's truthful live view. Version/terms/account requirements are explicit. |
| Real OMP/model/game round trip | Real observations reach the selected model, its tool call causes a verified game effect, and the result wakes the next strategic turn without a human prompting each step. Inference overlaps admitted work. |
| Adapter conformance and compatibility | Descriptor/schema hashes match the run manifest. Foreign game/adapter/profile artifacts and unsupported capabilities are rejected. The same core lease, lifecycle, fencing and security scenarios pass without game-specific scheduler branches. |
| Unsupported or operator-assisted state operations | Unsupported checkpoint/reset/restore/world-pause requests report unsupported, not synthetic success. Operator-assisted operations stay pending until attributed confirmation; supported operations demonstrate their declared consistency and lineage. |
| API key and supported OAuth/subscription flow | Each supported adapter completes a real permitted request or gives an honest entitlement/error result. No secret appears in logs, worker state, URLs or feed. Refresh/revocation is exercised. |
| Two strategic providers | The same bounded task reaches adapter-verified success with two strategic models from different providers, using unchanged core/adapter code and the same declared game/profile contract. Retain each configuration, outcome, and failed attempt. |
| Jev enabled, then unavailable | A real fast decision is schema-validated and timed. A later failure is visible, finite, and never relabeled as local execution. A separately selected code-only path can run without Jev. |
| Bootstrap expiry without candidate | At the configured time/call bound gameplay starts visibly with no selected policies. Retries do not extend the bound or inject handwritten strategy. |
| Warm startup bundle | Compatible model-authored selections are rehydrated and activated through current permission/freshness gates without regenerating their source. A changed source, profile, runtime, or isolation identity invalidates cached validation; rejection is visible, with no silent substitution. |
| Strategic wakeups and event bursts | Completion/failure, replan, idle, recovery, and due improvement signals reach one serialized strategic turn. Bursts coalesce without losing their evidence cursor. An empty successful turn automatically resumes after bounded cooldown even in a quiet world, then fails explicitly after the empty-turn limit; a meaningful wait wakes on its condition or deadline. Known successor work needs no redundant model call, and failures cannot create a tight request loop. |
| Autonomous improvement opportunity | Repeated latency/error/sequence evidence forms a deduplicated opportunity without requiring `feedback.read` first. The model reuses, revises, trials, keeps, reverts, or defers with an explicit reason. Gameplay continues unless normal control safety requires interruption. |
| Selective experience access | Search returns bounded compatible metadata; exact source and history are fetched on demand. The selected snapshot and run branch are accessible, while sibling/comparison branches, hidden verifier data, and incompatible artifacts are not. |
| Autonomous promotion and lost acknowledgement | Eligible Knowledge, program, and startup-bundle proposals satisfy their kind-specific gates and create one durable new library snapshot without required human approval. Knowledge keeps provenance/confidence and cannot disguise world facts or become verified by assertion. Repeating a mutation key returns the recorded outcome. Failed/uncertain eligibility is explicit; sealed comparisons defer publication and retain frozen inputs. |
| Strategy Card and improvement UI | A real immutable artifact revision has a complete linked card and semantic change record. The minimal UI shows that revision and its actual trial evidence, including failure or unmeasured status, without invented gains or exposing private data. |
| Slow valid decision amid unrelated observations | A response inside its age/dependency bounds can be accepted despite newer observation sequences. |
| Slow invalid decision | Change an adapter-declared mandatory domain dependency or lease, or advance epoch; the old response is rejected before effects with an attributable reason. |
| Preemption and cancel race | A replacement waits for neutralization; a completion racing cancellation records its actual outcome. Failed cancellation enters uncertainty/recovery, never overlapping leases. |
| Composite movement/look/interaction | Compatible channels overlap within one bounded lease during delayed inference. Cancellation neutralizes all channels before transfer; unrelated actions cannot bypass ownership. |
| Duplicate submission and lost result | Same ID/content yields one ledger job; conflicting content is rejected. Crash after an effect leaves `unknown` where evidence is incomplete, without automatic repetition. |
| Skill start with lost acknowledgement | Concurrent/retried starts with the same run/start key return one durable execution identity; lookup works after restart and terminal closure. Changed content conflicts. A pre-commit crash dispatches nothing; a post-commit crash preserves admission, and only fenced recovery may continue after reconciling child effects. |
| Atomic policy replacement | Concurrent switches respect expected version; only the selected generation proposes new effects. Old in-flight callbacks are rejected. Prior action effects are not retroactively erased. |
| Invalid or nonterminating generated policy | Isolation/limits terminate it, quarantine its immutable version, preserve evidence and notify strategist. Host stop remains usable. |
| Capability/sandbox escape attempts | Attempts to read credentials, SQLite, saves, host files, process data, raw engine state or reach network/viewer/control routes fail without revealing forbidden values in errors. |
| Retrieval attack | Private/loopback targets, redirect/rebinding tricks, local-file URLs and credential-bearing URLs are refused. Malicious retrieved instructions grant no authority. |
| Structured observation and reveal | Behind-camera unobstructed objects are included within range. Hidden ore/entities remain protected through observations, search metadata, tools, errors and retrieval; removing occlusion permits legitimate discovery. Last-seen entity memory and coarse sound events cannot become hidden live tracking. |
| Initial preset and filtering pressure | Effective sampling, candidate, search/output, freshness, sound and controller limits match the fingerprinted preset. Exhaustion produces bounded incomplete/unknown results without unchecked observations or hidden counts. Record filter/query/publication/coverage-age and controller costs under the evaluation protocol; stop and permitted effects remain responsive. |
| Bounded local navigation geometry | The controller can use permitted client-loaded geometry for movement and local detours to the same authorized known target without every voxel being previously observed. Reads, effects and outputs stay within the declared projection/envelope; no hidden-resource goal, unknown-target oracle, global or undiscovered higher-level exploration route, or raw path disclosure is admitted. |
| Optional Anti-Xray defense | Adapter controls pass without Anti-Xray. If enabled, pin effective per-world server configuration and record its limits; obfuscated raw data is not proof of a genuine resource observation or entity protection. |
| Browser attack and stale UI | Foreign origin/Host/CSRF attempts cannot issue controls or read protected events. Feed content cannot execute script. UI reconnect deduplicates SSE and explicitly resynchronizes missing history. |
| Authorized source viewing | Authorized generated source appears as escaped inert text, including HTML/script-like content. Viewing neither executes nor activates it, broadens capability grants, or reveals privileged/other-run data. |
| Pause under declared game behavior | Action admission closes and neutralization/safety fence is established before `paused`. UI shows whether the environment continues, disconnects or explicitly pauses; consequences/manual intervals remain in evidence. No inference wait is concealed. Resume uses fresh state. |
| Backend/adapter disconnect and restart | Old emitters are fenced, epoch advances and authoritative permitted observations reconcile ledger/memory. Recovery preserves run ID, unknown effects, outage and operator intent. |
| Checkpoint interruption and supported environment restore | Incomplete writes are rejected or recovered consistently. An older-state restoration creates a recorded rollback branch and reconciles memory; summaries cannot restore nonexistent domain facts. |
| Minecraft reference profile | Verify Survival/Normal, ordinary privileges, real first-person fidelity, the versioned structured profile and declared private navigation allowance. Strict camera FOV is not required. Hidden ore/entity/structure/seed/save protections still hold. Pause leaves the world running with a warning; uncertain craft/place/consume effects are not replayed. Exercise declared save/flush/backup/restore behavior. |
| Progressive soak | Increasing durations toward hours/days reveal memory/queue growth, stuck controls, repeated recovery and provider backpressure. Report actual achieved duration, progress, deaths, outages and interventions. |
| Emergency stop under load | Host control remains responsive during worker flooding/provider waits; no new effects enter, controls neutralize or disconnect is established, and closure is evidenced. |

A release report must identify which scenarios were actually exercised, game/adapter/profile/schema and artifact versions, declared support levels, observed failures, and remaining limitations. Passing schema/isolation tests does not demonstrate an effective strategy, and a polished live view does not establish task completion. Report actual real-game outcomes, including incomplete attempts, under the [PRD](prds/gameharness-v1.0-prd.md) and evaluation protocol. For the Minecraft reference integration, report workflow readiness independently from actual Ender Dragon completion.
