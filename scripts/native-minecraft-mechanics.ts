import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as postmortem from "@oh-my-pi/pi-utils/postmortem";
import type { Agent } from "@oh-my-pi/pi-agent-core/agent";
import type { AgentTool } from "@oh-my-pi/pi-agent-core/types";
import type { AuthManager } from "../src/server/auth.ts";
import type { Runtime } from "../src/server/runtime.ts";
import type { Store } from "../src/server/store.ts";
import type { SandboxService } from "../src/server/sandbox.ts";
import type { GameAction, GameActionResult } from "../src/shared/contracts.ts";
import { gameActionSchema } from "../src/shared/validation.ts";
import { targetRefSchema } from "../src/shared/control.ts";
import type { TargetRef } from "../src/shared/control.ts";
import { NativeFixture, bounded, evidence, pause, requireProof, until } from "../src/evaluation/native-game.ts";
import { DiagnosticModelHooks } from "../src/evaluation/diagnostic-model-hooks.ts";
import { createEvaluationCaps } from "../src/evaluation/config.ts";
import { assertNativeArtifactFresh, requireTierOptIn } from "../src/evaluation/tiers.ts";
import { NATURAL_SCENARIOS, captureScenarioVerification, verifyScenarioCompletion } from "../src/evaluation/adapter-scenarios.ts";
import { EpisodeRecorder } from "../src/server/recording.ts";

const mechanicalProbeStages = ["overhead", "overhead-dig", "adjacent", "dirt", "blocked", "replacement"] as const;
const recoveryProbeStages = ["ascent", "headroom", "excavation", "placement-collision", "placement-corner", "placement-face", "placement-adjacent", "navigation-envelope"] as const;
const fixedMechanicalProbeStages = ["overhead", "overhead-dig", "position-overhead", "unreachable-overhead", "entity-interaction", "adjacent", "dirt", "blocked", "replacement", "replacement-stale", "pickup-recovery", ...recoveryProbeStages] as const;
type ProbeStage = (typeof fixedMechanicalProbeStages)[number];
export function selectMechanicalProbeStages(selection: string | undefined): readonly ProbeStage[] {
  if (selection === undefined) return mechanicalProbeStages;
  const requested = selection.split(",");
  requireProof(requested.length > 0 && new Set(requested).size === requested.length &&
    requested.every(stage => fixedMechanicalProbeStages.some(known => known === stage)),
    "Pass --stages <comma-separated probe stage names>, without duplicates");
  return fixedMechanicalProbeStages.filter(stage => requested.includes(stage));
}

/** Evaluator-only receipt checks. Unknown emitted effects are never called failures
 * merely to satisfy an early-navigation-stop assertion. */
export function mechanicalFixedFailures(stage: ProbeStage, effects: readonly { action: { kind: string }; result?: GameActionResult }[], cobblestone: number): string[] {
  const failures: string[] = [];
  const navigations = effects.filter(effect => effect.action.kind==="navigate");
  const digs = effects.filter(effect => effect.action.kind==="dig");
  if (stage==="overhead") {
    const result = navigations[0]?.result, detail = result ? evidence(result) : {};
    if (navigations.length!==1 || result?.status!=="succeeded" || detail.effect_confirmed!==true ||
      detail.arrival_mode!=="interaction" || detail.interaction_reachable!==true)
      failures.push("Overhead interaction approach lacks confirmed reachable arrival");
    if (typeof detail.native_action_ms!=="number" || detail.native_action_ms>2500) failures.push("Overhead interaction approach exceeded 2500ms");
    if (typeof detail.rotation_yaw_radians!=="number" || detail.rotation_yaw_radians>=Math.PI) failures.push("Overhead interaction approach turned through pi or more");
  }
  if (stage==="blocked" || stage==="position-overhead" || stage==="unreachable-overhead") {
    const result = navigations[0]?.result, detail = result ? evidence(result) : {};
    if (navigations.length!==1 || result?.status==="succeeded" || detail.effect_confirmed===true) failures.push("Unreachable travel falsely confirmed arrival");
    if (typeof detail.native_action_ms!=="number" || detail.native_action_ms>2500 ||
      !["blocked","no_progress"].includes(String(detail.navigation_stop_reason))) failures.push("Unreachable travel lacks bounded actionable route feedback");
    if (detail.world_effect_emitted===true && result?.status!=="unknown") failures.push("Unconfirmed emitted travel was downgraded from unknown");
    if (stage==="position-overhead" && (detail.arrival_mode!=="position" || detail.position_range!==false)) failures.push("Default full-3D position semantics were not retained");
    if (stage==="unreachable-overhead" && (detail.arrival_mode!=="interaction" || detail.interaction_reachable!==false)) failures.push("Out-of-reach overhead target lacks an explicit unreachable interaction receipt");
  }
  if (stage==="overhead-dig" || stage==="adjacent" || stage==="dirt") {
    const expected = stage==="overhead-dig" ? 1 : 2;
    if (digs.length!==expected || digs.some(effect => {
      const detail = effect.result ? evidence(effect.result) : {};
      return effect.result?.status!=="succeeded" || detail.effect_confirmed!==true ||
        detail.block_removed!==true || detail.source!=="server_block_update" ||
        (stage==="adjacent" && detail.target_name!=="stone");
    })) failures.push("Expected native server-confirmed own block removals are missing");
    if (stage==="adjacent" && cobblestone<2) failures.push("Two excavated stone gains are not retained as cobblestone");
  }
  if (stage==="replacement") {
    const result = digs[0]?.result, detail = result ? evidence(result) : {};
    if (digs.length!==1 || result?.status!=="unknown" || detail.world_effect_emitted!==true ||
      detail.effect_confirmed!==false || detail.block_removed===true || detail.server_block_removed!==false)
      failures.push("Actual replacement after emitted digging lacks uncertainty or falsely confirms own removal");
  }
  if (stage==="entity-interaction") {
    const result = navigations[0]?.result, detail = result ? evidence(result) : {};
    if (navigations.length!==1 || result?.status!=="failed" || detail.effect_confirmed!==false ||
      detail.world_effect_emitted!==false || detail.camera_changed!==false || detail.travel_distance!==0)
      failures.push("Entity interaction arrival was not rejected before movement/camera emission");
  }
  if (stage==="pickup-recovery") {
    const refused = navigations[0]?.result, refusal = refused ? evidence(refused) : {};
    const picked = navigations[1]?.result, pickup = picked ? evidence(picked) : {};
    if (navigations.length!==2 || refused?.status!=="failed" || refusal.world_effect_emitted!==false ||
        refusal.camera_changed!==false || refusal.neutralized!==true)
      failures.push("Volatile pickup was not safely refused before effects");
    if (picked?.status!=="succeeded" || pickup.effect_confirmed!==true ||
        pickup.inventory_receipt_confirmed!==true || typeof pickup.pickup_inventory_gain!=="number" ||
        pickup.pickup_inventory_gain<1 || cobblestone<1)
      failures.push("Fresh pickup lacks authoritative retained consequence");
  }
  return failures;
}

/** Parent-side observations deliberately run outside the worker's sequential game API.
 * Both owners are joined, including a poll that fails after the native receipt. */
