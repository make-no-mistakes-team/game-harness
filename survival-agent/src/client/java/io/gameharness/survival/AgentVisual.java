package io.gameharness.survival;

import io.gameharness.survival.mixin.AgentVisualBossAccess;
import io.gameharness.survival.mixin.AgentVisualChatAccess;
import io.gameharness.survival.mixin.AgentVisualHudAccess;
import io.gameharness.survival.mixin.AgentVisualToastAccess;
import java.nio.ByteBuffer;
import java.nio.file.Path;
import java.util.UUID;
import java.util.function.Predicate;
import net.minecraft.block.BlockRenderType;
import net.minecraft.block.BlockState;
import net.minecraft.block.enums.CameraSubmersionType;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.client.world.ClientWorld;
import net.minecraft.entity.Entity;
import net.minecraft.entity.effect.StatusEffects;
import net.minecraft.entity.projectile.ProjectileUtil;
import net.minecraft.item.Items;
import net.minecraft.network.message.ChatVisibility;
import net.minecraft.registry.Registries;
import net.minecraft.scoreboard.ScoreboardDisplaySlot;
import net.minecraft.util.Arm;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.MathHelper;
import net.minecraft.util.math.Vec3d;
import net.minecraft.world.RaycastContext;

/** Associates an ordinary render with its image, and reads first hits. Never acquires any game input. */
final class AgentVisual {
    private static final int MAX_BASIS_AGE = 40;
    private static final int MAX_SOURCE_AGE = 600;
    private static final long MAX_SOURCE_NANOS = 30_000_000_000L;
    private static final long MAX_RENDER_NANOS = 160_000_000L;
    private static final double MAX_DISTANCE = 12;

    record CaptureView(AgentVisualProjection projection, ClientWorld world, ClientPlayerEntity player,
                       long renderFrame, long tick, long nanos) {
        boolean fresh(long currentTick, long now) {
            return tick <= currentTick && currentTick - tick <= MAX_SOURCE_AGE && nanos <= now && now - nanos <= MAX_SOURCE_NANOS;
        }
    }

    record Surface(String id, BlockHitResult hit, BlockState state, ClientWorld world, ClientPlayerEntity player,
                   int life, long epoch, long expiresTick, long expiresNanos) {}

    private static final class PublishedView {
        final AgentVisualProjection projection = new AgentVisualProjection();
        ClientWorld world;
        ClientPlayerEntity player;
        int life;
        long epoch, tick;
    }

    private final AgentVisualMailbox mailbox;
    private final MinecraftClient client;
    private final AgentMacroControl macro;
    private final Predicate<Entity> visibleBody = this::visibleBody;
    private AgentVisualProjection live = new AgentVisualProjection(), previous = new AgentVisualProjection();
    private final PublishedView[] bases = { new PublishedView(), new PublishedView(), new PublishedView(), new PublishedView() };
    private int nextBasis;
    private long startFrame = -1, renderFrame, renderedNanos, tick;
    private ClientWorld renderedWorld;
    private ClientPlayerEntity renderedPlayer;
    private AgentBody rendering;
    private CaptureView heldCapture;
    private boolean stable, closed;
    private String captureAttempt, probeAttempt, observedProbe;
    private Surface candidate;
    private long checkedTick = -1, checkedFrame = -1, firstProbeRay;

    AgentVisual(Path directory, String run, MinecraftClient client, AgentMacroControl macro) {
        this.client = client;
        this.macro = macro;
        mailbox = new AgentVisualMailbox(directory, run);
    }

    static String opaque(String prefix) { return prefix + UUID.randomUUID().toString().replace("-", ""); }

    void begin(AgentBody body) {
        rendering = body;
        startFrame = body.renderedFrame();
    }

