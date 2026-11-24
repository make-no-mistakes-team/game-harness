# Private evaluation storage and finite closure

This describes the separate evaluation/acceptance system, not ordinary-player
artifact authorization. Current coding-assistant permissions belong to
[development/model-runs.md](../development/model-runs.md). Historical retention
defaults grant no right to delete existing artifacts.

## Root and deletion boundaries

[`evaluationPaths`](../../src/evaluation/paths.ts) separates compact reports,
private runtime material and durable governance. Reports default to
`reports/evaluation`; runtime uses XDG cache and governance uses XDG state,
scoped by the checkout's canonical identity. Explicit function options override
`GAMEHARNESS_EVALUATION_REPORTS_ROOT`,
`GAMEHARNESS_EVALUATION_RUNTIME_ROOT` and
`GAMEHARNESS_EVALUATION_GOVERNANCE_ROOT`, which override defaults. All three
roots must be separate and non-nested. This does not change Electron storage
or `GAMEHARNESS_DATA_DIR`.

Worlds, JAR/JRE/libraries, client/session material and full private evidence
belong to runtime, not compact reports. Existing auth is opened in place, not
copied into bundles. Governance keeps attempts across report/output changes.
Compact reports/capped Store traces never substitute for full journal/capture.

Acceptance inventory tracks explicitly acquired bundles separately from
governance/payload roots. Existing reservation mechanics reserve **3 GiB** per
bundle plus **512 MiB** drain headroom and a **1 GiB** filesystem floor, with
nonoverlapping capacity checks every **5 seconds** in an owned subprocess,
outside gameplay's event loop. These are accounting bounds, not kernel disk
quotas or a new deletion grant. Refusal/error fences producers and joins cleanup;
protected occupancy is reported rather than removed.

Active/draining, manual-review-pinned and frozen/user-world evidence remains
protected. Unknown historical material may count toward occupancy without
becoming deletion-owned. Auth, governance and official game installation stay
outside payload deletion. Metadata accounting never requires opening credentials;
credential-shaped historical names are not permission to remove them. Separate
historical cleanup requires explicit authorization.

Where applicable policy permits expiry of owned closed bundles, cross-process
SQLite admission/expiry retains durable deletion intent and completion/failure/
cancellation. Outcomes, qualified/unknown usage and explicit expiry refs survive
payload removal. Expected expiry differs from missing/corrupt/incomplete capture.
Pins release only after their consumer no longer needs evidence. Public selected
exports require review; copied ignored files are not automatically sanitized.

## One original launcher deadline

Non-study acceptance starts its clock at task submission, **before** fixture or
auth preparation. One deadline covers preparation/discovery/startup/gameplay,
required final observation/verification, evidence/rendering/persistence and actual
cleanup. Reserve declared `caps.cleanupMs` inside total; stricter Stop/signals
still win. Early development preparation allows at most **300,000 ms**.

An explicit example, not a universal default, is **625,000 ms total**,
**240,000 ms gameplay**, **25,000 ms cleanup**, retaining **60,000 ms** after
maximum preparation/gameplay for verification/evidence/rendering. CLI accepts
`--total-ms`/`--run-ms`; cleanup is an API cap, **not** `--cleanup-ms`.

Evidence profiles cover the whole total window, prelude and drain. That example
requires recording duration at least **625,000 ms** and **18,751 frames** at
nominal 30 Hz including final-frame margin; a default 12,000-frame profile cannot
cover it. Supply a complete project-local profile through `evidenceProfile`/
`--evidence-profile`, not a partial override.

Expiry fences new model/resource admissions. Timed-out create/prepare/close
remains owned until the original operation settles; no abandoned owner or
replacement. Late actual closure stays separately recorded while bounded cleanup
remains unconfirmed and cannot produce pass. A signal during pending creation
tightens shutdown even after work expiry, preserves first interruption reason and
joins startup finalization through cleanup. Return can wait beyond the allowance
to join ownership, but cannot call that an in-budget success.

`finalization_within_budget` includes final metadata/database closure; an earlier
resource snapshot cannot certify later finalization. Publication keeps its
bundle draining/protected until final report joins, then closes it. Any eligible
rotation considers older bundles only. Registered studies keep original frozen
registration/reservation/deadline and interrupted histories.

## Development observation and request scope

Development takes evaluator observations before gameplay for independent baseline
and after closure for final verification/evidence. During gameplay it does not
poll to refresh actor geometry or stop on an evaluator verdict; production
Runtime/program/reaction reads and its registered verifier own that boundary.
Custom completion stays unverified. Standard scenarios and frozen studies keep
their separately declared evaluator polling.

Host-request caps gate **before transport**. The final admitted request keeps
response/tool authority; merely filling allocation does not stop it. Refusing
the next request triggers owned Runtime Stop and
`host_request_admission_bound_reached`; it is neither sent nor an empty planning
turn. Actual request/resource drain still applies.

Live study slots have private Store/programs, no global retrieval/promotion and
no actor access to hidden manifests/verifier/sibling data. Optional replication
is a preregistered whole block with immutable activation/decline; inactive slots
remain distinct from started outcomes. Unknown reservations retain allocation
after restart; final prepared-statement/database closure and actual drain remain
separate from usage/outcome settlement.
