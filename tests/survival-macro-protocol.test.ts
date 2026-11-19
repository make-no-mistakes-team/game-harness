import { expect, spyOn, test } from "bun:test";
import { link, mkdtemp, open, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MacroDirectory, MacroObservationRotating } from "../src/server/survival-macro/protocol.ts";

test.each([
  { count: 1, label: "A displaced observation is reopened from the canonical path" },
  { count: 2, label: "Repeated observation replacement defers instead of parsing a displaced snapshot" },
])("$label", async ({ count }) => {
    const directory = await mkdtemp(path.join(tmpdir(), "macro-snapshot-"));
    const current = path.join(directory, "observation.json");
    let ipc: MacroDirectory | undefined;
    let restore: (() => void) | undefined;
    try {
      const paths = [current, ...Array.from({ length: count }, (_, i) => path.join(directory, `observation.next-${i}`))];
      await Promise.all(paths.map((file, i) => writeFile(file, `{"tick":${10 + i}}\n`, { mode: 0o600 })));
      ipc = await MacroDirectory.open(directory);
      const probe = await open(current, "r");
      const prototype = Object.getPrototypeOf(probe) as Pick<FileHandle, "stat">;
      const descriptorStat = prototype.stat;
      const first = await probe.stat();
      await probe.close();

      const second = count > 1 ? await open(paths[1]!, "r") : null;
      const next = await second?.stat();
      await second?.close();
      const predecessors = next ? [first, next] : [first];
      let rotated = 0;
      const stat = spyOn(prototype, "stat").mockImplementation(async function (this: FileHandle, ...args: unknown[]) {
        const opened = await descriptorStat.call(this);
        const expected = predecessors[rotated];
        if (opened.ino === expected?.ino && opened.dev === expected.dev) {
          await rename(paths[++rotated]!, current);
        }
        return Reflect.apply(descriptorStat, this, args);
      } as typeof descriptorStat);
      restore = () => stat.mockRestore();

      if (count === 1) {
        expect(await ipc.read("observation.json", value => value)).toEqual({ tick: 11 });
      } else {
        await expect(ipc.read("observation.json", () => { throw new Error("A displaced snapshot must not be read."); }))
          .rejects.toBeInstanceOf(MacroObservationRotating);
        expect(await ipc.read("observation.json", value => value)).toEqual({ tick: 12 });
      }
      expect(rotated).toBe(count);
    } finally {
      restore?.();
      await ipc?.close();
      await rm(directory, { recursive: true, force: true });
    }
});

test("Stable multiply linked observations and receipts are still invalid IPC files", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "macro-snapshot-"));
  let ipc: MacroDirectory | undefined;
  try {
    const file = path.join(directory, "observation.json");
    await writeFile(file, '{"tick":10}\n', { mode: 0o600 });
    await link(file, path.join(directory, "receipt.json"));
    ipc = await MacroDirectory.open(directory);
    await expect(ipc.read("observation.json", value => value)).rejects.toThrow("Invalid macro IPC file: observation.json.");
    await expect(ipc.read("receipt.json", value => value)).rejects.toThrow("Invalid macro IPC file: receipt.json.");
  } finally {
    await ipc?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
