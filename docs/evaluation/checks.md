# Evaluation entries and recording boundaries

These commands describe available boundaries, not permission or evidence that
they were run. Read entry-point `--help`; source validators own current flags.
Native entries require an existing fresh explicitly built Java 21 JAR and refuse
staleness rather than rebuilding. [Policy](policy.md) governs attempts;
[frozen E01](e01.md), [P13](p13.md) and [released reference](released-reference.md)
have distinct declarations/allocations.

## Local checks and CI

`bun run check` selects typechecking only. `bun run check unit <file>` and
`bun run check integration <file>` select classified suites; omit file only for
a relevant full tier. `bun test` is broad aggregation. None builds Java/UI or
permits a game/provider.

The [CI workflow](../../.github/workflows/ci.yml) publishes **CI checks** on PRs
targeting `main` and pushes to `main`, with a **20-minute** infrastructure ceiling: frozen dependency
install, typecheck, Bun suite, Python **3.10.22** reference/process tests and UI
build. NumPy supports representation tests; no Torch/MineRL/weights are loaded.
No Minecraft/Docker/Electron/provider/Java build. Tests use temporary storage,
subprocesses/loopback; freshness times are baseline-relative, not sleeps.
PR merge snapshots check base compatibility without publishing merge commits;
superseded runs cancel. Branch protection is not configured by the workflow.
Green covers only tested revision; inspect failed-step logs.

## Native mechanics and conformance

`bun scripts/native-minecraft-mechanics.ts --allow-native --jar <fresh.jar>`:

| Selection | Real boundary and limits |
| --- | --- |
| Default / `tool` / `stone` / `repair` | Approach/mine/own pickup/planks/table, tool placement/craft, stone progression, or blocked-parent/child revision. Disclosed dry platform/resources/daylight and evaluator-authored procedures, zero inference. |
| `controller-stream` | Eleven base cases plus GUI receipt retirement/fresh owner, repeated input/counts and 16-operation GUI >2 seconds; native streaming arbiter, reserved retirement/expiry. Stopped native case retains late physical release, not timely continuity. |
| `resident` | Actual SDK/Runtime/Docker selected module, bow held over 15-second synthetic reasoning/inactive compilation, GUI craft, pre-admission cold error, post-effect throw, Stop during infinite computation; declared death/teleport/dimension and stopped-owned-native/ordinary-RPC pressure. No model competence. |
| `approach --mode baseline` | Captures faults without semantic pass |
| `approach --mode fixed` | Positive/negative mining/travel with concurrent parent observations; exact selected stages are scoped continuations, not a full rerun |
| `visible-gui` | Full 18-case screen/source/cursor/modifier/resize/replacement/ACK-race set. `--stages chest,furnace` is only debugging. Preserve original resize packets/fixed-size segments. |
| `sensing` | Eight own-state/crosshair/capture join/stopped-server/read/use/movement/heard priming/fluid-air-vehicle/scope cases; worker API exercises isolated access. Audibility mute/attenuation proof remains separate, not claimed live mute testing. |

Movement stages: `ascent,headroom,excavation,placement-collision,placement-corner,
placement-face,placement-adjacent,navigation-envelope`. Excavation's readable
recording discloses evaluator night vision; failed bursts and later ceiling
mining are evaluator choices, never a supplied actor solution.

GUI replacement requires a new same-class screen while the old gesture is still
pending, not only after drain. Slow-reader proof needs actual socket-write
backpressure, not unread replies/full host queue. Trusted owned-socket controls/
JVM observations may witness this without changing production writer; retain
reserved Stop ACK and pre-resume capture clocks separately. Expiry is not
continuous control. Fault configuration is evaluator-only; natural starts reject
it, and ordinary private sessions record disabled evaluation.

Additional zero-inference entries use `GAMEHARNESS_NATIVE_PROOF=1` with
`scripts/native-game.ts`, `scripts/native-contract-game.ts` (exact `--case`
continuations), and `scripts/native-recording-proof.ts`, all `--allow-native`.
Pure Java/synthetic transport/renderer preflight remain separate from live hooks.

## Model and study entries

`bun scripts/minecraft-development.ts --help` describes finite fresh Normal
Survival, empty inventory/continuous time, plain task, explicit image-capable
model/auth, criterion (default custom), seed/start disclosure and existing ledger.
No prepared/restored saves/setup commands. Curated starts are disclosed. Select
`craft_stone_pickaxe` for that goal; a table criterion cannot verify a stone task.

Diagnostic `--single-inference-dispatch` selects disclosed direct Codex SSE:
one pre-response host HTTP dispatch shared across SDK/auth recovery, no enabled
websocket, manual redirects surfaced without following. It preserves selected
account authority/error metadata and rejects completed tool calls from failed
streams. Truncated/errorless streams leave provider/consumption unknown.
This bounds host fetch dispatch, not provider-internal/custom-fetch retries;
ordinary defaults and frozen studies stay unchanged.

`evaluate register-study --manifest <manifest>` freezes declarations; `study`
selects that exact manifest/immutable slot. Live use needs both resource opt-ins;
admission-only rejects native/inference/auth/JAR/model/budget flags.
`authorize-evidence` binds concrete correction, not prompt/model renaming.

## Capture and replay

Acceptance uses actual AuthManager discovery/existing private auth in place,
without login/logout, credential copies or fallback. Private append-only
journals retain actual SDK-visible context, visible messages/partials,
tool args/results, authorized root observations before compact caps, source and
native receipts, deduplicated typed images and explicit redaction of private
reasoning. SDK-visible context is not wire payload or hidden-attempt proof.

Default journal bounds: **256 MiB text/16 MiB pending**. Pin complete effective
recording/journal/image/renderer profile and preprocessing identity in studies.
Actual durable bytes differ from reservations; capacity/persistence failures
stop visibly, and closure joins writers/handles before Store.

`evaluate native-recording --allow-native --jar <fresh.jar>` is zero-inference,
with disclosed wait/effect interruption/death/explicit respawn. Replay duration
tolerance is exactly **134 ms** (nominal 30 Hz frame +100 ms, rounded up), never
expanded by observed gaps. It is not Runtime Stop or auth-login proof.
Duration accepts up to **1,800,000 ms**; long samples need complete admitted
phase/frame capacity checked before preparation, declared final hold and actual
duration/gaps/drain. Technical arena and natural-start/load remain distinct.
Complete launcher-window examples and finalization rules are in
[storage and finite closure](storage.md).

Verify frame inventory/presentation timestamps, not duration alone; inspect
replay/actor images manually. Actor PNGs have opaque alpha. Default development
uses timestamped compressed capture without persistent per-frame PNG spool;
decoded compressed video is not exact-pixel proof. **Frozen registered pixel/
resident protocols explicitly retain lossless PNGs**. Corrected exports retain
old renders and declare source/options rather than rewrite capture history.
Long synthetic SDK requests finish normally without chaining “reasoning.”

Private retention may expire closed unpinned development payloads under policy,
retaining outcomes/usage/expiry. Expired evidence is not replayable or “fully
retained.” Recordings identify condition/profile/snapshot/time/cuts/speed;
selected highlights disclose selection, prerecording and original sources.
