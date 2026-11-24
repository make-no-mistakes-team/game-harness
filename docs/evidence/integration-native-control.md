# Integration evidence: native control and GUI

All conformance cohorts here used real licensed Fabric clients with
evaluator-authored controllers, **zero provider calls** and confirmed cleanup
unless an exception is stated. Prepared mechanics are not model-acquired
skills, human-equivalent gameplay, ordinary Survival success or full I01.

## Primitive and motor cohorts

The initial native proof delivered authentic world/hand/HUD through a hidden
GLFW window, with physical input blocked, movement, cancellation and cleanup.
Its cadence was 20.57 FPS against a 30 FPS target.
An alpha-zero PNG preview was black although RGB contained the real scene;
opaque-RGB correction fixed presentation, not world rendering.

The post-review `02e5c8bd…` cohort delivered 361 frames in 12.147 s:
29.719 FPS at 1280×720. Same-host capture-to-**backend** latency was
p50 4 ms / p95 22 ms / maximum 244 ms, not renderer latency.
Six yaw/position samples showed gradual turn/movement; cancellation settled.
GLFW key state changed while gameplay polling stayed false, with keyboard/mouse
block counters eight/three. An unauthenticated same-name login was challenged
without disturbing the owned player.
Pure Java proofs covered sound grouping/expiry, conservative occlusion,
damage attribution and emitted deadlines; review resolved six findings.
Neither review nor primitive proof established complete observation/navigation,
attack, dig/place/craft/equip progression or integrated active-game shutdown.

The `a119f9c1…` movement-receipt repeat delivered 365 frames in 12.205 s:
29.906 FPS, capture-to-backend p50 5 / p95 8 / maximum 135 ms.
Actual server before/after inventory confirmed the ordered receipt flag.
Missing receipt at the then-current three-second deadline yielded unknown,
reconnect and emitter closure; that teardown policy is historical.
A server-paused receipt-loss case became unknown 3,597.6 ms after pause,
without confirmation; this is not the deadline's exact start-to-end interval.
An earlier wrong-PID evaluator attempt failed and supplies no loss-proof credit.

Pure Java CameraMotion/NavigationGaze measurements on `f1f0848c…` settled
balanced 90° turns in 290/290/300 ms at deterministic 5/10/20 ms integration
steps plus a 100 ms hold. Speed/acceleration, wrap, monotonic-clock,
route and strafe predicates passed, not live FPS or end-to-end latency.

After evaluator cell-center/cancellation corrections, `06ff7983…` passed
16 live motor/item cases in 88.47 s.
Nine camera cases exercised 90°, 3° and wrap in three profiles:

| Profile | Native 90° duration | Host round trip |
| --- | --- | --- |
| precise | 484.910 ms | 567.85 ms |
| balanced | 334.929 ms | 418.79 ms |
| fast | 251.105 ms | 350.65 ms |

Five navigation cases reached range: flat, upstairs, downstairs, free gaze and
target gaze. Pitch followed sampled route geometry. The item boundary admitted
eligible front/behind-camera registry identities but excluded occluded,
out-of-range/invisible items and exact counts/NBT under that historical profile.
Cancellation retained unknown/missing-receipt effects while confirming the
neutralization barrier and healthy session/video. Cadence was 29.978 FPS.
These single-fixture samples are not controlled speedup or all-host guarantees.

## Ordinary input, 29 October 2026

The action-v2 cohort passed 24 cases with 24 complete recordings.
Nine camera cases covered the three motor profiles.
Other cases covered held digging versus entity clicks, counted clicks/misses,
main-hand PASS to offhand shield, bow draw/turn/release with server projectile,
completed/interrupted eating, bucket/boat fallback, hotbar/swap/drop,
simultaneous attack/use, cancellation and screen fencing.

A real drop exposed selection queued after vanilla slot synchronization:
client prediction showed seven dirt without matching server effects.
Applying selection at step entry fixed the repeat; server counts and
drop-all absence were independently confirmed. Explicit hotbar edges kept
ordinary vanilla ordering.
Owned-X11-window probes changed raw keys/callback counters but not game
polling, motion, view or attack/use. One authored drop stayed single with
physical Control held. The evaluator used xdotool/Python/libX11 without focus,
global input or pointer warping; ordinary operation needs no such helper.

All clips completed browser playback at 1× without media errors; selected
camera/bow/drop frames were inspected. Cancelled bow effects remained unknown
with use released. Opening inventory retained the visible screen and fenced
later world input rather than silently closing it or replaying steps.

## Persistent and complete GUI, 29 October 2026

The protocol-4/action3/visible-screen1/r8-GUI-v2 checkpoint retained the real
inventory across reads, no-input work and three pointer transfers.
It projected 46 slots and an empty cursor; four planks moved left-pickup,
right-place-one, then placement back to four. Three server receipts confirmed
conservation. Explicit close and independent server inventory agreed.
All 91 delivered frames were retained and the persistent screen inspected.
This smoke excluded chest/furnace progression and many choice/race cases;
action4 later changed that scope, without relabeling action3.

The action4 cohort passed all 18 declared cases with one effect writer.
Coverage: chest/cursor conservation; direct and recipe-book crafting;
32/33/64-event shift-craft receipts; conserved furnace top-up, nearby work and
three collected ingots; merchant paging/stale-row refusal; anvil text;
stonecutter, loom, enchanting and beacon controls.
A real isolated worker reached trusted goal completion without fixture-source
promotion. Conflicts, physical modifiers, Escape, resize, handler replacement,
delayed and lost/late acknowledgements also passed. Unknown effects stayed
unknown and were never replayed.
All 3,841 delivered frames appeared in 19 complete segments, each played at
1× without media errors. Resize separately retained 21 packets/PNGs across
1280×720 and 1024×640; no combined resize movie was fabricated.
Audio was absent. These are mechanical choices, not autonomous choice quality.

## Controller transport, 30 October 2026

Profile v4/frame-schema2 passed 11 Fabric cases.
Bow ownership survived turn updates and released a server projectile;
selection/drop retained six of seven items on the server.
A 16-operation GUI sequence applied input after 7,145 ms, followed by a
separate receipt retaining four planks; it was not a 150 ms gesture.
Corrections retained unknown FINISH receipts, drained the old driver before
retirement ACK, avoided duplicate motion credit, preserved partial presses
and removed a two-second truncation of lawful GUI.

A stopped native process kept retirement unresolved until resumption;
604 ms retirement exceeded the nominal 250 ms lease, and stale queued attack
received no credit. Non-reading TCP/full-queue/reserved-ACK proofs avoided
game-thread socket waits. The cohort retained all 962 frames without audio.
It also passed all 24 finite-input cases and a Runtime/Docker/SDK GUI/frame
check; 26 resulting replays played at 1× without media errors.
This is transport/input conformance, not a generated scheduler or 20 Hz benchmark.
