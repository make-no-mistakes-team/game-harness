package io.gameharness.survival;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import net.minecraft.util.math.BlockPos;
import org.junit.jupiter.api.Test;

final class AgentMemoryTest {
    private static final BlockPos LOW = new BlockPos(-15, 27, -34);
    private static final BlockPos MID = new BlockPos(-15, 28, -33);
    private static final BlockPos WOODLAND = new BlockPos(-14, 28, -33);

    @Test
    void aWalkCannotRecallAnExitUntilItsActualEndIsConfirmed() {
        var memory = new AgentMemory.ForagingTrail(List.of());
        memory.landed(LOW, MID, true);
        memory.landed(MID, WOODLAND, true);
        memory.confirm(MID);
        assertTrue(memory.proved().isEmpty());
        memory.confirm(WOODLAND);

        assertEquals(List.of(LOW, MID, WOODLAND), memory.proved());
        assertNull(memory.next(MID.north()), "nearby coordinates are not contact with the known path");
        assertEquals(WOODLAND, memory.next(MID));
        assertNull(memory.next(WOODLAND));
    }

    @Test
    void aDiscontinuityOrUncheckedReturnCanOnlyStartANewWalkedSuffix() {
        var memory = new AgentMemory.ForagingTrail(List.of());
        memory.landed(LOW, MID, true);
        BlockPos separate = MID.east(5);
        memory.landed(separate, separate.south(), true);
        memory.landed(separate.south(), separate.south(2), false);
        memory.landed(separate.south(2), separate.south(3), true);
        memory.confirm(separate.south(3));

        assertEquals(List.of(separate.south(2), separate.south(3)), memory.proved());
        assertNull(memory.next(MID));
        assertNull(memory.next(separate.south()));
    }

    @Test
    void aLiveVetoDoesNotOfferTheStaleEdgeAgainButKeepsTheConnectedUpperSuffix() {
        var memory = new AgentMemory.ForagingTrail(List.of(LOW, MID, WOODLAND));
        assertEquals(MID, memory.next(LOW));
        memory.refuse(LOW, MID);
        assertNull(memory.next(LOW));
        assertEquals(WOODLAND, memory.next(MID));
    }
}
