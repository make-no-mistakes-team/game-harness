# Timing and correlation

These records distinguish computation, sampling, application and effects. They are measurement evidence, never input permission. Frozen studies retain their own clocks/populations; see [E01](../evaluation/e01.md), [P13](../evaluation/p13.md) and [released reference](../evaluation/released-reference.md).

## Clock domains

UTC supports human correlation. Durations remain on their originating process/boot monotonic clock. Never subtract unrelated clocks or sum overlapping spans into idle time.

Ordinary native replies retain correlated receive/reply nanoseconds as decimal strings and tick. Receive is authenticated application entry; reply precedes serialization/socket flush. Host brackets request on its own clock to retain native-minus-host bounds and uncertainty. Existing traffic supplies samples without new observation polls. Mapping resets at boot and expires; it does not guarantee no drift.

Lease records bind actual queue checks/request/owner/generation with requested, previous, effective and task deadlines. First fence is stamped at synchronized transition, not earlier validation time. Retirement initiation/trigger, post-release ACK and input application are separate.

Application-stage evidence binds original request/owner/frame and actual admission/begin, queue ahead, preparation ordinals, first completed preparation/input consumption/movement hooks. Missing stays null. Queue settlement differs from ACK application time; empty GUI may ACK earlier; GUI dwell remains application time.

Opportunity batches record evaluated preparation/empty/skipped/predecessor/readiness decisions without re-running predicates. Buffers retain accepted prefix and omissions. No extra query transports final batch; missing carrier/unattached records leave coverage incomplete. Reserved retirement ACK size/order is unchanged.

## Different endpoints

| Endpoint | Meaning |
| --- | --- |
| Input submission | Host accepted authored snapshot, not application |
| Application start | First matching native application, distinct from later settlement |
| ACK | Consumed ordered prefix/actual pose/time, not damage/production |
| View settlement | Completion of admitted simulation-rate interval |
| Effect receipt | Declared world/GUI evidence, possibly unknown despite ACK |
| Worker step elapsed | Guarded transport/scheduling/evaluation/serialization wall time, not CPU |
| Analysis elapsed | Trusted evaluation interval, excludes compile/teardown |
| Analysis post-evaluation | Host callback receipt→service settlement, nullable |
| Action round trip | Includes gameplay duration and receipt waits, not dispatch latency |

Native attack callbacks record path entry, not accepted damage. Matching server attack receipt can distinguish damage, processed-no-damage and ambiguous handling. No channel proves kill by itself.

Resident trace can retain absolute anchor/slot/wake/sample/return/validation/renewal/submission. Early timer re-arms same slot; exact next-boundary settlement does not skip. Gaps/observer errors/finite omission limit claims. Streamed subscribers may retain separate bounded population; snapshots detach.

Capture-to-applied metrics require the **matching** capture and actual application endpoint. Later ACK settlement can measure later consumption/view settlement; it must not replace separately correlated application start for freshness. Sampling waits/missed slots are cadence, not capture-to-applied latency.

## Host diagnostics

Operator diagnostics retain 512 request samples with omitted/missing/invalid counts. Source validation/publication/import, inference admission/first complete SSE response/settlement, capability waits and worker startup/cleanup have correlated host spans.

SDK exposes prepared request and first complete received SSE event, **not raw first network byte**. Worker ready is supervisor boundary, not every source computation finished. Rejected validation/import publishes no source identity; uncertain cleanup is no successful barrier.

Actual native movement-key sampling, camera setter and owner-release hooks are separate witnesses. Camera change does not prove rendered view; capture/render metadata must supply that evidence.

Required game waits, authored waits and infrastructure stalls need evidence-based labels. Unclassified time is not automatically inference delay or wasted motion. Descriptive overlap, compactness and local-language performance do not imply token savings or causal gameplay improvement.

Sources: [`controller.ts`](../../src/shared/controller.ts), [`execution-evidence.ts`](../../src/shared/execution-evidence.ts), [`resident-controller.ts`](../../src/server/resident-controller.ts). See [capture](capture.md), [providers](providers.md), [evidence](evidence.md).
