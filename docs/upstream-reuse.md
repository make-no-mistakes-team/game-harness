# Upstream reuse and evidence

GameHarness will use selected published OMP libraries for provider access and strategic model turns. It will own game-independent orchestration, generated-policy isolation, the action ledger and recovery coordination. Game adapters will supply domain observations, actions, live views, task verification and supported environment recovery. Minecraft is the first planned complete reference integration. The project does not need a fork of OMP's coding CLI, its terminal UI or its built-in coding tools.

This document records the reuse decision and the evidence behind it. GameHarness is currently a documentation-only project; the integrations below are specifications, not implemented features. The [architecture overview](architecture/overview.md) assigns components, the [runtime contracts](runtime-contracts.md) define scheduling and state, and [operations and security](operations-and-security.md) governs credentials, isolation and recovery.

## Versions and provenance

The inspected read-only OMP checkout is commit [`2220e58146ebe31508e7a216242840d373e082d0`](https://github.com/can1357/oh-my-pi/tree/2220e58146ebe31508e7a216242840d373e082d0), examined on 20 October 2026. OMP source links in this document are pinned to that commit.

| Direct dependency candidate | Exact version | Intended imports |
| --- | --- | --- |
| `@oh-my-pi/pi-ai` | `18.12.3` | Provider streaming, message/tool contracts, argument validation, authentication and `/judgment` |
| `@oh-my-pi/pi-agent-core` | `18.12.3` | `/agent` for strategic turns; `/compaction` for bounded conversation context |
| `@oh-my-pi/pi-catalog` | `18.12.3` | `/models` and relevant model/auth metadata; declare directly when imported |

These names and versions come from source manifests and published metadata: [pi-ai][npm-ai], [pi-agent-core][npm-agent] and [pi-catalog][npm-catalog]. Use the manifest name `pi-agent-core`; an upstream agent README still uses the older/different `pi-agent` name. Pin the selected packages exactly and retain the eventual lockfile. This document does not prescribe `latest` or caret ranges.

The packages require Bun **1.3.14 or later** and have transitive native dependencies. They are not plain-Node-only libraries. `pi-agent-core` also depends on `snapcompact`; `pi-catalog` reaches `pi-natives` through `pi-utils`. Importing `/agent` does not remove native dependencies, because its tokenizer imports native and snapcompact functionality. See the [AI manifest][ai-manifest], [agent manifest][agent-manifest], [catalog manifest][catalog-manifest] and [tokenizer imports][tokenizer]. The first Minecraft adapter's separate trusted Node.js 24 Mineflayer bridge is a GameHarness design choice; OMP's runtime requirements do not establish Mineflayer compatibility under Bun.

**Source provenance and package-build provenance are separate.** The commit identifies inspected source. The disposable smoke used published `18.12.3` packages, not a build of that checkout. Matching version strings do not prove the npm tarballs were built from that commit. Registry records expose tarball integrity and provenance-attestation information, but signatures and the build-to-commit relationship were not verified in this investigation. The implementation must record the resolved artifacts, integrity values and Bun/native platform versions; any claim about their build commit requires artifact-specific evidence. The [publisher][publisher] generates declarations, resolves workspace dependency protocols, stages legal payloads and creates platform packages, so a checkout manifest is not itself the released artifact.

## Public APIs selected for reuse

| Upstream surface | GameHarness use | Boundary to preserve |
| --- | --- | --- |
| `pi-ai`: `streamSimple`, `completeSimple`, message/event types and tool validation | Strategic provider transport, streaming status, tool-call decoding and validation | A tool schema describes an interface; it neither executes a tool nor grants authority. Check terminal `stopReason` as well as thrown errors. |
| `pi-agent-core/agent`: `Agent`, subscriptions, `getApiKey`, context transforms, pre-call gates, steering and asides | One strategic conversation, host-supplied tools and prompt admission | It starts with no tools. Supply only GameHarness capabilities. Concurrent `prompt()` calls on one instance are rejected. |
| `pi-catalog/models`: bundled model lookup, capabilities, pricing status and cost calculation | Provider/model selection and honest usage displays | Bundled data is a default catalog, not account entitlement, live discovery or a successful request. |
| `pi-ai/judgment`: `NativeJudge`, `createNativeJudge`, typed requests/results | Required supported Jev path behind `FastDecisionProvider` | Invoke independently of strategic turns. Adapt deadlines and validate results before runtime use. |
| `pi-agent-core/compaction` | Prepare and summarize strategic conversation while retaining complete tool-result groups | Summaries are lossy and carry coding assumptions. Preserve original evidence separately. |

The public [AI exports][ai-exports], [agent options and hooks][agent-options], [tool/event contracts][agent-tools], [catalog helpers][catalog-models] and [judgment exports][judgment-exports] support this selection. The lower-level `agentLoop` is also public, but GameHarness will start with the `Agent` façade rather than maintain a copied turn loop. `AgentOptions.streamFn` provides a per-agent transport seam if needed; process-global `registerCustomApi` is available for unsupported transports but is not required for the initial integration.

Two details matter when implementing tools: `Context.systemPrompt` is an array of strings, and current tool schemas accept plain JSON Schema or the upstream schema type. Do not assume old TypeBox-only examples describe this version. Argument validation may normalize provider quirks; GameHarness must still enforce capability permissions, bounds and current action preconditions after parsing. See [context/schema types][ai-types] and [validation implementation][validation].

### Authentication: API keys and supported subscription flows

Both API-key connections and supported OAuth/subscription connections are in scope. Each operator must establish entitlement for the selected provider and model; upstream authentication support alone does not establish access.

Source inspection confirms that the current public `pi-ai` package contains usable authentication seams:

- `AuthStorage` is exported from the root and `/auth-storage`. It accepts an `AuthCredentialStore`; `AuthStorage.create(dbPath)` opens its SQLite implementation. The namespaces include `credentials`, `keys`, `oauth`, session affinity and provider usage/rate-limit services. Use the current namespaced API, not deprecated flat redirects. See [exports][ai-exports] and [storage façade][auth-storage].
- `auth.oauth.login(provider, callbacks)` performs interactive login and persists either a returned API key or an OAuth grant. Host callbacks handle authorization URLs, masked prompts, cancellation and supported manual/device flows. `auth.oauth.access(...)` resolves refreshed credentials together with identity metadata when a transport needs it. See [login/access implementation][oauth-accounts] and [callback contracts][oauth-types].
- `auth.keys.get(...)` is the provider key-resolution seam. The source precedence is runtime override, config override, stored OAuth, login-stored key, config fallback, environment and remaining stored keys, subject to provider/session restrictions. `AgentOptions.getApiKey(model)` is the public bridge into strategic requests. See [key cascade][auth-cascade] and [agent credential hook][agent-auth].
- `getOAuthProviders()`, `getOAuthCredentialProvider()`, `refreshOAuthToken()` and related types are exposed through `/registry/oauth` (also `/oauth`). The login list includes API-key login providers as well as actual OAuth providers; appearing there does not imply a subscription. `getOAuthApiKey()` requires an already-fresh grant and explicitly delegates refresh ownership to `AuthStorage`. See [OAuth façade][oauth-facade].

The source locations cross package boundaries: `pi-ai` supplies the public façade, OAuth engines, refresh orchestration and provider transport; provider auth policy data lives in **`pi-catalog/src/compat/rules/auth/*.kdl`**. `pi-ai` builds its registry from those compiled policies. It is inaccurate to say that every authentication mechanism resides entirely in `pi-ai`; see [registry composition][auth-registry] and [policy projection][auth-build].

| Source-verified upstream connection | Flow and relevant constraint | Pinned evidence |
| --- | --- | --- |
| OpenAI API | API-key route, distinct from the Codex subscription provider | [OpenAI auth entry][auth-openai]; catalog-derived [environment resolver][auth-env] |
| `openai-codex` | Browser authorization code with PKCE and refresh; callback uses the explicitly allowlisted localhost port 1455 and cannot silently choose another port | [Codex policy][auth-codex] |
| `openai-codex-device` | Headless/device login; stores the resulting grant under `openai-codex` | [Device policy][auth-codex-device] |
| `anthropic` | Upstream labels the OAuth route Claude Pro/Max; it uses inference scopes and organization-scoped identity with refresh | [Anthropic policy][auth-anthropic] |
| `github-copilot` | Custom login/refresh hooks; structured credentials preserve routing metadata | [Copilot policy][auth-copilot] |
| `google-gemini-cli` | Cloud Code Assist browser login and refresh, with project metadata and structured credentials | [Gemini CLI policy][auth-gemini] |
| `typesafe` | API key, `TYPESAFE_API_KEY` fallback and console-key login; models-endpoint validation belongs to login, not to the smoke described below | [TypeSafe policy][auth-typesafe] |

These are verified upstream implementation paths, not proof that every consumer subscription authorizes GameHarness use or that each provider currently accepts a particular client. Use legitimate provider-supported flows under the operator's entitlement and current terms. A source entry, an OAuth grant and model entitlement are different facts. Provider restrictions, account grants and refresh behavior must be exercised during integration; no credential-bearing flow was exercised in this documentation task. Preserve provider-specific identity/routing handling rather than treating every OAuth result as an interchangeable API key.

The trusted backend will own a GameHarness-selected credential store and login UI adapter. It must not silently open or migrate the user's OMP, Codex, browser or other application stores. The environment helper can consult the process environment and `.env` locations, including the home directory; choose the intended credential source explicitly rather than relying on ambient discovery. Do not adopt coding-agent command-valued key configuration as a default. Keys, refresh tokens, authorization codes and structured credential payloads stay out of workers, prompts, activity events, exports and checked-in files. Store access control, token redaction, allowed provider endpoints and local command authorization remain GameHarness responsibilities; public auth APIs do not establish those security boundaries. The [operations contract](operations-and-security.md) specifies the lifecycle.

### Strategic turns do not schedule gameplay

Upstream tool concurrency is scoped to a model-emitted batch, which the agent loop awaits. A tool that waits until navigation or combat finishes can therefore block the next strategic request. Steering is cooperative for ordinary tools; it is not proof that all emitted calls or external effects stopped. Asides can deliver completed work at turn boundaries, but cannot authorize a stale effect. See [batch execution][batch-execution], [tool interruption contracts][interrupt-contract] and [aside delivery][asides].

GameHarness tools will submit, revise or cancel bounded jobs and return their IDs promptly. Its independent runtime will own the controlled player's effectful action lease, cancellation acknowledgement, priority ordering, policy evaluation and freshness checks. Jev calls and local policy execution can continue while the strategist is awaiting inference. These obligations are defined in [runtime contracts](runtime-contracts.md); upstream agent events are inputs to the durable event stream, not a replacement for it.

OMP tool schemas will expose the active `GameAdapter`'s declared capabilities. Core scheduling will treat observation fields as opaque and validate actions against the adapter's schemas; Minecraft blocks, recipes and combat mechanics belong to its observation and action profile. The adapter descriptor will identify the game, adapter version, observation schemas/profiles, live-view source, task verifiers and supported save/reset/recovery operations. Run manifests and reusable artifacts must record compatible game, adapter and observation-profile identities. The [adapter contract and conformance procedure](runtime-contracts.md) defines connect, observe, effect, cancel and verify behavior, including explicit limits on cancellation and optional checkpoint/restore support. This separation permits additional adapters without treating OMP as a game engine or claiming other games already work.

### Jev deadline adaptation

`pi-ai/judgment` already implements TypeSafe's `POST /v1/systemone`, typed answers and usage results. The default wire model is `jev-latest`; catalog routing can select a concrete supported judge. The [TypeSafe introduction](https://typesafe.ai/blog/introducing-system-one-models-and-jev) is the primary product reference. No claim about observed GameHarness reaction speed follows from that announcement.

The current native client defaults to a **10-second timeout per attempt and three attempts**, with backoff; split requests can add work. `createNativeJudge(model, connection)` accepts connection settings but does not expose the constructor's full `NativeJudgeOptions`, including `timeoutMs`. See [options/defaults/factory][judgment-native] and [wire route][judgment-route].

The adapter must apply an absolute runtime deadline with an abort signal, bound outstanding judgments independently of chat-request concurrency, and prevent retries/backoff from extending a policy's useful lifetime. Where a shorter per-attempt timeout is needed, use the public constructor with catalog-derived routing and capability settings preserved. Do not merely change a UI timeout while leaving provider work alive. Record partial/billed usage when available even if answers are discarded. Validate the answer against the declared action choices, then recheck epoch, policy version, relevant observed changes, age and lease immediately before effects. Requiring equality with the newest `observation_seq` would incorrectly reject every slow answer; use the freshness contract instead.

Jev is a supported backend, not the identity of the whole policy system. Local JS is a separate backend and remains usable when Jev is disabled or unavailable. Failures and backend selection must remain visible; a local result must never be reported as a successful Jev response.

### Cost semantics

`getModelPricingStatus()` treats an all-zero rate card as `unknown` unless an explicit status says otherwise. `calculateCost()` writes into `usage.cost`; multiplying unknown placeholder rates can still produce numerical zeros. Those zeros do not establish that inference is free. See [pricing semantics and calculation][catalog-models].

Preserve raw usage, model/provider identity, pricing status and known charges separately. Distinguish a logical decision from provider attempts, including retries and judgment calls. Subscription/quota information is not automatically a per-request dollar price. Show unknown costs as unknown and report known subtotals without presenting them as complete totals. Concurrency, rate limits, finite retries, deadlines and emergency stop are reliability controls; they do not establish a spending limit or a known cost. Measurement definitions belong to [learning and evaluation](learning-and-evaluation.md).

## Coding-agent code to study or narrowly extract

| Mechanism | Useful reference | Why it is not a direct foundation |
| --- | --- | --- |
| Generated function → descriptor → custom tool | [JS registration][eval-register] and [host wrapping/invocation][eval-adapter] | Coupled to live kernels, tool sessions, settings and subagent infrastructure. Registration is mutable process memory, not an immutable policy artifact. |
| Session journal and retained summary/tail | [SessionManager imports][session-imports], [journal tree][session-journal] and [storage writes][session-storage] | Publicly exported by the coding-agent package, but coupled to its workspace, TUI, artifacts and indexing. Its flush does not call `fsync`. |
| Stale callback fencing | [Session epoch check][session-epoch] | A useful pattern; GameHarness must enforce its own epoch and lease checks before game effects, not only before displaying a result. |
| Recovery of unmatched tool calls | [Exit diagnostics][exit-diagnostics] | Repairs conversation structure by reporting an unknown outcome. It cannot prove whether the game performed the action. |

Prefer those protocol ideas to copying whole modules. Any actual extraction must be narrow, carry upstream notices and record original commit/path, destination and modifications. Adding the complete coding-agent dependency to obtain one helper would bring in unrelated authority and maintenance work.

### Generated code needs a separate security boundary

OMP's coding evaluator is **not a security sandbox**. Its [indirect evaluator][eval-indirect] invokes `globalThis.eval`; the [JS runtime][eval-runtime] exposes real filesystem/import facilities and the process object. The [worker launcher environment][eval-env] is not a general secret-removal boundary. A subprocess, Bun Worker, ordinary `eval` or language VM does not by itself prevent filesystem, network or subprocess access.

GameHarness will execute generated JS inside OS-isolated workers with explicit resource/deadline limits, serializable private state and no arbitrary host/network access. Only trusted brokers may supply observations filtered by the adapter's player-observable permission profile, declared actions, documentation retrieval and provider requests. Workers receive neither raw game-client objects nor credentials, databases, environment saves or viewer backing buffers. For the first Minecraft adapter, this excludes raw Mineflayer access and hidden world data as well as the viewer's chunk transport. Tool argument validation protects a bridge interface; it does not stop direct host access by unisolated code. See [operations and security](operations-and-security.md).

### Conversation compaction and session recovery have limits

Core compaction is a public dependency surface. Its [cut-point logic][compaction-cut] preserves tool-result groups, and its [preparation/result boundaries][compaction-api] support bounded strategic context. It still includes coding-specific file-operation assumptions and provider-specific compatibility rules. GameHarness will adapt summary content to goals, observations, uncertainty, policy versions and outcomes. It will retain original events, source artifacts and provenance outside summaries.

A restored conversation is not a restored game. Upstream [checkpoint records][checkpoint] contain conversation positions; [rewind implementation][rewind] branches history and rebuilds messages. Live closures, pending promises and kernel registries do not become durable continuations. GameHarness must reload compatible immutable programs plus explicit serializable memory, fence old work, reconnect, advance `epoch`, reobserve and reconcile the action ledger. An interrupted action may remain `unknown`; do not repeat an effect merely because a tool result is missing. Environment checkpoint/reset/restore support depends on the adapter's declared capabilities. Minecraft save/backup consistency and any world rollback are first-integration operations, governed by [recovery procedures](operations-and-security.md), rather than guarantees supplied by OMP.

## Licensing and distribution obligations

OMP's first-party root license is [MIT][mit], with copyright notices for Mario Zechner, Can Bölük and Stencil Labs. MIT permits reuse and modification, including selected source copying, provided the applicable copyright and permission notices accompany copies or substantial portions. Preserve actual package license files and any inherited attribution. This does not choose a license for GameHarness or imply that this repository already has one.

The upstream [third-party aggregate][notices] explicitly says that it does not replace package-level licenses or grant rights in third-party code, data, fonts or marks. Review the dependency graph and artifacts actually distributed, including native leaves and container images.

| Relevant component | Obligation to address before distribution |
| --- | --- |
| Native `inferno` dependency, CDDL-1.0 | Preserve the CDDL text and satisfy covered-source availability and recipient source-access notice requirements when distributing executable covered software. Larger-work permission does not remove these obligations. See [native dependency declaration][native-deps], [inventory][inferno] and [source availability clause][cddl]. |
| Silver font in native assets, CC BY 4.0 | If shipped, retain author/source attribution and license information, and identify modifications. See [asset notice][silver]. |
| Optional sharp/libvips runtimes, LGPL-3.0-or-later | OMP classifies these as runtime-acquired rather than included in its release bundles. A GameHarness preinstalled runtime/container may change that boundary; review applicable notices, source and replacement/relinking requirements for the actual distribution. See [runtime inventory][native-notices]. |
| MPL components and copied/vendor assets | Determine whether each component is build-only or shipped; comply with applicable covered-file/source and notice terms when distributing it. Preserve original MIT/BSD and other inherited notices as applicable. The full CLI's broader dependency tree is not needed for this design. |

The publisher stages `LICENSE` and `THIRD-PARTY-NOTICES.txt` into packages and platform leaves. Retain legal payloads in delivered bundles/containers, not only an acknowledgment in the repository. The aggregate can include components absent from a selected package and can differ from newly selected dependency versions; inspect the final artifact rather than assuming either that everything listed is shipped or that everything shipped is MIT. This is an engineering distribution requirement, not a legal opinion.

## Evidence already obtained and remaining integration work

A prior credential-free smoke used published exact `18.12.3` dependencies, including the native dependency. It imported `pi-ai`, `pi-agent-core/agent`, `pi-catalog/models` and `pi-ai/judgment`; accepted integer tool arguments and rejected invalid strings; and exercised `Agent.prompt()` through `beforeModelCall`. The gate ran once and stopped before inference. Observed event names were `agent_start`, `message_start`, `message_end`, `agent_end`. The temporary dependency directory was measured at **266M**; that is a directory measurement, not a compressed download or memory-use estimate.

The sampled model's pricing status was **unknown**, with zero placeholders. The smoke established package import/validation and a pre-provider lifecycle path. It made **no provider request** and established neither API/OAuth connectivity, Jev connectivity, a complete model/tool round trip, any game-adapter integration, Minecraft compatibility, first-person rendering nor gameplay performance.

Integration must exercise real authorized providers, refresh/cancellation, Jev deadlines, native compatibility, adapter conformance, live-view fidelity, action reconciliation and sandbox/observation leakage. These are planned release gates in the [operations document](operations-and-security.md), not results already obtained.

The first proof is the [Implementation MVP Contract](implementation-mvp.md): a real game observation reaches the OMP-backed model, its tool call produces a verified game effect, and that result reaches the next autonomously scheduled strategic turn while bounded execution can continue. Complete this with one supported connection before treating provider integration as solved or expanding the full management surface. An import smoke cannot substitute for that round trip.

Authentication breadth and model interchangeability have separate acceptance criteria. Final support retains both an API-key path and a legitimate subscription/OAuth path, without promising every provider's subscription product. Separately, two strategic models from different providers must complete the same bounded task through unchanged GameAdapter and core code. The first playable gate may use one model and connection; it does not waive either final criterion. Provider entitlement and current terms still apply.

## First Minecraft integration: sources and related work

[Mineflayer](https://github.com/PrismarineJS/mineflayer) is the first adapter's planned structured game-client dependency; its documented Node minimum is 18 and its supported range includes Minecraft 1.21. [prismarine-viewer](https://github.com/PrismarineJS/prismarine-viewer) explicitly lists 1.21.4 and a `firstPerson` mode. These support the chosen **Minecraft Java 1.21.4** compatibility target, but do not demonstrate that the proposed combination has run here. The human viewer may render world chunks; its transport and buffers must remain inaccessible to agent tools and generated code. Consult the [Minecraft EULA](https://www.minecraft.net/en-us/eula) and [usage guidelines](https://www.minecraft.net/en-us/usage-guidelines); game acquisition, accounts and server EULA acceptance are operator responsibilities.

[Voyager](https://github.com/MineDojo/Voyager) is a useful reference for generated programs and a reusable skill library. The [reported Minecraft system at arXiv:2610.22319](https://arxiv.org/abs/2610.22319) uses four game agents, Easy difficulty and structured Mineflayer access; its reported completion is not evidence that GameHarness's single strategic agent will complete Normal Survival. These Minecraft results inform the first adapter's design. They establish neither successful GameHarness gameplay nor support for other games, and do not establish scientific novelty or a measured performance advantage.

### Structured observation and navigation evidence

The following source inspection was performed on 20 October 2026 against Mineflayer commit [`7b4bb8d2b56be9cdb832474af873acd37e609746`](https://github.com/PrismarineJS/mineflayer/tree/7b4bb8d2b56be9cdb832474af873acd37e609746) and mineflayer-pathfinder commit [`d773d15ff1bb271090122b3c7106a519a68bbbd9`](https://github.com/PrismarineJS/mineflayer-pathfinder/tree/d773d15ff1bb271090122b3c7106a519a68bbbd9). These are evidence revisions, not selected package pins or proof of Minecraft 1.21.4 conformance. No real-game visibility, navigation or Anti-Xray testing was performed.

Mineflayer's [API documentation][mineflayer-observation-api] describes loaded client state, not an ordinary-player visibility boundary:

- [`blockAt`][mineflayer-block-state] calls `bot.world.getBlock`; an unloaded point returns `null`, but a loaded block needs no visibility check. Setting `extraInfos: false` does not add one.
- [`findBlocks` and `findBlock`][mineflayer-block-search] search loaded sections, including palette checks, by block type or predicate. Matches are distance-sorted and truncated to `count`; there is no built-in occlusion filter. Filtering a raw `findBlocks({count: k, ...})` result afterward can let concealed matches displace permitted results. Agent queries must use the authorized observation index; raw matches, counts and truncation behavior must stay private.
- [`bot.entities` and `nearestEntity`][mineflayer-entity-index] expose a client entity map and nearest matching entry. [Movement packet handlers][mineflayer-entity-updates] update exact positions and emit entity events without a line-of-sight check. Server tracking/packet availability is therefore not evidence that an entity is currently observable.

[`canSeeBlock`][mineflayer-can-see] is a candidate block-occlusion helper with a narrower contract than its name suggests. It casts **one ray** from the bot's position plus `eyeHeight` toward `block.position + (0.5, 0.5, 0.5)`. The supplied ray range is the eye's distance to `block.position` (the block origin), not to that center sample. Its matcher stops on an intersection with an encountered block's `shapes`, or on reaching the target coordinate; success requires the returned block coordinate to equal the target. Thus an earlier shape intersection obstructs that ray, while the target-coordinate fallback does not require hitting the target's own shape. The helper reads no camera yaw/pitch and imposes no separate observation-radius cap. It also returns the falsy raycast result when no block is returned, rather than necessarily a Boolean `false`.

This is a single center-directed, shape-based test, not a test of every exposed face, rendered transparency or entity visibility. Its sample and origin-based range need adapter fixtures for partial shapes, obstructions and boundary distances. Absence of a camera check fits the intended structured profile, but does not establish its range, discovery, memory or information-leakage rules. A type-specific raw search followed by this helper is not a complete permission gate. The [runtime contracts](runtime-contracts.md) own the profile and finite settings; [operations and security](operations-and-security.md#structured-observation-and-navigation) owns the required controlled fixtures.

Stock pathfinder is also outside that boundary. Its [planner][pathfinder-planner] defaults `searchRadius` to `-1` (unlimited by distance), reads `bot.blockAt`, and can build an entity-collision index. Its [movement generator][pathfinder-movement-data] reads raw block types/states and entity positions; disabling digging or hiding returned path nodes does not constrain those inputs. The runtime's bounded private-geometry exception permits local execution toward an authorized known goal without requiring every collision voxel to have been observed. It does not authorize hidden material/entity semantics or a loaded-world search for undiscovered routes. Reuse must constrain the planner's data path and execution envelope, including auxiliary reads, or replace it with bounded movement. A search-radius option alone is not proof of compliance.

Paper Anti-Xray is **optional defense in depth**. The current [world-configuration reference][paper-anti-xray-reference] explicitly lists `enabled: false` as the default. The [configuration guide][paper-anti-xray-guide] describes per-world block obfuscation: mode 1 substitutes dimension-appropriate stone/deepslate, netherrack or end stone for configured hidden blocks; mode 2 substitutes random hidden-list blocks for hidden/replacement-list blocks; mode 3 randomizes by chunk layer. Shared settings live in `paper-world-defaults.yml`, with world-specific `paper-world.yml` overrides. Effective lists, height, lava behavior, update radius and optional bypass permission affect coverage; the reference says interaction updates can send real block data. The guide warns about exposed ores, height/list gaps and bypass permissions, and requires a restart for changes. Fake ores are not genuine discoveries.

These documented mechanisms obfuscate blocks; they do not provide an entity-visibility filter or establish protection for every hidden-data channel. GameHarness filtering must work with Anti-Xray disabled. Current unversioned Paper documentation is not proof of the exact behavior of a selected 1.21.4 build. Record the actual server flavor/build, enabled status and effective per-world/dimension configuration snapshot or hash in evaluator evidence, and keep that configuration fixed in matched comparisons. No Paper server was configured or tested here.

[mineflayer-observation-api]: https://github.com/PrismarineJS/mineflayer/blob/7b4bb8d2b56be9cdb832474af873acd37e609746/docs/api.md#botblockatpoint-extrainfostrue
[mineflayer-block-state]: https://github.com/PrismarineJS/mineflayer/blob/7b4bb8d2b56be9cdb832474af873acd37e609746/lib/plugins/blocks.js#L215-L225
[mineflayer-block-search]: https://github.com/PrismarineJS/mineflayer/blob/7b4bb8d2b56be9cdb832474af873acd37e609746/lib/plugins/blocks.js#L108-L213
[mineflayer-entity-index]: https://github.com/PrismarineJS/mineflayer/blob/7b4bb8d2b56be9cdb832474af873acd37e609746/lib/plugins/entities.js#L74-L96
[mineflayer-entity-updates]: https://github.com/PrismarineJS/mineflayer/blob/7b4bb8d2b56be9cdb832474af873acd37e609746/lib/plugins/entities.js#L305-L363
[mineflayer-can-see]: https://github.com/PrismarineJS/mineflayer/blob/7b4bb8d2b56be9cdb832474af873acd37e609746/lib/plugins/blocks.js#L227-L240
[pathfinder-planner]: https://github.com/PrismarineJS/mineflayer-pathfinder/blob/d773d15ff1bb271090122b3c7106a519a68bbbd9/index.js#L37-L100
[pathfinder-movement-data]: https://github.com/PrismarineJS/mineflayer-pathfinder/blob/d773d15ff1bb271090122b3c7106a519a68bbbd9/lib/movements.js#L171-L253
[paper-anti-xray-guide]: https://docs.papermc.io/paper/anti-xray/
[paper-anti-xray-reference]: https://docs.papermc.io/paper/reference/world-configuration/#anticheat_anti_xray

[npm-ai]: https://registry.npmjs.org/@oh-my-pi%2Fpi-ai/18.12.3
[npm-agent]: https://registry.npmjs.org/@oh-my-pi%2Fpi-agent-core/18.12.3
[npm-catalog]: https://registry.npmjs.org/@oh-my-pi%2Fpi-catalog/18.12.3
[ai-manifest]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/ai/package.json#L34-L174
[agent-manifest]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/agent/package.json#L37-L77
[catalog-manifest]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/catalog/package.json#L29-L100
[tokenizer]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/agent/src/tokenizer.ts#L1-L35
[publisher]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/scripts/ci-release-publish.ts#L91-L189
[ai-exports]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/ai/src/index.ts#L1-L72
[agent-options]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/agent/src/agent.ts#L110-L191
[agent-tools]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/agent/src/types.ts#L1100-L1293
[ai-types]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/ai/src/types.ts#L1580-L1682
[validation]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/ai/src/utils/validation.ts#L1993-L2068
[catalog-models]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/catalog/src/models.ts#L16-L205
[judgment-exports]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/ai/src/judgment/index.ts#L1-L5
[auth-storage]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/ai/src/auth-storage.ts#L1-L293
[oauth-accounts]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/ai/src/auth/oauth.ts#L45-L164
[oauth-types]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/ai/src/registry/oauth/types.ts#L1-L120
[auth-cascade]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/ai/src/auth/cascade.ts#L20-L235
[agent-auth]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/agent/src/agent.ts#L178-L183
[oauth-facade]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/ai/src/registry/oauth/index.ts#L20-L172
[auth-registry]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/ai/src/registry/registry.ts#L1-L53
[auth-build]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/ai/src/registry/build.ts#L1-L74
[auth-env]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/ai/src/env-api-key.ts#L1-L77
[auth-openai]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/catalog/src/compat/rules/auth/openai.kdl#L1-L3
[auth-codex]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/catalog/src/compat/rules/auth/openai-codex.kdl#L1-L35
[auth-codex-device]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/catalog/src/compat/rules/auth/openai-codex-device.kdl#L1-L19
[auth-anthropic]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/catalog/src/compat/rules/auth/anthropic.kdl#L1-L56
[auth-copilot]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/catalog/src/compat/rules/auth/github-copilot.kdl#L1-L7
[auth-gemini]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/catalog/src/compat/rules/auth/google-gemini-cli.kdl#L1-L29
[auth-typesafe]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/catalog/src/compat/rules/auth/typesafe.kdl#L1-L13
[batch-execution]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/agent/src/agent-loop.ts#L3633-L3867
[interrupt-contract]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/agent/src/types.ts#L270-L309
[asides]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/agent/src/types.ts#L354-L374
[judgment-native]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/ai/src/judgment/native.ts#L165-L559
[judgment-route]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/ai/src/judgment/systemone.ts#L122-L156
[eval-register]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/coding-agent/src/eval/js/shared/prelude.txt#L81-L108
[eval-adapter]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/coding-agent/src/task/eval-tools.ts#L84-L191
[session-imports]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/coding-agent/src/session/session-manager.ts#L1-L125
[session-journal]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/coding-agent/src/session/session-manager.ts#L864-L889
[session-storage]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/coding-agent/src/session/session-storage.ts#L421-L453
[session-epoch]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/coding-agent/src/session/agent-session.ts#L3257-L3276
[exit-diagnostics]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/coding-agent/src/session/exit-diagnostics.ts#L251-L299
[eval-indirect]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/coding-agent/src/eval/js/shared/indirect-eval.ts#L13-L27
[eval-runtime]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/coding-agent/src/eval/js/shared/runtime.ts#L637-L740
[eval-env]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/coding-agent/src/subprocess/worker-client.ts#L180-L198
[compaction-cut]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/agent/src/compaction/compaction.ts#L508-L574
[compaction-api]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/agent/src/compaction/compaction.ts#L1289-L1350
[checkpoint]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/coding-agent/src/tools/checkpoint.ts#L11-L18
[rewind]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/coding-agent/src/session/agent-session.ts#L11041-L11115
[mit]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/LICENSE#L1-L23
[notices]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/THIRD-PARTY-NOTICES.txt#L1-L6
[native-deps]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/crates/pi-natives/Cargo.toml#L44-L96
[inferno]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/THIRD-PARTY-NOTICES.txt#L10804-L10809
[cddl]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/THIRD-PARTY-NOTICES.txt#L13075-L13086
[silver]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/THIRD-PARTY-NOTICES.txt#L320-L336
[native-notices]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/THIRD-PARTY-NOTICES.txt#L935-L1051
