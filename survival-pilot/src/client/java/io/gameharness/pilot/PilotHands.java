package io.gameharness.pilot;

import io.gameharness.pilot.mixin.PilotHandledScreenAccess;
import io.gameharness.pilot.mixin.PilotMouseAccess;
import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.List;
import java.util.function.Predicate;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.navigation.GuiNavigationType;
import net.minecraft.client.gui.screen.Screen;
import net.minecraft.client.gui.screen.ingame.CraftingScreen;
import net.minecraft.client.gui.screen.ingame.FurnaceScreen;
import net.minecraft.client.gui.screen.ingame.HandledScreen;
import net.minecraft.client.gui.screen.ingame.InventoryScreen;
import net.minecraft.client.gui.screen.recipebook.RecipeBookWidget;
import net.minecraft.client.gui.widget.TexturedButtonWidget;
import net.minecraft.client.option.KeyBinding;
import net.minecraft.client.util.InputUtil;
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

import static org.lwjgl.glfw.GLFW.GLFW_MOUSE_BUTTON_LEFT;
import static org.lwjgl.glfw.GLFW.GLFW_MOUSE_BUTTON_RIGHT;
import static org.lwjgl.glfw.GLFW.glfwGetCursorPos;
import static org.lwjgl.glfw.GLFW.glfwSetCursorPos;

final class PilotHands {
    private static final long ACTION_TIMEOUT = 15_000_000_000L;
    private static final long RESULT_TIMEOUT = 1_500_000_000L;
    private static final long KEY_TIMEOUT = 1_000_000_000L;
    private static final long LEFT_CLICK_INTERVAL = 260_000_000L; // Outside vanilla's double-click window.
    private static final int SMELT_TICKS = 200;

    private enum Job { CRAFT, SMELT, EQUIP }

    private enum Mode { TAKE, RESULT, ONE, PUT, STORE, SWAP, CLEAR_BOOK }

    private enum Recipe {
        PLANKS(null, 4, "l"),
        CRAFTING_TABLE(Items.CRAFTING_TABLE, 1, "pp", "pp"),
        STICK(Items.STICK, 4, "p", "p"),
        WOODEN_PICKAXE(Items.WOODEN_PICKAXE, 1, "ppp", " s ", " s "),
        WOODEN_SHOVEL(Items.WOODEN_SHOVEL, 1, "p", "s", "s"),
        STONE_PICKAXE(Items.STONE_PICKAXE, 1, "rrr", " s ", " s "),
        STONE_SHOVEL(Items.STONE_SHOVEL, 1, "r", "s", "s"),
        FURNACE(Items.FURNACE, 1, "mmm", "m m", "mmm"),
        IRON_PICKAXE(Items.IRON_PICKAXE, 1, "iii", " s ", " s "),
        STONE_SWORD(Items.STONE_SWORD, 1, "r", "r", "s"),
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

    private record CraftPlan(Recipe recipe, Item result, int batch, int[] sources, int[] used) {}

    private record Step(Mode mode, Slot slot, Item item, int count) {}

    private static final class Click {
        final Step step;
        final TexturedButtonWidget bookButton;
        final ItemStack cursorBefore;
        final ItemStack slotBefore;
        final int button;
        double fromX, fromY, toX, toY;
        long moveStart, duration;
        boolean arrived, pressed;

        Click(Step step, TexturedButtonWidget bookButton, ItemStack cursor, ItemStack slot) {
            this.step = step;
            this.bookButton = bookButton;
            cursorBefore = cursor.copy();
            slotBefore = slot.copy();
            button = step.mode == Mode.ONE ? GLFW_MOUSE_BUTTON_RIGHT : GLFW_MOUSE_BUTTON_LEFT;
        }
    }

