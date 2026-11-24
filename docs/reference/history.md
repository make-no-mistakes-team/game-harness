# Canonical history and derived projections

The canonical ledger, derived history and game saves have separate owners. Source events and action evidence are authoritative; summaries/metrics are derived and never authorize replay.

## Storage split and frozen readability

Current `runs.sqlite` schema **8** owns source MVCC. Bound `history.sqlite` schema **1** owns derived rows, generations, checkpoints and opportunities. `Store.readLocation()` binds both plus immutable artifacts; current readers refuse missing/foreign projection identity.

Writer migration copies and verifies derived rows/identities before removing old canonical copies. Interrupted migration compares retained copy; corruption refuses admission instead of rebuilding empty history. **Frozen combined schema-7 histories remain readable without migration or mutation.** Earlier schema-7 writer-preparation descriptions are historical combined-storage semantics, not current instructions to mutate frozen evidence.

Canonical changes to runs/actions/executions/events/traces/budgets/program metadata receive durable sequences. Seal prior raw values before mutation; unchanged values may remain in original row. Fixed-boundary reads preserve original ordinals, deletion and absent authority. Bootstrap/indexed source pages have at most 128 rows.

## Read and write owners

History child opens only existing writer-prepared SQLite readonly. It cannot create directories, migrate/repair, chmod, select arbitrary query paths, expose SQL or invoke game/provider operations. Fixed parent-selected executable/module/storage paths inherit no credentials/proxy/preload settings. Source bytes verify hash before UTF-8 decode.

One active query plus eight queued requests keep original deadlines/cancellation. Full UTF-8 request/reply including envelope/newline: 8 KiB/64 KiB. Each compound query releases deferred read transaction before serialization/idle so it does not pin WAL. Cancellation/timeout/shutdown owns child until process exit/pipes drain; replacement only for distinct request after barrier. Query failure grants no retry or empty-success fiction.

Default Runtime owns a separate lazy derived writer; standalone Store callers use same implementation locally. Derived transactions avoid canonical writer lock. Bounded sequential child metadata permits only source-frontier acceptance/idempotent audit, not arbitrary SQL or physical effects.

Child mutation interruption can mean unknown persistence. New owner inspects checkpoint and drains immutable outbox without replay. Startup admission waits audit recovery. Deadlines conservatively translate to CLOCK_MONOTONIC; live typed-array endpoints, not cached raw addresses, drive metadata waits.

## Bounded preparation and publication

Capture desired source boundary once; do not chase later mutations. A preview has at most 64 patches, 16 candidate captures and 128 work iterations. Writer validates scope/progress/bounds/prior checkpoint and rechecks captures against readonly source. Canonical transaction accepts exact candidate batch hash/frontier; patches/checkpoint commit together in projection DB.

Identical accepted batch may resume after derived rollback; changed content needs fresh source validation. Entire next continuation must fit 8 KiB **before commit**; fitting reply alone cannot strand work. One active preparation plus eight FIFO callers/run; waiting cancellation does not cancel active pass. No failed pass retry/deadline renewal.

Review resolution and audit outbox commit together in derived DB. Canonical event and dedup receipt commit together before outbox ACK. Reopen/replay drains pending learning-resolved exactly once; this is not a cross-database atomic transaction.

Publish only complete generations with retained derived revision and exact source-through. Pending metrics/opportunities stay hidden. Indexed dependencies and durable forward removal cursors bound work rather than rescan deleted prefixes; goal associations preserve terminal order and observation eligibility. Production reads materialized rows, not whole-history reduction.

## Paging and recovery references

Live views disclose generation/source-through/source-available/has-pending. End-of-page is not completion of pending source work. Before first complete publication, derived reads conflict, not empty success. Missing already-published generation is corruption, not current fallback. Readonly inspection never starts preparation; committed source notifications can schedule effect-free work, failure audit alone cannot retry.

Exact ID/version/family resolution is independent of presentation caps. Feedback V2 has separate opportunity/metric change cursors bound by scope hash; metrics replace/retract, including atomic old-scope retraction/new-scope replacement when a family moves. Removal before first publication emits nothing. Retraction does not fabricate replacement. Old cursors reject.

Comparison V2 pins both complete generations plus offset/scope across updates/reopen. Named actor views use program/version/execution ordinal, not opaque execution ID. Retained generation stays readable after live execution deletion.

Operator evidence pages are insertion-offset, may include running executions and omit oversized records whole. Actor metric/evidence selects exact named version/ordinal/generation. Operator full archive routes require generation and provide ordered JSON text chunks with record/chunk indices, byte count and SHA-256. Omissions retain recovery references; DTO fields never truncate.

Pause/Stop fence native input **before** waiting on history drain. Later effect-free history may resume even after Stop under separate authority, never gameplay/provider authority. Application close permanently closes history admission and joins all producers/readers before Store. Failed drain stays unconfirmed.

Sources: [`history-reader.ts`](../../src/server/history-reader.ts), [`history-projection.ts`](../../src/server/history-projection.ts), [`history-projection-owner.ts`](../../src/server/history-projection-owner.ts), [`store.ts`](../../src/server/store.ts). See [operations](operations.md), [evidence](evidence.md), [recovery](recovery.md).
