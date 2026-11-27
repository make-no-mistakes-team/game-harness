# Survival perception and terrain hypotheses

The Survival player does not receive hidden chunk maps, buried ore positions,
world seeds, or server-only state. It is also not framebuffer-only: the client
combines baked-geometry optical sight, short-range combat flow geometry, and
explicit local terrain hypotheses.

## What counts as observed

Outside active combat flow, [`Perception`](../../mod/src/client/java/io/gameharness/survival/Perception.java)
and [`AgentOpticalSight`](../../mod/src/client/java/io/gameharness/survival/AgentOpticalSight.java)
admit blocks and entities through current camera projection, range, light, and
ray visibility. A chunk loaded by Minecraft is not observed until the camera
actually sees it.

Optical sight inspects loaded baked block models and sprite alpha. Glass and
panes can transmit sight; leaf cutouts depend on the active texture and
graphics mode (`FAST` leaves stay opaque). Magnified cutouts sample texture
alpha conservatively, and unsupported models default to opaque. This is a fast
optical approximation, not GPU framebuffer reconstruction.

Visual sight, physical reach, collision, and vanilla item-use rays stay
separate:

- Seeing ore through glass or behind leaves does not allow striking through the
  barrier. Natural leaves blocking a targeted log may be cleared by hand while
  keeping the log objective.
- A visible face point is kept for aiming and revalidation instead of being
  replaced with the block center.
- Seeing a floor, lava pool, or water surface does not prove a traversable path
  or safe landing.
- [`CaveExplorer`](../../mod/src/client/java/io/gameharness/survival/CaveExplorer.java)
  records caves, ravines, and descending frontiers strictly from observed open
  space and exposed dark openings, never from unloaded or occluded cavities.

## Combat flow geometry

Confirmed hostile contact can activate a short-lived local geometry check
within four blocks of the player, including behind the camera. It reports
nearby floor, steps, walls, ceilings, and cliffs only up to the first solid
barrier; closed cavities beyond solid walls remain unknown.

Flow geometry exposes no block materials, ores, chests, dropped items, or
hidden mobs, and unidentified liquid cannot authorize a dry step. Its receipts
let `CombatPlanner` and `SurvivalReflexes` step back, block, or dodge without
waiting for a full camera turn. They expire when the encounter ends and never
populate the exploration map. Ambient sounds or fall damage alone cannot
activate combat flow; attacks, mining, and block placement still require normal
reach and contact checks.

## What counts as inferred

Ordinary digging and resource work may rely on explicit, qualitative local
hypotheses:

- Soil caps can conceal base rock when starting stone collection.
- Base rock continues around an active mine face or downward staircase.
- A visible tree trunk column may continue one block downward.

Hypotheses never reveal specific hidden ore, cave pockets, loot, or a
guaranteed safe floor. When a cut exposes air, water, lava, gravel, or a drop,
real physics and fresh observations immediately override the assumption and
trigger descent, retreat, or suffocation recovery.

World or life transitions clear prior spatial memory and hypotheses. Repeated
glances at the same unchanged block do not manufacture fresh authority.

## Keep outcomes separate

A predicted foothold is not a witnessed tread. A planned water clutch is not
wet contact. Controller intent, inventory changes, verified goal statistics,
and 1× visual inspection remain distinct evidence classes; see
[behavior](behavior.md).