export async function pollMechanicalEffect<T>(perform: () => Promise<T>, sample: () => Promise<void>, intervalMs = 50): Promise<T> {
  let settled = false;
  const effect = perform().then(
    value => ({ ok: true as const, value }),
    error => ({ ok: false as const, error }),
  ).finally(() => { settled = true; });
  let pollingError: unknown;
  const polling = (async () => {
    try {
      while (!settled) {
        await sample();
        if (!settled) await pause(intervalMs);
      }
    } catch (error) { pollingError = error; }
  })();
  const outcome = await effect;
  await polling;
  if (!outcome.ok && pollingError) throw new AggregateError([outcome.error, pollingError], "Native effect and parent observation failed");
  if (pollingError) throw pollingError;
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

const approachSource = `
const receipts = [], observations = [];
const observe = async () => { const o = await game.observe(); observations.push(o); return o; };
const act = async a => { const r = await game.action(a); receipts.push({action:a,result:r}); return r; };
const at = (o,x,y,z) => o.data.blocks.find(b => b.current && b.position.x===x+.5 && b.position.y===y+.5 && b.position.z===z+.5);
const target = async (x,y,z) => {
  const o = await observe(), b = at(o,x,y,z);
  if (!b) throw new Error("Prepared probe target not projected: "+JSON.stringify({x,y,z,observation:o}));
  return b;
};
if (args.stage==="overhead") {
  const b = await target(0,242,2);
  await act({kind:"navigate",target:b.target,range:2.5,duration_ms:5000,...(args.fixed?{arrival:"interaction"}:{})});
} else if (args.stage==="position-overhead") {
  const b = await target(0,243,2);
  await act({kind:"navigate",target:b.target,range:2.5,duration_ms:5000});
} else if (args.stage==="unreachable-overhead") {
  const b = await target(0,247,0);
  await act({kind:"navigate",target:b.target,range:4,duration_ms:5000,arrival:"interaction"});
} else if (args.stage==="entity-interaction") {
  const o = await observe(), pig = o.data.entities.find(e=>e.current&&e.name==="pig");
  if (!pig) throw new Error("Prepared pig was not observable");
  await act({kind:"navigate",target:pig.target,range:2.5,duration_ms:5000,arrival:"interaction"});
} else if (args.stage==="overhead-dig") {
  const fresh = await target(0,242,2);
  await act({kind:"dig",target:fresh.target});
} else if (args.stage==="adjacent" || args.stage==="dirt") {
  if (args.stage==="adjacent") await act({kind:"equip",item:"wooden_pickaxe",destination:"hand"});
  for (const x of [0,1]) {
    const b = await target(x,240,2);
    await act({kind:"dig",target:b.target});
  }
  // Pickup is separately disclosed; failed or unknown digs are never replayed.
  let o = await observe();
  const drop = o.data.entities.find(e=>e.current&&(e.item_name==="cobblestone"||e.item_name==="minecraft:cobblestone"));
  if (drop) await act({kind:"navigate",target:drop.target,range:0.5,duration_ms:3000});
} else if (args.stage==="blocked") {
  const b = await target(4,240,0);
  await act({kind:"navigate",target:b.target,range:1.5,duration_ms:5000});
} else if (args.stage==="replacement") {
  const b = await target(0,240,2);
  await act({kind:"dig",target:b.target});
} else if (args.stage==="replacement-stale") {
  const attempts = [];
  try { attempts.push({result:await act({kind:"dig",target:args.old_target})}); }
  catch (error) { attempts.push({error:String(error)}); }
  const o = await observe();
  return {status:"completed",summary:"Fresh action on replaced old handle attempted; no replay",result:{stage:args.stage,attempts,receipts,observations}};
} else if (args.stage==="navigation-envelope") {
  const b = await target(6,240,5);
  const refused = await act({kind:"navigate",target:b.target,range:3,duration_ms:5000,arrival:"interaction"});
  if (refused.status!=="failed" || refused.evidence.world_effect_emitted!==false)
    throw new Error("Expected settled envelope refusal before effects");
  // One bounded permitted alternative, not repeated unchanged refusal.
  await act({kind:"move",controls:{forward:true},look:{yaw:-Math.PI/2,pitch:0},duration_ms:250});
  const fresh = await target(6,240,5);
  await game.progress("Envelope refusal recognized; local approach changed before fresh selection",{subgoal:"Reassess now-local target"});
  return {status:"blocked",summary:"Refusal recognized once; no unchanged navigation retry",result:{stage:args.stage,receipts,observations,fresh_position:fresh.position}};
} else if (args.stage==="ascent" || args.stage==="headroom" || args.stage==="excavation") {
  const initial = await observe(), anchor = initial.data.player.position;
  let settled = initial, unsuccessful = 0;
  const attempt = async () => {
    // Raw forward follows the changing camera during a move. Settle the
    // orientation first in this narrow tunnel; this is an ordinary production look.
    await act({kind:"look",yaw:-Math.PI/2,pitch:0});
    await act({kind:"move",controls:{forward:true,jump:true},duration_ms:600});
    await act({kind:"move",controls:{},duration_ms:500});
    settled = await observe();
    const p = settled.data.player.position;
    // Grounded net height, not accumulated jump distance. A bounded detour is allowed.
    if (settled.data.player.on_ground && p.y>=anchor.y+.9) return true;
    unsuccessful++;
    return false;
  };
  if (args.stage==="ascent") {
    if (!await attempt()) throw new Error("Ordinary one-block ascent did not reach a stable higher standing position");
  } else {
    for (let i=0;i<3;i++) {
      if (await attempt()) throw new Error("Declared own-column ceiling did not block ascent");
    }
    await game.progress("Three ineffective ascent bursts; stopped and freshly observed own headroom obstruction",
      {subgoal:"Change local approach or terminate",unsuccessful,anchor,current:settled.data.player.position});
    if (args.stage==="headroom")
      return {status:"blocked",summary:"Own-column headroom prevents ascent; bounded termination, no loop",result:{stage:args.stage,receipts,observations,unsuccessful}};
    // Faithful minimal replay geometry. Clearing the actual own-column ceiling
    // uses ordinary observed-target mining, then the same physical controls.
    const roof = at(settled,5,243,0);
    if (!roof) throw new Error("Faithful excavation own-column roof not freshly observable");
    await act({kind:"equip",item:"wooden_pickaxe",destination:"hand"});
    const dug = await act({kind:"dig",target:roof.target});
    if (dug.status!=="succeeded") throw new Error("Ordinary excavation headroom repair not confirmed");
    if (!await attempt()) throw new Error("Headroom repair did not permit stable one-block escape");
  }
} else if (args.stage==="placement-collision" || args.stage==="placement-corner" || args.stage==="placement-face" || args.stage==="placement-adjacent") {
  const b = await target(args.stage==="placement-adjacent"||args.stage==="placement-corner"?1:0,239,args.stage==="placement-face"?2:args.stage==="placement-corner"?1:0);
  await act({kind:"place",item:"cobblestone",target:b.target,face:args.stage==="placement-face"?"down":"up"});
} else if (args.stage==="pickup-recovery") {
  let o = await observe();
  const drop = o.data.entities.find(e=>e.current&&e.item_name==="cobblestone"&&e.position.z>2);
  if (!drop) throw new Error("Prepared volatile item was not observable");
  const rejected = await act({kind:"navigate",target:drop.target,range:0.5,duration_ms:3000});
  if (rejected.status!=="failed" || rejected.evidence.world_effect_emitted!==false ||
      rejected.evidence.camera_changed!==false || rejected.evidence.neutralized!==true)
    throw new Error("Expected a safely settled no-effect refusal, not permission to retry uncertainty");
  o = await observe();
  const fresh = o.data.entities.find(e=>e.current&&e.item_name==="cobblestone");
  if (!fresh || fresh.target.target_id===drop.target.target_id) throw new Error("Fresh independent item required");
  await act({kind:"navigate",target:fresh.target,range:0.5,duration_ms:3000});
  o = await observe();
  if (!o.data.player.inventory.some(i=>i.name==="cobblestone"&&i.count>=1))
    throw new Error("Fresh pickup consequence absent");
}
await observe();
return {status:"completed",summary:"Evaluator-authored approach probe; faults retained, not model competence",result:{stage:args.stage,receipts,observations}};
`;

// Evaluator-owned mechanical conformance source. NEVER supplied to an actual model.
const source = `
const count = (o, name) => o.data.player.inventory.filter(i => i.name === name).reduce((n, i) => n + i.count, 0);
const receipts = [];
const act = async (a) => {
  const r = await game.action(a); receipts.push({ action: a, result: r });
  if (r.status !== "succeeded") throw new Error("Mechanical fixture action did not succeed: " + JSON.stringify(r));
  return r;
};
const logs = args.tool ? 3 : 1;
const gains = [];
for (let n = 0; n < logs; n++) {
  let o = await game.observe();
  const before = count(o, "oak_log");
  const p = o.data.player.position;
  const log = o.data.blocks.filter(b => b.current && b.name === "oak_log")
    .sort((a,b) => Math.hypot(a.position.x-p.x,a.position.z-p.z)-Math.hypot(b.position.x-p.x,b.position.z-p.z))[0];
  if (!log) throw new Error("Prepared log was not observable");
  await act({kind:"navigate",target:log.target,range:2,duration_ms:5000});
  o = await game.observe();
  const fresh = o.data.blocks.find(b => b.current && b.name === "oak_log" && b.target.target_id === log.target.target_id);
  if (!fresh) throw new Error("Selected log unavailable after approach");
  await act({kind:"dig",target:fresh.target});
  for (let poll=0; poll<12; poll++) {
    o = await game.observe();
    if (count(o,"oak_log") > before) break;
    const drop = o.data.entities.find(e => e.current && (e.item_name === "oak_log" || e.item_name === "minecraft:oak_log"));
    if (drop) await act({kind:"navigate",target:drop.target,range:0.5,duration_ms:2000});
    else await act({kind:"move",controls:{forward:true,sneak:true},duration_ms:150});
  }
  o = await game.observe();
  if (count(o,"oak_log") <= before) throw new Error("Own log pickup was not observed");
  gains.push({before,after:count(o,"oak_log"),observation_seq:o.observation_seq});
}
await act({kind:"craft",item:"oak_planks",executions:logs});
let o = await game.observe();
if (count(o,"oak_planks") !== logs*4) throw new Error("Plank production inventory mismatch");
await act({kind:"craft",item:"crafting_table",executions:1});
o = await game.observe();
if (count(o,"crafting_table") !== 1) throw new Error("Crafted table not retained");
if (args.tool) {
  const p = o.data.player.position;
  const floor = o.data.blocks.filter(b => b.current && b.name === "stone" && b.position.y < p.y && Math.hypot(b.position.x-p.x,b.position.z-p.z)>1.2 && Math.hypot(b.position.x-p.x,b.position.z-p.z)<2.8)[0];
  if (!floor) throw new Error("No observed reachable support for table placement");
  await act({kind:"place",target:floor.target,face:"up",item:"crafting_table"});
  await act({kind:"craft",item:"stick",executions:1});
  o = await game.observe();
  const table = o.data.blocks.find(b => b.current && b.name === "crafting_table");
  if (!table) throw new Error("Placed table was not observed");
  await act({kind:"craft",item:"wooden_pickaxe",executions:1,table:table.target});
  o = await game.observe();
  if (count(o,"wooden_pickaxe") !== 1) throw new Error("3x3 wooden pickaxe not retained");
  if (args.stone) {
    await act({kind:"equip",item:"wooden_pickaxe",destination:"hand"});
    for (let n=0;n<3;n++) {
      o=await game.observe();
      const before=count(o,"cobblestone"), p=o.data.player.position;
      const rock=o.data.blocks.filter(b=>b.current&&b.name==="stone"&&b.position.y>p.y)
        .sort((a,b)=>Math.hypot(a.position.x-p.x,a.position.z-p.z)-Math.hypot(b.position.x-p.x,b.position.z-p.z))[0];
      if(!rock) throw new Error("Prepared quarry stone was not observed");
      await act({kind:"navigate",target:rock.target,range:2,duration_ms:5000});
      o=await game.observe();
      const fresh=o.data.blocks.find(b=>b.current&&b.target.target_id===rock.target.target_id);
      if(!fresh) throw new Error("Selected quarry target was lost");
      await act({kind:"dig",target:fresh.target});
      for(let poll=0;poll<12;poll++) {
        o=await game.observe();
        if(count(o,"cobblestone")>before) break;
        const drop=o.data.entities.find(e=>e.current&&(e.item_name==="cobblestone"||e.item_name==="minecraft:cobblestone"));
        if(drop) await act({kind:"navigate",target:drop.target,range:0.5,duration_ms:2000});
        else await act({kind:"move",controls:{forward:true,sneak:true},duration_ms:150});
      }
      o=await game.observe();
      if(count(o,"cobblestone")<=before) throw new Error("Own cobblestone gain not observed");
    }
    o=await game.observe();
    let table=o.data.blocks.find(b=>b.current&&b.name==="crafting_table");
    if(!table) throw new Error("Work table not observed after quarrying");
    await act({kind:"navigate",target:table.target,range:2,duration_ms:5000});
    o=await game.observe();
    table=o.data.blocks.find(b=>b.current&&b.name==="crafting_table");
    if(!table) throw new Error("Work table no longer current");
    await act({kind:"craft",item:"stone_pickaxe",executions:1,table:table.target});
    o=await game.observe();
    if(count(o,"stone_pickaxe")!==1) throw new Error("Stone pickaxe not retained");
  }
}
return {status:"completed",summary:"Synthetic mechanical chain completed; not model gameplay",result:{gains,inventory:o.data.player.inventory,receipts}};
`;

// Evaluator-authored UI mechanics only. Never supplied as actor experience.
const inventorySource = `
const receipts = [];
let o = await game.observe();
const count = name => o.data.player.inventory.filter(i => i.name === name).reduce((n,i) => n+i.count,0);
const act = async action => {
  const checked = await game.actionAndObserve(action);
  receipts.push({action,result:checked.action});
  if (checked.observation) o = checked.observation;
  if (checked.action.status !== "succeeded") return false;
  return true;
};
const required = async action => {
  if (!await act(action)) throw new Error(receipts[receipts.length-1].result.summary);
};
try {
  if (args.scenario !== "positive") {
    const table = o.data.blocks.find(b=>b.current && b.name==="crafting_table");
    const action = args.scenario==="full" || args.scenario==="variants"
      ? {kind:"craft",item:args.scenario==="full"?"oak_planks":"crafting_table",executions:1}
      : {kind:"craft",item:"furnace",executions:1,table:table.target};
    const succeeded = await act(action);
    return {status:succeeded?"completed":"blocked",summary:"Disclosed inventory negative action settled",result:{receipts,inventory:o.data.player.inventory}};
  }
  await game.progress("Evaluator-authored visible inventory fixture",{current_subgoal:"Demonstrate native gestures, not autonomous gameplay"});
  await required({kind:"craft",item:"oak_planks",executions:3});
  if(count("oak_planks")!==12) throw new Error("Expected twelve produced planks");
  await required({kind:"craft",item:"crafting_table",executions:1});
  await required({kind:"craft",item:"stick",executions:2});
  await required({kind:"equip",item:"iron_shovel",destination:"hand"});
  await required({kind:"equip",item:"stone_pickaxe",destination:"hand"});
  const floor = o.data.blocks.find(b=>b.current && b.name==="grass_block" && b.position.x===2.5 && b.position.y===239.5 && b.position.z===2.5);
  if(!floor) throw new Error("Prepared placement support not observed");
  await required({kind:"place",target:floor.target,face:"up",item:"crafting_table"});
  let table = o.data.blocks.find(b=>b.current && b.name==="crafting_table");
  if(!table) throw new Error("Own placed table not observed");
  await required({kind:"craft",item:"wooden_pickaxe",executions:1,table:table.target});
  table = o.data.blocks.find(b=>b.current && b.name==="crafting_table");
  await required({kind:"craft",item:"furnace",executions:1,table:table.target});
  const furnaceFloor = o.data.blocks.find(b=>b.current && b.name==="dirt" && b.position.x===-1.5 && b.position.y===239.5 && b.position.z===0.5);
  if(!furnaceFloor) throw new Error("Prepared furnace support not observed");
  await required({kind:"place",target:furnaceFloor.target,face:"up",item:"furnace"});
  return {status:"completed",summary:"Disclosed native crafting, transfers, selection and placement completed",result:{receipts,inventory:o.data.player.inventory,position:o.data.player.position}};
} catch(error) {
  return {status:"blocked",summary:String(error).slice(0,500),result:{receipts,inventory:o.data.player.inventory}};
}
`;

export async function runNativeMinecraftMechanics(args: readonly string[]) {
  requireTierOptIn("native-game", { allowNative: args.includes("--allow-native") });
  const flags = [...args];
  const take = (flag: string) => { const at = flags.indexOf(flag); if (at < 0) return undefined; const value = flags[at+1]; requireProof(value && !value.startsWith("--"), `Pass ${flag} <value>`); flags.splice(at,2); return value; };
  const project = fileURLToPath(new URL("..", import.meta.url));
  const jar = take("--jar"); requireProof(jar, "Pass --jar <fresh-built.jar>");
  const selected = take("--case") ?? "basic";
  const mode = take("--mode") ?? "baseline";
  const stageSelection = take("--stages");
  const probeStages = selected !== "approach" ? mechanicalProbeStages
    : mode==="fixed" && stageSelection===undefined ? fixedMechanicalProbeStages : selectMechanicalProbeStages(stageSelection);
  requireProof(["basic", "tool", "stone", "repair", "approach", "inventory", "world-input", "visible-gui", "sensing", "controller-stream", "resident"].includes(selected) && ["baseline","fixed"].includes(mode) &&
    (selected === "approach" || !args.includes("--mode")) &&
    (selected === "approach" || selected === "visible-gui" || stageSelection === undefined) &&
    flags.every(flag => flag === "--allow-native"),
    "Pass --allow-native --jar and --case basic|tool|stone|repair|approach|inventory|world-input|visible-gui|sensing|controller-stream|resident; approach accepts --mode and --stages, visible-gui accepts --stages, no inference");
  requireProof(mode==="fixed" || probeStages.every(stage => mechanicalProbeStages.some(known=>known===stage)), "Additional negative stages require --mode fixed");
  requireProof(!probeStages.includes("replacement-stale") || probeStages.includes("replacement"), "replacement-stale requires replacement in the same selected proof");
  const artifact = assertNativeArtifactFresh(project, jar);
  process.env.GAMEHARNESS_NATIVE_PROOF = "1";
  process.env.GAMEHARNESS_PROOF_EXPECTED_JAR_SHA256 = artifact.sha256;
  const caps = createEvaluationCaps({ runMs: selected === "inventory" || selected === "visible-gui" ? 180_000 : 90_000,
    totalMs: selected === "visible-gui" ? 900_000 : selected === "inventory" ? 480_000 : 300_000, hostRequestAdmissions: 3 });
  if (selected === "resident") {
    const { runNativeResidentFixture } = await import("./native-resident.ts");
    const fixture = await runNativeResidentFixture(project, caps);
    console.log(JSON.stringify({ pass: fixture.report.pass, cleanup: fixture.report.cleanup,
      report: path.join(fixture.evidenceDirectory, "report.json"), actual_provider_calls: 0 }, null, 2));
    return;
  }
  if (selected === "controller-stream") {
    const { runNativeControllerStreamFixture } = await import("./native-controller-stream.ts");
    const fixture = await runNativeControllerStreamFixture(project, caps);
    console.log(JSON.stringify({ pass: fixture.report.pass, cleanup: fixture.report.cleanup,
      report: path.join(fixture.evidenceDirectory, "report.json"), actual_provider_calls: 0 }, null, 2));
    return;
  }
  if (selected === "sensing") {
    const { runNativeSensingFixture } = await import("./native-sensing.ts");
    const fixture = await runNativeSensingFixture(project, caps);
    console.log(JSON.stringify({ pass: fixture.report.pass, cleanup: fixture.report.cleanup,
      report: path.join(fixture.evidenceDirectory, "report.json"), actual_provider_calls: 0 }, null, 2));
    return;
  }
  if (selected === "visible-gui") {
    const { runNativeVisibleGuiFixture, selectVisibleGuiCases } = await import("./native-visible-gui.ts");
    const fixture = await runNativeVisibleGuiFixture(project, caps, selectVisibleGuiCases(stageSelection));
    console.log(JSON.stringify({ pass: fixture.report.pass, cleanup: fixture.report.cleanup,
      report: path.join(fixture.evidenceDirectory, "report.json"), actual_provider_calls: 0 }, null, 2));
    return;
  }
  if (selected === "world-input") {
    const { runNativeWorldInputFixture } = await import("./native-world-input.ts");
    const fixture = await runNativeWorldInputFixture(project, caps);
    console.log(JSON.stringify({ pass: fixture.report.pass, cleanup: fixture.report.cleanup,
      report: path.join(fixture.evidenceDirectory, "report.json"), actual_provider_calls: 0 }, null, 2));
    return;
  }
  const fixture = await NativeFixture.create("native-minecraft-mechanics", { projectRoot: project, caps });
  let runtime: Runtime | undefined, store: Store | undefined, sandbox: SandboxService | undefined, recorder: EpisodeRecorder | undefined;
  let failure: unknown, runId: string | undefined;
  const scope = new AbortController(), completed = Promise.withResolvers<void>();
  let probeStage: ProbeStage | undefined;
  let inventoryScenario = "positive";
  let replacedTarget: TargetRef | undefined;
  const probeExecutions: Array<Record<string, unknown>> = [];
  const probeRunIds: string[] = [];
  const inventoryRunIds: string[] = [];
  let observationCount = 0;
  const parentPolls: Array<Record<string, unknown>> = [];
  const transcript: unknown[] = [], effects: Array<{ action_id: string; action: GameAction; stage?: ProbeStage; result?: GameActionResult; error?: string; started_ms?: number; settled_ms?: number; polling_before?: number; polling_after?: number }> = [];
  const admission = Promise.withResolvers<void>(); void admission.promise.catch(() => {});
  let active = Promise.resolve(), release: (() => void) | undefined, admitted = false, peak = 0, concurrent = 0;
  let nativeDrain: Promise<{ closed: boolean }> | undefined;
  const stop = (why: string) => {
    failure ??= new Error(why); scope.abort(failure); release?.();
    if (runtime && runId) void runtime.control(runId, "stop").catch(() => {});
    nativeDrain ??= fixture.close();
    void nativeDrain.catch(() => {});
  };
  const unregister = postmortem.register(`mechanics-${randomUUID()}`, why => { stop(`Mechanical proof interrupted: ${why}`); return completed.promise; }, { exitOnly: true });
  const deadline = setTimeout(() => stop("Mechanical proof entire-process deadline"), caps.totalMs);
  const open = () => requireProof(!scope.signal.aborted, "Mechanical proof scope closed");
  fixture.report.classification = "Privileged prepared dry mechanical fixture; synthetic strategist, real Runtime/Docker worker/native effects. Zero provider/Jev calls. Not autonomous gameplay.";
  fixture.report.actual_provider_calls = 0; fixture.report.actual_jev_calls = 0;
  fixture.report.limits = caps; fixture.report.source = selected === "approach" ? approachSource : selected === "inventory" ? inventorySource : source; fixture.report.effects = effects;
  if (selected === "approach") fixture.report.approach_probe = {
    mode, selected_stages: probeStages, full_probe: probeStages.length===(mode==="fixed"?fixedMechanicalProbeStages:mechanicalProbeStages).length,
    source_difference: mode==="fixed" ? "Overhead navigate explicitly selects interaction arrival. Additional default-position, unreachable-interaction, entity-interaction and stale-new-action negatives are enabled. Actual replacement waits for native world-effect emission; baseline actions and pre-emission replacement behavior remain unchanged." : "Original baseline actions; navigate arrival omitted.",
    synthetic_strategy: true, supplied_wooden_pickaxe: probeStages.includes("adjacent"), prepared_no_ai_pig: probeStages.includes("entity-interaction"),
    replacement_requires_native_world_effect_emission: mode==="fixed" && probeStages.includes("replacement"),
    parent_polls: parentPolls, executions: probeExecutions,
    baseline_semantic_faults_are_not_platform_failures: true,
    acceptance_pending_baseline_review: [
      "Overhead approach attains a real reachable visible standing point without circling or exhausting its deadline; direct dig confirms removal.",
      "Adjacent stone digs survive parent observation polling and confirm own block removals plus fresh cobblestone acquisition.",
      "No-route travel reports bounded actionable blocked/no-progress without false arrival.",
      "Actual active-target replacement fences the old handle and leaves the replacement intact.",
    ],
  };
  try {
    await fixture.start(); open(); await fixture.flat(); open();
    await fixture.console(selected === "approach" || selected === "inventory" ? ["clear @a"] :
      ["clear @a", "setblock 0 240 6 minecraft:oak_log", "setblock 2 240 6 minecraft:oak_log", "setblock 4 240 6 minecraft:oak_log"]);
    if (selected === "stone") await fixture.console(["setblock 7 240 6 minecraft:stone", "setblock 7 240 7 minecraft:stone", "setblock 7 240 8 minecraft:stone"]);
    if (selected === "inventory") await fixture.console([
      "gamerule doDaylightCycle true", "setblock 2 239 2 minecraft:grass_block", "setblock -2 239 0 minecraft:dirt",
      "item replace entity @a inventory.0 with minecraft:oak_log 3",
      "item replace entity @a inventory.1 with minecraft:cobblestone 8",
      "item replace entity @a inventory.9 with minecraft:iron_shovel",
      "item replace entity @a hotbar.3 with minecraft:stone_pickaxe",
    ]);
    const initial = await fixture.observe();
    requireProof(selected === "inventory" || initial.data.player.inventory.length === 0, "Prepared fixture inventory is not empty");
    // Production config captures the fixture's private root at module load.
    // Static Runtime/Sandbox imports would bind the operator's data directory.
    const { Store } = await import("../src/server/store.ts");
    const { Runtime } = await import("../src/server/runtime.ts");
    const { SandboxService } = await import("../src/server/sandbox.ts");
    store = new Store(fixture.root); sandbox = new SandboxService(project, () => {});
    await bounded(sandbox.prepare(), caps.startMs, "Production Docker preparation timed out"); open();
    requireProof(sandbox.snapshot().status === "ready", "Production isolation unavailable");
    const modelId = "zero-provider-minecraft-mechanics";
    const auth = {
      snapshot: () => ({ status: "ready", authenticated: true, provider: "openai-codex", account_label: "Synthetic mechanical fixture; no provider", models: [{ id: modelId, name: modelId, provider: "private-diagnostic", context_window: null }], login: null, error: null }),
      createAgent: async (options: { tools: AgentTool[] }) => {
        let gate: Parameters<Agent["setBeforeModelCall"]>[0] | undefined;
        let cancelled = false, tools = options.tools;
        const hooks = new DiagnosticModelHooks();
        const api = {
          beforeToolCall: undefined as ((context: { tool: AgentTool; toolCall: { arguments: Record<string, unknown> }; args: Record<string, unknown> }) => unknown) | undefined,
          addBeforeModelCallHook: hooks.add,
          setBeforeModelCall: (hook: Parameters<Agent["setBeforeModelCall"]>[0]) => { gate = hook; },
          subscribe: () => () => {}, replaceMessages: () => {}, setTools: (next: AgentTool[]) => { tools = next; },
          abort: () => { cancelled = true; release?.(); }, waitForIdle: async () => { await active.catch(() => {}); },
          prompt: () => {
            active = (async () => {
              if (cancelled) return;
              await hooks.run(scope.signal, { systemPrompt: [], messages: [], tools });
              const receipt = await gate?.({ systemPrompt: [], messages: [], tools });
              if (receipt?.stop || cancelled) return;
              if (admitted) { const waiting = Promise.withResolvers<void>(); release = waiting.resolve; if (cancelled) release(); await waiting.promise; return; }
              admitted = true;
              const call = async (name: string, args: Record<string, unknown>) => {
                const tool = tools.find(tool => tool.name === name); requireProof(tool, `Production ${name} unavailable`);
                const check = await api.beforeToolCall?.({ tool, toolCall: { arguments: args }, args });
                requireProof(!cancelled && !(check && typeof check === "object" && "block" in check && check.block), "Synthetic production dispatch fenced");
                const result = await tool.execute(randomUUID(), args);
                transcript.push({ name, args, details: result.details, isError: result.isError });
                requireProof(!result.isError, `Production ${name} rejected fixture: ${JSON.stringify(result.details)}`);
              };
              if (selected === "approach") {
                requireProof(probeStage, "Missing parent-selected probe stage");
                const name = `Disclosed approach ${probeStage}`;
                const request = { name, args: { stage: probeStage, fixed: mode==="fixed", ...(replacedTarget ? {old_target:replacedTarget} : {}) },
                  limits: { duration_ms: 35_000, max_actions: 16, max_calls: 40, max_depth: 1 } };
                if (probeStage==="pickup-recovery") await call("program_submit", { ...request, source: approachSource });
                else {
                  await call("program_write", { name, source: approachSource });
                  await call("program_run", { operation: "start", ...request });
                }
                admission.resolve(); return;
              }
              if (selected === "inventory") {
                await call("program_submit", { name: "Disclosed visible inventory fixture", source: inventorySource,
                  args: {scenario: inventoryScenario}, limits: {duration_ms: caps.runMs, max_actions: 20, max_calls: 80, max_depth: 1} });
                admission.resolve(); return;
              }
              if (selected === "repair") {
                await call("program_write", { name: "Disclosed mechanics fixture",
                  source: 'return {status:"blocked",summary:"Synthetic assessed parent intentionally blocked before effects",result:null};' });
                await call("program_run", { operation: "start", name: "Disclosed mechanics fixture", args: null,
                  limits: { duration_ms: 1000, max_actions: 1, max_calls: 4, max_depth: 1 } });
                const parent = await until(async () => store!.latestRootExecution(runId!),
                  execution => execution?.status === "blocked", 5000, "Synthetic repair parent did not close as blocked");
                requireProof(parent?.status === "blocked", "Expected exact blocked parent");
                await call("program_review", { name: "Disclosed mechanics fixture", version: 1,
                  decision: "insufficient_evidence", reason: "Synthetic blocked parent has no gameplay efficacy evidence" });
                await call("program_write", { name: "Disclosed mechanics fixture", based_on: 1, source,
                  reason: "Exercise exact-parent code repair after immutable insufficient-evidence assessment; no efficacy claim" });
              } else await call("program_write", { name: "Disclosed mechanics fixture", source });
              await call("program_run", { operation: "start", name: "Disclosed mechanics fixture", args: { tool: selected === "tool" || selected === "stone", stone: selected === "stone" }, limits: { duration_ms: caps.runMs, max_actions: 60, max_calls: 180, max_depth: 1 } });
              admission.resolve();
            })().catch(error => { admission.reject(error); stop(String(error)); });
            return active;
          },
        };
        return api as unknown as Agent;
      },
      releaseAgent: async (agent: Agent) => { agent.abort(); await agent.waitForIdle(); },
    } as unknown as AuthManager;
    const execute = fixture.bridge.execute.bind(fixture.bridge);
    fixture.bridge.execute = async (request, signal) => {
      const receipt: (typeof effects)[number] = { action_id: request.operation_id, action: gameActionSchema.parse(request.action), started_ms: performance.now(),
        ...(selected === "approach" ? { stage: probeStage, polling_before: observationCount } : {}) }; effects.push(receipt);
      concurrent++; peak = Math.max(peak, concurrent);
      try {
        if (receipt.stage==="pickup-recovery" && receipt.action.kind==="navigate" &&
            effects.filter(effect=>effect.stage==="pickup-recovery").length===1) {
          // Deliberate evaluator perturbation between fresh actor observation
          // and native application. No retry or mutation of the old handle.
          await fixture.console(["kill @e[type=minecraft:item,tag=stale_pickup]"]);
        }
        if (selected !== "approach") receipt.result = await execute(request, signal);
        else {
          let replaced = false;
          receipt.result = await pollMechanicalEffect(async () => {
            const result = await execute(request, signal); receipt.result = result; return result;
          }, async () => {
            open();
            const sample: Record<string, unknown> = { action_id: receipt.action_id, stage: receipt.stage, started_ms: performance.now() };
            parentPolls.push(sample);
            try {
              const before = await fixture.diagnostics();
              sample.native_before = before;
              const observation = await fixture.observe(); observationCount++;
              sample.observation_seq = observation.observation_seq; sample.captured_at = observation.captured_at;
              sample.player = observation.data.player;
              sample.blocks = observation.data.blocks; sample.entities = observation.data.entities;
              const target = "target" in receipt.action ? targetRefSchema.parse(receipt.action.target) : null;
              sample.selected_target_projected = target ? [...observation.data.blocks,...observation.data.entities]
                .some(item => item.current && item.target.target_id === target.target_id && item.target.incarnation === target.incarnation) : null;
              const after = await fixture.diagnostics();
              sample.native_after = after;
              sample.observation_completed_ms = performance.now();
              sample.overlapped_native_motor = before.motor_active && after.motor_active;
              if (receipt.stage === "replacement" && receipt.action.kind === "dig" && before.motor_active && after.motor_active &&
                (mode!=="fixed" || before.motor_world_effect_emitted===true && after.motor_world_effect_emitted===true) && !replaced) {
                replaced = true;
                sample.replacement_started_ms = performance.now();
                sample.replacement_after_world_effect_emission = before.motor_world_effect_emitted===true && after.motor_world_effect_emitted===true;
                await fixture.console(["setblock 0 240 2 minecraft:stone"]);
                sample.replacement_acknowledged_ms = performance.now();
              }
            } catch (error) { sample.error = String(error); throw error; }
            finally { sample.finished_ms = performance.now(); }
          }, 0);
        }
        return receipt.result;
      }
      catch (error) { receipt.error = String(error); throw error; }
      finally {
        concurrent--;
        receipt.settled_ms = performance.now();
        if (selected === "approach") receipt.polling_after = observationCount;
      }
    };
    runtime = new Runtime(store, auth, fixture.bridge, sandbox, () => {}, { adapter: () => fixture.bridge.adapter() });
    await runtime.initialize(); open();
    const adapter = fixture.bridge.adapter(); requireProof(adapter, "Missing negotiated adapter");
    const goal = adapter.goals.find(goal => goal.goal_id === "custom" && goal.verifier === null); requireProof(goal, "Missing unverified fixture goal");
    if (selected === "approach") {
      await fixture.case(`approach_excavation_${mode}`, { synthetic_strategy: true, supplied_wooden_pickaxe: probeStages.includes("adjacent"),
        privileged_setup_between_drained_runs: true, active_target_replacement: probeStages.includes("replacement"),
        selected_stages: probeStages, mode, model_inference: false }, async entry => {
        const faults: Array<Record<string, unknown>> = [];
        const safetyFailures: string[] = [];
        const fixedFailures: Array<{ stage: ProbeStage; failures: string[] }> = [];
        entry.semantic_findings = faults; entry.executions = probeExecutions; entry.safety_failures = safetyFailures;
        entry.fixed_failures = fixedFailures;
        entry.semantic_acceptance = mode==="fixed" ? "running" : "not_evaluated_pending_baseline_review";
        for (const [stageIndex, stage] of probeStages.entries()) {
          open(); probeStage = stage; admitted = false;
          const followsOverheadTravel = stage === "overhead-dig" && probeStages[stageIndex-1] === "overhead";
          const followsReplacement = stage === "replacement-stale";
          if (!followsOverheadTravel && !followsReplacement) {
            const setup = [`fill -12 240 -12 12 ${mode==="fixed"?248:246} 12 minecraft:air`, "fill -12 239 -12 12 239 12 minecraft:stone",
              "kill @e[type=minecraft:item]", "clear @a", "tp @a 0.5 240 0.5 0 0"];
            if (mode==="fixed") setup.unshift("kill @e[tag=mechanics_probe]", "effect clear @a");
            if (stage === "overhead" || stage === "overhead-dig") setup.push("setblock 0 242 2 minecraft:oak_log");
            if (stage === "position-overhead") setup.push("setblock 0 243 2 minecraft:oak_log");
            if (stage === "unreachable-overhead") setup.push("setblock 0 247 0 minecraft:oak_log");
            if (stage === "entity-interaction") setup.push('summon minecraft:pig 0.5 240 2.5 {NoAI:1b,Invulnerable:1b,PersistenceRequired:1b,Tags:["mechanics_probe"]}');
            if (stage === "adjacent") setup.push("give @a minecraft:wooden_pickaxe 1", "setblock 0 240 2 minecraft:stone", "setblock 1 240 2 minecraft:stone");
            if (stage === "dirt") setup.push("setblock 0 240 2 minecraft:grass_block", "setblock 1 240 2 minecraft:dirt");
            if (stage === "blocked") setup.push("fill 1 239 -12 3 239 12 minecraft:air", "setblock 4 240 0 minecraft:stone");
            if (stage === "replacement") setup.push("setblock 0 240 2 minecraft:obsidian");
            if (stage === "pickup-recovery") setup.push(
              'summon minecraft:item 0.5 240 2.5 {Tags:["stale_pickup"],PickupDelay:0s,Item:{id:"minecraft:cobblestone",count:1}}',
              'summon minecraft:item -2.5 240 0.5 {PickupDelay:0s,Item:{id:"minecraft:cobblestone",count:1}}');
            if (stage === "ascent" || stage === "headroom") setup.push("fill 1 240 -1 4 240 1 minecraft:stone");
            if (stage === "headroom") setup.push("setblock 0 242 0 minecraft:stone");
            if (stage === "excavation") setup.push(
              "fill -1 240 -1 7 246 1 minecraft:stone",
              "fill 0 240 0 5 242 0 minecraft:air",
              "fill 6 242 0 6 243 0 minecraft:air",
              "setblock 5 240 0 minecraft:cobblestone",
              "give @a minecraft:wooden_pickaxe 1",
              // Evaluator-only lighting for legible evidence; does not change
              // collision, jump, mining or placement rules. Never used in live play.
              "effect give @a minecraft:night_vision 120 0 true",
              "tp @a 5.699999988 241 0.471232488 -90 0");
            if (stage === "placement-collision" || stage === "placement-corner" || stage === "placement-face" || stage === "placement-adjacent")
              setup.push("give @a minecraft:cobblestone 19");
            if (stage === "placement-corner") setup.push("tp @a 0.8543017056 240 0.7205624866 0 0");
            if (stage === "placement-face") setup.push("setblock 0 239 2 minecraft:stone");
            if (stage === "navigation-envelope") setup.push("tp @a 0.017695265 240 0.080661889 0 0", "setblock 6 240 5 minecraft:oak_log");
            await fixture.console(setup);
          }
          const expectedFeetY = stage==="excavation" ? 241 : 240;
          const before = await until(() => fixture.observe(), observation => observation.data.player.on_ground &&
            Math.abs(observation.data.player.position.y-expectedFeetY)<.05, caps.observationMs, "Probe player did not settle at its declared standing height");
          requireProof(before.data.player.on_ground && Math.abs(before.data.player.position.y-expectedFeetY)<.05, "Probe feet did not settle at declared height");
          if (!followsOverheadTravel && !followsReplacement && !recoveryProbeStages.some(known=>known===stage))
            requireProof(Math.hypot(before.data.player.position.x-.5,before.data.player.position.z-.5)<.05, "Probe setup did not retain declared horizontal start");
          const target = recoveryProbeStages.some(known=>known===stage) ? before.data.blocks.find(block=>block.current) :
            stage==="pickup-recovery" ? before.data.entities.find(entity=>entity.current && entity.item_name==="cobblestone") :
            stage==="entity-interaction" ? before.data.entities.find(entity=>entity.current && entity.name==="pig") :
            before.data.blocks.find(block => block.current && block.position.x === (stage==="blocked"?4.5:.5) &&
            block.position.y === (stage==="overhead"||stage==="overhead-dig"?242.5:stage==="position-overhead"?243.5:stage==="unreachable-overhead"?247.5:240.5) &&
            block.position.z === (stage==="blocked"||stage==="unreachable-overhead"?.5:2.5));
          requireProof(target, `Prepared ${stage} target absent from actual observation`);
          if (stage==="replacement") replacedTarget = target.target;
          if (stage==="replacement-stale") requireProof(replacedTarget, "Replacement old handle was not retained");
          if (stage === "overhead" || stage === "overhead-dig") requireProof(Math.abs(target.position.y-before.data.player.position.y-2.5)<.05, "Overhead geometry does not match Sol's feet70/center72.5 offset");
          const run = await runtime!.createRun({ task: `Disclosed synthetic ${stage} mechanics probe; not model competence`, goal, model_id: modelId, working_programs: "fresh" });
          runId = run.run_id; probeRunIds.push(runId);
          recorder = new EpisodeRecorder({ directory: path.join(fixture.evidenceDirectory, `recording-${stage}`), bridge: fixture.bridge,
            identity: { episode_id: randomUUID(), run_id: runId, world_id: run.world_id, session_id: run.session_id! },
            limits: { maxDurationMs: 45_000, maxFrames: 1500, maxStoredFrameBytes: 512 * 1024 ** 2 }, onIncomplete: stop });
          await runtime!.control(runId, "start");
          const execution = await until(async () => { open(); return store!.latestRootExecution(runId!); },
            value => Boolean(value && ["succeeded","blocked","failed","cancelled","unknown"].includes(value.status)),
            40_000, `Approach ${stage} root did not close`);
          await runtime!.control(runId, "stop"); open();
          const after = await fixture.observe(), diagnostics = await fixture.diagnostics();
          const stageEffects = effects.filter(effect => effect.stage === stage);
          const polls = parentPolls.filter(sample => sample.stage === stage);
          const observation = { stage, follows_overhead_travel: followsOverheadTravel, run_id: runId, before, target, execution, after, effects: stageEffects,
            polling_count_before: stageEffects[0]?.polling_before, polling_count_after: stageEffects.at(-1)?.polling_after,
            overlapping_native_polls: polls.filter(sample => sample.overlapped_native_motor).length,
            diagnostics, recording: await recorder.finish({ endedAt: Date.now(), reason: `${mode}_stage_retained` }),
            replay: await recorder.renderReplay({ signal: scope.signal }) };
          probeExecutions.push(observation);
          requireProof(diagnostics.controls_neutral && !diagnostics.motor_active && concurrent === 0 && peak === 1, "Probe stage did not drain its sole native effect owner");
          requireProof(observation.recording.status === "complete", "Probe recording incomplete");
          requireProof((stage==="replacement-stale" || stageEffects.length > 0) && stageEffects.every(effect => effect.result && !effect.error), `Probe ${stage} did not retain real action receipts`);
          if (["overhead-dig","adjacent","dirt","replacement"].includes(stage)) requireProof(observation.overlapping_native_polls > 0,
            `Probe ${stage} has no actual observation spanning an active native motor`);
          const digs = stageEffects.filter(effect => effect.action.kind === "dig");
          if (stage === "blocked" && stageEffects.some(effect => effect.result?.status === "succeeded")) safetyFailures.push("No-route negative falsely reported arrival");
          if (stage === "replacement") {
            requireProof(polls.some(sample => sample.replacement_acknowledged_ms), "Actual replacement was not applied during the active native dig");
            if (mode==="fixed" && !polls.some(sample=>sample.replacement_acknowledged_ms && sample.replacement_after_world_effect_emission===true))
              safetyFailures.push("Replacement was not demonstrated after native world-effect emission");
            if (digs.some(effect => effect.result?.status === "succeeded")) safetyFailures.push("Old target succeeded after actual replacement");
            if (!after.data.blocks.some(block => block.current && block.name==="stone" && block.position.x===.5 && block.position.y===240.5 && block.position.z===2.5)) safetyFailures.push("Replacement stone was not retained");
          }
          const confirmedRemovals = digs.filter(effect => effect.result && evidence(effect.result).block_removed===true).length;
          const cobblestone = after.data.player.inventory.filter(item => item.name==="cobblestone").reduce((n,item)=>n+item.count,0);
          if (mode==="fixed") {
            const failures = mechanicalFixedFailures(stage, stageEffects, cobblestone);
            if (recoveryProbeStages.some(known=>known===stage)) {
              const delta = after.data.player.position.y-before.data.player.position.y;
              const moves = stageEffects.filter(effect=>effect.action.kind==="move");
              if (stage==="ascent" || stage==="excavation") {
                if (execution?.status!=="succeeded" || !after.data.player.on_ground || delta<.9)
                  failures.push("Actual production controls did not reach a stable one-block-higher standing position");
                if (stage==="excavation" && (moves.length!==8 || digs.length!==1 ||
                    !digs.every(effect=>effect.result?.status==="succeeded" && evidence(effect.result).block_removed===true)))
                  failures.push("Faithful excavation did not bound ineffective effort, freshly mine own headroom and then escape");
              }
              if (stage==="headroom" && (execution?.status!=="blocked" || moves.length!==6 || Math.abs(delta)>.05))
                failures.push("Headroom-negative did not terminate after three ineffective bursts without false ascent");
              if (stage==="headroom" || stage==="excavation") {
                const feedback = moves[0]?.result ? evidence(moves[0].result) : {};
                const end = feedback.movement_end;
                if (!end || typeof end!=="object" || Array.isArray(end) || !("headroom_1m_clear" in end) || end.headroom_1m_clear!==false)
                  failures.push("Own-column ceiling lacks truthful mechanical headroom feedback");
              }
              if (stage==="navigation-envelope") {
                const navigations = stageEffects.filter(effect=>effect.action.kind==="navigate");
                const refusal = navigations[0]?.result ? evidence(navigations[0].result) : {};
                if (execution?.status!=="blocked" || navigations.length!==1 || moves.length!==1 ||
                    refusal.navigation_stop_reason!=="start_distance_limit" || refusal.world_effect_emitted!==false ||
                    typeof refusal.navigation_start_distance!=="number" || refusal.navigation_start_distance<=8)
                  failures.push("Envelope refusal lacks actual distance or bounded changed approach");
              }
              if (stage==="placement-collision" || stage==="placement-corner" || stage==="placement-face") {
                const placement = stageEffects.find(effect=>effect.action.kind==="place")?.result;
                const feedback = placement ? evidence(placement) : {};
                if (placement?.status!=="failed" || feedback.placement_effect_emitted!==false ||
                    typeof feedback.placement_preflight_reason!=="string" || feedback.inventory_receipt_confirmed===false)
                  failures.push("Invalid placement lacks safe pre-dispatch refusal and explicit reason");
                if (cobblestone!==19) failures.push("Refused placement consumed a block");
              }
              if (stage==="placement-adjacent") {
                const placement = stageEffects.find(effect=>effect.action.kind==="place")?.result;
                const feedback = placement ? evidence(placement) : {};
                if (placement?.status!=="succeeded" || feedback.placement_effect_emitted!==true ||
                    feedback.inventory_receipt_confirmed!==true || cobblestone!==18 ||
                    !after.data.blocks.some(block=>block.current && block.name==="cobblestone" &&
                      block.position.x===1.5 && block.position.y===240.5 && block.position.z===.5))
                  failures.push("Permitted adjacent placement lost actual block consequence, emission or inventory custody");
              }
            }
            if (["overhead","overhead-dig","adjacent","dirt","replacement-stale","pickup-recovery"].includes(stage) && execution?.status!=="succeeded")
              failures.push("Positive probe procedure did not complete through the worker");
            if (stage==="pickup-recovery" && (store!.allSkillExecutions(runId!).length!==1 ||
                store!.eventsAfter(runId!,0,500).some(event=>event.type==="runtime.uncertainty")))
              failures.push("Safely settled pickup recovery did not remain in one valid root");
            if (stage==="entity-interaction" && Math.hypot(
              after.data.player.position.x-before.data.player.position.x,
              after.data.player.position.y-before.data.player.position.y,
              after.data.player.position.z-before.data.player.position.z)>.005)
              failures.push("Entity interaction rejection displaced the actual player");
            if (["overhead-dig","adjacent","dirt"].includes(stage)) for (const [index,dig] of digs.entries()) {
              const position = dig.result ? evidence(dig.result).target_position : undefined;
              const expected = {x:stage==="overhead-dig"?.5:index+.5,y:stage==="overhead-dig"?242.5:240.5,z:2.5};
              if (!position || typeof position!=="object" || Array.isArray(position) ||
                !("x" in position) || !("y" in position) || !("z" in position) ||
                position.x!==expected.x || position.y!==expected.y || position.z!==expected.z)
                failures.push(`Dig ${index} lacks the declared native target coordinates`);
            }
            if (stage==="replacement-stale") {
              const output = execution?.result?.result;
              const attempts = output && typeof output==="object" && !Array.isArray(output) ? output.attempts : null;
              const rejected = Array.isArray(attempts) && attempts.length===1 && attempts.every(attempt => {
                if (!attempt || typeof attempt!=="object" || Array.isArray(attempt)) return false;
                if (typeof attempt.error==="string") return /target|stale|incarnation|fenced/i.test(attempt.error);
                const result = attempt.result;
                return result && typeof result==="object" && !Array.isArray(result) && result.status==="failed";
              });
              if (!rejected) failures.push("Fresh worker action did not reject the retained replaced handle");
              if (stageEffects.some(effect => effect.result?.status!=="failed" || evidence(effect.result).effect_confirmed!==false ||
                evidence(effect.result).world_effect_emitted===true)) failures.push("Old-handle new action emitted or confirmed an effect");
              if (target.target.incarnation===replacedTarget?.incarnation && target.target.target_id===replacedTarget.target_id)
                failures.push("Replacement did not produce a distinct observed incarnation");
              if (!after.data.blocks.some(block=>block.current && block.name==="stone" && block.position.x===.5 && block.position.y===240.5 && block.position.z===2.5))
                failures.push("New stale-handle action damaged the replacement stone");
            }
            if (failures.length) fixedFailures.push({stage,failures});
          }
          const observedFaults = [
            ...(stage==="overhead" && stageEffects.some(effect=>effect.result?.status!=="succeeded") ? ["overhead_travel_not_confirmed"] : []),
            ...(stage==="overhead-dig" && confirmedRemovals!==1 ? ["direct_overhead_removal_not_confirmed"] : []),
            ...((stage==="adjacent"||stage==="dirt") && confirmedRemovals!==2 ? ["adjacent_removals_incomplete"] : []),
            ...(stage==="adjacent" && cobblestone<2 ? ["two_stone_acquisitions_not_retained"] : []),
            ...(stage==="blocked" && stageEffects.some(effect=>/deadline/i.test(effect.result?.summary??"")) ? ["no_route_waited_until_deadline"] : []),
          ];
          faults.push({ stage, execution_status: execution?.status, receipts: stageEffects.map(effect => ({
            action_id: effect.action_id, kind: effect.action.kind, status: effect.result?.status, summary: effect.result?.summary,
            evidence: effect.result?.evidence })), confirmed_removals: confirmedRemovals, cobblestone_retained: cobblestone,
            observed_faults: observedFaults,
            interpretation: mode==="baseline" ? "Baseline observations only. Unknown effects remain unknown; no fixed semantic verdict or model competence claim." :
              "Fixed receipt checks apply; unknown effects stay unknown, mechanical fixture is not model competence." });
        }
        probeStage = undefined;
        entry.goal_claim = mode==="baseline" ? "Baseline capture completed, not repaired mechanics or model success; inspect semantic_findings and all native receipts" :
          "Only the selected mechanical acceptance checks; no model competence or full-chain gameplay claim";
        if (mode==="fixed") entry.semantic_acceptance = fixedFailures.length || safetyFailures.length ? "failed" : "passed";
        requireProof(safetyFailures.length===0, `Probe safety negatives failed: ${safetyFailures.join("; ")}`);
        requireProof(fixedFailures.length===0, `Fixed mechanics acceptance failed: ${JSON.stringify(fixedFailures)}`);
      });
    } else if (selected === "inventory") {
      fixture.report.inventory_conditions = { supplied_inventory: true, evaluator_authored: true,
        provider_calls: 0, native_world_time_continues: true, daylight_cycle: true,
        one_runtime_worker_root_per_case: true, no_actor_experience_export: true,
        setup_notification_settle_ms: 15000, action_notifications_preserved: true };
      const counts = (observation: typeof initial) => Object.fromEntries(observation.data.player.inventory.map(item => [item.slot, [item.name, item.count]]));
      const uiEvidence = (result: GameActionResult | undefined): Record<string, unknown> | null => {
        const raw = result && evidence(result).native_inventory_ui;
        return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
      };
      const nativeUi = (diagnostics: Awaited<ReturnType<typeof fixture.diagnostics>>) => {
        const raw = diagnostics.native_inventory_ui;
        return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
      };
      const ingredientCounts = (result: GameActionResult | undefined, expected: { acquire: number; distribute: number; return: number; result: number }) => {
        const ui = uiEvidence(result), counts = ui?.gesture_counts as Record<string, unknown> | undefined;
        requireProof(counts && Object.entries(expected).every(([key, count]) => counts[key] === count),
          `Actual ingredient/output gestures differ: ${JSON.stringify({expected, actual: counts})}`);
        requireProof(ui?.gestures === Object.values(expected).reduce((sum, value) => sum + value, 0),
          "Unexpected extra gestures outside the intended ingredient/output sequence");
      };
      const retained = (observation: typeof initial, name: string) => observation.data.player.inventory
        .filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0);
      // Preparation only: no actor/run is active, world time keeps advancing.
      // Do not cut or suppress notifications generated by the actual actions.
      await pause(15000); open();
      fixture.report.inventory_setup_frame = await fixture.frame("inventory-setup-settled");
      for (const scenario of ["positive", "surplus", "split", "variants", "components", "full", "stop", "stop-distributed", "replacement", "correction"]) {
        inventoryScenario = scenario; admitted = false;
        if (scenario !== "positive") {
          await fixture.console(["clear @a", "setblock 2 240 2 minecraft:crafting_table"]);
          if (scenario === "full") {
            await fixture.console([
              ...Array.from({length: 9}, (_,slot) => `item replace entity @a hotbar.${slot} with minecraft:stone 64`),
              ...Array.from({length: 27}, (_,slot) => `item replace entity @a inventory.${slot} with minecraft:stone 64`),
              "item replace entity @a inventory.0 with minecraft:oak_log 64",
            ]);
          } else if (scenario === "split") await fixture.console([
            "item replace entity @a inventory.0 with minecraft:cobblestone 3",
            "item replace entity @a inventory.1 with minecraft:cobblestone 5",
          ]);
          else if (scenario === "variants") await fixture.console([
            "item replace entity @a inventory.0 with minecraft:oak_planks 2",
            "item replace entity @a inventory.1 with minecraft:birch_planks 2",
          ]);
          else if (scenario === "components") await fixture.console([
            `item replace entity @a inventory.0 with minecraft:cobblestone[minecraft:custom_name='{"text":"Fixture stack A"}'] 3`,
            `item replace entity @a inventory.1 with minecraft:cobblestone[minecraft:custom_name='{"text":"Fixture stack B"}'] 5`,
          ]);
          else await fixture.console([`item replace entity @a inventory.0 with minecraft:cobblestone ${scenario === "surplus" ? 16 : 8}`]);
        }
        const before = await fixture.observe();
        const run = await runtime.createRun({task: `Disclosed zero-provider native inventory ${scenario}`, goal,
          model_id: modelId, working_programs: "fresh"});
        runId = run.run_id;
        inventoryRunIds.push(runId);
        const effectStart = effects.length;
        const recordingDirectory = path.join(fixture.evidenceDirectory, `recording-inventory-${scenario}`);
        recorder = ["positive", "surplus", "split", "stop-distributed"].includes(scenario) ? new EpisodeRecorder({
          directory: recordingDirectory, bridge: fixture.bridge,
          identity: {episode_id: randomUUID(), run_id: runId, world_id: run.world_id, session_id: run.session_id!},
          limits: {maxDurationMs: 180_000, maxFrames: 5500, maxStoredFrameBytes: 3 * 1024 ** 3}, onIncomplete: stop,
        }) : undefined;
        await fixture.case(`visible_inventory_${scenario}`, {evaluator_authored: true, supplied_inventory: true,
          model_inference: false, world_time_continues: true, perturbation: scenario === "positive" ? null : scenario}, async entry => {
          entry.before = before;
          const commandsBefore = fixture.commands.length;
          await runtime!.control(runId!, "start");
          await until(async () => {
            open();
            return store!.latestRootExecution(runId!);
          }, value => Boolean(value), 20000, "Inventory root was not admitted");
          let interruptedUi: Record<string, unknown> | null = null;
          if (["stop", "stop-distributed", "replacement", "correction"].includes(scenario)) {
            const sampled = await until(() => fixture.diagnostics(), value => {
              const ui = nativeUi(value);
              return ui?.held === true && typeof ui.cursor_count === "number" && ui.cursor_count > 0
                && (scenario === "stop" || typeof ui.grid_count === "number" && ui.grid_count >= 2);
            }, 20000, `Required carried-stack/grid press not observed for ${scenario}`);
            interruptedUi = nativeUi(sampled);
            entry.pre_perturbation_diagnostics = sampled;
            if (scenario === "stop" || scenario === "stop-distributed") await runtime!.control(runId!, "stop");
            else if (scenario === "replacement") await fixture.console(["setblock 2 240 2 minecraft:air"]);
            else await fixture.console(["item replace entity @a inventory.0 with minecraft:cobblestone 1"]);
          }
          const execution = await until(async () => store!.latestRootExecution(runId!),
            value => Boolean(value && ["succeeded", "blocked", "failed", "cancelled", "unknown"].includes(value.status)),
            caps.runMs, `Inventory ${scenario} root did not close`);
          entry.execution = execution;
          const actualEffects = effects.slice(effectStart);
          entry.effects = actualEffects;
          if (scenario === "positive") {
            requireProof(execution?.status === "succeeded", `Visible inventory fixture blocked: ${JSON.stringify(execution)}`);
            const operations = actualEffects.filter(effect => ["craft", "equip", "place"].includes(effect.action.kind));
            requireProof(operations.length === 9 && operations.every(effect => effect.result?.status === "succeeded"),
              "Representative native inventory operations did not all succeed");
            const ui = operations.map(effect => uiEvidence(effect.result));
            requireProof(ui.every(value => value && value.closed === true && value.cursor_count === 0 && value.grid_count === 0),
              "Successful inventory operations lack closed empty cursor/grid custody");
            requireProof(ui.some(value => value?.direct_hotbar === true) && ui.some(value => typeof value?.gestures === "number" && value.gestures > 0),
              "Fixture lacks actual gestures or direct existing-hotbar selection");
            ingredientCounts(operations.find(effect => effect.action.kind === "craft" && effect.action.item === "furnace")?.result,
              {acquire: 1, distribute: 8, return: 0, result: 2});
            ingredientCounts(operations.find(effect => effect.action.kind === "craft" && effect.action.item === "wooden_pickaxe")?.result,
              {acquire: 2, distribute: 5, return: 2, result: 2});
            requireProof(fixture.commands.length === commandsBefore, "Positive inventory clip received evaluator gameplay intervention");
          } else if (["surplus", "split", "variants", "components"].includes(scenario)) {
            requireProof(execution?.status === "succeeded" && actualEffects.length === 1 && actualEffects[0]?.result?.status === "succeeded",
              `${scenario} source-group craft did not complete`);
            ingredientCounts(actualEffects[0]?.result, scenario === "surplus"
              ? {acquire: 1, distribute: 8, return: 1, result: 2}
              : {acquire: 2, distribute: scenario === "variants" ? 4 : 8, return: 0, result: 2});
            requireProof(fixture.commands.length === commandsBefore, "Source-group proof received evaluator gameplay intervention");
          } else if (scenario === "full") {
            requireProof(execution?.status === "blocked" && actualEffects[0]?.result?.status === "failed",
              "Full inventory must refuse rather than falsely complete or lose output");
            requireProof(evidence(actualEffects[0]!.result!).world_effect_emitted === false,
              "Full-inventory refusal emitted effects before capacity validation");
          } else {
            requireProof(execution?.status !== "succeeded" && actualEffects.every(effect => effect.result?.status !== "succeeded"),
              "Interrupted/replaced/corrected inventory work falsely completed");
            entry.interrupted_ui = interruptedUi;
          }
          await runtime!.control(runId!, "stop");
          const after = await fixture.observe(), diagnostics = await until(() => fixture.diagnostics(), value => {
            const custody = value.current_inventory_custody as Record<string, unknown> | undefined;
            return value.screen_type === null && custody?.cursor_count === 0 && custody.grid_count === 0;
          }, 5000, "Current owned inventory custody did not settle after cleanup");
          entry.after = after; entry.final_diagnostics = diagnostics;
          requireProof(diagnostics.controls_neutral && !diagnostics.motor_active && concurrent === 0 && peak === 1,
            "Inventory fixture did not drain one effect owner");
          if (scenario === "full") requireProof(JSON.stringify(counts(before)) === JSON.stringify(counts(after)),
            "Capacity refusal changed actual own inventory");
          if (["surplus", "split", "components"].includes(scenario))
            requireProof(retained(after, "furnace") === 1 && retained(after, "cobblestone") === (scenario === "surplus" ? 8 : 0),
              "Source-group output or surplus inventory consequence is incorrect");
          if (scenario === "variants") requireProof(retained(after, "crafting_table") === 1
            && retained(after, "oak_planks") === 0 && retained(after, "birch_planks") === 0,
            "Compatible plank variants did not preserve exact recipe consumption");
          if (["stop", "stop-distributed", "replacement", "correction"].includes(scenario)) {
            requireProof(retained(after, "furnace") === 0 && retained(after, "cobblestone") === (scenario === "correction" ? 9 : 8),
              "Interrupted distribution lost custody, produced output or concealed evaluator correction");
            const interrupted = actualEffects[0]?.result;
            requireProof(interrupted?.status === "unknown" && evidence(interrupted).world_effect_emitted === true,
              "Interrupted emitted distribution was relabelled as a settled no-effect failure");
            if (scenario !== "stop") requireProof(typeof interruptedUi?.grid_count === "number" && interruptedUi.grid_count >= 2,
              "Partial-distribution perturbation did not actually include grid and cursor custody");
          }
          const latestUi = actualEffects.map(effect => uiEvidence(effect.result)).filter(value => value !== null).at(-1);
          requireProof(latestUi?.held === false, "Inventory cleanup retained a pressed gesture");
          if (["positive", "surplus", "split", "variants", "components", "full"].includes(scenario))
            requireProof(latestUi?.closed === true && latestUi.cursor_count === 0 && latestUi.grid_count === 0,
              "Settled inventory outcome lacks closed empty cursor/grid proof");
          // A replaced handler's last cursor/grid is retained historical custody,
          // not rollback. Current handler cleanup is sampled independently above.
          if (recorder) {
            const recording = await recorder.finish({endedAt: Date.now(), reason: `visible_inventory_${scenario}_settled`});
            entry.recording = recording;
            requireProof(recording.status === "complete", "Native inventory recording incomplete");
            entry.replay = await recorder.renderReplay({signal: scope.signal});
          }
          entry.claim = "Evaluator-authored native mechanics/presentation only, not model intelligence or pacing proof";
        });
        requireProof(fixture.cases.at(-1)?.status === "passed", `Inventory ${scenario} case failed; no later case may hide it`);
        recorder = undefined;
      }
    } else {
    const run = await runtime.createRun({ task: "Disclosed synthetic mechanics fixture, not an autonomous task", goal, model_id: modelId, working_programs: "fresh" });
    runId = run.run_id;
    const stoneGoal = adapter.goals.find(goal => goal.goal_id === "craft_stone_pickaxe");
    requireProof(stoneGoal?.verifier, "Missing registered stone-pickaxe criterion");
    const scenario = selected === "stone" ? { id: "mechanical-stone-pickaxe", prompt: "Synthetic empty-inventory wood-to-stone-pickaxe fixture",
      adapter_goal_id: stoneGoal.goal_id, verifier: { revision: stoneGoal.verifier.id, version: stoneGoal.verifier.version, description: "Registered own stone-pickaxe production and fresh alive retention" } } :
      NATURAL_SCENARIOS.find(scenario => scenario.id === "collect_and_craft_table")!;
    const verifier = captureScenarioVerification(adapter, scenario, runId, initial, 1);
    const commandsBefore = fixture.commands.length;
    recorder = new EpisodeRecorder({ directory: path.join(fixture.evidenceDirectory, "recording"), bridge: fixture.bridge,
      identity: { episode_id: randomUUID(), run_id: runId, world_id: run.world_id, session_id: run.session_id! },
      limits: { maxDurationMs: 120_000, maxFrames: 4000, maxStoredFrameBytes: 2 * 1024 ** 3 }, onIncomplete: stop });
    await fixture.case(`approach_mine_pickup_planks_table${selected === "basic" ? "" : selected === "tool" ? "_wooden_pickaxe" : selected === "stone" ? "_stone_pickaxe" : "_assessed_parent_repair"}`, { synthetic_strategy: true, prepared_dry_grove: true, prepared_quarry: selected === "stone", assessed_parent_repair: selected === "repair", supplied_inventory: false, daylight_frozen: true, model_inference: false }, async entry => {
      open(); await runtime!.control(runId!, "start");
      await bounded(admission.promise, 20_000, "Synthetic tool admission timed out"); open();
      const execution = await until(async () => { open(); return store!.latestRootExecution(runId!); }, value => Boolean(value && ["succeeded", "blocked", "failed", "cancelled", "unknown"].includes(value.status)), caps.runMs, "Mechanical root did not close within declared bound");
      entry.execution = execution;
      requireProof(execution?.status === "succeeded", `Mechanical root did not succeed: ${JSON.stringify(execution)}`);
      if (selected === "repair") {
        const executions = store!.allSkillExecutions(runId!);
        const events = store!.eventsAfter(runId!, 0, 500);
        requireProof(executions.length === 2 && executions.some(parent => parent.status === "blocked" && parent.version === 1) &&
          execution.version === 2 && events.filter(event => event.type === "learning.candidate_written").length === 1,
          "Assessed-parent repair lost its immutable parent or candidate linkage");
        entry.assessed_parent_repair = { executions, linkage: events.filter(event => event.type === "learning.candidate_written" || event.type === "learning.resolved") };
      }
      const final = await fixture.observe();
      entry.final_observation = final;
      const actions = effects.flatMap(effect => {
        const action = store!.getAction(runId!, effect.action_id);
        return action ? [{ ...action, run_id: runId! }] : [];
      });
      // Independent interpreter receives sealed actions and fresh observations, never Runtime's verdict.
      const verification = verifyScenarioCompletion(verifier, final, actions);
      entry.verification = verification;
      if (selected !== "tool") requireProof(verification.status === "verified", "Independent whole-fixture criterion not verified");
      else requireProof(final.data.player.inventory.some(item => item.name === "wooden_pickaxe" && item.count === 1), "Wooden pickaxe consequence missing");
      const approach = effects.find(effect => effect.action.kind === "navigate");
      requireProof(approach?.result && evidence(approach.result).effect_confirmed === true, "First real approach has no confirmed effect");
      requireProof(Math.hypot(final.data.player.position.x-initial.data.player.position.x, final.data.player.position.z-initial.data.player.position.z) > 1, "No actual approach displacement");
      requireProof(effects.some(effect => effect.action.kind === "dig" && effect.result && evidence(effect.result).effect_confirmed === true), "No confirmed native mining");
      requireProof(fixture.commands.length === commandsBefore && peak === 1, "Fixture intervention or overlapping effects during chain");
      await runtime!.control(runId!, "stop"); open();
      const diagnostics = await fixture.diagnostics();
      requireProof(diagnostics.controls_neutral && !diagnostics.motor_active && concurrent === 0, "Stop did not neutralize/drain");
      const recording = await recorder!.finish({ endedAt: Date.now(), reason: "mechanical_chain_completed" });
      entry.recording = recording;
      requireProof(recording.status === "complete", "Recording incomplete");
      entry.replay = await recorder!.renderReplay({ signal: scope.signal });
      entry.frame = await fixture.frame("mechanical-outcome");
      entry.goal_claim = "Mechanical fixture only; no model competence";
    });
    }
    if (fixture.cases.some(entry => entry.status !== "passed")) failure ??= new Error("Mechanical chain failed; retain evidence and diagnose first consequence");
  } catch (error) { failure ??= error; }
  finally {
    release?.();
    const cleanup: Array<{ resource: string; closed: boolean }> = [];
    fixture.report.resource_cleanup = cleanup;
    const settle = async (resource: string, operation: () => unknown | Promise<unknown>) => {
      const entry = { resource, closed: false }; cleanup.push(entry);
      try { await operation(); entry.closed = true; }
      catch (error) {
        failure ??= error; process.exitCode = 1;
        fixture.report.cleanup_failure = `Owner or evidence finalization failed: ${resource}`;
      }
    };
    try {
      await settle("runtime", () => runtime?.close());
      await settle("synthetic_agent", () => active);
      await settle("recording", async () => { if (recorder) {
        fixture.report.recording = await recorder.finish({ endedAt: Date.now(), reason: failure ? "failed" : "completed" });
        if (failure && !scope.signal.aborted) {
          try { fixture.report.failure_replay = await recorder.renderReplay({ signal: scope.signal }); } catch { fixture.report.failure_replay = "render_failed_original_frames_retained"; }
        }
      } });
      await settle("runtime_evidence", async () => {
        if (store && runId) await fixture.writeJson("runtime-evidence.json", selected === "approach" || selected === "inventory" ?
          { runs: (selected === "inventory" ? inventoryRunIds : probeRunIds).map(id => ({ run: store!.getRun(id), events: store!.eventsAfter(id,0,500), executions: store!.allSkillExecutions(id) })), effects, parent_polls: parentPolls, transcript } :
          { run: store.getRun(runId), events: store.eventsAfter(runId,0,500), executions: store.allSkillExecutions(runId), effects, transcript });
      });
      await settle("sandbox", () => sandbox?.close());
      await settle("store", () => store?.close());
      await settle("native", async () => {
        nativeDrain ??= fixture.close();
        requireProof((await nativeDrain).closed, "Native fixture drain unconfirmed");
      });
      fixture.report.peak_simultaneous_effects = peak;
      await fixture.finish(failure);
      console.log(JSON.stringify({ report: path.join(fixture.evidenceDirectory,"report.json"), replay: selected === "approach" ?
        probeStages.map(stage => path.join(fixture.evidenceDirectory,`recording-${stage}/replay.mp4`)) :
        path.join(fixture.evidenceDirectory, selected === "inventory" ? "recording-inventory-positive/replay.mp4" : "recording/replay.mp4"), actual_provider_calls: 0 }));
    } finally { clearTimeout(deadline); completed.resolve(); unregister(); }
  }
}
if (import.meta.main) await runNativeMinecraftMechanics(process.argv.slice(2));
