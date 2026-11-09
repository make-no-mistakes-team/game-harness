package io.gameharness.nativeclient;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import java.util.Objects;
import java.util.function.Function;
import java.util.function.LongSupplier;
import java.util.function.Supplier;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.entity.Entity;
import net.minecraft.entity.EquipmentSlot;
import net.minecraft.item.ItemStack;
import net.minecraft.registry.Registries;
import net.minecraft.util.Hand;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.EntityHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.MathHelper;
import net.minecraft.util.math.Vec3d;

/** Current own-client feedback only; no server inventory request or independent target admission. */
public final class ControllerBody {
  private static final EquipmentSlot[] EQUIPMENT = {
      EquipmentSlot.MAINHAND, EquipmentSlot.OFFHAND, EquipmentSlot.HEAD,
      EquipmentSlot.CHEST, EquipmentSlot.LEGS, EquipmentSlot.FEET
  };
  private static final String[] EQUIPMENT_NAMES = {"main", "off", "head", "torso", "legs", "feet"};
  private final MinecraftClient client;
  private final NativeRenderSnapshot render;
  private final LongSupplier lifeId;
  private final Supplier<EffectAuthority.Space> space;

  public ControllerBody(MinecraftClient client, NativeRenderSnapshot render, LongSupplier lifeId,
      Supplier<EffectAuthority.Space> space) {
    this.client = Objects.requireNonNull(client);
    this.render = Objects.requireNonNull(render);
    this.lifeId = Objects.requireNonNull(lifeId);
    this.space = Objects.requireNonNull(space);
  }

  /** Call on the client thread; an unavailable/unsupported sample fails rather than inventing state. */
  public JsonObject capture(long tick, long now, Function<BlockPos, JsonElement> blockReference,
      Function<Entity, JsonElement> entityReference, Function<Entity, Vec3d> entityPosition) {
    ContractIdentity.checked(tick);
    Objects.requireNonNull(blockReference);
    Objects.requireNonNull(entityReference);
    ClientPlayerEntity player = client.player;
    EffectAuthority.Space currentSpace = space.get();
    long currentLife = ContractIdentity.checked(lifeId.getAsLong());
    if (player == null || client.world == null || player.getWorld() != client.world
        || currentSpace == null || !currentSpace.dimensionId().equals(client.world.getRegistryKey().getValue().toString()))
      throw new IllegalStateException("Current own-player body is unavailable");

    JsonObject body = new JsonObject();
    body.add("position", vector(player.getPos()));
    body.add("velocity_blocks_per_tick", vector(player.getVelocity()));
    body.addProperty("health", finite(player.getHealth()));
    body.addProperty("food", player.getHungerManager().getFoodLevel());
    body.addProperty("on_ground", player.isOnGround());
    body.addProperty("in_water", player.isTouchingWater());
    body.addProperty("submerged_in_water", player.isSubmergedInWater());
    body.addProperty("in_lava", player.isInLava());
    // Vanilla drowning can expose negative own air; do not clamp it to zero.
    body.addProperty("air_ticks", player.getAir());
    body.addProperty("max_air_ticks", player.getMaxAir());
    body.addProperty("sprinting", player.isSprinting());
    body.addProperty("sneaking", player.isSneaking());
    body.addProperty("swimming", player.isSwimming());
    body.addProperty("gliding", player.isGliding());
    Entity vehicle = player.getVehicle();
    body.addProperty("vehicle_type", vehicle == null ? null : Registries.ENTITY_TYPE.getId(vehicle.getType()).toString());
    int selected = player.getInventory().selectedSlot;
    if (selected < 0 || selected > 8) throw new IllegalStateException("Unsupported selected hotbar slot");
    body.addProperty("selected_hotbar", selected);
    body.addProperty("xp_level", player.experienceLevel);
    body.addProperty("xp_progress", finite(player.experienceProgress));
    body.add("active_use", activeUse(player));
    body.addProperty("blocking", player.isBlocking());
    body.add("equipment", equipment(player));
    body.add("status_effects", statusEffects(player));

    JsonObject inventory = inventory(player);
    JsonObject view = new JsonObject(), pose = new JsonObject();
    pose.addProperty("yaw_radians", finite(Math.toRadians(MathHelper.wrapDegrees(player.getYaw()))));
    pose.addProperty("pitch_radians", finite(Math.toRadians(-player.getPitch())));
    view.add("applied_pose", pose);
    // Both vanilla crosshair and hotbar HUD indicators sample this exact zero-delta value.
    view.addProperty("attack_indicator", finite(player.getAttackCooldownProgress(0)));
    view.add("crosshair", crosshair(blockReference, entityReference, entityPosition));
    view.add("render_capture", render.actorCapture(currentLife, currentSpace.epoch(), now));
    if (client.player != player || client.world != player.getWorld() || lifeId.getAsLong() != currentLife
        || !currentSpace.equals(space.get()))
      throw new IllegalStateException("Own-player body scope changed during capture");
    JsonObject result = new JsonObject();
    result.add("player", body); result.add("inventory", inventory); result.add("view", view);
    return result;
  }

