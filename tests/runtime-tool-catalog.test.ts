import { expect, test } from "bun:test";
import { z } from "zod";
import type { ToolModule, ToolRole } from "../src/shared/tool-policy.ts";
import { runtimeToolCatalogue, runtimeToolDescriptor, runtimeToolDescriptors, type RuntimeToolName } from "../src/server/runtime-tool-catalog.ts";

const roles: ToolRole[] = ["ordinary", "authoring", "speculative", "review"];
const expected: Record<ToolRole, RuntimeToolName[]> = {
  ordinary: ["observe", "program_write", "program_edit", "program_submit", "program_run", "program_inspect", "program_review", "help", "task_finish", "reflex", "memory"],
  authoring: ["observe", "program_write", "program_edit", "program_inspect", "help"],
  speculative: ["observe", "program_write", "program_edit", "program_inspect", "help", "prepare_next"],
  review: ["observe", "program_write", "program_edit", "program_inspect", "program_review", "help"],
};

test("pure catalogue preserves exact role ordering and optional-module disclosure", () => {
  const moduleSelections: ToolModule[][] = [[], ["reflex"], ["memory"], ["reflex", "memory"]];
  for (const role of roles) for (const disclosed of moduleSelections) {
    const modules = new Set(disclosed);
    const catalogue = runtimeToolCatalogue(role, modules);
    expect(catalogue.map(entry => entry.name)).toEqual(expected[role].filter(name =>
      name !== "reflex" && name !== "memory" || modules.has(name)));
    expect([...modules]).toEqual(disclosed);
    expect(new Set(catalogue.map(entry => entry.name)).size).toBe(catalogue.length);
    expect(catalogue.every(entry => entry.description.length > 0)).toBe(true);
  }
});

test("SDK descriptors share catalogue schemas and exclusive host validation conventions", () => {
  const modules = new Set<ToolModule>(["reflex", "memory"]);
  for (const role of roles) {
    const catalogue = runtimeToolCatalogue(role, modules);
    const descriptors = runtimeToolDescriptors(role, modules);
    expect(descriptors).toEqual(catalogue.map(runtimeToolDescriptor));
    for (const [index, entry] of catalogue.entries()) {
      expect(descriptors[index]).toEqual({
        name: entry.name, label: entry.name, description: entry.description,
        intent: "omit", concurrency: "exclusive", strict: false, lenientArgValidation: true,
        parameters: z.toJSONSchema(entry.schema, { unrepresentable: "any", io: "input" }),
      });
      expect("execute" in descriptors[index]!).toBe(false);
    }
    expect(structuredClone(descriptors)).toEqual(descriptors);
  }
});

test("inactive authoring omits outcome reasons without removing descriptive card metadata", () => {
  const modules = new Set<ToolModule>();
  for (const role of roles) {
    const catalogue = runtimeToolCatalogue(role, modules);
    const inactive = role === "authoring" || role === "speculative";
    for (const name of ["program_write", "program_edit"] as const) {
      const entry = catalogue.find(entry => entry.name === name)!;
      const schema = z.toJSONSchema(entry.schema, { unrepresentable: "any", io: "input" });
      expect(Object.keys(schema.properties ?? {}).includes("reason")).toBe(!inactive);
      expect(schema.additionalProperties).toBe(false);
      if (inactive) expect(entry.schema.safeParse({ reason: "Not an admitted field" }).success).toBe(false);
      if (name === "program_write") {
        const card = schema.properties?.card;
        expect(card && typeof card === "object" && "properties" in card &&
          card.properties && Object.hasOwn(card.properties, "reason")).toBe(true);
      }
    }
  }
});

test("catalogue snapshots do not retain a mutable disclosure set", () => {
  const modules = new Set<ToolModule>(["reflex"]);
  const previous = runtimeToolDescriptors("ordinary", modules);
  modules.add("memory");
  expect(previous.some(entry => entry.name === "memory")).toBe(false);
  expect(runtimeToolDescriptors("ordinary", modules).some(entry => entry.name === "memory")).toBe(true);
  expect(runtimeToolCatalogue("ordinary", new Set()).map(entry => entry.name)).not.toContain("reflex");
});
