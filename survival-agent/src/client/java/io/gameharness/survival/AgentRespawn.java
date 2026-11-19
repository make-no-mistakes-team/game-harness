package io.gameharness.survival;

import net.fabricmc.fabric.api.client.screen.v1.Screens;
import net.minecraft.client.gui.screen.DeathScreen;
import net.minecraft.client.gui.widget.ButtonWidget;
import net.minecraft.text.TranslatableTextContent;

/** A one-shot click on the enabled Respawn control shown by vanilla. */
final class AgentRespawn {
    private DeathScreen screen;
    private ButtonWidget target;
    private boolean renderedHover, attempted;

    void rendered(DeathScreen shown, int mouseX, int mouseY, AgentHands hands) {
        if (attempted) return;
        ButtonWidget button = respawnButton(shown);
        boolean changed = shown != screen || button != target;
        screen = shown;
        target = button;
        renderedHover = button != null && hands.pointAtButton(button, changed) && button.isMouseOver(mouseX, mouseY);
    }

    AgentHands.ButtonPress press(DeathScreen shown, AgentHands hands) {
        if (attempted || !renderedHover || shown != screen || respawnButton(shown) != target)
            return AgentHands.ButtonPress.NOT_READY;
        var result = hands.pressButton(shown, target);
        attempted = result != AgentHands.ButtonPress.NOT_READY;
        renderedHover = false;
        return result;
    }

    private static ButtonWidget respawnButton(DeathScreen shown) {
        ButtonWidget match = null;
        for (var child : Screens.getButtons(shown)) {
            if (child instanceof ButtonWidget button && button.visible && button.active
                && button.getMessage().getContent() instanceof TranslatableTextContent text
                && text.getKey().equals("deathScreen.respawn")
                && button.getX() >= 0 && button.getY() >= 0
                && button.getX() + button.getWidth() <= shown.width
                && button.getY() + button.getHeight() <= shown.height) {
                if (match != null) return null;
                match = button;
            }
        }
        return match;
    }
}
