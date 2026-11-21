package io.gameharness.survival;

import java.util.function.Function;
import net.minecraft.block.BlockState;
import net.minecraft.util.hit.BlockHitResult;

/** A tiny, fixed, center-first read fan. Its only capability is a current first-hit reader. */
final class AgentVisualSelection {
    private static final double[] SAMPLES = {.5, .5, .25, .25, .75, .25, .25, .75, .75, .75};

    record Hit(String status, BlockHitResult block, BlockState state, double distance) {
        static final Hit MISS = new Hit("miss", null, null, 0);
        static final Hit OCCLUDED = new Hit("occluded", null, null, 0);
        static final Hit DARK = new Hit("dark", null, null, 0);
        static final Hit OUT_OF_RANGE = new Hit("out_of_range", null, null, 0);
        static final Hit BUDGET_EXHAUSTED = new Hit("budget_exhausted", null, null, 0);
    }

    private AgentVisualSelection() {}

    static Hit read(AgentVisualProjection.Region region, AgentVisualProjection source, AgentVisualProjection live,
                    Function<AgentVisualProjection.Ray, Hit> first) {
        Hit mostSpecific = Hit.MISS;
        for (int i = 0; i < SAMPLES.length; i += 2) {
            double x = region.x() + region.width() * SAMPLES[i], y = region.y() + region.height() * SAMPLES[i + 1];
            var sourceRay = source.ray(x, y);
            var currentRay = sourceRay == null ? null : live.ray(x, y);
            Hit hit = currentRay == null || sourceRay.direction().dotProduct(currentRay.direction()) < .99999
                ? Hit.OCCLUDED : first.apply(currentRay);
            if (hit.block != null || hit == Hit.BUDGET_EXHAUSTED) return hit;
            if (hit == Hit.DARK || hit == Hit.OUT_OF_RANGE && mostSpecific != Hit.DARK || mostSpecific == Hit.MISS)
                mostSpecific = hit;
        }
        return mostSpecific;
    }
}
