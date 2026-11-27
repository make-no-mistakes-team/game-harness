# Model runs and evidence

Read before starting a gameplay or model run, presenting footage, or deleting
run artifacts.

## Authorization

Development-run authorization comes from the user's current request, not from
a product-wide model list. Record exact model selections in private execution
declarations. Permission to test one model neither restricts users to it nor
authorizes testing another model.

On `experiment/minecraft-survival-agent`, active authorization permits
unlimited aggregate runs, requests, and duration for the explicitly authorized
model, including after failures. Still assign finite wall-time, request, and
evidence limits to each owned attempt, with progress checks and confirmed
resource closure. Never substitute models silently.

For recovery development on this branch, the soft artifact allowance is
**400,000,000,000 bytes of new artifacts**. Pre-existing material sits outside
that allowance and outside automatic deletion ownership. Crossing the soft
allowance prompts a review of eligible old development payloads; it is neither
a hard stop nor permission to delete unregistered historical files. Physical
disk safety remains a hard stop. Scoped accounting lives in
[`src/agent/storage.ts`](../../src/agent/storage.ts) and
[`src/agent/storage-campaign.ts`](../../src/agent/storage-campaign.ts).
Set `SURVIVAL_AGENT_ARTIFACT_CAMPAIGN=recovery-development` for ordinary runs
and declared [single-lane diagnostics](../survival/diagnostics.md#single-lane-diagnostics).
First activation requires drained lanes and records the historical baseline;
later admissions preserve it.

On other branches, ask before using a model or raising limits outside an active
grant: state old and proposed values, reason, cost/resource risks, and
temporary vs permanent scope. Repeated failures alone do not revoke standing
permission.

## Attempts and outcomes

Record finite allocations, actual consumption, unfinished work, failures, and
full attempt history. Exhausting wall time, requests, tokens, or evidence
bounds is a **budget-limited outcome**, not proof of model incapability. Check
whether the allocation allowed meaningful completion before blaming a model or
switching models.

Keep the real model control path on the critical path early. Local execution
keeps playing while inference is pending; reduce model authority if round trips
stall ordinary play. Preserve local safety reflexes and user prohibitions.

Failed runs and runtime errors require complete evidence and confirmed
stop/drain before diagnosis and repair. Never present obvious failures for
visual approval or relabel a narrower diagnostic as a full campaign win.

## Manual review

Inspect representative rendered footage at **original 1× speed** before
presenting it. Playback completion, sampled screenshots, passing unit tests,
and telemetry counters do not establish visual quality. State tool limitations
if 1× review is unavailable. Catch obvious defects yourself; the user's visual
judgment is decisive.

On `experiment/minecraft-survival-agent`, ask for footage feedback when useful
and include the recording's absolute path and local review link. A successful
run does not block further survival progression unless the user asks to stop.

On other branches, once a noticeable gameplay change produces a run meeting its
declared user-facing goal, present representative footage and pause further
gameplay development (including subagents) until feedback arrives. Group small
changes and request review when a run demonstrates their combined effect.

## Artifact ownership

Use compressed 30 fps live video (`screen.mp4`) for ordinary development while
preserving exact model-visible images separately. Full lossless frame sequences
require an explicit finite diagnostic declaration.

Outside the recovery campaign allowance above, rotate explicitly managed,
closed, confirmed-drained, unpinned development runs (successful or failed)
within **50 GiB**, **ten unpinned runs**, and **fourteen days**. Preserve
outcomes, usage, and expiry records. Active owners, user worlds, and review
pins override expiry; refuse new admission when protected storage fills the
hard budget.

Standalone parallel batches
([`diagnose:combat` / `diagnose:descent`](../survival/diagnostics.md#parallel-multi-scenario-harnesses))
write outside `storage.ts` admission; review and prune old diagnostic batches
explicitly after inspection. Unregistered historical material requires separate
cleanup approval. Credentials, governance records, and the official Minecraft
installation are never artifact deletion targets. Local git exclusions never
authorize deletion or publication.
