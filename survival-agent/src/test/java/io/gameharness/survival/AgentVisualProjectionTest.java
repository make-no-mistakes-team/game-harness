package io.gameharness.survival;

import net.minecraft.util.math.Vec3d;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

final class AgentVisualProjectionTest {
    @Test
    void topLeftCoordinatesRetainTheAsymmetricCornersOfTheRenderedAspectRatio() {
        var view = perspective();
        // At 90-degree vertical FOV, a plane two blocks ahead spans 4 blocks
        // vertically and 8 horizontally on this 2:1 native framebuffer.
        var topLeft = view.project(new Vec3d(7, 9.9, -5));
        var bottomRight = view.project(new Vec3d(13, 6.1, -5));
        assertNotNull(topLeft);
        assertNotNull(bottomRight);
        assertEquals(.125, topLeft.x(), 1e-6);
        assertEquals(.025, topLeft.y(), 1e-6);
        assertEquals(.875, bottomRight.x(), 1e-6);
        assertEquals(.975, bottomRight.y(), 1e-6);
        assertNull(view.project(new Vec3d(10, 8, -2)), "behind the rendered eye");
        assertNull(view.project(new Vec3d(14.1, 8, -5)), "beyond the right edge");

        var upperRay = view.ray(.125, .025);
        var lowerRay = view.ray(.875, .975);
        assertNotNull(upperRay);
        assertNotNull(lowerRay);
        assertTrue(upperRay.direction().x < 0 && upperRay.direction().y > 0);
        assertTrue(lowerRay.direction().x > 0 && lowerRay.direction().y < 0);
    }

    @Test
    void renderProjectionTranslationIsNotConfusedWithAPhysicalAimChange() {
        var view = perspective();
        view.matrix.translate(.125f, -.25f, 0);
        view.inverse.set(view.matrix).invert();
        var ray = view.ray(.5, .5);
        assertNotNull(ray);
        assertEquals(9.875, ray.origin().x, 1e-6);
        assertEquals(8.25, ray.origin().y, 1e-6);
        assertEquals(0, ray.direction().x, 1e-6);
        assertEquals(0, ray.direction().y, 1e-6);
        assertEquals(-1, ray.direction().z, 1e-6);
        var hit = view.project(new Vec3d(9.875, 8.25, -7));
        assertNotNull(hit);
        assertEquals(.5, hit.x(), 1e-6);
        assertEquals(.5, hit.y(), 1e-6);
    }

    @Test
    void differentPoseProjectionOrFrameSizeCannotRebindAnOldNomination() {
        var source = perspective();
        var later = perspective();
        assertTrue(source.compatible(later));
        later.eye = later.eye.add(.05, 0, 0);
        assertFalse(source.compatible(later));
        later.eye = source.eye;
        later.matrix.scale(1.1f, 1.1f, 1);
        assertFalse(source.compatible(later));
        later.matrix.set(source.matrix);
        later.width = 1000;
        assertFalse(source.compatible(later));
    }

    @Test
    void eitherCaptureOrCurrentHudMakesTheRegionInputFreeAndOccluded() {
        var source = perspective();
        var later = perspective();
        var region = new AgentVisualProjection.Region(.02, .03, .14, .14);
        source.mask(0, 0, .2, .2);
        assertSame(AgentVisualSelection.Hit.OCCLUDED,
            AgentVisualSelection.read(region, source, later, ray -> fail("read behind source HUD")));
        source.clearMasks();
        later.mask(0, 0, .2, .2);
        assertSame(AgentVisualSelection.Hit.OCCLUDED,
            AgentVisualSelection.read(region, source, later, ray -> fail("read behind live HUD")));
    }

    @Test
    void openRegionPerformsAtMostFiveFreshFirstHitReadsAndStopsWhenBudgetIsExhausted() {
        var source = perspective();
        var later = perspective();
        var region = new AgentVisualProjection.Region(.015, .035, .15, .15);
        int[] reads = {0};
        var result = AgentVisualSelection.read(region, source, later, ray -> {
            reads[0]++;
            var point = later.project(ray.origin().add(ray.direction().multiply(2)));
            assertNotNull(point);
            assertTrue(region.contains(point.x(), point.y()));
            return reads[0] == 2 ? AgentVisualSelection.Hit.DARK : AgentVisualSelection.Hit.MISS;
        });
        assertSame(AgentVisualSelection.Hit.DARK, result);
        assertEquals(5, reads[0]);
        reads[0] = 0;
        assertSame(AgentVisualSelection.Hit.BUDGET_EXHAUSTED, AgentVisualSelection.read(region, source, later, ray -> {
            reads[0]++;
            return AgentVisualSelection.Hit.BUDGET_EXHAUSTED;
        }));
        assertEquals(1, reads[0]);
    }

    private static AgentVisualProjection perspective() {
        var view = new AgentVisualProjection();
        view.eye = new Vec3d(10, 8, -3);
        view.width = 1200;
        view.height = 600;
        view.matrix.setPerspective((float) (Math.PI / 2), 2, .05f, 100);
        view.inverse.set(view.matrix).invert();
        return view;
    }
}
