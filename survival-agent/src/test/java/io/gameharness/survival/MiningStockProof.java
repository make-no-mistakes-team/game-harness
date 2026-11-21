package io.gameharness.survival;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.Set;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.block.FluidBlock;
import net.minecraft.block.entity.BlockEntity;
import net.minecraft.component.DataComponentTypes;
import net.minecraft.component.type.UnbreakableComponent;
import net.minecraft.entity.player.PlayerInventory;
import net.minecraft.fluid.FluidState;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.state.property.Properties;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;
import net.minecraft.world.BlockView;
import net.minecraft.world.EmptyBlockView;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

/** Exercises actual vanilla stacks and block states without starting a client or world. */
final class MiningStockProof {
    @Test
    void longProspectRefusalFitsTheNextModelObservation() {
        String prefix = "interrupted: The rendered landing had no dry support. ";
        String summary = AgentMacroControl.recentSummary(prefix + "No reachable side face. ".repeat(24));
        org.junit.jupiter.api.Assertions.assertTrue(summary.startsWith(prefix) && summary.endsWith("..."));
        org.junit.jupiter.api.Assertions.assertEquals(512, summary.getBytes(StandardCharsets.UTF_8).length);
        String exact = "a".repeat(508) + "\uD83C\uDF0D";
        org.junit.jupiter.api.Assertions.assertEquals(exact, AgentMacroControl.recentSummary(exact));
        org.junit.jupiter.api.Assertions.assertEquals("a".repeat(508) + "...",
            AgentMacroControl.recentSummary(exact + "x"));
    }

    @BeforeAll
    static void initializeVanilla() {
        VanillaTestResources.initialize();
    }

    @Test
    void acceptsSettledSurfaceSandButNotAVanillaOverhang() {
        var top = new BlockPos(0, 65, 0);
        var sand = Blocks.SAND.getDefaultState();
        var gravel = Blocks.GRAVEL.getDefaultState();
        var stone = Blocks.STONE.getDefaultState();
        var probe = new BlockPos.Mutable();
        var settled = new SurfaceColumn(Map.of(top, sand, top.down(), gravel, top.down(2), stone));
        require(AgentBody.overlandLoadHolds(settled, top, sand, probe),
            "a visible full gravity top on a settled column is usable without cutting it");
        var overhang = new SurfaceColumn(Map.of(top, sand, top.down(), gravel));
        require(!AgentBody.overlandLoadHolds(overhang, top, sand, probe),
            "sand resting on more unsupported falling material is not a safe top");
    }

    private record SurfaceColumn(Map<BlockPos, BlockState> blocks) implements BlockView {
        @Override public BlockEntity getBlockEntity(BlockPos pos) { return null; }
        @Override public BlockState getBlockState(BlockPos pos) { return blocks.getOrDefault(pos, Blocks.AIR.getDefaultState()); }
        @Override public FluidState getFluidState(BlockPos pos) { return getBlockState(pos).getFluidState(); }
        @Override public int getHeight() { return 384; }
        @Override public int getBottomY() { return -64; }
    }

    @Test
    void boundsItemCountLossForRealVanillaStacks() {
        var stone = Blocks.STONE.getDefaultState();
        var log = Blocks.BIRCH_LOG.getDefaultState();
        var world = EmptyBlockView.INSTANCE;
        var pos = BlockPos.ORIGIN;

        require(AgentMiningStock.maxLoss(ItemStack.EMPTY, log, world, pos) == 0, "bare hand uses no stock");
        require(AgentMiningStock.maxLoss(new ItemStack(Items.COBBLESTONE, 12), log, world, pos) == 0,
            "holding a nonwearing material while hitting a block uses none of it");

        var bow = new ItemStack(Items.BOW);
        bow.setDamage(bow.getMaxDamage() - 1);
        require(AgentMiningStock.maxLoss(bow, log, world, pos) == 0, "a damageable non-mining item does not wear");

        var pick = new ItemStack(Items.WOODEN_PICKAXE);
        require(AgentMiningStock.maxLoss(pick, stone, world, pos) == 0, "wear alone does not use stock");
        pick.setDamage(pick.getMaxDamage() - 1);
        require(AgentMiningStock.maxLoss(pick, stone, world, pos) == 1, "a last-use pick can be lost");
        require(AgentMiningStock.maxLoss(pick, Blocks.TORCH.getDefaultState(), world, pos) == 0,
            "ordinary mining tools take no wear from a zero-hardness block");
        pick.set(DataComponentTypes.UNBREAKABLE, new UnbreakableComponent(false));
        require(AgentMiningStock.maxLoss(pick, stone, world, pos) == 0, "the Unbreakable component prevents stock loss");

        var shears = new ItemStack(Items.SHEARS);
        shears.setDamage(shears.getMaxDamage() - 2);
        require(AgentMiningStock.maxLoss(shears, log, world, pos) == 1, "shears can apply their own wear and base tool wear");
        require(AgentMiningStock.maxLoss(shears, Blocks.COBWEB.getDefaultState(), world, pos) == 0,
            "shears skip base tool wear when their override handles the block");

        var sword = new ItemStack(Items.WOODEN_SWORD);
        sword.setDamage(sword.getMaxDamage() - 2);
        require(AgentMiningStock.maxLoss(sword, log, world, pos) == 1, "two points of tool wear can exhaust two remaining");
    }

    @Test
    void protectedTwoUseIronStaysReadyForOreWhileWoodCutsTheCover() {
        var stock = new PlayerInventory(null);
        var iron = pickWithUses(Items.IRON_PICKAXE, 2);
        stock.setStack(0, iron);
        stock.setStack(1, pickWithUses(Items.WOODEN_PICKAXE, 30));
        var budget = diamondBudget(1, 1);

        assertEquals(1, prospectCoverTool(stock, budget, Blocks.DEEPSLATE.getDefaultState()));
        assertEquals(1, prospectCoverTool(stock, budget, Blocks.STONE.getDefaultState()));
        assertEquals(AgentProspectTools.COVER_LOSES_HARVEST, AgentProspectTools.coverLoss(stock, 0,
            Blocks.DEEPSLATE.getDefaultState(), EmptyBlockView.INSTANCE, BlockPos.ORIGIN, budget, slot -> true));
        assertEquals(0, AgentProspectTools.coverLoss(stock, 1, Blocks.DEEPSLATE.getDefaultState(),
            EmptyBlockView.INSTANCE, BlockPos.ORIGIN, budget, slot -> true));
        assertEquals(iron.getMaxDamage() - 2, iron.getDamage());

        iron.setDamage(iron.getMaxDamage() - 3);
        assertEquals(0, prospectCoverTool(stock, budget, Blocks.DEEPSLATE.getDefaultState()));
    }

    @Test
    void noSpareCoverToolCanConsumeTheOnlyAdmissibleOreUse() {
        var stock = new PlayerInventory(null);
        var iron = pickWithUses(Items.IRON_PICKAXE, 2);
        stock.setStack(0, iron);
        stock.setStack(1, new ItemStack(Items.STICK));
        var budget = diamondBudget(1, 1);

        assertEquals(AgentProspectTools.COVER_LOSES_HARVEST, prospectCoverTool(stock, budget, Blocks.DEEPSLATE.getDefaultState()));
        assertEquals(0, diamondOreTool(stock, budget));

        iron.setDamage(iron.getMaxDamage() - 1);
        assertEquals(AgentProspectTools.HARVEST_PROTECTED, diamondOreTool(stock, budget));
    }

    @Test
    void anExactlyPricedLastOreUseIsLegalButNotOnCover() {
        var stock = new PlayerInventory(null);
        var iron = pickWithUses(Items.IRON_PICKAXE, 2);
        stock.setStack(0, iron);
        var budget = diamondBudget(1, 0);

        assertEquals(0, prospectCoverTool(stock, budget, Blocks.DEEPSLATE.getDefaultState()));
        iron.setDamage(iron.getMaxDamage() - 1);
        assertEquals(0, diamondOreTool(stock, budget));
        assertEquals(AgentProspectTools.COVER_LOSES_HARVEST, prospectCoverTool(stock, budget, Blocks.DEEPSLATE.getDefaultState()));
        assertEquals(AgentProspectTools.HARVEST_UNPRICED, diamondOreTool(stock, diamondBudget(0, 0)));

        stock.setStack(1, pickWithUses(Items.IRON_PICKAXE, 1));
        assertEquals(AgentProspectTools.COVER_LOSES_HARVEST, prospectCoverTool(stock, budget, Blocks.DEEPSLATE.getDefaultState()));
        assertEquals(AgentProspectTools.COVER_LOSES_HARVEST,
            prospectCoverTool(stock, diamondBudget(2, 1), Blocks.DEEPSLATE.getDefaultState()));
        assertEquals(0, prospectCoverTool(stock, diamondBudget(2, 0), Blocks.DEEPSLATE.getDefaultState()));
        budget.broken(Items.IRON_PICKAXE, 1);
        assertEquals(AgentProspectTools.HARVEST_UNPRICED, diamondOreTool(stock, budget));
    }

