package io.gameharness.nativeclient.mixin;

import io.gameharness.nativeclient.NativeClient;
import net.minecraft.client.util.Window;
import org.lwjgl.glfw.GLFW;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.*;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(Window.class)
public abstract class WindowMixin {
  @Redirect(
      method = "<init>",
      at =
          @At(
              value = "INVOKE",
              target = "Lorg/lwjgl/glfw/GLFW;glfwCreateWindow(IILjava/lang/CharSequence;JJ)J"))
  private long hidden(int width, int height, CharSequence title, long monitor, long share) {
    if (NativeClient.managed()) {
      GLFW.glfwWindowHint(GLFW.GLFW_VISIBLE, GLFW.GLFW_FALSE);
      monitor = 0;
    }
    return GLFW.glfwCreateWindow(width, height, title, monitor, share);
  }

  @Inject(method = "toggleFullscreen", at = @At("HEAD"), cancellable = true)
  private void windowed(CallbackInfo ci) {
    if (NativeClient.managed()) ci.cancel();
  }
}
