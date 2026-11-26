package io.gameharness.survival;

import io.gameharness.survival.mixin.AgentHandledScreenAccess;
import io.gameharness.survival.mixin.AgentKeyboardAccess;
import io.gameharness.survival.mixin.AgentMouseAccess;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Predicate;
import net.fabricmc.fabric.api.client.screen.v1.Screens;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.screen.DeathScreen;
import net.minecraft.client.gui.screen.Screen;
import net.minecraft.client.gui.screen.ingame.CraftingScreen;
import net.minecraft.client.gui.screen.ingame.FurnaceScreen;
import net.minecraft.client.gui.screen.ingame.HandledScreen;
import net.minecraft.client.gui.screen.ingame.InventoryScreen;
import net.minecraft.client.gui.widget.ButtonWidget;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.client.util.Window;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.registry.tag.ItemTags;
import net.minecraft.screen.AbstractCraftingScreenHandler;
import net.minecraft.screen.FurnaceScreenHandler;
import net.minecraft.screen.ScreenHandler;
import net.minecraft.screen.slot.Slot;
import net.minecraft.text.TranslatableTextContent;

import static org.lwjgl.glfw.GLFW.GLFW_KEY_E;
import static org.lwjgl.glfw.GLFW.GLFW_KEY_ESCAPE;
import static org.lwjgl.glfw.GLFW.GLFW_MOUSE_BUTTON_LEFT;
import static org.lwjgl.glfw.GLFW.GLFW_MOUSE_BUTTON_RIGHT;
import static org.lwjgl.glfw.GLFW.GLFW_PRESS;
import static org.lwjgl.glfw.GLFW.GLFW_RELEASE;
import static org.lwjgl.glfw.GLFW.glfwGetKeyScancode;
import static org.lwjgl.glfw.GLFW.glfwSetCursorPos;

/**
 * Clean, brisk, human-paced vanilla GUI hand controller.
 * Executes real mouse movements and real slot clicks for 2x2/3x3 crafting,
 * furnace loading/collection, hotbar swaps, and DeathScreen respawn.
 */
final class GuiHands {
    enum State { IDLE, WORKING, DONE, FAILED }

    enum RecipeId {
        PLANKS(null, 4, false, "l"),
        CRAFTING_TABLE(Items.CRAFTING_TABLE, 1, false, "pp", "pp"),
        STICK(Items.STICK, 4, false, "p", "p"),
        TORCH(Items.TORCH, 4, false, "c", "s"),
        WOODEN_PICKAXE(Items.WOODEN_PICKAXE, 1, true, "ppp", " s ", " s "),
        WOODEN_AXE(Items.WOODEN_AXE, 1, true, "pp", "ps", " s"),
        WOODEN_SWORD(Items.WOODEN_SWORD, 1, true, "p", "p", "s"),
        WOODEN_SHOVEL(Items.WOODEN_SHOVEL, 1, true, "p", "s", "s"),
        STONE_PICKAXE(Items.STONE_PICKAXE, 1, true, "rrr", " s ", " s "),
        STONE_AXE(Items.STONE_AXE, 1, true, "rr", "rs", " s"),
        STONE_SWORD(Items.STONE_SWORD, 1, true, "r", "r", "s"),
        STONE_SHOVEL(Items.STONE_SHOVEL, 1, true, "r", "s", "s"),
        FURNACE(Items.FURNACE, 1, true, "rrr", "r r", "rrr"),
        IRON_PICKAXE(Items.IRON_PICKAXE, 1, true, "iii", " s ", " s "),
        IRON_AXE(Items.IRON_AXE, 1, true, "ii", "is", " s"),
        IRON_SWORD(Items.IRON_SWORD, 1, true, "i", "i", "s"),
        IRON_SHOVEL(Items.IRON_SHOVEL, 1, true, "i", "s", "s"),
        BUCKET(Items.BUCKET, 1, true, "i i", " i "),
        SHIELD(Items.SHIELD, 1, true, "pip", "ppp", " p "),
        IRON_HELMET(Items.IRON_HELMET, 1, true, "iii", "i i"),
        IRON_CHESTPLATE(Items.IRON_CHESTPLATE, 1, true, "i i", "iii", "iii"),
        IRON_LEGGINGS(Items.IRON_LEGGINGS, 1, true, "iii", "i i", "i i"),
        IRON_BOOTS(Items.IRON_BOOTS, 1, true, "i i", "i i"),
        DIAMOND_PICKAXE(Items.DIAMOND_PICKAXE, 1, true, "ddd", " s ", " s "),
        DIAMOND_SWORD(Items.DIAMOND_SWORD, 1, true, "d", "d", "s"),
        FLINT_AND_STEEL(Items.FLINT_AND_STEEL, 1, false, "if"),
        BOAT(null, 1, true, "p p", "ppp");

