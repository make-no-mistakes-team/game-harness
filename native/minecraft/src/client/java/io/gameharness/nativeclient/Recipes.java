package io.gameharness.nativeclient;

import com.google.gson.*;
import java.util.*;
import net.minecraft.client.MinecraftClient;
import net.minecraft.item.ItemStack;
import net.minecraft.recipe.RecipeDisplayEntry;
import net.minecraft.recipe.display.*;
import net.minecraft.registry.Registries;
import net.minecraft.screen.*;
import net.minecraft.screen.slot.*;
import net.minecraft.util.Hand;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.*;
import net.minecraft.world.RaycastContext;

/** Client-synchronized unlocked recipes only; all crafting goes through vanilla server packets. */
public final class Recipes {
  private static RecipeDisplayEntry active;
  private static int remaining, phase, ticks;
  private static boolean table;
  private static int expectedGain;

  public static int expectedGain() {
    return expectedGain;
  }

  private static List<RecipeDisplayEntry> entries(MinecraftClient c) {
    List<RecipeDisplayEntry> list = new ArrayList<>();
    for (var group : c.player.getRecipeBook().getOrderedResults())
      list.addAll(group.getAllRecipes());
    return list;
  }

  public static JsonArray available(MinecraftClient c, String item) {
    JsonArray recipes = new JsonArray();
    var context = SlotDisplayContexts.createParameters(c.world);
    for (var entry : entries(c)) {
      ItemStack output = entry.display().result().getFirst(context);
      if (output.isEmpty() || !Registries.ITEM.getId(output.getItem()).getPath().equals(item))
        continue;
      List<SlotDisplay> ingredients;
      int width = 0, height = 0;
      if (entry.display() instanceof ShapedCraftingRecipeDisplay shaped) {
        ingredients = shaped.ingredients();
        width = shaped.width();
        height = shaped.height();
      } else if (entry.display() instanceof ShapelessCraftingRecipeDisplay shapeless)
        ingredients = shapeless.ingredients();
      else continue;
      JsonObject recipe = new JsonObject();
      recipe.addProperty("output", item);
      recipe.addProperty("count", output.getCount());
      recipe.addProperty("width", width);
      recipe.addProperty("height", height);
      recipe.addProperty("requires_table", width > 2 || height > 2 || ingredients.size() > 4);
      JsonArray slots = new JsonArray();
      for (var ingredient : ingredients) {
        JsonArray alternatives = new JsonArray();
        for (var stack : ingredient.getStacks(context)) {
          JsonObject choice = new JsonObject();
          choice.addProperty("item", Registries.ITEM.getId(stack.getItem()).getPath());
          choice.addProperty("count", stack.getCount());
          alternatives.add(choice);
        }
        slots.add(alternatives);
      }
      recipe.add("ingredients", slots);
      recipes.add(recipe);
      if (recipes.size() >= 32) break;
    }
    return recipes;
  }

  public static boolean begin(MinecraftClient c, JsonObject action, Map<String, BlockPos> visible) {
    active = null;
    phase = 0;
    ticks = 0;
    remaining = action.get("executions").getAsInt();
    table = action.has("table_id");
    if (remaining < 1 || remaining > 64) return false;
    var context = SlotDisplayContexts.createParameters(c.world);
    for (var entry : entries(c)) {
      var output = entry.display().result().getFirst(context);
      if (output.isEmpty()
          || !Registries.ITEM
              .getId(output.getItem())
              .getPath()
              .equals(action.get("item").getAsString())) continue;
      boolean fits =
          entry.display() instanceof ShapedCraftingRecipeDisplay shaped
              ? shaped.width() <= 2 && shaped.height() <= 2
              : entry.display() instanceof ShapelessCraftingRecipeDisplay shapeless
                  && shapeless.ingredients().size() <= 4;
      if (!fits && !table) continue;
      active = entry;
      expectedGain = output.getCount() * remaining;
      break;
    }
    if (active == null) return false;
    if (table) {
      BlockPos pos = visible.get(action.get("table_id").getAsString());
      if (pos == null
          || c.player.getEyePos().squaredDistanceTo(pos.toCenterPos()) > 25
          || !Registries.BLOCK
              .getId(c.world.getBlockState(pos).getBlock())
              .getPath()
              .equals("crafting_table")) {
        active = null;
        return false;
      }
      BlockHitResult hit =
          c.world.raycast(
              new RaycastContext(
                  c.player.getEyePos(),
                  pos.toCenterPos(),
                  RaycastContext.ShapeType.OUTLINE,
                  RaycastContext.FluidHandling.NONE,
                  c.player));
      if (!hit.getBlockPos().equals(pos)) {
        active = null;
        return false;
      }
      c.interactionManager.interactBlock(c.player, Hand.MAIN_HAND, hit);
    }
    return true;
  }

  public static boolean complete() {
    return active == null && remaining == 0;
  }

  public static void cancel() {
    active = null;
    remaining = 0;
  }

  public static void tick(MinecraftClient c) {
    if (active == null) return;
    ticks++;
    if (ticks % 4 != 0) return;
    var handler = c.player.currentScreenHandler;
    if (table && !(handler instanceof CraftingScreenHandler)) return;
    if (!(handler instanceof CraftingScreenHandler) && !(handler instanceof PlayerScreenHandler))
      return;
    if (phase == 0) {
      c.interactionManager.clickRecipe(handler.syncId, active.id(), false);
      phase = 1;
      return;
    }
    if (phase == 1) {
      if (handler.getSlot(0).getStack().isEmpty()) return;
      c.interactionManager.clickSlot(handler.syncId, 0, 0, SlotActionType.PICKUP, c.player);
      phase = 2;
      return;
    }
    if (phase == 2) {
      ItemStack cursor = handler.getCursorStack();
      if (cursor.isEmpty()) return;
      for (Slot slot : handler.slots) {
        if (slot.inventory != c.player.getInventory() || !slot.canInsert(cursor)) continue;
        ItemStack existing = slot.getStack();
        if (!existing.isEmpty()
            && (!ItemStack.areItemsAndComponentsEqual(existing, cursor)
                || existing.getCount() + cursor.getCount() > existing.getMaxCount())) continue;
        c.interactionManager.clickSlot(handler.syncId, slot.id, 0, SlotActionType.PICKUP, c.player);
        phase = 3;
        return;
      }
      return;
    }
    if (phase == 3 && handler.getCursorStack().isEmpty()) {
      remaining--;
      if (remaining == 0) {
        active = null;
        c.player.closeHandledScreen();
      } else phase = 0;
    }
  }
}
