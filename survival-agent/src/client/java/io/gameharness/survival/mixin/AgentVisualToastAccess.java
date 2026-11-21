package io.gameharness.survival.mixin;

import java.util.List;
import net.minecraft.client.toast.ToastManager;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

@Mixin(ToastManager.class)
public interface AgentVisualToastAccess {
    @Accessor("visibleEntries") List<?> agent$visualToasts();
}