        final Item output;
        final int batch;
        final boolean needsTable;
        final String[] rows;

        RecipeId(Item output, int batch, boolean needsTable, String... rows) {
            this.output = output;
            this.batch = batch;
            this.needsTable = needsTable;
            this.rows = rows;
        }
    }

    private enum ClickKind { LEFT, RIGHT, SHIFT_RESULT }
    private record GuiAction(Slot slot, ClickKind kind) {}

    private final MinecraftClient client;
    private final AgentGuiPointer pointer = new AgentGuiPointer();
    private final ArrayDeque<GuiAction> actions = new ArrayDeque<>();

    private State state = State.IDLE;
    private String failReason = "";
    private GuiAction activeAction;
    private boolean clickedActive;
    private long actionStartedNs;
    private long waitUntilNs;
    private long closeAfterNs;
    private boolean screenOpenedBeatPending;
    private double curGuiX, curGuiY;
    private boolean curPosInit;
    private boolean closeWhenDone;
    private int jobTicks;
    private final java.util.Random pacingRng = new java.util.Random();

    // Pending job descriptors
    private RecipeId pendingRecipe;
    private int pendingRecipeExecs;
    private boolean needOpenInventory;
    private boolean pendingHotbarSwap;
    private Predicate<ItemStack> pendingHotbarPredicate;
    private boolean pendingFurnaceLoad;
    private Item pendingSmeltInput;
    private int pendingSmeltCount;
    private boolean pendingFurnaceCollect;

    GuiHands(MinecraftClient client) {
        this.client = client;
    }

    State state() { return state; }
    String failReason() { return failReason; }
    boolean isBusy() { return state == State.WORKING; }

    private void clearState() {
        actions.clear();
        activeAction = null;
        clickedActive = false;
        pendingRecipe = null;
        pendingHotbarSwap = false;
        pendingFurnaceLoad = false;
        pendingFurnaceCollect = false;
        needOpenInventory = false;
        closeWhenDone = false;
        closeAfterNs = 0L;
        waitUntilNs = 0L;
        screenOpenedBeatPending = false;
        state = State.IDLE;
    }

    void abort() {
        clearState();
        if (client.currentScreen instanceof HandledScreen<?>) {
            sendKey(GLFW_KEY_ESCAPE);
        }
    }

    /** Start crafting `executions` batches of `recipe`. For 3x3 recipes, caller must open CraftingScreen first! */
    boolean startCraft(RecipeId recipe, int executions) {
        clearState();
        if (recipe == null || executions <= 0) return false;
        pendingRecipe = recipe;
        pendingRecipeExecs = executions;
        needOpenInventory = !recipe.needsTable && !(client.currentScreen instanceof InventoryScreen)
            && !(client.currentScreen instanceof CraftingScreen);
        closeWhenDone = true;
        state = State.WORKING;
        jobTicks = 0;
        return true;
    }

    /** Start moving an item matching `pred` from backpack into a hotbar slot. */
    boolean startHotbarSwap(Predicate<ItemStack> pred) {
        clearState();
        pendingHotbarSwap = true;
        pendingHotbarPredicate = pred;
        needOpenInventory = !(client.currentScreen instanceof InventoryScreen);
        closeWhenDone = true;
        state = State.WORKING;
        jobTicks = 0;
        return true;
    }

    /** Start loading input + best fuel into an already-open FurnaceScreen. */
    boolean startFurnaceLoad(Item input, int count) {
        clearState();
        pendingFurnaceLoad = true;
        pendingSmeltInput = input;
        pendingSmeltCount = count;
        closeWhenDone = true;
        state = State.WORKING;
        jobTicks = 0;
        return true;
    }