    @Test
    void unsuitableUnknownAndUnequippableToolsDoNotEstablishAnOreHarvest() {
        var stock = new PlayerInventory(null);
        stock.setStack(0, new ItemStack(Items.WOODEN_PICKAXE));
        var budget = diamondBudget(2, 0);
        assertEquals(AgentProspectTools.NO_HARVEST_TOOL, diamondOreTool(stock, budget));

        // Non-vanilla stack shape: the native wear bound is unavailable.
        stock.setStack(1, new ItemStack(Items.IRON_PICKAXE, 2));
        assertEquals(AgentProspectTools.HARVEST_UNKNOWN_WEAR, diamondOreTool(stock, budget));
        stock.setStack(1, new ItemStack(Items.IRON_PICKAXE));
        assertEquals(AgentProspectTools.HARVEST_UNEQUIPPABLE, AgentProspectTools.harvestSlot(stock,
            Blocks.DEEPSLATE_DIAMOND_ORE.getDefaultState(), EmptyBlockView.INSTANCE, BlockPos.ORIGIN, budget, slot -> slot == 0));
        assertEquals(AgentProspectTools.NO_HARVEST_TOOL, AgentProspectTools.harvestSlot(stock,
            Blocks.DIAMOND_ORE.getDefaultState(), EmptyBlockView.INSTANCE, BlockPos.ORIGIN, budget, slot -> true));
    }

    @Test
    void diamondRoomDependsOnSlotsAndCompatibleStackCapacity() {
        var stock = new PlayerInventory(null);
        for (int slot = 0; slot < PlayerInventory.MAIN_SIZE; ++slot)
            stock.setStack(slot, new ItemStack(Items.COBBLESTONE, 64));
        require(!AgentProspectTools.roomForDiamond(stock), "a full inventory without a diamond stack has no diamond room");
        stock.setStack(2, new ItemStack(Items.DIAMOND, 63));
        require(AgentProspectTools.roomForDiamond(stock), "an existing diamond stack can take the drop");
        stock.getStack(2).increment(1);
        require(!AgentProspectTools.roomForDiamond(stock), "a full diamond stack cannot take the drop");
        stock.setStack(2, ItemStack.EMPTY);
        require(AgentProspectTools.roomForDiamond(stock), "an empty slot takes the drop");
    }

    private static AgentWorkOrder.Budget diamondBudget(int ironCost, int ironReserve) {
        return new AgentWorkOrder.Budget(new AgentWorkOrder.Policy(false, new AgentWorkOrder.Target(Items.DIAMOND, 1, null),
            Set.of("prospect:minecraft:diamond", "break:minecraft:deepslate_diamond_ore", "break:minecraft:deepslate",
                "break:minecraft:stone"), Map.of(Items.IRON_PICKAXE, ironCost), Map.of(Items.IRON_PICKAXE, ironReserve), 4, 0, 0));
    }

    private static ItemStack pickWithUses(Item item, int uses) {
        var stack = new ItemStack(item);
        stack.setDamage(stack.getMaxDamage() - uses);
        return stack;
    }

    private static int diamondOreTool(PlayerInventory stock, AgentWorkOrder.Budget budget) {
        return AgentProspectTools.harvestSlot(stock, Blocks.DEEPSLATE_DIAMOND_ORE.getDefaultState(),
            EmptyBlockView.INSTANCE, BlockPos.ORIGIN, budget, slot -> true);
    }

    private static int prospectCoverTool(PlayerInventory stock, AgentWorkOrder.Budget budget, BlockState cover) {
        return AgentProspectTools.coverSlot(stock, cover, EmptyBlockView.INSTANCE, BlockPos.ORIGIN, budget, null, slot -> true);
    }

    @Test
    void reservesAStartingLogAndProcuresOnlyCompatibleWood() {
        var policy = new AgentWorkOrder.Policy(false, new AgentWorkOrder.Target(Items.OAK_PLANKS, 4, null),
            Set.of("craft:planks", "break:minecraft:oak_log"), Map.of(Items.OAK_LOG, 1), Map.of(Items.OAK_LOG, 1), 1, 1, 0);
        var remaining = new AgentWorkOrder.Budget(policy);
        var stock = new PlayerInventory(null);
        stock.setStack(3, new ItemStack(Items.OAK_LOG));
        stock.setStack(8, new ItemStack(Items.SPRUCE_LOG, 4));
        var missing = AgentHands.workNeed(stock, "oak_planks", remaining);
        require(policy.craftAllowed("oak_planks"), "generic plank permission can bind an exact oak output");
        require(missing != null && missing.count() == 1 && missing.matches(new ItemStack(Items.OAK_LOG))
            && !missing.matches(new ItemStack(Items.SPRUCE_LOG)), "protected stock does not satisfy the exact input");
        stock.setStack(16, new ItemStack(Items.OAK_LOG));
        require(AgentHands.workNeed(stock, "oak_planks", remaining) == null, "the newly acquired log supplies the recipe");
        require(remaining.limit(Items.OAK_LOG, 2) == 1, "only one of two logs is spendable");
        remaining.crafted(Map.of(Items.OAK_LOG, 1), 1);
        require(remaining.limit(Items.OAK_LOG, 3) == 0 && remaining.craftsLeft() == 0,
            "more stock does not replenish the already charged permission");
    }

    @Test
    void appliesTheSameRuleToANonWoodIngredient() {
        var policy = new AgentWorkOrder.Policy(false, new AgentWorkOrder.Target(Items.TORCH, 8, null),
            Set.of("craft:torch", "break:minecraft:coal_ore"), Map.of(Items.COAL, 2, Items.STICK, 2),
            Map.of(Items.COAL, 1), 2, 2, 0);
        var budget = new AgentWorkOrder.Budget(policy);
        var stock = new PlayerInventory(null);
        stock.setStack(0, new ItemStack(Items.COAL));
        stock.setStack(11, new ItemStack(Items.STICK, 2));
        var missing = AgentHands.workNeed(stock, "torch", budget);
        require(missing != null && missing.matches(new ItemStack(Items.COAL)), "last coal is not a crafting ingredient");
        require(!missing.matches(new ItemStack(Items.STICK)), "a surplus of other recipe inputs cannot hide missing coal");
        stock.setStack(0, ItemStack.EMPTY);
        stock.setStack(35, new ItemStack(Items.COAL, 2));
        require(AgentHands.workNeed(stock, "torch", budget) == null && budget.limit(Items.COAL, 2) == 1,
            "slot changes leave one legal execution, not a two-execution batch");
    }

    @Test
    void acquiresAReserveWithoutTreatingItAsAlreadyHeld() {
        var policy = new AgentWorkOrder.Policy(false, new AgentWorkOrder.Target(Items.TORCH, 4, null),
            Set.of("craft:torch", "craft:stick"), Map.of(Items.OAK_PLANKS, 2, Items.COAL, 1, Items.STICK, 1),
            Map.of(Items.TORCH, 4), 0, 2, 0);
        var budget = new AgentWorkOrder.Budget(policy);
        var stock = new PlayerInventory(null);
        stock.setStack(0, new ItemStack(Items.OAK_PLANKS, 2));
        stock.setStack(1, new ItemStack(Items.COAL));
        require(budget.missingFloor(stock).getKey() == Items.TORCH
                && AgentWorkOrder.count(stock, Items.TORCH) == 0,
            "a declared final reserve is not an observed item");
        require(budget.limit(Items.OAK_PLANKS, 2) == 2 && AgentHands.workNeed(stock, "stick", budget) == null,
            "producing a different prerequisite is legal without consuming the absent reserve");
        var next = AgentHands.workNeed(stock, "torch", budget);
        require(next != null && next.matches(new ItemStack(Items.STICK)), "torch procurement still requires an actual stick");
        stock.setStack(2, new ItemStack(Items.STICK, 4));
        stock.setStack(3, new ItemStack(Items.TORCH, 3));
        require(AgentHands.workNeed(stock, "torch", budget) == null && budget.missingFloor(stock) != null,
            "craft is now possible, but stock does not yet meet the final reserve");
        stock.setStack(3, new ItemStack(Items.TORCH, 4));
        require(budget.missingFloor(stock) == null && budget.limit(Items.TORCH, 4) == 0,
            "only the observed output fulfills the reserve, and it cannot be spent");
    }

