package io.gameharness.nativeclient;

/** Closed-voxel supercover gate. Unknown/unloaded and every intervening non-air voxel block. */
public final class VoxelVisibility {
  @FunctionalInterface
  public interface Cells {
    int state(int x, int y, int z);
  }

  private final int[] seenX = new int[128], seenY = new int[128], seenZ = new int[128];
  private int count, targetX, targetY, targetZ;
  private Cells cells;

  private boolean visit(int x, int y, int z) {
    for (int i = 0; i < count; i++)
      if (seenX[i] == x && seenY[i] == y && seenZ[i] == z) return true;
    if (count == 128) return false;
    seenX[count] = x;
    seenY[count] = y;
    seenZ[count++] = z;
    int state = cells.state(x, y, z);
    return state >= 0 && (state == 0 || x == targetX && y == targetY && z == targetZ);
  }

  public boolean clear(
      double sx,
      double sy,
      double sz,
      double ex,
      double ey,
      double ez,
      int tx,
      int ty,
      int tz,
      Cells cells) {
    if (!Double.isFinite(sx + sy + sz + ex + ey + ez)) return false;
    count = 0;
    this.cells = cells;
    targetX = tx;
    targetY = ty;
    targetZ = tz;
    int fx = (int) Math.floor(sx), fy = (int) Math.floor(sy), fz = (int) Math.floor(sz);
    boolean bx = sx == fx, by = sy == fy, bz = sz == fz;
    for (int x = bx ? -1 : 0; x <= 0; x++)
      for (int y = by ? -1 : 0; y <= 0; y++)
        for (int z = bz ? -1 : 0; z <= 0; z++) if (!visit(fx + x, fy + y, fz + z)) return false;
    double dx = ex - sx, dy = ey - sy, dz = ez - sz;
    int stepX = Double.compare(dx, 0), stepY = Double.compare(dy, 0), stepZ = Double.compare(dz, 0);
    int x = fx + (bx && stepX < 0 ? -1 : 0),
        y = fy + (by && stepY < 0 ? -1 : 0),
        z = fz + (bz && stepZ < 0 ? -1 : 0);
    boolean planeX = stepX == 0 && bx, planeY = stepY == 0 && by, planeZ = stepZ == 0 && bz;
    for (int event = 0; event < 128; event++) {
      double nx = stepX == 0 ? Double.POSITIVE_INFINITY : ((stepX > 0 ? x + 1 : x) - sx) / dx;
      double ny = stepY == 0 ? Double.POSITIVE_INFINITY : ((stepY > 0 ? y + 1 : y) - sy) / dy;
      double nz = stepZ == 0 ? Double.POSITIVE_INFINITY : ((stepZ > 0 ? z + 1 : z) - sz) / dz;
      double next = Math.min(nx, Math.min(ny, nz));
      if (next > 1) return true;
      boolean crossX = Math.abs(nx - next) < 1e-12,
          crossY = Math.abs(ny - next) < 1e-12,
          crossZ = Math.abs(nz - next) < 1e-12;
      // All cells touching a simultaneous edge/corner, including coplanar boundary neighbors.
      int minX = planeX ? x - 1 : crossX ? Math.min(x, x + stepX) : x,
          maxX = crossX ? Math.max(x, x + stepX) : x;
      int minY = planeY ? y - 1 : crossY ? Math.min(y, y + stepY) : y,
          maxY = crossY ? Math.max(y, y + stepY) : y;
      int minZ = planeZ ? z - 1 : crossZ ? Math.min(z, z + stepZ) : z,
          maxZ = crossZ ? Math.max(z, z + stepZ) : z;
      for (int vx = minX; vx <= maxX; vx++)
        for (int vy = minY; vy <= maxY; vy++)
          for (int vz = minZ; vz <= maxZ; vz++) if (!visit(vx, vy, vz)) return false;
      if (next >= 1) return true;
      if (crossX) x += stepX;
      if (crossY) y += stepY;
      if (crossZ) z += stepZ;
    }
    return false;
  }
}