    /** Start collecting output from an already-open FurnaceScreen. */
    boolean startFurnaceCollect() {
        clearState();
        pendingFurnaceCollect = true;
        closeWhenDone = true;
        state = State.WORKING;
        jobTicks = 0;
        return true;
    }

    /** Handle vanilla DeathScreen respawn with smooth pointer motion. */
    void tickDeathScreen(DeathScreen screen) {
        ButtonWidget btn = findRespawnButton(screen);
        if (btn == null) return;
        Window win = client.getWindow();
        double scaleX = (double) win.getFramebufferWidth() / Math.max(1, win.getScaledWidth());
        double scaleY = (double) win.getFramebufferHeight() / Math.max(1, win.getScaledHeight());
        long now = System.nanoTime();
        if (!curPosInit) {
            curGuiX = screen.width * 0.5;
            curGuiY = screen.height * 0.5;
            curPosInit = true;
        }
        if (!pointer.matches(btn.getX(), btn.getY(), btn.getWidth(), btn.getHeight(), scaleX, scaleY)) {
            pointer.plan(now, curGuiX, curGuiY, btn.getX(), btn.getY(), btn.getWidth(), btn.getHeight(),
                scaleX, scaleY, false, 0, 0, btn.getX() + btn.getWidth() * 0.5, btn.getY() + btn.getHeight() * 0.5);
        }
        pointer.advance(now);
        movePointerTo(pointer.x, pointer.y);
        if (pointer.settled) {
            screen.mouseClicked(pointer.x, pointer.y, GLFW_MOUSE_BUTTON_LEFT);
            screen.mouseReleased(pointer.x, pointer.y, GLFW_MOUSE_BUTTON_LEFT);
            pointer.reset();
        }
    }

    private static ButtonWidget findRespawnButton(DeathScreen screen) {
        for (var child : Screens.getButtons(screen)) {
            if (child instanceof ButtonWidget btn && btn.visible && btn.active
                    && btn.getMessage().getContent() instanceof TranslatableTextContent t
                    && t.getKey().equals("deathScreen.respawn")) {
                return btn;
            }
        }
        return null;
    }

    /** Called every tick while working on a GUI job. */
    void tick() {
        if (state != State.WORKING) return;
        var player = client.player;
        if (player == null) { fail("no_player"); return; }

        jobTicks++;
        if (jobTicks > 480) { fail("gui_timeout"); return; }

        // Step 1: Open inventory if needed
        if (needOpenInventory) {
            if (client.currentScreen == null) {
                sendKey(GLFW_KEY_E);
                return;
            }
            if (client.currentScreen instanceof InventoryScreen) {
                needOpenInventory = false;
                screenOpenedBeatPending = true;
            } else {
                sendKey(GLFW_KEY_ESCAPE);
                return;
            }
        }

        // Step 2: Ensure expected HandledScreen is open
        if (!(client.currentScreen instanceof HandledScreen<?> screen)) {
            if (jobTicks > 15) fail("screen_not_open");
            return;
        }
        if (jobTicks == 1) {
            screenOpenedBeatPending = true;
        }

        // Step 3: Build click queue once screen is open & synced
        if (actions.isEmpty() && activeAction == null) {
            if (pendingRecipe != null) {
                if (screen instanceof CraftingScreen && jobTicks < 4) {
                    return; // wait briefly for server inventory slot sync on newly opened crafting table
                }
                if (!planCraftActions(screen, pendingRecipe, pendingRecipeExecs)) {
                    fail("missing_ingredients_or_grid");
                    return;
                }
                pendingRecipe = null;
                if (screenOpenedBeatPending) {
                    waitUntilNs = System.nanoTime() + randMs(90, 140);
                    screenOpenedBeatPending = false;
                }
            } else if (pendingHotbarSwap) {
                if (!planHotbarSwapActions(screen, pendingHotbarPredicate)) {
                    fail("item_not_in_backpack");
                    return;
                }
                pendingHotbarSwap = false;
                if (screenOpenedBeatPending) {
                    waitUntilNs = System.nanoTime() + randMs(85, 130);
                    screenOpenedBeatPending = false;
                }
            } else if (pendingFurnaceLoad) {
                if (!(screen instanceof FurnaceScreen) || !(screen.getScreenHandler() instanceof FurnaceScreenHandler fsh)) {
                    fail("not_furnace_screen");
                    return;
                }
                if (!((AgentFurnaceSync) fsh).agent$furnaceContentsSynced()) {
                    return; // wait a couple ticks for server slot sync
                }
                if (!planFurnaceLoadActions(fsh, pendingSmeltInput, pendingSmeltCount)) {
                    fail("furnace_load_unavailable");
                    return;
                }
                pendingFurnaceLoad = false;
                if (screenOpenedBeatPending) {
                    waitUntilNs = System.nanoTime() + randMs(95, 145);
                    screenOpenedBeatPending = false;
                }
            } else if (pendingFurnaceCollect) {
                if (!(screen instanceof FurnaceScreen) || !(screen.getScreenHandler() instanceof FurnaceScreenHandler fsh)) {
                    fail("not_furnace_screen");
                    return;
                }
                if (!((AgentFurnaceSync) fsh).agent$furnaceContentsSynced()) {
                    return;
                }
                Slot outSlot = fsh.getSlot(2);
                if (outSlot.hasStack()) {
                    actions.add(new GuiAction(outSlot, ClickKind.SHIFT_RESULT));
                }
                pendingFurnaceCollect = false;
                if (actions.isEmpty()) {
                    finish();
                    return;
                }
                if (screenOpenedBeatPending) {
                    waitUntilNs = System.nanoTime() + randMs(95, 145);
                    screenOpenedBeatPending = false;
                }
            } else {
                // Queue drained — short natural beat before closing GUI so item transfers stay readable!
                long now = System.nanoTime();
                if (closeAfterNs == 0L) {
                    closeAfterNs = now + randMs(100, 150);
                    return;
                }
                if (now < closeAfterNs) return;
                finish();
                return;
            }
        }
    }

