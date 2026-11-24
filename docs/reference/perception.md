# Authorized perception

An observation is filtered evidence, not permission to query raw game state. Core requires only versioned envelope plus adapter-owned data. Omitted/expired/unobserved records mean unknown, never absence without authorized completeness evidence.

## Current Minecraft profile

Active `minecraft_assisted_rgb_fov_r8_control_v8`, version 8, binds observation envelope 3, payload `minecraft_observation_v1@2`, frame 3 and actual motor/view configuration. Bounds: radius eight, 144 terrain rows, 32 entity rows, 128 considered entity candidates; GUI 128 slots/64 elements/32 progress entries; inventory 64 entries.

Terrain remains camera-independent assisted line of sight. Controller acquisitions occur at 500-ms cadence, with 1,000-ms stale threshold; retained rows keep original time. Faster body/camera/sound feedback does not trigger/refresh geometry. Explicit Runtime observations may acquire fresh state/seed cache. Assisted effects keep their own geometry custody; scope invalidates cache.

Entities require actual captured camera projection **and renderer witness in the same completed framebuffer**. Retain original render tick/time/invocation/capture and interpolated geometry. Missing/foreign/older-than-250-ms evidence denies access. Pending/skipped readbacks do not refresh; next completed capture replaces even with empty turned-away view. Crosshair, observations and semantic handles use the same gate; denied crosshair becomes miss without kind/hit leakage.

Camera FOV/aspect/zoom are captured facts. Open water/bubbles may pass optical checks; waterlogged solids/lava/opaque/unloaded cells do not. Denied candidate counts stay private. Geometry/render witness is structured assistance, not exact pixel recognition or human-equivalent perception.

Normal own position/status/inventory/UI, public recipes/docs and legitimate world-local memory are permitted. ItemEntity item name is registry kind of an eligible visible nonempty stack, never count/NBT/lore/hidden identity. Historical r2 introduced this projection without frustum gating; retain its original condition, not current-profile label.

Raw world/chunk/entity collections, renderer buffers, seeds/saves/hidden resources/structures and evaluator state are unavailable through every prompt/program/tool/log/error/retrieval/library route. Own blocking/durability and 32-entry attack-mechanics ring are separate feedback, not hidden entity state.

## Reads and evidence

`game.observe()` is authorized structured state; Main's observation also selects an unsynchronized actor PNG. `game.frame(audio_cursor)` is local body/crosshair/visible GUI/heard feedback **without server inventory receipt**. Its inventory is client prediction, not goal possession. Components are not atomic; inventory has its own timestamp.

Frame render metadata names actual GHV2 capture/original pose, not current pixels. Wrong-scope/unavailable/older-than-five-second render data is null. Capture counter is unsigned 32-bit including zero/wrap; native nanoseconds stay signed decimal strings and camera yaw may be unwrapped.

Controller screen identity must match delivery authority; starting screen is not a read precondition. A superseded frame is discarded without VM/audio/lease advancement. Ordinary health/inventory reads have independent nonce/generation/session/player/world/life/space/profile custody; retiring an effect owner does not invalidate otherwise unchanged read scope. Stop still rejects pending reads.

Filter **before** counts, order, cursors, pagination, truncation and errors. Searches use authorized index, not raw type-specific top-k discovery followed by filtering. Old handles/memory do not grant live target access. Remembered entities retain last-authorized position/time/uncertainty, never raw concealed tracking.

Observation rejection diagnostics identify bounded first fence and correlated timing without another native echo read, raw snapshot or targets. Delivered fresh structured observations can enter ordinary Runtime evidence/verifier path without an echo; duplicate/older sequences do not create freshness.

## Actually heard sound

Only actual audible delivery may enter sound feedback. Require tagged positioned nonrelative Source.play completion, finite positive source/listener gains, attenuation cutoff and ≤32-block distance. Delayed callbacks retain original scope. Subtitle presence/raw entity state cannot synthesize hearing.

Whitelist projects movement, interaction, combat, creature and weather. Specific approved cues include creeper priming/explosion, mob hurt/death, shield/item-break/player-attack; generic is null. Drowned ambient/underwater/swim is generic creature without species/handle/coordinates. Explosion never proves source, death, kill credit, damage or safety.

Distance bins: near [0,8), mid [8,16), far [16,32]. Eight world-relative compass sectors use clockwise ties; north −Z/east +X. Horizontal distance <1 is here, without vertical direction. No raw ID, exact coordinates, identity, volume/pitch or hidden HP/fuse.

Scope ring retains 128 coarsened events/1,000 ms. Independent cursors return eight/read with expiry/overflow gaps; reads neither drain nor freshen. Ordinary groups keep latest original heard time by category/cue/direction/bin; cue groups precede generic under eight-group cap. Scope change clears queued playback/events.

Static vanilla 1.21.4 creeper mechanics are reference facts, not sensed AI: ordinary non-manual swelling may begin below three blocks; ignition goal decreases progress beyond seven blocks or lost sight, not instant reset; hiss starts when positive progress rises from zero, so a resumed partial fuse need not hiss. No live fuse estimate or chosen safety margin follows.

Native proof launch defaults silent OpenAL null output with engine/gains active. Explicit native audio setting selects silent/audible; it does not mute other apps. Heard-event schema is not recorded audio.

Sources: [`minecraft.ts`](../../src/shared/minecraft.ts), [`observations.ts`](../../src/shared/observations.ts), [`controller.ts`](../../src/shared/controller.ts). See [capture](capture.md), [future sampler](perception-sampler.md), [navigation](navigation.md).
