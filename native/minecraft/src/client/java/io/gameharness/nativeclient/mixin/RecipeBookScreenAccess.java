package io.gameharness.nativeclient.mixin;

import net.minecraft.client.gui.ScreenPos;
import net.minecraft.client.gui.screen.ingame.RecipeBookScreen;
import net.minecraft.client.gui.screen.recipebook.RecipeBookWidget;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;
import org.spongepowered.asm.mixin.gen.Invoker;

@Mixin(RecipeBookScreen.class)
public interface RecipeBookScreenAccess {
  @Accessor("recipeBook") RecipeBookWidget<?> gameharness$book();
  @Invoker("getRecipeBookButtonPos") ScreenPos gameharness$bookButton();
}