    private long randMs(int minMs, int maxMs) {
        return (minMs + pacingRng.nextInt(Math.max(1, maxMs - minMs + 1))) * 1_000_000L;
    }

    /** Called every render frame (60fps) for smooth, skilled human-paced GUI cursor motion and clicks! */
    void renderFrame() {
        if (state != State.WORKING) return;
        if (!(client.currentScreen instanceof HandledScreen<?> screen)) return;
        long now = System.nanoTime();
        if (now < waitUntilNs) return;

        if (activeAction == null) {
            activeAction = actions.poll();
            if (activeAction == null) return;
            clickedActive = false;
            actionStartedNs = now;
            pointer.reset();
        }

        Window win = client.getWindow();
        double scaleX = (double) win.getFramebufferWidth() / Math.max(1, win.getScaledWidth());
        double scaleY = (double) win.getFramebufferHeight() / Math.max(1, win.getScaledHeight());
        AgentHandledScreenAccess acc = (AgentHandledScreenAccess) screen;
        double slotLeft = acc.agent$x() + activeAction.slot().x;
        double slotTop = acc.agent$y() + activeAction.slot().y;

        if (!curPosInit) {
            curGuiX = screen.width * 0.5;
            curGuiY = screen.height * 0.5;
            curPosInit = true;
        }

        GuiAction next = actions.peek();
        double nextX = next != null ? acc.agent$x() + next.slot().x + 8.0 : slotLeft + 8.0;
        double nextY = next != null ? acc.agent$y() + next.slot().y + 8.0 : slotTop + 8.0;

        if (!pointer.matches(slotLeft, slotTop, 16.0, 16.0, scaleX, scaleY)) {
            pointer.plan(now, curGuiX, curGuiY, slotLeft, slotTop, 16.0, 16.0, scaleX, scaleY,
                false, pointer.vx * 0.35, pointer.vy * 0.35, nextX, nextY);
        }
        // Balanced skilled-human pointer speed (~1.05x base Bezier curve — smooth, crisp, never abrupt!)
        long pacedNow = actionStartedNs + (long) ((now - actionStartedNs) * 1.05);
        pointer.advance(pacedNow);
        movePointerTo(pointer.x, pointer.y);

        boolean readyToClick = pointer.settled
            || (pointer.braking && pointer.inside(pointer.x, pointer.y) && (now - actionStartedNs) >= 85_000_000L);
        if (!clickedActive && readyToClick) {
            executeClick(screen, activeAction, pointer.x, pointer.y);
            clickedActive = true;
            // Balanced varied human inter-click rhythm
            boolean rapidPlace = activeAction.kind() == ClickKind.RIGHT && next != null && next.kind() == ClickKind.RIGHT;
            boolean takingResult = activeAction.kind() == ClickKind.SHIFT_RESULT;
            waitUntilNs = now + (rapidPlace ? randMs(60, 95) : (takingResult ? randMs(100, 145) : randMs(80, 125)));
            activeAction = null;
        }
    }

