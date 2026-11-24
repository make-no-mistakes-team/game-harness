# Programs and immutable source

This is the experimental GameHarness program workspace, not the primary Java Survival player's policy API. [`programs.ts`](../../src/shared/programs.ts) owns executable types; [`program-interface.ts`](../../src/server/program-interface.ts) and generated [`program-help.ts`](../../src/server/program-help.ts) own tool inputs/help. Dotted conceptual names in product requirements are not callable aliases.

## Formats and defaults

| Entry | Current format |
| --- | --- |
| `run` | Async body with host-bound `game,args`; no function wrapper, imports or exports |
| `step` | Synchronous module exporting `step(frame,state,intent)`; executive mode also requires `activate` |
| `analyze` | Pure synchronous module exporting `analyze(input)` |
| `library` | Pure static module, incapable of playing |

**Ordinary `program_write` requires explicit entry, including revisions.** Source-only disconnected preparation defaults its write to step. `program_submit`, playing start and `prepare_next` retain their run default. Historical records without an entry remain historical; execution never guesses a format.

Original and canonical source each fit 16,384 UTF-8 bytes. Comments/helpers are allowed. Line count, nesting and complexity are descriptive, not admission limits. Syntax/body/ambient-access checks do not establish type safety, isolation or gameplay efficacy.

Pure roots import explicitly declared immutable aliases such as `./helper.js`; libraries import libraries, analyze can additionally import a validated step, and a step can separately declare finite run children. Step-to-step and library-to-step imports are invalid. No packages, absolute/parent/dynamic imports, `import.meta` or ambient host access.

The acyclic closure fits 32 modules, depth eight, 64 KiB canonical source and a 256 KiB initialization frame. One exact module has one instance in one watched realm; local pure calls share it. Execution hash binds source, aliases and topology; import-free roots retain their existing identity. New library revisions cannot alter pinned roots. Pure lexical binding checks reject undeclared access before publication, except direct `typeof missing`; this is not type or temporal-dead-zone verification.

## Author, inspect and execute

`program_write` saves inactive source. A new name omits `based_on`; existing names require the latest stored version, even unexecuted. Checks occur before validation and commit; no silent rebase.

`program_edit` applies 1–16 sequential exact replacements to canonical parent text. Each nonempty old text must occur exactly once, including overlaps. Any failure rejects the whole edit. Entry/card persist; omitted dependencies retain exact pins, a supplied list replaces all pins and `[]` removes them. Source and graph validate atomically.

`card.reason` is inert motivation. Omitted card fields use unspecified/untested host metadata, never supplied tactics or efficacy. Top-level `reason` links a candidate experiment to actual feedback for that exact direct parent; missing feedback refuses before writing/starting. Ordinary revisions to unexecuted source omit it. Writing grants no efficacy, review or activation.

`program_submit` persists one version then attempts its exact start. JSON args are required (`null` when unused); step args are intent, with initial state default null. Persistence and started/refused/unknown start are separate outcomes. Refused start keeps source; unknown start must be inspected, never resubmitted as new work. Durable replay preserves original source/execution rather than selecting newer latest.

Selectors resolve latest validated once or honor exact version. Catalog paging shows latest stored families; exact source/execution/history never rebinds. Review without a version selects latest matching outcome, not unexecuted source. Prior keep/insufficient-evidence assessment is immutable but does not block repair.

Source validation runs in a credential-free child: four active jobs, no queue/fallback, five-second startup/validation ceiling clipped to caller deadline. Cancellation joins process/pipes. Only exact bounded dependency artifacts cross its read protocol; scope/profile/bytes are rechecked at publication and transaction commit. Crash/rejection publishes no version.

Entry rejection can retain bounded contract/export/signature facts (at most eight names of 80 characters), never guess imported/reassigned signatures or choose another format. Parser hints classify known reserved-keyword/duplicate/unexpected-token failures using fixed categories and source location, not raw parser text/identifiers/literals/host stacks. Unknown parse failures remain generic. Rejection does not save, repair or retry source.

Immutable artifact publication verifies or writes/syncs/renames/syncs bytes before SQLite registry/receipt commit. Inputs are detached first. Revoked calls cannot publish; an unreferenced durable file may remain. Source-only work cannot acquire a producer.

## Execution budgets and results

Async defaults: 120,000 ms, 64 actions, 256 calls, depth eight. Hard maxima: 600,000 ms, 512 actions, 2,048 calls, depth eight. Exact children share root consumption/deadline; one worker has one outstanding capability. Parents hold no leaf lease. Only trusted bounded capability waits suspend runnable-computation timing; worker heartbeats cannot renew authority.

Omitted/empty limits select defaults; valid partial actor inputs override supplied fields. Effective limits are complete and strict. Unknown/invalid values reject, never clamp. Optional `assertProgramStart` checks every initial, replacement, prepared or ordinary admission before incumbent retirement; replay receipts grant no new admission.

A configured `playingAuthorityCeilings` is a complete finite resident/session envelope, validated and detached before owners exist. All starts must be step+session within its exact enum/numeric limits. It discloses authority in Main/help, does not clamp or renew it, and is additional to the callback guard. See [`playing-authority.ts`](../../src/server/playing-authority.ts).

Async paths return completed/blocked/failed, 1–2,000-character summary and compact result (`null` when unused). Entire output plus envelope/newline fits 65,536 UTF-8 bytes and depth 32. Raw observations/receipts stay in host evidence; do not return arrays or invent IDs. Typed terminal encoding failures distinguish byte/depth/serialization from source exceptions and preserve applied effects. Invalid transported result has its separate classification and bounded rejected data; neither permits replay.

Aggregate action/call exhaustion records exact shared counts, rejects without additional charge, revokes the tree and joins drain. Generated catches cannot restore authority or turn exhaustion into completion.

## Game API

Generated help supplies exact native positional bindings and action schemas. `game.call` resolves only the parent's declared pinned run closure; native reads need no authored dependency. `game.progress` records notes; `game.attention` requests a serialized decision while local work continues and consumes existing call bounds.

`game.actionAndObserve` performs one ordinary action and a fresh observation only after success or a neutralized failure with explicit `world_effect_emitted:false` or `failure_outcome_confirmed:true`, without reconnect. Confirmed failure can retain attempted input/partial effects. Unknown/cancelled cases return no observation and retain fences. Observation/validation/scope failures propagate without stale fallback. Both calls consume existing budgets. It never retries or supplies strategy; adopt fresh state and check the postcondition.

Names for Minecraft items are registry paths (`oak_log`), not namespaced display labels. Inventory uses name/display_name/count/slot. Recipes use `game.recipes(item)`; the retired inspection view is not an alias. Exact output kind and recipe executions are distinct from output quantity.

See [handoff](handoff.md), [executive](executive.md), [scheduler](scheduler.md), [security](security.md) and [evidence](evidence.md).
