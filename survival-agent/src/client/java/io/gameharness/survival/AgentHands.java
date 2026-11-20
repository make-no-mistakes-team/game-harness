package io.gameharness.survival;

import io.gameharness.survival.mixin.AgentHandledScreenAccess;
import io.gameharness.survival.mixin.AgentKeyboardAccess;
import io.gameharness.survival.mixin.AgentMouseAccess;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.function.Predicate;
import java.util.function.ToIntFunction;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.navigation.GuiNavigationType;
import net.minecraft.client.gui.screen.Screen;
import net.minecraft.client.gui.screen.ingame.CraftingScreen;
import net.minecraft.client.gui.screen.ingame.FurnaceScreen;
import net.minecraft.client.gui.screen.ingame.HandledScreen;
import net.minecraft.client.gui.screen.ingame.InventoryScreen;
import net.minecraft.client.gui.screen.recipebook.RecipeBookWidget;
import net.minecraft.client.gui.widget.ButtonWidget;
import net.minecraft.client.gui.widget.TexturedButtonWidget;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.client.option.KeyBinding;
import net.minecraft.client.util.InputUtil;
import net.minecraft.client.util.Window;
import net.minecraft.entity.player.PlayerInventory;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.registry.Registries;
import net.minecraft.registry.tag.ItemTags;
import net.minecraft.screen.AbstractCraftingScreenHandler;
import net.minecraft.screen.ScreenHandler;
import net.minecraft.screen.slot.Slot;
import net.minecraft.util.Identifier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import static org.lwjgl.glfw.GLFW.GLFW_MOUSE_BUTTON_LEFT;
import static org.lwjgl.glfw.GLFW.GLFW_MOUSE_BUTTON_RIGHT;
import static org.lwjgl.glfw.GLFW.GLFW_KEY_ESCAPE;
import static org.lwjgl.glfw.GLFW.GLFW_PRESS;
import static org.lwjgl.glfw.GLFW.GLFW_RELEASE;
import static org.lwjgl.glfw.GLFW.glfwGetCursorPos;
import static org.lwjgl.glfw.GLFW.glfwGetKey;
import static org.lwjgl.glfw.GLFW.glfwGetKeyScancode;
import static org.lwjgl.glfw.GLFW.glfwGetMouseButton;
import static org.lwjgl.glfw.GLFW.glfwSetCursorPos;

final class AgentHands {
    private static final Logger LOGGER = LoggerFactory.getLogger(AgentHands.class);
    private static final long ACTION_TIMEOUT = 15_000_000_000L;
    private static final long RESULT_TIMEOUT = 1_500_000_000L;
    private static final long KEY_TIMEOUT = 1_000_000_000L;
    private static final long LEFT_CLICK_INTERVAL = 260_000_000L; // Outside vanilla's double-click window.
    private static final long POINTER_HANDOFF = 60_000_000L;
    private static final int SLOT_SIZE = 16; // Visible icon interior; vanilla separately owns the hit test.
    private static final int GRID_SPACING = 18;
    private static final int SCREEN_REVISION_MASK = 0x7fff;
    static final int SMELT_TICKS = 200;

    private enum Job { CRAFT, SMELT, EQUIP }

    private enum Mode { TAKE, HALF, RESULT, QUICK_RESULT, ONE, PUT, STORE, SWAP, CLEAR_BOOK }

    private enum Recipe {
        PLANKS(null, 4, "l"),
        BOAT(null, 1, "p p", "ppp"),
        CRAFTING_TABLE(Items.CRAFTING_TABLE, 1, "pp", "pp"),
        STICK(Items.STICK, 4, "p", "p"),
        WOODEN_PICKAXE(Items.WOODEN_PICKAXE, 1, "ppp", " s ", " s "),
        WOODEN_SHOVEL(Items.WOODEN_SHOVEL, 1, "p", "s", "s"),
        WOODEN_AXE(Items.WOODEN_AXE, 1, "pp", "ps", " s"),
        STONE_PICKAXE(Items.STONE_PICKAXE, 1, "rrr", " s ", " s "),
        STONE_SHOVEL(Items.STONE_SHOVEL, 1, "r", "s", "s"),
        STONE_AXE(Items.STONE_AXE, 1, "rr", "rs", " s"),
        FURNACE(Items.FURNACE, 1, "mmm", "m m", "mmm"),
        IRON_PICKAXE(Items.IRON_PICKAXE, 1, "iii", " s ", " s "),
        IRON_SHOVEL(Items.IRON_SHOVEL, 1, "i", "s", "s"),
        DIAMOND_PICKAXE(Items.DIAMOND_PICKAXE, 1, "ddd", " s ", " s "),
        BUCKET(Items.BUCKET, 1, "i i", " i "),
        FLINT_AND_STEEL(Items.FLINT_AND_STEEL, 1, "if"), // Shapeless; place both in the first row.
        STONE_SWORD(Items.STONE_SWORD, 1, "r", "r", "s"),
        SHIELD(Items.SHIELD, 1, "wiw", "www", " w "),
        IRON_CHESTPLATE(Items.IRON_CHESTPLATE, 1, "i i", "iii", "iii"),
        IRON_LEGGINGS(Items.IRON_LEGGINGS, 1, "iii", "i i", "i i"),
        IRON_HELMET(Items.IRON_HELMET, 1, "iii", "i i"),
        IRON_BOOTS(Items.IRON_BOOTS, 1, "i i", "i i"),
        TORCH(Items.TORCH, 4, "c", "s");

        final Item output;
        final int batch;
        final String[] rows;

        Recipe(Item output, int batch, String... rows) {
            this.output = output;
            this.batch = batch;
            this.rows = rows;
        }

        boolean needsTable() {
            return rows.length > 2 || rows[0].length() > 2;
        }
    }

    private record CraftRequest(Recipe recipe, String key) {}

    private record Portion(int source, int cell, int count) {}

    private record CraftPlan(Recipe recipe, ItemStack result, int executions, ItemStack[] cells,
                             List<Portion> portions, int[] used) {}

    record CraftReceipt(long sequence, String recipe, int executions, int items, int shiftClicks, int revision) {}

    record IronBatch(int units, Item fuel, int fuelCount, int fuelTicks) {}

    private record Step(Mode mode, Slot slot, Item item, int count) {}

    private static final class Click {
        final AgentGuiPointer motion;
        final Step step;
        final TexturedButtonWidget bookButton;
        final ItemStack cursorBefore;
        final int button;
        ItemStack slotBefore;
        Drag drag;
        long firstEntry, lastEntry, pressWallMs, pressAt;
        double pressX, pressY, pressOffsetX, pressOffsetY, pressVx, pressVy;
        int pressRevision;
        boolean inTarget, pressSettled;
        boolean pressed, holdTail;

        Click(AgentGuiPointer motion, Step step, TexturedButtonWidget bookButton, ItemStack cursor, ItemStack slot) {
            this.motion = motion;
            motion.reset();
            this.step = step;
            this.bookButton = bookButton;
            cursorBefore = cursor.copy();
            slotBefore = slot.copy();
            button = step.mode == Mode.ONE || step.mode == Mode.HALF ? GLFW_MOUSE_BUTTON_RIGHT : GLFW_MOUSE_BUTTON_LEFT;
        }
    }

    /** One straight row or column of vanilla craft inputs, with an exact before-image for settlement. */
    private static final class Drag {
        final Slot[] slots;
        ItemStack[] before;
        long sequence, movedAt, settleDeadline;
        double x, y, dx, dy, commandX, commandY, endX, endY, scaleX, scaleY, speed;
        int entered, left, top, releaseRevision;
        boolean down, released;

        Drag(Slot[] slots) { this.slots = slots; }

        Slot last() { return slots[slots.length - 1]; }
    }

    private final MinecraftClient c;
    private final ArrayDeque<Step> steps = new ArrayDeque<>();
    private final double[] mouseX = new double[1], mouseY = new double[1];
    private final AgentGuiPointer clickMotion = new AgentGuiPointer();
    private final AgentGuiPointer buttonMotion = new AgentGuiPointer();
    private Job job;
    private ClientPlayerEntity player;
    private HandledScreen<?> screen;
    private Click click;
    private Path pointerEvidence, dragEvidence;
    private boolean pointerHeaderWritten, dragHeaderWritten;
    private long handoffAt;
    private double handoffX, handoffY, handoffVx, handoffVy;
    private Slot lastLeftSlot;
    private long nextSameLeftPress;
    private CraftRequest[] crafts;
    private CraftPlan craftPlan;
    private ItemStack[] craftStorage;
    private AgentWorkOrder.Budget craftBudget;
    private IronBatch boundedIron;
    private AgentWorkOrder.Budget smeltBudget;
    private boolean scopedSmelt;
    private int ironDeposited, fuelDeposited;
    private long workEvidence;
    private int craftGridRevision, craftTakeRevision;
    private long craftSettleDeadline, craftShiftClicks;
    private CraftReceipt craftReceipt;
    private int craftIndex;
    private ItemStack equipStack = ItemStack.EMPTY;
    private int equipSource, hotbar;
    private boolean inventoryNeeded, planned, storeResult, resultStored, previousFailure;
    private KeyBinding pendingKey;
    private long deadline, keyDeadline, resultDeadline;
    private long jobGeneration;
    private String label = "hands";
    private String status = "idle";

    AgentHands(MinecraftClient c) {
        this.c = c;
        String output = System.getProperty("gh.agent.dir", System.getenv("GH_AGENT_DIR"));
        if (output != null) {
            Path dir = Path.of(output);
            pointerEvidence = dir.resolve("gui-pointer.tsv");
            dragEvidence = dir.resolve("gui-drag.tsv");
        }
    }

    boolean busy() {
        return job != null;
    }

    boolean holdsWorkInventory() {
        return job == null && screen instanceof InventoryScreen;
    }

    boolean workInventoryReady() {
        return holdsWorkInventory() && ownsScreen() && cleanPersonalScreen() && stableCraftFooting()
            && pointerAvailable() && !Screen.hasShiftDown() && !physicalButtonDown(c.getWindow());
    }

    private boolean cleanPersonalScreen() {
        return screen instanceof InventoryScreen && cleanGrid(screen)
            && !((AgentHandledScreenAccess) screen).agent$cursorDragging();
    }

    void releaseWorkInventory(boolean close) {
        if (!holdsWorkInventory()) return;
        if (close && ownsScreen() && cleanPersonalScreen() && !physicalButtonDown(c.getWindow())) screen.close();
        screen = null;
        player = null;
        handoffAt = 0;
        lastLeftSlot = null;
    }

    long jobGeneration() { return jobGeneration; }
    long workEvidence() { return workEvidence; }

    /** A boat cannot use mixed plank species. Only append optional boat work to
     * a workshop session when the planned plank conversions preserve one species. */
    boolean singleBoatWoodStock() {
        if (c.player == null) return false;
        Item species = null;
        for (int slot = 0; slot < PlayerInventory.MAIN_SIZE; ++slot) {
            ItemStack stack = c.player.getInventory().getStack(slot);
            Item wood = stack.isIn(ItemTags.PLANKS) ? stack.getItem() :
                stack.isIn(ItemTags.LOGS) ? planksFor(stack) : null;
            if (wood == null) continue;
            if (species != null && species != wood) return false;
            species = wood;
        }
        return species != null;
    }

    String status() {
        return status;
    }

    CraftReceipt lastCraftReceipt() {
        return craftReceipt;
    }

    long craftShiftClicks() {
        return craftShiftClicks;
    }

    int count(Predicate<ItemStack> item) {
        if (c.player == null) return 0;
        var inv = c.player.getInventory();
        int amount = 0;
        for (int i = 0; i < PlayerInventory.MAIN_SIZE; i++) {
            ItemStack stack = inv.getStack(i);
            if (!stack.isEmpty() && item.test(stack)) amount += stack.getCount();
        }
        return amount;
    }

    boolean craft(String item) {
        return craftBatch(List.of(item));
    }

    static boolean workRecipe(String key) {
        if (key.indexOf(':') >= 0) return false;
        CraftRequest request = craftRequest(key);
        return request != null && request.key.equals(key);
    }

