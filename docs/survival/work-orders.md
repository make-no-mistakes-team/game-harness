# Constrained work-order invariants

Read this with [diagnostic admission](diagnostics.md#explicit-constrained-work-orders).
These permissions belong to the experimental work-order controller.
Ordinary advisory play does not wait for model grants to pursue its built-in
goal. Exact fields and supported effects are owned by the
[`protocol`](../../src/server/survival-macro/protocol.ts) and
[`controller`](../../src/server/survival-macro/controller.ts).

## Authority and budgets

An order needs current physical evidence, exact permitted effects, material
costs, stock floors, finite action caps and expiry. Advice never expands those
grants. Ambiguous plans authorize nothing; unsupported break effects reject
the whole policy. A starting reserve must already be held; the host does not
lower it for the model. One corrected proposal can be allowed on the same
evidence after a reserve refusal.

An opening can offer alternatives and up to three jobs, but only one
observed branch starts. Host preflight checks source and footing.
Actual carried ingredients can satisfy a later recipe without gathering more;
preexisting stock earns no harvest credit. Every handoff checks the previous
receipt and current stock. Consecutive personal recipes can share the same
owned inventory; a world step closes it.
While the model thinks, an already authorized job may continue. Exhausting requests
neither enlarges that job nor extends Minecraft's attempt.

`renew-work` binds the exact accepted job and later bounded expiry while
retaining its action and spent budget. It cannot extend a paid furnace batch
or bucket fill. `afterWorkId` gates a different objective on predecessor
completion; it is not a substitute for already satisfied stock.

## Fresh views and bounded handoffs

A priced opening read needs accepted/completed camera receipts followed by
the first later safe view containing genuinely new matching physical evidence.
The issued job stays bound to its observed log, landing, lane or opening;
another trunk cannot substitute for an exact target. A camera change alone
does not prove a route. An unchanged stance earns no repeated bare survey,
though a genuinely new face/lane can be inspected.

If a travel target disappears before issue, the host can hold the unissued
job for at most 10 ticks or 600 ms, whichever is first. It must reappear from
the same safe stance. If input capture loses the target before provider
dispatch, one recapture may occur within five seconds and 100 ticks; both
attempts count against the request limit. Dispatched requests get no such retry.
Lost inspections can permit one fresh decision when matching/new usable
evidence appears; stale reads and old jobs are not replayed.

The first observation needs a settled first-person render. An upward ceiling
view with no work can offer one forward look at unchanged bearing; the model must
choose it. A fixed survey's missing render cannot reset aim or extend expiry.
Completion needs a new rendered frame at the requested angle, then camera
release before publishing the next observation.

A model-nominated image region requires image and camera geometry captured
together. It requests surface identification, not motion, contact or route
authority. Late answers cannot extend read deadlines. A genuinely new bound
image can permit one new nomination after a failed physical start.
A separate scouting grant may authorize at most three checked legs and six
blocks, rechecking surface, support and stopping distance throughout.

## Ground and resource evidence

Visible frontiers and canopy are travel hints, not ore, logs, species or stock.
Travel needs visible support through stopping distance, not a round trip to
every waypoint. Lower landings need actual clearance and no predicted fall
damage; a top-of-support stance shift cannot step off the edge.
A one-block climb needs exact landing and jump clearance.

Prospecting can begin at a visible exact soil cap or dry side wall without
claiming buried ore. A cap grant permits one break, no descent. Tool/cover
permissions, return allowance and physical condition bound further cuts.
Keep one break for the resource and enough usable tool to mine an exposed
diamond afterward. A spare slower pick may protect the only iron pick.
Last-use ore mining requires explicit tool-loss/reserve permission.

Each new landing needs dry lit support, body clearance and the required
reverse climb. An exposed floor is checked separately from its cover break.
Above Y=16 a proved natural descent takes priority. A fresh ray may check the
same previously observed lit wall face; memory alone never authorizes mining.
Exact leaf clearance shares the break cap, cannot remove support/return
foliage and earns no wood credit. A reachable log or usable lane wins.

Torch and cobblestone placements need their own cost/reserve/placement caps.
Cobblestone also needs witnessed empty dry space, reachable attachment and
clear forward/reverse space; fluid can veto it. Stay on original footing until
the placed top and matching inventory debit are observed. Placement, crossing,
lowest footing and stock gain are distinct receipts.
A new funded job can revisit a budget refusal, not erase an unsafe-ground veto.

Pickup needs actual inventory gain, not crosshair tracking. A falling nearby
drop can be collected while looking elsewhere; a lower drop needs checked dry
landing and return. Shallow wading needs a supported bed and dry bank checked
throughout; a stale frame permits coasting, not another forward input.
Lost bank/current safety hands control to water recovery. Deep/swift water,
lava, unknown drops and jumps are outside that crossing grant.

## Furnace and bucket custody

Raw-iron smelting needs exact stock/fuel pricing and protected floors.
Two raw iron cost two oak planks, four sticks, or one coal/charcoal in a cold
furnace. An existing furnace must first be opened and checked empty/cold.
Crafting/placing furnace or table needs separate effects, costs and caps.
Craft count includes recipe executions and smelted units, spent before pickup.
Loading, burning and collection are separate; completion needs matching receipt
and live ingots. One original input permits waiting; a longer batch can fund
separate useful work through `duringWaitFor`. Threats always preempt.

Paid furnace identity, walked route and protected stock may survive clean
continuation, never an executable command. Recheck each remembered tread;
broken/flooded return postpones pickup. Cooking completion does not interrupt
another job or place ingots in inventory. A dependent bucket craft still needs
collected ingots, fresh stock checks and its own craft permission.
Startup plans, presets, generated skills, direct opportunities and work
programs cannot authorize furnace transfers.

Water fill is a separate live model job: one water bucket, only
`fill:minecraft:water`, one empty bucket above reserve and zero break/craft/place
caps. Require an exposed lit source in reach from dry footing, main-hand bucket
and empty offhand. Recheck that source before one use; completion requires
vanilla acceptance and the exact empty-to-water-bucket inventory change.
Flow-only clues grant nothing. Other startup/program/opportunity/skill paths
cannot grant filling; pouring, lava collection and portal casting are excluded.

## Survival overrides and authored code

Actual hits or a creeper fuse preempt work/planning; ambient sound alone cannot
authorize attacking an unseen mob or prolong an emergency.
Foraging requires a visible source; hunting also needs an adult animal and
usable axe. Arrival, food pickup, eating and healing remain separate.
Stock protections still apply to shields/tools during emergency work.

Model-authored inspection functions require isolated Docker validation,
separate-world testing and explicit selection of the tested version against
current evidence before moving a camera. That grant covers no walking,
crafting or client modification. Private client patches require human review;
the runner never builds or applies them.