  private static JsonElement activeUse(ClientPlayerEntity player) {
    if (!player.isUsingItem()) return JsonNull.INSTANCE;
    ItemStack stack = player.getActiveItem();
    if (stack.isEmpty()) throw new IllegalStateException("Active use item is unavailable");
    JsonObject use = new JsonObject();
    use.addProperty("hand", player.getActiveHand() == Hand.MAIN_HAND ? "main" : "off");
    use.addProperty("item", itemName(stack));
    use.addProperty("elapsed_ticks", player.getItemUseTime());
    use.addProperty("remaining_ticks", player.getItemUseTimeLeft());
    return use;
  }

  private static JsonArray equipment(ClientPlayerEntity player) {
    JsonArray result = new JsonArray();
    for (int i = 0; i < EQUIPMENT.length; i++) {
      ItemStack stack = player.getEquippedStack(EQUIPMENT[i]);
      JsonObject entry = new JsonObject();
      entry.addProperty("slot", EQUIPMENT_NAMES[i]);
      entry.addProperty("item", stack.isEmpty() ? null : itemName(stack));
      entry.addProperty("count", stack.isEmpty() ? 0 : stack.getCount());
      if (stack.isEmpty() || !stack.isDamageable()) entry.add("durability", JsonNull.INSTANCE);
      else {
        JsonObject durability = new JsonObject();
        durability.addProperty("damage", stack.getDamage());
        durability.addProperty("maximum", stack.getMaxDamage());
        entry.add("durability", durability);
      }
      result.add(entry);
    }
    return result;
  }

  private static JsonArray statusEffects(ClientPlayerEntity player) {
    var effects = player.getStatusEffects();
    if (effects.size() > 32) throw new IllegalStateException("Own status effects exceed controller frame bound");
    JsonArray result = new JsonArray();
    for (var effect : effects) {
      JsonObject entry = new JsonObject();
      entry.addProperty("id", Registries.STATUS_EFFECT.getId(effect.getEffectType().value()).toString());
      entry.addProperty("amplifier", effect.getAmplifier());
      // Vanilla's -1 infinite duration is a real own effect value, not missing data.
      entry.addProperty("duration_ticks", effect.getDuration());
      result.add(entry);
    }
    return result;
  }

  private static JsonObject inventory(ClientPlayerEntity player) {
    long sampled = System.nanoTime();
    var inventory = player.getInventory();
    if (inventory.size() > 64) throw new IllegalStateException("Own inventory exceeds controller frame bound");
    JsonArray items = new JsonArray();
    for (int slot = 0; slot < inventory.size(); slot++) {
      ItemStack stack = inventory.getStack(slot);
      if (stack.isEmpty()) continue;
      JsonObject item = new JsonObject();
      item.addProperty("name", itemName(stack));
      item.addProperty("display_name", stack.getName().getString());
      item.addProperty("count", stack.getCount());
      item.addProperty("slot", slot);
      items.add(item);
    }
    JsonObject result = new JsonObject();
    result.addProperty("source", "client_prediction");
    result.addProperty("captured_native_ns", Long.toString(sampled));
    result.add("items", items);
    return result;
  }

  private JsonObject crosshair(Function<BlockPos, JsonElement> blockReference,
      Function<Entity, JsonElement> entityReference, Function<Entity, Vec3d> entityPosition) {
    HitResult hit = client.crosshairTarget;
    if (hit == null) throw new IllegalStateException("Vanilla crosshair is unavailable");
    JsonObject result = new JsonObject();
    if (hit.getType() == HitResult.Type.MISS) {
      result.addProperty("kind", "miss");
    } else if (hit.getType() == HitResult.Type.BLOCK && hit instanceof BlockHitResult block) {
      result.addProperty("kind", "block");
      result.add("hit_position", vector(block.getPos()));
      BlockPos pos = block.getBlockPos();
      JsonObject blockPosition = new JsonObject();
      blockPosition.addProperty("x", pos.getX()); blockPosition.addProperty("y", pos.getY());
      blockPosition.addProperty("z", pos.getZ());
      result.add("block_position", blockPosition);
      result.addProperty("face", block.getSide().asString());
      result.add("target", blockReference.apply(pos));
    } else if (hit.getType() == HitResult.Type.ENTITY && hit instanceof EntityHitResult entity) {
      JsonElement target = entityReference.apply(entity.getEntity());
      Vec3d position = target.isJsonNull() ? null : entityPosition.apply(entity.getEntity());
      if (position == null) result.addProperty("kind", "miss");
      else {
        result.addProperty("kind", "entity");
        result.add("hit_position", vector(position));
        result.add("target", target);
      }
    } else {
      throw new IllegalStateException("Unsupported vanilla crosshair state");
    }
    return result;
  }

  private static String itemName(ItemStack stack) {
    return Registries.ITEM.getId(stack.getItem()).getPath();
  }

  private static JsonObject vector(Vec3d vector) {
    JsonObject result = new JsonObject();
    result.addProperty("x", finite(vector.x)); result.addProperty("y", finite(vector.y));
    result.addProperty("z", finite(vector.z));
    return result;
  }

  private static double finite(double value) {
    if (!Double.isFinite(value)) throw new IllegalStateException("Nonfinite own-player feedback");
    return value;
  }
}
