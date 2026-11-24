# Prepare before joining

Experimental GameHarness can author a bounded executive before starting a stopped world. This is distinct from ordinary connected-world Create/Start and from the primary [Java Survival workflow](../survival/play.md). Preparation never disconnects an existing session to satisfy its preconditions.

## Disconnected source phase

`POST /v1/prepared-start` uses an immutable UUID request identity/task/goal/exact image-capable model. Preconditions: stopped EULA-accepted server, disconnected player, ready sandbox, no active run or unsettled preparation. The host reads the actual native JAR, validates embedded contract/build inputs and binds artifact SHA-256 plus compatibility hash. Schema knowledge is not a negotiated session or observation.

The selected authenticated model receives task, trusted schemas/help and finite limits with world state, observation and native identity null. No placeholder run/world/session/life is invented. Each attempt has fresh private sourcebook without inherited programs, experience, observations or cross-model history.

Tools are help, inactive write/edit, source/catalog inspect, pure analyze and prepare finish. Preparation write alone defaults step. Semantic children explicitly select run body; libraries/analyze select their formats. Ordinary write requires explicit entry. Help uses actual source-only catalog and excludes unavailable playing/review/reflex/memory operations.

Optional operator-supplied readonly references are bounded task material: 32 references, 16 KiB each, 512 KiB total, detached and SHA-256 checked. No ambient file lookup or automatic dependency/state/target loading. Only then is `program_copy` available; an actual model call selects approved reference hash, name and matching entry. Copy creates inactive source with provenance, not new authorship, qualified experience or selected root.

Edits retain parent entry/card and omitted pins, or replace all pins explicitly. Selected dependencies must already exist. Rejected graph/source changes publish nothing; retries preserve immutable original receipts.

Pure analyses use model-authored synthetic JSON and disposable workers. They establish software behavior/shape, not clean-worker readiness, gameplay applicability or efficacy. Optional activation/decision validation preserves the original output and failure after charging once. Check the actual selected state/args: null and `{}` are different. State remains 16 KiB, not a full frame dump.

## Finite attempt and sealing

[`PREPARED_START_LIMITS`](../../src/shared/prepared-start.ts) owns defaults: 1,200,000-ms original deadline through compile/join/transfer; 48 model requests, 96 tool admissions, 64 immutable versions, 524,288 canonical source bytes, eight analyses, 500-ms per evaluation and 4,000-ms cumulative evaluation.

Historical 12-request/300,000-ms or 24-request/600,000-ms attempts retain their original 48-tool allowance and deadlines. Reads never upgrade them. Private journal has 16 MiB plus 1 MiB terminal reserve and 2 MiB record cap. Failed work remains charged; persistence failure fences admission.

Before dispatch, journaled budget context states remaining resources and original deadline. Remaining-after-this-request excludes the receiving request; zero leaves that response as last chance to finish. This does not amend tool receipts.

Prepare finish selects exact step exporting activate and step, explicit args/state, finite resident limits and session config. It seals source/inference, joins actual inference/tools, then clean-compiles the pinned bundle without invoking entries. Software checks are risk-driven, not an exhaustive admission matrix; known contract/source defects still require correction. Valid source/limits/clean compile/current native applicability/ownership remain mandatory.

Ready means the worker exists and supports activation, never a gameplay result. Coordinator rechecks idle ownership, JAR and compatibility before acquiring new native launch.

## One-use transfer

Only actual joined native readiness permits a real run, fresh working-program import and retained authoring usage. Ordinary preflight requires a living ready player; it does not respawn. SkillManager validates sealed bundle/root/args/state/limits/session and admits the real root in Store **before** consuming worker once under that run.

First actual frame invokes live activate with selected state/intent unchanged. No predecessor, synthetic activation or probe result is replayed. Worker transfer, activation, applied input and task success are separate evidence.

Preflight-ready also admits Main's first task inspection while local executive runs. Local starts without waiting for cloud; local work must not postpone that first inspection to retirement.

## Replay and closure

Same request/body returns original receipt without another inference/compile/launch; changed body conflicts. Cancel fences source inference/compile synchronously then joins tools/workers and untransferred launch. Closed requires confirmed cleanup. Interrupted/unconfirmed ownership stays unknown, blocks new attempts and is not replayed on restart.

Transfer records transferred, not worker closed. Ordinary run budgets and Pause/Resume/Stop then own execution; preparation cancel refuses transferred runs. Later startup failure drains run ownership without silently disconnecting a healthy transferred world. Stop world explicitly tears it down.

Official-session preflight can verify trusted matching Launcher session before billable Source without exposing account/credentials or granting launch; launch checks again. Pure authoring needs no game login. Confirmed absence projects fixed official-session-unavailable; arbitrary failures stay redacted. Rejected launch joins closure, preserves ready time and leaves no run/transfer.

Sources: [`prepared-start.ts`](../../src/server/prepared-start.ts), [`prepared-source.ts`](../../src/server/prepared-source.ts), [`prepared-sourcebook.ts`](../../src/server/prepared-sourcebook.ts). See [providers](providers.md), [security](security.md).