    @Test
    void parsesExactZeroSpendFirstOrderWithAnUnmetTargetReserve() {
        // Same stock payload emitted by the goal-only host binder after a live birch witness.
        var raw = JsonParser.parseString("""
            {"v":1,"id":"first-work","run":"run","life":1,"epoch":1,"basisTick":5,"expiresTick":105,
             "safetyRevision":1,"origin":"model","target":{"kind":"stock","item":"minecraft:birch_log","count":1},
             "allowedEffects":["break:minecraft:birch_log"],"costCaps":[],"reserves":[{"item":"minecraft:birch_log","count":1}],
             "maxBreaks":1,"maxCrafts":0,"maxPlacements":0}
            """).getAsJsonObject();
        var order = AgentWorkOrder.parse(raw, "run", "constrained");
        require(order != null && order.policy() != null, "the exact narrow order passes the native parser");
        var policy = order.policy();
        var budget = new AgentWorkOrder.Budget(policy);
        var stock = new PlayerInventory(null);
        stock.setStack(0, new ItemStack(Items.SPRUCE_LOG));
        var seen = Blocks.BIRCH_LOG.getDefaultState();
        require(budget.canBreak() && policy.breakAllowed(seen) && AgentWorkOrder.harvest(seen) == policy.target().item(),
            "the witnessed source may advance this exact stock target while its floor is missing");
        require(!policy.breakAllowed(Blocks.SPRUCE_LOG.getDefaultState()) && !policy.placeTable() && budget.craftsLeft() == 0,
            "there is no wider species, crafting or placement privilege");
        require(budget.missingFloor(stock).getKey() == Items.BIRCH_LOG
                && budget.remainingCost(Items.SPRUCE_LOG) == 0 && budget.limit(Items.SPRUCE_LOG, 1) == 0,
            "unrelated held stock cannot fulfill the floor or be spent");
        budget.broken(Items.AIR, 0);
        require(!budget.canBreak() && budget.missingFloor(stock) != null,
            "a zero-spend break consumes its cap, not the floor; a break is not a confirmed pickup");
        stock.setStack(1, new ItemStack(Items.BIRCH_LOG));
        require(budget.missingFloor(stock) == null && budget.limit(Items.BIRCH_LOG, 1) == 0,
            "only a confirmed exact pickup fulfills the floor and the item stays protected");
    }

    @Test
    void prospectingCoverRequiresItsOwnEffectAndLeavesABreakForTheSource() {
        var raw = JsonParser.parseString("""
            {"v":1,"id":"stone","run":"run","life":1,"epoch":1,"basisTick":5,"expiresTick":105,
             "safetyRevision":1,"origin":"model","target":{"kind":"stock","item":"minecraft:cobblestone","count":3},
             "allowedEffects":["break:minecraft:stone"],"costCaps":[],"reserves":[],
             "maxBreaks":4,"maxCrafts":0,"maxPlacements":0}
            """).getAsJsonObject();
        var stone = Blocks.STONE.getDefaultState();
        var grass = Blocks.GRASS_BLOCK.getDefaultState();
        var dirt = Blocks.DIRT.getDefaultState();
        var narrow = AgentWorkOrder.parse(raw, "run", "constrained").policy();
        require(narrow.breakAllowed(stone) && !narrow.prospectCoverAllowed(grass) && !narrow.prospectCoverAllowed(dirt),
            "an exact stone break does not permit removing soil");
        raw.getAsJsonArray("allowedEffects").add("break:minecraft:grass_block");
        var withGrass = AgentWorkOrder.parse(raw, "run", "constrained").policy();
        require(withGrass.prospectCoverAllowed(grass) && !withGrass.prospectCoverAllowed(dirt)
                && !withGrass.breakAllowed(grass) && AgentWorkOrder.prospectCoverDrop(grass) == Items.DIRT,
            "the named cap is a prospecting permission, not an implied dirt harvest or a wider cover family");
        var budget = new AgentWorkOrder.Budget(withGrass);
        for (int i = 0; i < 3; i++) budget.broken(Items.AIR, 0);
        require(budget.canBreak() && !budget.canCutCover(), "the last break belongs to exposed source work");

        var preset = new AgentWorkOrder.Policy(true, new AgentWorkOrder.Target(null, 0, "stone_pickaxe"),
            Set.of(), Map.of(), Map.of(), 4, 0, 0);
        require(preset.prospectCoverAllowed(grass) && preset.prospectCoverAllowed(dirt)
                && !preset.prospectCoverAllowed(Blocks.GRAVEL.getDefaultState())
                && !preset.prospectCoverAllowed(Blocks.COAL_ORE.getDefaultState()),
            "the built-in stone job permits only ordinary non-falling cover, not an unrelated ore");
    }

    @Test
    void diamondDescentDoesNotBroadenOreOnlyWorkOrCutEitherSupport() {
        var raw = JsonParser.parseString("""
            {"v":1,"id":"diamond-leg","run":"run","life":1,"epoch":1,"basisTick":5,"expiresTick":1205,
             "safetyRevision":1,"origin":"model","target":{"kind":"stock","item":"minecraft:diamond","count":1},
             "allowedEffects":["break:minecraft:deepslate_diamond_ore"],
             "costCaps":[],"reserves":[],"maxBreaks":8,"maxCrafts":0,"maxPlacements":0}
            """).getAsJsonObject();
        var stone = Blocks.STONE.getDefaultState();
        var oreOnly = AgentWorkOrder.parse(raw, "run", "constrained").policy();
        require(!oreOnly.diamondProspecting() && !oreOnly.prospectCoverAllowed(stone),
            "ore-only work is not permission for deep alterations");
        raw.getAsJsonArray("allowedEffects").add("prospect:minecraft:diamond");
        var dark = AgentWorkOrder.parse(raw, "run", "constrained").policy();
        require(dark.diamondProspecting() && !dark.prospectCoverAllowed(stone) && !dark.placeProspectTorch(),
            "method permission does not imply any block effect");
        raw.getAsJsonArray("allowedEffects").add("break:minecraft:stone");
        raw.getAsJsonArray("allowedEffects").add("place:minecraft:torch");
        raw.getAsJsonArray("costCaps").add(JsonParser.parseString("""
            {"item":"minecraft:torch","count":1}
            """));
        raw.getAsJsonArray("reserves").add(JsonParser.parseString("""
            {"item":"minecraft:torch","count":2}
            """));
        raw.addProperty("maxPlacements", 1);
        var policy = AgentWorkOrder.parse(raw, "run", "constrained").policy();
        var budget = new AgentWorkOrder.Budget(policy);
        var stock = new PlayerInventory(null);
        stock.setStack(0, new ItemStack(Items.TORCH, 2));
        require(policy.prospectCoverAllowed(stone) && !policy.prospectCoverAllowed(Blocks.DEEPSLATE.getDefaultState())
            && !budget.canPlaceProspectTorch(stock), "stone is exact and two protected torches are not a spendable light");
        stock.setStack(0, new ItemStack(Items.TORCH, 3));
        require(budget.canPlaceProspectTorch(stock), "one carried torch above the floor fits this policy");
        budget.placedProspectTorch();
        require(!budget.canPlaceProspectTorch(stock), "one issued light consumes both placement and exact cost");
        require(!budget.canPlaceProspectSupport(stock), "light never implies placement of cobblestone");
        raw.getAsJsonArray("allowedEffects").add("place:minecraft:cobblestone");
        require(AgentWorkOrder.parse(raw, "run", "constrained").policy() == null,
            "the support effect without its exact cost is invalid");
        var cobble = JsonParser.parseString("""
            {"item":"minecraft:cobblestone","count":1}
            """).getAsJsonObject();
        raw.getAsJsonArray("costCaps").add(cobble);
        raw.getAsJsonArray("reserves").add(cobble.deepCopy());
        var lightOrSupport = new AgentWorkOrder.Budget(AgentWorkOrder.parse(raw, "run", "constrained").policy());
        stock.setStack(1, new ItemStack(Items.COBBLESTONE));
        require(!lightOrSupport.canPlaceProspectSupport(stock), "the last reserved cobble cannot be placed");
        stock.setStack(1, new ItemStack(Items.COBBLESTONE, 2));
        require(lightOrSupport.canPlaceProspectSupport(stock), "one eligible block fits the declared cost and floor");
        lightOrSupport.placedProspectSupport();
        require(!lightOrSupport.canPlaceProspectTorch(stock) && !lightOrSupport.canPlaceProspectSupport(stock),
            "one issued block consumes the shared placement and its own cost but is not a confirmed crossing");
        raw.addProperty("id", "program:3");
        require(AgentWorkOrder.parse(raw, "run", "constrained").policy() == null, "no program stage can select the route");

        for (int y : new int[]{32, 0, -58}) {
            var from = new BlockPos(8, y, -3);
            var lower = AgentSurfaceTread.nextFoot(from, Direction.EAST);
            require(lower.getY() == y - 1 && lower.getX() == from.getX() + 1,
                "the planned descent is cardinal and one block deep at each actual depth");
            require(AgentSurfaceTread.prospectCell(from, lower, Direction.EAST)
                && AgentSurfaceTread.prospectCell(from, lower.up(3), Direction.EAST)
                && !AgentSurfaceTread.prospectCell(from, from.down(), Direction.EAST)
                && !AgentSurfaceTread.prospectCell(from, lower.down(), Direction.EAST),
                "only body and jump-clearance cells can be cut, never either support");
            var beside = from.east();
            require(AgentSurfaceTread.cardinalTread(from, beside, Direction.EAST)
                && AgentSurfaceTread.cardinalTread(from, beside.up(), Direction.EAST)
                && !AgentSurfaceTread.cardinalTread(from, from.down(), Direction.EAST)
                && !AgentSurfaceTread.cardinalTread(from, beside.down(2), Direction.EAST),
                "level recovery still cannot imply a vertical or two-block drop");
            require(AgentSurfaceTread.prospectLevelCell(from, beside, Direction.EAST)
                && AgentSurfaceTread.prospectLevelCell(from, beside.up(), Direction.EAST)
                && !AgentSurfaceTread.prospectLevelCell(from, beside.up(2), Direction.EAST)
                && !AgentSurfaceTread.prospectLevelCell(from, beside.down(), Direction.EAST),
                "horizontal excavation is strictly two-high and cannot cut its landing or roof");
        }
    }

