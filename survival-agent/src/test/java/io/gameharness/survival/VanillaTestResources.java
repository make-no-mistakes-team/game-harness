package io.gameharness.survival;

import java.util.List;
import net.minecraft.Bootstrap;
import net.minecraft.SharedConstants;
import net.minecraft.registry.DynamicRegistryManager;
import net.minecraft.registry.Registry;
import net.minecraft.registry.Registries;
import net.minecraft.registry.tag.TagGroupLoader;
import net.minecraft.resource.LifecycledResourceManagerImpl;
import net.minecraft.resource.ResourceType;
import net.minecraft.resource.VanillaDataPackProvider;

final class VanillaTestResources {
    private static boolean ready;

    private VanillaTestResources() {}

    static synchronized void initialize() {
        if (ready) return;
        SharedConstants.createGameVersion();
        Bootstrap.initialize();
        // Fabric normally finishes registry and tag initialization during game startup.
        Registries.bootstrap();
        try (var packs = new LifecycledResourceManagerImpl(ResourceType.SERVER_DATA,
                List.of(VanillaDataPackProvider.createDefaultPack()))) {
            TagGroupLoader.startReload(packs, DynamicRegistryManager.of(Registries.REGISTRIES))
                .forEach(Registry.PendingTagLoad::apply);
        }
        ready = true;
    }
}
