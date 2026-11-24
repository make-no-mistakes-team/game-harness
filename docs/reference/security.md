# Trust, access and isolation

Trusted owners: backend authorization/persistence, provider/auth brokers, adapter observation/effect gates and selected dependencies. Untrusted: generated JS/model output, retrieved docs/web/tool results and displayed source. Loopback alone grants no authority.

## Data access

| Resource | Authorized owner / boundary |
| --- | --- |
| Raw engine/protocol/world state | Trusted adapter; narrow privileged evaluator only for verification |
| Authorized observations/memory | Filtered planner/workers with original time/world/branch/uncertainty |
| Private geometry | Trusted bounded low-level movement only, never observed index or hidden route selection |
| Hidden targets/seeds/saves/verifier truth | Isolated game/evaluator storage; never planner, workers, experience, logs or retrieval |
| Provider/game credentials | Trusted broker/private login only; no prompt/event/URL/frontend/artifact/worker export |
| SQLite/artifacts/host files | Trusted least-access backend; workers get only bounded authorized copies |
| Human live view | Authorized renderer/transport; actor only narrow typed PNG path, no HTTP/backing buffers |
| Public docs | Trusted bounded retrieval of attributed untrusted text |

Filter before metadata/count/order/paging/errors, not just prompts. Privileged verification has separate output/access even on single-user host. Its hidden inputs cannot teach current actor or reusable experience. Host-selection image metadata is not capture-time gameplay proof.

## Generated-code boundary

Plain eval, VM, worker and unrestricted coding-agent execution are not security sandbox. Current generated programs/policies use private restricted Docker containers; required boundary is enforced OS isolation independently of source checks/model instructions.

Dedicated unprivileged identity, readonly minimal root, dropped capabilities/no escalation, no host namespaces/sockets/Docker socket, no source/home/credentials/database/world/host-proc mounts or unrelated environment. Network disabled, including loopback/private/link-local/metadata/DNS/viewer/provider. Only immutable selected artifact and bounded private state/scratch cross.

Framed serialized schema-checked capability IPC, no raw objects/callbacks/arbitrary imports/commands/paths. Finite CPU/wall/memory/process/output/IPC; nontermination/flooding terminates/revokes and retains evidence/quarantine as applicable. Kill still leaves trusted executor responsible for lease safety.

Ship worker and detached guardian; pinned Node image preexists. Cleanup pending until Docker confirms removal/descendants drain. No unsandboxed fallback when isolation unavailable. Source AST/byte checks are not this boundary; isolation alone also cannot prevent cheating through overbroad broker results.

## Browser and local transport

Loopback default for host/adapter/view. Explicit Host/Origin allowlist resists rebinding/hostile pages; no reflected/wildcard origins. Trusted bootstrap/authenticated commands, appropriate HttpOnly/SameSite cookies and CSRF on mutations; read/SSE/WebSocket also authorized. Never tokens in URLs/history/logs, and no GET control mutation.

Generated content is escaped/inert or deliberately restricted sanitized display under CSP/origin separation; no script/event-handler execution in operator origin. Viewing source cannot execute/install/activate/widen access. Private authenticated adapter transport is not browser raw-engine API. CORS/port secrecy is insufficient.

Electron sandboxed renderer has no raw Node/game input. External links use validated trusted flow. Backend ownership nonce and shutdown target only its child, not unrelated services. Public hosting/multiuser administration requires separate security design.

## Retrieval

Broker bounds bytes/time, attributes URL/source/time and marks content untrusted. Reject files/nonpublic/loopback/private/link-local/credential-bearing destinations and privileged local routes; validate resolution at connection and every redirect, including proxy/alternate forms. No arbitrary cookies/headers/auth.

Queries cannot upload secrets/private run/hidden environment state. Public game facts are allowed; hidden-world lookup/save analysis is not. Retrieved instructions never grant capability or override task/system.

## Diagnostics and interventions

Redact **before persistence/display**, not export only. Allowlist categories/correlation/version/config/admission/timing/usage/cancel/fence/quarantine. Exclude secrets/device codes/auth headers/account sessions/hidden state/raw protocol/saves/private paths/arbitrary objects/stacks. Do not dump environments/HTTP bodies for auth diagnosis.

Registered argument errors can name declared field/static expected type or trusted numeric constraint, not supplied values/schema internals/ambiguous union guesses. Unknown-key hints retain bounded names/containing path/omission counts, never values. Source-authored exceptions are separately untrusted advisories, not host truth.

UI labels unknown costs/effects, stale view, incomplete capture/rejected output honestly. Record restart/reconnect/pause/task/restore/account interventions and tactical coaching distinctly, retaining active/wall/downtime. Recovery never removes failed segment or resets metric origin.

Existing private evidence/world/auth data has no automatic deletion authorization. New-development artifact budget and model-run authorization live in [development policy](../development/model-runs.md), while [frozen protocols](../evaluation/policy.md) keep original allocations. Publication requires review/sanitization; an ignored checkout path is not a safe export.

See [providers](providers.md), [perception](perception.md), [navigation](navigation.md), [operations](operations.md).
