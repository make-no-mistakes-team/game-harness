# Adapter compatibility and extension

The generic core uses `ObservationV3` plus registered adapter-owned payload/capability schemas. It does not require player, blocks, enemies, inventory, recipes or a terminal victory. Minecraft is the first implemented game; a descriptor alone does not make another game supported.

## Negotiation and manifests

Trusted registration validates actual JSON schema documents, not peer hashes alone. Descriptor binds game/adapter/version/build inputs, envelope/payload identities and hashes, complete materialized permission-profile configuration/hash, actual capabilities and actuator/executable versions. Native JAR embeds its contract; host reads the ZIP resource, final artifact hash and actual build inputs, then compares the process descriptor. Supplying a hash for a process to echo is insufficient.

Run manifest records actual negotiated support, task, model/connection reference, world/epoch, configuration, verifier and immutable snapshot before strategy starts. Reconnect verifies compatibility. Incompatible change needs explicit migration/new attempt, never silent continuation.

Permissions and delivery interface are separate. Structured state/events/actor RGB do not prove fairness. Configuration is materialized before hashing; profile changes are explicit comparison conditions, not schema relabeling.

Artifacts/state declare compatible game/adapter/profile/schema/configuration/capabilities/state schema and source provenance. Source compatibility excludes live boot/session/run/life/space IDs. Runtime checks declarations/hashes; adapter checks domain predicates. Same JavaScript is not automatic cross-game portability.

Active boundary:

| Boundary | Version |
| --- | --- |
| Observation envelope / Minecraft payload | 3 / `minecraft_observation_v1@2` |
| Executable API, validator, runtime | 5 |
| Native hello / action | 4 / `minecraft.action@4` |
| Visible screen / controller binding | `minecraft.visible_screen@1` / `minecraft.controller_frame@2` |
| Controller frame payload | 3 |
| Worker framing / resident namespace / login admission | 1 / 1 / 1 |
| Live capture / canonical SQLite / derived SQLite | GHV2 / 8 / 1 |
| Usage metrics / request-usage evidence | 2 / 1 |

Historical schema-2/API1–4 source, reports and observations retain original read-only identity, including missing authority/nulls. They are never relabelled or restored as live controllers. Active validation/import/hydration/policy/effect admission requires complete API5 stamp and stable compatibility/source/configuration fingerprint. Revalidation creates new immutable identity; no old-active shim, fallback adapter or child-calling alias.

## Required adapter declarations

An extension supplies:

- Stable game/adapter identity and exact versions/range.
- Observation profiles with permission/interface/schema, bounds, freshness, reference/dependency invalidation and separately declared controller-only data.
- Implemented capability argument/result schemas, effect/read classification, units, finite duration, preconditions, evidence and cancellation.
- Authentic live-view source, staleness/availability and authorization, or unsupported.
- Task/verifier schema, version, evidence authority and separate privileged path, or unverified.
- Connect/disconnect/fencing/recovery and actual state-support procedures.

Connect starts closed to effects and binds authenticated session. Observe returns only authorized profile data. Effect checks current scope/deadline/domain constraints at application. Cancel distinguishes request acknowledgement from neutralization/fence. Verify never leaks privileged inputs. Optional state operations report unsupported/pending/completed/failed honestly.

Checkpoint, reset, restore and world pause **independently** declare unsupported, operator-assisted or adapter-managed. Pending assistance needs attributed action/confirmation. A checkpoint does not imply rewind, deterministic replay or another operation.

Cancellation declares acknowledged neutralization or required fence/disconnect, finite deadline and worst-case remaining effect window. No bounded safe fence means no admission. Cancelled can never mean merely “message sent”; another lease waits for actual retirement.

## Conformance

Exercise schema/version/mismatch rejection; profile filtering and unknown/reference semantics through every API/helper/error/retrieval/view route; privileged-verifier separation; unchanged single lease/lifecycle/cancellation/unknown-effect rules; expired/revoked/changed-dependency rejection and still-valid slow decisions; reconnect/reobservation/reconciliation with preserved Pause/Stop intent; authentic view and verifier evidence.

Supported state operations must demonstrate declared consistency/lineage, not merely possess files. New games add no game-specific scheduler shortcut, marketplace or distributed-service requirement.

Minecraft conformance must distinguish behind-camera **terrain** assistance from rendered-camera entity admission. Test hidden ore/reveal with Anti-Xray disabled, hidden-entity stale memory/coarse real sound, alternate-route isolation and internal local-navigation reads/effects. Old camera-independent entity fixtures are historical conditions, not current-profile requirements.

Synthetic cases establish infrastructure; real tasks establish gameplay. No second game or complete conformance is claimed here. See [perception](perception.md), [navigation](navigation.md), [recovery](recovery.md), [runtime evidence](../evidence/runtime-history.md).

Sources: [`adapter.ts`](../../src/shared/adapter.ts), [`registered-adapter.ts`](../../src/server/registered-adapter.ts), [`adapter-contract.ts`](../../src/server/adapter-contract.ts).