    @Test
    void admitsOnlyAnExplicitStandaloneIronWorkQuote() {
        var raw = ironWorkQuote();
        for (String mode : List.of("preset", "constrained")) {
            var policy = AgentWorkOrder.parse(raw, "run", mode).policy();
            require(policy.smeltIron() && policy.placeFurnace() && !policy.placeTable() && !policy.craftAllowed("furnace"),
                "a live iron quote names exactly its smelt and placement, not a bench or recipe");
        }
        var alternate = raw.deepCopy();
        alternate.getAsJsonObject("target").addProperty("item", "minecraft:copper_ingot");
        require(AgentWorkOrder.parse(alternate, "run", "preset").policy() == null, "not a generic smelting authority");
        alternate = raw.deepCopy();
        alternate.addProperty("id", "any-program:3");
        require(AgentWorkOrder.parse(alternate, "run", "preset").policy() == null, "not a linked program stage");
        alternate = raw.deepCopy();
        alternate.addProperty("origin", "preset");
        require(AgentWorkOrder.parse(alternate, "run", "preset").policy() == null, "not preset-origin startup work");
        alternate = raw.deepCopy();
        alternate.getAsJsonArray("allowedEffects").remove(0);
        require(AgentWorkOrder.parse(alternate, "run", "constrained").policy() == null, "placement cannot stand alone");
        alternate = raw.deepCopy();
        alternate.getAsJsonArray("allowedEffects").remove(1);
        var policy = AgentWorkOrder.parse(alternate, "run", "constrained").policy();
        require(policy.smeltIron() && !policy.placeFurnace(), "using an empty screen cannot implicitly place a block");
    }

    @Test
    void exactFuelAndRawIronAreReservedTogetherBeforeTheFirstClick() {
        var budget = new AgentWorkOrder.Budget(AgentWorkOrder.parse(ironWorkQuote(), "run", "constrained").policy());
        var inventory = new PlayerInventory(null);
        inventory.setStack(0, new ItemStack(Items.RAW_IRON, 2));
        inventory.setStack(1, new ItemStack(Items.RAW_IRON, 1));
        inventory.setStack(2, new ItemStack(Items.OAK_PLANKS, 6));
        inventory.setStack(3, new ItemStack(Items.COAL, 64));
        inventory.setStack(4, new ItemStack(Items.IRON_INGOT, 1));
        require(!budget.reserveIronSmelt(inventory, 2, Items.COAL, 1, 1600),
            "available but uncapped coal cannot be burned");
        inventory.setStack(1, ItemStack.EMPTY);
        require(!budget.reserveIronSmelt(inventory, 2, Items.OAK_PLANKS, 2, 300),
            "two raw cannot be committed while one is reserved from two carried");
        inventory.setStack(1, new ItemStack(Items.RAW_IRON));
        require(!budget.reserveIronSmelt(inventory, 2, Items.OAK_PLANKS, 3, 300),
            "more fuel than the exact bound is not reserved");
        require(budget.craftsLeft() == 3 && budget.remainingCost(Items.RAW_IRON) == 3,
            "a failed reservation must not charge any ingredient or execution");
        var batch = AgentHands.quoteIron(inventory, budget, 2, item -> item == Items.OAK_PLANKS ? 300 : 1600);
        require(batch != null && batch.units() == 2 && batch.fuel() == Items.OAK_PLANKS && batch.fuelCount() == 2,
            "two recipes use two exact planks, not the stack or the uncapped coal");
        require(budget.reserveIronSmelt(inventory, batch.units(), batch.fuel(), batch.fuelCount(), batch.fuelTicks()),
            "sufficient input and minimal exact fuel are admitted together");
        require(budget.craftsLeft() == 1 && budget.remainingCost(Items.RAW_IRON) == 1
                && budget.remainingCost(Items.OAK_PLANKS) == 0,
            "each smelt counts as one execution and both item costs are charged before the click");
        require(AgentHands.quoteIron(inventory, budget, 2, item -> 300) == null,
            "an unconfirmed or retried transfer never restores its conservative spend");
    }

    @Test
    void furnaceRecipeAndEverySmeltConsumeTheSameExecutionBudget() {
        var raw = ironWorkQuote();
        raw.getAsJsonArray("allowedEffects").add("craft:furnace");
        raw.addProperty("maxCrafts", 2);
        var policy = AgentWorkOrder.parse(raw, "run", "preset").policy();
        var budget = new AgentWorkOrder.Budget(policy);
        var inventory = new PlayerInventory(null);
        inventory.setStack(0, new ItemStack(Items.RAW_IRON, 3));
        inventory.setStack(1, new ItemStack(Items.OAK_PLANKS, 6));
        budget.crafted(Map.of(), 1);
        var batch = AgentHands.quoteIron(inventory, budget, 3, item -> 300);
        require(batch != null && batch.units() == 1 && batch.fuelCount() == 1,
            "a preceding workstation craft leaves only one smelting execution");
        require(AgentHands.ironFuelNeeded(2, 100) == 4 && AgentHands.ironFuelNeeded(3, 300) == 2,
            "exact full heat determines required sticks or planks");
    }

    @Test
    void onlyMultiUnitPaidBatchesLeaveTheFurnaceScreenEvenIfOneUnitRemains() {
        var single = new AgentHands.IronBatch(1, Items.COAL, 1, 1600);
        var pair = new AgentHands.IronBatch(2, Items.COAL, 1, 1600);
        require(!AgentFurnaceWatch.required(single), "one charged unit normally stays in the GUI");
        var watch = new AgentFurnaceWatch(BlockPos.ORIGIN, Direction.NORTH, 6,
            new AgentFurnaceWatch.Stock(1, 2, 1), pair, 1, 0, 0.5f, 20, 1_000_000_000L);
        require(AgentFurnaceWatch.required(pair) && watch.remainingTicks(20) == 100,
            "one remaining in a paid pair still requires a world watch");
    }

