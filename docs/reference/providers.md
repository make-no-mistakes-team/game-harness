# Provider connections and accounting

GameHarness model selection is provider-agnostic. Development-run permission
for a specific model is governed separately by
[model runs](../development/model-runs.md); provider availability or valid
credentials never prove account entitlement or gameplay competence.

## Authentication ownership

The current launcher offers provider-supported browser OAuth and device-code
flows. Consumer subscriptions do not automatically grant arbitrary API access.
GameHarness never scrapes browser sessions or imports ambient third-party CLI
credentials.

The auth worker completes authorization and the manager stores credentials in
the private auth database. The frontend receives redacted status and catalog
choices; selected-account inference sessions resolve credentials directly for
the SDK. Tokens and authorization headers never enter prompts, logs, run
events, URLs, or frontend state.

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

## Request accounting

The strategist records requests, published plans, applied plans, and provider
errors separately. Each admitted inference call permits one transport
dispatch, including SDK recovery paths. Shutdown joins inference and checks
the final applied-plan receipt without counting it twice.

The v2 runner does not export token subtotals or monetary cost. Request counts
do not establish either quantity. Applied-plan receipts establish that advice
was accepted, not that the player achieved a resource goal.

Sources: [`src/auth/manager.ts`](../../src/auth/manager.ts),
[`src/auth/session.ts`](../../src/auth/session.ts),
[`src/auth/worker.ts`](../../src/auth/worker.ts),
[`src/auth/protocol.ts`](../../src/auth/protocol.ts), and
[`src/strategist/strategist.ts`](../../src/strategist/strategist.ts).
See [security](security.md) and [pinned packages](../upstream/packages.md).
