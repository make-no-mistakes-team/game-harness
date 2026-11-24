# Model runs and evidence

Read before starting a gameplay/model run, presenting footage or deleting run
artifacts. Frozen protocols retain their original declarations.

## Authorization

Development-run authorization comes from the user's current request, not from
the product's supported-model list. Record the exact authorized selection in
private execution declarations. Permission to test one model neither restricts
users to it nor authorizes testing a different model.

On `experiment/minecraft-survival-agent`, the current authorization permits
unlimited aggregate runs, requests and duration for the explicitly authorized
model, including after failures. Choose finite wall, request, tool and evidence
allocations for each owned attempt, with progress checks and confirmed resource
closure. Do not substitute models in declared experiments.

For the current recovery work, the soft allowance is **400,000,000,000 bytes of
new artifacts**. Pre-existing material is outside that allowance and outside
automatic deletion ownership. This replaces the earlier branch-wide 300 GB
aggregate ceiling for this work. Crossing the soft allowance calls for reviewing
eligible old development payloads; it is not a hard stop or permission to delete
unregistered historical material. Physical disk safety remains a hard condition.
The scoped accounting implementation lives in
[`storage.ts`](../../survival-agent/storage.ts).
Use `SURVIVAL_AGENT_ARTIFACT_CAMPAIGN=recovery-development` for these ordinary
runs and the explicitly declared [high-water development diagnostics](../survival/diagnostics.md#high-water-development-cases).
First activation requires drained lanes and records the historical baseline;
later admissions retain it. Older/frozen diagnostic allocations stay unchanged.

Other branches retain their applicable private authorizations. Ask before using
a model or increasing a limit not covered by an active grant. Repeated failures
alone do not revoke standing permission or require a new platform-evidence
revision.

The resident step budget defaults to **25 ms**. Individually declared finite
development experiments may temporarily use **50 ms**, recording that override.
This does not change the default or other limits.

Outside the experiment branch's explicit authorization, increases to model-run
or experiment limits require approval: state old/proposed values, reason,
cost/resource risks and temporary/permanent scope. Use a new declaration.
For recurring constraints, offer a permanent default change.

## Attempts and outcomes

Record finite allocations, actual consumption, unfinished work, failures and
complete attempt history. Exhaustion of time, requests, tokens, tools, analysis
or evidence is a **budget-limited outcome**, not proof of model incapability.
Assess whether the allocation permitted meaningful completion before attributing
failure to a model or changing models; propose larger allocations when justified.

Keep the actual model control path on the critical path early. Ordinary work
continues locally while inference is pending; reduce model authority if permission
checks or round trips interrupt normal play. Preserve safety checks and user
prohibitions. Escalate conflicting prerequisites rather than bypassing them or
postponing real product feedback indefinitely.

Failed runs and runtime errors need complete evidence and safe stop/drain,
then direct diagnosis and repair. Do not request visual approval of obvious
failures or relabel an easier task as success.

## Manual review

Inspect representative rendered behavior at **original speed** before presenting
it. Playback completion, sampled screenshots, tests and metrics do not establish
visual quality. If tools cannot support that assessment, state the limitation.
Identify obvious defects yourself; the user's visual judgment is decisive.

On `experiment/minecraft-survival-agent`, request representative-footage feedback
through `ask` when useful. Include the recording's absolute path and playback
link. A successful run does not block further survival progression unless the
user asks to stop.

On other branches, after a noticeable gameplay change yields a run successful
for its declared user-facing purpose, show representative footage and explicitly
ask for review. Pause development, including subagents, until feedback arrives.
Small changes may be grouped; track changes since the last review and request
review when a successful run demonstrates their noticeable combined effect.

Successful-run review rules do not waive frozen protocols, concurrency limits,
finite admission, explicit stop instructions or applicable model authorization.

## Artifact ownership

Use compressed live video for ordinary development, preserving exact
model-visible images separately. Full lossless frame sequences require an
explicit finite diagnostic/experiment declaration.

Outside the recovery allowance above, rotate explicitly managed, closed,
confirmed-drained, unpinned development runs, successful or failed, within
**50 GiB**, **ten unpinned runs**, and **fourteen days**. Preserve outcomes, usage
and explicit payload-expiry records. Active owners, user worlds, review pins
and frozen experiments override expiry; refuse admission when protected storage
fills the applicable hard budget.

Existing unregistered material requires separate cleanup approval. Credentials,
governance history and the official game installation are not artifact deletion
targets. Local checkout exclusion does not authorize deletion or publication.
