# Retired adapter and visibility research

Historical source inspection on **20 October 2026** used Mineflayer
[`7b4bb8d2b56be9cdb832474af873acd37e609746`][mineflayer] and pathfinder
[`d773d15ff1bb271090122b3c7106a519a68bbbd9`][pathfinder]. It ran no game tests.
Mineflayer and prismarine-viewer belonged to the retired spike. Their 1.21.4/
first-person claims are not selected native support, compatibility obligations
or fallback. Old-adapter fixtures likewise do not certify Fabric.

## Why loaded state is not player visibility

`blockAt` calls raw `world.getBlock`; loaded blocks need no visibility check,
and `extraInfos:false` adds none. `findBlocks/findBlock` search loaded section
palettes/types/predicates, sort by distance and truncate without occlusion.
Filtering after a count-capped raw search can let concealed results displace
authorized ones. Actor queries must use the authorized index; raw counts/order/
truncation stay private.

The entity index and nearest-entity lookup expose client-tracked entries.
Movement packet handlers update exact positions without line-of-sight checks.
Server packet availability is not ordinary-player observability.

`canSeeBlock` casts **one** shape ray from position +eye height toward target
center `(0.5,0.5,0.5)`, but range is eye-to-**origin**, not eye-to-center. It stops
on a shape intersection or target coordinate; target fallback need not hit its
own shape. Returned coordinate must match, and no raycast can yield a falsy
value rather than Boolean false. No camera check or independent radius cap.
This is not all-face, rendered-transparency or entity visibility. Partial shapes,
obstructions and boundary distances need fixtures; raw type search plus this
helper is not an observation gate.

Stock pathfinder defaults `searchRadius:-1`, reads raw blocks and can build an
entity-collision index; movement reads block semantics/exact entities. Disabling
digging/hiding returned paths does not constrain inputs. Even a search cap alone
does not prove compliance. Reuse needs constrained data paths/auxiliary reads and
local execution envelope or replacement.

The native permission permits bounded private **geometry only**, local detours
toward an authorized known goal, not hidden material/entity lookup or global
undiscovered route selection. See [perception](../reference/perception.md).

## Paper Anti-Xray source limits

Current [reference][paper-reference] defaults `enabled:false`.
The [guide][paper-guide] describes mode 1 dimension-appropriate replacement,
mode 2 random hidden-list replacements and mode 3 chunk-layer randomization.
Defaults/per-world overrides, effective lists/heights/lava/update radius/bypass
permissions affect coverage. Interaction updates can reveal real blocks;
exposed ores/list/height gaps and bypass permissions remain caveats.
Changes require restart. False ores are not discoveries.

This block obfuscation is not entity filtering or complete hidden-channel
protection. Native filtering must work with it disabled. Unversioned docs prove
no selected 1.21.4 build behavior; retain exact server flavor/build and effective
per-world/dimension snapshot/hash privately, fixed across matched runs. No Paper
server was configured/tested in this source investigation.

[mineflayer]: https://github.com/PrismarineJS/mineflayer/tree/7b4bb8d2b56be9cdb832474af873acd37e609746
[pathfinder]: https://github.com/PrismarineJS/mineflayer-pathfinder/tree/d773d15ff1bb271090122b3c7106a519a68bbbd9
[paper-guide]: https://docs.papermc.io/paper/anti-xray/
[paper-reference]: https://docs.papermc.io/paper/reference/world-configuration/#anticheat_anti_xray
