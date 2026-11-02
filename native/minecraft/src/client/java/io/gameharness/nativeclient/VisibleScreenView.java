package io.gameharness.nativeclient;

import com.google.gson.*;
import io.gameharness.nativeclient.mixin.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import net.minecraft.block.entity.BannerPattern;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.screen.Screen;
import net.minecraft.client.gui.screen.ingame.*;
import net.minecraft.client.gui.screen.recipebook.AnimatedResultButton;
import net.minecraft.client.gui.widget.ClickableWidget;
import net.minecraft.client.gui.widget.TextFieldWidget;
import net.minecraft.client.gui.widget.TexturedButtonWidget;
import net.minecraft.item.ItemStack;
import net.minecraft.entity.effect.StatusEffect;
import net.minecraft.registry.Registries;
import net.minecraft.registry.entry.RegistryEntry;
import net.minecraft.screen.AbstractFurnaceScreenHandler;
import net.minecraft.screen.BrewingStandScreenHandler;
import net.minecraft.screen.slot.Slot;
import net.minecraft.text.StringVisitable;
import net.minecraft.text.Text;

/** Captures only controls/slots actually drawn by the current vanilla screen, never recipe/offer catalogues. */
public final class VisibleScreenView {
  private static final int[] BREWING_BUBBLES = {29, 24, 20, 16, 11, 6, 0};
  private static Screen rendering, rendered;
  private static final Slot[] drawingSlots = new Slot[129], visibleSlots = new Slot[129];
  private static final ClickableWidget[] drawingWidgets = new ClickableWidget[65], visibleWidgets = new ClickableWidget[65];
  private static int drawingSlotCount, drawingWidgetCount, slotCount, widgetCount;
  private static int drawingMerchantPage, renderedMerchantPage;
  /** Read-only binding access on the real vanilla object; not an alternate effect path. */
  public interface BeaconEffect {
    RegistryEntry<StatusEffect> gameharness$effect();
    boolean gameharness$primary();
  }
  public interface PagedChoices { int gameharness$page(); }
  private static final class DrawnChoice {
    int type, index, page, x, y, width, height;
    boolean enabled, selected;
    Object icon;
    ClickableWidget widget;
    String cost;
    StringVisitable runes;
    List<Text> tooltip;
    String semantic, runeText;
    Object semanticIcon;
    int iconCount;
  }
  private static DrawnChoice[] drawingChoices = choices(), visibleChoices = choices();
  private static int drawingChoiceCount, choiceCount;
  private static Screen inputScreen;
  private static final ItemStack[] drawnInputs = {ItemStack.EMPTY, ItemStack.EMPTY, ItemStack.EMPTY};
  private static long inputEpoch;
  private static long renderedAt, frame;
  private static boolean overflow;
  private final MinecraftClient client;
  private final ScreenIncarnations incarnations;
  private Screen contentScreen;
  private String contentSignature;
  private long contentRevision;
  private final IdentityHashMap<ClickableWidget, String> ids = new IdentityHashMap<>();
  private final IdentityHashMap<ClickableWidget, String> bindings = new IdentityHashMap<>();
  private final IdentityHashMap<ClickableWidget, WidgetBinding> widgetBindings = new IdentityHashMap<>();
  private final ClickableWidget[] boundWidgets = new ClickableWidget[65];
  private int boundWidgetCount;
  private long bindingsFrame = -1;
  private long elementSequence;
  private long layoutSequence;
  private EffectAuthority.VisibleScreenRef currentIdentity;
  private final VisibleScreenContract.RenderedLayout layout = new VisibleScreenContract.RenderedLayout();
  private final ArrayList<VisibleScreenContract.Region> capturedRegions = new ArrayList<>(65);
  private final ChoiceBinding[] choiceBindings = new ChoiceBinding[65];
  private final VisibleScreenContract.RenderedRegions regions = new VisibleScreenContract.RenderedRegions();
  private static final class ChoiceBinding {
    long epoch;
    int type, index, page;
    String semantic;
    VisibleScreenContract.Region region;
    ClickableWidget widget;
  }
  /** Raw vanilla binding state; unchanged guards never build labels, stack copies or JSON. */
  private static final class TextMatch implements StringVisitable.Visitor<Boolean> {
    private static final Optional<Boolean> DIFFERENT = Optional.of(Boolean.TRUE);
    String expected;
    int offset;
    boolean matches(StringVisitable text) {
      offset = 0;
      return text.visit(this).isEmpty() && offset == expected.length();
    }
    public Optional<Boolean> accept(String segment) {
      if (!expected.regionMatches(offset, segment, 0, segment.length())) return DIFFERENT;
      offset += segment.length(); return Optional.empty();
    }
  }
  private static final TextMatch runeMatch = new TextMatch();
  private final class WidgetBinding {
    int recipe, page, index, demand, price;
    long epoch;
    float multiplier;
    Object offer, first, second, firstItem, secondItem, soldItem;
    int secondCount, soldCount;
    boolean disabled;
    TextMatch message;
    boolean matches(ClickableWidget widget) {
      if (widget instanceof TextFieldWidget) return true;
      if (widget instanceof AnimatedResultButton button) return recipe == button.getCurrentId().index();
      if (widget instanceof RecipeAlternativeAccess button) return recipe == button.gameharness$recipe().index();
      if (widget instanceof MerchantOfferAccess row && client.currentScreen instanceof MerchantScreen screen) {
        var offers = screen.getScreenHandler().getRecipes();
        int currentIndex = row.gameharness$index() + renderedMerchantPage;
        if (currentIndex < 0 || currentIndex >= offers.size()) throw new IllegalStateException("Rendered merchant row lost binding");
        var current = offers.get(currentIndex);
        var secondBuy = current.getSecondBuyItem().orElse(null);
        return epoch == inputEpoch && page == renderedMerchantPage && index == row.gameharness$index()
            && offer == current && first == current.getFirstBuyItem() && second == secondBuy
            && firstItem == current.getOriginalFirstBuyItem().getItem()
            && secondItem == (secondBuy == null ? null : secondBuy.itemStack().getItem())
            && secondCount == (secondBuy == null ? 0 : secondBuy.itemStack().getCount())
            && demand == current.getDemandBonus() && price == current.getSpecialPrice()
            && Float.compare(multiplier, current.getPriceMultiplier()) == 0 && disabled == current.isDisabled()
            && soldItem == current.getSellItem().getItem() && soldCount == current.getSellItem().getCount();
      }
      return message != null && message.matches(widget.getMessage());
    }
    void capture(ClickableWidget widget) {
      if (widget instanceof AnimatedResultButton button) recipe = button.getCurrentId().index();
      else if (widget instanceof RecipeAlternativeAccess button) recipe = button.gameharness$recipe().index();
      else if (widget instanceof MerchantOfferAccess row && client.currentScreen instanceof MerchantScreen screen) {
        var current = screen.getScreenHandler().getRecipes().get(row.gameharness$index() + renderedMerchantPage);
        var secondBuy = current.getSecondBuyItem().orElse(null);
        epoch = inputEpoch; page = renderedMerchantPage; index = row.gameharness$index();
        offer = current; first = current.getFirstBuyItem(); second = secondBuy; firstItem = current.getOriginalFirstBuyItem().getItem();
        secondItem = secondBuy == null ? null : secondBuy.itemStack().getItem(); secondCount = secondBuy == null ? 0 : secondBuy.itemStack().getCount();
        demand = current.getDemandBonus(); price = current.getSpecialPrice(); multiplier = current.getPriceMultiplier();
        disabled = current.isDisabled(); soldItem = current.getSellItem().getItem(); soldCount = current.getSellItem().getCount();
      } else if (!(widget instanceof TextFieldWidget)) {
        if (message == null) message = new TextMatch();
        message.expected = widget.getMessage().getString();
      }
    }
  }
  public record Element(String id, String kind, boolean enabled, int x, int y, int width, int height,
      ClickableWidget widget, VisibleScreenContract.Region region) {
    public boolean contains(double px, double py) { return region != null ? region.contains(px, py) : px >= x && py >= y && px < (double)x + width && py < (double)y + height; }
    public boolean accepts(String operation) {
      return region != null ? region.accepts(operation) : enabled && (operation.equals("text") ? kind.equals("text") : operation.equals("element"));
    }
  }
  private final Map<String, Element> elementsById = new HashMap<>();