    @Test
    void pendingSideWaitRequiresRealBurnAndAFrameAfterEscape() {
        var single = new AgentHands.IronBatch(1, Items.COAL, 1, 1600);
        var pair = new AgentHands.IronBatch(2, Items.COAL, 1, 1600);
        require(!AgentFurnaceWatch.releasedForSide(single, 20, 10, 11),
            "the paid single-item GUI grants no side-work handoff");
        require(!AgentFurnaceWatch.releasedForSide(pair, 0, 10, 11)
                && !AgentFurnaceWatch.releasedForSide(pair, 20, 10, 10)
                && AgentFurnaceWatch.releasedForSide(pair, 20, 10, 11),
            "only ignition followed by a fresh in-world observation establishes a real release");
    }

    @Test
    void paidWaitUsesOrdinaryHorizonEffectsAndIndependentCostsWithoutBorrowingTheBatch() {
        var request = JsonParser.parseString("""
            {"v":1,"id":"independent","run":"run","life":1,"epoch":1,"basisTick":5,"expiresTick":1205,
             "safetyRevision":1,"origin":"model","target":{"kind":"stock","item":"minecraft:raw_iron","count":6},
             "allowedEffects":["break:minecraft:iron_ore","break:minecraft:deepslate_iron_ore"],
             "costCaps":[{"item":"minecraft:stone_pickaxe","count":1}],"reserves":[],
             "maxBreaks":6,"maxCrafts":0,"maxPlacements":0,"duringWaitFor":"9d0ad30c-b85c-4261-baff-f071c8e5ebc1"}
            """).getAsJsonObject();
        var order = AgentWorkOrder.parse(request, "run", "constrained");
        require(order.policy() != null && order.duringWaitFor().equals("9d0ad30c-b85c-4261-baff-f071c8e5ebc1")
                && order.policy().breakAllowed(Blocks.IRON_ORE.getDefaultState())
                && order.policy().breakAllowed(Blocks.DEEPSLATE_IRON_ORE.getDefaultState())
                && !order.policy().breakAllowed(Blocks.STONE.getDefaultState()),
            "ordinary raw-iron work authorizes its exact ore types across the normal horizon, not unrelated stone");
        var budget = new AgentWorkOrder.Budget(order.policy(), Map.of(Items.OAK_PLANKS, 3, Items.STONE_PICKAXE, 1));
        var stock = new PlayerInventory(null);
        stock.setStack(0, new ItemStack(Items.OAK_PLANKS, 3));
        stock.setStack(1, new ItemStack(Items.STONE_PICKAXE));
        stock.setStack(2, new ItemStack(Items.RAW_IRON, 6));
        require(budget.limit(Items.OAK_PLANKS, 3) == 0 && budget.limit(Items.STONE_PICKAXE, 1) == 0
                && budget.limit(Items.RAW_IRON, 6) == 0 && budget.missingFloor(stock) == null
                && budget.breaksLeft() == 6,
            "the new job honors inherited floors despite its own caps and receives no smelt-input cap");
        request.getAsJsonObject("target").addProperty("item", "minecraft:iron_ingot");
        require(AgentWorkOrder.parse(request, "run", "constrained").policy() == null,
            "the pending output is not a stock target for ordinary handoff work");
        request.getAsJsonObject("target").addProperty("item", "minecraft:raw_iron");
        request.getAsJsonArray("allowedEffects").add("smelt:minecraft:iron_ingot");
        require(AgentWorkOrder.parse(request, "run", "constrained").policy() == null,
            "no quoted work lease can inherit or duplicate smelt authority");
    }

    @Test
    void paidWaitCanQuoteOneOrdinaryPlankExecutionFromExactlyOneCarriedLog() {
        var request = JsonParser.parseString("""
            {"v":1,"id":"planks","run":"run","life":1,"epoch":1,"basisTick":5,"expiresTick":125,
             "safetyRevision":1,"origin":"model","target":{"kind":"stock","item":"minecraft:oak_planks","count":4},
             "allowedEffects":["craft:planks"],"costCaps":[{"item":"minecraft:oak_log","count":1}],"reserves":[],
             "maxBreaks":0,"maxCrafts":1,"maxPlacements":0,"duringWaitFor":"9d0ad30c-b85c-4261-baff-f071c8e5ebc1"}
            """).getAsJsonObject();
        var policy = AgentWorkOrder.parse(request, "run", "constrained").policy();
        var stock = new PlayerInventory(null);
        stock.setStack(0, new ItemStack(Items.OAK_LOG, 2));
        var budget = new AgentWorkOrder.Budget(policy, Map.of(Items.OAK_LOG, 1));
        require(policy.craftAllowed("oak_planks") && !policy.craftAllowed("stick")
                && AgentHands.workOutputCount("oak_planks") == 4
                && AgentHands.workNeed(stock, "oak_planks", budget) == null,
            "one stocked log above the inherited floor can be consumed by the ordinary exact plank recipe");
        stock.setStack(0, new ItemStack(Items.OAK_LOG));
        require(AgentHands.workNeed(stock, "oak_planks", budget) != null,
            "the last log cannot be borrowed from the paid job's protected reserve");
    }

    @Test
    void parkedCollectionRequiresFreshSlotsAndUsesTheInventoryAfterIndependentWork() {
        var batch = new AgentHands.IronBatch(2, Items.OAK_PLANKS, 2, 300);
        var empty = ItemStack.EMPTY;
        var output = new ItemStack(Items.IRON_INGOT, 2);
        require(AgentFurnaceWatch.pendingReopenProblem(6, 6, true, 1, batch, 0, 1, empty, empty, output) != null
                && AgentFurnaceWatch.pendingReopenProblem(6, 7, true, 0, batch, 0, 1, empty, empty, output) != null
                && AgentFurnaceWatch.pendingReopenProblem(6, 7, true, 1, batch, 0, 1, empty, empty, output) == null,
            "only a new independently synchronized vanilla handler proves the paid output");
        var withdrawal = new AgentFurnaceWatch.Withdrawal();
        require(withdrawal.begin(new AgentFurnaceWatch.Stock(5, 2, 4)),
            "physical collection starts from current stock, not from the stale paid inventory before side work");
        require(!withdrawal.confirms(new AgentFurnaceWatch.Stock(5, 2, 4), batch)
                && !withdrawal.confirms(new AgentFurnaceWatch.Stock(4, 2, 6), batch)
                && withdrawal.confirms(new AgentFurnaceWatch.Stock(5, 2, 6), batch),
            "only the exact two ingot gain with unchanged currently carried input and fuel confirms withdrawal");
        require(!withdrawal.begin(new AgentFurnaceWatch.Stock(5, 2, 6)),
            "the accepted withdrawal edge cannot be issued again even after its actual stock gain");
    }

    @Test
    void explicitPaidRecallWaitsForTheSecondSynchronizedIngotBeforeOneWithdrawal() {
        var batch = new AgentHands.IronBatch(2, Items.OAK_PLANKS, 2, 300);
        var raw = new ItemStack(Items.RAW_IRON);
        var one = new ItemStack(Items.IRON_INGOT);
        var pair = new ItemStack(Items.IRON_INGOT, 2);
        var empty = ItemStack.EMPTY;
        var result = new AgentFurnaceWatch.PendingResult(6, 0, 1);

        assertEquals(AgentFurnaceWatch.Recall.WAIT, result.observe(680, 1152, 7, true, 1,
            batch, raw, empty, one, true, 0.685f, 0.8f));
        assertEquals(63, result.remainingTicks());
        assertEquals(AgentFurnaceWatch.Recall.WAIT, result.observe(708, 1152, 7, true, 1,
            batch, raw, empty, one, true, 0.825f, 0.7f));
        assertEquals(AgentFurnaceWatch.Recall.WAIT, result.observe(743, 1152, 7, true, 1,
            batch, empty, empty, pair, true, 0, 0.6f));
        assertEquals(AgentFurnaceWatch.Recall.READY, result.observe(744, 1152, 7, true, 2,
            batch, empty, empty, pair, true, 0, 0.6f));
        assertEquals(1, result.afterOutputUpdate());

        require(!AgentFurnaceWatch.exactResult(batch.units(), result.afterOutputUpdate(), 2, empty, empty, one)
                && AgentFurnaceWatch.exactResult(batch.units(), result.afterOutputUpdate(), 2, empty, empty, pair),
            "the vanilla hand action must still recheck the exact updated pair, not a now-altered result");
        var withdrawal = new AgentFurnaceWatch.Withdrawal();
        require(withdrawal.begin(new AgentFurnaceWatch.Stock(0, 2, 1))
                && !withdrawal.confirms(new AgentFurnaceWatch.Stock(0, 2, 2), batch)
                && withdrawal.confirms(new AgentFurnaceWatch.Stock(0, 2, 3), batch)
                && !withdrawal.begin(new AgentFurnaceWatch.Stock(0, 2, 3)),
            "only the exact two-ingot gain can confirm the one authorized withdrawal");
    }

