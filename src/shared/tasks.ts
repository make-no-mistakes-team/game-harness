import { z } from "zod";

export const MAX_TASK_CHARACTERS = 4000;
export const taskTextSchema = z.string().trim().min(1).max(MAX_TASK_CHARACTERS);