  private static DrawnChoice[] choices() {
    DrawnChoice[] choices = new DrawnChoice[65];
    for (int i = 0; i < choices.length; i++) choices[i] = new DrawnChoice();
    return choices;
  }
  private static int inputCount(Screen screen) {
    return screen instanceof LoomScreen ? 3 : screen instanceof EnchantmentScreen ? 2
        : screen instanceof MerchantScreen ? 2
        : screen instanceof StonecutterScreen || screen instanceof BeaconScreen ? 1 : 0;
  }
  static boolean customView(Screen screen) { return inputCount(screen) > 0; }
  private static boolean inputsMatch(HandledScreen<?> screen) {
    if (inputScreen != screen) return false;
    for (int i = 0; i < inputCount(screen); i++)
      if (!ItemStack.areEqual(drawnInputs[i], screen.getScreenHandler().getSlot(i).getStack())) return false;
    return true;
  }

  public VisibleScreenView(MinecraftClient client, ScreenIncarnations incarnations) { this.client = client; this.incarnations = incarnations; }
  public static void begin(Screen screen) {
    rendering = screen; drawingSlotCount = drawingWidgetCount = drawingChoiceCount = 0; overflow = false;
    if (screen instanceof MerchantScreen) drawingMerchantPage = ((MerchantScreenAccess)screen).gameharness$offset();
    if (inputCount(screen) > 0 && screen instanceof HandledScreen<?> handled && !inputsMatch(handled)) {
      inputScreen = screen; inputEpoch = ContractIdentity.next(inputEpoch);
      for (int i = 0; i < inputCount(screen); i++) drawnInputs[i] = handled.getScreenHandler().getSlot(i).getStack().copy();
    }
  }
  public static void slot(Slot slot) {
    if (!(rendering instanceof HandledScreen<?>)) return;
    if (drawingSlotCount >= drawingSlots.length) { overflow = true; return; }
    drawingSlots[drawingSlotCount++] = slot;
  }
  public static void widget(ClickableWidget widget) {
    if (!(rendering instanceof HandledScreen<?>) || !widget.visible || widget instanceof BeaconEffect) return;
    for (int i = 0; i < drawingWidgetCount; i++) if (drawingWidgets[i] == widget) return;
    if (drawingWidgetCount >= drawingWidgets.length) { overflow = true; return; }
    drawingWidgets[drawingWidgetCount++] = widget;
  }
  public static void end(Screen screen) {
    if (rendering != screen) return;
    for (int i = 0; i < drawingChoiceCount; i++) {
      DrawnChoice choice = drawingChoices[i], prior = i < choiceCount && rendered == screen ? visibleChoices[i] : null;
      choice.semanticIcon = choice.type == 1 ? ((ItemStack)choice.icon).getItem() : choice.icon;
      choice.iconCount = choice.type == 1 ? ((ItemStack)choice.icon).getCount() : 0;
      choice.runeText = null;
      if (choice.cost != null && choice.runes != null) {
        runeMatch.expected = prior == null ? null : prior.runeText;
        choice.runeText = runeMatch.expected != null && runeMatch.matches(choice.runes) ? prior.runeText : choice.runes.getString();
      }
      boolean same = prior != null && prior.type == choice.type && prior.index == choice.index && prior.page == choice.page
          && Objects.equals(prior.semanticIcon, choice.semanticIcon) && prior.iconCount == choice.iconCount
          && Objects.equals(prior.cost, choice.cost) && Objects.equals(prior.runeText, choice.runeText);
      choice.semantic = same ? prior.semantic : choiceSemantic(choice);
    }
    rendered = screen; rendering = null;
    slotCount = drawingSlotCount; widgetCount = drawingWidgetCount;
    renderedMerchantPage = drawingMerchantPage;
    System.arraycopy(drawingSlots, 0, visibleSlots, 0, slotCount);
    System.arraycopy(drawingWidgets, 0, visibleWidgets, 0, widgetCount);
    choiceCount = drawingChoiceCount;
    DrawnChoice[] swap = visibleChoices; visibleChoices = drawingChoices; drawingChoices = swap;
    renderedAt = System.nanoTime(); frame++;
  }
  private static String choiceSemantic(DrawnChoice choice) {
    if (choice.type == 1) return stackText((ItemStack)choice.icon);
    if (choice.type == 2 || choice.type == 5) return choice.icon.toString();
    if (choice.type == 4) {
      @SuppressWarnings("unchecked") var effect = (RegistryEntry<StatusEffect>)choice.icon;
      return (choice.page == 1 ? "primary " : "secondary ") + effect.getKey().orElseThrow().getValue().getPath();
    }
    return "option " + (choice.index + 1) + (choice.cost == null ? " unavailable" : " level " + choice.cost + " runes " + choice.runeText);
  }
  private static DrawnChoice choice(Screen screen, int type, int index, int page, boolean enabled, boolean selected,
      int x, int y, int width, int height, Object icon, ClickableWidget widget) {
    if (rendering != screen) return null;
    if (drawingChoiceCount == drawingChoices.length) { overflow = true; return null; }
    DrawnChoice choice = drawingChoices[drawingChoiceCount++];
    choice.type = type; choice.index = index; choice.page = page; choice.enabled = enabled; choice.selected = selected;
    choice.x = x; choice.y = y; choice.width = width; choice.height = height; choice.icon = icon; choice.widget = widget;
    choice.cost = null; choice.runes = null; choice.tooltip = null;
    return choice;
  }
  public static void stoneChoice(StonecutterScreen screen, int index, int page, ItemStack icon, boolean selected, int x, int y) {
    choice(screen, 1, index, page, true, selected, x, y, 16, 18, icon, null);
  }
  public static void loomChoice(LoomScreen screen, int index, int page, RegistryEntry<BannerPattern> icon, boolean selected, int x, int y) {
    choice(screen, 2, index, page, true, selected, x, y, 14, 14, icon.value().assetId(), null);
  }
  public static void scrollRegion(Screen screen, int page, String text, int x, int y, int width, int height) {
    choice(screen, 5, 0, page, true, false, x, y, width, height, text, null);
  }
  public static void beaconChoice(ClickableWidget widget, RegistryEntry<StatusEffect> icon, boolean primary, boolean selected) {
    if (!(rendering instanceof BeaconScreen)) return;
    choice(rendering, 4, drawingChoiceCount, primary ? 1 : 0, widget.active, selected,
        widget.getX(), widget.getY(), widget.getWidth(), widget.getHeight(), icon, widget);
  }
  public static void enchantmentChoice(EnchantmentScreen screen, int x, int y, boolean enabled) {
    int row = (y - ((HandledScreenAccess)screen).gameharness$y() - 14) / 19;
    choice(screen, 3, row, 0, enabled, false, x, y, 108, 19, null, null);
  }
  private static DrawnChoice enchantmentRow(EnchantmentScreen screen, int y, int offset) {
    if (screen != rendering) return null;
    int row = (y - ((HandledScreenAccess)screen).gameharness$y() - offset) / 19;
    for (int i = 0; i < drawingChoiceCount; i++) if (drawingChoices[i].type == 3 && drawingChoices[i].index == row) return drawingChoices[i];
    return null;
  }
  public static void enchantmentRunes(EnchantmentScreen screen, int y, StringVisitable text) {
    DrawnChoice choice = enchantmentRow(screen, y, 16); if (choice != null) choice.runes = text;
  }
  public static void enchantmentCost(EnchantmentScreen screen, int y, String text) {
    DrawnChoice choice = enchantmentRow(screen, y, 23); if (choice != null) choice.cost = text;
  }
  public static void enchantmentTooltip(EnchantmentScreen screen, int x, int y, List<Text> text) {
    if (screen != rendering) return;
    for (int i = 0; i < drawingChoiceCount; i++) {
      DrawnChoice choice = drawingChoices[i];
      if (choice.type == 3 && x >= choice.x && x < choice.x + choice.width && y >= choice.y && y < choice.y + choice.height) choice.tooltip = text;
    }
  }
  public static long frame() { return frame; }
  public boolean ready() {
    return client.currentScreen == null || client.currentScreen == rendered
        && System.nanoTime() - renderedAt <= 2_000_000_000L;
  }
  public static VisibleScreenContract.Value value(ItemStack stack) {
    return stack.isEmpty() ? new VisibleScreenContract.Value(null, 0)
        : new VisibleScreenContract.Value(Registries.ITEM.getId(stack.getItem()).getPath(), stack.getCount());
  }
  private static JsonObject bounds(int x, int y, int width, int height) {
    if (width <= 0 || height <= 0) throw new IllegalArgumentException("Visible bounds must be positive");
    JsonObject out = new JsonObject(); out.addProperty("x", x); out.addProperty("y", y);
    out.addProperty("width", width); out.addProperty("height", height); return out;
  }
  private static String stackText(ItemStack stack) {
    return stack.isEmpty() ? "empty" : stack.getCount() + " " + Registries.ITEM.getId(stack.getItem()).getPath();
  }
  private String label(ClickableWidget widget) {
    if (widget instanceof TexturedButtonWidget && client.currentScreen instanceof RecipeBookScreen<?> bookScreen) {
      var position = ((RecipeBookScreenAccess)bookScreen).gameharness$bookButton();
      if (widget.getX() == position.x() && widget.getY() == position.y()
          && widget.getWidth() == 20 && widget.getHeight() == 18) return "recipe_book_toggle";
    }
    if (widget instanceof AnimatedResultButton recipe) return stackText(recipe.getDisplayStack());
    if (widget instanceof MerchantOfferAccess row && client.currentScreen instanceof MerchantScreen merchant) {
      int index = row.gameharness$index() + renderedMerchantPage;
      var offers = merchant.getScreenHandler().getRecipes();
      if (index < 0 || index >= offers.size()) throw new IllegalStateException("Rendered merchant row lost binding");
      // Exactly the row already rendered. Do not enumerate unrendered offers or their hidden metadata.
      var offer = offers.get(index);
      return (((MerchantScreenAccess) merchant).gameharness$selected() == index ? "selected " : "")
          + stackText(offer.getDisplayedFirstBuyItem()) + " + " + stackText(offer.getDisplayedSecondBuyItem())
          + " -> " + stackText(offer.getSellItem()) + (offer.isDisabled() ? " unavailable" : "");
    }
    return widget instanceof TextFieldWidget field ? field.getText() : widget.getMessage().getString();
  }
  private String binding(ClickableWidget widget, String label) {
    if (widget instanceof TextFieldWidget) return "text";
    if (widget instanceof AnimatedResultButton recipe) return "recipe:" + recipe.getCurrentId().index();
    if (widget instanceof RecipeAlternativeAccess recipe) return "recipe:" + recipe.gameharness$recipe().index();
    if (widget instanceof MerchantOfferAccess row)
      return "offer:" + inputEpoch + ":" + renderedMerchantPage + ":" + row.gameharness$index()
          + ":" + widget.getX() + ":" + widget.getY() + ":" + widget.getWidth() + ":" + widget.getHeight()
          + ":" + label.replace("selected ", "");
    return widget.getClass().getName() + ":" + label;
  }
  public Element element(String id) { return elementsById.get(id); }
  public Map<Integer, VisibleScreenContract.Value> values() {
    Map<Integer, VisibleScreenContract.Value> values = new HashMap<>();
    for (int i = 0; i < slotCount; i++) values.put(visibleSlots[i].id, value(visibleSlots[i].getStack())); return values;
  }
  public Slot slot(int id) { for (int i = 0; i < slotCount; i++) if (visibleSlots[i].id == id) return visibleSlots[i]; return null; }
  /** Refresh exact live layout custody without projecting slot values, cursor, progress or content JSON. */
  public EffectAuthority.VisibleScreenRef currentLayout() {
    if (client.currentScreen == null) return null;
    if (!(client.currentScreen instanceof HandledScreen<?> screen)) throw new IllegalArgumentException("Unsupported non-handled visible view");
    if (client.player == null || screen.getScreenHandler() != client.player.currentScreenHandler) throw new IllegalStateException("Visible handler unavailable");
    if (rendered != screen || System.nanoTime() - renderedAt > 2_000_000_000L) throw new IllegalStateException("Waiting for a current rendered vanilla layout");
    if (inputCount(screen) > 0 && !inputsMatch(screen)) throw new IllegalStateException("Waiting for current rendered custom choices after an input change");
    if (screen instanceof MerchantScreen && ((MerchantScreenAccess)screen).gameharness$offset() != renderedMerchantPage)
      throw new IllegalStateException("Waiting for current rendered merchant offer page");
    if (overflow || slotCount > 128 || widgetCount + choiceCount > 64 || screen.getScreenHandler().slots.size() > 128) throw new IllegalArgumentException("Visible projection bound exceeded");
    boolean ownerChanged = screen != contentScreen;
    if (ownerChanged) {
      contentScreen = screen; contentSignature = null; contentRevision = 0; ids.clear(); bindings.clear();
      widgetBindings.clear(); elementsById.clear(); boundWidgetCount = 0;
      Arrays.fill(choiceBindings, null); capturedRegions.clear();
    }
    var access = (HandledScreenAccess) screen;
    layout.begin(screen, screen.width, screen.height, client.getWindow().getScaleFactor());
    long lowSlots = 0, highSlots = 0;
    for (int i = 0; i < slotCount; i++) {
      Slot slot = visibleSlots[i];
      if (slot.id < 0 || slot.id > 127) throw new IllegalArgumentException("Rendered slot id bound exceeded");
      long bit = 1L << (slot.id & 63);
      if (((slot.id < 64 ? lowSlots : highSlots) & bit) != 0) throw new IllegalArgumentException("Duplicate rendered slot");
      if (slot.id < 64) lowSlots |= bit; else highSlots |= bit;
      layout.slot(slot, slot.id, access.gameharness$x() + slot.x, access.gameharness$y() + slot.y, slot.isEnabled());
    }
    if (bindingsFrame != frame) {
      for (int i = 0; i < boundWidgetCount; i++) {
        ClickableWidget previous = boundWidgets[i];
        boolean present = false;
        for (int j = 0; j < widgetCount; j++) if (visibleWidgets[j] == previous) { present = true; break; }
        if (!present) { elementsById.remove(ids.remove(previous)); bindings.remove(previous); widgetBindings.remove(previous); }
      }
      System.arraycopy(visibleWidgets, 0, boundWidgets, 0, widgetCount);
      Arrays.fill(boundWidgets, widgetCount, Math.max(widgetCount, boundWidgetCount), null); boundWidgetCount = widgetCount;
      bindingsFrame = frame;
    }
    for (int i = 0; i < widgetCount; i++) {
      ClickableWidget widget = visibleWidgets[i];
      if (!widget.visible) throw new IllegalStateException("Visible control changed before projection");
      WidgetBinding state = widgetBindings.get(widget);
      Element old = elementsById.get(ids.get(widget));
      boolean moved = old == null || old.x() != widget.getX() || old.y() != widget.getY()
          || old.width() != widget.getWidth() || old.height() != widget.getHeight();
      if (state == null || moved || !state.matches(widget)) {
        String text = widget instanceof TextFieldWidget || widget instanceof AnimatedResultButton || widget instanceof RecipeAlternativeAccess ? "" : label(widget);
        String binding = binding(widget, text);
        if (!binding.equals(bindings.get(widget))) {
          elementsById.remove(ids.get(widget));
          bindings.put(widget, binding); elementSequence = ContractIdentity.next(elementSequence); ids.put(widget, "element-" + elementSequence);
        }
        if (state == null) { state = new WidgetBinding(); widgetBindings.put(widget, state); }
        state.capture(widget);
      }
      String kind = widget instanceof TextFieldWidget ? "text" : widget instanceof AnimatedResultButton || widget instanceof RecipeAlternativeAccess ? "recipe" : widget instanceof MerchantOfferAccess ? "trade_offer" : "button";
      String id = ids.get(widget);
      if (moved || old.enabled() != widget.active || !old.id().equals(id))
        elementsById.put(id, new Element(id, kind, widget.active, widget.getX(), widget.getY(), widget.getWidth(), widget.getHeight(), widget, null));
      layout.element(id, widget.active, widget.getX(), widget.getY(), widget.getWidth(), widget.getHeight());
    }
    boolean regionsChanged = ownerChanged || capturedRegions.size() != choiceCount;
    for (int i = 0; i < choiceCount; i++) {
      DrawnChoice choice = visibleChoices[i];
      if (screen instanceof PagedChoices paged && paged.gameharness$page() != choice.page)
        throw new IllegalStateException("Waiting for current rendered choice page");
      if (choice.type == 3 && choice.cost != null && choice.runeText == null)
        throw new IllegalStateException("Waiting for current rendered enchantment text");
      if (choice.widget != null && (!choice.widget.visible || choice.widget.active != choice.enabled
          || choice.widget.getX() != choice.x || choice.widget.getY() != choice.y
          || choice.widget.getWidth() != choice.width || choice.widget.getHeight() != choice.height
          || choice.widget instanceof BeaconEffect effect && (!effect.gameharness$effect().equals(choice.icon)
          || effect.gameharness$primary() != (choice.page == 1)
          || ((BeaconButtonAccess)choice.widget).gameharness$selected() != choice.selected)))
        throw new IllegalStateException("Waiting for current rendered choice widget binding");
      ChoiceBinding prior = choiceBindings[i];
      var region = prior == null ? null : prior.region;
      if (prior == null || prior.epoch != inputEpoch || prior.type != choice.type || prior.page != choice.page
          || prior.index != choice.index || prior.widget != choice.widget || !prior.semantic.equals(choice.semantic) || region.enabled() != choice.enabled
          || region.x() != choice.x || region.y() != choice.y || region.width() != choice.width || region.height() != choice.height) {
        if (prior == null) { prior = new ChoiceBinding(); choiceBindings[i] = prior; }
        prior.epoch = inputEpoch; prior.type = choice.type; prior.page = choice.page; prior.index = choice.index; prior.semantic = choice.semantic; prior.widget = choice.widget;
        prior.region = new VisibleScreenContract.Region("draw-" + choice.type + "-" + choice.index,
            inputEpoch + ":" + choice.page + ":" + choice.index + ":" + choice.semantic,
            choice.type == 5 ? "scroll_region" : "choice", "", choice.enabled, choice.x, choice.y, choice.width, choice.height);
        regionsChanged = true;
      }
    }
    if (regionsChanged) {
      for (var previous : regions.elements()) elementsById.remove(previous.id());
      capturedRegions.clear();
      for (int i = 0; i < choiceCount; i++) capturedRegions.add(choiceBindings[i].region);
      Arrays.fill(choiceBindings, choiceCount, choiceBindings.length, null);
      regions.publish(screen, capturedRegions);
    }
    for (int i = 0; i < regions.elements().size(); i++) {
      var capturedElement = regions.elements().get(i);
      var region = capturedElement.region();
      ClickableWidget widget = visibleChoices[i].widget;
      if (regionsChanged) elementsById.put(capturedElement.id(), new Element(capturedElement.id(), region.kind(), region.enabled(),
          region.x(), region.y(), region.width(), region.height(), widget, region));
      layout.element(capturedElement.id(), region.enabled(), region.x(), region.y(), region.width(), region.height());
    }
    if (layout.finish()) {
      layoutSequence = ContractIdentity.next(layoutSequence);
      incarnations.layoutChanged(screen, Long.toString(layoutSequence)); currentIdentity = incarnations.visible();
    } else if (currentIdentity == null || incarnations.screen() == null
        || currentIdentity.incarnation() != incarnations.screen().incarnation()
        || !currentIdentity.id().equals(incarnations.screen().id())) {
      incarnations.layoutChanged(screen, Long.toString(layoutSequence)); currentIdentity = incarnations.visible();
    }
    return currentIdentity;
  }
  public JsonElement snapshot() {
    EffectAuthority.VisibleScreenRef identity = currentLayout();
    if (identity == null) return JsonNull.INSTANCE;
    HandledScreen<?> screen = (HandledScreen<?>)client.currentScreen;
    var access = (HandledScreenAccess)screen;
    JsonObject out = new JsonObject(), viewport = new JsonObject();
    viewport.addProperty("width", screen.width); viewport.addProperty("height", screen.height);
    viewport.addProperty("scale_factor", client.getWindow().getScaleFactor()); out.add("viewport", viewport);
    JsonArray slots = new JsonArray(), elements = new JsonArray(), progress = new JsonArray();
    for (int i = 0; i < slotCount; i++) {
      Slot slot = visibleSlots[i];
      JsonObject entry = new JsonObject(); entry.addProperty("slot_id", slot.id); entry.add("value", value(slot.getStack()).json());
      entry.add("bounds", bounds(access.gameharness$x() + slot.x, access.gameharness$y() + slot.y, 16, 16));
      entry.addProperty("enabled", slot.isEnabled()); slots.add(entry);
    }
    int textBytes = 0;
    for (int i = 0; i < widgetCount + choiceCount; i++) {
      Element element;
      String text;
      if (i < widgetCount) { element = elementsById.get(ids.get(visibleWidgets[i])); text = label(visibleWidgets[i]); }
      else {
        int choiceIndex = i - widgetCount;
        DrawnChoice choice = visibleChoices[choiceIndex];
        element = elementsById.get(regions.elements().get(choiceIndex).id());
        text = (choice.selected ? "selected " : "") + choice.semantic;
        if (choice.tooltip != null) {
          StringBuilder tooltip = new StringBuilder(text).append(" tooltip");
          for (Text line : choice.tooltip) tooltip.append(" | ").append(line.getString());
          text = tooltip.toString();
        }
      }
      if (text.length() > 256 || (textBytes += text.getBytes(StandardCharsets.UTF_8).length) > 8192)
        throw new IllegalArgumentException("Visible text bound exceeded");
      JsonObject entry = new JsonObject(); entry.addProperty("element_id", element.id()); entry.addProperty("kind", element.kind());
      entry.addProperty("text", text); entry.addProperty("enabled", element.enabled());
      entry.add("bounds", bounds(element.x(), element.y(), element.width(), element.height())); elements.add(entry);
    }
    if (screen instanceof AbstractFurnaceScreen<?> && screen.getScreenHandler() instanceof AbstractFurnaceScreenHandler furnace) {
      bar(progress, "cook_arrow", (int)Math.ceil(furnace.getCookProgress() * 24), 24);
      bar(progress, "fuel_flame", furnace.isBurning() ? (int)Math.ceil(furnace.getFuelProgress() * 13) + 1 : 0, 14);
    }
    if (screen instanceof BrewingStandScreen && screen.getScreenHandler() instanceof BrewingStandScreenHandler brewing) {
      int time = brewing.getBrewTime();
      bar(progress, "brewing_fuel", (18 * brewing.getFuel() + 19) / 20, 18);
      bar(progress, "brewing_arrow", time > 0 ? (int)(28 * (1 - time / 400.0f)) : 0, 28);
      bar(progress, "brewing_bubbles", time > 0 ? BREWING_BUBBLES[time / 2 % 7] : 0, 29);
    }
    out.add("identity", NativeEffectContract.visibleScreen(identity)); out.addProperty("screen_kind", kind(screen));
    out.add("slots", slots); out.add("cursor", value(screen.getScreenHandler().getCursorStack()).json());
    out.add("elements", elements); out.add("progress", progress);
    String contents = slots.toString() + out.get("cursor") + elements + progress;
    if (!contents.equals(contentSignature)) { contentSignature = contents; contentRevision = ContractIdentity.next(contentRevision); }
    out.addProperty("content_revision", contentRevision); return out;
  }
  private static void bar(JsonArray entries, String id, int value, int maximum) {
    JsonObject bar = new JsonObject(); bar.addProperty("id", id); bar.addProperty("value", Math.max(0, Math.min(maximum, value))); bar.addProperty("maximum", maximum); entries.add(bar);
  }
  private static String kind(HandledScreen<?> screen) {
    if (screen instanceof StonecutterScreen) return "stonecutter";
    if (screen instanceof LoomScreen) return "loom";
    if (screen instanceof EnchantmentScreen) return "enchanting";
    if (screen instanceof BeaconScreen) return "beacon";
    if (screen instanceof MerchantScreen) return "merchant";
    if (screen instanceof AnvilScreen) return "anvil";
    if (screen instanceof FurnaceScreen) return "furnace";
    if (screen instanceof BlastFurnaceScreen || screen instanceof SmokerScreen) return "furnace";
    if (screen instanceof CraftingScreen) return "crafting";
    if (screen instanceof InventoryScreen) return "inventory";
    if (screen instanceof GenericContainerScreen) return "generic_container";
    return "other_handled";
  }
}
