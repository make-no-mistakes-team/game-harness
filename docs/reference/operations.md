# Experimental desktop operations

This workflow is for generic generated-program GameHarness. The primary ordinary Java player uses [Survival play](../survival/play.md). Host prerequisites/install/auth are in [setup](../setup.md); game/model/test authorization is separate in [development policy](../development/model-runs.md).

## Create and control a run

1. In Settings accept the Minecraft EULA and prepare managed server, then Start world/Reconnect client. Wait for connection and authentic world/hand/HUD view separately.
2. Select a discovered image-capable strategic model and natural-language task. Custom defaults to no verifier. Selecting a preset binds its exact criterion/prompt; editing text switches back to Custom.
3. Select Fresh or same-session same-model working definitions. Qualified compatible snapshot is a separate cross-session selection, not retained invocation state.
4. Create saves task; Start begins inference after host preflight. Inspect source/cards/dependencies, executions, trace/comparison/learning/life/planning in dialogs. Validation/program completed prose is not objective success.
5. Pause/Resume/Stop run retain healthy connection/video with neutral input and ticking world. Only explicit authored respawn requests new life. Stop world ends owned server/client. Stop run/world before new world; prior directories and runs remain retained.

Custom completion displays model reported/unverified; trusted preset alone emits verified goal. An unsupported verifier never becomes success. No human prompt per action is required. Camera/movement profile precise/balanced/fast is persisted operator mechanics, not strategy or speedup proof.

Desktop closes only spawned backend/game via owned shutdown. Readiness nonce distinguishes its child from an unrelated service occupying the port. Managed server is loopback/private-session admitted, not public multiplayer. Physical gameplay/menu callbacks/polling in owned native client are suppressed; human uses app controls.

## Private application storage

Desktop defaults Electron userData/runtime; `GAMEHARNESS_DATA_DIR` selects root. Direct backend retains a legacy checkout-local default: use private absolute external override, never a share directory.

| Relative location | Private contents |
| --- | --- |
| auth/gameharness.sqlite and sidecars | Credentials; auth directory mode 0700/files 0600 |
| runs.sqlite and sidecars | Canonical run/action/event/program/policy evidence |
| history.sqlite and sidecars | Bound derived projection; see history schema rules |
| artifacts | Immutable canonical source |
| minecraft | Provisioning/worlds/private logs; prior worlds retained |
| native-client | Isolated client; no personal world/config migration |
| native-session.json | Mode-0600 admission secret; never display/export |
| provisioning-consent.json / app.lock | EULA consent / single-owner lock |

Launching configuration: desktop port 0 (dynamic), direct backend 4317 via `GAMEHARNESS_PORT`; managed game 25565 via `GAMEHARNESS_MINECRAFT_PORT`. Checkout exclusion does not untrack files, secure backups or sanitize exports. Never copy open SQLite main file alone.

Evaluation [runtime/governance/report roots](../evaluation/storage.md) are separate and do not change application storage. Existing auth opens in place, not copied into bundles. Old worlds/reports are not automatically adopted/deleted under new artifact accounting.

## Authenticated inspection

Current route definitions/validators, rather than this list, own DTO/query fields. Stable route families:

- Session bootstrap `/v1/session`, private readiness `/v1/ready`; authenticated state/runs/run details/events.
- Run evidence, objective metrics, trace, improvements, deaths and planning; version comparisons.
- Model-scoped experience metadata and explicit evidence-gated promotion.
- `/v1/config` motor settings, `/v1/jev` redacted configuration and `/v1/performance` operator diagnostics.
- Stable-ID run controls, authenticated `/v1/events` SSE and same-origin `/v1/video` binary WebSocket.
- Prepared start/cancel under the separate [preparation contract](preparation.md).

Read access is bounded evidence projection, not filesystem/execution/activation authority. Source/script-looking content renders inert. History includes exact source/cards and explicit omissions. Current feedback/comparison V2 cursors are in [history](history.md); retired insertion/legacy query forms are not aliases.

Mutations require authenticated session, CSRF and retained request identity. Identical command returns original result; changed content conflicts. Invalid transitions conflict, unknown run IDs create nothing. A sent command is not safe closure.

SSE is at least once with durable per-run sequence; deduplicate. Expired/unavailable cursor requires explicit resync/current status/new cursor, not uninterrupted-delivery claim. Browser disconnect marks stale but does not pause a healthy run.

## Performance and status

Settings Performance diagnostics shows backend CPU (% one core), RSS, sample window, event-loop lag and bounded observation/action/video-forward distributions. Dialog polls at most once per second while open, cancels close/hide and preserves no-sample/unavailable/stale states.

Action round trip includes deliberate gameplay/receipt, not dispatch latency. Native FPS/frame data differs from renderer capture-to-draw wall measurement. Display cannot establish token savings, useful policy or justified language rewrite.

Acting/program running/model thinking/waiting/blocked/recovering are execution facts, not model intent or guaranteed progress. Progress retains source/execution/event/time and unverified provenance. Model-request-failed paused is failed request, not provider-wide outage. Inspect cause/account; refresh discovery if appropriate, then explicit fresh-state Resume. Reauthorization needs Stop first.

Stopping remains pending until real drain; Retry Stop retries cleanup, never gameplay. Stopped cannot Resume. Unknown outcomes retain uncertainty after neutralization. See [lifecycle](lifecycle.md), [recovery](recovery.md), [capture](capture.md) and [security](security.md).
