# Survival diagnostics

Prepared trials test one mechanism under declared assistance. They do not
establish ordinary random-world resource finding or the combined
[Survival acceptance target](behavior.md).
Only one diagnostic owns the second lane at a time; a parallel ordinary world
occupies the same capacity. Diagnostic saves cannot become Survival parents.

```sh
bun run watch:agent --diagnostic
```

The stream is `http://127.0.0.1:4382/`. The ordinary stream remains separate.
Inspect actual recording, receipts, outcome and clean shutdown.

## Prepared mechanisms

| Command | Scope and supplied assistance |
| --- | --- |
| `bun run diagnose:pool 600` | Portal casting in a prepared flat Normal Survival world; supplied bucket, tools, blocks and food. |
| `bun run play:agent --diagnostic-urgent-creeper --model PROVIDER/MODEL` | First-tick reaction to a real fuse with a model call outstanding; connected account, at most three requests in 120 seconds. |
| `bun run play:agent --diagnostic-urgent-craft` | Interrupt a real crafting drag, recover the cursor stack and escape unharmed; no model calls. |
| `bun run play:agent --diagnostic-descent water 180` | Supplied water bucket; place water during a fall and land without damage. |
| `bun run play:agent --diagnostic-descent boat 240` | Supplied boat and prepared ledge; place, board and descend to dry ground. |
| `bun run play:agent --diagnostic-descent cave 180` | Prepared lit chamber and connected descending shelves. |
| `bun run play:agent --diagnostic-terrain birch 180` | Prepared unreachable log and reachable alternative tree. |
| `bun run play:agent --diagnostic-terrain ceiling 180` | Prepared low ceiling and upper step. |
| `bun run play:agent --diagnostic-terrain wade-model 180 --model PROVIDER/MODEL` | Prepared shallow channel and diamond ore; supplied iron pick, at most one live model request. |
| `bun run play:agent --diagnostic-terrain brake-model 180 --model PROVIDER/MODEL` | Prepared approach to ore ending at a six-block-wide, twelve-block-deep gap; at most one live model request. |

The pool starts facing south on a dry stone bank, one dry block from a
7×6 one-block-deep pool containing 42 lava sources. Clock tick 1000 is set
before joining, then time advances normally. Starting hotbar: one water bucket,
flint and steel, stone pick, 64 cobblestone and eight cooked beef.
There is no initial diamond, obsidian, frame or mold.
At the four-block lava edge, two frame blocks cool in place; the other eight
are poured with the same bucket. The same agent must recover water, complete
all ten positions, light the frame and enter the Nether, corroborated by
vanilla statistics. This does not test mining supplies or finding lava.

`wade-model` requires actual grounded water contact, a new dry bank, a native
horizon order, ore break and diamond pickup, corroborated after clean closure.
It does not exercise a deep-water refusal in-game.
`brake-model` requires an accepted order, at least two blocks of grounded
approach, and a fresh motor danger/support report. Controls must remain neutral
on the near bank for at least 20 ticks, without damage, pickup or completion.
Timeout, early stop or going around the gap does not prove braking.
`brake_closed` is a diagnostic verdict, not a Survival win.
The verifier joins the sole order, motor journal, sampled movement and saved
statistics; it cannot measure movement between samples or qualify other terrain.

Both trials wait for matching safe idle approaches before spending their one
request. If no authorized stock order can follow the answer, they close as
`stockNotExercised`, without proof. Supplied tools, terrain and observation
conditions must remain attached to any result.

## Explicit constrained work orders

This mode gives the selected model individual work-order authority instead of ordinary
local advisory control. Use it deliberately:

```sh
bun run play:agent --strategy model --model PROVIDER/MODEL --control constrained --macro-requests 8 --skill-trials off --task 'Choose your next subgoal from what you can see.' diamond 360
```

Eight requests and 360 seconds are this example's finite allocation.
A custom task requires `--control constrained`;
it does not replace the selected vanilla goal verifier.
The desktop Survival form does not expose this free-form mode.

Constrained startup may spend one call while loading, with task/action
descriptions but no frame or inventory. Use `--startup off` before the goal to
wait for a live observation. A refused plan or failed startup can still consume
a request. Skill trials default off; `--skill-trials allow` explicitly opts
into the separate work-order/skill-study path and side worlds.

Keep [work-order safety and receipts](work-orders.md) attached to experiments.
The canonical option parser is
[`strategy-options.ts`](../../survival-agent/strategy-options.ts);
DTOs and validators, not copied documentation schemas, define exact fields.

## Reading stalls without manufacturing progress

The three-second planning deadline is a diagnostic target, not a footage
guarantee. Inspect `strategy.planningWait.longestPendingWithoutWorkMs`;
`rightCensored: true` means the final interval can extend beyond observation.
Provider timeout is separate. A camera receipt is an observation outcome,
not physical progress or a reset of the progress clock.
An idle deadline cannot choose a camera turn.

Use `outcome.json` → `pauseEvidence` and 1× recording to distinguish useful
work, necessary waiting, obstruction and idle time. Pending inference can
overlap any of them. An audible creeper fuse can interrupt either a request or
an inventory drag before the planning limit matters.
For ordinary save-copy diagnostics, use [incident replay](recovery.md#incident-replay-is-diagnostic).
