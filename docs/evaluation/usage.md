# Usage and cost-to-result

Host logical admissions, SDK usage messages and actual wire attempts are
different populations. Wire-attempt counts remain unknown when the transport
does not expose them. Retain provider/model/available request IDs and reported
uncached input, cache read/write and output separately. Missing is not zero;
subscription access is not free inference.

[Result classification](../../src/evaluation/results.ts) and
[provider evidence](../../src/server/provider-usage.ts) own current fields.
New `UsageMetrics` use schema 2 and
`consumption_scope:"observed_logical_admissions"`.

| View | Meaning |
| --- | --- |
| Event coverage | Every admitted request has its accounting event, without a relevant omitted event page; not full consumption proof |
| Consumption coverage | Known, partial or unknown justification for the four qualified category totals |
| Reported subtotal | Valid observed SDK/provider contributions; earlier contributions survive later missing/invalid data |
| Qualified category total | Null if any included contribution is unproven; never substitute its subtotal for null |

Positive proof comes from supported terminal metadata bound to the exact host
invocation, or Jev's real response-usage envelope. An ID, normal stop reason or
truthy SDK usage object is insufficient. Missing/contradictory categories remain
unknown; supported contracts alone may justify not-applicable zero. Terminal
counters can survive abort/unsettled finalization without inventing a successful
provider outcome or SDK message. Thus event coverage can be incomplete while
consumption is known. Abandoned unaccounted responses or observation bounds can
prevent full consumption claims. Zero admissions have known logical zero
without a fabricated provider event; subscription money remains unknown.

An aborted SDK message with zero counters and no terminal proof does not
establish zero consumption. Preserve original labels/subtotals and qualify
uncertainty. Historical `coverage:"complete"` means legacy event coverage only.
Version-aware readers expose the old subtotal with unknown full consumption;
never rewrite original reports, measurements or settled rows.

Post-hoc qualification is a separate private exclusive-create artifact binding
attempt/report identity, report SHA-256 and reasons. It authorizes neither a new
platform-evidence revision nor another attempt.

## Aggregates and prices

`costToResult` includes all preceding unsuccessful attempts through first
verified success, propagates unknown categories and preserves subtotals. A later
win does not erase an unknown failed attempt.

`study_usage` instead includes **every reserved outcome**, including failures or
unknowns after success and scheduled/inactive dispositions. It has no
first-success cutoff and infers neither wire attempts nor subscription money.

Catalogue estimates need qualified counters, source/date and model descriptor.
An unproven category or missing rate leaves the estimate unknown. Catalogue
all-zero placeholder rates are not proof of free usage; `calculateCost` can
produce numerical zero from unknown rates. Estimates are not invoices.

Select models on evidence needed and cost-to-result, not token price alone.
Compact source, selective retrieval, cache hits or a lower token rate establish
no total latency/token/cost improvement without matched useful-task outcomes.
Separate provisional admission purpose from final host-role/visible-tool
classification; no accounting-only model request or hidden-reasoning inference.
Reliability limits/deadlines/rate caps do not establish spending limits.
