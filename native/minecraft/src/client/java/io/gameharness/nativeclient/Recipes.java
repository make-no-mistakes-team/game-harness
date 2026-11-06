package io.gameharness.nativeclient;

import com.google.gson.*;
import java.util.*;
import net.minecraft.client.MinecraftClient;
import net.minecraft.item.ItemStack;
import java.util.function.BooleanSupplier;
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
  private static int remaining, phase, ingredient, remainder;
  private static boolean table;
  private static int expectedGain;
  private static boolean invalidated;
  private static String beginRefusalReason;
  private static VisibleInventory session;
  private record IngredientGroup(int source, ItemStack stack, int[] grids) {}
  private static IngredientGroup[] groups;
  private static int source, destination, carriedCount, placement;
  private static ItemStack output, carried;
  private static long outputWait;

  public static int expectedGain() {
    return expectedGain;
  }

  public static String beginRefusalReason() {
    return beginRefusalReason;
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

  public static boolean begin(MinecraftClient c, JsonObject action, BlockPos selectedTable,
      BooleanSupplier authorized) {
    active = null;
    session = null;
    invalidated = false;
    beginRefusalReason = null;
    phase = 0;
    remaining = action.get("executions").getAsInt();
    table = action.has("table");
    if (remaining < 1 || remaining > 16) {
      beginRefusalReason = "Craft executions must be between 1 and 16";
      return false;
    }
    boolean matchingOutput = false;
    var context = SlotDisplayContexts.createParameters(c.world);
    for (var entry : entries(c)) {
      var output = entry.display().result().getFirst(context);
      if (output.isEmpty()
          || !Registries.ITEM
              .getId(output.getItem())
              .getPath()
              .equals(action.get("item").getAsString())) continue;
      matchingOutput = true;
      boolean fits =
          entry.display() instanceof ShapedCraftingRecipeDisplay shaped
              ? shaped.width() <= 2 && shaped.height() <= 2
              : entry.display() instanceof ShapelessCraftingRecipeDisplay shapeless
                  && shapeless.ingredients().size() <= 4;
      if (!fits && !table) continue;
      active = entry;
      Recipes.output = output.copy();
      expectedGain = output.getCount() * remaining;
      break;
    }
    if (active == null) {
      beginRefusalReason = matchingOutput
          ? "Unlocked recipe output matches, but no matching display fits the 2x2 inventory grid and no crafting table was supplied"
          : "No unlocked recipe display matches the exact output item";
      return false;
    }
    session = new VisibleInventory(c, table, authorized);
    if (table) {
      BlockPos pos = selectedTable;
      if (pos == null)
        beginRefusalReason = "Supplied crafting table target is missing";
      else if (c.player.getEyePos().squaredDistanceTo(pos.toCenterPos()) > 25)
        beginRefusalReason = "Supplied crafting table is beyond interaction reach";
      else if (!Registries.BLOCK
              .getId(c.world.getBlockState(pos).getBlock())
              .getPath()
              .equals("crafting_table"))
        beginRefusalReason = "Supplied target is not a crafting table";
      if (beginRefusalReason != null) {
        session.cancel(false); active = null;
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
        beginRefusalReason = "Line of sight to supplied crafting table is blocked or unavailable";
        session.cancel(false); active = null;
        return false;
      }
      c.interactionManager.interactBlock(c.player, Hand.MAIN_HAND, hit);
    } else session.openInventory();
    return true;
  }

  public static boolean complete() {
    return !invalidated && active == null && remaining == 0 && session != null && session.closed();
  }
  /** After the requested table opens, exact handler identity owns the transfer.
   * Vanilla may send a same-state block update for the interaction; that still
   * revokes old world targets, but does not replace this already-open grid.
   */
  public static boolean ownsTableGrid(MinecraftClient c) {
    return table && session != null && session.bind() && session.ownsHandler();
  }
  public static boolean invalidated() { return invalidated; }

  public static VisibleInventory session() { return session; }

  public static void cancel(boolean trustedCleanup) {
    if (session != null) session.cancel(trustedCleanup);
    active = null;
    remaining = 0;
    session = null;
  }

  public static void tick(MinecraftClient c) {
    if (active == null) return;
    if (!session.bind()) {
      if (session.failed()) invalidated = true;
      return;
    }
    session.tick();
    if (session.failed()) { invalidated = true; return; }
    if (!session.ready()) return;
    ScreenHandler handler = session.handler();
    ItemStack cursor = handler.getCursorStack();
    switch (phase) {
      case 0 -> {
        if (!session.clean()) { fail("craft_grid_or_cursor_not_clear"); return; }
        if (destination(c, output) < 0) { fail("craft_output_capacity_unavailable"); return; }
        String planningRefusal = plan(c);
        if (planningRefusal != null) { fail(planningRefusal); return; }
        ingredient = 0; placement = 0; phase = 1;
      }
      case 1 -> {
        if (!cursor.isEmpty() || !ingredientsMatch(handler, 0)) {
          fail("ingredient_group_custody_changed"); return;
        }
        if (ingredient == groups.length) { phase = 4; outputWait = System.nanoTime(); return; }
        IngredientGroup group = groups[ingredient];
        source = group.source();
        carried = group.stack();
        carriedCount = carried.getCount();
        placement = 0;
        if (carriedCount < group.grids().length
            || !ItemStack.areEqual(handler.getSlot(source).getStack(), carried)
            || !handler.getSlot(source).canTakeItems(c.player)) {
          session.fail("ingredient_source_changed"); invalidated = true; return;
        }
        for (int grid : group.grids())
          if (!handler.getSlot(grid).canInsert(carried)
              || handler.getSlot(grid).getMaxItemCount(carried) < 1) {
            fail("ingredient_grid_changed"); return;
          }
        session.beginIngredientGroup(source);
        if (!session.click(source, 0, VisibleInventory.Gesture.ACQUIRE)) {
          fail("ingredient_pickup_not_started"); return;
        }
        phase = 2;
      }
      case 2 -> {
        if (!heldIngredientMatches(handler, cursor, 0)) {
          fail("ingredient_pickup_not_confirmed"); return;
        }
        if (!session.click(groups[ingredient].grids()[0], 1, VisibleInventory.Gesture.DISTRIBUTE)) {
          fail("ingredient_distribution_not_started"); return;
        }
        phase = 3;
      }
      case 3 -> {
        if (!heldIngredientMatches(handler, cursor, placement + 1)) {
          fail("ingredient_distribution_not_confirmed"); return;
        }
        placement++;
        if (placement < groups[ingredient].grids().length) {
          if (!session.click(groups[ingredient].grids()[placement], 1, VisibleInventory.Gesture.DISTRIBUTE))
            fail("ingredient_distribution_not_started");
          return;
        }
        if (!cursor.isEmpty()) {
          if (!session.click(source, 0, VisibleInventory.Gesture.RETURN)) {
            fail("ingredient_return_not_started"); return;
          }
          phase = 9;
        } else {
          ingredient++; phase = 1;
        }
      }
      case 9 -> {
        if (!cursor.isEmpty()
            || !stackMatches(handler.getSlot(source).getStack(), carried, carriedCount - placement)
            || !ingredientsMatch(handler, placement)) {
          fail("ingredient_cursor_not_returned"); return;
        }
        ingredient++; phase = 1;
      }
      case 4 -> {
        if (!ItemStack.areEqual(handler.getSlot(0).getStack(), output)) {
          if (System.nanoTime() - outputWait > 2_000_000_000L) fail("craft_output_not_observed");
          return;
        }
        destination = destination(c, output);
        if (destination < 0) { fail("craft_output_capacity_changed"); return; }
        if (session.click(0, 0, VisibleInventory.Gesture.RESULT)) phase = 5;
        else fail("craft_output_pickup_not_started");
      }
      case 5 -> {
        if (!ItemStack.areEqual(cursor, output)) { fail("craft_output_pickup_not_confirmed"); return; }
        if (session.click(destination, 0, VisibleInventory.Gesture.RESULT)) phase = 6;
        else fail("craft_output_deposit_not_started");
      }
      case 6 -> {
        if (!cursor.isEmpty()) { fail("craft_output_cursor_not_deposited"); return; }
        remainder = 1; phase = 7;
      }
      case 7 -> {
        int gridSize = table ? 9 : 4;
        while (remainder <= gridSize && handler.getSlot(remainder).getStack().isEmpty()) remainder++;
        if (remainder > gridSize) {
          if (!session.clean()) { fail("craft_grid_custody_not_clean"); return; }
          remaining--;
          if (remaining == 0) {
            session.close();
            if (session.failed()) { invalidated = true; return; }
            active = null;
          }
          else phase = 0;
          return;
        }
        carried = handler.getSlot(remainder).getStack().copy();
        destination = destination(c, carried);
        if (destination < 0) { fail("craft_remainder_capacity"); return; }
        if (session.click(remainder, 0, VisibleInventory.Gesture.TRANSFER)) phase = 8;
        else fail("remainder_pickup_not_started");
      }
      case 8 -> {
        if (!ItemStack.areEqual(cursor, carried)) { fail("remainder_pickup_not_confirmed"); return; }
        if (session.click(destination, 0, VisibleInventory.Gesture.TRANSFER)) phase = 10;
        else fail("remainder_deposit_not_started");
      }
      case 10 -> {
        if (!cursor.isEmpty()) { fail("remainder_cursor_not_returned"); return; }
        remainder++; phase = 7;
      }
      default -> fail("craft_phase_invalid");
    }
  }

  private static void fail(String reason) {
    session.fail(reason); invalidated = true;
  }

  private static boolean stackMatches(ItemStack actual, ItemStack expected, int count) {
    return count == 0 ? actual.isEmpty()
        : actual.getCount() == count && ItemStack.areItemsAndComponentsEqual(actual, expected);
  }

  /** Every completed placement stays checked, including when a source group changes. */
  private static boolean ingredientsMatch(ScreenHandler handler, int placed) {
    for (int i = 0; i < groups.length; i++) {
      IngredientGroup group = groups[i];
      for (int j = 0; j < group.grids().length; j++)
        if (!stackMatches(handler.getSlot(group.grids()[j]).getStack(), group.stack(),
            i < ingredient || i == ingredient && j < placed ? 1 : 0)) return false;
    }
    return true;
  }

  private static boolean heldIngredientMatches(ScreenHandler handler, ItemStack cursor, int placed) {
    return handler.getSlot(source).getStack().isEmpty()
        && stackMatches(cursor, carried, carriedCount - placed)
        && ingredientsMatch(handler, placed);
  }

  /** Ingredient alternatives are only the already-disclosed unlocked recipe display data. */
  private static String plan(MinecraftClient c) {
    var context = SlotDisplayContexts.createParameters(c.world);
    List<SlotDisplay> ingredients;
    int width;
    if (active.display() instanceof ShapedCraftingRecipeDisplay shaped) {
      ingredients = shaped.ingredients(); width = shaped.width();
    } else if (active.display() instanceof ShapelessCraftingRecipeDisplay shapeless) {
      ingredients = shapeless.ingredients(); width = table ? 3 : 2;
    } else return "craft_recipe_display_unsupported";
    Map<Integer, List<Integer>> selected = new LinkedHashMap<>();
    ScreenHandler handler = session.handler();
    int[] reserved = new int[handler.slots.size()];
    for (int i = 0; i < ingredients.size(); i++) {
      List<ItemStack> alternatives = ingredients.get(i).getStacks(context);
      if (alternatives.isEmpty()) continue;
      int sourceSlot = -1;
      for (Slot slot : handler.slots) {
        if (slot.inventory != c.player.getInventory() || slot.getIndex() >= 36
            || slot.getStack().getCount() <= reserved[slot.id] || !slot.canTakeItems(c.player)) continue;
        for (ItemStack alternative : alternatives)
          // Vanilla Ingredient tests registry item membership, not components.
          // Custody below still pins the actual source stack's exact components.
          if (slot.getStack().isOf(alternative.getItem())) { sourceSlot = slot.id; break; }
        if (sourceSlot >= 0) break;
      }
      if (sourceSlot < 0) return "craft_ingredients_unavailable";
      reserved[sourceSlot]++;
      selected.computeIfAbsent(sourceSlot, ignored -> new ArrayList<>())
          .add(1 + i % width + i / width * (table ? 3 : 2));
    }
    groups = new IngredientGroup[selected.size()];
    int index = 0;
    for (var entry : selected.entrySet())
      groups[index++] = new IngredientGroup(entry.getKey(), handler.getSlot(entry.getKey()).getStack().copy(),
          entry.getValue().stream().mapToInt(Integer::intValue).toArray());
    return groups.length > 0 ? null : "craft_recipe_has_no_supported_ingredients";
  }

  private static int destination(MinecraftClient c, ItemStack stack) {
    int empty = -1;
    for (Slot slot : session.handler().slots) {
      if (slot.inventory != c.player.getInventory() || slot.getIndex() >= 36 || !slot.canInsert(stack)) continue;
      ItemStack existing = slot.getStack();
      if (existing.isEmpty()) { if (empty < 0 && stack.getCount() <= slot.getMaxItemCount(stack)) empty = slot.id; }
      else if (ItemStack.areItemsAndComponentsEqual(existing, stack)
          && existing.getCount() + stack.getCount() <= slot.getMaxItemCount(stack)) return slot.id;
    }
    return empty;
  }
}