    private void executeClick(HandledScreen<?> screen, GuiAction action, double x, double y) {
        if (action.kind() == ClickKind.SHIFT_RESULT) {
            if (screen instanceof AgentCraftClick craftClick && screen.getScreenHandler() instanceof AbstractCraftingScreenHandler) {
                if (craftClick.agent$shiftClickResult(action.slot(), x, y)) {
                    screen.mouseReleased(x, y, GLFW_MOUSE_BUTTON_LEFT);
                    return;
                }
            }
            // Fallback for FurnaceScreen / non-craft shift-click: quick-move via InteractionManager
            if (client.interactionManager != null && client.player != null) {
                client.interactionManager.clickSlot(
                    screen.getScreenHandler().syncId,
                    action.slot().id,
                    0,
                    net.minecraft.screen.slot.SlotActionType.QUICK_MOVE,
                    client.player
                );
            }
            return;
        }
        int button = action.kind() == ClickKind.RIGHT ? GLFW_MOUSE_BUTTON_RIGHT : GLFW_MOUSE_BUTTON_LEFT;
        screen.mouseClicked(x, y, button);
        screen.mouseReleased(x, y, button);
    }

    private void movePointerTo(double guiX, double guiY) {
        curGuiX = guiX;
        curGuiY = guiY;
        Window win = client.getWindow();
        double rawX = guiX * win.getFramebufferWidth() / Math.max(1.0, win.getScaledWidth());
        double rawY = guiY * win.getFramebufferHeight() / Math.max(1.0, win.getScaledHeight());
        glfwSetCursorPos(win.getHandle(), rawX, rawY);
        ((AgentMouseAccess) client.mouse).agent$onCursorPos(win.getHandle(), rawX, rawY);
    }

    private void sendKey(int key) {
        Window win = client.getWindow();
        int scan = glfwGetKeyScancode(key);
        ((AgentKeyboardAccess) client.keyboard).agent$onKey(win.getHandle(), key, scan, GLFW_PRESS, 0);
        ((AgentKeyboardAccess) client.keyboard).agent$onKey(win.getHandle(), key, scan, GLFW_RELEASE, 0);
    }

    private void finish() {
        if (closeWhenDone && client.currentScreen instanceof HandledScreen<?>) {
            sendKey(GLFW_KEY_ESCAPE);
        }
        state = State.DONE;
        closeWhenDone = false;
    }

    private void fail(String reason) {
        failReason = reason;
        actions.clear();
        activeAction = null;
        if (client.currentScreen instanceof HandledScreen<?>) {
            sendKey(GLFW_KEY_ESCAPE);
        }
        state = State.FAILED;
    }

