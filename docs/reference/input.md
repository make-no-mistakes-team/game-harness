# Native input and visible screens

Experimental GameHarness world clips and resident streams use ordinary vanilla input under one arbiter owner. Assisted semantic actions remain separately disclosed. [`control.ts`](../../src/shared/control.ts), [`controller.ts`](../../src/shared/controller.ts) and generated game/controller help own complete shapes.

## World clips and held state

`minecraft.action@4` world input admits at most 64 steps, 100 native ticks and 256 expanded edges, with finite tick-derived wall/receipt deadline. Versions 1–3 are not live aliases.

Each step declares all nine held movement/attack/use booleans. Explicit ordered transitions must agree with desired state; holding attack does not manufacture repeated entity clicks. Inventory open is edge-only. Slot selection applies at entry before vanilla sync; counted hotbar edges retain vanilla consumption precedence.

World input requires absent screen. A vanilla-opened screen ends clip without closing it or applying later steps. No arbitrary keys/chat/debug/generic GUI route.

Raw resident input can omit edges: derive one transition per changed held boolean from last **successfully submitted** state, initially neutral. Unchanged holds produce no new clicks. Explicit edges including empty keep exact order/counting; inconsistent lists reject rather than repair. Native transport always receives explicit list. Stale intent cannot update baseline; lagging latest ACK is not submitted baseline.

Screen input requires neutral submitted world-held state. Release before GUI appears; even neutral world input is forbidden once visible. New raw channels already start neutral. Switch-time input discards and non-running return retires without applying its input.

Movement follows actual yaw each tick: forward horizontal `X=−sin(yaw), Z=cos(yaw)`, back reverses. Simultaneous rotation changes basis. Requested future pose is not applied orientation.

## Stream transport

Reservation uses same arbiter as finite effects and records exact source/scope first. No dummy action/second writer. Finite work and context replacement wait for retirement.

Bounded lanes: sixteen ordinary RPCs, four unresolved input frames, one sample, eight heartbeats and one reserved retirement; native ordinary dispatch is bounded to 32 tasks. Expanded unacknowledged edges cannot exceed 256. Only compatible unsent edge-free held snapshots coalesce; sent frames, edges, relative deltas and explicit selection are preserved.

Input enters within 150 ms of original native capture including conservative clock uncertainty. A separate 250-ms native lease bounds mechanical control; renewal never renews task or replays decision. Held use survives snapshots without release/repress. Vanilla consumption/sampling establishes applied prefix, not queue insertion.

Game thread enqueues immutable replies/notices without waiting for socket. Single writer retains at most 256 messages and 1 MiB including in-flight and ACK headroom. Critical FIFO cannot coalesce; replaceable diagnostic progress can with omissions. Critical overflow fences connection and leaves unresolved effects unknown. Per-frame telemetry does not fsync Store.

Retirement fences admission then clears inputs on game thread and ACKs real tick/time. Stopped native thread cannot release on time; after resume expired backlog rejects, never bursts. Missing ACK requires emitter containment and stays uncertain; process termination is not fabricated native ACK.

## Visible GUI

`game.screen()` reads current visible layout without opening/closing anything. Includes empty visible slots/cursor/logical bounds/current page/progress, not hidden recipes/offers/NBT or closed containers.

Screen input binds screen identity/layout plus local cursor/source predicates. Unrelated content update (for example furnace output) is not whole-layout invalidation. Reads, empty input and normal settlement preserve screen. Explicit close follows vanilla custody, never rollback.

Pointer retains actual last position on same handler/screen during idle/request gaps; no forced inventory return point. Retention grants no pressed-button ownership. Closing/replacement/handler/window/viewport or another writer invalidates; fresh context starts from scaled vanilla mouse.

Rendered choices cover stonecutter/loom/enchantment/beacon and at most seven visible merchant offers. Wheel targets an enabled rendered scroll region with horizontal/vertical components in [-16,16] after pointer travel. Page/binding/geometry changes retire IDs. No off-page enumeration, enchantment seed or undisplayed hint; unavailable operations reject.

Matched server ARM/FINISH and actual production/result-slot provenance may establish GUI effect. Input ACK, client prediction or final possession alone cannot. Unmatched stays unknown and is not retried.

Dependent GUI operations wait for preceding nonempty gesture's matching application ACK **and terminal effect receipt**. While pending, use null submission, not empty GUI polling inputs after close/layout change. World/empty-screen inputs have ACK but no later effect receipt; null waits have neither.

Frame retains latest ACK, plus up to eight later GUI effect updates within 16 KiB with original sequence/time and omission count. Capture sequence, input sequence and native tick are independent. ACK does not establish world effect and never exposes private owner grant.

## Evaluator-only faults

Ordinary native launches serialize evaluation null. Explicit proof authority can declare strict one-use owner-bound screen replacement after actual second gesture press and/or bounded control send buffer. It uses ordinary screen hooks, no second writer/fake receipt/release into replacement handler. Natural fixtures refuse it; resident timing study requires disabled state. Raw diagnostic methods are not actor tools.

Overlay/input eligibility diagnostics are readonly gates, not evidence a key was consumed or GUI was eligible.

See [motion](motion.md), [inventory](inventory.md), [actions](actions.md), [timing](timing.md).
