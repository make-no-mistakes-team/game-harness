package io.gameharness.nativeclient.mixin;

import io.gameharness.nativeclient.VisibleScreenView;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.gui.widget.ClickableWidget;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(ClickableWidget.class)
public abstract class VisibleWidgetMixin {
  @Inject(method = "render", at = @At("HEAD"))
  private void capture(DrawContext context, int x, int y, float delta, CallbackInfo ci) {
    VisibleScreenView.widget((ClickableWidget)(Object)this);
  }
}