    @Test
    void paidRecallCannotWaitOrWithdrawFromUnsyncedAlteredColdOrStalledSlots() {
        var batch = new AgentHands.IronBatch(2, Items.OAK_PLANKS, 2, 300);
        var raw = new ItemStack(Items.RAW_IRON);
        var one = new ItemStack(Items.IRON_INGOT);
        var empty = ItemStack.EMPTY;
        var result = new AgentFurnaceWatch.PendingResult(6, 0, 1);
        assertEquals(AgentFurnaceWatch.Recall.BINDING_CHANGED, result.observe(680, 1152, 6, true, 1,
            batch, raw, empty, one, true, 0.685f, 0.8f));
        assertEquals(AgentFurnaceWatch.Recall.BINDING_CHANGED, result.observe(680, 1152, 7, false, 1,
            batch, raw, empty, one, true, 0.685f, 0.8f));
        assertEquals(AgentFurnaceWatch.Recall.PENDING, result.observe(680, 1152, 7, true, 1,
            batch, raw, empty, one, false, 0.685f, 0));
        assertEquals(0, result.remainingTicks());
        assertEquals(AgentFurnaceWatch.Recall.PENDING, result.observe(680, 1152, 7, true, 1,
            batch, raw, empty, one, true, 0.685f, 0.05f));
        assertEquals(0, result.remainingTicks());
        assertEquals(AgentFurnaceWatch.Recall.PENDING, result.observe(680, 1152, 7, true, 1,
            batch, raw, empty, one, true, 0, 0.8f));
        assertEquals(0, result.remainingTicks());
        assertEquals(AgentFurnaceWatch.Recall.PENDING, result.observe(680, 1152, 7, true, 1,
            batch, raw, empty, one, true, 0.2f, 0.8f));
        assertEquals(160, result.remainingTicks());
        assertEquals(AgentFurnaceWatch.Recall.WAIT, result.observe(680, 1152, 7, true, 1,
            batch, raw, empty, one, true, 0.685f, 0.8f));
        assertEquals(AgentFurnaceWatch.Recall.BINDING_CHANGED, result.observe(681, 1152, 8, true, 2,
            batch, empty, empty, new ItemStack(Items.IRON_INGOT, 2), true, 0, 0.8f));
        assertEquals(AgentFurnaceWatch.Recall.STOCK_CHANGED, result.observe(681, 1152, 7, true, 2,
            batch, new ItemStack(Items.RAW_IRON, 2), empty, empty, true, 0.69f, 0.8f));
        assertEquals(AgentFurnaceWatch.Recall.PENDING, result.observe(705, 1152, 7, true, 1,
            batch, raw, empty, one, true, 0.685f, 0.8f));
        assertEquals(0, result.remainingTicks());
    }

    @Test
    void exactFurnaceWatchUsesNewVanillaSyncThenCollectsOnlyThePaidOutput() {
        var block = new BlockPos(3, 18, -7);
        var batch = new AgentHands.IronBatch(2, Items.OAK_PLANKS, 2, 300);
        var before = new AgentFurnaceWatch.Stock(3, 6, 1);
        var paid = new AgentFurnaceWatch.Stock(1, 4, 1);
        var raw = new ItemStack(Items.RAW_IRON, 2);
        var fuel = new ItemStack(Items.OAK_PLANKS);
        var output = new ItemStack(Items.IRON_INGOT, 2);
        var empty = ItemStack.EMPTY;
        require(paid.paidFrom(before, batch)
            && AgentFurnaceWatch.matches(batch, 0, 2, raw, fuel, empty),
            "one paid load conserves the two raw inputs, two planks and one existing ingot");
        var watch = new AgentFurnaceWatch(block, Direction.NORTH, 6, paid, batch, 0, 1, 0.05f, 20, 1_000_000_000L);
        require(watch.accessProblem(block, Direction.NORTH, true) == null, "the original loaded block is admissible");
        require(!watch.elapsed(409, 25_000_000_000L) && !watch.elapsed(410, 20_499_999_999L)
                && watch.elapsed(410, 20_500_000_000L),
            "both 390 native ticks and 19.5 seconds must have elapsed since close");
        require(!AgentFurnaceWatch.exactResult(2, 0, 1, raw, fuel, empty),
            "a finished timer is not an ingot receipt");
        require(watch.reopenProblem(7, true, 1, 1, 4, 1, empty, empty, output) == null
                && AgentFurnaceWatch.exactResult(2, 0, 1, empty, empty, output),
            "only the new independently synchronized complete output can be taken");
        require(new AgentFurnaceWatch.Stock(1, 4, 3).collectedFrom(paid, batch),
            "both paid inputs become exactly two ingots, preserving raw and fuel reserves");
        require(!new AgentFurnaceWatch.Stock(1, 4, 4).collectedFrom(paid, batch)
                && !new AgentFurnaceWatch.Stock(1, 2, 3).collectedFrom(paid, batch)
                && !new AgentFurnaceWatch.Stock(0, 4, 3).collectedFrom(paid, batch),
            "extra output, extra fuel payment or extra raw payment refuses completion");
    }

    @Test
    void reopenedFurnaceRefusesMisboundReplacedUnsyncedOrChangedContents() {
        var block = new BlockPos(3, 18, -7);
        var batch = new AgentHands.IronBatch(2, Items.COAL, 1, 1600);
        var watch = new AgentFurnaceWatch(block, Direction.NORTH, 6,
            new AgentFurnaceWatch.Stock(1, 2, 1), batch, 1, 0, 0.5f, 20, 1_000_000_000L);
        var pair = new ItemStack(Items.IRON_INGOT, 2);
        var empty = ItemStack.EMPTY;
        require(watch.accessProblem(block.east(), Direction.NORTH, true) != null
                && watch.accessProblem(block, Direction.SOUTH, true) != null
                && watch.accessProblem(block, Direction.NORTH, false) != null,
            "a neighboring furnace, changed facing or nonexclusive access cannot use the paid claim");
        require(watch.reopenProblem(6, true, 2, 1, 2, 1, empty, empty, pair) != null
                && watch.reopenProblem(7, false, 1, 1, 2, 1, empty, empty, pair) != null
                && watch.reopenProblem(7, true, 0, 1, 2, 1, empty, empty, pair) != null,
            "an old, unsynced or unobserved handler never proves output");
        require(watch.reopenProblem(7, true, 1, 1, 2, 2, empty, empty, pair) != null
                && watch.reopenProblem(7, true, 1, 2, 2, 1, empty, empty, pair) != null
                && watch.reopenProblem(7, true, 1, 1, 1, 1, empty, empty, pair) != null,
            "none of the three bounded stock values can change while closed");
        require(watch.reopenProblem(7, true, 1, 1, 2, 1, empty, empty, new ItemStack(Items.IRON_INGOT, 3)) != null
                && watch.reopenProblem(7, true, 1, 1, 2, 1, empty, new ItemStack(Items.COAL), pair) != null
                && watch.reopenProblem(7, true, 1, 1, 2, 1, new ItemStack(Items.RAW_IRON, 2), empty, empty) != null,
            "new output, excess fuel or regressed slots must not be treated as the paid batch");
        require(watch.reopenProblem(7, true, 1, 1, 2, 1, new ItemStack(Items.RAW_IRON), empty,
                new ItemStack(Items.IRON_INGOT)) == null
                && !AgentFurnaceWatch.exactResult(2, 0, 1, new ItemStack(Items.RAW_IRON), empty, pair),
            "matching but unfinished output stays uncollected");
        watch.invalidate();
        require(watch.accessProblem(block, Direction.NORTH, true) != null
                && watch.reopenProblem(7, true, 1, 1, 2, 1, empty, empty, pair) != null,
            "once replaced or unloaded, matching visible appearance and output cannot reauthorize this work");
    }

