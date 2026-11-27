# Trust, access, and isolation

Trusted components are the TypeScript host (`src/agent/`, `src/minecraft/`,
`src/auth/`, `src/server/`), the Fabric mod's observation and verification
boundaries, and pinned upstream libraries. Model replies, retrieved text, and
external inputs are untrusted: they may suggest macro goals through
`StrategistBridge` but cannot execute shell commands, read host files, or
bypass local safety reflexes.

## Data boundaries

| Resource | Owner and boundary |
| --- | --- |
| Raw Minecraft world and server state | Managed local server and Fabric client; ordinary play consumes filtered sight and [combat-flow geometry](../survival/perception.md), never hidden chunks, seeds, or admin commands. |
| Goal verification statistics | Saved vanilla stats read by [`src/agent/verify.ts`](../../src/agent/verify.ts) only after confirmed clean server closure. |
| Provider and Minecraft credentials | Private auth store (`src/auth/`, directory mode `0700`, files `0600`) and official Launcher Secret Service lookup (`mod/bootstrap/launcher-auth.py`); never logged, printed, exported, or included in prompts. |
| Worlds, recordings, and raw logs | Private gitignored roots under `local/runtime/`, `local/survival-agent/`, and `local/survival-pilot/` (or `GAMEHARNESS_DATA_DIR`). |
| Live video viewers | Read-only loopback HTTP/WebSocket streams (`watch:agent` on `127.0.0.1:4379`/`4382`/`4383` and desktop viewer); viewing grants no gameplay input. |

## Local transport and desktop shell

Host HTTP, live viewer, and managed Minecraft server bindings default to
loopback (`127.0.0.1`). Loopback alone does not confer trust: the minimal
desktop backend checks session tokens, `Host`/`Origin` allowlists, and CSRF
headers on mutations, keeping tokens out of URLs and logs.

The Electron shell (`desktop/main.cjs`) keeps renderer sandboxing and context
isolation enabled with Node integration disabled. Never launch with
`--no-sandbox`; fix `chrome-sandbox` permissions per [setup](../setup.md).
Each Survival run isolates its own private `Xvfb` display and `XAUTHORITY`
file rather than sharing a personal desktop display.

## Redaction and private storage

Redact secrets, bearer tokens, auth headers, device codes, and machine-specific
paths **before** writing logs, receipts, or error payloads — not only at export
time. Never dump raw environments or HTTP bodies when diagnosing auth failures.

Private worlds, credentials, SQLite databases, and raw recordings have no
automatic publication permission. Git local excludes (`.git/info/exclude`) do
not sanitize tracked files or archives; follow [publication](../development/publication.md)
before committing or pushing, and [model runs](../development/model-runs.md)
for artifact retention and cleanup bounds. See [providers](providers.md) for
credential lifecycle details.
