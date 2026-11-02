import { afterEach, expect, test, vi } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as runner from '../scripts/native-resident-benchmark.ts';
import { StudyLedger } from '../src/evaluation/studies.ts';
import { studyManifest } from './helpers/study-manifest.ts';
import { closeResidentBenchmarkNativeAfterDrain, waitResidentBenchmarkUntil } from '../src/evaluation/resident-benchmark.ts';

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function ownership(){
  const root=mkdtempSync(join(tmpdir(),'resident-benchmark-process-'));roots.push(root);
  const manifest=studyManifest(root);manifest.allowances.per_attempt.workers=1;manifest.allowances.cohort.workers=1;
  const ledger=new StudyLedger(join(root,'governance'),{projectRoot:root});
  const ref=ledger.registerStudy(manifest),reservation=ledger.reserveStudyAttempt(ref,manifest.schedule[0]!.slot);
  return {ledger,ref,reservation};
}
function observedMessage(value:unknown):string|null{
  return value!==null&&typeof value==='object'&&'observed'in value&&typeof value.observed==='string'?value.observed:null;
}

// Real reusable process supervisor, with short admitted deadlines. No native owner,
// source rewriting, fake close event or timer substituted for process drain.
const controlledChild=`
process.on('SIGTERM',()=>process.send({observed:'term'}));
process.on('message',message=>{
  if(message==='finalize') {
    const entered=Date.now();
    // Finalization has begun, but IPC notification can be delivered after the
    // work cutoff. It must not turn an in-budget cleanup into SIGTERM failure.
    setTimeout(()=>process.send({type:'resident_benchmark_phase',version:1,phase:'finalizing',entered_epoch_ms:entered}),600);
    process.send({observed:'finalizing'});
  }
  if(message==='finish') process.exit(0);
});
process.send({observed:'ready'});
`;

test('in-budget finalization survives the work cutoff and release waits actual OS close',async()=>{
  expect(typeof runner.launchResidentBenchmarkChild).toBe('function');
  const started=Date.now(),deadline=started+1600;
  let closed=false,term=false;
  let beforeRelease:unknown;
  const owner=ownership();
  try {
  const observed=await runner.launchResidentBenchmarkChild({
    command:process.execPath,args:['--no-env-file','-e',controlledChild],cwd:process.cwd(),env:process.env,
    deadlineEpochMs:deadline,cleanupMs:1100,
    setChild(child){
      if(!child){closed=true;return;}
      child.on('message',message=>{
        if(observedMessage(message)==='term')term=true;
        if(observedMessage(message)==='ready')child.send('finalize');
        // Release only after the deliberately delayed phase notice arrives.
        // An absolute finish timer could beat that notice after SQLite setup
        // or process startup, legitimately making the supervisor fail closed.
        if(message!==null&&typeof message==='object'&&'type'in message&&message.type==='resident_benchmark_phase'){
          beforeRelease={closed,cleanup_confirmed:owner.ledger.readStudy(owner.ref).attempts[0]!.cleanup.confirmed,
            after_work_cutoff:Date.now()>=deadline-1100};
          child.send('finish');
        }
      });
    },
  });
  expect(beforeRelease).toEqual({closed:false,cleanup_confirmed:false,after_work_cutoff:true});
  expect(term).toBe(false);
  expect(observed).toMatchObject({close_observed:true,exit_code:0,deadline_requested:false,kill_requested:false,phase:'finalizing'});
  expect(closed).toBe(true);
  expect(runner.residentBenchmarkCleanupConfirmed(observed,{cleanup_confirmed:true})).toBe(true);
  owner.ledger.settleStudyAttempt(owner.reservation,{outcome:{platform_status:'pass',agent_status:'not_run',provider_status:'not_called',
    goal_verified:null,classification_reason:['Controlled process lifecycle only; no native resources or provider calls']},
    usage:null,evidence:['Actual controlled child OS close after finalization'],stop_reason:null});
  owner.ledger.confirmStudyResourceDrain(owner.reservation,{requests_drained:true,runtime_closed:true,native_closed:true,
    evidence:['Controlled process closed; no native owner was launched in this lifecycle regression']});
  expect(owner.ledger.readStudy(owner.ref).attempts[0]!.cleanup.confirmed).toBe(true);
  } finally {owner.ledger.close();}
});

