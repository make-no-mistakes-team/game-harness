package io.gameharness.survival;

import java.util.List;

/**
 * Pure combat threat-scoring, combat-flow escape/cliff evaluation, tactical action selection,
 * and emergency shelter mode selection. Kept free of Minecraft client singletons so it is
 * directly unit-testable with JUnit 5.
 */
final class CombatPlanner {
    private CombatPlanner() {}

    enum CombatStance {
        AUTO, AGGRESSIVE, DEFENSIVE, FLEE, SHELTER;

        static CombatStance parse(String raw) {
            if (raw == null || raw.isBlank()) return AUTO;
            return switch (raw.trim().toLowerCase()) {
                case "aggressive" -> AGGRESSIVE;
                case "defensive" -> DEFENSIVE;
                case "flee" -> FLEE;
                case "shelter" -> SHELTER;
                default -> AUTO;
            };
        }

        String wireName() {
            return name().toLowerCase();
        }
    }

    enum ThreatKind {
        CREEPER, BABY_ZOMBIE, SKELETON, SPIDER, ZOMBIE, RANGED_OTHER, MELEE_OTHER;

        boolean isRanged() {
            return this == SKELETON || this == RANGED_OTHER;
        }

        boolean isFast() {
            return this == BABY_ZOMBIE || this == SPIDER;
        }

        String wireName() {
            return name().toLowerCase();
        }
    }

    enum TacticalAction {
        FIGHT,
        SHIELD_ADVANCE,
        SHIELD_HOLD,
        CREEPER_KITE,
        CREEPER_BLOCK,
        FLEE,
        EMERGENCY_SHELTER,
        CAUTIOUS_PEEK
    }

    enum ShelterMode {
        NONE,
        BOX_OR_CORNER,
        BURROW_DOWN
    }

    enum CellKind {
        UNKNOWN,
        PASSABLE,
        SOLID,
        HAZARD
    }

    @FunctionalInterface
    interface CellProbe {
        CellKind probe(int x, int y, int z);
    }

    record ThreatInfo(
        int entityId,
        ThreatKind kind,
        double x,
        double y,
        double z,
        double vx,
        double vy,
        double vz,
        double dist,
        float creeperFuse,
        boolean creeperSwelling,
        boolean rangedDrawing,
        boolean occluded,
        int memoryAgeTicks
    ) {}

    record CombatContext(
        float health,
        float maxHealth,
        int food,
        boolean hasFood,
        double weaponScore,
        boolean hasShield,
        boolean shieldReady,
        int armorPoints,
        int scaffoldBlocks,
        boolean hasDigTool,
        boolean trapped,
        double bestRetreatScore,
        CombatStance stance,
        List<ThreatInfo> threats,
        boolean incomingArrow
    ) {}

    record EscapeAssessment(
        double dirX,
        double dirZ,
        double bestScore,
        int openBearings,
        boolean trapped
    ) {}

    /** Score a threat for targeting priority (higher = handle first). */
    static double scoreThreat(ThreatInfo t) {
        if (t == null) return Double.NEGATIVE_INFINITY;
        double d = Math.max(0.5, t.dist());
        double base;
        if (t.kind() == ThreatKind.CREEPER && (t.creeperSwelling() || t.creeperFuse() > 0.05f || d < 5.0)) {
            base = 140.0 + t.creeperFuse() * 110.0 + (t.creeperSwelling() ? 25.0 : 0.0) - d * 6.0;
        } else if (t.kind() == ThreatKind.BABY_ZOMBIE && d < 9.5) {
            base = 108.0 - d * 6.5;
        } else if (t.kind().isRanged()) {
            base = 78.0 - d * 2.2 + (t.rangedDrawing() ? 20.0 : 0.0) + (d < 4.5 ? 14.0 : 0.0);
        } else if (t.kind() == ThreatKind.SPIDER) {
            base = 82.0 - d * 5.0;
        } else if (t.kind() == ThreatKind.CREEPER) {
            base = 76.0 - d * 4.0;
        } else {
            base = 80.0 - d * 5.2;
        }
        if (t.occluded()) {
            base -= 22.0 + Math.min(30.0, t.memoryAgeTicks() * 0.35);
        }
        return base;
    }

    /** Pick highest-priority threat from visible + remembered threats. */
    static ThreatInfo pickPrimaryThreat(List<ThreatInfo> threats) {
        ThreatInfo best = null;
        double bestScore = Double.NEGATIVE_INFINITY;
        for (ThreatInfo t : threats) {
            double s = scoreThreat(t);
            if (s > bestScore) {
                bestScore = s;
                best = t;
            }
        }
        return best;
    }

