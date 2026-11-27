# Provider connections and accounting

GameHarness model selection is provider-agnostic. Development-run permission
for a specific model is governed separately by
[model runs](../development/model-runs.md); provider availability or valid
credentials never prove account entitlement or gameplay competence.

## Authentication ownership

Supported connection categories are legitimate API keys and provider-supported
OAuth or device-code flows. Consumer subscriptions do not automatically grant
arbitrary API access. GameHarness never scrapes browser sessions or imports
ambient third-party CLI credentials.

Credentials are submitted through the trusted loopback UI or auth worker and
stored in the private auth database; callers receive opaque references and
redacted status only. Raw keys, tokens, and authorization headers never enter
prompts, logs, run events, URLs, or frontend state.

OAuth login validates the provider HTTPS authorization endpoint (rejecting
embedded credentials, fragments, or unexpected hosts/paths), binds PKCE and
state to the loopback callback on `localhost:1455`, and supports device-code
login when a browser callback is impractical. Callback listeners expose no
gameplay routes.

`AuthManager` ([`src/auth/manager.ts`](../../src/auth/manager.ts)) owns
selected-account sessions independently of individual strategist calls.
Consumers register synchronous revoke and asynchronous drain handlers covering
startup and active transport. Logout, discovery refresh, account replacement,
and shutdown revoke before joining; failed drain keeps the account fenced and
blocks credential-store close.

## Transport and proxy settings

The auth and inference transport modules
([`src/auth/network.ts`](../../src/auth/network.ts),
[`src/auth/inference.ts`](../../src/auth/inference.ts)) honor standard proxy
and TLS environment variables (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`,
`NO_PROXY`, lowercase equivalents, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, and
`SSL_CERT_DIR`). Keep loopback addresses direct via `NO_PROXY`.

At run start, `src/strategist/strategist.ts` resolves the explicit
`PROVIDER/MODEL` selection and enforces the attempt's finite `--macro-requests`
budget before dispatching each request. Request timeouts, refusals, or
provider errors never halt the local Java player.

## Usage accounting

Each attempt records logical admissions, actual transport attempts, applied
advice receipts, and SDK-reported token subtotals (`uncached input`, `cache
read`, `cache write`, and `output`) separately. Missing categories stay `null`
(unknown), never coerced to zero.

Known cost requires explicit pricing provenance; placeholder zero prices are
not reported as free inference. A terminal usage record does not confirm clean
transport drain, and advice receipts establish method application rather than
verified resource progress.

Sources: [`src/auth/manager.ts`](../../src/auth/manager.ts),
[`src/auth/session.ts`](../../src/auth/session.ts),
[`src/auth/worker.ts`](../../src/auth/worker.ts),
[`src/auth/protocol.ts`](../../src/auth/protocol.ts), and
[`src/strategist/strategist.ts`](../../src/strategist/strategist.ts).
See [security](security.md) and [pinned packages](../upstream/packages.md).
