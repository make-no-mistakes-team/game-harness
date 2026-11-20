import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openOperatorStop, requestOperatorStop, serverSaveEvidence } from "../survival-agent/operator-stop.ts";

test("only a private request for the exact active owner can stop an ordinary run", async () => {
  const root = await mkdtemp(join(tmpdir(), "survival-operator-stop-"));
  const run = "2026-11-20T05-10-46.155Z-diamond-AbCd12";
  const other = "2026-11-20T05-10-46.155Z-diamond-EfGh34";
  const dir = join(root, "runs", run);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, "operator-stop-request"), run, { mode: 0o600 });
  const owner = await openOperatorStop(dir);
  try {
    const display = { display: ":100", authority: "/tmp/owned/Xauthority" };
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
