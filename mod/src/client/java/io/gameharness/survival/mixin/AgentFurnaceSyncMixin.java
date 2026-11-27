package io.gameharness.survival.mixin;

import io.gameharness.survival.AgentFurnaceSync;
import java.util.List;
import net.minecraft.item.ItemStack;
import net.minecraft.screen.FurnaceScreenHandler;
import net.minecraft.screen.ScreenHandler;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(ScreenHandler.class)
abstract class AgentFurnaceSyncMixin implements AgentFurnaceSync {
    @Unique private boolean agent$furnaceContentsSynced;
    @Unique private long agent$furnaceOutputUpdates;

    @Override
    public boolean agent$furnaceContentsSynced() { return agent$furnaceContentsSynced; }

    @Override
    public long agent$furnaceOutputUpdates() { return agent$furnaceOutputUpdates; }

    @Inject(method = "updateSlotStacks", at = @At("RETURN"))
    private void agent$furnaceContents(int revision, List<ItemStack> contents, ItemStack cursor, CallbackInfo callback) {
        if ((Object) this instanceof FurnaceScreenHandler) {
            agent$furnaceContentsSynced = true;
            ++agent$furnaceOutputUpdates;
        }
    }

    @Inject(method = "setStackInSlot", at = @At("RETURN"))
    private void agent$furnaceSlot(int slot, int revision, ItemStack stack, CallbackInfo callback) {
        if (slot == 2 && (Object) this instanceof FurnaceScreenHandler) ++agent$furnaceOutputUpdates;
    }
}