    /** Compute weighted threat pressure for fight-vs-flee-vs-shelter decisions. */
    static double threatPressure(List<ThreatInfo> threats) {
        double pressure = 0.0;
        for (ThreatInfo t : threats) {
            if (t.dist() > 13.0) continue;
            double closeness = t.dist() <= 4.5 ? 1.25 : (t.dist() <= 8.5 ? 1.0 : 0.65);
            double weight = switch (t.kind()) {
                case CREEPER -> (t.creeperSwelling() || t.creeperFuse() > 0.05f) ? 2.0 : 1.35;
                case BABY_ZOMBIE -> 1.65;
                case SKELETON, RANGED_OTHER -> 1.25;
                case SPIDER -> 1.15;
                default -> 1.0;
            };
            if (t.occluded()) {
                weight *= 0.65;
            }
            pressure += weight * closeness;
        }
        return pressure;
    }

    /** Decide tactical combat response from health, gear, threats, combat-flow terrain, and strategist stance. */
    static TacticalAction decideAction(CombatContext ctx) {
        List<ThreatInfo> threats = ctx.threats();
        boolean canShelter = ctx.scaffoldBlocks() >= 1 && (ctx.scaffoldBlocks() >= 4 || ctx.hasDigTool());
        boolean shieldUsable = ctx.hasShield() && ctx.shieldReady();

        // Explicit strategist stance overrides
        if (ctx.stance() == CombatStance.SHELTER) {
            if (canShelter) return TacticalAction.EMERGENCY_SHELTER;
            return shieldUsable && !threats.isEmpty() ? TacticalAction.SHIELD_HOLD : TacticalAction.FLEE;
        }

        if (threats.isEmpty()) {
            return ctx.incomingArrow() && shieldUsable ? TacticalAction.SHIELD_HOLD : TacticalAction.CAUTIOUS_PEEK;
        }

        ThreatInfo primary = pickPrimaryThreat(threats);
        boolean anyVisible = false;
        boolean hasRanged = false;
        boolean hasFast = false;
        ThreatInfo urgentCreeper = null;
        for (ThreatInfo t : threats) {
            if (!t.occluded()) anyVisible = true;
            if (t.kind().isRanged() && t.dist() <= 14.0) hasRanged = true;
            if (t.kind().isFast() && t.dist() <= 9.0) hasFast = true;
            if (t.kind() == ThreatKind.CREEPER && !t.occluded()
                    && (t.creeperSwelling() || t.creeperFuse() > 0.05f || t.dist() < 5.0)) {
                if (urgentCreeper == null || t.dist() < urgentCreeper.dist()) {
                    urgentCreeper = t;
                }
            }
        }

        // 1. Immediate swelling/point-blank creeper safety ALWAYS wins over everything except SHELTER stance!
        if (urgentCreeper != null) {
            boolean swelling = urgentCreeper.creeperSwelling() || urgentCreeper.creeperFuse() > 0.08f;
            if ((ctx.trapped() || ctx.bestRetreatScore() < 1.5 || urgentCreeper.creeperFuse() >= 0.45f)
                    && urgentCreeper.dist() < 5.2 && shieldUsable) {
                return TacticalAction.CREEPER_BLOCK;
            }
            if (swelling && urgentCreeper.dist() < 6.2) {
                if (ctx.trapped() && shieldUsable) return TacticalAction.CREEPER_BLOCK;
                if (ctx.trapped() && canShelter && urgentCreeper.creeperFuse() < 0.35f) {
                    return TacticalAction.EMERGENCY_SHELTER;
                }
                return TacticalAction.FLEE;
            }
            if (ctx.stance() != CombatStance.FLEE && ctx.weaponScore() >= 6.5
                    && ctx.health() >= 10.0f && !ctx.trapped() && urgentCreeper.dist() <= 4.4) {
                return TacticalAction.CREEPER_KITE;
            }
            if (ctx.trapped()) {
                if (shieldUsable) return TacticalAction.CREEPER_BLOCK;
                if (canShelter) return TacticalAction.EMERGENCY_SHELTER;
            }
            return TacticalAction.FLEE;
        }

        // 2. Explicit FLEE stance
        if (ctx.stance() == CombatStance.FLEE) {
            if (ctx.trapped() && canShelter) return TacticalAction.EMERGENCY_SHELTER;
            return TacticalAction.FLEE;
        }

        double pressure = threatPressure(threats);
        boolean underEquipped = ctx.weaponScore() < 6.5; // no sword or axe
        float effHealth = ctx.health() + ctx.armorPoints() * 0.25f;

        // 3. Autonomous fight vs flee vs emergency shelter evaluation
        boolean wantEscape;
        if (ctx.stance() == CombatStance.AGGRESSIVE) {
            wantEscape = ctx.health() <= 4.5f || (ctx.health() <= 7.0f && underEquipped && pressure >= 2.0);
        } else if (ctx.stance() == CombatStance.DEFENSIVE) {
            wantEscape = ctx.health() <= 10.5f
                || (underEquipped && pressure >= 1.2)
                || (pressure >= 2.3 && !shieldUsable);
        } else { // AUTO
            wantEscape = ctx.health() <= 7.5f
                || (ctx.health() <= 10.0f && (underEquipped || pressure >= 1.5 || !shieldUsable))
                || (ctx.health() <= 12.0f && underEquipped && pressure >= 1.2)
                || (pressure >= 3.2 && effHealth < 15.0f && !shieldUsable)
                || (primary.kind() == ThreatKind.BABY_ZOMBIE && primary.dist() < 6.5
                    && (ctx.health() <= 9.5f || (underEquipped && ctx.health() <= 13.5f)));
        }

        if (wantEscape) {
            if (canShelter) {
                boolean strongShelterCase = ctx.trapped()
                    || (ctx.health() <= 10.5f && (pressure >= 1.8 || (hasRanged && pressure >= 1.2) || (hasFast && underEquipped)));
                if (strongShelterCase) {
                    return TacticalAction.EMERGENCY_SHELTER;
                }
            }
            if (ctx.trapped() && shieldUsable && anyVisible) {
                return TacticalAction.SHIELD_HOLD;
            }
            return TacticalAction.FLEE;
        }

        // 4. All threats currently occluded behind cover -> cautious peek (never drop guard!)
        if (!anyVisible) {
            return TacticalAction.CAUTIOUS_PEEK;
        }

        // 5. Incoming arrow or ranged skeleton engagement with shield
        if (ctx.incomingArrow() && shieldUsable) {
            return TacticalAction.SHIELD_HOLD;
        }
        if (primary.kind().isRanged() && primary.dist() > 3.1 && shieldUsable) {
            return TacticalAction.SHIELD_ADVANCE;
        }

        return TacticalAction.FIGHT;
    }