    static boolean workTableRecipe(String key) {
        CraftRequest request = craftRequest(key);
        return request != null && request.recipe.needsTable();
    }

    static boolean workSpecificPlanks(String key) {
        return key.endsWith("_planks") && workRecipe(key);
    }

    static int workOutputCount(String key) {
        CraftRequest request = craftRequest(key);
        return request.recipe == Recipe.PLANKS && key.equals("bamboo_planks") ? 2 : request.recipe.batch;
    }

    static Item workOutput(String key) {
        CraftRequest request = craftRequest(key);
        if (request == null) return null;
        if (request.recipe == Recipe.PLANKS) {
            return key.equals("planks") ? null : Registries.ITEM.get(Identifier.ofVanilla(key));
        }
        return request.recipe == Recipe.BOAT ? vanillaBoat(key) : request.recipe.output;
    }

    /** The same admitted vanilla ingredient rules drive procurement before the real grid plan. */
    record WorkNeed(char token, String recipe, Item exact, int count) {
        boolean matches(ItemStack stack) {
            return ingredientMatches(token, stack) && (exact == null || stack.isOf(exact))
                && (token != 'l' || planksFor(stack) != null && (recipe.equals("planks")
                    || Registries.ITEM.getId(planksFor(stack)).getPath().equals(recipe)));
        }
    }

    WorkNeed workNeed(String recipe, AgentWorkOrder.Budget budget) {
        return workNeed(c.player.getInventory(), recipe, budget);
    }

    static WorkNeed workNeed(PlayerInventory inventory, String recipe, AgentWorkOrder.Budget budget) {
        CraftRequest request = craftRequest(recipe);
        if (request == null || budget.craftsLeft() <= 0) return null;
        Item exact = null;
        if (request.recipe == Recipe.BOAT) {
            if (recipe.equals("boat")) return null;
            String wood = recipe.equals("bamboo_raft") ? "bamboo" : recipe.substring(0, recipe.length() - "_boat".length());
            exact = Registries.ITEM.get(Identifier.ofVanilla(wood + "_planks"));
        }
        int examined = 0;
        for (String row : request.recipe.rows) for (int cell = 0; cell < row.length(); ++cell) {
            char token = row.charAt(cell);
            if (token == ' ') continue;
            int bit = 1 << (token - 'a');
            if ((examined & bit) != 0) continue;
            examined |= bit;
            int required = 0;
            for (String line : request.recipe.rows) for (int i = 0; i < line.length(); ++i)
                if (line.charAt(i) == token) ++required;
            WorkNeed ingredient = new WorkNeed(token, recipe, exact, required);
            int available = 0;
            for (int i = 0; i < PlayerInventory.MAIN_SIZE && available < required; ++i) {
                ItemStack stack = inventory.getStack(i);
                if (stack.isEmpty() || !ingredient.matches(stack)) continue;
                Item item = stack.getItem();
                boolean tallied = false;
                for (int j = 0; j < i && !tallied; ++j) tallied = inventory.getStack(j).isOf(item);
                if (!tallied) available += budget.limit(item, AgentWorkOrder.count(inventory, item));
            }
            if (required > available) return new WorkNeed(token, recipe, exact, required - available);
        }
        return null;
    }

    boolean workCraftable(String recipe, AgentWorkOrder.Budget budget) {
        return budget.craftsLeft() > 0 && workRecipe(recipe) && budget.policy.craftAllowed(recipe)
            && findCraftPlan(new CraftRequest[] { craftRequest(recipe) }, 0, budget) != null;
    }

    boolean craftWork(String recipe, int executions, AgentWorkOrder.Budget budget) {
        return executions > 0 && budget.policy.craftAllowed(recipe)
            && craftBatch(java.util.Collections.nCopies(Math.min(executions, budget.craftsLeft()), recipe), budget);
    }

    boolean stableCraftFooting() {
        var p = c.player;
        return p != null && p.isOnGround() && !p.isTouchingWater() && !p.isInLava()
            && !p.hasVehicle() && p.getVelocity().horizontalLengthSquared() <= 0.0025;
    }

    boolean craftBatch(List<String> recipes) {
        return craftBatch(recipes, null);
    }

    private boolean craftBatch(List<String> recipes, AgentWorkOrder.Budget budget) {
        boolean retained = holdsWorkInventory();
        if (busy() || (retained ? budget == null || !workInventoryReady() : !stableCraftFooting())) return false;
        if (recipes.isEmpty()) return report("craft", "no recipes");
        var current = c.currentScreen;
        if (current != null && !(current instanceof InventoryScreen || current instanceof CraftingScreen))
            return report("craft", "incompatible screen");
        if (!retained && current instanceof HandledScreen<?> handled && !cleanGrid(handled))
            return report("craft", "crafting grid or cursor occupied");
        if (current == null && c.options.inventoryKey.isUnbound())
            return report("craft", "inventory key unbound");

        CraftRequest[] requests = new CraftRequest[recipes.size()];
        int i = 0;
        for (String item : recipes) {
            CraftRequest request = craftRequest(item);
            if (request == null) return report("craft", "unsupported recipe " + item);
            if (request.recipe.needsTable() && !(current instanceof CraftingScreen))
                return report("craft", "crafting table required for " + request.key);
            requests[i++] = request;
        }
        CraftRequest first = requests[0];
        if (findCraftPlan(requests, 0, budget) == null)
            return report("craft", "missing compatible ingredients or storage room for " + first.key);

        String name = requests.length == 1 ? "craft " + first.key : "craft batch (" + requests.length + ")";
        start(Job.CRAFT, name, (HandledScreen<?>) current);
        crafts = requests;
        craftBudget = budget;
        inventoryNeeded = true;
        return true;
    }

    private static CraftRequest craftRequest(String item) {
        if (item == null) return null;
        String key = item.startsWith("minecraft:") ? item.substring("minecraft:".length()) : item;
        Recipe recipe = switch (key) {
            case "planks" -> Recipe.PLANKS;
            case "boat" -> Recipe.BOAT;
            case "crafting_table" -> Recipe.CRAFTING_TABLE;
            case "stick", "sticks" -> Recipe.STICK;
            case "wooden_pickaxe" -> Recipe.WOODEN_PICKAXE;
            case "wooden_shovel" -> Recipe.WOODEN_SHOVEL;
            case "wooden_axe" -> Recipe.WOODEN_AXE;
            case "stone_pickaxe" -> Recipe.STONE_PICKAXE;
            case "stone_shovel" -> Recipe.STONE_SHOVEL;
            case "stone_axe" -> Recipe.STONE_AXE;
            case "furnace" -> Recipe.FURNACE;
            case "iron_pickaxe" -> Recipe.IRON_PICKAXE;
            case "iron_shovel" -> Recipe.IRON_SHOVEL;
            case "diamond_pickaxe" -> Recipe.DIAMOND_PICKAXE;
            case "bucket" -> Recipe.BUCKET;
            case "flint_and_steel" -> Recipe.FLINT_AND_STEEL;
            case "stone_sword" -> Recipe.STONE_SWORD;
            case "shield" -> Recipe.SHIELD;
            case "iron_chestplate" -> Recipe.IRON_CHESTPLATE;
            case "iron_leggings" -> Recipe.IRON_LEGGINGS;
            case "iron_helmet" -> Recipe.IRON_HELMET;
            case "iron_boots" -> Recipe.IRON_BOOTS;
            case "torch", "torches" -> Recipe.TORCH;
            default -> {
                if (vanillaBoat(key) != null) yield Recipe.BOAT;
                Identifier id = key.endsWith("_planks") && key.indexOf(':') < 0 ? Identifier.tryParse(key) : null;
                yield id != null && Registries.ITEM.get(id).getRegistryEntry().isIn(ItemTags.PLANKS)
                        ? Recipe.PLANKS : null;
            }
        };
        if (recipe == Recipe.STICK) key = "stick";
        if (recipe == Recipe.TORCH) key = "torch";
        return recipe == null ? null : new CraftRequest(recipe, key);
    }

    static boolean workSmeltFuel(Item item) {
        return fuelRank(item) != Integer.MAX_VALUE;
    }

    static int ironFuelNeeded(int units, int fuelTicks) {
        return Math.ceilDiv(units * SMELT_TICKS, fuelTicks);
    }

    static IronBatch quoteIron(PlayerInventory inventory, AgentWorkOrder.Budget budget, int wanted,
                              ToIntFunction<Item> fuelValue) {
        if (!budget.policy.smeltIron()) return null;
        int available = Math.min(Math.min(wanted, budget.craftsLeft()),
            budget.limit(Items.RAW_IRON, AgentWorkOrder.count(inventory, Items.RAW_IRON)));
        if (available <= 0) return null;
        IronBatch best = null;
        for (Item item : budget.policy.caps().keySet()) {
            if (!workSmeltFuel(item)) continue;
            int stock = Math.min(64, budget.limit(item, AgentWorkOrder.count(inventory, item)));
            if (stock == 0) continue;
            int heat = fuelValue.applyAsInt(item);
            if (heat <= 0) continue;
            int units = (int) Math.min(available, (long) heat * stock / SMELT_TICKS);
            if (units == 0) continue;
            int fuelCount = ironFuelNeeded(units, heat);
            if (best == null || units > best.units || units == best.units
                    && (fuelCount < best.fuelCount || fuelCount == best.fuelCount
                        && Registries.ITEM.getId(item).compareTo(Registries.ITEM.getId(best.fuel)) < 0))
                best = new IronBatch(units, item, fuelCount, heat);
        }
        return best;
    }

    IronBatch quoteIron(AgentWorkOrder.Budget budget, int wanted) {
        var fuels = c.world.getFuelRegistry();
        return quoteIron(c.player.getInventory(), budget, wanted, item -> fuels.getFuelTicks(new ItemStack(item)));
    }

    boolean loadWorkIron(FurnaceScreen furnace, IronBatch batch, AgentWorkOrder.Budget budget) {
        if (!canWorkFurnace(furnace)) return report("smelt", "no exact clean furnace screen");
        var handler = furnace.getScreenHandler();
        Slot input = handler.getSlot(0), fuel = handler.getSlot(1);
        if (input.hasStack() || fuel.hasStack() || handler.getOutputSlot().hasStack() || handler.isBurning()
                || !((AgentFurnaceSync) handler).agent$furnaceContentsSynced())
            return report("smelt", "furnace was not confirmed empty and cold");
        if (!storageRoom(new ItemStack(Items.IRON_INGOT), batch.units, null))
            return report("smelt", "no safe ingot storage");
        if (c.world.getFuelRegistry().getFuelTicks(new ItemStack(batch.fuel)) != batch.fuelTicks
                || !budget.reserveIronSmelt(c.player.getInventory(), batch.units, batch.fuel, batch.fuelCount, batch.fuelTicks))
            return report("smelt", "the exact input, fuel or execution budget changed");

        start(Job.SMELT, "smelt", furnace);
        boundedIron = batch;
        smeltBudget = budget;
        scopedSmelt = true;
        // Finish all fuel gestures while cold; raw iron is the only thing that may start the burn.
        if (!queueFurnaceTransfers(handler, fuel, batch.fuel, batch.fuelCount)
                || !queueFurnaceTransfers(handler, input, Items.RAW_IRON, batch.units)) {
            finish("the bounded source stacks changed");
            return false;
        }
        planned = true;
        return true;
    }

    boolean collectWorkIron(FurnaceScreen furnace, int units, long afterOutputSync) {
        if (!canWorkFurnace(furnace)) return report("smelt", "no exact clean furnace screen");
        var handler = furnace.getScreenHandler();
        Slot output = handler.getOutputSlot();
        if (!AgentFurnaceWatch.exactResult(units, afterOutputSync,
                ((AgentFurnaceSync) handler).agent$furnaceOutputUpdates(),
                handler.getSlot(0).getStack(), handler.getSlot(1).getStack(), output.getStack()))
            return report("smelt", "the witnessed result changed");
        return collectSmelt(furnace, output, units);
    }

    boolean returnWorkIron(FurnaceScreen furnace, int units) {
        if (!canWorkFurnace(furnace)) return report("smelt", "no exact clean furnace screen");
        var handler = furnace.getScreenHandler();
        Slot input = handler.getSlot(0);
        if (handler.isBurning() || !input.getStack().isOf(Items.RAW_IRON) || input.getStack().getCount() != units)
            return report("smelt", "the cold input no longer matches the paid raw iron");
        return collectSmelt(furnace, input, units);
    }

