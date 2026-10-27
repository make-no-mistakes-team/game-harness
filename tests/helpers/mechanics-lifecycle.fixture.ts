import { mock } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { minecraftTestAdapter, minecraftObservationFixture } from "./adapter-contract.ts";
import * as native from "../../src/evaluation/native-game.ts";
import * as tiers from "../../src/evaluation/tiers.ts";
const [mode,root] = process.argv.slice(2);
if (!root) throw new Error("Missing private fixture root");
const ownership = {native_closed:false,runtime_closed:false,sandbox_closed:false,store_closed:false};
const persist = () => writeFile(path.join(root,"ownership.json"),JSON.stringify(ownership));
await persist();
const startup=Promise.withResolvers<void>();
const adapter=minecraftTestAdapter();
const observation=minecraftObservationFixture(adapter);
const bridge={observe:async()=>observation,adapter:()=>adapter,execute:async()=>{throw new Error("No game effects in cleanup fixture");}};
mock.module(path.resolve(import.meta.dir,"../../src/evaluation/tiers.ts"),()=>({...tiers,assertNativeArtifactFresh:()=>({jarPath:"synthetic.jar",sha256:"a".repeat(64)})}));
mock.module(path.resolve(import.meta.dir,"../../src/evaluation/native-game.ts"),()=>({...native,NativeFixture:{create:async()=>({
 root,evidenceDirectory:root,cases:[],commands:[],report:{},bridge,
 start:async()=>{if(mode==="startup-signal"){
   // Actual SIGTERM/postmortem ownership cannot be exercised by fake timers.
   setTimeout(()=>process.kill(process.pid,"SIGTERM"),10);await startup.promise;
 }},flat:async()=>{},console:async()=>{},observe:async()=>observation,
 close:async()=>{ownership.native_closed=true;await persist();startup.resolve();return {closed:true};},
 case:async()=>{throw new Error("Injected case failure after recorder acquisition");},
 writeJson:async()=>{if(mode==="evidence-failure")throw new Error("Injected evidence storage failure");},
 finish:async(error:unknown)=>{ownership.native_closed=true;await persist();if(error)process.exitCode=1;},
})}}));
mock.module(path.resolve(import.meta.dir,"../../src/server/store.ts"),()=>({Store:class{
 getRun(){return {};}eventsAfter(){return [];}allSkillExecutions(){return [];}
 close(){ownership.store_closed=true;return persist();}
}}));
mock.module(path.resolve(import.meta.dir,"../../src/server/runtime.ts"),()=>({Runtime:class{
 async initialize(){}async createRun(){return {run_id:"synthetic-run",world_id:"world",session_id:"session"};}
 async close(){ownership.runtime_closed=true;await persist();}
}}));
mock.module(path.resolve(import.meta.dir,"../../src/server/sandbox.ts"),()=>({SandboxService:class{
 async prepare(){}snapshot(){return {status:"ready"};}
 async close(){ownership.sandbox_closed=true;await persist();}
}}));
mock.module(path.resolve(import.meta.dir,"../../src/server/recording.ts"),()=>({EpisodeRecorder:class{
 async finish(){if(mode==="recorder-failure")throw new Error("Injected recording manifest failure");return {status:"complete"};}
 async renderReplay(){return "synthetic-no-video";}
}}));
const {runNativeMinecraftMechanics}=await import("../../scripts/native-minecraft-mechanics.ts");
await runNativeMinecraftMechanics(["--allow-native","--jar","synthetic.jar"]);
