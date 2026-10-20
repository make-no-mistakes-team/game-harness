# Implementation MVP Contract

Status: acceptance contract for the first complete playable integration. No implementation or gameplay result is established by this document. The [release PRD](prds/gameharness-v1.0-prd.md) remains authoritative for full product scope, including the full-game objective.

The first gate is one real Minecraft session with one supported strategic connection: filtered observation → OMP strategic tool call → admitted game action → observed feedback → next autonomous strategic turn. It must also exercise a model-authored policy in real play while execution continues during inference. Build this vertical slice before completing every provider, recovery path, or evaluation feature.

## Contracts used by the slice

Use the [runtime contracts](runtime-contracts.md), [architecture](architecture/overview.md), [operating rules](operations-and-security.md), and [artifact/evidence rules](learning-and-evaluation.md). The slice implements those interfaces with real effects. It retains one controlled player, serialized strategic turns, and a game-neutral core.

The only required initial Minecraft observation profile is [`player-observable-structured`, version 1](runtime-contracts.md#player-observable-structured-profile-v1): bounded nearby unobstructed objects independent of camera direction, with structured state/events and protected hidden state. Information permissions and observation interface are separate; structured access does not authorize arbitrary raw Mineflayer data. The runtime owns finite configurable observation/query limits and the [bounded private geometry-only navigation exception](runtime-contracts.md#bounded-private-navigation-geometry). A future `strict_visual` profile, screenshots as model input, and an all-voxels-observed collision map are not prerequisites. Record the effective profile/configuration fingerprint, interface/schema, and server flavor/build/Anti-Xray configuration under the [evaluation manifest rules](learning-and-evaluation.md#declare-the-experiment-before-running-it). Paper Anti-Xray is optional; filtering must work with it disabled.

## Early integration proofs

Resolve these two data/control risks before building a broader capability catalogue:

- **I01 — Structured observation and bounded navigation.** Pass the [structured-observation and navigation proof](operations-and-security.md#structured-observation-and-navigation): behind-camera unobstructed objects remain observable within range; concealed ore stays hidden until legitimately revealed; hidden entities have no exact live updates, last-seen memory stays stale, and real audio remains coarse. Unknown is not absent. Private bounded geometry-only navigation to an authorized known target permits local detours toward that same target through collision cells not individually observed. It cannot select hidden resource targets or use global/unknown geometry to choose exploration routes, and cannot expose private geometry through paths/results/errors. Reject unknown-target probes before private lookup; check internal reads and actual effects, including same-geometry ore/stone substitution and hidden shortcut selection outside the local execution envelope. Generated code and alternate endpoints cannot reach raw bot/world/chunk/entity data. Exercise filtering with Anti-Xray disabled; constrain/replace an incompatible pathfinder rather than give it unrestricted raw world state.
- **I02 — Composite control under one owner.** Pass the [composite-control proof](operations-and-security.md#composite-control): movement, camera change, and permitted interaction overlap under one lease during delayed inference; cancellation neutralizes all included channels. Label any injected delay.

## First complete playable gate

All items are mandatory for this gate. A connected UI, successful provider call, generated source file, or mocked game effect alone cannot pass it.

| ID | Executable outcome and retained evidence |
| --- | --- |
| I03 — Real observation/model/game loop | Use one supported model through a legitimate API-key or subscription/OAuth flow in ordinary Minecraft Normal Survival. Complete the [real strategic round trip](operations-and-security.md#a-real-strategic-round-trip), including the next autonomous turn and at least one verifier-confirmed useful bounded result. No human prompt advances each step. |
| I04 — Asynchronous execution and scheduling | A bounded action continues during a real strategic request; submission returns promptly and policy evaluation remains independent. The [scheduler](runtime-contracts.md#strategic-turn-scheduler) handles completion/replan/no-work signals without concurrent strategic requests, tick polling, or tight retries. |
| I05 — Authored policy with real invocation | The model authors, registers, validates, and activates one immutable local-JS or Jev-backed policy. An ordinary-gameplay trigger produces an admitted decision with a confirmed attributable effect, such as effective interruption or replacement under the normal lease rules. Retain its StrategyCard and authoring/validation/activation/use evidence. Registration, trigger counters, `continue`-only/no-op traces, staged arenas, and self-reported success cannot pass. The first policy need not improve metrics. |
| I06 — Safety and durable admission | Enforce OS isolation, brokered permissions, one effect owner, stop, and freshness gates. Commit admission/artifacts before dispatch; uncertain effects remain unknown. Skill starts retain stable `start_key`, one durable `execution_id`, and `skill.get` lookup across lost acknowledgements. Restart fences old emitters even if automated resumption is deferred. |
| I07 — Inspectable live evidence | Show the live player, lifecycle, model/tool/action status, waits/failures, and policy/card references. A trace connects observation, request, admission, confirmed effect, feedback, next turn, and policy use. Display actual timing/usage or explicit unknown/unmeasured status, not a promised speedup. |

No mock provider, handwritten survival strategy, unsafe `eval`, fake fallback, or fabricated success can satisfy this gate. Safety, permitted observations, durable admission, and minimum local evidence are not deferred infrastructure. Controlled security fixtures are separate from ordinary-world gameplay: their privileged diagnostics remain evaluator-only, their coordinates/tactics cannot train reusable experience, and passing them cannot establish policy effectiveness or satisfy I03/I05.

## Expansion after first play

Exercise the real Jev connection and typed proposal/freshness path early alongside this slice, retaining authorization or compatibility failures explicitly. A local-JS first loop may pass before Jev is integrated; release **P07** still requires real Jev gameplay and a separate code-only run.

The following remain mandatory release work after this first gate: full autonomous improvement opportunity handling and evidence-linked revision trials (**P20**); selective retrieval, knowledge saving, eligible autonomous promotion, and compatible warm hydration (**P05/P11**); the live improvement-history card with a real authored change and linked trial (**P21**); complete declared recovery coverage and progressive soak evidence (**P13/P14/M03**); cold/warm, held-out continuity, and the controlled policy-capability experiment (**P09/P16**). The first gate's policy invocation does not by itself establish useful-policy effectiveness, promotion eligibility, or a measured improvement.

Release also retains both supported auth categories (**P02**) and adapter-verified success on the same bounded task with two strategic models from different providers, changing only provider/model/configuration/credentials (**P22**). It does not promise every provider or subscription brand. Full library browsing/editing and replay stay optional.

The complete Minecraft workflow and autonomous Ender Dragon objective (**M01/M02**) remain in scope. Report this bounded integration result separately from full release readiness and full-game success; retain genuine failures and unresolved progress at every stage.
