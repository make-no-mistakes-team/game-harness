package io.gameharness.nativeclient;

import java.util.concurrent.TimeUnit;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;

/** A supervisor crash must not leave a detached private server accepting sessions. */
public final class ServerOwner implements ModInitializer {
  public void onInitialize() {
    String parent = System.getenv("GAMEHARNESS_PARENT_PID");
    if (parent == null) return;
    long pid = Long.parseLong(parent);
    ProcessHandle owner =
        ProcessHandle.of(pid)
            .orElseThrow(() -> new IllegalStateException("Native supervisor unavailable"));
    var running =
        new java.util.concurrent.atomic.AtomicReference<net.minecraft.server.MinecraftServer>();
    ServerLifecycleEvents.SERVER_STARTED.register(running::set);
    owner
        .onExit()
        .thenRun(
            () -> {
              var server = running.get();
              if (server == null) {
                Runtime.getRuntime().halt(1);
                return;
              }
              server.stop(false);
              Thread deadline =
                  new Thread(
                      () -> {
                        try {
                          TimeUnit.SECONDS.sleep(20);
                        } catch (InterruptedException ignored) {
                        }
                        Runtime.getRuntime().halt(1);
                      },
                      "gameharness-owner-exit");
              deadline.setDaemon(true);
              deadline.start();
            });
    if (!owner.isAlive()) throw new IllegalStateException("Native supervisor exited");
  }
}
