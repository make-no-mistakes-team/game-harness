import { expect, test } from "bun:test";
import type { GoalChoice } from "../../src/shared/contracts.ts";
import { initialTaskDraft, editTaskPrompt, selectTaskChoice, taskSubmission } from "./task-draft.ts";

const choices: GoalChoice[] = [
  { id: "break_log", label: "Break a log", prompt: "Break one log block.", goal: { adapter_id: "minecraft", goal_id: "break_log", parameters: {}, verifier: { id: "minecraft_block_removal_v2", version: 2 } } },
  { id: "collect_and_craft_table", label: "Collect and craft", prompt: "Collect wood and craft a crafting table.", goal: { adapter_id: "minecraft", goal_id: "collect_and_craft_table", parameters: {}, verifier: { id: "minecraft_collection_craft_v2", version: 2 } } },
  { id: "custom", label: "Custom", prompt: "Describe your task.", goal: { adapter_id: "minecraft", goal_id: "custom", parameters: {}, verifier: null } },
];

test("fresh natural-language entry submits custom regardless of catalog order", () => {
  const initial = initialTaskDraft(choices);
  expect(initial).toEqual({ choice_id: "custom", task: "" });
  const request = taskSubmission(editTaskPrompt("Make a stone pickaxe from the resources around you.", choices), choices);
  expect(request.task).toBe("Make a stone pickaxe from the resources around you.");
  expect(request.goal).toEqual(choices[2]!.goal);
});

test("editing a preset clears its early stop even when the text is later restored", () => {
  const preset = selectTaskChoice("break_log", "", choices);
  const edited = editTaskPrompt(preset.task + " Then craft a table and a pickaxe.", choices);
  expect(edited.choice_id).toBe("custom");
  expect(taskSubmission(edited, choices).goal.verifier).toBeNull();
  expect(taskSubmission(editTaskPrompt(preset.task, choices), choices).goal.verifier).toBeNull();
});

test("explicit preset selection replaces an unrelated prompt and retains the matching criterion", () => {
  const draft = selectTaskChoice("collect_and_craft_table", "Make a stone pickaxe.", choices);
  expect(taskSubmission(draft, choices)).toEqual({ task: choices[1]!.prompt, goal: choices[1]!.goal });
  expect(selectTaskChoice("custom", draft.task, choices).task).toBe(draft.task);
});

test("a stale preset association cannot submit a different task with an early-stop verifier", () => {
  const request = taskSubmission({ choice_id: "break_log", task: "Collect wood and craft a crafting table." }, choices);
  expect(request.goal.verifier).toBeNull();
  expect(initialTaskDraft(choices, { choice_id: "break_log", task: request.task }).choice_id).toBe("custom");
});

test("task boundaries accept trimmed one-character and 4000-character tasks, reject empty and oversized tasks", () => {
  expect(taskSubmission(editTaskPrompt(" x ", choices), choices).task).toBe("x");
  expect(taskSubmission(editTaskPrompt("x".repeat(4000), choices), choices).task).toHaveLength(4000);
  expect(() => taskSubmission(editTaskPrompt("   ", choices), choices)).toThrow();
  expect(() => taskSubmission(editTaskPrompt("x".repeat(4001), choices), choices)).toThrow();
});

test("catalog refresh preserves custom text but refuses missing custom authority", () => {
  const draft = editTaskPrompt("Build something useful.", choices);
  expect(initialTaskDraft(choices, draft)).toEqual(draft);
  expect(() => taskSubmission(draft, choices.slice(0, 2))).toThrow();
});