    boolean closeWorkFurnaceWithEscape(FurnaceScreen furnace) {
        if (!canWorkFurnace(furnace) || !c.isWindowFocused() || c.getOverlay() != null) return false;
        long window = c.getWindow().getHandle();
        if (glfwGetKey(window, GLFW_KEY_ESCAPE) != GLFW_RELEASE) return false;
        var keyboard = (AgentKeyboardAccess) c.keyboard;
        int scan = glfwGetKeyScancode(GLFW_KEY_ESCAPE);
        keyboard.agent$onKey(window, GLFW_KEY_ESCAPE, scan, GLFW_PRESS, 0);
        keyboard.agent$onKey(window, GLFW_KEY_ESCAPE, scan, GLFW_RELEASE, 0);
        return c.currentScreen == null && c.player.currentScreenHandler == c.player.playerScreenHandler;
    }

    private boolean canWorkFurnace(FurnaceScreen furnace) {
        return !busy() && !holdsWorkInventory() && stableCraftFooting() && c.currentScreen == furnace
            && c.player.currentScreenHandler == furnace.getScreenHandler()
            && furnace.getScreenHandler().getCursorStack().isEmpty()
            && pointerAvailable() && !Screen.hasShiftDown() && !physicalButtonDown(c.getWindow())
            && !((AgentHandledScreenAccess) furnace).agent$cursorDragging();
    }

    private boolean queueFurnaceTransfers(ScreenHandler handler, Slot target, Item item, int remaining) {
        for (Slot slot : handler.slots) {
            if (!isStorage(slot) || !slot.getStack().isOf(item)) continue;
            int amount = Math.min(remaining, slot.getStack().getCount());
            transfer(slot, target, amount, true);
            remaining -= amount;
            if (remaining == 0) return true;
        }
        return false;
    }

    private boolean collectSmelt(FurnaceScreen furnace, Slot output, int exactUnits) {
        ItemStack finished = output.getStack();
        if (!storageRoom(finished, null)) return report("smelt", "inventory full");
        start(Job.SMELT, "smelt", furnace);
        scopedSmelt = exactUnits > 0;
        steps.addLast(new Step(Mode.RESULT, output, finished.getItem(), exactUnits));
        planned = storeResult = true;
        return true;
    }

    boolean smelt(boolean charcoal, int batchLimit) {
        if (busy() || c.player == null || c.world == null) return false;
        if (!(c.currentScreen instanceof FurnaceScreen furnace)) return report("smelt", "furnace required");
        var handler = furnace.getScreenHandler();
        if (!handler.getCursorStack().isEmpty()) return report("smelt", "cursor occupied");
        Slot input = handler.getSlot(0), fuel = handler.getSlot(1), output = handler.getOutputSlot();
        ItemStack finished = output.getStack();
        if (!finished.isEmpty()) {
            if (!finished.isOf(charcoal ? Items.CHARCOAL : Items.IRON_INGOT))
                return report("smelt", "unrelated furnace output");
            return collectSmelt(furnace, output, 0);
        }

        var fuels = c.world.getFuelRegistry();
        ItemStack fuelStack = fuel.getStack();
        int installedHeat = fuels.getFuelTicks(fuelStack) * fuelStack.getCount();
        if (!handler.isBurning() && !fuelStack.isEmpty() && installedHeat == 0)
            return report("smelt", "fuel slot occupied");
        Slot inputSource = null;
        int inputCount = input.getStack().getCount();
        if (inputCount == 0) {
            inputSource = findStorage(handler, charcoal ? stack -> stack.isIn(ItemTags.LOGS_THAT_BURN)
                    : stack -> stack.isOf(Items.RAW_IRON));
            if (inputSource == null) return report("smelt", "no input");
            inputCount = Math.min(inputSource.getStack().getCount(), batchLimit);
        } else {
            ItemStack existing = input.getStack();
            if (!(charcoal ? existing.isIn(ItemTags.LOGS_THAT_BURN) : existing.isOf(Items.RAW_IRON)))
                return report("smelt", "unrelated furnace input");
            if (handler.isBurning() || installedHeat > 0) return report("smelt", "cooking");
        }

        Slot fuelSource = null;
        int fuelCount = 0;
        int heat = installedHeat;
        int requiredTicks = Math.min(batchLimit, inputCount) * SMELT_TICKS;
        if (installedHeat < requiredTicks) {
            int bestRank = Integer.MAX_VALUE;
            int bestRecipes = Math.min(requiredTicks, installedHeat) / SMELT_TICKS;
            for (Slot slot : handler.slots) {
                if (!isStorage(slot) || slot == inputSource || !slot.hasStack()) continue;
                ItemStack stack = slot.getStack();
                int rank = fuelRank(stack.getItem());
                if (rank == Integer.MAX_VALUE) continue;
                int ticks = fuels.getFuelTicks(stack);
                if (ticks <= 0) continue;
                int quantity = Math.min(stack.getCount(), room(fuel, stack));
                int recipes = Math.min(requiredTicks, installedHeat + ticks * quantity) / SMELT_TICKS;
                if (recipes <= installedHeat / SMELT_TICKS
                        || recipes < bestRecipes || recipes == bestRecipes && rank >= bestRank) continue;
                bestRank = rank;
                bestRecipes = recipes;
                fuelSource = slot;
                fuelCount = Math.min(quantity, (recipes * SMELT_TICKS - installedHeat + ticks - 1) / ticks);
                heat = installedHeat + fuelCount * ticks;
            }
        }
        // Quote heat against the current slots, after any workshop crafting. Only a live
        // burn can justify trying one item without a full 200 ticks in the fuel slot.
        int affordable = Math.max(heat / SMELT_TICKS, handler.isBurning() ? 1 : 0);
        if (affordable == 0) return report("smelt", "no fuel");
        inputCount = Math.min(inputCount, affordable);

        start(Job.SMELT, "smelt", furnace);
        // In a cold, empty furnace, finish loading the fuel before the input can ignite it.
        if (fuelSource != null) transfer(fuelSource, fuel, fuelCount, false);
        if (inputSource != null) transfer(inputSource, input, inputCount, false);
        planned = true;
        return true;
    }

    boolean prepareSmeltFuel(boolean reserveLog) {
        var inventory = c.player.getInventory();
        if (reserveLog && count(stack -> stack.isIn(ItemTags.LOGS_THAT_BURN)) <= 1) return false;
        for (int i = 0; i < PlayerInventory.MAIN_SIZE; i++) {
            ItemStack stack = inventory.getStack(i);
            if (stack.isEmpty() || !stack.isIn(ItemTags.LOGS_THAT_BURN)) continue;
            Item planks = planksFor(stack);
            if (planks != null && c.world.getFuelRegistry().getFuelTicks(new ItemStack(planks)) > 0)
                return craft(Registries.ITEM.getId(planks).getPath());
        }
        return false;
    }

    /** Returns true if the item is already held or an equip job was queued. */
    boolean equip(Predicate<ItemStack> item) {
        if (c.player == null) return false;
        var inv = c.player.getInventory();
        if (item.test(inv.getMainHandStack())) return true;
        return !busy() && queueEquip(inv, item);
    }

    /** Requests selection if needed; returns true only when Hands is idle and the main hand matches. */
    boolean equipForUse(Predicate<ItemStack> item) {
        if (c.player == null || busy()) return false;
        var inv = c.player.getInventory();
        if (item.test(inv.getMainHandStack())) return true;
        queueEquip(inv, item);
        return false;
    }

    private boolean queueEquip(PlayerInventory inv, Predicate<ItemStack> item) {
        for (int slot = 0; slot < PlayerInventory.MAIN_SIZE; slot++) {
            if (!item.test(inv.getStack(slot))) continue;
            int destination = equipDestination(inv, slot);
            if (destination >= 0) return queueEquip(inv, slot, destination);
        }
        return report("equip", "item or usable hotbar slot unavailable");
    }

    /** False may mean pending; once a storage item moves, reevaluate the current hotbar. */
    boolean equipSlot(int slot) {
        if (c.player == null || slot < 0 || slot >= PlayerInventory.MAIN_SIZE) return false;
        var inv = c.player.getInventory();
        if (inv.selectedSlot == slot) return true;
        if (!busy()) {
            int destination = equipDestination(inv, slot);
            if (destination >= 0) queueEquip(inv, slot, destination);
            else report("equip", "slot or usable hotbar key unavailable");
        }
        return false;
    }

    private int equipDestination(PlayerInventory inv, int source) {
        if (source < PlayerInventory.HOTBAR_SIZE)
            return c.options.hotbarKeys[source].isUnbound() ? -1 : source;
        ItemStack stack = inv.getStack(source);
        if (stack.isEmpty()) return inv.getMainHandStack().isEmpty() ? -1 : inv.selectedSlot;
        return hotbarDestination(inv, stack);
    }

    private boolean queueEquip(PlayerInventory inv, int source, int destination) {
        if (holdsWorkInventory()) return false;
        if (c.currentScreen != null && !(c.currentScreen instanceof InventoryScreen))
            return report("equip", "incompatible screen");
        var inventory = (InventoryScreen) c.currentScreen;
        if (inventory != null && !inventory.getScreenHandler().getCursorStack().isEmpty())
            return report("equip", "cursor occupied");
        boolean transfer = source != destination;
        if (transfer && inventory == null && c.options.inventoryKey.isUnbound())
            return report("equip", "inventory key unbound");

        start(Job.EQUIP, "equip", inventory);
        equipStack = inv.getStack(source).copy();
        equipSource = source;
        hotbar = destination;
        inventoryNeeded = transfer;
        planned = !transfer;
        return true;
    }

    void cancel() {
        if (busy()) finish("cancelled");
        else releaseWorkInventory(true);
    }

    void discardLifeInputs() {
        // The server and vanilla own the closing/dropping behavior on death.
        if (busy()) finish("cancelled", false);
        else releaseWorkInventory(false);
        buttonMotion.reset();
    }

    void frame() {
        if (click == null || !ownsScreen() || !pointerAvailable()) return;
        if (click.drag != null && click.drag.down) {
            if (!click.drag.released) dragFrame(System.nanoTime());
            return;
        }
        Slot slot = click.step.slot;
        if (slot != null && (!slot.isEnabled() || bookHidesSlots())) return;
        if (slot == null && !click.pressed && (!click.bookButton.visible || !click.bookButton.active)) return;
        var layout = (AgentHandledScreenAccess) screen;
        double left = slot != null ? layout.agent$x() + slot.x : click.bookButton.getX();
        double top = slot != null ? layout.agent$y() + slot.y : click.bookButton.getY();
        double width = slot != null ? SLOT_SIZE : click.bookButton.getWidth();
        double height = slot != null ? SLOT_SIZE : click.bookButton.getHeight();
        if (left < 0 || top < 0 || left + width > screen.width || top + height > screen.height
                || width <= 0 || height <= 0) {
            if (!click.pressed) click.motion.reset();
            return;
        }
        var motion = click.motion;
        var window = c.getWindow();
        double scaleX = (double) window.getScaledWidth() / window.getWidth();
        double scaleY = (double) window.getScaledHeight() / window.getHeight();
        long now = System.nanoTime();
        if (!motion.matches(left, top, width, height, scaleX, scaleY)) {
            if (click.pressed) return; // A relayout must never launch a new stroke under a pressed button.
            sampleCursor(window.getHandle());
            double x = mouseX[0] * scaleX, y = mouseY[0] * scaleY;
            var next = steps.peekFirst();
            Slot nextSlot = click.drag != null ? click.drag.slots[1] : next == null ? null : next.slot;
            boolean precise = slot == null || click.step.mode == Mode.SWAP
                    || nextSlot == slot || c.options.getTouchscreen().getValue();
            boolean carry = !precise && handoffAt != 0 && now - handoffAt < POINTER_HANDOFF
                    && x == handoffX && y == handoffY;
            motion.plan(now, x, y, left, top, width, height, scaleX, scaleY, precise,
                    carry ? handoffVx : 0, carry ? handoffVy : 0,
                    nextSlot == null ? left + width * .5 : layout.agent$x() + nextSlot.x + SLOT_SIZE * .5,
                    nextSlot == null ? top + height * .5 : layout.agent$y() + nextSlot.y + SLOT_SIZE * .5);
            handoffAt = 0;
            click.firstEntry = click.lastEntry = 0;
            click.inTarget = false;
            if (!hit(click, motion.landingX, motion.landingY)) {
                motion.reset();
                return;
            }
        }
        if (!motion.settled && !click.holdTail) {
            sampleCursor(window.getHandle());
            double beforeX = mouseX[0] * scaleX, beforeY = mouseY[0] * scaleY;
            if (click.pressed) {
                // Do not pull a pointer that has left the target back under a held click.
                if (!motion.inside(beforeX, beforeY) || !hit(click, beforeX, beforeY)) {
                    click.holdTail = true;
                    return;
                }
            }
            motion.advance(now);
            // The only motion allowed during a press is the bounded tail in this exact target.
            if (!click.pressed || motion.inside(motion.x, motion.y) && hit(click, motion.x, motion.y))
                moveCursor(window, motion.x, motion.y, scaleX, scaleY);
            sampleCursor(window.getHandle());
            double afterX = mouseX[0] * scaleX, afterY = mouseY[0] * scaleY;
            if (Math.hypot(beforeX - motion.landingX, beforeY - motion.landingY)
                    - Math.hypot(afterX - motion.landingX, afterY - motion.landingY) >= 0.5) ++workEvidence;
        }
        sampleCursor(window.getHandle());
        observePointer(click, now, mouseX[0] * scaleX, mouseY[0] * scaleY);
    }

