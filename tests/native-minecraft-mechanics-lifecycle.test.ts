import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mechanicalFixedFailures, pollMechanicalEffect, selectMechanicalProbeStages } from "../scripts/native-minecraft-mechanics.ts";

test("fixed mechanical acceptance rejects spinning, deadline waits and uncertain excavation", () => {
  const result = { status:"unknown" as const, summary:"Action deadline reached", evidence:{native_action_ms:5024,rotation_yaw_radians:17.3,world_effect_emitted:true} };
  expect(mechanicalFixedFailures("overhead", [{action:{kind:"navigate"},result}], 0).length).toBeGreaterThan(0);
  expect(mechanicalFixedFailures("blocked", [{action:{kind:"navigate"},result}], 0).length).toBeGreaterThan(0);
  expect(mechanicalFixedFailures("adjacent", [{action:{kind:"dig"},result}], 0).length).toBeGreaterThan(0);
});

test("fixed mechanical acceptance requires authoritative own removals and retained stone", () => {
  const dig = { action:{kind:"dig"}, result:{status:"succeeded" as const,summary:"Removed",evidence:{
    effect_confirmed:true,block_removed:true,source:"server_block_update",target_name:"stone",
  }} };
  expect(mechanicalFixedFailures("adjacent",[dig,dig],2)).toEqual([]);
  expect(mechanicalFixedFailures("adjacent",[dig,dig],1).length).toBeGreaterThan(0);
  expect(mechanicalFixedFailures("adjacent",[dig],2).length).toBeGreaterThan(0);
});

test("fixed approach acceptance requires reachable interaction receipt without a pirouette", () => {
  const result = { status:"succeeded" as const, summary:"Reached", evidence:{
    effect_confirmed:true,arrival_mode:"interaction",interaction_reachable:true,native_action_ms:100,rotation_yaw_radians:0,
  }};
  expect(mechanicalFixedFailures("overhead",[{action:{kind:"navigate"},result}],0)).toEqual([]);
  expect(mechanicalFixedFailures("overhead",[{action:{kind:"navigate"},result:{
    ...result,evidence:{...result.evidence,rotation_yaw_radians:Math.PI},
  }}],0).length).toBeGreaterThan(0);
});

test("fixed blocked acceptance preserves uncertain emitted movement instead of relabeling it failed", () => {
  const result = { status:"unknown" as const,summary:"No feasible route",evidence:{
    effect_confirmed:false,world_effect_emitted:true,navigation_stop_reason:"blocked",native_action_ms:800,
  }};
  expect(mechanicalFixedFailures("blocked",[{action:{kind:"navigate"},result}],0)).toEqual([]);
  expect(mechanicalFixedFailures("blocked",[{action:{kind:"navigate"},result:{...result,status:"failed"}}],0).length).toBeGreaterThan(0);
});

test("fixed default position negative requires full-3D nonarrival evidence", () => {
  const result = { status:"failed" as const,summary:"No useful progress",evidence:{
    effect_confirmed:false,world_effect_emitted:false,navigation_stop_reason:"no_progress",native_action_ms:1600,
    arrival_mode:"position",position_range:false,
  }};
  expect(mechanicalFixedFailures("position-overhead",[{action:{kind:"navigate"},result}],0)).toEqual([]);
  expect(mechanicalFixedFailures("position-overhead",[{action:{kind:"navigate"},result:{
    ...result,evidence:{...result.evidence,position_range:true},
  }}],0).length).toBeGreaterThan(0);
});

test("fixed replacement acceptance requires emitted-effect uncertainty without false own removal", () => {
  const result = { status:"unknown" as const,summary:"Target changed",evidence:{
    world_effect_emitted:true,effect_confirmed:false,block_removed:false,server_block_removed:false,
  }};
  expect(mechanicalFixedFailures("replacement",[{action:{kind:"dig"},result}],0)).toEqual([]);
  expect(mechanicalFixedFailures("replacement",[{action:{kind:"dig"},result:{
    ...result,status:"failed",evidence:{...result.evidence,world_effect_emitted:false},
  }}],0).length).toBeGreaterThan(0);
  expect(mechanicalFixedFailures("replacement",[{action:{kind:"dig"},result:{
    ...result,evidence:{...result.evidence,server_block_removed:true},
  }}],0).length).toBeGreaterThan(0);
});

test("fixed entity interaction negative requires rejection without movement or camera emission", () => {
  const result = {status:"failed" as const,summary:"Interaction arrival requires a block target",evidence:{
    effect_confirmed:false,world_effect_emitted:false,camera_changed:false,travel_distance:0,
  }};
  expect(mechanicalFixedFailures("entity-interaction",[{action:{kind:"navigate"},result}],0)).toEqual([]);
  expect(mechanicalFixedFailures("entity-interaction",[{action:{kind:"navigate"},result:{
    ...result,evidence:{...result.evidence,camera_changed:true},
  }}],0).length).toBeGreaterThan(0);
});

