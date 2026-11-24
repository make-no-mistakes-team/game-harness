# Authored view motion

Raw world clips and resident snapshots share one view actuator. The model chooses target and trajectory; native interpolation does not turn a full-error delta into gradual motion.

## Units and integration

Delta is relative radians applied once at snapshot/step entry, never divided across duration. Rate is radians/second. Each admitted actual simulation tick owns at most rate×0.05; monotone vanilla render-tick fraction distributes that budget across mouse samples. More render callbacks do not create ticks or extra angle.

An authorized remainder may settle at next real tick boundary before crosshair/input. Stop, lease expiry, screen/scope change or retirement discards remainder without late completion. Unadvanced/paused simulation supplies no new rotation.

Nonzero-rate stream ACK records settled interval at next boundary using actual pose/time. Finite final rate has same settlement, while keys release at original final consumed tick. Interrupted fraction is not confirmed application.

A clip runs rate for declared ticks then next step/release. A stream **retains rate after ACK** until replacement view, screen transition, retirement or expiry. Neutral held keys alone do not stop it. Submit unchanged or zero rate; unchanged replaces prior rate without restoring pose.

Capture age of 150 ms gates new consumption, not later settlement of already-authorized interval. Its final ACK may be later; every mouse/boundary hook still checks owner/scope/lease without renewing. Stale queued snapshots fence before consumption.

Yaw zero faces +Z, +π/2 faces −X, −π/2 faces +X, ±π faces −Z; positive yaw turns right under actor convention, positive pitch up. Applied pose wraps yaw to [-π,π), clamps pitch to [-π/2,π/2] subject to vanilla/vehicle limits. Read actual pose; wrap crossing is not full turn.

Compass directions use world axes: N=−Z, E=+X, S=+Z. East is yaw −π/2, not +π/2. Generated controller help provides bearings and π/8 sector half-width. Here has no horizontal bearing. Sound labels grant no exact target.

## Pure motion helpers

Frozen realm-local `motion.turn(options,state)` is cubic math for model-selected stable orientation: actual native tick/applied pose, chosen target, positive duration ticks/rate, explicit retained JSON. Same-tick callback does not advance. Retarget/regressed clock rebases from actual pose. At duration returns zero rate even if unaligned; finished and aligned differ.

`motion.track` is changing-target feedback math with chosen rate/acceleration/response time and optional tolerance. Desired velocity is wrapped yaw/clamped pitch error divided by response, capped; velocity changes by at most acceleration×native elapsed. Target changes retain velocity. Same tick does not advance; null/regressed time resets zero. Invalid carried state, including velocity above lowered cap, rejects.

Tolerance reports alignment without snapping velocity. Lag/overshoot is possible. Neither helper selects target, scans, moves, attacks, emits input, supplies strategy or guarantees arrival. The model submits output and decides next action.

Helper versions enter validation; track binding/aliases require advertised worker feature. Old kernels refuse instead of silent replacement. Explicit delta remains immediate even with helpers available.

Authoring contract asks transitions over authored time, not mandatory full-circle scans or re-aiming at removed blocks. This is guidance, not proof a model follows it. Stop clears owned holds/presses/future rotation without undoing applied pose or resolving unknown effects.

Sources: [`control.ts`](../../src/shared/control.ts), [`resident.ts`](../../src/shared/resident.ts), [native client](../../native/minecraft/src/client/java/io/gameharness/nativeclient/NativeClient.java). See [navigation](navigation.md), [input](input.md), [executive](executive.md).
