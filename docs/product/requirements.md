# P01–P22 research requirements

**LEGACY GENERAL-HARNESS RESEARCH.** These are retained acceptance requirements
for model-authored GameHarness, not constraints on the ordinary local Java
player. [Scope](research.md) and [Minecraft requirements](minecraft.md) explain
the distinction. All criteria remain open unless their complete evidence is
established; mechanism evidence alone does not tick a release criterion.

## Setup and operation

- [ ] **P01 — Supported-host workflow.** An external operator completes
  documented setup, connects a supported adapter/environment and reaches real
  autonomous play. Publish tested application/runtime/adapter/game versions.
- [ ] **P02 — Both auth categories.** Make real authorized requests through a
  supported API-key path and legitimate provider-supported subscription/OAuth
  path. Keep credentials trusted; make entitlement/expiry failures actionable.
  Publish supported providers without promising every subscription brand.
  One category suffices for the first playable gate, not full acceptance.
- [ ] **P03 — Essential controls.** Start, pause, resume and stop work during
  inference/effects and display acknowledged lifecycle. Task/provider changes
  can configure a new run without requiring midrun model switching.
- [ ] **P04 — Truthful desktop view.** Show actual controlled Fabric
  post-HUD world/hand/video in one window. Gameplay occupies at least 75% of the
  fixed main area with sidebar shown and nearly all with it hidden; bounded
  dialogs contain setup/source/cards/history. Video is read-only. Feed intent,
  accepted work, waits, failures and uncertainty separately; video freshness
  grants no observation authority.

## Autonomous control

- [ ] **P05 — Bounded startup and warm activation.** Equal capability/preflight
  policy and frozen per-model limits across matched arms. Record requests,
  exposed attempts, retrieval, validation/cache, activation and first effect.
  Eligible exact-version warm selections need neither reauthoring nor repeat
  tactical trials; zero authoring calls is allowed. Unselected source remains
  selectively retrieved. Missing/inapplicable entries and ordinary authoring are
  visible; no substituted library, developer tactic or model readiness ceremony.
- [ ] **P06 — Concurrent and composite control.** A real long model request
  overlaps bounded effects and reactive evaluation. Submit promptly returns
  action/execution identity. Movement, camera and permitted interaction/attack
  overlap under one lease; cancellation neutralizes every channel. Measure
  inference, dispatch/reaction, legitimate waits and model-induced idle apart.
- [ ] **P07 — Declared reaction backends.** Code-only play needs no Jev or reflex
  ceremony. Selected local-code/Jev reactions retain actual authoring, use,
  outcome and freshness evidence. Advertised Jev connectivity needs a real
  response; local execution never impersonates an unavailable/failed provider.
- [ ] **P08 — Single effect owner.** Policies, revisions and controls cannot
  emit conflicting effects. Transfer requires acknowledged neutralization or
  declared recovery; stale epochs cannot act and ambiguous effects stay unknown.
- [ ] **P09 — Useful continuity.** Held-out play meets frozen window and
  task-specific progress/non-regression criteria. Report control-only TTF and
  same-window progress, retained state, failures/deaths separately. Busy or
  repetitive motion is not useful progress; retain every scheduled run.
- [ ] **P10 — Ordinary bounded programs.** Coherent JS modules support relative
  imports, controlled pure libraries and `run(game, args, checkpoint)`. Host
  pins immutable dependencies, scope and finite source/transport/runtime/
  capability/retry bounds; pure calls share isolation. First attempts need no
  elaborate reusable-artifact form. Complexity is descriptive; model completion
  prose is not verification and source validation is not OS isolation.

The compact interface's 16 KiB bodies/exact-version child calls, without module
imports or checkpoint continuation, do not alone satisfy P10.

## Experience, safety and recovery

- [ ] **P11 — Compatible reusable experience.** Immutable selected snapshots,
  bounded summary search, exact retrieval, idempotent knowledge/promotion and
  actual outcome history. Explicit cross-model imports preserve authorship and
  recheck compatibility; comparisons cannot silently cross partitions.
  Knowledge retains provenance/uncertainty/contradictions; programs need complete
  cards and eligible gameplay use. Eligible proposals publish new snapshots
  without mandatory human approval, deferred until sealed-batch closure.
  Failures remain visible; retries do not duplicate versions; world facts stay
  in their lineage and held-out outcomes cannot train the tested library.