    boolean pointAtButton(ButtonWidget button, boolean changedTarget) {
        if (!pointerAvailable()) {
            buttonMotion.reset();
            return false;
        }
        var window = c.getWindow();
        double scaleX = (double) window.getScaledWidth() / window.getWidth();
        double scaleY = (double) window.getScaledHeight() / window.getHeight();
        int left = button.getX(), top = button.getY(), width = button.getWidth(), height = button.getHeight();
        if (width <= 0 || height <= 0) return false;
        long now = System.nanoTime();
        if (changedTarget || !buttonMotion.matches(left, top, width, height, scaleX, scaleY)) {
            sampleCursor(window.getHandle());
            buttonMotion.plan(now, mouseX[0] * scaleX, mouseY[0] * scaleY,
                    left, top, width, height, scaleX, scaleY, true, 0, 0,
                    left + width * .5, top + height * .5);
        }
        if (!buttonMotion.settled) {
            buttonMotion.advance(now);
            moveCursor(window, buttonMotion.x, buttonMotion.y, scaleX, scaleY);
        }
        sampleCursor(window.getHandle());
        if (buttonMotion.settled && !button.isMouseOver(mouseX[0] * scaleX, mouseY[0] * scaleY)) {
            buttonMotion.reset();
            return false;
        }
        return buttonMotion.settled;
    }

    enum ButtonPress { NOT_READY, ACCEPTED, REJECTED }

    ButtonPress pressButton(Screen shown, ButtonWidget button) {
        if (!buttonMotion.planned || !buttonMotion.settled || c.currentScreen != shown
                || !pointerAvailable() || !button.visible || !button.active)
            return ButtonPress.NOT_READY;
        var window = c.getWindow();
        sampleCursor(window.getHandle());
        double scaleX = (double) window.getScaledWidth() / window.getWidth();
        double scaleY = (double) window.getScaledHeight() / window.getHeight();
        double x = mouseX[0] * scaleX, y = mouseY[0] * scaleY;
        if (!button.isMouseOver(x, y) || !button.isMouseOver(c.mouse.getX() * scaleX, c.mouse.getY() * scaleY)) {
            buttonMotion.reset();
            return ButtonPress.NOT_READY;
        }
        c.setNavigationType(GuiNavigationType.MOUSE);
        boolean accepted = shown.mouseClicked(x, y, GLFW_MOUSE_BUTTON_LEFT) && !button.active;
        if (c.currentScreen == shown) {
            sampleCursor(window.getHandle());
            shown.mouseReleased(mouseX[0] * scaleX, mouseY[0] * scaleY, GLFW_MOUSE_BUTTON_LEFT);
        }
        return accepted ? ButtonPress.ACCEPTED : ButtonPress.REJECTED;
    }

    private void moveCursor(Window window, double x, double y, double scaleX, double scaleY) {
        glfwSetCursorPos(window.getHandle(),
                Math.max(0, Math.min(window.getWidth() - 1, x / scaleX)),
                Math.max(0, Math.min(window.getHeight() - 1, y / scaleY)));
    }

    void tick() {
        if (!busy()) return;
        long now = System.nanoTime();
        if (c.player != player || player == null || player.isDead()) {
            finish("interrupted");
            return;
        }
        if (now >= deadline) {
            finish(click == null ? "timed out" : "timed out on " + (click.step.slot == null
                    ? "recipe book" : click.step.mode + " slot " + click.step.slot.id));
            return;
        }
        if (screen == null) {
            if (job == Job.CRAFT && !stableCraftFooting()) {
                finish("lost dry footing before opening the inventory");
                return;
            }
            if (!inventoryNeeded) {
                selectHotbar(now);
                return;
            }
            if (pendingKey != null && c.currentScreen instanceof InventoryScreen inventory) {
                pendingKey = null;
                screen = inventory;
            } else {
                if (c.currentScreen != null) finish("screen changed");
                else if (pendingKey == null) tap(c.options.inventoryKey, now);
                else if (now >= keyDeadline) finish("inventory did not open");
                return;
            }
        }
        if (!ownsScreen()) {
            finish("screen changed");
            return;
        }
        if (!pointerAvailable()) {
            finish("window not available");
            return;
        }
        if (scopedSmelt && (Screen.hasShiftDown() || physicalButtonDown(c.getWindow()))) {
            finish("another input gesture took the furnace pointer");
            return;
        }
        if (click != null) {
            if (!advanceClick(now) || !busy()) return;
            if (!ownsScreen()) {
                finish("screen changed");
                return;
            }
        }

        if ((job != Job.EQUIP || inventoryNeeded) && bookHidesSlots()) {
            TexturedButtonWidget toggle = null;
            for (var child : screen.children()) {
                if (child instanceof TexturedButtonWidget button && button.visible && button.active) {
                    if (toggle != null) {
                        finish("recipe book toggle ambiguous");
                        return;
                    }
                    toggle = button;
                }
            }
            if (toggle == null) finish("recipe book hides inventory");
            else click = new Click(clickMotion, new Step(Mode.CLEAR_BOOK, null, null, 0),
                    toggle, ItemStack.EMPTY, ItemStack.EMPTY);
            return;
        }
        if (!planned) {
            if (job == Job.CRAFT) {
                if (!planNextCraft()) return;
            } else if (!planEquip()) {
                finish("inventory changed before equip");
                return;
            }
            planned = true;
        }
        if (!steps.isEmpty()) {
            Step next = steps.peekFirst();
            ItemStack stack = next.slot.getStack();
            if (isResult(next) && (!matches(stack, next) || job == Job.CRAFT
                    && screen.getScreenHandler().getRevision() == craftGridRevision)) {
                if (resultDeadline == 0) resultDeadline = now + RESULT_TIMEOUT;
                if (now >= resultDeadline) finish("expected result not visible");
                return;
            }
            steps.removeFirst();
            prepareClick(next);
            return;
        }
        ItemStack carried = screen.getScreenHandler().getCursorStack();
        if (storeResult && !carried.isEmpty()) {
            Slot dest = resultDestination(screen.getScreenHandler(), carried);
            if (dest == null) finish("inventory full");
            else prepareClick(new Step(Mode.STORE, dest, carried.getItem(), 0));
            return;
        }
        if (!carried.isEmpty()) {
            finish("cursor not empty");
        } else if (storeResult && !resultStored) {
            finish("result not stored");
        } else if (job == Job.CRAFT) {
            completeCraft(now);
        } else if (job == Job.EQUIP) {
            closeScreen();
            inventoryNeeded = false;
            selectHotbar(now);
        } else {
            finish("done");
        }
    }

    /** True only after release and the expected local effect; the next approach can then start this frame. */
    private boolean advanceClick(long now) {
        if (click.drag != null && click.drag.down) return advanceDrag(now);
        if (!click.motion.planned || Screen.hasShiftDown()) return false;
        Slot slot = click.step.slot;
        if (slot != null && (!slot.isEnabled() || bookHidesSlots())) {
            finish("slot is no longer visible");
            return false;
        }
        boolean leftSlotPress = slot != null && click.button == GLFW_MOUSE_BUTTON_LEFT;
        if (!click.pressed && leftSlotPress && slot == lastLeftSlot && now < nextSameLeftPress) return false;
        var window = c.getWindow();
        sampleCursor(window.getHandle());
        double scaleX = (double) window.getScaledWidth() / window.getWidth();
        double scaleY = (double) window.getScaledHeight() / window.getHeight();
        double x = mouseX[0] * scaleX, y = mouseY[0] * scaleY;
        var motion = click.motion;
        if (!click.pressed && !layoutStillMatches(click, scaleX, scaleY)) return false;
        observePointer(click, now, x, y);
        if (!click.pressed && !motion.ready()) return false;
        if (!hit(click, x, y) || !hit(click, c.mouse.getX() * scaleX, c.mouse.getY() * scaleY)) {
            if (click.pressed) finish("cursor moved during press");
            else if (motion.settled) motion.reset();
            return false;
        }
        var handler = screen.getScreenHandler();
        if (!click.pressed) {
            if (!motion.inside(x, y)) {
                if (motion.settled) motion.reset();
                return false;
            }
            if (click.step.mode != Mode.CLEAR_BOOK && (!clickTargetReady(handler.getCursorStack())
                    || !boundedFurnaceDeposit(handler.getCursorStack()))) {
                finish("slot changed before press");
                return false;
            }
            boolean craftOutput = job == Job.CRAFT && isResult(click.step);
            if (craftOutput && (!craftReady((AbstractCraftingScreenHandler) handler) || !admitCraftSpend())) {
                finish("ingredients or storage changed before craft output");
                return false;
            }
            c.setNavigationType(GuiNavigationType.MOUSE);
            if (craftOutput) craftTakeRevision = handler.getRevision();
            if (click.drag != null) {
                if (physicalButtonDown(window) || ((AgentHandledScreenAccess) screen).agent$cursorDragging()) {
                    finish("another mouse gesture is already active");
                    return false;
                }
                if (beginDrag(handler, window, scaleX, scaleY, x, y, now)) return false;
                click.drag = null; // No input was sent; the original steps are still queued.
            }
            if (pointerEvidence != null) {
                click.pressAt = now;
                click.pressWallMs = System.currentTimeMillis();
                click.pressX = x;
                click.pressY = y;
                click.pressOffsetX = motion.offsetX(x);
                click.pressOffsetY = motion.offsetY(y);
                click.pressVx = motion.vx;
                click.pressVy = motion.vy;
                click.pressSettled = motion.settled;
                click.pressRevision = handler.getRevision();
            }
            if (click.step.mode == Mode.QUICK_RESULT) {
                if (!((AgentCraftClick) screen).agent$shiftClickResult(slot, x, y)) {
                    finish("vanilla rejected crafting Shift click");
                    return false;
                }
                craftShiftClicks++;
            } else if (!screen.mouseClicked(x, y, click.button)) {
                finish("vanilla rejected click");
                return false;
            }
            if (leftSlotPress) {
                lastLeftSlot = slot;
                nextSameLeftPress = now + LEFT_CLICK_INTERVAL;
            }
            click.pressed = true;
            return false;
        }

        // Vanilla places a carried stack on release, and the furnace may have ticked since press.
        if (isFurnacePlacement() && (!clickTargetReady(handler.getCursorStack())
                || !boundedFurnaceDeposit(handler.getCursorStack()))) {
            finish("furnace slot changed before release");
            return false;
        }
        if (job == Job.CRAFT && (click.step.mode == Mode.ONE || click.step.mode == Mode.PUT)
                && !isStorage(slot)) craftGridRevision = handler.getRevision();
        screen.mouseReleased(x, y, click.button);
        ItemStack cursor = handler.getCursorStack();
        boolean book = click.step.mode == Mode.CLEAR_BOOK;
        boolean effect = book ? !bookHidesSlots() : clickEffect(click, cursor);
        recordPointer(click, x, y, true, effect ? (click.step.mode == Mode.QUICK_RESULT
                ? "awaiting craft receipt" : "local effect observed") : "effect missing");
        if (!effect) {
            finish(book ? "recipe book did not close" : "slot gesture had no expected effect");
            return false;
        }
        if (boundedIron != null && isFurnacePlacement()) {
            int deposited = click.cursorBefore.getCount() - cursor.getCount();
            if (slot.id == 0) ironDeposited += deposited;
            else fuelDeposited += deposited;
        }
        if (!book && click.step.mode != Mode.QUICK_RESULT) ++workEvidence;
        if (click.step.mode == Mode.STORE && cursor.isEmpty()) resultStored = true;
        if (!motion.settled && !click.holdTail && layoutStillMatches(click, scaleX, scaleY) && motion.inside(x, y)) {
            handoffAt = now;
            handoffX = x;
            handoffY = y;
            handoffVx = motion.vx;
            handoffVy = motion.vy;
        }
        return finishGesture(now);
    }

