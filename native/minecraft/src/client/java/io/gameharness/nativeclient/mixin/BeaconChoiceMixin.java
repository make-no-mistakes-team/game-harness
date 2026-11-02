package io.gameharness.nativeclient.mixin;

import io.gameharness.nativeclient.VisibleScreenView;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.gui.widget.ClickableWidget;
import net.minecraft.entity.effect.StatusEffect;
import net.minecraft.registry.entry.RegistryEntry;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(targets = "net.minecraft.client.gui.screen.ingame.BeaconScreen$EffectButtonWidget")
public abstract class BeaconChoiceMixin implements VisibleScreenView.BeaconEffect {
  @Shadow @Final private boolean primary;
  @Shadow private RegistryEntry<StatusEffect> effect;
  @Override public RegistryEntry<StatusEffect> gameharness$effect() { return effect; }
  @Override public boolean gameharness$primary() { return primary; }
  @Inject(method = "renderExtra", at = @At("TAIL"))
  private void icon(DrawContext context, CallbackInfo ci) {
    VisibleScreenView.beaconChoice((ClickableWidget)(Object)this, effect, primary,
        ((BeaconButtonAccess)(Object)this).gameharness$selected());
  }
}
