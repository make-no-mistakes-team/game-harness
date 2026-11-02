import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { liveStudyManifest } from './helpers/study-manifest.ts';
import { DEFAULT_RESIDENT_BENCHMARK_PROTOCOL, RESIDENT_BENCHMARK_SOURCE, residentBenchmarkSchedule, validateResidentBenchmarkDeclaration } from '../src/evaluation/resident-benchmark.ts';
import * as benchmark from '../src/evaluation/resident-benchmark.ts';
import type { GameState } from '../src/shared/contracts.ts';
import { minecraftTestAdapter, minecraftTestBinding } from './helpers/adapter-contract.ts';
const roots: string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(mode:'cohort'|'calibration'='cohort') {
  const root=mkdtempSync(join(tmpdir(),'gameharness-resident-benchmark-')); roots.push(root);
  const manifest=liveStudyManifest(root,'resident-benchmark-boundary');
  const protocol={...structuredClone(DEFAULT_RESIDENT_BENCHMARK_PROTOCOL),mode};
  const checked=(path:string,text:string)=>{writeFileSync(join(root,path),text);return {path,sha256:createHash('sha256').update(text).digest('hex')};};
  manifest.permission.record=checked('permission.txt','Local zero-provider technical benchmark fixture; no native or provider launch.');
  manifest.task.text='Measure native resident independence; not agent competence';manifest.task.identity=checked('task.txt',manifest.task.text);
  manifest.task.verifier=checked('protocol.json',JSON.stringify(protocol));manifest.task.horizon_ms=165000;
  manifest.identities.controller=checked('controller.mjs',RESIDENT_BENCHMARK_SOURCE);manifest.identities.model=null;
  manifest.execution={...manifest.execution,controller_mode:'resident_platform',adaptation:'none',start_mode:'evaluator_prepared_world',request_paths:[]};
  const profile=manifest.identities.profile;
  const rates=mode==='calibration'?[20]:[1,5,20],delays=mode==='calibration'?[15000]:[15000,30000,90000];
  manifest.arms=rates.map(rate=>({id:`hertz_${rate}`,description:'Synthetic mechanical source only',model:null,helpers:[],profile}));
  manifest.initial_states=delays.map(delay=>({id:`delay_${delay}`,mode:'evaluator_prepared_world',seed:null,save:null,
    settings:{difficulty:'normal',gamemode:'survival',cheats:true,level_type:'minecraft:normal',structures:true,hardcore:false,supplied_inventory:true,console_commands:true,fresh_world_per_slot:true}}));
  manifest.repetitions=mode==='cohort'?3:1;manifest.optional_blocks=[];
  manifest.schedule=residentBenchmarkSchedule(manifest.study_id,mode);
  manifest.allowances={per_attempt:{host_requests:0,concurrent_requests:0,workers:1,wall_ms:240000},cohort:{host_requests:0,concurrent_requests:0,workers:1,attempt_wall_ms:240000*manifest.schedule.length,elapsed_ms:10800000}};
  const update=()=>{manifest.task.verifier=checked('protocol.json',JSON.stringify(protocol));};
  return {root,manifest,protocol,update,parse:()=>validateResidentBenchmarkDeclaration(manifest,{projectRoot:root})};
}

test('benchmark refuses a missing, repeated or relabelled cell rather than claiming a partial cohort as E01',()=>{
  for(const change of ['missing rate','duplicate row','wrong repetition','reordered','optional']as const){
    const f=fixture();f.parse();
    if(change==='missing rate')f.manifest.schedule=f.manifest.schedule.filter(row=>row.slot.arm!=='hertz_5');
    if(change==='duplicate row')f.manifest.schedule[1]={...f.manifest.schedule[1]!,slot:{...f.manifest.schedule[0]!.slot}};
    if(change==='wrong repetition')f.manifest.schedule[0]!.slot.repetition=4;
    if(change==='reordered')[f.manifest.schedule[0],f.manifest.schedule[1]]=[f.manifest.schedule[1]!,f.manifest.schedule[0]!];
    if(change==='optional')f.manifest.schedule[0]!.optional_block='skip';
    expect(()=>f.parse()).toThrow();
  }
});

test('calibration remains separately labelled and cannot substitute for the prespecified cohort',()=>{
  const f=fixture('calibration');const parsed=f.parse();
  expect(parsed.protocol.mode).toBe('calibration');
  expect(parsed.cells[0]).toMatchObject({frequency_hz:20,delay_ms:15000,repetition:1});
  f.protocol.mode='cohort';f.update();expect(()=>f.parse()).toThrow();
});

