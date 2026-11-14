import { expect, test } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import { CognitionWire } from "../src/server/cognition-wire.ts";
import { deferred, eventLoopTurn } from "./helpers/cognition-process.fixture.ts";

test("closed wire drain joins failed write callbacks without converting unknown delivery into success", async () => {
  const input = new PassThrough(), entered = deferred();
  let callback: ((error?: Error | null) => void) | undefined;
  const output = new Writable({ write(_chunk, _encoding, done) { callback = done; entered.resolve(); } });
  const wire = new CognitionWire(input, output, () => null, () => {});
  const operation = wire.call("owned_operation", { value: 1 }).then(() => "delivered", () => "unknown_delivery");
  await entered.promise;
  input.end(); await wire.ended;
  let drained = false;
  const joining = wire.drain().then(() => { drained = true; });
  await eventLoopTurn();
  expect(drained).toBe(false);
  callback!(new Error("Fixture pipe closed before delivery could be confirmed"));
  await joining;
  expect(await operation).toBe("unknown_delivery");
  expect(drained).toBe(true);
  await expect(wire.flush()).rejects.toThrow("Cognition transport unavailable");
  output.destroy();
});