test("pickup recovery proof requires a no-effect refusal followed by confirmed fresh pickup", () => {
  const refused = { action:{kind:"navigate"}, result:{status:"failed" as const,summary:"Target replaced",evidence:{
    effect_confirmed:false,world_effect_emitted:false,camera_changed:false,neutralized:true,
  }} };
  const picked = { action:{kind:"navigate"}, result:{status:"succeeded" as const,summary:"Fresh item picked up",evidence:{
    effect_confirmed:true,pickup_inventory_gain:1,inventory_receipt_confirmed:true,
  }} };
  expect(mechanicalFixedFailures("pickup-recovery",[refused,picked],1)).toEqual([]);
  expect(mechanicalFixedFailures("pickup-recovery",[{...refused,result:{...refused.result,status:"unknown"}},picked],1))
    .toContain("Volatile pickup was not safely refused before effects");
  expect(mechanicalFixedFailures("pickup-recovery",[refused,picked],0))
    .toContain("Fresh pickup lacks authoritative retained consequence");
});

test("mechanics stage selection is explicit and follows canonical fixture order", () => {
  expect(selectMechanicalProbeStages(undefined)).toEqual(["overhead","overhead-dig","adjacent","dirt","blocked","replacement"]);
  expect(selectMechanicalProbeStages("dirt,overhead-dig,adjacent")).toEqual(["overhead-dig","adjacent","dirt"]);
  expect(selectMechanicalProbeStages("replacement-stale,position-overhead,unreachable-overhead")).toEqual(["position-overhead","unreachable-overhead","replacement-stale"]);
});

test("mechanics stage selection rejects unknown, empty and repeated stages", () => {
  for (const selection of ["","adjacent,","adjacent,adjacent","all","overhead,dig"]) {
    expect(() => selectMechanicalProbeStages(selection)).toThrow();
  }
});

test("mechanics polling overlaps the effect and joins its last observation before returning", async () => {
  const effect = Promise.withResolvers<string>(), sampled = Promise.withResolvers<void>(), lastPoll = Promise.withResolvers<void>();
  let calls = 0, returned = false;
  const work = pollMechanicalEffect(() => effect.promise, async () => {
    calls++;
    sampled.resolve();
    await lastPoll.promise;
  }, 0).then(value => { returned = true; return value; });
  await sampled.promise;
  effect.resolve("native receipt");
  await Promise.resolve();
  expect(returned).toBe(false);
  lastPoll.resolve();
  expect(await work).toBe("native receipt");
  expect(calls).toBe(1);
});

test("mechanics polling preserves late observation failure after the native effect drains", async () => {
  const effect = Promise.withResolvers<void>(), sampled = Promise.withResolvers<void>(), lastPoll = Promise.withResolvers<void>();
  const work = pollMechanicalEffect(() => effect.promise, async () => {
    sampled.resolve();
    await lastPoll.promise;
    throw new Error("late parent observation failure");
  }, 0);
  const outcome = work.catch(error => error);
  await sampled.promise;
  effect.resolve();
  lastPoll.resolve();
  expect(String(await outcome)).toContain("late parent observation failure");
});

test("mechanics observation failure does not abandon a still-owned effect", async () => {
  const effect = Promise.withResolvers<void>(), sampled = Promise.withResolvers<void>();
  let settled = false;
  const work = pollMechanicalEffect(() => effect.promise, async () => {
    sampled.resolve();
    throw new Error("parent observation failure");
  }, 0).catch(error => { settled = true; return error; });
  await sampled.promise;
  await Promise.resolve();
  expect(settled).toBe(false);
  effect.resolve();
  expect(String(await work)).toContain("parent observation failure");
});

test("mechanics polling retains both native and observation errors", async () => {
  const effect = Promise.withResolvers<void>(), sampled = Promise.withResolvers<void>();
  const work = pollMechanicalEffect(() => effect.promise, async () => {
    sampled.resolve();
    throw new Error("observation failure");
  }, 0).catch(error => error);
  await sampled.promise;
  effect.reject(new Error("native failure"));
  const error = await work;
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.errors.map(String)).toEqual(["Error: native failure","Error: observation failure"]);
});

for (const mode of ["recorder-failure", "evidence-failure", "startup-signal"]) {
  test(`mechanics proof ${mode} still initiates and joins every acquired owner`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gameharness-mechanics-close-"));
    const child = Bun.spawn([process.execPath, "--no-env-file", path.join(import.meta.dir, "helpers/mechanics-lifecycle.fixture.ts"), mode, root], { stdout:"pipe", stderr:"pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 13000);
    try {
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
      const ownership = JSON.parse(await readFile(path.join(root,"ownership.json"),"utf8"));
      expect({code,stderr,ownership}).toMatchObject({ code: mode === "startup-signal" ? 143 : 1, ownership: { native_closed:true } });
      if (mode !== "startup-signal") expect(ownership).toMatchObject({runtime_closed:true,sandbox_closed:true,store_closed:true});
    } finally { clearTimeout(timer); await rm(root,{recursive:true,force:true}); }
  }, 15000);
}
