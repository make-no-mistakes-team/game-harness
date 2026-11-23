import { expect, test } from "bun:test";
import { decodeAgentMemory } from "../survival-agent/agent-memory.ts";

const base = { version: 1, dimension: "minecraft:overworld", trail: [] };
const exit = [[-15, 27, -34], [-15, 28, -33], [-14, 28, -33]];

test("ordinary continuation accepts one simple exit leading from walked treads to foraging ground", () => {
  const value = { ...base, foragingExit: exit };
  expect(decodeAgentMemory(JSON.stringify(value))).toEqual(value);
  expect(decodeAgentMemory(JSON.stringify(base))).toEqual(base);
});

test("an exit memory cannot bridge a discontinuity or be used in another dimension", () => {
  for (const foragingExit of [
    [exit[0], exit[2]],
    [exit[0], [-15, 28, -34]],
    [...exit, exit[1]],
    [exit[0]],
  ]) expect(decodeAgentMemory(JSON.stringify({ ...base, foragingExit }))).toBeNull();

  expect(decodeAgentMemory(JSON.stringify({
    ...base, dimension: "minecraft:the_nether", foragingExit: exit,
  }))).toBeNull();
});

test("exit memory shares the native cell and byte limits", () => {
  const cells = (n: number) => Array.from({ length: n }, (_, x) => [x, 27, -34]);
  expect(decodeAgentMemory(JSON.stringify({ ...base, foragingExit: cells(97) }))).toBeNull();
  expect(decodeAgentMemory(JSON.stringify({ ...base, trail: cells(1022), foragingExit: exit }))).toBeNull();
  expect(decodeAgentMemory(`${JSON.stringify({ ...base, foragingExit: exit })}${" ".repeat(32_768)}`)).toBeNull();
});