    private boolean finishGesture(long now) {
        deadline = now + ACTION_TIMEOUT;
        if (previousFailure) {
            previousFailure = false;
            status = label + ": working";
        }
        click = null;
        return true;
    }

    /** False means no button edge was dispatched; the ordinary click can still be used. */
    private boolean beginDrag(ScreenHandler handler, Window window, double scaleX, double scaleY,
                              double x, double y, long now) {
        Drag drag = click.drag;
        var layout = (AgentHandledScreenAccess) screen;
        if (!dragInputAvailable(window)) return false;
        ItemStack cursor = handler.getCursorStack();
        // Vanilla admits the next slot only while carried count exceeds the current preview size.
        // At commit it requires count >= final size. Exactly N is valid for a stroke over N cells.
        if (cursor.getCount() < drag.slots.length) return false;
        drag.left = layout.agent$x();
        drag.top = layout.agent$y();
        Slot first = drag.slots[0], last = drag.last();
        double directionX = Integer.signum(last.x - first.x), directionY = Integer.signum(last.y - first.y);
        drag.endX = directionX == 0 ? x : drag.left + last.x + SLOT_SIZE * .5 + directionX * 4;
        drag.endY = directionY == 0 ? y : drag.top + last.y + SLOT_SIZE * .5 + directionY * 4;
        for (Slot slot : drag.slots) {
            if (!slot.isEnabled() || room(slot, cursor) < 1 || !handler.canInsertIntoSlot(slot)
                    || !ScreenHandler.canInsertItemIntoSlot(slot, cursor, true)
                    || drag.left + slot.x < 0 || drag.top + slot.y < 0
                    || drag.left + slot.x + SLOT_SIZE > screen.width
                    || drag.top + slot.y + SLOT_SIZE > screen.height) return false;
            double laneX = directionX == 0 ? x : drag.left + slot.x + SLOT_SIZE * .5;
            double laneY = directionY == 0 ? y : drag.top + slot.y + SLOT_SIZE * .5;
            if (layout.agent$slotAt(laneX, laneY) != slot) return false;
        }
        if (layout.agent$slotAt(drag.endX, drag.endY) != last) return false;

        drag.before = new ItemStack[handler.slots.size()];
        for (int i = 0; i < drag.before.length; i++)
            drag.before[i] = i == first.id ? click.slotBefore : handler.getSlot(i).getStack().copy();
        drag.x = drag.commandX = x;
        drag.y = drag.commandY = y;
        drag.scaleX = scaleX;
        drag.scaleY = scaleY;
        drag.speed = Math.max(45, Math.min(125, 70 + .42 * (directionX * click.motion.vx + directionY * click.motion.vy)));
        drag.movedAt = now;
        drag.sequence = now; // Monotonic within this native process, even if Hands is replaced on respawn.
        drag.down = true;
        int revision = handler.getRevision();
        boolean accepted = screen.mouseClicked(x, y, GLFW_MOUSE_BUTTON_RIGHT);
        recordDrag(drag, "down", first, revision, "dispatched");
        if (!accepted || !dragPreviewMatches(drag) || !dragStacksMatch(drag, false)) {
            finish("vanilla did not begin the expected right drag");
            return true;
        }
        for (int i = 1; i < drag.slots.length; i++) steps.removeFirst();
        return true;
    }

    private void dragFrame(long now) {
        Drag drag = click.drag;
        Window window = c.getWindow();
        if (!dragHeld(drag, window)) {
            finish("right drag changed before move");
            return;
        }
        double remainingX = drag.endX - drag.commandX, remainingY = drag.endY - drag.commandY;
        double remaining = Math.abs(remainingX) + Math.abs(remainingY);
        if (remaining == 0) return;
        // Advance the single lane, not a new stop-and-start path to each cell. Cap a slow frame's
        // move well below one cell so no required native slot entry can be skipped.
        double elapsed = Math.min(.03, (now - drag.movedAt) * 1e-9);
        drag.speed = Math.min(Math.min(245, 75 + remaining * 12), drag.speed + elapsed * 1800);
        double increment = Math.min(4.5, elapsed * drag.speed);
        if (drag.entered == 0) increment = Math.min(increment, 1.15 * Math.max(drag.scaleX, drag.scaleY));
        drag.movedAt = now;
        double fraction = Math.min(1, increment / remaining);
        drag.commandX += remainingX * fraction;
        drag.commandY += remainingY * fraction;
        moveCursor(window, drag.commandX, drag.commandY, drag.scaleX, drag.scaleY);
        sampleCursor(window.getHandle());
        double x = mouseX[0] * drag.scaleX, y = mouseY[0] * drag.scaleY;
        drag.dx = x - drag.x;
        drag.dy = y - drag.y;
        if (drag.dx == 0 && drag.dy == 0) return;
        drag.x = x;
        drag.y = y;
        var layout = (AgentHandledScreenAccess) screen;
        Slot actual = layout.agent$slotAt(x, y);
        Slot next = drag.entered < drag.slots.length ? drag.slots[drag.entered] : null;
        Slot previous = drag.entered > 0 ? drag.slots[drag.entered - 1] : null;
        if ((actual != null && actual != previous && actual != next) || (drag.entered == 0 && actual != next)) {
            finish("right drag would cross an unintended slot");
            return;
        }
        screen.mouseDragged(x, y, GLFW_MOUSE_BUTTON_RIGHT, drag.dx, drag.dy);
        boolean entered = actual != null && actual == next;
        if (entered) drag.entered++;
        if (!dragPreviewMatches(drag)) {
            if (entered) drag.entered--;
            finish("vanilla right drag preview changed");
        } else {
            if (entered || drag.dx * remainingX + drag.dy * remainingY >= 0.35 * remaining) ++workEvidence;
            if (entered) recordDrag(drag, "enter", actual, screen.getScreenHandler().getRevision(), "native preview admitted");
        }
    }

    private boolean dragHeld(Drag drag, Window window) {
        var layout = (AgentHandledScreenAccess) screen;
        if (bookHidesSlots() || !dragInputAvailable(window) || layout.agent$x() != drag.left || layout.agent$y() != drag.top
                || (double) window.getScaledWidth() / window.getWidth() != drag.scaleX
                || (double) window.getScaledHeight() / window.getHeight() != drag.scaleY
                || !dragPreviewMatches(drag) || !dragStacksMatch(drag, false)) return false;
        for (Slot slot : drag.slots) if (!slot.isEnabled()) return false;
        sampleCursor(window.getHandle());
        return mouseX[0] * drag.scaleX == drag.x && mouseY[0] * drag.scaleY == drag.y;
    }

    private boolean dragInputAvailable(Window window) {
        return !Screen.hasShiftDown() && !c.options.getTouchscreen().getValue() && !physicalButtonDown(window);
    }

    private static boolean physicalButtonDown(Window window) {
        long handle = window.getHandle();
        return glfwGetMouseButton(handle, GLFW_MOUSE_BUTTON_LEFT) != GLFW_RELEASE
                || glfwGetMouseButton(handle, GLFW_MOUSE_BUTTON_RIGHT) != GLFW_RELEASE;
    }

    private boolean dragPreviewMatches(Drag drag) {
        var layout = (AgentHandledScreenAccess) screen;
        var preview = layout.agent$cursorDragSlots();
        if (!layout.agent$cursorDragging() || preview.size() != drag.entered) return false;
        for (int i = 0; i < drag.entered; i++) if (!preview.contains(drag.slots[i])) return false;
        return true;
    }

    private boolean dragStacksMatch(Drag drag, boolean deposited) {
        var handler = (AbstractCraftingScreenHandler) screen.getScreenHandler();
        ItemStack cursor = handler.getCursorStack();
        int remaining = click.cursorBefore.getCount() - (deposited ? drag.slots.length : 0);
        if (cursor.getCount() != remaining || remaining != 0 && !same(click.cursorBefore, cursor)) return false;
        if (handler.slots.size() != drag.before.length) return false;
        Slot output = handler.getOutputSlot();
        for (int i = 0; i < drag.before.length; i++) {
            Slot slot = handler.getSlot(i);
            if (deposited && slot == output) continue; // Derived server recipe preview is not ingredient custody.
            ItemStack before = drag.before[i], actual = slot.getStack();
            boolean target = false;
            if (deposited) for (Slot dragged : drag.slots) {
                if (dragged == slot) { target = true; break; }
            }
            if (target) {
                if (actual.getCount() != before.getCount() + 1 || !same(actual, click.cursorBefore)) return false;
            } else if (!ItemStack.areEqual(before, actual)) return false;
        }
        return true;
    }

    private boolean advanceDrag(long now) {
        Drag drag = click.drag;
        int revision = screen.getScreenHandler().getRevision();
        if (!drag.released) {
            if (!dragHeld(drag, c.getWindow())) {
                finish("right drag changed before release");
                return false;
            }
            Slot last = drag.last();
            if (drag.entered != drag.slots.length
                    || Math.abs(drag.x - drag.endX) > 4 || Math.abs(drag.y - drag.endY) > 4) return false;
            if (((AgentHandledScreenAccess) screen).agent$slotAt(drag.x, drag.y) != last) {
                finish("right drag release missed its last slot");
                return false;
            }
            craftGridRevision = drag.releaseRevision = revision;
            drag.released = true; // Never release a second time, even if the result fails to settle.
            boolean accepted = screen.mouseReleased(drag.x, drag.y, GLFW_MOUSE_BUTTON_RIGHT);
            recordDrag(drag, "up", last, screen.getScreenHandler().getRevision(), "dispatched");
            if (!accepted || ((AgentHandledScreenAccess) screen).agent$cursorDragging() || !dragStacksMatch(drag, true)) {
                finish("right drag did not deposit exactly one in each intended slot");
                return false;
            }
            drag.settleDeadline = now + RESULT_TIMEOUT;
            return false;
        }
        if (!dragStacksMatch(drag, true)) {
            finish("right drag balances changed after release");
            return false;
        }
        // The pinned vanilla handler sends one server result-slot revision for each changed craft input.
        if (((revision - drag.releaseRevision) & SCREEN_REVISION_MASK) < drag.slots.length) {
            if (now >= drag.settleDeadline) finish("right drag did not receive the expected crafting revisions");
            return false;
        }
        recordDrag(drag, "settled", drag.last(), revision, "exact slot increments and cursor decrease");
        ++workEvidence;
        return finishGesture(now);
    }

