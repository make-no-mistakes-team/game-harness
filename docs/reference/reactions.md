# Authored reactions and fast decisions

Experimental GameHarness policies propose decisions; the executor alone emits effects. JS policy execution and remote Jev are different backends. Neither receives a built-in shield, attack, retreat, eating or other survival policy.

## Immutable selection and trials

Source/config/card/validation are immutable. Selection, generation, counters and private state belong to one run and policy lineage, never shared inherited snapshot entries. One run cannot activate/quarantine/retire another's selection. Global security revocation is a separate audited safety action.

Draft can validate/quarantine/retire. Validated can trial/quarantine/retire or activate after evidence-linked keep/eligible inherited reuse. Trial can activate/return validated/quarantine/retire. Active can demote/quarantine/retire. Quarantined can only retire; correction is a new version. Retired is terminal.

Expected-current-version checks prevent lost updates. At scheduling boundary revoke old evaluations, atomically publish pointer/state/effective event, then evaluate new source. Old replies reject. Prior running action remains attributed to its source unless explicitly cancelled; selection does not undo effects.

`reflex submit` persists, validates and explicitly selects a finite trial in one call while retaining separate stage outcomes. Failure after persistence does not delete source. Replays never repeat validation/activation or replenish counters; interrupted unacknowledged activation stays unknown. Preparing a revision leaves incumbent selected until normal switch.

Action/evaluation exhaustion fences new proposals but permits last admitted action and exact retirement to settle inside original time bound. Time expiry/Stop/life loss revoke immediately. Safe trial closure returns selected compatible prior version or no policy. Quarantine fences and safely cancels affected work, retaining evidence.

## JavaScript semantics

Body receives authorized context and mutable JSON state. Successful object mutation persists; reassignment of local state does not. Program metadata can describe an unfinished root even when action is null; action absence is not an idle test. No worker state, intent or authority is exposed.

Activated JS evaluates independently while async work awaits a capability. Ordinary semantic leaves have priority zero; unrelated reflex preemption requires higher priority. Replace creates another action and consumes trial action budget, not in-place retargeting. Continue leaves its own admitted response running; guards can use state to avoid repeated transitions.

Selection can span GUI transitions within original run/session/life/boot/space/compatibility. Each evaluation captures fresh screen and rechecks before effects; replaced-screen output discards. Opening/closing does not renew timers/bounds or silently unselect policy.

## Passive watch

Explicit JS watch permits positive duration ≤1,800,000 ms and checks ≤100,000. Continue consumes watch time/checks without short-trial evaluations; first valid current non-continue starts trial once, counting toward both. Trial deadline is clipped to watch deadline. Reselection/reasoning/trigger repetition renews neither.

Watch is unavailable for keep and Jev. Final selection-closed accounting follows worker/evaluation/effect drain. Expiry without threat is not defensive effectiveness.

## Jev broker

Actual OMP NativeJudge/TypeSafe broker uses selected bundled judge, never the strategic model ID. Trusted options may select another supported bundled TypeSafe judge. Configured state means key stored, not connectivity/entitlement proof.

Current broker: two concurrent requests, 60/minute, one actual attempt, no queue, 10,000-ms maximum and 2,000-ms effective reactive timeout. Cancelled transport retains its slot until actual settlement. Missing credentials fail before send; no local/fake-provider fallback.

Life changes synchronously fence/drain JS/Jev evaluations and execution state, preserving definitions/evidence/absolute trial budgets. Old-life replies never activate after respawn.

Requests bind policy/version/generation/evaluation, filtered input, permitted finite choices and broker deadline. Outputs are schema-validated choices with timing/attempt/usage or explicit error, never arbitrary tool/host/network commands. Input projections, output size, input age, response deadlines and attempts stay finite.

Code-only operation is valid when selected. A failed Jev response remains failed even if later JS proceeds. Local code is not labelled a successful Jev answer.

Sources: [`reactive.ts`](../../src/server/reactive.ts), [`fast-provider.ts`](../../src/server/fast-provider.ts), [`program-interface.ts`](../../src/server/program-interface.ts). See [actions](actions.md), [providers](providers.md), [experience](experience.md).
