package io.gameharness.pilot;

import java.util.function.Predicate;
import net.minecraft.client.MinecraftClient;
import net.minecraft.component.DataComponentTypes;
import net.minecraft.component.type.AttributeModifiersComponent;
import net.minecraft.entity.EquipmentSlot;
import net.minecraft.entity.LivingEntity;
import net.minecraft.entity.ai.RangedAttackMob;
import net.minecraft.entity.attribute.EntityAttributes;
import net.minecraft.entity.player.PlayerInventory;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.registry.tag.ItemTags;
import net.minecraft.util.math.Vec3d;

/** Cave kit and weapon choices use the player's inventory; combat uses only the current view. */
final class PilotDefense {
    private static final int SHIELD_PLANKS = 6;
    private static final Predicate<ItemStack> SHIELD = stack -> stack.isOf(Items.SHIELD);
    private static final Predicate<ItemStack> INGOT = stack -> stack.isOf(Items.IRON_INGOT);
    private static final Predicate<ItemStack> STONE = stack -> stack.isIn(ItemTags.STONE_TOOL_MATERIALS);

    private enum Armor {
        CHEST(Items.IRON_CHESTPLATE, EquipmentSlot.CHEST, "iron_chestplate", 8),
        LEGS(Items.IRON_LEGGINGS, EquipmentSlot.LEGS, "iron_leggings", 7),
        FEET(Items.IRON_BOOTS, EquipmentSlot.FEET, "iron_boots", 4),
        HEAD(Items.IRON_HELMET, EquipmentSlot.HEAD, "iron_helmet", 5);

        final Item item;
        final EquipmentSlot slot;
        final String recipe;
        final Predicate<ItemStack> matches;
        final int cost;
        final double protection;

        Armor(Item item, EquipmentSlot slot, String recipe, int cost) {
            this.item = item;
            this.slot = slot;
            this.recipe = recipe;
            this.cost = cost;
            matches = stack -> stack.isOf(item);
            protection = armorPoints(item.getComponents().getOrDefault(
                DataComponentTypes.ATTRIBUTE_MODIFIERS, AttributeModifiersComponent.DEFAULT), slot);
        }
    }

    private static final Armor[] ARMOR = Armor.values();
    private final MinecraftClient client;
    private final PilotBody body;
    private final PilotHands hands;
    private String status;
    private boolean hadShield;
    private boolean combatSelecting;
    private int calmAfter;
    private int seekIronUntil;
    private int equipAfter;
    private int swapAfter;
    private int swapWaitUntil;
    private Armor wearing;
    private int wearUntil;
    private int wearAfter;
    private String workshopRecipe;
    private int workshopUntil;
    private int workshopAfter;
    private LivingEntity lastThreat;
    private int engagementStarted;
    private int lastEngaged;
    private Vec3d aim;

    PilotDefense(MinecraftClient client, PilotBody body, PilotHands hands) {
        this.client = client;
        this.body = body;
        this.hands = hands;
    }

    String status() {
        return status;
    }

    void markDanger(int tick) {
        calmAfter = tick + 20;
    }

    boolean combatSelecting() {
        if (!hands.busy()) combatSelecting = false;
        return combatSelecting;
    }

    void cancelSelection() { combatSelecting = false; }

    boolean canPrepare(int tick) {
        return tick >= calmAfter && !client.player.isUsingItem() && body.hasRecentView();
    }

