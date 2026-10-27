import type { GoalChoice } from "../../src/shared/contracts.ts";
import { taskTextSchema } from "../../src/shared/tasks.ts";

export interface TaskDraft { choice_id: string; task: string }

export function initialTaskDraft(choices: readonly GoalChoice[], previous?: TaskDraft): TaskDraft {
  const custom = choices.find(choice => choice.goal.goal_id === "custom" && choice.goal.verifier === null);
  if (!custom) throw new Error("The current adapter has no custom task entry");
  const selected = previous && choices.find(choice => choice.id === previous.choice_id);
  if (selected && (selected.id === custom.id || previous!.task === selected.prompt)) return { ...previous! };
  return { choice_id: custom.id, task: previous?.task ?? "" };
}

export function editTaskPrompt(task: string, choices: readonly GoalChoice[]): TaskDraft {
  const custom = initialTaskDraft(choices);
  return { ...custom, task };
}

export function selectTaskChoice(choice_id: string, task: string, choices: readonly GoalChoice[]): TaskDraft {
  const choice = choices.find(choice => choice.id === choice_id);
  if (!choice) throw new Error("Select a success check from the current adapter");
  return { choice_id, task: choice.goal.verifier === null ? task : choice.prompt };
}

export function taskSubmission(draft: TaskDraft, choices: readonly GoalChoice[]) {
  const bound = initialTaskDraft(choices, draft);
  const choice = choices.find(choice => choice.id === bound.choice_id)!;
  return { task: taskTextSchema.parse(bound.task), goal: choice.goal };
}
