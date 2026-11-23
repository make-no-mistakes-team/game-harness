export const MEMORY_BYTES = 32 * 1024;
export const MEMORY_CELLS = 1024;
export const OVERWORLD = "minecraft:overworld";
const FORAGING_CELLS = 96;

export type Cell = [number, number, number];
export type AgentMemory = {
  version: 1; dimension: typeof OVERWORLD; trail: Cell[]; dormant?: Cell[]; workbench?: Cell; furnace?: Cell;
  ownedWorkbench?: Cell; foragingExit?: Cell[];
};

export function isCell(value: unknown): value is Cell {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isInteger) &&
    Math.abs(value[0]) <= 30_000_000 && value[1] >= -64 && value[1] <= 320 &&
    Math.abs(value[2]) <= 30_000_000;
}

export function adjacentCells(a: Cell, b: Cell) {
  return Math.abs(a[1] - b[1]) <= 1 && Math.abs(a[0] - b[0]) + Math.abs(a[2] - b[2]) <= 1;
}

function validTrail(trail: unknown, limit: number, cardinal = false): trail is Cell[] {
  if (!Array.isArray(trail) || trail.length > limit) return false;
  const seen = new Set<string>();
  let previous: Cell | undefined;
  for (const cell of trail) {
    if (!isCell(cell) || previous && (!adjacentCells(previous, cell) ||
        cardinal && previous[0] === cell[0] && previous[2] === cell[2])) return false;
    const key = cell.join(",");
    if (seen.has(key)) return false;
    seen.add(key);
    previous = cell;
  }
  return true;
}

export function decodeAgentMemory(text: string): AgentMemory | null {
  if (Buffer.byteLength(text) > MEMORY_BYTES) return null;
  try {
    const value = JSON.parse(text);
    if (value?.version !== 1 || value?.dimension !== OVERWORLD || !validTrail(value.trail, MEMORY_CELLS) ||
        ("dormant" in value && !validTrail(value.dormant, MEMORY_CELLS - value.trail.length)) ||
        Object.keys(value).some((key) =>
          !["version", "dimension", "trail", "dormant", "workbench", "furnace", "ownedWorkbench", "foragingExit"].includes(key)) ||
        ("workbench" in value && !isCell(value.workbench)) || ("furnace" in value && !isCell(value.furnace)) ||
        ("ownedWorkbench" in value && !isCell(value.ownedWorkbench))) return null;
    if ("foragingExit" in value) {
      const available = MEMORY_CELLS - value.trail.length - (value.dormant?.length ?? 0);
      if (!validTrail(value.foragingExit, Math.min(FORAGING_CELLS, available), true) || value.foragingExit.length < 2)
        return null;
    }
    return value;
  } catch {
    return null;
  }
}