    boolean prepare(PilotProgress progress, int tick, int reserve, int sparePlanks, int sticks, boolean beforePortal) {
        status = null;
        var player = client.player;

        boolean offhand = SHIELD.test(player.getOffHandStack());
        boolean shield = offhand || hands.count(SHIELD) > 0;
        hadShield |= shield;
        if (!offhand && shield) {
            if (SHIELD.test(player.getMainHandStack())) {
                if (swapShield(tick)) return true;
            } else if (equip(tick, SHIELD)) {
                status = "selecting a shield for the offhand";
                return true;
            }
        }

        int iron = hands.count(INGOT);
        if (!shield && sparePlanks >= SHIELD_PLANKS) {
            // Spend one ingot after the pick, even before the portal reserve is complete.
            // Replacements must come from surplus so repeated losses cannot drain the reserve.
            if (iron > (hadShield || !beforePortal ? reserve : 0)
                    && workshop(progress, tick, "shield", SHIELD_PLANKS, 0)) return true;
            if (beforePortal && !hadShield && iron == 0) {
                if (seekIronUntil == 0) seekIronUntil = tick + 180;
                if (tick < seekIronUntil) {
                    progress.acquireIron(1);
                    return true;
                }
            }
        }

        if (beforePortal && bestWeapon(PlayerInventory.HOTBAR_SIZE, true) < 0) {
            int stored = bestWeapon(PlayerInventory.MAIN_SIZE, true);
            if (stored >= PlayerInventory.HOTBAR_SIZE) {
                if (tick >= equipAfter) {
                    equipAfter = tick + 45;
                    hands.equipSlot(stored);
                    if (hands.busy()) {
                        status = "moving a weapon to the hotbar";
                        return true;
                    }
                }
            } else if (sparePlanks >= (sticks < 3 ? 2 : 0) && hands.count(STONE) >= 2
                    && workshop(progress, tick, "stone_sword", 0, 1)) {
                return true;
            }
        }

        int stickReservePlanks = sticks < 2 ? 2 : 0;
        for (Armor piece : ARMOR) {
            ItemStack worn = player.getEquippedStack(piece.slot);
            if (worn.hasEnchantments() || armorPoints(worn.getOrDefault(
                    DataComponentTypes.ATTRIBUTE_MODIFIERS, AttributeModifiersComponent.DEFAULT), piece.slot)
                    >= piece.protection) continue;
            if (hands.count(piece.matches) > 0) {
                if (wear(tick, piece)) return true;
            } else if (offhand && sparePlanks >= stickReservePlanks && beforePortal && iron - reserve >= piece.cost
                    && workshop(progress, tick, piece.recipe, 0, 0)) {
                return true;
            }
        }
        return false;
    }

    private boolean equip(int tick, Predicate<ItemStack> matches) {
        if (tick < equipAfter) return false;
        equipAfter = tick + 45;
        return hands.equip(matches);
    }

    private boolean swapShield(int tick) {
        if (tick >= swapAfter) {
            swapAfter = tick + 45;
            if (body.swapShieldToOffhand()) swapWaitUntil = tick + 8;
        }
        if (tick >= swapWaitUntil) return false;
        status = "swapping shield to offhand";
        return true;
    }

    private boolean wear(int tick, Armor piece) {
        if (tick < wearAfter) return false;
        if (!piece.matches.test(client.player.getMainHandStack())) {
            if (!equip(tick, piece.matches)) return false;
            status = "selecting armor to equip";
            return true;
        }
        if (wearing != piece) {
            wearing = piece;
            wearUntil = tick + 14;
        } else if (tick >= wearUntil) {
            wearAfter = tick + 80;
            wearing = null;
            return false;
        }
        body.turn(client.player.getYaw(), -45);
        body.wearArmor(piece.item);
        status = "using armor to equip it";
        return true;
    }

    private boolean workshop(PilotProgress progress, int tick, String recipe, int planks, int sticks) {
        if (tick < workshopAfter) return false;
        if (!recipe.equals(workshopRecipe)) {
            workshopRecipe = recipe;
            workshopUntil = tick + 100;
        } else if (tick >= workshopUntil) {
            workshopRecipe = null;
            workshopAfter = tick + 100;
            return false;
        }
        progress.requestTable(recipe, null, planks, sticks);
        return true;
    }

    /** True if Progress should try a visible, terrain-checked approach this tick. */
    boolean fight(LivingEntity threat, int tick) {
        markDanger(tick);
        var player = client.player;
        if (lastThreat != threat || tick - lastEngaged > 3) engagementStarted = tick;
        lastThreat = threat;
        lastEngaged = tick;
        aim = threat.getBoundingBox().getCenter();
        if (!body.clearTerrain(aim)) {
            double margin = threat.getHeight() * 0.32;
            Vec3d upper = aim.add(0, margin, 0);
            if (body.clearTerrain(upper)) aim = upper;
            else {
                Vec3d lower = aim.add(0, -margin, 0);
                if (body.clearTerrain(lower)) aim = lower;
            }
        }
        face();

        boolean mainShield = SHIELD.test(player.getMainHandStack());
        boolean offhand = SHIELD.test(player.getOffHandStack());
        if (mainShield && !offhand && swapShield(tick)) return false;
        if (!mainShield || offhand) selectWeapon(offhand);

        if (body.strikeTarget(threat)) {
            if (!combatSelecting() && player.getAttackCooldownProgress(0.5f) >= 0.9f) {
                // Vanilla discards attack edges in the tick that releases item use.
                if (player.isUsingItem()) status = "releasing item use for a timed strike";
                else {
                    body.strike(threat);
                    status = "lining up a charged strike on a visible hostile";
                }
                return false;
            }
            guard(threat, mainShield || offhand);
            return false;
        }
        guard(threat, mainShield || offhand);
        double distance = player.squaredDistanceTo(threat);
        return distance > 2.65 * 2.65 && (threat instanceof RangedAttackMob || !mainShield && !offhand
            || distance > 4.4 * 4.4 || tick - engagementStarted >= 14);
    }

