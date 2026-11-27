# Survival behavior and acceptance

The acceptance target is **diamonds and Nether entry in the same fresh Normal
Survival campaign**, with purposeful local play independent of model latency.
User-reported defects — slow camera movement, multi-second stalls, and erratic
target switching — are ground truth, never overridden by passing unit tests or
prepared fixtures. No retained run establishes this combined target yet.

The local Java mod owns movement, mining, crafting, combat, descent, cave
exploration, inventory management, and portal casting. A configured model
advises asynchronously on macro goals; ordinary play continues when advice is
delayed, absent, or exhausted.

## What must be visible in play

- Smooth turns with natural variation in speed and effort, not one identical
  camera trajectory for every gesture.
- Off-center reachable aim points. Mining may start before the camera fully
  settles when the live crosshair already hits the intended block safely.
- Continuous travel across visible or walked treads on arbitrary bearings,
  without stopping, re-zeroing aim, or calling a model at every waypoint.
- Stable target commitment rather than oscillating left and right across
  nearby blocks.
- Decisive canopy and ledge exits: leave elevated foliage for a witnessed dry
  landing (even with modest survivable fall damage) rather than wandering a
  treetop indefinitely.
- Excavation and descent under explicit local terrain hypotheses, updating
  immediately from real falls, lava exposure, collisions, or damage.
- Reflexive threat response that preempts chores: shield, fight, retreat, or
  seal an emergency shelter without waiting on a model reply.
- Food seeking, cooking, eating, and healing before resuming deep mining at low
  health.
- Useful local work while advice is pending or furnaces smelt. Legitimate waits
  need no fake fidgeting.

Judge full recordings at **1× speed** alongside movement, contact, look, pause,
and provider receipts.

## Local v2 execution contract

These rules govern the v2 mod in
[`mod/src/client/java/io/gameharness/survival/`](../../mod/src/client/java/io/gameharness/survival/)
and the asynchronous strategist in
[`src/strategist/strategist.ts`](../../src/strategist/strategist.ts). They
define required behavior, not a claim of campaign completion. See
[perception](perception.md) for observation and hypothesis limits.

### Movement, camera, and descent

`Pathfinder` and `RouteExecutor` plan 3D routes over witnessed or previously
walked treads, clearing headroom before lower cuts, rejecting bare-handed digs
on tool-required stone/sandstone, and cluster-blacklisting unreachable targets.
`Motor` varies ordinary turn velocity within bounded acceleration while keeping
gimbal-safe vertical aiming and protected steering for urgent reactions.

`SafeDescent` handles high drops, cliffs, and steep cave ledges through
multiple methods: water-bucket clutch or pour-and-descend, boat drops, carved
cliff stairs, and placed edge blocks, while refusing lava and unseen floors.
Water escape routes toward dry banks rather than swimming into steep shore
cliffs or under roofs.

### Mining, caves, crafting, and inventory

`CaveExplorer` tracks observed caves, ravines, and descending frontiers without
hidden chunk reads, retiring exhausted shallow pockets, breaking into deep
levels, and auto-crafting torches when lighting dark tunnels.

`TaskRunner`, `GuiHands`, and `AgentGuiPointer` run timber harvesting, stone
and ore mining, tool crafting (wooden, stone, iron, and diamond picks plus
shovels and axes), underground replacement stone pickaxes, and smelting with
organic cursor pacing. Multi-execution crafts clamp batches to one matching
ingredient stack to avoid mixed-species craft failures. Longer smelts overlap
nearby productive chores while tying paid furnace batches to their walked route
and actual item pickup.

`InventoryTriage` keeps hotbar and main inventory usable during long caving
runs by discarding low-value clutter while preserving tools, fuel, food,
torches, buckets, and ore.

### Combat, shelter, and food

`CombatPlanner` and `SurvivalReflexes` preempt ordinary tasks on hostile
sighting, actual damage, creeper fuse, or gravel suffocation. Responses include
shield blocking and advancing, creeper kiting or emergency block placement,
outmatched dry retreat, and building or burrowing into a sealed shelter when
cornered. Shelters reset cleanly on exit or respawn, preferring soft exits.

Hurt or hungry players suspend mining to eat carried safe food, hunt or forage
visible sources, cook raw meat, and recover health before returning underground.
Safe food outranks raw chicken and rotten flesh.

### Shore-cast Nether portal

`PortalCaster` builds and lights a ten-obsidian Nether portal directly beside a
surface or deep (`y = -54`) cave lava pool using a water bucket and cobblestone
supports — clearing raised rims and avoiding lava flooding — then enters the
ignited portal.

## Evidence boundary

The player relies on optical sight, [combat-flow geometry](perception.md#combat-flow-geometry),
and local hypotheses — never hidden block queries, world seeds, or server
cheats. Goal verification reads saved vanilla statistics after clean server
closure:

- `diamond`: live inventory plus newly mined diamond ore and diamond pickup.
- `diamond_pickaxe`: crafted and carried pickaxe backed by diamond provenance
  (fresh or valid continuation chain).
- `nether_portal`: constructed, lit, and entered portal, not ten obsidian or a
  found ruined portal.

Clean continuations record campaign provenance but are not fresh-world wins.
Prepared diagnostics and historical outcomes stay separated in
[diagnostics](diagnostics.md) and [Survival evidence](../evidence/survival.md).