    /** Plan exact vanilla clicks to execute `recipe` `executions` times on the open crafting grid. */
    private boolean planCraftActions(HandledScreen<?> screen, RecipeId recipe, int executions) {
        if (!(screen.getScreenHandler() instanceof AbstractCraftingScreenHandler handler)) return false;
        int gridW = handler.getWidth();
        int gridH = handler.getHeight();
        if (recipe.rows.length > gridH) return false;
        for (String r : recipe.rows) if (r.length() > gridW) return false;

        // Clear cursor or leftover grid items first? If grid isn't empty, return them to inventory.
        List<Slot> inputSlots = handler.getInputSlots();
        for (Slot s : inputSlots) {
            if (s.hasStack()) {
                actions.add(new GuiAction(s, ClickKind.SHIFT_RESULT));
            }
        }

        // Gather player inventory slots (indices after crafting output+grid)
        List<Slot> invSlots = new ArrayList<>();
        for (Slot s : handler.slots) {
            if (s.inventory == client.player.getInventory()) {
                invSlots.add(s);
            }
        }

        // Track remaining counts per inventory slot as we plan
        int[] avail = new int[invSlots.size()];
        for (int i = 0; i < invSlots.size(); i++) avail[i] = invSlots.get(i).getStack().getCount();

        // Determine how many executions we can actually afford (cap at requested executions)
        // Map each recipe symbol to list of grid cells needing it
        List<Integer> cells = new ArrayList<>();
        List<Character> syms = new ArrayList<>();
        for (int r = 0; r < recipe.rows.length; r++) {
            String row = recipe.rows[r];
            for (int c = 0; c < row.length(); c++) {
                char ch = row.charAt(c);
                if (ch != ' ') {
                    cells.add(r * gridW + c);
                    syms.add(ch);
                }
            }
        }

        // For each distinct symbol, find matching inventory slot(s) and allocate `executions` items per cell
        // Special case for BOAT: all planks must be same wood species!
        Item lockedSpecies = null;
        if (recipe == RecipeId.BOAT) {
            for (int i = 0; i < invSlots.size(); i++) {
                ItemStack st = invSlots.get(i).getStack();
                if (st.isIn(ItemTags.PLANKS) && avail[i] >= 5) {
                    lockedSpecies = st.getItem();
                    break;
                }
            }
            if (lockedSpecies == null) return false;
        }

        // Only stack executions > 1 when all items for each cell come from a single stack (avoids mixed-species collision!)
        int effExecs = recipe == RecipeId.PLANKS ? executions : (recipe == RecipeId.TORCH ? Math.min(executions, 4) : 1);
        // Clamp multi-execution batch to what's actually available in inventory so e.g. 1 stick still crafts 4 torches!
        if (effExecs > 1) {
            for (char sym : new char[]{'l', 'p', 's', 'r', 'c', 'i', 'd', 'f'}) {
                int perExec = 0;
                for (char s : syms) if (s == sym) perExec++;
                if (perExec == 0) continue;
                int totalHave = 0;
                for (int i = 0; i < invSlots.size(); i++) {
                    if (matchesSymbol(invSlots.get(i).getStack(), sym, lockedSpecies)) totalHave += avail[i];
                }
                effExecs = Math.min(effExecs, totalHave / perExec);
            }
            if (effExecs <= 0) return false;
        }

        // Group cells by symbol so we pick up a stack once and right-click drop into each matching cell
        for (char sym : new char[]{'l', 'p', 's', 'r', 'c', 'i', 'd', 'f'}) {
            List<Integer> symCells = new ArrayList<>();
            for (int k = 0; k < syms.size(); k++) {
                if (syms.get(k) == sym) symCells.add(cells.get(k));
            }
            if (symCells.isEmpty()) continue;

            int neededTotal = symCells.size() * effExecs;
            // Find source slots matching symbol
            int cellIdx = 0;
            int placedInCurrentCell = 0;

            for (int i = 0; i < invSlots.size() && cellIdx < symCells.size(); i++) {
                ItemStack st = invSlots.get(i).getStack();
                if (avail[i] <= 0 || !matchesSymbol(st, sym, lockedSpecies)) continue;
                // For effExecs > 1 on logs/planks, skip if a single stack can't fill at least one cell cleanly
                if (effExecs > 1 && placedInCurrentCell > 0) continue;

                Slot src = invSlots.get(i);
                actions.add(new GuiAction(src, ClickKind.LEFT)); // pick up stack

                int inHand = avail[i];
                avail[i] = 0;

                while (inHand > 0 && cellIdx < symCells.size()) {
                    Slot targetGridSlot = inputSlots.get(symCells.get(cellIdx));
                    actions.add(new GuiAction(targetGridSlot, ClickKind.RIGHT)); // place 1
                    inHand--;
                    neededTotal--;
                    placedInCurrentCell++;
                    if (placedInCurrentCell >= effExecs) {
                        cellIdx++;
                        placedInCurrentCell = 0;
                    }
                }
                if (inHand > 0) {
                    // Put remaining stack back into src slot!
                    actions.add(new GuiAction(src, ClickKind.LEFT));
                    avail[i] = inHand;
                }
            }
            if (cellIdx < symCells.size()) {
                actions.clear();
                return false;
            }
        }

        // Finally shift-click the output slot to collect all crafted items!
        actions.add(new GuiAction(handler.getOutputSlot(), ClickKind.SHIFT_RESULT));
        return true;
    }

