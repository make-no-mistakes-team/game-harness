# Survival perception and terrain hypotheses

This page describes the ordinary native Survival player. The separate general
harness has its own [adapter perception profile](../reference/perception.md).
Neither should be described as framebuffer-only play.

## What counts as observed

Outside combat flow, the client admits geometry through current camera
projection, range, light and ray visibility. Loaded world data is not a map available to the planner.
Knowing that a chunk contains a block does not make that block observed.

Optical sight uses loaded baked geometry and sprite alpha. Glass and panes can
transmit sight; leaf gaps depend on the actual texture and graphics mode.
FAST leaves remain opaque. Near magnified cutouts use the applicable texture
sampling; uncertain animation/filtering and unsupported models are treated
conservatively. This is an assisted optical approximation, not an exact GPU
framebuffer reconstruction.

Physical contact, collision, placement and vanilla item-use rays remain
separate. Seeing ore through glass does not permit striking through the glass.
Seeing ground or water does not establish a traversable route or safe arrival.

A visible face point does not imply a visible block center. Keep the admitted
point for gaze and revalidation rather than silently replacing it with the
center. Tool work follows the actual physical first hit: a permitted natural
leaf mask can be cleared while retaining the observed log goal. Removing
occupied support requires an explicit descent action, not a generic mining
exception.

The implementation is in
[`AgentOpticalSight`](../../survival-agent/src/client/java/io/gameharness/survival/AgentOpticalSight.java)
and [`AgentBody`](../../survival-agent/src/client/java/io/gameharness/survival/AgentBody.java).

## Combat flow geometry

Confirmed hostile contact may enable a short-lived native geometry sensor
within four blocks, including behind the player. It exposes nearby floor,
steps, walls, ceiling and cliffs only up to the first solid barrier.
Closed cavities beyond that barrier stay unknown. Block materials, resources,
containers, items and hidden mobs are not supplied; unidentified liquid
volumes cannot authorize a dry tread.

Flow geometry is not a visual observation. Its fresh, world/player/life-bound
receipts may support reflexive movement without turning the camera first.
They expire with the encounter and do not populate the ordinary exploration
map. Actually traversed contacts remain the player's own experience.
Ambient sounds or fall damage alone cannot activate flow. Attacks, mining
and placement still require their normal current contact, reach and effect
checks.

## What counts as inferred

Ordinary excavation can assume that nearby base rock continues; trunk work can
assume a further log below an observed column. An initial prospect can expect
base rock beneath soil without claiming to have seen it. Those are explicit,
local, qualitative hypotheses. They do not reveal a specific hidden ore, its
location, loot, a guaranteed floor or a return route.

The belief model consumes admitted observations and actual action/physics
outcomes. It cannot query hidden terrain to check whether its guess is right.
An action may proceed under uncertainty. Newly exposed material, falls,
collisions or fluids can disprove its premise and require another course.

Repeated views of the same source do not create unlimited new authority.
Actual new observations may support another local action. World/life changes
invalidate old hypotheses; contradictory local experience cannot silently
become a fresh permit.

See [`AgentTerrainBeliefs`](../../survival-agent/src/client/java/io/gameharness/survival/AgentTerrainBeliefs.java)
for the bounded model and the [behavior contract](behavior.md) for accepted
risk and purposeful-play requirements.

## Keep outcomes separate

A predicted support is not an observed support. A forecast water entry is not
water contact. Actual arrival does not retroactively prove unseen material.
Controller claims, inventory gain, verified goal completion and human judgment
of movement quality remain different evidence.
