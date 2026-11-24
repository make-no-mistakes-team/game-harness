# Improvement opportunities and bounded trials

This page distinguishes the broader generic release contract from delivered source-linked death/failure/outcome opportunities and named revision/assessment evidence. The broader dotted catalogue is not another callable API. Exact implemented records live in [`execution-evidence.ts`](../../src/shared/execution-evidence.ts).

## Detection and delivery requirements

The same backend derives game-neutral timing/capability/error opportunities; it chooses no tactic and launches no second strategist. Feedback reads are not required to create an opportunity.

Deduplicate by run/epoch/reason/exact artifacts/evidence window. Preserve evidence interval, counts, unknowns, delivery/decision references and finite deferral. Capability sequences use capability IDs/versions, not tactical labels; unrelated patterns remain separate.

Initial chosen release settings, not benchmark results:

| Setting | Value |
| --- | --- |
| Evidence window | 120,000 ms, fixed run/epoch windows |
| Inference gaps | Three classified gaps ≥1,000 ms |
| Error/interruption pattern | Three occurrences |
| Capability sequence | Three nonoverlapping occurrences of an ordered 2–4-call sequence |
| Task/skill boundary | Five new relevant records since acknowledgement |
| Delivery cooldown/default defer | 30,000 ms each |
| Pending / active trials | 32 / one |
| Trial maximum | 120,000 ms, 20 actions, 100 evaluations; first bound wins |

Unknown timing cannot become an inference gap. Due trial decisions bypass new-opportunity cooldown. Detection/retrieval runs in bounded batches outside effects; pending pressure retains unprocessed cursor/source intervals rather than dropping facts or flooding prompts.

States: pending, offered, in trial, deferred, resolved, rejected, superseded. Offering is not acknowledgement. Each offered ID requires explicit reuse/trial/keep/revise/retire/revert/defer/reject with reason and evidence. Restart preserves offered/unacknowledged and acknowledged deferrals. Task/epoch transition supersedes obsolete opportunities without deleting evidence.

## Trial requirements

Admission durably binds exact candidate/card/dependencies, model hypothesis, measurements, prior-policy-or-none return selection, start cursor and finite limits. One trial remains allocated through cancellation/closure; identical admission retries return original trial/execution/switch, changed content conflicts. Terminal trial IDs cannot renew allowance.

A validated candidate may enter a bounded real trial without existing efficacy evidence. Normal leases/security/cancellation/quarantine/freshness apply. First bound/decision point fences proposals/children/evaluations, cancels through ordinary closure and restores declared prior selection or none. Automatically request one strategic decision; concurrent reasoning cannot bypass safe transfer.

Model assesses actual outcomes or missing evidence, then keeps/revises/retires/reverts and considers promotion or records ineligibility/defer/reject. No self-promotion or deadline extension. Before/after association is not causality.

## Delivered revision evidence

Named review records keep or insufficient evidence for matching outcome. Top-level reason on a direct-child write/edit links latest exact-parent feedback and candidate; the host fills exact provenance. It is performed candidate work, not verified improvement or adoption.

Already assessed feedback keeps immutable resolution; a separate candidate-written event can preserve a later experiment link. Internal revise needs exact revision; assessments do not. Invalid/conflicting links cannot fabricate resolution.

Insufficient evidence limits claims, not permission to author/try finite new work before goal completion. Repeating unchanged blocked work under unchanged conditions supplies no new evidence.

After trusted verified goal, one effect-free review allows three calls, twelve tools and 30,000 ms under improvement purpose. It may inspect/author but never run another gameplay trial. Custom model-reported completion follows Stop rather than review.

See [scheduler](scheduler.md), [experience](experience.md), [objective evidence](evidence.md) and [evaluation](../evaluation/policy.md).
