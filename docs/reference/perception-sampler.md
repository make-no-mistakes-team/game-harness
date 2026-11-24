# Proposed scheduled perception sampler

This is a **future separate profile**, not the active eight-block native implementation or a benchmark result. It preserves a concrete generic-system design without silently widening present permissions. Active semantics are in [perception](perception.md).

## Fixed budget

| Resource | Proposed setting |
| --- | --- |
| Observation / private geometry radius | 32 from exact eye / eight from feet |
| Schedule | One batch/200 bridge-monotonic ms; first immediate; no overlap/catch-up |
| Block directions / entity slots per batch | 128 consecutive of fixed 354 / 64 registry slots |
| Raw cell visits | 65,536 total: 57,344 block, 8,192 entity; no borrowing |
| Occlusion | One eye, ≤six target points, ≤128 visits/ray |
| Elapsed admission guard | 10 ms, checked before each candidate/cell; blocks first even batches, entities odd |
| Current age | ≤1,000 ms, dependencies can invalidate earlier |
| Authorized index | 4,096 current+remembered records |
| Pages | Default 32/max128, invalid larger limits rejected |
| Output | 256 records; 2,048 UTF-8 bytes/record; 65,536 whole response with 4,096 envelope reserve |
| Sound | Eight coarse records/batch, expiry 1,000 ms |
| Private plan | 4,913 distinct cells/8,192 visits/2,048 expansions/4,096 queue; ≥100-ms replan, 5-ms admission guard |

Before admission retain actual algorithm/registry/geometry revisions, effective overrides and SHA-256 of RFC8785 materialized configuration. Missing current/historical values cannot be filled from this proposal. Loaded state/eligibility further restrict each radius.

## Discovery and resumability

World-aligned ray cycle: elevations −75° to +75° by 15°, within each azimuth 0° to 348.75° by 11.25°, then straight up and down. Direction `(sin(a)cos(e),sin(e),−cos(a)cos(e))`; zero north, clockwise east. Resume cursor across poses, never restart prefix because resource queried/avatar moved.

Each eye→eye+32×direction supercover traversal stops at first loaded nonair cell or unavailable cell, at most 128 visits. Nonair is only candidate: center must be within 32 blocks and pass target check. Failure does not look behind it; all-air means no candidate, not absence. Repeated hits consume slots/visits and upsert authorized block position.

Registry traversal resumes ascending protocol entity-ID order strictly after last examined ID, wraps, and counts slot **before** type/availability/range checks. New lower IDs wait for wrap; avatar excluded; bounding-box center must be within 32 blocks. No per-batch whole-registry sort/type query. Raw IDs/counts stay private.

Retain at most one unfinished discovery/block candidate and one entity candidate with point/ray cursor. Suspend before next counted operation when partition/slot/time ends, resume before advancing that source. A resumed item consumes next batch slot. Reuse partial/check only while eye and all read-cell/target dependencies remain unchanged and age is at most 1,000 ms; otherwise restart same direction/entity, not cycle prefix. Each slot attempted once/batch; advance on completed success/failure.

Three nominal batches cover a stable direction cycle only absent interruptions; thin objects/ray gaps and changing state can remain unsampled indefinitely. A cycle is neither full coverage nor absence proof.

## Conservative target checks

Use exact eye as sole origin; yaw/pitch irrelevant. Six block unit-face centers are inset by 1/1024 block; entity AABB faces by min(1/1024, normal extent/4), ordered −X,+X,−Y,+Y,−Z,+Z. Missing/degenerate bounds are unknown.

Known nonempty pinned block collision geometry retains points inside shape boxes; if none, substitute up to six distinct box centers in ascending min/max coordinate order. Known-empty shape for loaded nonair uses full voxel and original face points. Unsupported/missing geometry cannot use that fallback. These approximate selection volume, not rendered silhouette.

Supercover includes every closed cell touching segment, origin/end included, ordered entry parameter then x/y/z for ties. Intervening nonair is whole-cube opaque, including transparent blocks/foliage/fluids; other entities do not occlude. Unknown/unloaded fails unknown. Exempt only block target cell, whose endpoint still passes geometry. No skipped air assumptions.

First eligible clear ray authorizes projection. Blocked tries next point; over 128 visits is unknown. Six failed rays mean unobserved, not absent. Stock visibility helpers are not this permission system.

## Currentness and bounded publication

Recheck eye/target/read-cell dependencies before publication/read. Eye movement, target/occluder change, dependent unload or age over 1,000 ms invalidate; camera rotation alone does not. Hidden entity motion invalidates currentness without changing last seen. Session/life/epoch/world/branch/profile invalidates handles/partials; new epoch/profile resets cursors.

Filter/project current or explicitly requested memory **before** predicates/counts/order/paging. Sort blocks x/y/z and entities by opaque authorized handle; collection order current blocks/entities then remembered blocks/entities. Evict oldest legitimate observation with authorized-order tie-break. Counts never represent raw world totals.

Cursor pins authorized index revision/order and expires after 1,000 ms; changed eligibility/revision rejects. Search does not scan raw world. Responses describe partial coverage and returned ages without hidden raw counters/maps.

Count actual compact UTF-8, reserve envelope, never split a record. Oversized record omits with safe authorized-output truncation; fill ordered records until page/aggregate/byte limit. Optional large prose omits, never leaks into errors. Sound shares output caps. Expiry/eviction/missed sampling never proves disappearance.

Private diagnostics retain durations/exhaustion, slots/completions/partial checks/rays/visits, sampled pose/cursors/cycle age and actual checked coverage. Guards stop new work rather than preempt a slow operation or promise deterministic runtime. Exhaustion cannot authorize unchecked targets.

See [navigation](navigation.md), [adapters](adapters.md) and [measurement](../evaluation/measurement.md).