test('new E01 admission requires 50/100 ms and rejects the superseded 75 ms declaration',()=>{
  const f=fixture();
  f.protocol.acceptance={p95_ms:50,p99_ms:100,max_gap_ms:1000};
  f.update();
  const admitted=f.parse();
  expect(admitted.cells).toHaveLength(27);
  f.protocol.acceptance.p95_ms=75;
  f.update();
  expect(()=>f.parse()).toThrow();
});

test('benchmark rejects shortened waits, insufficient lifetime/evidence capacity and changed controller identity',()=>{
  for(const change of ['warmup','measurement','root lifetime','storage','controller','provider','relaxed target']as const){
    const f=fixture();
    if(change==='warmup')f.protocol.warmup_ms=0;
    if(change==='measurement')f.protocol.measurement_ms=1000;
    if(change==='root lifetime')f.manifest.task.horizon_ms=150000;
    if(change==='storage')f.protocol.recording.maxStoredFrameBytes=0;
    if(change==='controller')f.manifest.identities.controller={...f.manifest.identities.controller!,sha256:'f'.repeat(64)};
    if(change==='provider')f.manifest.allowances.per_attempt.host_requests=1;
    if(change==='relaxed target')f.protocol.acceptance.p95_ms=100;
    f.update();expect(()=>f.parse()).toThrow();
  }
});

test('benchmark rejects unsupported terrain and structure declarations before native admission',()=>{
  for(const settings of [{level_type:'minecraft:flat'},{structures:false}]){
    const f=fixture();
    Object.assign(f.manifest.initial_states[0]!.settings!,settings);
    expect(()=>f.parse()).toThrow(/normal|structures/);
  }
});

test('actual owned world properties are checked and only safe selected settings are retained',()=>{
  expect(typeof benchmark.checkResidentBenchmarkWorldProperties).toBe('function');
  const check=benchmark.checkResidentBenchmarkWorldProperties;
  const properties='gamemode=survival\nforce-gamemode=true\ndifficulty=normal\nhardcore=false\nlevel-type=minecraft\\:normal\ngenerate-structures=true\nlevel-seed=PRIVATE\nrcon.password=SECRET\n';
  expect(check(properties)).toEqual({gamemode:'survival','force-gamemode':'true',difficulty:'normal',hardcore:'false',
    'level-type':'minecraft:normal','generate-structures':'true'});
  expect(()=>check(properties.replace('generate-structures=true','generate-structures=false'))).toThrow();
  expect(()=>check(properties.replace('minecraft\\:normal','minecraft\\:flat'))).toThrow();
  expect(()=>check(`${properties}difficulty=peaceful\n`)).toThrow();
});

test('decision-window latency includes a final slow confirmed ACK received after the window',()=>{
  expect(typeof benchmark.residentBenchmarkDecisionPopulation).toBe('function');
  const population=benchmark.residentBenchmarkDecisionPopulation({
    start:100,end:200,
    submissions:[
      {host_ms:110,captured_host_ms:105,frame_seq:1,result:{sequence:1,status:'submitted',reason:null}},
      {host_ms:195,captured_host_ms:190,frame_seq:2,result:{sequence:2,status:'submitted',reason:null}},
      {host_ms:205,captured_host_ms:205,frame_seq:3,result:{sequence:3,status:'submitted',reason:null}},
    ],
    acks:[
      {received_host_ms:115,age_ms:10,ack:{sequence:1,input_application:'confirmed'}},
      {received_host_ms:250,age_ms:120,ack:{sequence:2,input_application:'confirmed'}},
      {received_host_ms:210,age_ms:5,ack:{sequence:3,input_application:'confirmed'}},
    ],
    terminalReason:'benchmark_full_original_window_completed',
  });
  expect(population.input_age_ms).toMatchObject({count:2,p95:120,p99:120,max:120,omitted_samples:0});
  expect(population.confirmed_after_window).toBe(1);
  expect(population.decisions.map(row=>row.disposition)).toEqual(['confirmed','confirmed']);
});