    void renderTail(AgentBody body, long tick) {
        this.tick = tick;
        long now = System.nanoTime();
        boolean usable = !closed && mailbox.authorized && rendering == body && startFrame + 1 == body.renderedFrame()
            && worldCamera();
        rendering = null;
        if (usable) {
            var old = live;
            live = previous;
            previous = old;
            usable = body.copyVisualProjection(live);
            if (usable) {
                var framebuffer = client.getFramebuffer();
                live.width = framebuffer.viewportWidth;
                live.height = framebuffer.viewportHeight;
                usable = live.valid() && AgentVisualImage.dimensions(live.width, live.height)
                    && live.width == framebuffer.textureWidth && live.height == framebuffer.textureHeight;
            }
        }
        if (usable) {
            stable = renderedWorld == client.world && renderedPlayer == client.player && now - renderedNanos <= MAX_RENDER_NANOS
                && live.compatible(previous);
            renderedWorld = client.world;
            renderedPlayer = client.player;
            renderFrame = body.renderedFrame();
            renderedNanos = now;
            masks();
            if (heldCapture != null && (!live.compatible(heldCapture.projection)
                    || heldCapture.world != renderedWorld || heldCapture.player != renderedPlayer)) heldCapture = null;
        } else {
            invalidateRender();
            if (candidate != null) retireCandidate();
        }
        captureOnDemand(tick, now, usable);
    }

    static boolean publishable(AgentBody body, long tick) {
        var visual = body == null ? null : body.visual();
        return visual != null && visual.rememberBasis(tick);
    }

    private boolean rememberBasis(long observationTick) {
        if (!stable || !freshRender(System.nanoTime(), true)) return false;
        PublishedView basis = bases[nextBasis];
        nextBasis = (nextBasis + 1) % bases.length;
        basis.tick = observationTick;
        basis.life = macro.visualLife();
        basis.epoch = macro.visualEpoch();
        basis.world = renderedWorld;
        basis.player = renderedPlayer;
        basis.projection.copyFrom(live);
        return true;
    }

    private void captureOnDemand(long tick, long now, boolean usable) {
        var request = mailbox.capture;
        if (request == null || request.id().equals(captureAttempt)) return;
        captureAttempt = request.id();
        var basis = request.basis();
        if (!basis.current(macro.visualLife(), macro.visualEpoch(), tick, MAX_BASIS_AGE)
                || !captureBasis(basis) || !macro.visualReadAllowed()) {
            mailbox.submit(new AgentVisualMailbox.Readback(request, null, null, "basis_changed"));
            return;
        }
        if (!usable || !stable || !freshRender(now, true)) {
            mailbox.submit(new AgentVisualMailbox.Readback(request, null, null, "unavailable"));
            return;
        }
        AgentVisualProjection projection = new AgentVisualProjection();
        projection.copyFrom(live);
        CaptureView source = new CaptureView(projection, renderedWorld, renderedPlayer, renderFrame, tick, now);
        refreshScene();
        ByteBuffer pixels;
        try { pixels = AgentVisualImage.read(client.getFramebuffer()); }
        catch (RuntimeException failed) { pixels = null; }
        if (pixels == null) {
            mailbox.submit(new AgentVisualMailbox.Readback(request, null, null, "unavailable"));
        } else {
            heldCapture = source;
            mailbox.submit(new AgentVisualMailbox.Readback(request, source, pixels, null));
        }
    }

    private boolean captureBasis(AgentVisualMailbox.Basis requested) {
        for (PublishedView basis : bases) {
            if (basis.tick == requested.tick() && basis.life == requested.life() && basis.epoch == requested.epoch()
                    && basis.world == client.world && basis.player == client.player)
                return live.compatible(basis.projection);
        }
        return false;
    }

    void beginTick(long tick) { this.tick = tick; }