    /**
     * Evaluate 16 compass bearings around the player using combat-flow nearest-surface observations
     * (within 4 blocks, stopping at the first solid barrier).
     * Avoids cliffs/drop-offs, hazards, walls, and backing into secondary hostiles.
     */
    static EscapeAssessment evaluateEscapeBearings(
        double px,
        int py,
        double pz,
        List<ThreatInfo> threats,
        CellProbe probe
    ) {
        // Compute threat-weighted escape vector away from ALL active threats
        double awayX = 0.0;
        double awayZ = 0.0;
        for (ThreatInfo t : threats) {
            double dx = px - t.x();
            double dz = pz - t.z();
            double d = Math.max(0.5, Math.hypot(dx, dz));
            double w = (t.kind() == ThreatKind.CREEPER ? 2.2 : 1.0) / (d * d);
            awayX += (dx / d) * w;
            awayZ += (dz / d) * w;
        }
        double awayLen = Math.hypot(awayX, awayZ);
        double awayAngle = awayLen > 1e-4 ? Math.atan2(awayZ, awayX) : 0.0;

        double bestScore = Double.NEGATIVE_INFINITY;
        double bestDirX = Math.cos(awayAngle);
        double bestDirZ = Math.sin(awayAngle);
        int openBearings = 0;

        // Evaluate 16 rays relative to awayAngle PLUS the 4 exact axis-aligned cardinals
        // so narrow 1-wide staircases and tunnels are never missed by slightly off-axis rays!
        for (int i = 0; i < 20; i++) {
            double ang = i < 16
                ? awayAngle + (i * Math.PI * 2.0 / 16.0)
                : ((i - 16) * Math.PI * 0.5);
            double dx = Math.cos(ang);
            double dz = Math.sin(ang);
            double awayDot = awayLen > 1e-4 ? (dx * awayX + dz * awayZ) / awayLen : 1.0;
            double score = awayDot * 6.0;

            int clearSteps = 0;
            int curY = py;
            boolean cliffOrHazard = false;

            for (int step = 1; step <= 4; step++) {
                double sx = px + dx * step;
                double sz = pz + dz * step;
                int bx = (int) Math.floor(sx);
                int bz = (int) Math.floor(sz);

                CellKind feet = probe.probe(bx, curY, bz);
                CellKind head = probe.probe(bx, curY + 1, bz);
                CellKind below = probe.probe(bx, curY - 1, bz);
                CellKind below2 = probe.probe(bx, curY - 2, bz);

                if (feet == CellKind.HAZARD || head == CellKind.HAZARD || below == CellKind.HAZARD) {
                    score -= 120.0;
                    cliffOrHazard = true;
                    break;
                }
                if (feet == CellKind.SOLID) {
                    // Check 1-block step-up
                    CellKind upHead = probe.probe(bx, curY + 2, bz);
                    if (head == CellKind.PASSABLE && upHead == CellKind.PASSABLE) {
                        score -= 1.2;
                        curY += 1;
                        clearSteps++;
                    } else {
                        score -= 22.0;
                        break;
                    }
                } else if (head == CellKind.SOLID) {
                    score -= 22.0;
                    break;
                } else if (below == CellKind.PASSABLE && below2 == CellKind.PASSABLE) {
                    // Drop-off >= 2 blocks (cliff/ravine)! Never back off a cliff!
                    score -= 70.0;
                    cliffOrHazard = true;
                    break;
                } else if (below == CellKind.PASSABLE && below2 == CellKind.SOLID) {
                    // Safe 1-block step-down
                    curY -= 1;
                    clearSteps++;
                } else if (below == CellKind.SOLID) {
                    clearSteps++;
                } else {
                    // Unobserved floor beyond first barrier — treat conservatively (do not assume safe)
                    score -= 10.0;
                    break;
                }

                // Penalize stepping close to ANY threat along this bearing (prevents backing into a second mob!)
                for (ThreatInfo t : threats) {
                    double td = Math.hypot(sx - t.x(), sz - t.z());
                    if (td < 2.6) {
                        score -= 36.0 / Math.max(0.6, td);
                    } else if (td < 4.5 && step >= 2) {
                        score -= 10.0 / td;
                    }
                }
            }

            score += clearSteps * 3.5;
            if (!cliffOrHazard && clearSteps >= 3 && awayDot > -0.15 && score > 4.0) {
                openBearings++;
            }
            if (score > bestScore) {
                bestScore = score;
                bestDirX = dx;
                bestDirZ = dz;
            }
        }

        boolean trapped = openBearings == 0 || bestScore < 2.0;
        return new EscapeAssessment(bestDirX, bestDirZ, bestScore, openBearings, trapped);
    }

