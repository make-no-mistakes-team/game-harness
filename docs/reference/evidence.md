# Execution evidence and interpretation

Evidence records actual authorized requests, observations, outcomes and source-linked revisions. They are not hidden reasoning or a guarantee that software is useful. Frozen experiments retain original identities/populations and negative results.

## Trace and attribution

[`execution-evidence.ts`](../../src/shared/execution-evidence.ts) defines trace/death/opportunity/working-program/comparison records. Trace binds exact program/version/hash, root/parent, session/life and available call/action/observation/event references.

Kinds cover capability request/result, observation, instrumented branch, authored intent, categorized span and explicit omission. Branch instrumentation must preserve evaluation order, short-circuit and await behavior; canonical source/hash stays immutable. Branch/intent never explains why a target was chosen.

Trace page cap is 65,536 bytes; payload over 24,576 becomes explicit omission with original size. Per-run bounds are 8,192 records/8 MiB, with omitted counters; default page is 100 records. Death episodes/source event commit together before subscriber notification and retain last authorized context.

Known omission and uncertain tail/loss reason both mark incomplete. Missing trace cannot erase separately confirmed receipts. Public capability rejection category/message enters correlated evidence before ordinary trace caps even if source catches it; host exceptions remain redacted.

Spans distinguish native action, dispatch, receipt, readiness, sandbox, capability wait, strategic request, handoff and life recovery. Same-clock durations are measured; absent/cross-process intervals need uncertainty.

## Objective comparisons

Measured means actual dispatch started, not accepted-then-cancelled. Report confirmed block removals, receipted own inventory delta, target switches, sampled/receipted travel/rotation, timings, outcomes, full sample counts and limitations.

Convert sampled radians using shortest-angle differences for degrees. Do not label every extra block unnecessary, infer tree identity, exact item origin or target-selection reason.

Comparison pins exact source/card before/after and bounded populations; conclusion is descriptive only, not causal improvement. Unmeasured revision remains candidate. Actor scope is trusted run/model before source reads; operator explicitly authorized scope is separate from caller-supplied claims.

## Facts that must remain distinct

| Evidence | Does not establish |
| --- | --- |
| Source accepted / clean worker ready | Applicability, effects or gameplay success |
| Program completed / authored event | Whole-task verification |
| Input submitted / ACK / callback | Damage, kill, item production or useful behavior |
| Neutralized / worker drained | No earlier effects, rollback or resolution of unknown |
| Inventory possession | Exact item causal origin or intermediate production |
| Frozen snapshot / compatible hash | Generalization, fairness or safety override |
| Video encoded / manifest complete | Visual inspection, every native render, synchronized state or audio |
| Before/after timing / overlap | Causal benefit or token savings |

UI/activity should show proposal, selected/effective change, keep/revert/failure/unmeasured status separately. A compact improvement card links opportunity, exact previous/candidate/selected source/card, model reason/semantic change, trial and authorized evidence. Escaped source display grants no activation.

Keep unavailable metrics unknown. Retain actual requests/attempts, rejected proposals, cache/retrieval, actions, versions, input basis, interventions/downtime and unresolved effects. Startup/preflight, source authoring/validation, opportunity delivery/decision, switch, trial closure and first confirmed outcome each need their actual event/process/clock.

## Scope of retained runtime cohorts

- [Process isolation and recording](../evidence/runtime-processes.md): component/default-path stall/Stop and capture fixtures.
- [Mechanics](../evidence/runtime-mechanics.md): visible inventory and fault-custody fixtures.
- [Earlier integration](../evidence/runtime-history.md): superseded lifecycle/model/native samples.
- [E01](../evaluation/e01.md), [P13](../evaluation/p13.md), [released reference](../evaluation/released-reference.md): separately frozen protocols, never pooled by documentation rewrite.

Those records are scoped claims copied from retained documentation, not checks rerun during restructuring. Primary fresh-world Survival acceptance is separate; no runtime fixture supplies evidence of both diamonds and Nether entry.

See [history](history.md), [experience](experience.md), [timing](timing.md), [evaluation policy](../evaluation/policy.md).
