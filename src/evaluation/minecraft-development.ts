import { z } from "zod";
import type { RuntimeAdapter } from "../shared/contracts.ts";
import { taskTextSchema } from "../shared/tasks.ts";
import type { MinecraftAcceptanceTask } from "./adapter-scenarios.ts";

/** Fresh-world development only, not an extension of registered study support. */
export const minecraftDevelopmentSchema = z.object({
  task: taskTextSchema,
  criterion: z.enum(["custom", "break_log", "collect_wood", "obtain_stone", "craft_crafting_table", "collect_and_craft_table", "craft_stone_pickaxe"]).default("custom"),
  seed: z.string().trim().min(1).max(100),
  start_description: z.string().trim().min(1).max(1000),
  reasoning: z.literal("low").optional(),
}).strict();
export type MinecraftDevelopmentDeclaration = z.infer<typeof minecraftDevelopmentSchema>;

export function developmentTask(declaration: MinecraftDevelopmentDeclaration, adapter: RuntimeAdapter): MinecraftAcceptanceTask {
  const checked = minecraftDevelopmentSchema.parse(declaration);
  const goal = adapter.goals.find(goal => goal.goal_id === checked.criterion);
  if (!goal || adapter.descriptor.game.id !== "minecraft") throw new Error("Development criterion must be registered by the actual Minecraft adapter");
  const choice = adapter.goalChoices?.find(choice => choice.goal.goal_id === goal.goal_id);
  return { id: "minecraft-development", prompt: checked.task, adapter_goal_id: goal.goal_id,
    verifier: goal.verifier ? { revision: goal.verifier.id, version: goal.verifier.version,
      description: choice?.prompt ?? "Explicit registered Minecraft criterion" } : null };
}