    private final MinecraftClient c;
    private final ArrayDeque<Step> steps = new ArrayDeque<>();
    private final double[] mouseX = new double[1], mouseY = new double[1];
    private Job job;
    private HandledScreen<?> screen;
    private Click click;
    private Slot lastLeftSlot;
    private long nextSameLeftPress;
    private CraftRequest[] crafts;
    private CraftPlan firstCraftPlan;
    private int craftIndex;
    private ItemStack equipStack = ItemStack.EMPTY;
    private int equipSource, hotbar;
    private boolean inventoryNeeded, planned, storeResult, resultStored, previousFailure;
    private KeyBinding pendingKey;
    private long deadline, keyDeadline, resultDeadline;
    private String label = "hands";
    private String status = "idle";

    PilotHands(MinecraftClient c) {
        this.c = c;
    }

    boolean busy() {
        return job != null;
    }

    String status() {
        return status;
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

    boolean craftBatch(List<String> recipes) {
        if (busy() || c.player == null) return false;
        if (recipes.isEmpty()) return report("craft", "no recipes");
        var current = c.currentScreen;
        if (current != null && !(current instanceof InventoryScreen || current instanceof CraftingScreen))
            return report("craft", "incompatible screen");
        if (current instanceof HandledScreen<?> handled && !cleanGrid(handled))
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
        CraftPlan plan = ingredients(c.player.getInventory(), first.recipe, first.key);
        if (plan == null) return report("craft", "missing ingredients for " + first.key);
        if (!storageRoom(new ItemStack(plan.result, plan.batch), plan.used))
            return report("craft", "inventory full");

        String name = requests.length == 1 ? "craft " + first.key : "craft batch (" + requests.length + ")";
        start(Job.CRAFT, name, (HandledScreen<?>) current);
        crafts = requests;
        firstCraftPlan = plan;
        inventoryNeeded = true;
        return true;
    }

    private static CraftRequest craftRequest(String item) {
        if (item == null) return null;
        String key = item.startsWith("minecraft:") ? item.substring("minecraft:".length()) : item;
        Recipe recipe = switch (key) {
            case "planks" -> Recipe.PLANKS;
            case "crafting_table" -> Recipe.CRAFTING_TABLE;
            case "stick", "sticks" -> Recipe.STICK;
            case "wooden_pickaxe" -> Recipe.WOODEN_PICKAXE;
            case "wooden_shovel" -> Recipe.WOODEN_SHOVEL;
            case "stone_pickaxe" -> Recipe.STONE_PICKAXE;
            case "stone_shovel" -> Recipe.STONE_SHOVEL;
            case "furnace" -> Recipe.FURNACE;
            case "iron_pickaxe" -> Recipe.IRON_PICKAXE;
            case "stone_sword" -> Recipe.STONE_SWORD;
            case "torch", "torches" -> Recipe.TORCH;
            default -> {
                Identifier id = key.endsWith("_planks") && key.indexOf(':') < 0 ? Identifier.tryParse(key) : null;
                yield id != null && Registries.ITEM.get(id).getRegistryEntry().isIn(ItemTags.PLANKS)
                        ? Recipe.PLANKS : null;
            }
        };
        return recipe == null ? null : new CraftRequest(recipe, key);
    }

    boolean smelt() {
        return smelt(false);
    }

    boolean smelt(boolean charcoal) {
        if (busy() || c.player == null || c.world == null) return false;
        if (!(c.currentScreen instanceof FurnaceScreen furnace)) return report("smelt", "furnace required");
        var handler = furnace.getScreenHandler();
        if (!handler.getCursorStack().isEmpty()) return report("smelt", "cursor occupied");
        Slot input = handler.getSlot(0), fuel = handler.getSlot(1), output = handler.getOutputSlot();
        ItemStack finished = output.getStack();
        if (!finished.isEmpty()) {
            if (!finished.isOf(Items.IRON_INGOT) && !finished.isOf(Items.CHARCOAL))
                return report("smelt", "unrelated furnace output");
            if (!storageRoom(finished, null)) return report("smelt", "inventory full");
            start(Job.SMELT, "smelt", furnace);
            steps.addLast(new Step(Mode.RESULT, output, finished.getItem(), 0));
            planned = storeResult = true;
            return true;
        }

        var fuels = c.world.getFuelRegistry();
        if (!handler.isBurning() && fuel.hasStack() && fuels.getFuelTicks(fuel.getStack()) <= 0)
            return report("smelt", "fuel slot occupied");
        Slot inputSource = null;
        int inputCount = input.getStack().getCount();
        if (inputCount == 0) {
            inputSource = findStorage(handler, charcoal ? stack -> stack.isIn(ItemTags.LOGS_THAT_BURN)
                    : stack -> stack.isOf(Items.RAW_IRON));
            if (inputSource == null) return report("smelt", "no input");
            inputCount = Math.min(inputSource.getStack().getCount(), 3);
        } else {
            ItemStack existing = input.getStack();
            if (!existing.isOf(Items.RAW_IRON) && !existing.isIn(ItemTags.LOGS_THAT_BURN))
                return report("smelt", "unrelated furnace input");
            if (handler.isBurning() || fuel.hasStack()) return report("smelt", "cooking");
        }

        Slot fuelSource = null;
        int fuelCount = 0;
        if (!handler.isBurning() && !fuel.hasStack()) {
            int bestRank = Integer.MAX_VALUE;
            int bestTicks = 0;
            int requiredTicks = Math.min(3, inputCount) * SMELT_TICKS;
            for (Slot slot : handler.slots) {
                if (!isStorage(slot) || slot == inputSource || !slot.hasStack()) continue;
                ItemStack stack = slot.getStack();
                int rank = fuelRank(stack);
                if (rank == Integer.MAX_VALUE || !fuel.canInsert(stack)) continue;
                int ticks = fuels.getFuelTicks(stack);
                if (ticks <= 0) continue;
                int coverage = ticks * stack.getCount();
                // A stack which can finish the planned batch beats one which would stall it.
                if (coverage < requiredTicks) rank += 4;
                if (rank > bestRank || rank == bestRank && coverage <= bestTicks) continue;
                bestRank = rank;
                bestTicks = coverage;
                fuelSource = slot;
                fuelCount = Math.min(stack.getCount(), (requiredTicks + ticks - 1) / ticks);
            }
            if (fuelSource == null) return report("smelt", "no fuel");
        }

        start(Job.SMELT, "smelt", furnace);
        if (inputSource != null) transfer(inputSource, input, inputCount);
        if (fuelSource != null) transfer(fuelSource, fuel, fuelCount);
        planned = true;
        return true;
    }

    boolean equip(Predicate<ItemStack> item) {
        if (c.player == null) return false;
        var inv = c.player.getInventory();
        if (item.test(inv.getMainHandStack())) return true;
        if (busy()) return false;
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
    }

    void frame() {
        if (click == null || click.pressed || screen != c.currentScreen || !pointerAvailable()) return;
        var window = c.getWindow();
        var layout = (PilotHandledScreenAccess) screen;
        Slot slot = click.step.slot;
        double x = slot != null ? layout.pilot$x() + slot.x + 8 : click.bookButton.getX() + click.bookButton.getWidth() * .5;
        double y = slot != null ? layout.pilot$y() + slot.y + 8 : click.bookButton.getY() + click.bookButton.getHeight() * .5;
        x *= (double) window.getWidth() / window.getScaledWidth();
        y *= (double) window.getHeight() / window.getScaledHeight();
        long now = System.nanoTime();
        if (click.moveStart == 0 || x != click.toX || y != click.toY) {
            glfwGetCursorPos(window.getHandle(), mouseX, mouseY);
            click.fromX = mouseX[0];
            click.fromY = mouseY[0];
            click.toX = x;
            click.toY = y;
            click.moveStart = now;
            click.duration = Math.min(270_000_000L, 65_000_000L
                    + (long) (Math.hypot(x - click.fromX, y - click.fromY) * 450_000));
            click.arrived = false;
        }
        if (!click.arrived) {
            double t = Math.min(1, (double) (now - click.moveStart) / click.duration);
            double eased = t * t * (3 - 2 * t);
            glfwSetCursorPos(window.getHandle(), click.fromX + (x - click.fromX) * eased,
                    click.fromY + (y - click.fromY) * eased);
            click.arrived = t == 1;
        }
        sampleCursor(window.getHandle());
    }

    void tick() {
        if (!busy()) return;
        long now = System.nanoTime();
        if (c.player == null || c.player.isDead()) {
            finish("interrupted");
            return;
        }
        if (now >= deadline) {
            finish(click == null ? "timed out" : "timed out on " + (click.step.slot == null
                    ? "recipe book" : click.step.mode + " slot " + click.step.slot.id));
            return;
        }
        if (screen == null) {
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
        if (c.currentScreen != screen || c.player.currentScreenHandler != screen.getScreenHandler()) {
            finish("screen changed");
            return;
        }
        if (!pointerAvailable()) {
            finish("window not available");
            return;
        }
        if (click != null) {
            advanceClick(now);
            return;
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
            else click = new Click(new Step(Mode.CLEAR_BOOK, null, null, 0), toggle, ItemStack.EMPTY, ItemStack.EMPTY);
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
            if (next.mode == Mode.RESULT && !matches(stack, next)) {
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

    private void advanceClick(long now) {
        if (!click.arrived || Screen.hasShiftDown()) return;
        Slot slot = click.step.slot;
        boolean leftSlotPress = slot != null && click.button == GLFW_MOUSE_BUTTON_LEFT;
        if (!click.pressed && leftSlotPress && slot == lastLeftSlot && now < nextSameLeftPress) return;
        var window = c.getWindow();
        sampleCursor(window.getHandle());
        double scaleX = (double) window.getScaledWidth() / window.getWidth();
        double scaleY = (double) window.getScaledHeight() / window.getHeight();
        double x = mouseX[0] * scaleX, y = mouseY[0] * scaleY;
        if (!hit(click, x, y) || !hit(click, c.mouse.getX() * scaleX, c.mouse.getY() * scaleY)) {
            if (click.pressed) finish("cursor moved during press");
            else {
                click.arrived = false;
                click.moveStart = 0;
            }
            return;
        }
        var handler = screen.getScreenHandler();
        if (!click.pressed) {
            if (click.step.mode != Mode.CLEAR_BOOK
                    && (!ItemStack.areEqual(click.cursorBefore, handler.getCursorStack())
                    || !ItemStack.areEqual(click.slotBefore, click.step.slot.getStack()))) {
                finish("slot changed before press");
                return;
            }
            c.setNavigationType(GuiNavigationType.MOUSE);
            screen.mouseClicked(x, y, click.button);
            if (leftSlotPress) {
                lastLeftSlot = slot;
                nextSameLeftPress = now + LEFT_CLICK_INTERVAL;
            }
            click.pressed = true;
        } else {
            screen.mouseReleased(x, y, click.button);
            if (click.step.mode == Mode.CLEAR_BOOK) {
                if (bookHidesSlots()) finish("recipe book did not close");
            } else {
                ItemStack cursor = handler.getCursorStack();
                if (!clickEffect(click, cursor)) finish("slot gesture had no expected effect");
                else if (click.step.mode == Mode.STORE && cursor.isEmpty()) resultStored = true;
            }
            if (busy() && previousFailure) {
                previousFailure = false;
                status = label + ": working";
            }
            click = null;
        }
    }

    private void sampleCursor(long window) {
        glfwGetCursorPos(window, mouseX, mouseY);
        double x = mouseX[0], y = mouseY[0];
        // X11 can suppress the cursor callback for a GLFW warp. Give vanilla only
        // the position read back from the window, never the requested destination.
        if (x != c.mouse.getX() || y != c.mouse.getY())
            ((PilotMouseAccess) c.mouse).pilot$onCursorPos(window, x, y);
    }

    private boolean hit(Click gesture, double x, double y) {
        return gesture.bookButton != null ? gesture.bookButton.isMouseOver(x, y)
                : ((PilotHandledScreenAccess) screen).pilot$slotAt(x, y) == gesture.step.slot;
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
            case TAKE -> cursor.isEmpty() && matches(stack, step) && slot.canTakeItems(c.player);
            case RESULT -> cursor.isEmpty() && matches(stack, step) && slot.canTakeItems(c.player)
                    && storageRoom(stack, null);
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
        else click = new Click(step, null, cursor, stack);
    }

    private static boolean clickEffect(Click click, ItemStack cursor) {
        return switch (click.step.mode) {
            case TAKE, RESULT -> ItemStack.areEqual(click.slotBefore, cursor);
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
        CraftPlan plan = firstCraftPlan;
        firstCraftPlan = null;
        if (plan == null) plan = ingredients(c.player.getInventory(), request.recipe, request.key);
        if (plan == null) finish("missing ingredients for " + request.key);
        else if (!planCraft(plan)) finish("inventory or crafting grid changed before " + request.key);
        else return true;
        return false;
    }

    private void completeCraft(long now) {
        if (!cleanGrid(screen)) {
            finish("crafting grid did not clear");
        } else if (++craftIndex == crafts.length) {
            finish("done");
        } else {
            // The next plan must see the actual storage after this recipe, not a projected inventory.
            planned = storeResult = resultStored = false;
            resultDeadline = 0;
            deadline = now + ACTION_TIMEOUT;
            status = label + ": " + craftIndex + "/" + crafts.length + " done; next " + crafts[craftIndex].key;
        }
    }

    private boolean planCraft(CraftPlan craftPlan) {
        if (!cleanGrid(screen) || !storageRoom(new ItemStack(craftPlan.result, craftPlan.batch), craftPlan.used))
            return false;
        var handler = (AbstractCraftingScreenHandler) screen.getScreenHandler();
        List<Slot> grid = handler.getInputSlots();
        int side = screen instanceof CraftingScreen ? 3 : 2;
        var rows = craftPlan.recipe.rows;
        int width = rows[0].length();
        for (int i = 0; i < craftPlan.used.length; i++) {
            if (craftPlan.used[i] == 0) continue;
            Slot source = storageSlot(handler, i);
            if (source == null || source.getStack().getCount() < craftPlan.used[i]) return false;
            ItemStack stack = source.getStack();
            Item material = stack.getItem();
            steps.addLast(new Step(Mode.TAKE, source, material, stack.getCount()));
            int remaining = stack.getCount();
            for (int cell = 0; cell < craftPlan.sources.length; cell++) {
                if (craftPlan.sources[cell] != i) continue;
                int row = cell / width, col = cell % width;
                char ingredient = rows[row].charAt(col);
                if (!ingredientMatches(ingredient, stack)
                        || ingredient == 'l' && planksFor(stack) != craftPlan.result) return false;
                Slot dest = grid.get(row * side + col);
                steps.addLast(new Step(remaining-- == 1 ? Mode.PUT : Mode.ONE, dest, material, 0));
            }
            if (remaining > 0) steps.addLast(new Step(Mode.PUT, source, material, 0));
        }
        steps.addLast(new Step(Mode.RESULT, handler.getOutputSlot(), craftPlan.result, craftPlan.batch));
        storeResult = true;
        return true;
    }

    private boolean planEquip() {
        var handler = screen.getScreenHandler();
        Slot source = storageSlot(handler, equipSource), dest = storageSlot(handler, hotbar);
        if (source == null || dest == null || !handler.getCursorStack().isEmpty()) return false;
        ItemStack tool = source.getStack(), previous = dest.getStack();
        if (!ItemStack.areEqual(tool, equipStack) || same(tool, previous)) return false;
        if (tool.isEmpty()) {
            if (previous.isEmpty()) return false;
            transfer(dest, source, previous.getCount());
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

    private void transfer(Slot source, Slot target, int amount) {
        ItemStack stack = source.getStack();
        Item item = stack.getItem();
        steps.addLast(new Step(Mode.TAKE, source, item, stack.getCount()));
        if (stack.getCount() == amount) {
            steps.addLast(new Step(Mode.PUT, target, item, 0));
        } else {
            for (int i = 0; i < amount; i++) steps.addLast(new Step(Mode.ONE, target, item, 0));
            steps.addLast(new Step(Mode.PUT, source, item, 0));
        }
    }

    private void start(Job kind, String name, HandledScreen<?> current) {
        job = kind;
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
        if (screen != null && c.currentScreen == screen && c.player != null
                && c.player.currentScreenHandler == screen.getScreenHandler()) screen.close();
        screen = null;
    }

    private void finish(String reason) {
        if (pendingKey != null) {
            if (inventoryNeeded && screen == null && c.currentScreen instanceof InventoryScreen inventory)
                screen = inventory;
            pendingKey.wasPressed(); // Remove our queued key edge if vanilla has not consumed it.
            pendingKey = null;
        }
        closeScreen();
        previousFailure = !reason.equals("done") && !reason.equals("cancelled");
        report(label, reason);
        job = null;
        click = null;
        lastLeftSlot = null;
        crafts = null;
        firstCraftPlan = null;
        craftIndex = 0;
        equipStack = ItemStack.EMPTY;
        steps.clear();
        inventoryNeeded = planned = storeResult = resultStored = false;
        resultDeadline = 0;
    }

    private static CraftPlan ingredients(PlayerInventory inv, Recipe recipe, String key) {
        int width = recipe.rows[0].length();
        int[] sources = new int[recipe.rows.length * width];
        int[] used = new int[PlayerInventory.MAIN_SIZE];
        Arrays.fill(sources, -1);
        Item result = recipe.output;
        int batch = recipe.batch;
        for (int cell = 0; cell < sources.length; cell++) {
            char ingredient = recipe.rows[cell / width].charAt(cell % width);
            if (ingredient == ' ') continue;
            for (int i = 0; i < used.length; i++) {
                ItemStack stack = inv.getStack(i);
                if (stack.getCount() <= used[i] || !ingredientMatches(ingredient, stack)) continue;
                if (ingredient == 'l') {
                    Item planks = planksFor(stack);
                    if (planks == null || !key.equals("planks") && !Registries.ITEM.getId(planks).getPath().equals(key))
                        continue;
                    result = planks;
                    if (planks == Items.BAMBOO_PLANKS) batch = 2;
                }
                sources[cell] = i;
                used[i]++;
                break;
            }
            if (sources[cell] < 0) return null;
        }
        return new CraftPlan(recipe, result, batch, sources, used);
    }

    private static boolean ingredientMatches(char token, ItemStack stack) {
        return switch (token) {
            case 'l' -> stack.isIn(ItemTags.LOGS) || stack.isIn(ItemTags.BAMBOO_BLOCKS);
            case 'p' -> stack.isIn(ItemTags.PLANKS);
            case 's' -> stack.isOf(Items.STICK);
            case 'r' -> stack.isIn(ItemTags.STONE_TOOL_MATERIALS);
            case 'm' -> stack.isIn(ItemTags.STONE_CRAFTING_MATERIALS);
            case 'i' -> stack.isOf(Items.IRON_INGOT);
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

    private static boolean cleanGrid(HandledScreen<?> screen) {
        if (!(screen.getScreenHandler() instanceof AbstractCraftingScreenHandler handler)
                || !handler.getCursorStack().isEmpty() || handler.getOutputSlot().hasStack()) return false;
        for (Slot slot : handler.getInputSlots()) if (slot.hasStack()) return false;
        return true;
    }

    private static int fuelRank(ItemStack stack) {
        if (stack.isOf(Items.COAL)) return 0;
        if (stack.isOf(Items.CHARCOAL)) return 1;
        if (stack.isIn(ItemTags.PLANKS)) return 2;
        if (stack.isOf(Items.STICK)) return 3;
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
        var inv = c.player.getInventory();
        int remaining = result.getCount();
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
                || stack.isIn(ItemTags.PICKAXES) || stack.isIn(ItemTags.SHOVELS) || stack.isIn(ItemTags.SWORDS);
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
