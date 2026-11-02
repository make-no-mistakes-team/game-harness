package io.gameharness.nativeclient.mixin;

import io.gameharness.nativeclient.VisibleScreenView;
import java.util.function.Function;
import java.util.List;
import net.minecraft.client.font.TextRenderer;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.gui.screen.ingame.EnchantmentScreen;
import net.minecraft.client.render.RenderLayer;
import net.minecraft.text.StringVisitable;
import net.minecraft.text.Text;
import net.minecraft.util.Identifier;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Redirect;

/** Capture draw arguments, never seed, enchantment lists, or undisplayed tooltip data. */
@Mixin(EnchantmentScreen.class)
public abstract class EnchantmentChoiceMixin {
  @Redirect(method = "drawBackground", at = @At(value = "INVOKE",
      target = "Lnet/minecraft/client/gui/DrawContext;drawGuiTexture(Ljava/util/function/Function;Lnet/minecraft/util/Identifier;IIII)V"))
  private void background(DrawContext context, Function<Identifier, RenderLayer> layers, Identifier texture, int x, int y, int width, int height) {
    context.drawGuiTexture(layers, texture, x, y, width, height);
    if (width == 108 && height == 19) VisibleScreenView.enchantmentChoice((EnchantmentScreen)(Object)this,
        x, y, !texture.getPath().endsWith("enchantment_slot_disabled"));
  }
  @Redirect(method = "drawBackground", at = @At(value = "INVOKE",
      target = "Lnet/minecraft/client/gui/DrawContext;drawWrappedText(Lnet/minecraft/client/font/TextRenderer;Lnet/minecraft/text/StringVisitable;IIIIZ)V"))
  private void runes(DrawContext context, TextRenderer renderer, StringVisitable text, int x, int y, int width, int color, boolean shadow) {
    context.drawWrappedText(renderer, text, x, y, width, color, shadow);
    VisibleScreenView.enchantmentRunes((EnchantmentScreen)(Object)this, y, text);
  }
  @Redirect(method = "drawBackground", at = @At(value = "INVOKE",
      target = "Lnet/minecraft/client/gui/DrawContext;drawTextWithShadow(Lnet/minecraft/client/font/TextRenderer;Ljava/lang/String;III)I"))
  private int cost(DrawContext context, TextRenderer renderer, String text, int x, int y, int color) {
    int result = context.drawTextWithShadow(renderer, text, x, y, color);
    VisibleScreenView.enchantmentCost((EnchantmentScreen)(Object)this, y, text);
    return result;
  }
  @Redirect(method = "render", at = @At(value = "INVOKE",
      target = "Lnet/minecraft/client/gui/DrawContext;drawTooltip(Lnet/minecraft/client/font/TextRenderer;Ljava/util/List;II)V"))
  private void tooltip(DrawContext context, TextRenderer renderer, List<Text> text, int x, int y) {
    context.drawTooltip(renderer, text, x, y);
    VisibleScreenView.enchantmentTooltip((EnchantmentScreen)(Object)this, x, y, text);
  }
}
