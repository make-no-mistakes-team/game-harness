# Survival behavior and acceptance

The acceptance target is **diamonds and Nether entry in the same fresh Normal
Survival campaign**, with purposeful local activity independent of model
latency. The user-reported slow camera, roughly five-second pauses and awkward
target switches are observed failures to address, not doubts to dismiss with
passing fixtures. No retained integration result establishes this target.

## What must be visible in play

- Smooth turns with useful variation in speed and effort, rather than a fixed
  camera trajectory for every action.
- Reachable aim points away from exact block centers. Mining may begin before
  the camera fully settles when the actual crosshair already supports a safe
  strike on the intended block.
- Continuous travel across local targets and checked treads, without a full
  stop, complete camera reset or model request at every waypoint.
- Ordinary travel and exploration use useful arbitrary bearings. The block
  grid can constrain a cut or placement, not restrict the player's gaze to
  four directions.
- A healthy player can leave elevated foliage for a witnessed dry landing with
  modest survivable fall damage; searching forever for a damage-free route is
  not a safe or useful outcome.
- Threat response that interrupts work: flee, take cover or fight a visible
  reachable hostile as conditions require. Combat cannot wait for a model.
- Food seeking, eating and recovery when health/hunger require them.
  Returning from a bad save at low health must not blindly resume mining.
- Useful work while advice is pending. Necessary observation, furnace waiting
  and safety checks are allowed; empty motion is not purposeful activity.

Review the whole recording at 1× alongside movement, contact, look, pause and
provider receipts. A turn-speed sample, neutralized cancellation, visible
inventory action or diagnostic portal is not proof of this combined experience.

## Implemented local intentions

These are source-level behaviors and safety constraints, not a successful
fresh-campaign claim. The controllers are defined in the
[`survival` Java package](../../survival-agent/src/client/java/io/gameharness/survival/)
and the [advisory host](../../src/server/survival-macro/expedition.ts).

### Movement and camera

The local navigator keeps a destination across visible or previously walked
treads. A route can go sideways, briefly away, up or down; a blocked crossing
can trigger another local path toward the same destination. A reachable
vantage supplies a new view, not proof of arrival at the resource.
Short flat retraces can use backwards/sideways movement over freshly checked
treads instead of a full turn. A missed frame releases movement keys; it does
not by itself erase a checked one-block descent by the same player.

Ordinary look motion varies safe gestures while retaining bounded acceleration
and braking; urgent or precision contexts keep their protected steering.
Face selection and actual crosshair contact govern mining. These mechanisms
still require normal-speed footage review against the acceptance above.

Each new tread needs visible support and body clearance. Ordinary exploration
can descend one or two blocks to stable dry ground with no immediate threat,
with a usable pick or building blocks; that does not prove a climb back.
Unknown/unlit floors, lava and greater drops need another approach.
A placed step or connector needs fresh placement and inventory confirmation,
then a separate crossing check. Slips, changed terrain or a different landing
require a fresh footing check.

### Supplies, mining and workshops

Timber approach chooses a collectible stance, not merely swing reach.
Nearby low logs can supply handles and light before departure. The first pick
takes priority over optional tools. Canopy work can clear neighboring leaves
without removing support, inspect dry descent and avoid revisiting the same
failed collection spot. A healthy fed player may accept a visible dry descent
predicted to cost at most one heart only after safer wood approaches run out;
unclear footing or a threat vetoes it.

Stone work selects collectible faces. Uncollectible drops prompt a stance
change; andesite-like substitutes earn no cobblestone credit.
Repeated unproductive rock prospecting changes ground while the tool still
has uses. Shaft escape checks reachable side exits and headroom; gravel is
cleared from beside the column after falling material settles.
An outlined face can support a short dark egress check from real dry footing;
darkness, sound or an empty ray never proves safe ground or hidden ore.

The miner stocks light for return, reserves a torch when possible and checks
placed light plus its item debit before a crossing. It preserves two sticks
for the first iron pick when affordable, unless replacing the last usable
pick or lighting an unsafe passage takes precedence. A nearby reachable
crafting table can be reused after it is seen again.

### Furnace continuity

Already carried ore, fuel and a usable furnace permit smelting even if a
crafting ingredient is still missing. Different supported fuels and smaller
loads can avoid an unnecessary coal expedition.
One original input item may justify waiting at the furnace; the last item of
a larger batch is still part of that larger batch.
Longer cooks can overlap nearby useful work or watchful waiting. Threats win.

A paid batch stays associated with its actual furnace and walked route.
An old furnace must be reachable by rechecked treads; a flooded/broken route
can postpone collection. Output is not held inventory until actually taken.
A completed smelt proves neither a bucket craft nor a resource goal.

### Threats, water and food

Actual damage interrupts work, including in water. Sound can prompt a look
or search for a dry bank, but cannot authorize hitting an unseen mob.
A creeper escape needs horizontal progress and checked body clearance;
repeatedly jumping into a wall or blast knockback is not a retreat.
Outmatched melee calls for dry retreat; a blocked retreat can permit a strike
at a visible reachable hostile. An unarmed drowned below a dry worksite need
not be chased. A visible trident or actual hit changes the danger assessment.
Repeated ranged hits require checked escape/cover; one dodge is not safety.

Water escape rechecks connected older stairs rather than swimming blindly
up under a roof. One dry step beside a breach is not a new worksite.
After danger, hurt or hungry players suspend mining, eat suitable carried
food, pursue visible safe food, or scout reachable new ground.
Apples require actual drops; an audible chicken is only a reason to look.
Safe food takes priority over raw chicken or rotten flesh.
Pickup, eating and health recovery are separate outcomes.

## Evidence boundary

The actor receives player-observable evidence, not hidden blocks, seeds,
server state, admin commands or privileged evaluator records.
Final verification reads saved vanilla statistics only after closure.
A diamond win requires live inventory plus newly mined diamond ore and pickup.
Nether success requires construction, ignition and actual entry, not ten
obsidian or discovery of an existing portal.

Clean continuations retain campaign provenance but are not uninterrupted
fresh-attempt results. Prepared trials and model-authored GameHarness results
remain separately labeled in [integration evidence](../evidence/integration-gameplay.md).
