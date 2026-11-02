package io.gameharness.nativeclient.mixin;

import net.minecraft.recipe.NetworkRecipeId;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

@Mixin(targets = "net.minecraft.client.gui.screen.recipebook.RecipeAlternativesWidget$AlternativeButtonWidget")
public interface RecipeAlternativeAccess {
  @Accessor("recipeId") NetworkRecipeId gameharness$recipe();
}
