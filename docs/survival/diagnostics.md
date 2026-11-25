# Survival diagnostics

Prepared trials test one mechanism under declared assistance. They do not
establish ordinary random-world resource finding or the combined
[Survival acceptance target](behavior.md).
Only one diagnostic owns the second lane at a time. A primary ordinary run can
continue beside it; `--parallel-world` competes for that second lane.
Diagnostic saves cannot become Survival parents.

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

## High-water development cases

| Command | Declared elevation difference |
| --- | ---: |
| `bun run play:agent --diagnostic-descent waterjump16 180` | 16 blocks |
| `bun run play:agent --diagnostic-descent waterjump24 180` | 24 blocks |
| `bun run play:agent --diagnostic-descent bucketdrop16 180` | 16 blocks |
| `bun run play:agent --diagnostic-descent bucketdrop24 180` | 24 blocks |

These zero-provider cases use controlled terrain and a named method-selection
override while retaining the normal player tick and physical controller.
They are labeled `mechanic-only-alternate-policy`, not ordinary campaign proof.
Each has a maximum 180-second allocation and cannot become a Survival parent.

The verifier joins native end-tick physics, actual inputs, health, water contact,
item-use/inventory transitions and saved statistics. Controller counters or
`LANDED` alone do not prove success. Bucket cases also require real safe reclaim.
Retain failed attempts and close all owned processes before reusing the lane.

Per-run JVM heap requests use `SURVIVAL_AGENT_{SERVER,CLIENT}_{XMS,XMX}_MIB`.
Initial values must not exceed maxima; defaults remain unchanged. Resolved
requests appear in `declaration.json` under `limits.jvmHeapsMiB`. Heap limits do
not replace host-memory admission, execution-slot ownership or hard scope caps.

## Ordinary-controller development cases

These cases prepare initial conditions before the first join, then use the
ordinary local player with zero provider calls and no method-selection override.
They do not establish the combined Survival target.

| Command suffix after `bun run play:agent` | Prepared condition and required outcome |
| --- | --- |
| `--diagnostic-combat unarmed` | Hostile contact, empty hands; survive effective counters or a sustained escape. |
| `--diagnostic-combat sword` | A carried sword, initially holding a pick; use the appropriate weapon and survive. |
| `--diagnostic-terrain food 120` | Injury, hunger and ripe bushes; harvest, collect, eat and naturally regain health. |
| `--diagnostic-terrain food-chicken 120` | Injury, hunger and normal chickens; hunt, collect, eat and naturally regain health. |
| `--diagnostic-terrain excavation-void 180` | Low health, funded tools and a concealed void below a rock cap; expose it without falling through. |
| `--diagnostic-terrain excavation-stair 180` | Low health and funded tools over rock; make two actual safe downward steps and collect the cut material. |

Combat records [flow geometry](perception.md#combat-flow-geometry) separately
from vision. Food and excavation checks join actual inputs, native physical
outcomes and saved vanilla statistics after clean shutdown. Prepared supplies
or a controller's acceptance counter alone are not completion evidence.

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
