# Private geometry and disclosed movement

Generic GameHarness may use a trusted geometry-only projection for bounded local movement toward an authorized known goal. This assistance is separate from the model's observation/memory index and must stay fixed across comparisons.

## Information boundary

Local steering/detours toward the same goal can traverse unseen collision cells; an all-voxels-previously-observed map is not required. Projection contains only collision/passability/headroom. No hidden material/resource/structure/entity/container/seed semantics or resource scoring. Additional hazards/material facts require authorized observations.

Validate target/waypoint or model-chosen bounded direction/displacement before private lookup. Unknown-target probes reject first. Neither global loaded-world planner nor local controller may discover/select a hidden cave, entrance, corridor, shortcut or higher-level exploration route. Need such discovery: request observation/replan or return neutral bounded failure.

Cells must be loaded, center within radius eight of current feet and integer offset within `[-8,8]³` of floor feet. No eager prefetch outside an admitted plan. Bounds: 4,913 distinct cells, 8,192 counted visits including cached/repeated, 2,048 expanded nodes, 4,096 queue, ≥100-ms replan and 5-ms admission guard. Stop before exceeding, never return unchecked route.

Pin physics/controller revision; deterministic A* neighbor order x/y/z and open ties f/g/x/y/z. Invalidate changed goal/pose/envelope/read dependencies. No autonomous replanning without authorized active movement. Agent receives only actual permitted motion/coarse failure, never maps/path nodes/reachability/resource-dependent errors.

Conformance audits internal reads and effects, not just filtered path. Include known-goal unseen steering, same-geometry concealed ore/stone substitution, unknown-target rejection before lookup and hidden-route refusal. Fixture truth/audits stay private and are not gameplay experience.

## Native motion

Operator precise/balanced (default)/fast profiles persist and apply live. Balanced configured yaw/pitch caps are 480°/s and 300°/s with adaptive settling; this is not achieved-speed measurement. Semantic motor uses one render-monotonic simulation-progress integration clock, shortest yaw and bounded settling.

Semantic dig starts from actual pose with zero velocity toward block center, updating eye-origin angles while moving/jumping/landing. Entity aim uses admitted rendered witness. Gate is <3° each axis, not zero velocity: mining may begin before camera fully settles. Raw→semantic residual adjustment can be fast without proving teleport.

Targeted dig/place/attack/interact/table opening/composite interaction require actual vanilla crosshair match, refreshed before native dispatch. Packet uses real hit/face; synthetic visibility ray cannot substitute. Place requires chosen face. Dig loses progress while hit is lost until reacquired inside original deadline.

Navigate gaze defaults to bounded actual route sample plus eye height, or explicit current target/free orientation. Yaw gates movement, not pitch; legal strafing preserves travel under free/target gaze. Look and move.look remain explicit. Range 0.5–4 blocks is approach precision, not automatic pickup.

Arrival default position uses full three-dimensional feet-to-last-authorized-target distance. Block interaction arrival instead needs eye-to-center range plus native reach/line of sight; entity supports position only. Horizontal proximity is insufficient. Unless already arrived, initial feet distance is at most eight blocks and current distance at most ten; these differ from sampler integer offsets.

Stop local motor after 750 ms without a supported route or 1,500 ms without more than 0.1-block improvement in best remaining arrival gap. One camera-settle allowance of at most 750 ms cannot renew by circling. Duration exhaustion and unavailable explicit gaze are separate coarse failures. Release controls before bounded own-inventory completion receipt.

Timely same-target/scope receipt can settle partial navigation failed with confirmed failure outcome, never arrival or selected alternative. Missing/late receipt, target/life/scope loss or unresolved pickup remain unknown. Waiting never extends root.

Move success means requested input interval completed, not displacement/escape. Receipts distinguish cumulative travel from net/horizontal/height change, plus body ground/support/headroom/collision without materials/route. Purposeful authored travel/ascent must check settled positions in a bounded sequence, permitting detours but reobserving/changing/returning blocked after at most three ineffective bursts. Jump travel is not ascent; a completed jump does not keep the player airborne across later calls.

Dropped items collect by proximity. Interact refuses them before aim/screen-close/packet, with no world/camera effect. Navigate may confirm item disappearance within two blocks after movement only with selected-kind own inventory gain within 1,500 ms; disappearance/despawn alone remains unknown.

Actual movement releases at declared duration before ordered own-server receipt, bounded three seconds. Local prediction is not confirmation. Missing receipt remains unknown even after safe neutralization; only unconfirmable emitter safety requires client teardown.

See [input](input.md), [inventory](inventory.md), [perception](perception.md), [actions](actions.md). Sources: [`minecraft.ts`](../../src/shared/minecraft.ts), [native client](../../native/minecraft/src/client/java/io/gameharness/nativeclient/NativeClient.java).