    @Test
    void ironFuelAndFurnacePlacementRespectTheirSeparateExactFloors() {
        var budget = new AgentWorkOrder.Budget(AgentWorkOrder.parse(ironWorkQuote(), "run", "preset").policy());
        var inventory = new PlayerInventory(null);
        inventory.setStack(0, new ItemStack(Items.RAW_IRON, 3));
        inventory.setStack(1, new ItemStack(Items.OAK_PLANKS, 5));
        inventory.setStack(2, new ItemStack(Items.FURNACE, 1));
        var batch = AgentHands.quoteIron(inventory, budget, 2, item -> 300);
        require(batch != null && batch.units() == 1 && batch.fuelCount() == 1,
            "one plank above the floor cooks only one ingot; no reserve is silently spent");
        require(!budget.canPlaceFurnace(inventory), "the reserved furnace is not available for placement");
        inventory.setStack(2, new ItemStack(Items.FURNACE, 2));
        require(budget.canPlaceFurnace(inventory), "one carried furnace can be spent while preserving the exact floor");
        budget.placedFurnace();
        require(!budget.canPlaceFurnace(inventory) && budget.placementsLeft() == 2
                && budget.remainingCost(Items.FURNACE) == 1 && budget.craftsLeft() == 3,
            "one furnace already used its single placement even when the wider job still has placement and item budget");
    }

    private static JsonObject ironWorkQuote() {
        return JsonParser.parseString("""
            {"v":1,"id":"iron-work","run":"run","life":1,"epoch":1,"basisTick":5,"expiresTick":905,
             "safetyRevision":1,"origin":"model","target":{"kind":"stock","item":"minecraft:iron_ingot","count":3},
             "allowedEffects":["smelt:minecraft:iron_ingot","place:minecraft:furnace"],
             "costCaps":[{"item":"minecraft:raw_iron","count":3},{"item":"minecraft:oak_planks","count":2},
                         {"item":"minecraft:furnace","count":2}],
             "reserves":[{"item":"minecraft:raw_iron","count":1},{"item":"minecraft:oak_planks","count":4},
                         {"item":"minecraft:furnace","count":1}],
             "maxBreaks":0,"maxCrafts":3,"maxPlacements":3}
            """).getAsJsonObject();
    }

    @Test
    void leaseRefreshRequiresTheExactStillActiveOrdinarySession() {
        var raw = JsonParser.parseString("""
            {"v":1,"id":"prospect","run":"run","life":1,"epoch":1,"basisTick":2187,"expiresTick":3387,
             "safetyRevision":1,"origin":"model","target":{"kind":"stock","item":"minecraft:diamond","count":1},
             "allowedEffects":["prospect:minecraft:diamond","break:minecraft:deepslate_diamond_ore","place:minecraft:torch"],
             "costCaps":[{"item":"minecraft:torch","count":3}],"reserves":[{"item":"minecraft:iron_pickaxe","count":1}],
             "maxBreaks":40,"maxCrafts":0,"maxPlacements":3,"duringWaitFor":"paid-furnace"}
            """).getAsJsonObject();
        var original = AgentWorkOrder.parse(raw, "run", "constrained");
        raw.addProperty("id", "renewed");
        raw.addProperty("basisTick", 2809);
        raw.addProperty("expiresTick", 3747);
        var renewed = AgentWorkOrder.parse(raw, "run", "constrained");
        require(AgentMacroControl.canRenewWork(original, original, renewed),
            "an exact lease refresh uses the witnessed active session");
        require(!AgentMacroControl.canRenewWork(original, null, renewed),
            "arrival after the original retired must not turn time into a new session");
        require(!AgentMacroControl.canRenewWork(original, renewed, renewed),
            "another active order with the same policy does not own the witnessed session");
        raw.addProperty("maxPlacements", 4);
        require(!AgentMacroControl.canRenewWork(original, original, AgentWorkOrder.parse(raw, "run", "constrained")),
            "renewal does not increase placement permission");
        raw.addProperty("maxPlacements", 3);
        raw.addProperty("duringWaitFor", "another-furnace");
        require(!AgentMacroControl.canRenewWork(original, original, AgentWorkOrder.parse(raw, "run", "constrained")),
            "renewal does not change the separately paid obligation");
        var smelt = AgentWorkOrder.parse(ironWorkQuote(), "run", "preset");
        var freshSmelt = new AgentWorkOrder("renewed-smelt", smelt.life(), smelt.epoch(), 50, 950,
            smelt.safetyRevision(), smelt.policy(), null, null, null, null, null);
        require(!AgentMacroControl.canRenewWork(smelt, smelt, freshSmelt),
            "the paid batch is not an ordinary session");
    }

    @Test
    void aScopedApproachCannotPriceCoverOrBeRetargetedByRenewal() {
        var raw = JsonParser.parseString("""
            {"v":1,"id":"diamond-leg","run":"run","life":1,"epoch":1,"basisTick":15,"expiresTick":400,
             "safetyRevision":1,"origin":"model","target":{"kind":"stock","item":"minecraft:diamond","count":1},
             "allowedEffects":["prospect:minecraft:diamond","break:minecraft:diamond_ore"],"costCaps":[],
             "reserves":[{"item":"minecraft:iron_pickaxe","count":1}],"maxBreaks":2,"maxCrafts":0,"maxPlacements":0,
             "travelAnchor":{"subject":"block:minecraft:stone","target":"wall-a"}}
            """).getAsJsonObject();
        var original = AgentWorkOrder.parse(raw, "run", "constrained");
        require(original != null && original.policy() != null && original.policy().diamondProspecting()
                && original.travelAnchor().target().equals("wall-a"),
            "an ordinary diamond prospect can name a specific rendered natural frontier");
        require(original.policy().travelAnchorAllowed(original.travelAnchor().subject(), AgentWorkOrder.TravelKind.CAVE_FRONTIER)
                && !original.policy().breakAllowed(Blocks.STONE.getDefaultState()),
            "approach evidence cannot expand the allowed break set");
        raw.addProperty("id", "renew");
        raw.addProperty("basisTick", 40);
        raw.addProperty("expiresTick", 450);
        require(AgentMacroControl.canRenewWork(original, original, AgentWorkOrder.parse(raw, "run", "constrained")),
            "an exact ordinary approach can retain its original grant and spent budget");
        raw.getAsJsonObject("travelAnchor").addProperty("target", "wall-b");
        require(!AgentMacroControl.canRenewWork(original, original, AgentWorkOrder.parse(raw, "run", "constrained")),
            "a new target needs a new physical admission, never a renewal");
        raw.getAsJsonObject("travelAnchor").addProperty("subject", "block:minecraft:lava");
        require(AgentWorkOrder.parse(raw, "run", "constrained").policy() == null,
            "a lava anchor is not a scoped ordinary approach");
    }

    @Test
    void aWoodlandLandmarkCannotStandInForTheInspectedHarvest() {
        var raw = JsonParser.parseString("""
            {"v":1,"id":"oak-leg","run":"run","life":1,"epoch":1,"basisTick":15,"expiresTick":400,
             "safetyRevision":1,"origin":"model","target":{"kind":"stock","item":"minecraft:oak_log","count":1},
             "allowedEffects":["break:minecraft:oak_log"],"costCaps":[],"reserves":[],
             "maxBreaks":1,"maxCrafts":0,"maxPlacements":0,
             "travelAnchor":{"subject":"landmark:woodland","target":"canopy-a"}}
            """).getAsJsonObject();
        var forest = AgentWorkOrder.parse(raw, "run", "constrained");
        require(forest.policy() != null && forest.harvestAnchor() == null
                && !forest.policy().breakAllowed(Blocks.OAK_LEAVES.getDefaultState()),
            "visible canopy allows an ordinary log inquiry; foliage is not a harvest");
        var anchor = raw.remove("travelAnchor").getAsJsonObject();
        raw.add("harvestAnchor", anchor);
        require(AgentWorkOrder.parse(raw, "run", "constrained").policy() == null,
            "woodland is not a material target");
        anchor.addProperty("subject", "block:minecraft:oak_log");
        anchor.addProperty("target", "trunk-a");
        var exact = AgentWorkOrder.parse(raw, "run", "constrained");
        require(exact.policy() != null && exact.travelAnchor() == null && exact.harvestAnchor().target().equals("trunk-a"),
            "the inspected exact log can authorize harvest without a walking window");
        raw.addProperty("id", "renew-oak");
        raw.addProperty("expiresTick", 450);
        anchor.addProperty("target", "trunk-b");
        require(!AgentMacroControl.canRenewWork(exact, exact, AgentWorkOrder.parse(raw, "run", "constrained")),
            "a renewal cannot redirect exact harvest to another trunk");
    }