    private void recordDrag(Drag drag, String edge, Slot slot, int revision, String effect) {
        if (dragEvidence == null) return;
        var handler = screen.getScreenHandler();
        try {
            String header = dragHeaderWritten || Files.exists(dragEvidence) ? "" :
                    "drag\tjob_generation\tsurface\tsync_id\tedge\tbutton\twall_ms\tslot\tx\ty\tcenter_dx\tcenter_dy"
                    + "\tsample_dx\tsample_dy\trevision\tcursor_count\tslot_count\tentered\tplanned_slots\tslot_deltas\teffect\n";
            String deltas = "";
            if (edge.equals("settled")) {
                var values = new StringBuilder();
                for (Slot target : drag.slots) {
                    if (!values.isEmpty()) values.append(',');
                    values.append(target.id).append(':').append(drag.before[target.id].getCount())
                            .append("->").append(target.getStack().getCount());
                }
                deltas = values.toString();
            }
            Files.writeString(dragEvidence, header + drag.sequence + "\t" + jobGeneration + "\t"
                    + (screen instanceof InventoryScreen ? "inventory" : "crafting") + "\t" + handler.syncId
                    + "\t" + edge + "\t" + GLFW_MOUSE_BUTTON_RIGHT + "\t" + System.currentTimeMillis() + "\t" + slot.id
                    + "\t" + drag.x + "\t" + drag.y + "\t" + (drag.x - drag.left - slot.x - SLOT_SIZE * .5)
                    + "\t" + (drag.y - drag.top - slot.y - SLOT_SIZE * .5)
                    + "\t" + (edge.equals("enter") ? drag.dx : Double.NaN)
                    + "\t" + (edge.equals("enter") ? drag.dy : Double.NaN) + "\t" + revision
                    + "\t" + handler.getCursorStack().getCount() + "\t" + slot.getStack().getCount()
                    + "\t" + drag.entered + "\t" + drag.slots.length + "\t" + deltas + "\t" + effect + "\n",
                    StandardOpenOption.CREATE, StandardOpenOption.APPEND);
            dragHeaderWritten = true;
        } catch (IOException failure) {
            LOGGER.warn("Disabling GUI drag evidence: {}", dragEvidence, failure);
            dragEvidence = null;
        }
    }

    private static boolean isResult(Step step) {
        return step.mode == Mode.RESULT || step.mode == Mode.QUICK_RESULT;
    }

    private boolean isFurnacePlacement() {
        Step step = click.step;
        return job == Job.SMELT && (step.mode == Mode.ONE || step.mode == Mode.PUT) && !isStorage(step.slot);
    }

    private boolean boundedFurnaceDeposit(ItemStack cursor) {
        if (boundedIron == null || !isFurnacePlacement()) return true;
        var handler = screen.getScreenHandler();
        ItemStack input = handler.getSlot(0).getStack(), fuel = handler.getSlot(1).getStack();
        ItemStack output = handler.getSlot(2).getStack();
        if ((!input.isEmpty() && !input.isOf(Items.RAW_IRON))
                || (!fuel.isEmpty() && !fuel.isOf(boundedIron.fuel))
                || (!output.isEmpty() && !output.isOf(Items.IRON_INGOT))
                || input.getCount() + output.getCount() != ironDeposited
                || fuel.getCount() > fuelDeposited) return false;
        boolean raw = click.step.slot.id == 0;
        Item item = raw ? Items.RAW_IRON : boundedIron.fuel;
        int remaining = raw ? boundedIron.units - ironDeposited : boundedIron.fuelCount - fuelDeposited;
        int amount = click.step.mode == Mode.ONE ? 1 : cursor.getCount();
        return cursor.isOf(item) && amount <= remaining
            && AgentWorkOrder.count(player.getInventory(), item) + cursor.getCount() - amount >= smeltBudget.floor(item);
    }

    private boolean clickTargetReady(ItemStack cursor) {
        if (!ItemStack.areEqual(click.cursorBefore, cursor)) return false;
        ItemStack slot = click.step.slot.getStack();
        if (ItemStack.areEqual(click.slotBefore, slot)) return true;
        if (isFurnacePlacement()) {
            // A cooking furnace can consume fuel or input; reduced counts still leave room to place.
            if (!slot.isEmpty() && (!same(click.slotBefore, slot)
                    || slot.getCount() > click.slotBefore.getCount())) return false;
        } else if (job == Job.SMELT && click.step.mode == Mode.RESULT && click.step.count == 0) {
            if (!same(click.slotBefore, slot) || slot.getCount() < click.slotBefore.getCount()
                    || !storageRoom(slot, null)) return false;
        } else {
            return false;
        }
        click.slotBefore = slot.copy();
        return true;
    }

    private void sampleCursor(long window) {
        glfwGetCursorPos(window, mouseX, mouseY);
        double x = mouseX[0], y = mouseY[0];
        // X11 can suppress the cursor callback for a GLFW warp. Give vanilla only
        // the position read back from the window, never the requested destination.
        if (x != c.mouse.getX() || y != c.mouse.getY())
            ((AgentMouseAccess) c.mouse).agent$onCursorPos(window, x, y);
    }

    private boolean hit(Click gesture, double x, double y) {
        return gesture.bookButton != null ? gesture.bookButton.isMouseOver(x, y)
                : ((AgentHandledScreenAccess) screen).agent$slotAt(x, y) == gesture.step.slot;
    }

    private boolean layoutStillMatches(Click gesture, double scaleX, double scaleY) {
        Slot slot = gesture.step.slot;
        if (slot == null) {
            var button = gesture.bookButton;
            return gesture.motion.matches(button.getX(), button.getY(), button.getWidth(), button.getHeight(), scaleX, scaleY);
        }
        var layout = (AgentHandledScreenAccess) screen;
        return gesture.motion.matches(layout.agent$x() + slot.x, layout.agent$y() + slot.y,
                SLOT_SIZE, SLOT_SIZE, scaleX, scaleY);
    }

    private void observePointer(Click gesture, long now, double x, double y) {
        gesture.motion.observe(now, x, y);
        if (pointerEvidence == null || gesture.pressed) return;
        boolean inTarget = gesture.motion.visibleAt(x, y) && hit(gesture, x, y);
        if (inTarget && !gesture.inTarget) {
            if (gesture.firstEntry == 0) gesture.firstEntry = now;
            gesture.lastEntry = now;
        }
        gesture.inTarget = inTarget;
    }

    private void recordPointer(Click gesture, double x, double y, boolean released, String effect) {
        if (pointerEvidence == null || gesture.pressWallMs == 0) return;
        var handler = screen.getScreenHandler();
        var motion = gesture.motion;
        String surface = screen instanceof InventoryScreen ? "inventory"
                : screen instanceof CraftingScreen ? "crafting" : "furnace";
        try {
            String header = pointerHeaderWritten || Files.exists(pointerEvidence) ? "" :
                    "job_generation\tsurface\tsync_id\tslot\tmode\tbutton\tpress_wall_ms\tpress_x\tpress_y"
                    + "\tpress_center_dx\tpress_center_dy\tpress_vx\tpress_vy\tpress_settled"
                    + "\tfirst_entry_to_press_ms\tlast_entry_to_press_ms\tpress_revision"
                    + "\trelease_wall_ms\trelease_x\trelease_y\trelease_vx\trelease_vy\trelease_revision\teffect\n";
            Files.writeString(pointerEvidence, header + jobGeneration + "\t" + surface + "\t" + handler.syncId + "\t"
                    + (gesture.step.slot == null ? -1 : gesture.step.slot.id)
                    + "\t" + gesture.step.mode + "\t" + gesture.button + "\t" + gesture.pressWallMs
                    + "\t" + gesture.pressX + "\t" + gesture.pressY + "\t" + gesture.pressOffsetX + "\t"
                    + gesture.pressOffsetY + "\t" + gesture.pressVx + "\t" + gesture.pressVy
                    + "\t" + gesture.pressSettled + "\t" + entryToPress(gesture.firstEntry, gesture.pressAt)
                    + "\t" + entryToPress(gesture.lastEntry, gesture.pressAt) + "\t" + gesture.pressRevision
                    + "\t" + (released ? System.currentTimeMillis() : 0) + "\t" + x + "\t" + y
                    + "\t" + (released ? motion.vx : Double.NaN) + "\t" + (released ? motion.vy : Double.NaN)
                    + "\t" + (released ? handler.getRevision() : -1) + "\t" + effect + "\n",
                    StandardOpenOption.CREATE, StandardOpenOption.APPEND);
            pointerHeaderWritten = true;
        } catch (IOException failure) {
            LOGGER.warn("Disabling GUI pointer evidence: {}", pointerEvidence, failure);
            pointerEvidence = null;
        }
        gesture.pressWallMs = 0;
    }

    private static double entryToPress(long entry, long press) {
        return entry == 0 ? Double.NaN : (press - entry) / 1_000_000d;
    }

    private boolean ownsScreen() {
        return screen != null && c.currentScreen == screen && player != null && c.player == player
                && !player.isDead() && player.currentScreenHandler == screen.getScreenHandler();
    }

    private boolean bookHidesSlots() {
        if (screen.width >= 379) return false; // Vanilla RecipeBookScreen narrow layout.
        for (var child : screen.children()) {
            if (child instanceof RecipeBookWidget<?> book && book.isOpen()) return true;
        }
        return false;
    }

    private boolean pointerAvailable() {
        var window = c.getWindow();
        return c.isWindowFocused() && !c.mouse.isCursorLocked() && c.getOverlay() == null
                && !window.isMinimized() && window.getWidth() > 0 && window.getHeight() > 0
                && window.getScaledWidth() > 0 && window.getScaledHeight() > 0;
    }

    private void prepareClick(Step step) {
        ItemStack cursor = screen.getScreenHandler().getCursorStack();
        Slot slot = step.slot;
        ItemStack stack = slot.getStack();
        boolean allowed = switch (step.mode) {
            case TAKE, HALF -> cursor.isEmpty() && matches(stack, step) && slot.canTakeItems(c.player);
            case RESULT -> cursor.isEmpty() && matches(stack, step) && slot.canTakeItems(c.player)
                    && storageRoom(stack, null);
            case QUICK_RESULT -> cursor.isEmpty() && matches(stack, step) && slot.canTakeItems(c.player);
            case ONE -> cursor.isOf(step.item) && room(slot, cursor) >= 1;
            case PUT -> cursor.isOf(step.item) && room(slot, cursor) >= cursor.getCount();
            case STORE -> cursor.isOf(step.item) && room(slot, cursor) > 0;
            case SWAP -> cursor.isOf(step.item) && !stack.isEmpty() && !same(stack, cursor)
                    && cursor.getCount() <= slot.getMaxItemCount(cursor)
                    && slot.canInsert(cursor) && slot.canTakeItems(c.player);
            case CLEAR_BOOK -> false;
        };
        if (job == Job.EQUIP && slot.getIndex() == equipSource
                && (step.mode == Mode.TAKE || equipStack.isEmpty()))
            allowed &= ItemStack.areEqual(stack, equipStack);
        if (!allowed || !slot.isEnabled()) finish("slot not ready for gesture");
        else {
            click = new Click(clickMotion, step, null, cursor, stack);
            if (job == Job.CRAFT && step.mode == Mode.ONE && cursor.getCount() >= 2
                    && !c.options.getTouchscreen().getValue())
                click.drag = planDrag(step, cursor.getCount());
        }
    }

    private Drag planDrag(Step first, int carried) {
        var grid = ((AbstractCraftingScreenHandler) screen.getScreenHandler()).getInputSlots();
        if (!grid.contains(first.slot)) return null;
        Slot second = null, third = null, previous = first.slot;
        int dx = 0, dy = 0, count = 1;
        for (Step next : steps) {
            Slot slot = next.slot;
            if (count == 3 || count >= carried || next.item != first.item
                    || (next.mode != Mode.ONE && !(next.mode == Mode.PUT && carried == count + 1))
                    || !grid.contains(slot)) break;
            int sx = slot.x - previous.x, sy = slot.y - previous.y;
            if (count == 1) {
                if (Math.abs(sx) + Math.abs(sy) != GRID_SPACING || sx != 0 && sy != 0) break;
                dx = sx;
                dy = sy;
                second = slot;
            } else {
                if (sx != dx || sy != dy) break;
                third = slot;
            }
            count++;
            previous = slot;
        }
        return second == null ? null : new Drag(third == null
                ? new Slot[]{first.slot, second} : new Slot[]{first.slot, second, third});
    }