test('evaluator settlement waits for the last measured ACK without admitting a post-window decision', async()=>{
  const acks:Array<{received_host_ms:number;age_ms:number;ack:{sequence:number;input_application:'confirmed'}}>=[];
  const read=()=>benchmark.residentBenchmarkDecisionPopulation({start:100,end:200,terminalReason:null,
    frames:[{frame_seq:7,captured_host_ms:150},{frame_seq:8,captured_host_ms:201}],
    submissions:[
      {frame_seq:7,captured_host_ms:150,host_ms:160,result:{sequence:11,status:'submitted',reason:null}},
      {frame_seq:8,captured_host_ms:201,host_ms:211,result:{sequence:12,status:'submitted',reason:null}},
    ],acks});
  const timer=setTimeout(()=>acks.push({received_host_ms:300,age_ms:120,ack:{sequence:11,input_application:'confirmed'}}),15);
  try {
    const settled=await benchmark.settleResidentBenchmarkMeasuredInputs(read,{
      signal:new AbortController().signal,deadline_host_ms:performance.now()+1000,current:()=>true});
    expect(settled).toMatchObject({admitted_decisions:1,confirmed_decisions:1,unconfirmed_decisions:0,
      confirmed_after_window:1,input_age_ms:{count:1,p95:120,max:120}});
    expect(settled.decisions.map(row=>row.frame_seq)).toEqual([7]);
  } finally {clearTimeout(timer);}
});

test('user Stop aborts measured-frontier waiting instead of waiting for an application or the root deadline',async()=>{
  const controller=new AbortController(),stop=new Error('Actual user Stop');
  const read=()=>benchmark.residentBenchmarkDecisionPopulation({start:100,end:200,terminalReason:null,
    submissions:[{frame_seq:7,captured_host_ms:150,host_ms:160,result:{sequence:11,status:'submitted',reason:null}}],acks:[]});
  const timer=setTimeout(()=>controller.abort(stop),15);
  try {
    await expect(benchmark.settleResidentBenchmarkMeasuredInputs(read,{
      signal:controller.signal,deadline_host_ms:performance.now()+1000,current:()=>true})).rejects.toBe(stop);
  } finally {clearTimeout(timer);}
});

test('a confirmed measured population cannot revive an expired or no-longer-current root',async()=>{
  const read=()=>benchmark.residentBenchmarkDecisionPopulation({start:100,end:200,terminalReason:null,
    submissions:[{frame_seq:7,captured_host_ms:150,host_ms:160,result:{sequence:11,status:'submitted',reason:null}}],
    acks:[{received_host_ms:190,age_ms:30,ack:{sequence:11,input_application:'confirmed'}}]});
  for(const root of [{deadline_host_ms:performance.now()-1,current:()=>true},
    {deadline_host_ms:performance.now()+1000,current:()=>false}]){
    await expect(benchmark.settleResidentBenchmarkMeasuredInputs(read,{
      signal:new AbortController().signal,...root})).rejects.toThrow();
  }
});

test('confirmed settlement cannot cross the original deadline inside synchronous authority or population reads',async()=>{
  const confirmed=()=>benchmark.residentBenchmarkDecisionPopulation({start:100,end:200,terminalReason:null,
    submissions:[{frame_seq:7,captured_host_ms:150,host_ms:160,result:{sequence:11,status:'submitted',reason:null}}],
    acks:[{received_host_ms:190,age_ms:30,ack:{sequence:11,input_application:'confirmed'}}]});
  for(const slow of ['authority','population']){
    const deadline=performance.now()+25;
    const cross=()=>Bun.sleepSync(Math.max(0,deadline-performance.now()+2));
    await expect(benchmark.settleResidentBenchmarkMeasuredInputs(
      ()=>{if(slow==='population')cross();return confirmed();},
      {signal:new AbortController().signal,deadline_host_ms:deadline,current:()=>{if(slow==='authority')cross();return true;}},
    )).rejects.toThrow();
  }
});

test('an abort during a confirmed population read remains Stop rather than normal completion',async()=>{
  const controller=new AbortController(),stop=new Error('Stop during reconstruction');
  await expect(benchmark.settleResidentBenchmarkMeasuredInputs(()=>{
    controller.abort(stop);
    return benchmark.residentBenchmarkDecisionPopulation({start:100,end:200,terminalReason:null,
      submissions:[{frame_seq:7,captured_host_ms:150,host_ms:160,result:{sequence:11,status:'submitted',reason:null}}],
      acks:[{received_host_ms:190,age_ms:30,ack:{sequence:11,input_application:'confirmed'}}]});
  },{signal:controller.signal,deadline_host_ms:performance.now()+1000,current:()=>true})).rejects.toBe(stop);
});

