package io.gameharness.survival.mixin;

import java.util.List;
import net.minecraft.client.render.model.MultipartBakedModel;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

@Mixin(MultipartBakedModel.class)
public interface AgentMultipartModelAccess {
    @Accessor("selectors")
    List<MultipartBakedModel.Selector> gameharness$selectors();
}
