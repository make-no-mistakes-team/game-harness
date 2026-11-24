# Provider connections and accounting

Product model selection is provider-agnostic. Authorization for live development runs is separate in [development policy](../development/model-runs.md); frozen studies retain their actual selected identity/allocations. Provider availability and valid credentials do not establish entitlement or task success.

## Authentication ownership

Required connection categories are legitimate API keys and provider-supported subscription/OAuth. A consumer subscription does not automatically grant arbitrary API/model access. No scraping browser sessions or bypassing provider terms.

Trusted same-origin UI submits key once; broker stores protected credentials and returns opaque reference/redacted status. Never echo key or put it in model tools, worker files/environment, logs/events/URLs/source metadata/frontend state.

Provider owns authorization initiation/callback/device exchange, state/redirect binding, PKCE where required, finite callback lifetime, storage and refresh. Callback listener has no game-control routes. Device codes/authorization URLs remain trusted private operator flow.

Current Codex browser flow displays validated HTTPS auth.openai.com/oauth/authorize rather than optional SDK loopback launch shortcut. Reject URL credentials/fragments/unexpected host/port/path. State-checked callback uses port 1455; validated /codex/device flow is alternative for occupied/unsuitable callback. Retained discovery success is not independent live testing of both flows.

`AuthManager` owns selected-account inference sessions independently of Agent construction. Consumers register synchronous revoke and asynchronous drain covering startup, late resources and transport. Logout/discovery refresh/account replacement/app close revoke before joining; failed drain retains account restriction and blocks credential-store shutdown.

Resolution checks exact credential/model before/after tracked refresh persistence. Cancelling a caller ends its wait, not refresh ownership. Preserve upstream credential/sibling-wait provenance; never string/missing-key/ambient fallback. This API alone is not process isolation.

Revocation/expired refresh marks unavailable, rejects new calls and fences late callbacks. Reconnect is explicit trusted flow. Previously admitted local work obeys its original authority; no silent strategy/provider substitution. Jev failure remains separate from chosen later code-only work.

## Broker admission and transport

At run start opaque connection resolves exact role/model. Broker checks capability, authorized projection, deadline/concurrency/finite attempts/output. Secrets never reach general HTTP capability.

Provider descriptor records role/adapter/version/features/context/output/cancel/stream support where known. Unknown remains explicit. Logical decisions, actual exposed transport attempts, reported usage and cost provenance are separate.

Host tool parsing/authority is distinct from provider schema grammar. Tool factory sets strict false to preserve optional/discriminated semantics and uses input-direction schemas so host supplies defaults. Invalid raw inputs still reject before identity/persistence; SDK coercion cannot turn them into admission. Malformed SDK JSON stays SDK-owned, not harmless host validation.

No finite deadline/concurrency/attempt bound implies monetary stop threshold. A request can fail/abort with usage and unknown drain; a terminal usage record is not resource-release acknowledgement.

## Usage evidence

Run totals explicitly use SDK-reported subtotal basis. Uncached input/cache read/cache write/output can be null; null means Unknown, explicit zero differs. Earlier valid contributions survive later missing categories. Historical aggregate-only input remains legacy, never relabelled uncached; startup does not rewrite historical payloads.

New request usage evidence binds host request ID, separate SDK counters, allowlisted nullable provider-terminal metadata and bounded unaccounted response IDs. Supported OpenAI/Codex Responses terminal events and actual Jev response body supply source evidence; raw events/payload/header/credential/hidden reasoning do not.

SDK counter presence, response ID or stop reason alone is not terminal-counter proof. Missing/inconsistent categories/subdivisions stay null. Invocation-bound explicit terminal zero can qualify without response ID. Late predecessor observations cannot certify successor request.

Counters can survive local abort/unsettled finalization without fabricating successful message or transport closure. Event coverage and consumption coverage are distinct; [evaluation measurement](../evaluation/measurement.md) defines aggregation.

Known cost needs pricing provenance; zero placeholder prices are not free inference. Unknown cost stays unknown. Token/cache savings, program compactness and task efficacy are separate claims.

## Purpose attribution

Host admission records provisional role, not model prose or an accounting-only call. Final visible role/tool classification uses host review/speculation/recovery/authoring precedence before operations. Final purpose reattributes buckets without changing total calls/tokens/cost. Missing assistant response keeps explicitly nonfinal provisional role.

Historical model-declared purpose remains distinguishable/readable. Classification is accounting, never causal explanation or hidden reasoning.

Sources: [`auth.ts`](../../src/server/auth.ts), [`auth-session.ts`](../../src/server/auth-session.ts), [`provider-usage.ts`](../../src/server/provider-usage.ts), [`strategic.ts`](../../src/server/strategic.ts). See [reactions](reactions.md), [scheduler](scheduler.md), [security](security.md).
