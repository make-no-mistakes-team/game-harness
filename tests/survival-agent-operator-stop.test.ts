import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openOperatorStop, readOrdinaryLiveRun, requestOperatorStop, serverSaveEvidence } from "../src/agent/operator-stop.ts";

test("only a private request for the exact active owner can stop an ordinary run", async () => {
  const root = await mkdtemp(join(tmpdir(), "survival-operator-stop-"));
  const run = "2026-11-20T05-10-46.155Z-diamond-AbCd12";
  const other = "2026-11-20T05-10-46.155Z-diamond-EfGh34";
  const dir = join(root, "runs", run);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, "operator-stop-request"), run, { mode: 0o600 });
  const display = { display: ":100", authority: join(root, "Xauthority") };
  await writeFile(display.authority, "cookie", { mode: 0o600 });
  const owner = await openOperatorStop(dir, { ...display, slot: "primary" });
  try {
    const descriptor = { active: true, run, ...display, operatorStop: owner.scope };
    const live = join(root, "live.json");
    await writeFile(live, JSON.stringify(descriptor), { mode: 0o600 });
    expect(await owner.requested()).toBe(false);
    expect(await requestOperatorStop(root, { run: other })).toBeNull();
    expect(await requestOperatorStop(root, { ...display, authority: "/tmp/other/Xauthority" })).toBeNull();

    const request = join(dir, `operator-stop-${owner.scope.token}`);
    await writeFile(request, other, { mode: 0o600 });
    expect(await owner.requested()).toBe(false);
    await rm(request);
    await symlink(join(dir, "operator-stop-request"), request);
    expect(await owner.requested()).toBe(false);
    await rm(request);
    await writeFile(request, run, { mode: 0o600 });
    await chmod(request, 0o644);
    expect(await owner.requested()).toBe(false);
    await rm(request);

    const displaced = `${dir}-displaced`;
    await rename(dir, displaced);
    await mkdir(dir, { mode: 0o700 });
    await writeFile(request, run, { mode: 0o600 });
    expect(await requestOperatorStop(root, { run })).toBeNull();
    expect(await owner.requested()).toBe(false);
    await rm(dir, { recursive: true });
    await rename(displaced, dir);

    const alias = join(root, "runs", other);
    await rename(dir, alias);
    await writeFile(live, JSON.stringify({ ...descriptor, run: other }));
    expect(await readOrdinaryLiveRun(root, "primary")).toBeNull();
    expect(await requestOperatorStop(root, { run: other })).toBeNull();
    await rename(alias, dir);

    await writeFile(live, JSON.stringify({ ...descriptor, active: false }));
    expect(await requestOperatorStop(root, { run })).toBeNull();
    expect(await owner.requested()).toBe(false);
    await writeFile(live, JSON.stringify(descriptor));
    expect(await requestOperatorStop(root, { run })).toBe(run);
    expect(await owner.requested()).toBe(true);
    await rm(request);
    expect(await requestOperatorStop(root, display)).toBe(run);
    expect(await owner.requested()).toBe(true);
  } finally {
    await owner.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("two live ordinary runs receive only their own basename stop requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "survival-operator-stop-"));
  const primaryRun = "2026-11-20T05-10-46.155Z-diamond-AbCd12";
  const parallelRun = "2026-11-20T05-10-46.155Z-nether_portal-EfGh34";
  const primaryDir = join(root, "runs", primaryRun);
  const parallelDir = join(root, "runs", parallelRun);
  const primaryDisplay = { display: ":100", authority: join(root, "primary.Xauthority") };
  const parallelDisplay = { display: ":101", authority: join(root, "parallel.Xauthority") };
  await mkdir(primaryDir, { recursive: true, mode: 0o700 });
  await mkdir(parallelDir, { mode: 0o700 });
  await writeFile(primaryDisplay.authority, "primary cookie", { mode: 0o600 });
  await writeFile(parallelDisplay.authority, "parallel cookie", { mode: 0o600 });
  const primary = await openOperatorStop(primaryDir, { ...primaryDisplay, slot: "primary" });
  try {
    const parallel = await openOperatorStop(parallelDir, { ...parallelDisplay, slot: "parallel" });
    try {
      const primaryFile = join(root, "live.json");
      const parallelFile = join(root, "parallel-live.json");
      const primaryLive = { active: true, run: primaryRun, ...primaryDisplay, operatorStop: primary.scope };
      const parallelLive = { active: true, run: parallelRun, ...parallelDisplay, operatorStop: parallel.scope };
      await writeFile(primaryFile, JSON.stringify(primaryLive), { mode: 0o600 });
      await writeFile(parallelFile, JSON.stringify(parallelLive), { mode: 0o600 });
      expect(await readOrdinaryLiveRun(root, "primary")).toMatchObject({ run: primaryRun, ...primaryDisplay });
      expect(await readOrdinaryLiveRun(root, "parallel")).toMatchObject({ run: parallelRun, ...parallelDisplay });

      expect(await requestOperatorStop(root, parallelDisplay)).toBeNull();
      expect(await requestOperatorStop(root, { run: parallelRun })).toBe(parallelRun);
      expect(await parallel.requested()).toBe(true);
      expect(await primary.requested()).toBe(false);
      await rm(join(parallelDir, `operator-stop-${parallel.scope.token}`));

      expect(await requestOperatorStop(root, { run: primaryRun })).toBe(primaryRun);
      expect(await primary.requested()).toBe(true);
      expect(await parallel.requested()).toBe(false);
      await rm(join(primaryDir, `operator-stop-${primary.scope.token}`));

      await writeFile(primaryFile, JSON.stringify(parallelLive));
      expect(await readOrdinaryLiveRun(root, "primary")).toBeNull();
      expect(await requestOperatorStop(root, { run: parallelRun })).toBeNull();
      await writeFile(primaryFile, JSON.stringify(primaryLive));
      await writeFile(parallelFile, JSON.stringify({ ...parallelLive, ...primaryDisplay }));
      expect(await readOrdinaryLiveRun(root, "parallel")).toBeNull();
      expect(await requestOperatorStop(root, { run: parallelRun })).toBeNull();
      await writeFile(parallelFile, JSON.stringify({
        ...parallelLive, operatorStop: { ...parallel.scope, token: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa" },
      }));
      expect(await readOrdinaryLiveRun(root, "parallel")).toBeNull();
      expect(await requestOperatorStop(root, { run: parallelRun })).toBeNull();
      await writeFile(parallelFile, JSON.stringify(parallelLive));
      await chmod(parallelFile, 0o644);
      expect(await readOrdinaryLiveRun(root, "parallel")).toBeNull();
      expect(await requestOperatorStop(root, { run: parallelRun })).toBeNull();
      await chmod(parallelFile, 0o600);
      await rename(parallelDisplay.authority, `${parallelDisplay.authority}.previous`);
      await writeFile(parallelDisplay.authority, "replacement cookie", { mode: 0o600 });
      expect(await readOrdinaryLiveRun(root, "parallel")).toBeNull();
      expect(await requestOperatorStop(root, { run: parallelRun })).toBeNull();
      expect(await primary.requested()).toBe(false);
      expect(await parallel.requested()).toBe(false);
    } finally { await parallel.close(); }
  } finally {
    await primary.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("operator stop does not report a saved world without an observed unforced server close", () => {
  const clean = { exit: { code: 0, signal: null } };
  const saved = { dimensionsSaved: true, escalation: null };
  expect(serverSaveEvidence(undefined, null)).toBeNull();
  expect(serverSaveEvidence({}, saved)).toBe(false);
  expect(serverSaveEvidence(clean, null)).toBe(false);
  expect(serverSaveEvidence(clean, { ...saved, dimensionsSaved: false })).toBe(false);
  expect(serverSaveEvidence(clean, { ...saved, escalation: "SIGTERM" })).toBe(false);
  expect(serverSaveEvidence({ exit: { code: null, signal: "SIGTERM" } }, saved)).toBe(false);
  expect(serverSaveEvidence(clean, saved)).toBe(true);
});