    /**
     * Decide whether to seal around feet/corner (fastest when walls exist or plenty of blocks)
     * vs burrowing 3 blocks down + 1 overhead cap (uses only 1 block when blocks are scarce).
     */
    static ShelterMode chooseShelterMode(
        int px,
        int py,
        int pz,
        int scaffoldBlocks,
        boolean hasDigTool,
        boolean floorDiggable,
        CellProbe probe
    ) {
        if (scaffoldBlocks <= 0) return ShelterMode.NONE;

        int openWallSlots = 0;
        boolean hasRoofSupport = false;
        int[][] cardinals = {{1, 0}, {-1, 0}, {0, 1}, {0, -1}};
        for (int[] c : cardinals) {
            if (probe.probe(px + c[0], py, pz + c[1]) != CellKind.SOLID) openWallSlots++;
            if (probe.probe(px + c[0], py + 1, pz + c[1]) != CellKind.SOLID) openWallSlots++;
            if (probe.probe(px + c[0], py + 2, pz + c[1]) == CellKind.SOLID) hasRoofSupport = true;
        }
        int roofBlocks = probe.probe(px, py + 2, pz) == CellKind.SOLID ? 0 : (hasRoofSupport ? 1 : 2);
        int blocksNeededForBox = openWallSlots + roofBlocks;

        // If we already have walls around us (ravine/corner/niche) or enough blocks to box in quickly:
        if (scaffoldBlocks >= blocksNeededForBox && (blocksNeededForBox <= 6 || scaffoldBlocks >= 10)) {
            return ShelterMode.BOX_OR_CORNER;
        }
        if (floorDiggable && (hasDigTool || scaffoldBlocks < blocksNeededForBox)) {
            return ShelterMode.BURROW_DOWN;
        }
        if (scaffoldBlocks >= blocksNeededForBox) {
            return ShelterMode.BOX_OR_CORNER;
        }
        return floorDiggable ? ShelterMode.BURROW_DOWN : ShelterMode.NONE;
    }
}
