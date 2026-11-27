package io.gameharness.survival.mixin;

import net.minecraft.client.texture.AbstractTexture;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

@Mixin(AbstractTexture.class)
public interface AgentTextureFilterAccess {
    @Accessor("magFilter")
    int gameharness$magnificationFilter();
}