    private boolean clickEffect(Click click, ItemStack cursor) {
        return switch (click.step.mode) {
            case TAKE -> ItemStack.areEqual(click.slotBefore, cursor);
            case HALF -> same(click.slotBefore, cursor) && cursor.getCount() == (click.slotBefore.getCount() + 1) / 2;
            case RESULT -> job == Job.SMELT && click.step.count == 0
                    // The server can finish another item before processing the pickup.
                    ? same(click.slotBefore, cursor) && cursor.getCount() >= click.slotBefore.getCount()
                    : ItemStack.areEqual(click.slotBefore, cursor);
            case QUICK_RESULT -> cursor.isEmpty(); // Only the later server-backed receipt counts as production.
            case ONE -> cursor.getCount() == click.cursorBefore.getCount() - 1
                    && (cursor.isEmpty() || same(cursor, click.cursorBefore));
            case PUT -> cursor.isEmpty();
            case STORE -> {
                int transferred = click.cursorBefore.getCount() - cursor.getCount();
                ItemStack destination = click.step.slot.getStack();
                yield transferred > 0 && (cursor.isEmpty() || same(cursor, click.cursorBefore))
                        && same(destination, click.cursorBefore)
                        && destination.getCount() == click.slotBefore.getCount() + transferred;
            }
            case SWAP -> ItemStack.areEqual(click.slotBefore, cursor)
                    && ItemStack.areEqual(click.cursorBefore, click.step.slot.getStack());
            case CLEAR_BOOK -> true;
        };
    }

    private boolean planNextCraft() {
        CraftRequest request = crafts[craftIndex];
        CraftPlan plan = findCraftPlan(crafts, craftIndex, craftBudget);
        if (plan == null) finish("missing compatible ingredients or storage room for " + request.key);
        else if (!planCraft(plan)) finish("inventory or crafting grid changed before " + request.key);
        else {
            craftPlan = plan;
            return true;
        }
        return false;
    }

    private void completeCraft(long now) {
        var handler = screen.getScreenHandler();
        int quantity = craftPlan.executions * craftPlan.result.getCount();
        // The server recomputes the result after each take, and a multi-craft's later results
        // are not client-predicted. Wait for authoritative slot revisions and the full footprint.
        if (handler.getRevision() == craftTakeRevision || !cleanGrid(screen) || !craftStorageMatches(quantity)) {
            if (craftSettleDeadline == 0) craftSettleDeadline = now + RESULT_TIMEOUT;
            if (now >= craftSettleDeadline) finish("craft output did not settle; expected " + quantity);
            return;
        }
        long sequence = craftReceipt == null ? 1 : craftReceipt.sequence + 1;
        craftReceipt = new CraftReceipt(sequence, crafts[craftIndex].key, craftPlan.executions, quantity,
                craftPlan.executions > 1 ? 1 : 0, handler.getRevision());
        ++workEvidence;
        craftIndex += craftPlan.executions;
        craftPlan = null;
        craftStorage = null;
        craftSettleDeadline = 0;
        if (craftBudget != null || craftIndex == crafts.length) {
            finish("done", true, craftBudget != null && screen instanceof InventoryScreen
                && !((AgentHandledScreenAccess) screen).agent$cursorDragging());
        } else {
            // The next plan must see the actual storage after this recipe, not a projected inventory.
            planned = storeResult = resultStored = false;
            resultDeadline = 0;
            deadline = now + ACTION_TIMEOUT;
            status = label + ": " + craftIndex + "/" + crafts.length + " done; next " + crafts[craftIndex].key;
        }
    }

    private boolean planCraft(CraftPlan plan) {
        if (!cleanGrid(screen)) return false;
        var handler = (AbstractCraftingScreenHandler) screen.getScreenHandler();
        List<Slot> grid = handler.getInputSlots();
        int width = plan.recipe.rows[0].length(), side = screen instanceof CraftingScreen ? 3 : 2;
        var inventory = c.player.getInventory();
        craftStorage = new ItemStack[PlayerInventory.MAIN_SIZE];
        for (int i = 0; i < plan.used.length; i++) {
            int used = plan.used[i];
            ItemStack held = inventory.getStack(i);
            int after = held.getCount() - used;
            if (after < 0) return false;
            craftStorage[i] = after == 0 ? ItemStack.EMPTY : held.copyWithCount(after);
            if (used == 0) continue;
            Slot source = storageSlot(handler, i);
            if (source == null) return false;
            Item material = held.getItem();
            boolean half = held.getCount() > 1 && used == (held.getCount() + 1) / 2;
            steps.addLast(new Step(half ? Mode.HALF : Mode.TAKE, source, material, held.getCount()));
            int remaining = half ? used : held.getCount();
            for (Portion portion : plan.portions) {
                if (portion.source != i) continue;
                int cell = portion.cell, amount = portion.count;
                if (!same(held, plan.cells[cell])) return false;
                Slot dest = grid.get((cell / width) * side + cell % width);
                if (remaining == amount) {
                    steps.addLast(new Step(Mode.PUT, dest, material, 0));
                } else {
                    for (int n = 0; n < amount; n++) steps.addLast(new Step(Mode.ONE, dest, material, 0));
                }
                remaining -= amount;
            }
            if (remaining > 0) steps.addLast(new Step(Mode.PUT, source, material, 0));
        }
        steps.addLast(new Step(plan.executions > 1 ? Mode.QUICK_RESULT : Mode.RESULT, handler.getOutputSlot(),
                plan.result.getItem(), plan.result.getCount()));
        storeResult = plan.executions == 1;
        return true;
    }

    private boolean craftReady(AbstractCraftingScreenHandler handler) {
        if (handler.getRevision() == craftGridRevision || !craftStorageMatches(0)
                || !ItemStack.areEqual(handler.getOutputSlot().getStack(), craftPlan.result)) return false;
        int width = craftPlan.recipe.rows[0].length(), side = screen instanceof CraftingScreen ? 3 : 2;
        List<Slot> grid = handler.getInputSlots();
        for (int i = 0; i < grid.size(); i++) {
            int row = i / side, column = i % side;
            ItemStack expected = row < craftPlan.recipe.rows.length && column < width
                    ? craftPlan.cells[row * width + column] : ItemStack.EMPTY;
            if (!ItemStack.areEqual(grid.get(i).getStack(), expected)) return false;
        }
        return true;
    }

    private boolean admitCraftSpend() {
        if (craftBudget == null) return true;
        if (craftPlan.executions > craftBudget.craftsLeft()) return false;
        // Grid items are escrow, not spend. craftReady checked the exact grid and storage;
        // this is the last gate before vanilla's potentially multi-output Shift press.
        var costs = new HashMap<Item, Integer>();
        for (ItemStack cell : craftPlan.cells)
            if (!cell.isEmpty()) costs.merge(cell.getItem(), cell.getCount(), Integer::sum);
        PlayerInventory inventory = c.player.getInventory();
        for (var cost : costs.entrySet()) {
            int before = AgentWorkOrder.count(inventory, cost.getKey()) + cost.getValue();
            if (craftBudget.limit(cost.getKey(), before) < cost.getValue()) return false;
        }
        craftBudget.crafted(costs, craftPlan.executions);
        return true;
    }

    private boolean craftStorageMatches(int outputGain) {
        var inventory = c.player.getInventory();
        for (int i = 0; i < craftStorage.length; i++) {
            ItemStack expected = craftStorage[i], actual = inventory.getStack(i);
            if (ItemStack.areEqual(expected, actual)) continue;
            if (outputGain <= 0 || !same(actual, craftPlan.result)
                    || !expected.isEmpty() && !same(actual, expected)
                    || actual.getCount() <= expected.getCount()) return false;
            outputGain -= actual.getCount() - expected.getCount();
        }
        return outputGain == 0;
    }

    private boolean planEquip() {
        var handler = screen.getScreenHandler();
        Slot source = storageSlot(handler, equipSource), dest = storageSlot(handler, hotbar);
        if (source == null || dest == null || !handler.getCursorStack().isEmpty()) return false;
        ItemStack tool = source.getStack(), previous = dest.getStack();
        if (!ItemStack.areEqual(tool, equipStack) || same(tool, previous)) return false;
        if (tool.isEmpty()) {
            if (previous.isEmpty()) return false;
            transfer(dest, source, previous.getCount(), false);
            return true;
        }
        steps.addLast(new Step(Mode.TAKE, source, tool.getItem(), tool.getCount()));
        steps.addLast(new Step(previous.isEmpty() ? Mode.PUT : Mode.SWAP, dest, tool.getItem(), 0));
        if (!previous.isEmpty()) steps.addLast(new Step(Mode.PUT, source, previous.getItem(), 0));
        return true;
    }

    private void selectHotbar(long now) {
        if (job != Job.EQUIP || c.currentScreen != null) {
            finish("screen changed");
            return;
        }
        var inv = c.player.getInventory();
        ItemStack target = inv.getStack(hotbar);
        if (!ItemStack.areEqual(target, equipStack)) {
            finish("item not in expected hotbar slot");
        } else if (inv.selectedSlot == hotbar) {
            pendingKey = null;
            finish("done");
        } else if (pendingKey == null) {
            tap(c.options.hotbarKeys[hotbar], now);
        } else if (now >= keyDeadline) {
            finish("hotbar key did not select item");
        }
    }

    private void tap(KeyBinding binding, long now) {
        if (binding.isUnbound() || !c.isWindowFocused() || c.getOverlay() != null) {
            finish("key unavailable");
            return;
        }
        pendingKey = binding;
        keyDeadline = now + KEY_TIMEOUT;
        KeyBinding.onKeyPressed(InputUtil.fromTranslationKey(binding.getBoundKeyTranslationKey()));
    }

    private void transfer(Slot source, Slot target, int amount, boolean bounded) {
        ItemStack stack = source.getStack();
        Item item = stack.getItem();
        if (bounded && amount < stack.getCount() && amount == (stack.getCount() + 1) / 2) {
            steps.addLast(new Step(Mode.HALF, source, item, stack.getCount()));
            steps.addLast(new Step(Mode.PUT, target, item, 0));
            return;
        }
        steps.addLast(new Step(Mode.TAKE, source, item, stack.getCount()));
        if (stack.getCount() == amount) {
            steps.addLast(new Step(Mode.PUT, target, item, 0));
        } else {
            for (int i = 0; i < amount; i++) steps.addLast(new Step(Mode.ONE, target, item, 0));
            steps.addLast(new Step(Mode.PUT, source, item, 0));
        }
    }

    private void start(Job kind, String name, HandledScreen<?> current) {
        ++jobGeneration;
        job = kind;
        player = c.player;
        previousFailure &= label.equals(name);
        label = name;
        if (!previousFailure) status = name + ": queued";
        deadline = System.nanoTime() + ACTION_TIMEOUT;
        screen = current;
    }

    private boolean report(String name, String reason) {
        status = name + ": " + reason;
        return false;
    }

    private void closeScreen() {
        if (ownsScreen()) screen.close();
        screen = null;
    }

    private void finish(String reason) {
        finish(reason, true);
    }

    private void finish(String reason, boolean closeOwnedScreen) {
        finish(reason, closeOwnedScreen, false);
    }

    private void finish(String reason, boolean closeOwnedScreen, boolean retainInventory) {
        if (click != null) {
            Drag drag = click.drag;
            if (drag != null && drag.down) {
                var layout = (AgentHandledScreenAccess) screen;
                if (!drag.released || layout.agent$cursorDragging()) {
                    // Right release can commit a vanilla preview even over empty space. Clear only
                    // the initiating screen's transient preview, never send a substitute release.
                    // No global Mouse button was set, so closing/replacing the screen cannot leak it.
                    layout.agent$setCursorDragging(false);
                    layout.agent$cursorDragSlots().clear();
                }
                Slot at = drag.slots[Math.max(0, drag.entered - 1)];
                recordDrag(drag, "aborted", at, screen.getScreenHandler().getRevision(), reason);
            } else {
                recordPointer(click, Double.NaN, Double.NaN, false, "interrupted: " + reason);
            }
        }
        if (pendingKey != null) {
            if (closeOwnedScreen && inventoryNeeded && screen == null && c.currentScreen instanceof InventoryScreen inventory)
                screen = inventory;
            pendingKey.wasPressed(); // Remove our queued key edge if vanilla has not consumed it.
            pendingKey = null;
        }
        if (!closeOwnedScreen || job == Job.SMELT && reason.equals("done")) screen = null;
        else if (!retainInventory) closeScreen();
        previousFailure = !reason.equals("done") && !reason.equals("cancelled");
        report(label, reason);
        job = null;
        click = null;
        if (!retainInventory) {
            player = null;
            handoffAt = 0;
            lastLeftSlot = null;
        }
        crafts = null;
        craftPlan = null;
        craftStorage = null;
        craftBudget = null;
        boundedIron = null;
        smeltBudget = null;
        scopedSmelt = false;
        ironDeposited = fuelDeposited = 0;
        craftSettleDeadline = 0;
        craftIndex = 0;
        equipStack = ItemStack.EMPTY;
        steps.clear();
        inventoryNeeded = planned = storeResult = resultStored = false;
        resultDeadline = 0;
    }

