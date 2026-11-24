# Visible inventory mechanics and effect evidence

These are disclosed generic GameHarness Minecraft helpers. They perform explicitly selected craft/equip/place mechanics, not resource gathering or survival strategy. World time continues through gestures and inference.

## Custody and visible gestures

Craft uses actual vanilla 2×2 inventory or reachable 3×3 table, manual pickup/right-click transfers, output retrieval and remainders; no hidden recipe autofill. Equip and implicit hand preparation for placement use the same exclusive visible inventory session. Hotbar availability permits direct selection.

One virtual pointer supplies hover, carried-stack rendering and real press/release coordinates before capture. Gestures advance on ticks/rendered frames without game-thread sleep or catch-up click burst. Handler/sync/slot-object/layout/source/destination/cursor/grid predicates check before consequential gestures.

Pointer plans choose a stable inset landing, bounded path/category timing variation and coherent short-placement tempo. Their recorded seed reproduces the plan, not OS/game scheduling. Retain actual press/release times and role totals to measure quantization. Normal pointer stays white; no forced overshoot, decorative noise or click-state tint.

Recipe ingredients group by actual source slot: pick up once, distribute individual right-clicks with releases, return surplus once. Mixed/split sources retain actual components/count custody; recipe alternative eligibility does not require incidental components equal display defaults. No drag distribution.

Table block-handle changes after opening do not invalidate already-owned exact crafting handler. Handler replacement stops recipe clicks; life/space/owner/deadline still enforce. Resize may retarget unpressed slot travel; held gesture or pending recipe-book press with changed geometry revokes.

Each operation owns one screen session. Place waits for owned equipment transfer to close, then rechecks placement; an item legitimately on cursor is not a missing-item refusal.

## Recipe bounds and batching

Craft accepts one exact output item/execution count or ordered sequence of 1–8 stages, at most 16 total recipe consumptions. The model selects order/quantity/table. Executions are recipe uses, not output-item counts. Exact registry path query does not expand tags/material families/ingredient names. Missing helper recipe does not prove manual crafting impossible.

One session keeps custody across sequence. Server-confirmed production and clean cursor/grid gate next stage; later failure retains attributable prefix. Final inventory cannot prove intermediate outputs later consumed.

Bounded batch can fill grid then one ordinary Shift-click when inventory capacity holds whole output. Remainders/dynamic displays/output-as-ingredient retain single-execution handling. No automatic refill/count increase.

After owned Shift press, only expected changes inside original grid/output footprint settle; unrelated changes revoke. Settlement within 1,500 ms requires exact output gain plus empty cursor/grid/result. Shift is visible only during authorized vanilla mouse callbacks, not physical override during waits/cleanup. Client deposited-count settlement is not server-confirmed production; stage receipt still gates progression.

Craft deadline is 10,000 + 35,000×executions ms (at most 16); equip 12,000 ms; place including equipment 20,000 ms. Host adds a 3,000-ms receipt margin, with root/task possibly stricter. Safety bounds are not intentional delays or promised times.

## One prepress refresh

Inventory-screen crafting may adopt one ordinary player-inventory server update before **any** press, including first ingredient unpressed pointer travel. Owner/life/space/screen/handler/sync/slot objects/geometry stay fixed; cursor/grid/output empty. Equip/table remain strict.

Cancel old pointer plan and rebuild recipe assignments/quantities/placements from fresh inventory before press. No requested quantity increase. Any prior press/emission/held button/completed gesture/in-flight transfer prohibits refresh, even unknown effect. Allowance shared with startup; rejected update consumes none. No dwell/deadline/gesture renewal or replay. Evidence distinguishes refresh, pending fresh-plan barrier, custody refusal and cancelled-before-input.

## Receipts and cancellation

Authenticated own-inventory receipts bind connection/session/world/epoch, nonce and motor generation, ordered after vanilla packets. They expose bounded own counts/slots, not NBT/admin/world data or another actor capability. Identical slot updates can be suppressed; local click prediction/packet promise cannot prove gain.

Success requires authoritative selected slot and clean cursor/grid custody. Stop/replacement revokes pending gestures without releasing into a different handler; cleanup may close only still-owned handler. Close never rolls back transfers. Detached handler's carried stack remains historical even if new handler is empty.

Capacity, cursor/grid custody, supported recipe display and ingredient availability are distinct refusals without substitute material choice. A refusal after table opening can already have emitted interaction and remain unknown.

Placement preflight validates chosen face/vanilla placement state/replacement/collision before equip/packet. Receipt separates equipment and packet emission/local accepted-pass-fail. Local verdict cannot prove server certainty; aggregate item count may hide consumption offset by pickup.

Dig/removal/attack helpers also separate preparation and effects. Actual outgoing dig packet witnesses emission and server block update establishes removal. Valid long-dig visibility proof retains only unchanged eye/pose/target/read dependencies, not new target authority. Attack sends one current-hand vanilla strike, without equipping/approaching/repeating/cooldown policy; matching server ATTACK processing—not INTERACT—can confirm accepted damage or processed-no-damage. Neither damage nor neutralization proves kill.

Unknown lost craft/place/consume/respawn output is never blindly retried. Inspect retained evidence/fresh state; earlier successful equip does not establish item still available after wear/breakage.

Sources: [`VisibleInventory.java`](../../native/minecraft/src/client/java/io/gameharness/nativeclient/VisibleInventory.java), [`Recipes.java`](../../native/minecraft/src/client/java/io/gameharness/nativeclient/Recipes.java), [`minecraft.ts`](../../src/shared/minecraft.ts). See [mechanics evidence](../evidence/runtime-mechanics.md), [experience](experience.md), [actions](actions.md).