    void tick(AgentBody body) {
        if (closed) return;
        refreshScene();
        var published = mailbox.publishedProbe;
        if (published != null && !published.request().id().equals(observedProbe)) {
            observedProbe = published.request().id();
            candidate = published.surface();
            checkedTick = checkedFrame = -1;
            macro.visualResultChanged();
        }
        if (candidate != null && !validScope(candidate, System.nanoTime())) retireCandidate();

        long now = System.nanoTime();
        var bound = mailbox.bound.get();
        var scene = mailbox.scene;
        if (heldCapture != null && (!heldCapture.fresh(tick, now) || !freshRender(now, true))) heldCapture = null;
        if (bound != null && (bound.view() != heldCapture || scene == null || !scene.matches(bound.request().basis(),
                bound.view().world, bound.view().player))) {
            mailbox.bound.compareAndSet(bound, null);
            bound = null;
        }
        var request = mailbox.probe;
        if (request == null || request.id().equals(probeAttempt)) return;
        // A proposal may take seconds. It still names the old source image exactly but the
        // proof is a different, compatible world render, with its own fresh first-hit check.
        if (bound == null || !bound.matches(request)
                || !request.basis().current(macro.visualLife(), macro.visualEpoch(), tick, MAX_BASIS_AGE)
                || request.basis().tick() > macro.visualBasisTick() || tick > request.expires()
                || bound.view().world != client.world || bound.view().player != client.player
                || !macro.visualReadAllowed() || !stable || !freshRender(now, true)
                || !bound.view().projection.compatible(live)) {
            probeAttempt = request.id();
            answer(request, tick, "basis_changed", null, null, 0);
        } else if (renderFrame > bound.view().renderFrame) {
            probeAttempt = request.id();
            sample(body, request, bound.view().projection, tick, now);
        }
    }

    private void refreshScene() {
        var scene = mailbox.scene;
        int life = macro.visualLife();
        long epoch = macro.visualEpoch();
        if (scene == null || scene.life() != life || scene.epoch() != epoch || scene.world() != client.world
                || scene.player() != client.player)
            mailbox.scene = new AgentVisualMailbox.Scene(life, epoch, client.world, client.player);
    }

    private void sample(AgentBody body, AgentVisualMailbox.Probe request, AgentVisualProjection source, long tick, long now) {
        var nomination = request.region();
        firstProbeRay = 0;
        var report = AgentVisualSelection.read(nomination, source, live, ray -> {
            long rayStart = System.nanoTime();
            if (firstProbeRay == 0) firstProbeRay = rayStart;
            else if (rayStart - firstProbeRay > 2_500_000L) return AgentVisualSelection.Hit.BUDGET_EXHAUSTED;
            var hit = first(ray.origin(), ray.origin().add(ray.direction().multiply(MAX_DISTANCE + .025)));
            if (hit.getType() != HitResult.Type.BLOCK) return AgentVisualSelection.Hit.MISS;
            double distance = live.eye.distanceTo(hit.getPos());
            if (distance < .05 || distance > MAX_DISTANCE) return AgentVisualSelection.Hit.OUT_OF_RANGE;
            var pixel = live.project(hit.getPos());
            var sourcePixel = source.project(hit.getPos());
            if (pixel == null || !nomination.contains(pixel.x(), pixel.y()) || hit.isInsideBlock()
                    || sourcePixel == null || !nomination.contains(sourcePixel.x(), sourcePixel.y())
                    || entityOccludes(ray.origin(), hit.getPos(), ray.origin().squaredDistanceTo(hit.getPos())))
                return AgentVisualSelection.Hit.OCCLUDED;
            if (body.observedFaceLight(hit) <= 0) return AgentVisualSelection.Hit.DARK;
            var state = client.world.getBlockState(hit.getBlockPos());
            if (!witnessedState(state)) return AgentVisualSelection.Hit.OCCLUDED;
            return new AgentVisualSelection.Hit("witnessed", hit, state, distance);
        });
        if (report.block() == null) answer(request, tick, report.status(), null, null, 0);
        else {
            String subject = "block:" + Registries.BLOCK.getId(report.state().getBlock());
            Surface witnessed = new Surface(opaque("vr-"), report.block(), report.state(), renderedWorld, renderedPlayer,
                request.basis().life(), request.basis().epoch(), tick + MAX_SOURCE_AGE, now + MAX_SOURCE_NANOS);
            answer(request, tick, "witnessed", witnessed, subject, report.distance());
        }
    }

    private void answer(AgentVisualMailbox.Probe request, long tick, String status, Surface surface, String subject,
                        double distance) {
        mailbox.submit(new AgentVisualMailbox.ProbeAnswer(request, tick, status, surface, subject, distance));
    }

    static Surface current(AgentBody body) {
        var visual = body == null ? null : body.visual();
        return visual == null || visual.candidate == null ? null : visual.check(body, visual.candidate.id);
    }

