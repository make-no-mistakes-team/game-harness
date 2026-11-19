package io.gameharness.pilot.mixin;

import io.gameharness.pilot.PilotCraftClick;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.screen.ingame.CraftingScreen;
import net.minecraft.client.gui.screen.ingame.HandledScreen;
import net.minecraft.client.gui.screen.ingame.InventoryScreen;
import net.minecraft.client.util.InputUtil;
import net.minecraft.screen.AbstractCraftingScreenHandler;
import net.minecraft.screen.slot.Slot;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Redirect;

import static org.lwjgl.glfw.GLFW.GLFW_MOUSE_BUTTON_LEFT;

@Mixin(HandledScreen.class)
abstract class PilotCraftScreenMixin implements PilotCraftClick {
    @Unique private boolean pilot$resultShift;
    @Unique private boolean pilot$resultShiftPolled;

    @Override
    public final boolean pilot$shiftClickResult(Slot result, double x, double y) {
        var client = MinecraftClient.getInstance();
        var screen = (HandledScreen<?>) (Object) this;
        if (pilot$resultShift || !client.isOnThread() || client.currentScreen != screen
                || !client.isWindowFocused() || client.getOverlay() != null || client.player == null
                || !(screen instanceof InventoryScreen || screen instanceof CraftingScreen)
                || !(screen.getScreenHandler() instanceof AbstractCraftingScreenHandler handler)
                || client.player.currentScreenHandler != handler || result != handler.getOutputSlot()
                || ((PilotHandledScreenAccess) screen).pilot$slotAt(x, y) != result
                || !handler.getCursorStack().isEmpty() || !result.hasStack() || !result.isEnabled()) return false;
        pilot$resultShift = true;
        pilot$resultShiftPolled = false;
        try {
            return screen.mouseClicked(x, y, GLFW_MOUSE_BUTTON_LEFT) && pilot$resultShiftPolled;
        } finally {
            pilot$resultShift = false;
            pilot$resultShiftPolled = false;
        }
    }

    @Redirect(method = "mouseClicked", at = @At(value = "INVOKE",
            target = "Lnet/minecraft/client/util/InputUtil;isKeyPressed(JI)Z"))
    private boolean pilot$checkResultShift(long window, int key) {
        if (pilot$resultShift && key == InputUtil.GLFW_KEY_LEFT_SHIFT) {
            var client = MinecraftClient.getInstance();
            if (client.isOnThread() && client.currentScreen == (Object) this
                    && window == client.getWindow().getHandle()) {
                pilot$resultShiftPolled = true;
                return true;
            }
        }
        return InputUtil.isKeyPressed(window, key);
    }
}