    @Test
    void onlyAnExposedSourceWaterBlockCanBeConsideredForTheFill() {
        var water = Blocks.WATER.getDefaultState();
        require(AgentBody.exactWaterSource(water), "ordinary still water is eligible");
        require(!AgentBody.exactWaterSource(water.with(FluidBlock.LEVEL, 1)),
            "flowing water is not bucketable stock");
        require(!AgentBody.exactWaterSource(water.with(FluidBlock.LEVEL, 8)),
            "falling water is not bucketable stock");
        require(!AgentBody.exactWaterSource(Blocks.OAK_STAIRS.getDefaultState().with(Properties.WATERLOGGED, true)),
            "a waterlogged block is not a plain water source");
        require(!AgentBody.exactWaterSource(Blocks.LAVA.getDefaultState()), "still lava is outside the effect");
    }

    @Test
    void waterWorkUsesOneUnreservedBucketAndRequiresAReceiptAndExactSwap() {
        var raw = JsonParser.parseString("""
            {"v":1,"id":"water-work","run":"run","life":1,"epoch":1,"basisTick":5,"expiresTick":105,
             "safetyRevision":1,"origin":"model","target":{"kind":"stock","item":"minecraft:water_bucket","count":1},
             "allowedEffects":["fill:minecraft:water"],"costCaps":[{"item":"minecraft:bucket","count":1}],
             "reserves":[{"item":"minecraft:bucket","count":1},{"item":"minecraft:iron_pickaxe","count":1}],
             "maxBreaks":0,"maxCrafts":0,"maxPlacements":0}
            """).getAsJsonObject();
        var policy = AgentWorkOrder.parse(raw, "run", "constrained").policy();
        require(policy.waterFill() && !policy.placeTable() && !policy.placeFurnace() && !policy.craftAllowed("bucket"),
            "only source water may be filled; no placement or crafting is inherited");
        var inventory = new PlayerInventory(null);
        var budget = new AgentWorkOrder.Budget(policy);
        inventory.setStack(0, new ItemStack(Items.BUCKET, 2));
        require(!budget.canFillWater(inventory), "a missing unrelated floor also blocks the fill");
        inventory.setStack(0, new ItemStack(Items.BUCKET, 1));
        inventory.setStack(1, new ItemStack(Items.IRON_PICKAXE));
        require(!budget.canFillWater(inventory), "one reserved empty bucket is not spendable");
        inventory.setStack(0, new ItemStack(Items.BUCKET, 2));
        require(budget.canFillWater(inventory), "a second carried bucket is spendable");
        budget.issuedWaterFill();
        require(!budget.canFillWater(inventory) && !budget.confirmsWaterFill(inventory, 2, true),
            "the lease cannot issue twice while vanilla inventory is delayed");
        inventory.setStack(2, new ItemStack(Items.WATER_BUCKET));
        require(!budget.confirmsWaterFill(inventory, 2, true), "a gain alone is not the required swap");
        inventory.setStack(0, new ItemStack(Items.BUCKET));
        require(!budget.confirmsWaterFill(inventory, 2, false), "the swap alone is not a source-use receipt");
        require(budget.confirmsWaterFill(inventory, 2, true), "one receipt, one swap, and intact floors confirm the work");
        inventory.setStack(1, ItemStack.EMPTY);
        require(!budget.confirmsWaterFill(inventory, 2, true), "no completion after a declared floor is lost");

        for (String effect : List.of("fill:minecraft:lava", "pour:minecraft:water", "place:minecraft:water")) {
            var variant = raw.deepCopy();
            variant.getAsJsonArray("allowedEffects").set(0, new com.google.gson.JsonPrimitive(effect));
            require(AgentWorkOrder.parse(variant, "run", "preset").policy() == null, "unsupported fluid effect: " + effect);
        }
        var program = raw.deepCopy();
        program.addProperty("id", "program:1");
        program.addProperty("nextWorkId", "program:2");
        require(AgentWorkOrder.parse(program, "run", "preset").policy() == null, "no program can authorize bucket filling");
        var twoBuckets = raw.deepCopy();
        twoBuckets.getAsJsonObject("target").addProperty("count", 2);
        require(AgentWorkOrder.parse(twoBuckets, "run", "preset").policy() == null, "one lease fills only one bucket");
        raw.getAsJsonArray("costCaps").get(0).getAsJsonObject().addProperty("count", 2);
        require(AgentWorkOrder.parse(raw, "run", "preset").policy() == null, "the only bucket cap is one");
    }

    @Test
    void adjacentCapAndFurtherStairCutsNeverRemoveTheStandingOrReturnSupport() {
        var foot = new BlockPos(0, 72, 0);
        var cap = foot.down().east();
        require(AgentMacroControl.prospectBearing(foot, foot.down(), Direction.UP) == null
                && AgentMacroControl.prospectBearing(foot, foot.east().up(), Direction.WEST) == null
                && AgentMacroControl.prospectBearing(foot, foot.east().north().down(), Direction.UP) == null,
            "the player cannot cut underfoot or remove its headroom");
        var bearing = AgentMacroControl.prospectBearing(foot, cap, Direction.UP);
        require(bearing == Direction.EAST && AgentSurfaceTread.nextFoot(foot, bearing).equals(cap),
            "a witnessed adjacent cap proposes a one-block descent on that same bearing");
        var next = cap.east().down();
        require(AgentSurfaceTread.plannedCell(cap, next.up(), bearing, Direction.WEST)
                && AgentSurfaceTread.plannedCell(cap, next, bearing, Direction.UP),
            "after landing, only the exact adjacent lower cell and its occluding face can be cleared");
        require(!AgentSurfaceTread.plannedCell(cap, cap.down(), bearing, Direction.UP)
                && !AgentSurfaceTread.plannedCell(cap, foot.down(), bearing, Direction.UP)
                && !AgentSurfaceTread.plannedCell(cap, next.down(), bearing, Direction.UP)
                && !AgentSurfaceTread.plannedCell(cap, next, bearing, Direction.WEST)
                && !AgentSurfaceTread.plannedCell(cap, next.north(), bearing, Direction.UP),
            "the route cannot cut a retained support, deepen its landing, or turn into another column");
    }

    @Test
    void stairAcquiresTheInnerTopWithoutAimingThroughTheReturnLip() {
        var upper = new BlockPos(0, 70, 0);
        var next = AgentSurfaceTread.nextFoot(upper, Direction.EAST);
        var eye = new Vec3d(0.55, 71.62, 0.58);
        var inner = AgentSurfaceTread.innerTop(next, Direction.EAST);
        double entryHeight = eye.lerp(inner, (1 - eye.x) / (inner.x - eye.x)).y;
        require(entryHeight > 70 && entryHeight < 71, "the inner ray crosses the open cell below the close lip");
        require(AgentSurfaceTread.returnLip(upper, next.up(2), Direction.EAST, Direction.WEST),
            "the near face of the one exact return lip is actionable");
        require(!AgentSurfaceTread.returnLip(upper, upper.up(), Direction.EAST, Direction.DOWN)
                && !AgentSurfaceTread.returnLip(upper, next.up(3), Direction.EAST, Direction.WEST)
                && !AgentSurfaceTread.returnLip(upper, next.up(2), Direction.EAST, Direction.NORTH)
                && !AgentSurfaceTread.returnLip(upper, next.down(), Direction.EAST, Direction.UP),
            "neither overhead at the stance, a higher roof, the wrong side, nor a support is a return lip");
    }

    @Test
    void deepCoverUsesTheAdmittedRoleBudgetNotAnInternalFiveCutLimit() {
        var preset = new AgentWorkOrder.Policy(true, new AgentWorkOrder.Target(null, 0, "stone_pickaxe"),
            Set.of(), Map.of(), Map.of(), 32, 0, 0);
        var budget = new AgentWorkOrder.Budget(preset);
        for (int i = 0; i < 5; i++) budget.broken(Items.AIR, 0);
        require(budget.breaksLeft() == 27 && budget.canCutCover(),
            "five real cover breaks leave the rest of the admitted preset grant available");
        for (int i = 0; i < 26; i++) budget.broken(Items.AIR, 0);
        require(budget.breaksLeft() == 1 && !budget.canCutCover() && budget.canBreak(),
            "the source break is retained when the actual grant gets low");
    }

    @Test
    void eachNewTreadMustLeaveTimeForEveryRetainedReverseEdge() {
        int currentDepth = 4;
        long returnReserve = AgentSurfaceTread.returnTicks(currentDepth + 1);
        require(AgentSurfaceTread.canExtend(returnReserve + AgentSurfaceTread.ACTION_TICKS + 1, currentDepth)
                && !AgentSurfaceTread.canExtend(returnReserve + AgentSurfaceTread.ACTION_TICKS, currentDepth),
            "extension beyond three treads depends on the remaining lease, including the new return edge");
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