test('over-total finalization is killed at the original deadline and cannot confirm resource release',async()=>{
  expect(typeof runner.launchResidentBenchmarkChild).toBe('function');
  const deadline=Date.now()+800;
  const owner=ownership();
  try {
  const observed=await runner.launchResidentBenchmarkChild({
    command:process.execPath,args:['--no-env-file','-e',controlledChild],cwd:process.cwd(),env:process.env,
    deadlineEpochMs:deadline,cleanupMs:500,
    setChild(child){
      child?.on('message',message=>{if(observedMessage(message)==='ready')child.send('finalize');});
    },
  });
  expect(observed).toMatchObject({close_observed:true,deadline_requested:true,kill_requested:true,signal:'SIGKILL'});
  expect(runner.residentBenchmarkCleanupConfirmed(observed,{cleanup_confirmed:true})).toBe(false);
  owner.ledger.settleStudyAttempt(owner.reservation,{outcome:{platform_status:'unknown',agent_status:'not_run',provider_status:'not_called',
    goal_verified:null,classification_reason:['Controlled child exceeded total bound; native drain is unconfirmed']},
    usage:null,evidence:['Observed actual controlled child SIGKILL and OS close'],stop_reason:'invalid_platform'});
  expect(owner.ledger.readStudy(owner.ref).attempts[0]).toMatchObject({state:'settled',cleanup:{confirmed:false},
    settlement:{outcome:{platform_status:'unknown'}}});
  } finally {owner.ledger.close();}
});

test('pre-native admission failure releases an uncreated owner without inventing a native report',()=>{
  const owner=ownership(), directory=mkdtempSync(join(tmpdir(),'resident-benchmark-result-'));
  roots.push(directory);
  const reportPath=join(directory,'slot-report.json');
  const result={study_id:owner.ref.studyId,reservation_id:owner.reservation.reservationId,slot:owner.reservation.slot,
    platform_status:'fail',cleanup_confirmed:true,report:reportPath,native_report:null,classification:'technical'};
  const report={native_fixture_created:false,full_window_completed:false,final_resident:null,native_retirements:[],
    cleanup:{confirmed:true,resident_worker_closed:true,resident_native_retired:true,sandbox_closed:true,store_closed:true,
      native_closed:true,runtime_closed:true,recorder_closed:true,journal_closed:true},
    media:{recording_manifest:null,frames:null,replay:null,playback:'pending_full_original_speed_review'}};
  const save=()=>{writeFileSync(reportPath,JSON.stringify(report));writeFileSync(join(directory,'platform-result.json'),JSON.stringify(result));};
  try {
    save();
    expect(runner.validateResult(directory,owner.reservation).result).toMatchObject({platform_status:'fail',cleanup_confirmed:true});
    for(const created of [true,undefined]){
      Object.assign(report,{native_fixture_created:created});save();
      expect(()=>runner.validateResult(directory,owner.reservation)).toThrow(/native/i);
    }
    Object.assign(report,{native_fixture_created:false,final_resident:{run_id:'unproven-owner'}});save();
    expect(()=>runner.validateResult(directory,owner.reservation)).toThrow(/native/i);
  } finally {owner.ledger.close();}
});

test('an early timer notification cannot shorten the original monotonic warmup deadline',async()=>{
  vi.useFakeTimers();
  const clock=vi.spyOn(performance,'now').mockReturnValue(1000.4),abort=new AbortController();
  let finished=false;
  const waiting=waitResidentBenchmarkUntil(1030.4,abort.signal).then(()=>{finished=true;});
  try {
    clock.mockReturnValue(1030);vi.advanceTimersByTime(30);
    for(let index=0;index<8;index++)await Promise.resolve();
    expect(finished).toBe(false);
    clock.mockReturnValue(1030.4);vi.advanceTimersByTime(1);
    await waiting;expect(finished).toBe(true);
  } finally {abort.abort();await waiting.catch(()=>{});clock.mockRestore();vi.useRealTimers();}
});

test('abort during a remaining fractional wait rejects without extending or completing the interval',async()=>{
  vi.useFakeTimers();
  const clock=vi.spyOn(performance,'now').mockReturnValue(0),abort=new AbortController();
  const reason=new Error('Original scope closed');
  const outcome=waitResidentBenchmarkUntil(10.5,abort.signal).then(()=>null,error=>error);
  try {
    clock.mockReturnValue(10.1);vi.advanceTimersByTime(10);
    abort.abort(reason);expect(await outcome).toBe(reason);
  } finally {abort.abort(reason);clock.mockRestore();vi.useRealTimers();}
});

for(const rejects of [false,true])test(`native fixture teardown waits actual resident drain settlement: rejects=${rejects}`,async()=>{
  const gate=Promise.withResolvers<void>(),drainError=new Error('Resident retirement unknown');
  const drain=gate.promise.then(()=>{if(rejects)throw drainError;});
  let fixtureClosed=false,finished=false,drainFailure:unknown;
  void drain.catch(error=>{drainFailure=error;});
  const closing=closeResidentBenchmarkNativeAfterDrain(drain,async()=>{
    fixtureClosed=true;return {closed:true};
  }).then(result=>{finished=true;return result;});
  for(let index=0;index<8;index++)await Promise.resolve();
  const before={fixtureClosed,finished};
  gate.resolve();
  expect(await closing).toEqual({closed:true});
  expect(before).toEqual({fixtureClosed:false,finished:false});
  expect(drainFailure).toBe(rejects?drainError:undefined);
});