    private static boolean matchesSymbol(ItemStack stack, char sym, Item lockedSpecies) {
        if (stack.isEmpty()) return false;
        if (lockedSpecies != null && sym == 'p') return stack.isOf(lockedSpecies);
        return switch (sym) {
            case 'l' -> stack.isIn(ItemTags.LOGS);
            case 'p' -> stack.isIn(ItemTags.PLANKS);
            case 's' -> stack.isOf(Items.STICK);
            case 'r' -> stack.isOf(Items.COBBLESTONE) || stack.isOf(Items.COBBLED_DEEPSLATE) || stack.isOf(Items.BLACKSTONE);
            case 'c' -> stack.isOf(Items.COAL) || stack.isOf(Items.CHARCOAL);
            case 'i' -> stack.isOf(Items.IRON_INGOT);
            case 'd' -> stack.isOf(Items.DIAMOND);
            case 'f' -> stack.isOf(Items.FLINT);
            default -> false;
        };
    }

    private boolean planHotbarSwapActions(HandledScreen<?> screen, Predicate<ItemStack> pred) {
        ScreenHandler handler = screen.getScreenHandler();
        var inv = client.player.getInventory();
        Slot source = null;
        Slot destHotbar = null;
        int bestDestScore = Integer.MAX_VALUE;

        for (Slot s : handler.slots) {
            if (s.inventory != inv) continue;
            int idx = s.getIndex();
            if (idx >= 9 && idx < 36 && source == null && pred.test(s.getStack())) {
                source = s;
            } else if (idx >= 0 && idx < 9) {
                int score = hotbarKeepPriority(s.getStack());
                if (score < bestDestScore) {
                    bestDestScore = score;
                    destHotbar = s;
                }
            }
        }
        if (source == null || destHotbar == null) return false;
        actions.add(new GuiAction(source, ClickKind.LEFT));
        actions.add(new GuiAction(destHotbar, ClickKind.LEFT));
        if (destHotbar.hasStack()) {
            actions.add(new GuiAction(source, ClickKind.LEFT));
        }
        return true;
    }

    private static int hotbarKeepPriority(ItemStack st) {
        if (st.isEmpty()) return 0;
        Item i = st.getItem();
        if (i == Items.DIAMOND_PICKAXE || i == Items.IRON_PICKAXE || i == Items.STONE_PICKAXE || i == Items.WOODEN_PICKAXE) return 100;
        if (i == Items.IRON_SWORD || i == Items.STONE_SWORD || i == Items.IRON_AXE || i == Items.STONE_AXE) return 90;
        if (i == Items.TORCH || i == Items.WATER_BUCKET) return 80;
        if (Motor.foodScore(st, false) > 0) return 75;
        if (i == Items.COBBLESTONE || i == Items.COBBLED_DEEPSLATE || i == Items.DIRT) return 60;
        if (i == Items.CRAFTING_TABLE || i == Items.FURNACE) return 55;
        return 10;
    }

    private boolean planFurnaceLoadActions(FurnaceScreenHandler handler, Item input, int maxCount) {
        Slot inputSlot = handler.getSlot(0);
        Slot fuelSlot = handler.getSlot(1);
        Slot outSlot = handler.getSlot(2);
        var inv = client.player.getInventory();

        // Collect any existing output first
        if (outSlot.hasStack()) {
            actions.add(new GuiAction(outSlot, ClickKind.SHIFT_RESULT));
        }

        // Load input item if input slot is empty or same item
        Slot srcInput = null;
        for (Slot s : handler.slots) {
            if (s.inventory == inv && s.getStack().isOf(input)) {
                srcInput = s;
                break;
            }
        }
        if (srcInput != null && (!inputSlot.hasStack() || inputSlot.getStack().isOf(input))) {
            int toMove = Math.min(srcInput.getStack().getCount(), maxCount);
            if (toMove == srcInput.getStack().getCount()) {
                actions.add(new GuiAction(srcInput, ClickKind.LEFT));
                actions.add(new GuiAction(inputSlot, ClickKind.LEFT));
            } else {
                actions.add(new GuiAction(srcInput, ClickKind.LEFT));
                for (int k = 0; k < toMove; k++) {
                    actions.add(new GuiAction(inputSlot, ClickKind.RIGHT));
                }
                actions.add(new GuiAction(srcInput, ClickKind.LEFT));
            }
        } else if (!inputSlot.hasStack()) {
            return false;
        }

        // Load fuel if fuel slot is empty (coal > charcoal > planks > logs > sticks)
        if (!fuelSlot.hasStack()) {
            Slot bestFuel = findBestFuelSlot(handler, inv);
            if (bestFuel == null) return false;
            int fuelNeeded = fuelNeeded(bestFuel.getStack(), Math.max(1, maxCount));
            if (fuelNeeded >= bestFuel.getStack().getCount()) {
                actions.add(new GuiAction(bestFuel, ClickKind.LEFT));
                actions.add(new GuiAction(fuelSlot, ClickKind.LEFT));
            } else {
                actions.add(new GuiAction(bestFuel, ClickKind.LEFT));
                for (int k = 0; k < fuelNeeded; k++) {
                    actions.add(new GuiAction(fuelSlot, ClickKind.RIGHT));
                }
                actions.add(new GuiAction(bestFuel, ClickKind.LEFT));
            }
        }
        return !actions.isEmpty();
    }

