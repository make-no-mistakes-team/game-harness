import { expect, test } from "bun:test";
import { currentTaskText, stopControl, canRefreshModels } from "./operator-state.ts";

test("long custom task keeps meaningful wording while preserving full-task disclosure", () => {
  const task = "Return to the worksite with a second load.\n" + "Keep the collected items in the same chest. ".repeat(12);
  const result = currentTaskText(task, false);
  expect(result.excerpt).toStartWith("Return to the worksite with a second load. Keep the collected items");
  expect(result.excerpt.length).toBeLessThanOrEqual(145);
  expect(result.showFull).toBe(true);
  expect(currentTaskText(task, true)).toEqual({ excerpt: task, showFull: false });
});

test("Stop retry depends only on actual cleanup failure, not a previous provider error", () => {
  expect(stopControl("stopping", null)).toMatchObject({ retry: false, draining: true });
  expect(stopControl("stopping", "Emitter closure unconfirmed")).toMatchObject({ retry: true, draining: false });
  expect(stopControl("paused", null)).toMatchObject({ retry: false, draining: false });
});

test("same-account model refresh is available while paused but never implies Resume", () => {
  expect(canRefreshModels("paused")).toBe(true);
  expect(canRefreshModels("running")).toBe(false);
  expect(canRefreshModels("stopping")).toBe(false);
  expect(canRefreshModels("stopped")).toBe(true);
});
