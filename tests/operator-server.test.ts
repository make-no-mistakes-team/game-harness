import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AuthManager } from "../src/server/auth.ts";
import { Store } from "../src/server/store.ts";
import { Runtime } from "../src/server/runtime.ts";
import { GameBridgeClient } from "../src/server/game-bridge.ts";
import { MinecraftServer } from "../src/server/minecraft-server.ts";
import { SandboxService } from "../src/server/sandbox.ts";
import { JevBroker } from "../src/server/jev.ts";
import { PerformanceMonitor } from "../src/server/performance.ts";
import { OperatorPublication } from "../src/server/operator-publication.ts";
import { APP_ORIGIN } from "../src/server/config.ts";
import { createDefaultOperatorApplication, createOperatorApplication, OperatorChangeBus, type OperatorApplicationOwners } from "../src/server/index.ts";

const projectRoot = path.resolve(import.meta.dir, "..");

/** Real disconnected owners, empty app-owned auth, no initialization/model/native launch. */
async function fixture(changes = new OperatorChangeBus()) {
  const directory = mkdtempSync(path.join(tmpdir(), "gameharness-operator-owner-"));
  const cleanup: (() => void | Promise<void>)[] = [];
  const closeUntransferred = async () => {
    const failures: unknown[] = [];
    for (const close of cleanup.splice(0).reverse()) {
      try { await close(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Fixture owner closure is unconfirmed");
  };
  try {
    const store = new Store(directory); cleanup.push(() => store.close());
    const auth = await AuthManager.create(directory, changes.notify); cleanup.push(() => auth.close());
    const performanceMonitor = new PerformanceMonitor(); cleanup.push(() => performanceMonitor.close());
    const game = new GameBridgeClient(projectRoot); cleanup.push(() => game.close());
    const sandbox = new SandboxService(projectRoot, changes.notify); cleanup.push(() => sandbox.close());
    const minecraft = new MinecraftServer(changes.notify, (type, summary, details) => store.event(null, type, summary, details ?? null));
    cleanup.push(() => minecraft.close());
    const jev = await JevBroker.create(directory, { onChange: changes.notify }); cleanup.push(() => jev.close());
    const runtime = new Runtime(store, auth, game, sandbox, changes.notify, {
      experienceDirectory: directory, judge: jev, adapter: () => game.adapter(), actorFrames: game,
    });
    cleanup.push(() => runtime.close());
    const owners: OperatorApplicationOwners = { directory, projectRoot, port: 0, desktopNonce: null,
      changes, store, auth, performanceMonitor, game, sandbox, minecraft, jev, runtime };
    return { owners, closeUntransferred, removeDirectory() { rmSync(directory, { recursive: true, force: true }); } };
  } catch (error) {
    try { await closeUntransferred(); } finally { rmSync(directory, { recursive: true, force: true }); }
    throw error;
  }
}

function expectReaped(pid: number | null) {
  if (pid === null) return;
  let error: unknown;
  try { process.kill(pid, 0); } catch (failure) { error = failure; }
  expect(error).toMatchObject({ code: "ESRCH" });
}

test("bind failure drains its real publication child and exact subscriptions without taking caller-owned services", async () => {
  const f = await fixture();
  const occupied = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("occupied") });
  const closeServices = [f.owners.store, f.owners.auth, f.owners.runtime, f.owners.game, f.owners.minecraft,
    f.owners.sandbox, f.owners.jev, f.owners.performanceMonitor].map(owner => spyOn(owner, "close"));
  const external = () => {};
  f.owners.changes.listeners.add(external);
  const externalGame = f.owners.game.subscribe(() => {});
  const externalFrame = f.owners.game.subscribeFrames(() => {});
  const subscribe = f.owners.game.subscribe.bind(f.owners.game);
  const subscribeFrames = f.owners.game.subscribeFrames.bind(f.owners.game);
  let offGameCalls = 0, offFrameCalls = 0;
  const gameSubscriptions = spyOn(f.owners.game, "subscribe").mockImplementation(listener => {
    const off = subscribe(listener);
    return () => { offGameCalls++; off(); };
  });
  const frameSubscriptions = spyOn(f.owners.game, "subscribeFrames").mockImplementation(listener => {
    const off = subscribeFrames(listener);
    return () => { offFrameCalls++; off(); };
  });
  const closePublication = OperatorPublication.prototype.close;
  const drained: { pid: number | null; closed: boolean }[] = [];
  const publicationClosures = spyOn(OperatorPublication.prototype, "close").mockImplementation(async function (this: OperatorPublication) {
    const pid = this.snapshot().pid;
    await closePublication.call(this);
    drained.push({ pid, closed: this.snapshot().closed });
  });
  try {
    await expect(createOperatorApplication({ ...f.owners, port: occupied.port! })).rejects.toThrow();
    expect(drained).toHaveLength(1);
    expect(drained[0]!.closed).toBe(true);
    expectReaped(drained[0]!.pid);
    expect(offGameCalls).toBe(1);
    expect(offFrameCalls).toBe(1);
    expect(f.owners.changes.listeners).toEqual(new Set([external]));
    for (const close of closeServices) expect(close).not.toHaveBeenCalled();
    expect(f.owners.auth.snapshot().status).toBe("signed_out");
    expect(f.owners.store.runs()).toEqual([]);
  } finally {
    publicationClosures.mockRestore(); gameSubscriptions.mockRestore(); frameSubscriptions.mockRestore();
    for (const close of closeServices) close.mockRestore();
    externalGame(); externalFrame(); await occupied.stop(true);
    try { await f.closeUntransferred(); } finally { f.removeDirectory(); }
  }
});

test("invalid factory configuration leaves caller-owned concrete services and unrelated bus consumers intact", async () => {
  const f = await fixture();
  const external = () => {};
  f.owners.changes.listeners.add(external);
  writeFileSync(path.join(f.owners.directory, "motor-profile.json"), "not JSON");
  try {
    await expect(createOperatorApplication(f.owners)).rejects.toThrow();
    expect(f.owners.changes.listeners).toEqual(new Set([external]));
    expect(f.owners.auth.snapshot().status).toBe("signed_out");
    f.owners.store.event(null, "fixture.retained", "Caller retains the writable owner after rejected transfer");
    expect(f.owners.store.events().at(-1)?.type).toBe("fixture.retained");
  } finally { try { await f.closeUntransferred(); } finally { f.removeDirectory(); } }
});

test("partial default construction closes the actual Store when later empty-auth allocation fails", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "gameharness-default-owner-"));
  // A real filesystem allocation failure occurs after Store construction, before
  // AuthManager can return an owner. No credentials or native world are involved.
  writeFileSync(path.join(directory, "auth"), "not a directory");
  const closeStore = Store.prototype.close;
  let closures = 0;
  const closed = spyOn(Store.prototype, "close").mockImplementation(function (this: Store) { closures++; closeStore.call(this); });
  try {
    await expect(createDefaultOperatorApplication({ directory, projectRoot, port: 0, desktopNonce: null })).rejects.toThrow();
    expect(closures).toBe(1);
  } finally { closed.mockRestore(); rmSync(directory, { recursive: true, force: true }); }
});