test('native scope loss rejects frontier settlement while resident status is still running',async()=>{
  const binding=minecraftTestBinding(minecraftTestAdapter());
  const state:GameState={status:'connected',username:'fixture',version:'1.21.4',world_id:'world',epoch:1,session_id:'session',
    life:{life_id:1,status:'alive',can_respawn:false,death:null},binding,space:{dimension_id:'minecraft:overworld',space_epoch:1},
    screen:null,presentation:null,video:{status:'idle',width:0,height:0,fps:null,frames:0,last_frame_at:null,error:null},
    last_observation_at:null,error:null};
  const scope={world_id:'world',session_id:'session',native_boot_id:'fixture-native-boot',epoch:1,life_id:1,space_epoch:1};
  expect(benchmark.residentBenchmarkNativeScopeCurrent(state,scope)).toBe(true);
  await expect(benchmark.settleResidentBenchmarkMeasuredInputs(()=>{
    state.space={dimension_id:'minecraft:overworld',space_epoch:2};
    return benchmark.residentBenchmarkDecisionPopulation({start:100,end:200,terminalReason:null,
      submissions:[{frame_seq:7,captured_host_ms:150,host_ms:160,result:{sequence:11,status:'submitted',reason:null}}],
      acks:[{received_host_ms:190,age_ms:30,ack:{sequence:11,input_application:'confirmed'}}]});
  },{signal:new AbortController().signal,deadline_host_ms:performance.now()+1000,
    current:()=>benchmark.residentBenchmarkNativeScopeCurrent(state,scope)})).rejects.toThrow();
  const invalidStates:GameState[]=[
    {...state,space:{dimension_id:'minecraft:overworld',space_epoch:1},world_id:'other'},
    {...state,space:{dimension_id:'minecraft:overworld',space_epoch:1},session_id:'other'},
    {...state,space:{dimension_id:'minecraft:overworld',space_epoch:1},epoch:2},
    {...state,space:{dimension_id:'minecraft:overworld',space_epoch:1},binding:minecraftTestBinding(minecraftTestAdapter(),'other-boot')},
    {...state,space:{dimension_id:'minecraft:overworld',space_epoch:1},life:{life_id:2,status:'alive',can_respawn:false,death:null}},
    {...state,space:{dimension_id:'minecraft:overworld',space_epoch:1},binding:null},
    {...state,space:{dimension_id:'minecraft:overworld',space_epoch:1},error:'transport failure'},
  ];
  for(const invalid of invalidStates)expect(benchmark.residentBenchmarkNativeScopeCurrent(invalid,scope)).toBe(false);
});

test('terminal decisions retain censoring, partial, unknown, refused and coalesced dispositions',()=>{
  expect(typeof benchmark.residentBenchmarkDecisionPopulation).toBe('function');
  const population=benchmark.residentBenchmarkDecisionPopulation({
    start:100,end:200,
    submissions:[
      {host_ms:110,captured_host_ms:105,frame_seq:1,result:{sequence:1,status:'submitted',reason:null}},
      {host_ms:120,captured_host_ms:115,frame_seq:2,result:{sequence:2,status:'coalesced',reason:null}},
      {host_ms:130,captured_host_ms:125,frame_seq:3,result:{sequence:3,status:'submitted',reason:null}},
      {host_ms:140,captured_host_ms:135,frame_seq:4,result:{sequence:4,status:'submitted',reason:null}},
      {host_ms:150,captured_host_ms:145,frame_seq:5,result:{sequence:4,status:'rejected',reason:'fenced'}},
    ],
    acks:[
      {received_host_ms:140,age_ms:null,ack:{sequence:2,input_application:'partial'}},
      {received_host_ms:150,age_ms:null,ack:{sequence:3,input_application:'unknown'}},
    ],
    terminalReason:'benchmark_full_original_window_completed',
  });
  expect(population.decisions.map(row=>row.disposition)).toEqual(['coalesced','partial','unknown','terminal_censored','refused']);
  expect(population).toMatchObject({admitted_decisions:5,confirmed_decisions:0,unconfirmed_decisions:5,
    full_population_confirmed:false,input_age_ms:{count:0,omitted_samples:5}});
  expect(population.decisions[3]).toMatchObject({terminal_reason:'benchmark_full_original_window_completed'});
});

test('a measured frame cancelled during worker evaluation remains an explicit unsubmitted decision',()=>{
  expect(typeof benchmark.residentBenchmarkDecisionPopulation).toBe('function');
  const population=benchmark.residentBenchmarkDecisionPopulation({start:100,end:200,submissions:[],acks:[],
    frames:[{frame_seq:7,captured_host_ms:190}],terminalReason:'benchmark_full_original_window_completed'});
  expect(population).toMatchObject({admitted_decisions:1,unconfirmed_decisions:1,full_population_confirmed:false,
    input_age_ms:{count:0,omitted_samples:1}});
  expect(population.decisions[0]).toMatchObject({frame_seq:7,result:null,disposition:'terminal_censored',
    terminal_reason:'benchmark_full_original_window_completed',age_ms:null});
});