    private static Slot findBestFuelSlot(FurnaceScreenHandler handler, net.minecraft.entity.player.PlayerInventory inv) {
        Slot best = null;
        int bestRank = -1;
        for (Slot s : handler.slots) {
            if (s.inventory != inv || !s.hasStack()) continue;
            ItemStack st = s.getStack();
            int rank = st.isOf(Items.COAL) || st.isOf(Items.CHARCOAL) ? 5
                : st.isIn(ItemTags.PLANKS) ? 4
                : st.isIn(ItemTags.LOGS) ? 3
                : st.isOf(Items.STICK) ? 2 : -1;
            if (rank > bestRank) {
                bestRank = rank;
                best = s;
            }
        }
        return best;
    }

    private static int fuelNeeded(ItemStack fuel, int itemsToSmelt) {
        int ticksNeeded = itemsToSmelt * 200;
        int perUnit = (fuel.isOf(Items.COAL) || fuel.isOf(Items.CHARCOAL)) ? 1600
            : (fuel.isIn(ItemTags.PLANKS) || fuel.isIn(ItemTags.LOGS)) ? 300
            : 100;
        return Math.max(1, (ticksNeeded + perUnit - 1) / perUnit);
    }

    /** Utility: total count of an item across entire player inventory. */
    static int countItem(ClientPlayerEntity player, Item item) {
        int total = 0;
        var inv = player.getInventory();
        for (int i = 0; i < inv.size(); i++) {
            ItemStack st = inv.getStack(i);
            if (st.isOf(item)) total += st.getCount();
        }
        return total;
    }

    static int countLogs(ClientPlayerEntity player) {
        int total = 0;
        var inv = player.getInventory();
        for (int i = 0; i < inv.size(); i++) {
            ItemStack st = inv.getStack(i);
            if (st.isIn(ItemTags.LOGS)) total += st.getCount();
        }
        return total;
    }

    static int countPlanks(ClientPlayerEntity player) {
        int total = 0;
        var inv = player.getInventory();
        for (int i = 0; i < inv.size(); i++) {
            ItemStack st = inv.getStack(i);
            if (st.isIn(ItemTags.PLANKS)) total += st.getCount();
        }
        return total;
    }

    static int countStone(ClientPlayerEntity player) {
        return countItem(player, Items.COBBLESTONE) + countItem(player, Items.COBBLED_DEEPSLATE) + countItem(player, Items.BLACKSTONE);
    }

    static int countFuelUnits(ClientPlayerEntity player) {
        return countItem(player, Items.COAL) * 8
            + countItem(player, Items.CHARCOAL) * 8
            + (countPlanks(player) * 3) / 2
            + (countLogs(player) * 3) / 2;
    }

    static int countEdibleFood(ClientPlayerEntity player, boolean allowRaw) {
        int total = 0;
        var inv = player.getInventory();
        for (int i = 0; i < inv.size(); i++) {
            ItemStack st = inv.getStack(i);
            if (Motor.foodScore(st, allowRaw) > 0) total += st.getCount();
        }
        return total;
    }
}