    static Surface recheck(AgentBody body, String candidateId) {
        var visual = body == null ? null : body.visual();
        return visual == null ? null : visual.check(body, candidateId);
    }

    private Surface check(AgentBody body, String id) {
        var surface = candidate;
        if (surface == null || !surface.id.equals(id)) return null;
        long now = System.nanoTime();
        if (!validScope(surface, now) || !freshRender(now, false)) {
            retireCandidate();
            return null;
        }
        if (checkedTick == tick && checkedFrame == renderFrame) return surface;
        checkedTick = tick;
        checkedFrame = renderFrame;
        Vec3d target = surface.hit.getPos();
        var pixel = live.project(target);
        var ray = pixel == null ? null : live.ray(pixel.x(), pixel.y());
        double renderedDistanceSquared = live.eye.squaredDistanceTo(target);
        if (ray != null && renderedDistanceSquared >= .0025 && renderedDistanceSquared <= MAX_DISTANCE * MAX_DISTANCE
                && client.player.getEyePos().squaredDistanceTo(target) <= MAX_DISTANCE * MAX_DISTANCE) {
            var hit = first(ray.origin(), target.add(ray.direction().multiply(.025)));
            if (hit.getType() == HitResult.Type.BLOCK && !hit.isInsideBlock()
                    && hit.getBlockPos().equals(surface.hit.getBlockPos()) && hit.getSide() == surface.hit.getSide()
                    && hit.getPos().squaredDistanceTo(target) <= .0004
                    && client.world.getBlockState(hit.getBlockPos()) == surface.state
                    && !entityOccludes(ray.origin(), hit.getPos(), ray.origin().squaredDistanceTo(hit.getPos()))
                    && live.project(hit.getPos()) != null && body.observedFaceLight(hit) > 0) return surface;
        }
        retireCandidate();
        return null;
    }

    private boolean validScope(Surface surface, long now) {
        return !closed && mailbox.authorized && surface.world == client.world && surface.player == client.player
            && surface.life == macro.visualLife() && surface.epoch == macro.visualEpoch()
            && tick <= surface.expiresTick && now <= surface.expiresNanos;
    }

    private void retireCandidate() {
        candidate = null;
        macro.visualResultChanged();
    }

    void invalidate() {
        invalidateRender();
        mailbox.scene = null;
        mailbox.bound.set(null);
        if (candidate != null) retireCandidate();
        for (PublishedView basis : bases) basis.tick = 0;
    }

    private void invalidateRender() {
        stable = false;
        heldCapture = null;
        renderedWorld = null;
        renderedPlayer = null;
        renderedNanos = 0;
    }

    void close() {
        if (closed) return;
        closed = true;
        invalidate();
        mailbox.close();
    }

    private boolean freshRender(long now, boolean stableEye) {
        var player = client.player;
        return renderedNanos > 0 && now >= renderedNanos && now - renderedNanos <= MAX_RENDER_NANOS
            && renderedWorld == client.world && renderedPlayer == player && worldCamera()
            && client.getFramebuffer().viewportWidth == live.width && client.getFramebuffer().viewportHeight == live.height
            && player.getEyePos().squaredDistanceTo(live.eye) <= (stableEye ? .0025 : .1296)
            && Math.abs(MathHelper.wrapDegrees(player.getYaw() - live.yaw)) <= (stableEye ? .25 : 2)
            && Math.abs(player.getPitch() - live.pitch) <= (stableEye ? .25 : 2);
    }

    private boolean worldCamera() {
        var player = client.player;
        var camera = client.gameRenderer.getCamera();
        if (client.world == null || player == null || !player.isAlive() || player.isSpectator() || player.isSleeping()
                || player.hasVehicle() || client.isPaused() || !client.isWindowFocused()
                || client.currentScreen != null || client.getOverlay() != null || client.getCameraEntity() != player
                || camera.getFocusedEntity() != player || !client.options.getPerspective().isFirstPerson()
                || player.isUsingItem() || player.isOnFire() || player.nauseaIntensity > 0 || player.prevNauseaIntensity > 0
                || player.hasStatusEffect(StatusEffects.BLINDNESS) || player.hasStatusEffect(StatusEffects.DARKNESS)
                || player.getInventory().getArmorStack(3).isOf(Items.CARVED_PUMPKIN)
                || camera.getSubmersionType() != CameraSubmersionType.NONE) return false;
        if (client.options.hudHidden) return true;
        var hud = (AgentVisualHudAccess) client.inGameHud;
        return hud.agent$visualTitleTicks() <= 0 && !client.getDebugHud().shouldShowDebugHud()
            && !client.options.playerListKey.isPressed();
    }

