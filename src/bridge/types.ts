import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import type { Block } from "prismarine-block";

/** Runtime fields installed by the pinned Mineflayer entity/physics plugins but omitted upstream. */
export type PlayerEntity = Entity & { eyeHeight: number; isInWater: boolean };
export type BridgeBot = Omit<Bot, "entity"> & {
  entity: PlayerEntity;
  jumpQueued: boolean;
};
export type GeometryBlock = Block & { missingStateShape?: boolean };