test("late default bind failure joins every concrete default owner after local publication rollback", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "gameharness-default-bind-"));
  const occupied = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("occupied") });
  const closures = [Store.prototype, AuthManager.prototype, Runtime.prototype, GameBridgeClient.prototype,
    MinecraftServer.prototype, SandboxService.prototype, JevBroker.prototype, PerformanceMonitor.prototype,
    OperatorPublication.prototype].map(owner => spyOn(owner, "close"));
  try {
    await expect(createDefaultOperatorApplication({ directory, projectRoot, port: occupied.port!, desktopNonce: null })).rejects.toThrow();
    for (const close of closures) expect(close).toHaveBeenCalled();
  } finally {
    for (const close of closures) close.mockRestore();
    await occupied.stop(true); rmSync(directory, { recursive: true, force: true });
  }
});

test("parallel applications keep per-port Origin/session isolation and remove only their own shared-bus subscription", async () => {
  const changes = new OperatorChangeBus();
  let externalChanges = 0;
  const external = () => { externalChanges++; };
  changes.listeners.add(external);
  const [a, b] = await Promise.all([fixture(changes), fixture(changes)]);
  const originalOrigin = APP_ORIGIN;
  const created = await Promise.allSettled([createOperatorApplication(a.owners), createOperatorApplication(b.owners)]);
  const resultA = created[0]!, resultB = created[1]!;
  if (resultA.status !== "fulfilled" || resultB.status !== "fulfilled") {
    await Promise.all([
      resultA.status === "fulfilled" ? resultA.value.close() : a.closeUntransferred(),
      resultB.status === "fulfilled" ? resultB.value.close() : b.closeUntransferred(),
    ]);
    a.removeDirectory(); b.removeDirectory();
    throw new Error("Actual parallel application construction failed");
  }
  const appA = resultA.value, appB = resultB.value;
  const originA = `http://127.0.0.1:${appA.server.port}`, originB = `http://127.0.0.1:${appB.server.port}`;
  try {
    expect(APP_ORIGIN).toBe(originalOrigin);
    const sessionA = await fetch(originA + "/v1/session", { headers: { origin: originA } });
    const sessionB = await fetch(originB + "/v1/session", { headers: { origin: originB } });
    expect(sessionA.status).toBe(200); expect(sessionB.status).toBe(200);
    const cookieA = sessionA.headers.get("set-cookie")!.split(";")[0]!;
    const cookieB = sessionB.headers.get("set-cookie")!.split(";")[0]!;
    await sessionA.arrayBuffer(); await sessionB.arrayBuffer();
    expect((await fetch(originA + "/v1/session", { headers: { origin: originB } })).status).toBe(403);
    expect((await fetch(originB + "/v1/session", { headers: { origin: originA } })).status).toBe(403);
    expect((await fetch(originB + "/v1/config", { headers: { origin: originB, cookie: cookieA } })).status).toBe(401);
    expect((await fetch(originB + "/v1/config", { headers: { origin: originB, cookie: cookieB } })).status).toBe(200);
    expect(changes.listeners.size).toBe(3);
    await appA.close();
    expect(changes.listeners.size).toBe(2);
    expect(changes.listeners.has(external)).toBe(true);
    const before = externalChanges; changes.notify();
    expect(externalChanges).toBe(before + 1);
    expect((await fetch(originB + "/v1/config", { headers: { origin: originB, cookie: cookieB } })).status).toBe(200);
    await appB.close();
    expect(changes.listeners).toEqual(new Set([external]));
  } finally {
    await Promise.all([appA.close(), appB.close()]);
    a.removeDirectory(); b.removeDirectory();
  }
});