    private CraftPlan findCraftPlan(CraftRequest[] requests, int index, AgentWorkOrder.Budget budget) {
        CraftRequest request = requests[index];
        int limit = Math.min(requests.length - index, 64); // Vanilla ingredient stack ceiling.
        int runs = 1;
        while (runs < limit && request.equals(requests[index + runs])) runs++;
        var inventory = c.player.getInventory();
        for (int executions = runs; executions > 0; executions--) {
            if (request.recipe == Recipe.BOAT) {
                CraftPlan plan = boatIngredients(inventory, request, executions, budget);
                if (plan != null) return plan;
            } else {
                CraftPlan plan = ingredients(inventory, request, executions, null, request.recipe.output, budget);
                if (plan != null && storageRoom(plan.result, plan.result.getCount() * executions, plan.used))
                    return plan;
            }
        }
        return null;
    }

    private CraftPlan boatIngredients(PlayerInventory inventory, CraftRequest request, int executions,
                                      AgentWorkOrder.Budget budget) {
        Item requestedBoat = request.key.equals("boat") ? null : vanillaBoat(request.key);
        for (int i = 0; i < PlayerInventory.MAIN_SIZE; i++) {
            ItemStack stack = inventory.getStack(i);
            if (!stack.isIn(ItemTags.PLANKS)) continue;
            Item planks = stack.getItem();
            boolean seen = false;
            for (int j = 0; j < i && !seen; j++) seen = inventory.getStack(j).isOf(planks);
            if (seen) continue;
            Item boat = boatFor(planks);
            if (boat == null || requestedBoat != null && boat != requestedBoat) continue;
            CraftPlan plan = ingredients(inventory, request, executions, planks, boat, budget);
            if (plan != null && storageRoom(plan.result, executions, plan.used)) return plan;
        }
        return null;
    }

    private static CraftPlan ingredients(PlayerInventory inv, CraftRequest request, int executions,
                                         Item exactMaterial, Item result, AgentWorkOrder.Budget budget) {
        Recipe recipe = request.recipe;
        int width = recipe.rows[0].length();
        ItemStack[] cells = new ItemStack[recipe.rows.length * width];
        int[] used = new int[PlayerInventory.MAIN_SIZE];
        var portions = new ArrayList<Portion>();
        int batch = recipe.batch;
        for (int cell = 0; cell < cells.length; cell++) {
            char ingredient = recipe.rows[cell / width].charAt(cell % width);
            if (ingredient == ' ') {
                cells[cell] = ItemStack.EMPTY;
                continue;
            }
            ItemStack material = findIngredient(inv, used, ingredient, request.key, executions, exactMaterial, budget);
            if (material == null) return null;
            if (ingredient == 'l') {
                result = planksFor(material);
                if (result == Items.BAMBOO_PLANKS) batch = 2;
            }
            cells[cell] = material.copyWithCount(executions);
            int remaining = executions;
            // Multiple storage stacks can feed a cell, but only when vanilla can stack them together.
            for (int i = 0; i < used.length && remaining > 0; i++) {
                ItemStack stack = inv.getStack(i);
                int amount = Math.min(remaining, stack.getCount() - used[i]);
                if (amount <= 0 || !same(stack, material)) continue;
                portions.add(new Portion(i, cell, amount));
                used[i] += amount;
                remaining -= amount;
            }
        }
        return new CraftPlan(recipe, new ItemStack(result, batch), executions, cells, portions, used);
    }

    private static ItemStack findIngredient(PlayerInventory inv, int[] used, char ingredient, String key,
                                            int quantity, Item exactMaterial, AgentWorkOrder.Budget budget) {
        for (int i = 0; i < used.length; i++) {
            ItemStack stack = inv.getStack(i);
            int amount = stack.getCount() - used[i];
            if (amount <= 0 || stack.getMaxCount() < quantity || !ingredientMatches(ingredient, stack)
                    || exactMaterial != null && !stack.isOf(exactMaterial)) continue;
            if (budget != null) {
                Item item = stack.getItem();
                int current = 0, claimed = 0;
                for (int j = 0; j < used.length; ++j) if (inv.getStack(j).isOf(item)) {
                    current += inv.getStack(j).getCount();
                    claimed += used[j];
                }
                if (budget.limit(item, current) - claimed < quantity) continue;
            }
            if (ingredient == 'l') {
                Item planks = planksFor(stack);
                if (planks == null || !key.equals("planks") && !Registries.ITEM.getId(planks).getPath().equals(key))
                    continue;
            }
            for (int j = i + 1; j < used.length && amount < quantity; j++) {
                ItemStack other = inv.getStack(j);
                if (other.getCount() > used[j] && same(stack, other)) amount += other.getCount() - used[j];
            }
            if (amount >= quantity) return stack;
        }
        return null;
    }

    private static boolean ingredientMatches(char token, ItemStack stack) {
        return switch (token) {
            case 'l' -> stack.isIn(ItemTags.LOGS) || stack.isIn(ItemTags.BAMBOO_BLOCKS);
            case 'p' -> stack.isIn(ItemTags.PLANKS);
            case 'w' -> stack.isIn(ItemTags.WOODEN_TOOL_MATERIALS);
            case 's' -> stack.isOf(Items.STICK);
            case 'r' -> stack.isIn(ItemTags.STONE_TOOL_MATERIALS);
            case 'm' -> stack.isIn(ItemTags.STONE_CRAFTING_MATERIALS);
            case 'i' -> stack.isOf(Items.IRON_INGOT);
            case 'd' -> stack.isOf(Items.DIAMOND);
            case 'f' -> stack.isOf(Items.FLINT);
            case 'c' -> stack.isOf(Items.COAL) || stack.isOf(Items.CHARCOAL);
            default -> false;
        };
    }

    private static Item planksFor(ItemStack stack) {
        if (stack.isIn(ItemTags.BAMBOO_BLOCKS)) return Items.BAMBOO_PLANKS;
        var id = Registries.ITEM.getId(stack.getItem());
        if (!id.getNamespace().equals("minecraft")) return null;
        String path = id.getPath();
        int from = path.startsWith("stripped_") ? "stripped_".length() : 0;
        int to = path.lastIndexOf('_');
        if (to <= from) return null;
        Item planks = Registries.ITEM.get(Identifier.ofVanilla(path.substring(from, to) + "_planks"));
        return planks == Items.AIR ? null : planks;
    }

    private static Item boatFor(Item planks) {
        var id = Registries.ITEM.getId(planks);
        String suffix = "_planks", path = id.getPath();
        if (!id.getNamespace().equals("minecraft") || !path.endsWith(suffix)) return null;
        return planks == Items.BAMBOO_PLANKS ? Items.BAMBOO_RAFT
                : vanillaBoat(path.substring(0, path.length() - suffix.length()) + "_boat");
    }

    private static Item vanillaBoat(String key) {
        if (key.indexOf(':') >= 0 || !key.endsWith("_boat") && !key.equals("bamboo_raft")) return null;
        Identifier id = Identifier.tryParse(key);
        if (id == null) return null;
        Item boat = Registries.ITEM.get(id);
        var entry = boat.getRegistryEntry();
        return entry.isIn(ItemTags.BOATS) && !entry.isIn(ItemTags.CHEST_BOATS) ? boat : null;
    }

    private static boolean cleanGrid(HandledScreen<?> screen) {
        if (!(screen.getScreenHandler() instanceof AbstractCraftingScreenHandler handler)
                || !handler.getCursorStack().isEmpty() || handler.getOutputSlot().hasStack()) return false;
        for (Slot slot : handler.getInputSlots()) if (slot.hasStack()) return false;
        return true;
    }

    private static int fuelRank(Item item) {
        if (item == Items.COAL) return 0;
        if (item == Items.CHARCOAL) return 1;
        if (item != null && item.getRegistryEntry().isIn(ItemTags.PLANKS)) return 2;
        if (item == Items.STICK) return 3;
        return Integer.MAX_VALUE;
    }

    private boolean isStorage(Slot slot) {
        return slot.inventory == c.player.getInventory() && slot.getIndex() >= 0
                && slot.getIndex() < PlayerInventory.MAIN_SIZE && slot.isEnabled();
    }

    private Slot storageSlot(ScreenHandler handler, int index) {
        for (Slot slot : handler.slots) if (slot.getIndex() == index && isStorage(slot)) return slot;
        return null;
    }

    private Slot findStorage(ScreenHandler handler, Predicate<ItemStack> match) {
        Slot best = null;
        for (Slot slot : handler.slots) {
            if (!isStorage(slot) || !slot.hasStack() || !match.test(slot.getStack())) continue;
            if (best == null || slot.getStack().getCount() > best.getStack().getCount()) best = slot;
        }
        return best;
    }

    private boolean storageRoom(ItemStack result, int[] used) {
        return storageRoom(result, result.getCount(), used);
    }

    private boolean storageRoom(ItemStack result, int remaining, int[] used) {
        var inv = c.player.getInventory();
        for (int i = 0; i < PlayerInventory.MAIN_SIZE; i++) {
            ItemStack stack = inv.getStack(i);
            int held = stack.getCount() - (used == null ? 0 : used[i]);
            if (held <= 0 || same(stack, result)) {
                remaining -= result.getMaxCount() - Math.max(0, held);
                if (remaining <= 0) return true;
            }
        }
        return false;
    }

    private Slot resultDestination(ScreenHandler handler, ItemStack stack) {
        boolean preferHotbar = stack.isOf(Items.CRAFTING_TABLE) || stack.isOf(Items.FURNACE)
                || stack.isOf(Items.BUCKET) || stack.isOf(Items.FLINT_AND_STEEL)
                || stack.isIn(ItemTags.PICKAXES) || stack.isIn(ItemTags.SHOVELS) || stack.isIn(ItemTags.SWORDS)
                || stack.isIn(ItemTags.BOATS);
        Slot best = null;
        int bestScore = 0;
        for (Slot slot : handler.slots) {
            if (!isStorage(slot)) continue;
            int available = room(slot, stack);
            if (available <= 0) continue;
            int score = available >= stack.getCount() ? (slot.hasStack() ? 1000 : 500) : available;
            if (preferHotbar && slot.getIndex() < PlayerInventory.HOTBAR_SIZE && available >= stack.getCount())
                score += 2000;
            if (score > bestScore) {
                best = slot;
                bestScore = score;
            }
        }
        return best;
    }

    private int hotbarDestination(PlayerInventory inv, ItemStack source) {
        int selected = inv.selectedSlot;
        if (!same(inv.getStack(selected), source)) return selected;
        for (int i = 0; i < PlayerInventory.HOTBAR_SIZE; i++) {
            if (!c.options.hotbarKeys[i].isUnbound() && !same(inv.getStack(i), source)) return i;
        }
        return -1;
    }

    private static int room(Slot slot, ItemStack cursor) {
        if (cursor.isEmpty() || !slot.canInsert(cursor)) return 0;
        ItemStack target = slot.getStack();
        if (!target.isEmpty() && !same(target, cursor)) return 0;
        return slot.getMaxItemCount(cursor) - target.getCount();
    }

    private static boolean same(ItemStack a, ItemStack b) {
        return ItemStack.areItemsAndComponentsEqual(a, b);
    }

    private static boolean matches(ItemStack stack, Step step) {
        return !stack.isEmpty() && stack.isOf(step.item) && (step.count == 0 || stack.getCount() == step.count);
    }
}