    void face() {
        body.aim(aim);
    }

    private void guard(LivingEntity threat, boolean shield) {
        if (shield) body.blockAgainst(threat);
        status = client.player.isBlocking() && SHIELD.test(client.player.getActiveItem())
            ? "shield raised; tracking a visible hostile"
            : shield ? "facing a visible hostile with a shield" : "facing a visible hostile";
    }

    private void selectWeapon(boolean shield) {
        if (hands.busy()) return;
        var player = client.player;
        var inventory = player.getInventory();
        ItemStack main = inventory.getMainHandStack();
        boolean allowAxe = !shield || player.isUsingItem() || !body.shieldStartWouldUseBlock();
        int target = bestWeapon(PlayerInventory.HOTBAR_SIZE, allowAxe);
        if (target < 0 && shield && (!PilotBody.shieldSafeMainHand(main) || !allowAxe && main.isIn(ItemTags.AXES))) {
            for (int slot = 0; slot < PlayerInventory.HOTBAR_SIZE; slot++) {
                if (client.options.hotbarKeys[slot].isUnbound()) continue;
                ItemStack stack = inventory.getStack(slot);
                if (stack.isIn(ItemTags.PICKAXES)) {
                    target = slot;
                    break;
                }
                if (target < 0 && stack.isEmpty()) target = slot;
            }
        }
        if (target >= 0 && target != inventory.selectedSlot) {
            hands.equipSlot(target);
            combatSelecting = hands.busy();
        }
    }

    private int bestWeapon(int limit, boolean allowAxe) {
        var inventory = client.player.getInventory();
        int best = -1;
        double score = 0;
        for (int slot = 0; slot < limit; slot++) {
            if (slot < PlayerInventory.HOTBAR_SIZE && slot != inventory.selectedSlot
                    && client.options.hotbarKeys[slot].isUnbound()) continue;
            ItemStack stack = inventory.getStack(slot);
            boolean sword = stack.isIn(ItemTags.SWORDS);
            if (!sword && (!allowAxe || !stack.isIn(ItemTags.AXES))) continue;
            var entries = stack.getOrDefault(DataComponentTypes.ATTRIBUTE_MODIFIERS, AttributeModifiersComponent.DEFAULT)
                .modifiers();
            double damage = 1, speed = 4;
            for (int i = 0; i < entries.size(); i++) {
                var entry = entries.get(i);
                if (!entry.slot().matches(EquipmentSlot.MAINHAND)) continue;
                if (entry.attribute().equals(EntityAttributes.ATTACK_DAMAGE)) damage += entry.modifier().value();
                if (entry.attribute().equals(EntityAttributes.ATTACK_SPEED)) speed += entry.modifier().value();
            }
            // Swords can raise the offhand shield over a block without an axe use taking priority.
            double candidate = damage * speed + (sword ? 0.25 : 0);
            if (candidate > score || candidate == score && slot == inventory.selectedSlot) {
                best = slot;
                score = candidate;
            }
        }
        return best;
    }

    private static double armorPoints(AttributeModifiersComponent modifiers, EquipmentSlot slot) {
        var entries = modifiers.modifiers();
        double points = 0;
        for (int i = 0; i < entries.size(); i++) {
            var entry = entries.get(i);
            if (entry.slot().matches(slot) && entry.attribute().equals(EntityAttributes.ARMOR)) {
                points += entry.modifier().value();
            }
        }
        return points;
    }
}