- [ ] **P12 — Observation and sandbox boundary.** No tool/program/navigation/
  error/retrieval/view bypass to hidden game state, host files, secrets or ambient
  network. Assisted-360 permits nearby unobstructed behind-camera objects;
  frustum gates new targets; strict visual permits no semantic/private-geometry
  shortcut. Concealed resources stay hidden, hidden entities lack exact live
  updates, memory stays stale and real audio is coarse. Filter before ranking,
  counts and errors. Declared bounded private geometry supports local detours to
  authorized targets only; reject unknown goals before lookup. Test with
  Anti-Xray disabled and retain optional server configuration. Invalid programs
  are bounded/quarantined; privileged fixtures prove no tactical effectiveness.
- [ ] **P13 — Durable recovery.** Versioned serializable checkpoints permit
  compatible restart after fencing/drain, fresh state and unresolved-operation
  reconciliation, without restoring stacks or blindly replaying effects.
  Preserve Pause/Stop; disclose actual reset/restore support and rollback branches.
- [ ] **P14 — Long-running operation.** Progressive real-play/recovery soak
  evidence toward hours/days states actual duration, downtime, game failures and
  interventions. Short episodes do not establish days-long reliability.
- [ ] **P15 — Usage transparency.** Separate decisions, requests, exposed
  attempts/IDs, uncached/cache-read/cache-write/output and known/unknown cost.
  Host admission role is provisional; visible-tool/host-role precedence finalizes
  it without accounting-only inference or hidden-reasoning interpretation.
  Missing responses stay provisional, legacy aggregate input unclassified.
  Compact context/cache hits promise no savings; reliability limits are not prices.

## Evaluation, improvement and portability

- [ ] **P16 — Registered comparative evidence.** Immutable finite cold/warm and
  policy-capability manifests use actual matched initial saves, sealed snapshots
  and every scheduled outcome. Freeze models, verifier, observation/assistance/
  server settings, mechanics, executor, references and limits. Seed equality
  alone is not matching. Cold policy control disables registered reactions/fast
  requests but keeps ordinary conditional programs; treatment enables JS/optional
  Jev. Separate efficacy/deaths from timing/use and retain non-use/regression/
  downtime/unknown usage. Package effects do not isolate Jev. Predeclared sample
  reuse retains the same IDs; revision correlations are descriptive.
- [ ] **P17 — Task outcomes.** Declare verifiers and preserve genuine attempts,
  verified success or exact unresolved progress. Narrow milestones cannot close
  a broader objective; sustained tasks need no terminal game state.
- [ ] **P18 — Adapter conformance.** First integration proves typed permitted
  observations/actions, real effects/view identity, verification, cancellation/
  recovery, stale fencing and privileged-state isolation. Publish unsupported
  lifecycle operations; no second adapter is required.
- [ ] **P19 — Honest operating handoff.** Setup, auth, integrations, limitations
  and outcomes match delivery. Workflow readiness and unachieved objectives stay
  independently visible.
- [ ] **P20 — Autonomous strategic turns and improvement.** Event-driven,
  single-request scheduling covers readiness, task changes, relevant outcomes,
  replans, recovery, no runnable work and due trials. Queued work continues
  without polling. Durable cursors/coalescing, bounded retries/backoff/context and
  explicit waiting prevent call loops. Evidence-backed repeated-gap, capability/
  error/interruption, short-sequence, boundary and trial opportunities arrive
  proactively without stopping play. Manifest-recorded triggers, deduplication,
  acknowledgement/deferral and one active trial survive restart. At least one
  opportunity produces a model-authored change and linked bounded gameplay trial;
  every offer has evidence-linked reuse/revision/trial/disposition or reasoned
  defer/reject. Runtime facts prescribe no tactics.
- [ ] **P21 — StrategyCards and visible improvement history.** Every reusable
  version has the exact [card](../evaluation/revision.md) with source, purpose,
  applicability, method, reason, parent, changes and outcomes. Show one real
  version change, why and what changed, and linked trial outcome or “not yet
  measured.” Claims differ from effects. Authorized source is escaped inert
  text; viewing grants no execution/data authority. Model markup never executes
  in the operator origin. Full editors/replay are optional.
- [ ] **P22 — Two-provider task success.** Two strategic models from different
  providers independently verify the same bounded task through unchanged core/
  adapter, changing only provider/model/configuration/credentials. Retain all
  attempts, conditions/failures and verifier evidence. This promises neither
  every provider nor Dragon success by both; P02 auth breadth and P11 explicit
  imports are separate requirements.