    private void masks() {
        live.clearMasks();
        if (client.options.hudHidden) return;
        var player = client.player;
        int w = client.getWindow().getScaledWidth(), h = client.getWindow().getScaledHeight();
        // GUI rendered in scaled coordinates over the full-resolution image. These
        // conservatively cover vanilla's crosshair/attack indicator, status bars and
        // untracked first-person hand/item animation.
        live.mask(.5 - 14.0 / w, .5 - 14.0 / h, .5 + 14.0 / w, .5 + 22.0 / h);
        live.mask(0, 1 - 62.0 / h, 1, 1);
        if (player.getMainArm() == Arm.RIGHT || !player.getOffHandStack().isEmpty()) live.mask(.64, .59, 1, 1);
        if (player.getMainArm() == Arm.LEFT || !player.getOffHandStack().isEmpty()) live.mask(0, .59, .36, 1);
        var chat = client.inGameHud.getChatHud();
        var messages = ((AgentVisualChatAccess) chat).agent$visualMessages();
        if (client.options.getChatVisibility().getValue() != ChatVisibility.HIDDEN
                && !messages.isEmpty() && client.inGameHud.getTicks() - messages.getFirst().addedTime() < 200)
            live.mask(0, Math.max(0, 1 - (chat.getHeight() + 46.0) / h), Math.min(1, (chat.getWidth() + 9.0) / w), 1);
        var toasts = ((AgentVisualToastAccess) client.getToastManager()).agent$visualToasts();
        if (!toasts.isEmpty()) live.mask(Math.max(0, 1 - 170.0 / w), 0, 1, Math.min(1, 170.0 / h));
        if (!player.getStatusEffects().isEmpty()) live.mask(Math.max(0, 1 - 240.0 / w), 0, 1, 70.0 / h);
        if (!((AgentVisualBossAccess) client.inGameHud.getBossBarHud()).agent$visualBars().isEmpty())
            live.mask(.5 - 96.0 / w, 0, .5 + 96.0 / w, .333); // Vanilla caps boss bars at one third of height.
        if (((AgentVisualHudAccess) client.inGameHud).agent$visualOverlayTicks() > 0)
            live.mask(0, 1 - 86.0 / h, 1, 1);
        if (client.options.getShowSubtitles().getValue()) live.mask(.50, .50, 1, 1);
        var scoreboard = client.world.getScoreboard();
        var team = player.getScoreboardTeam();
        var teamSlot = team == null ? null : ScoreboardDisplaySlot.fromFormatting(team.getColor());
        if (scoreboard.getObjectiveForSlot(ScoreboardDisplaySlot.SIDEBAR) != null
                || teamSlot != null && scoreboard.getObjectiveForSlot(teamSlot) != null) live.mask(.5, .20, 1, .80);
    }

    private BlockHitResult first(Vec3d eye, Vec3d end) {
        // Unlike the ordinary resource sampler, a visual-region read never looks through fluids.
        return client.world.raycast(new RaycastContext(eye, end, RaycastContext.ShapeType.OUTLINE,
            RaycastContext.FluidHandling.ANY, client.player));
    }

    private static boolean witnessedState(BlockState state) {
        return !state.isAir() && state.getRenderType() != BlockRenderType.INVISIBLE && state.getFluidState().isEmpty();
    }

    private boolean visibleBody(Entity entity) {
        return entity.isAlive() && !entity.isSpectator() && !entity.isInvisibleTo(client.player);
    }

    private boolean entityOccludes(Vec3d eye, Vec3d end, double rangeSquared) {
        return ProjectileUtil.raycast(client.player, eye, end, new Box(eye, end).expand(1), visibleBody, rangeSquared) != null;
    }
}
