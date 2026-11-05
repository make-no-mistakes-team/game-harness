import { afterEach, expect, test, vi } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as runner from '../scripts/native-resident-benchmark.ts';
import { StudyLedger } from '../src/evaluation/studies.ts';
import { studyManifest } from './helpers/study-manifest.ts';
import { closeResidentBenchmarkNativeAfterDrain, waitResidentBenchmarkUntil } from '../src/evaluation/resident-benchmark.ts';
import { HistoryReader } from '../src/server/history-reader.ts';
import { historyFixture } from './helpers/history-fixture.ts';
import { P13_VOLUME_CLASSIFICATION } from '../src/evaluation/resident-volume.ts';
import { osMonotonicNs } from '../src/evaluation/os-monotonic.ts';

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function ownership(){
  const root=mkdtempSync(join(tmpdir(),'resident-benchmark-process-'));roots.push(root);
  const manifest=studyManifest(root);manifest.allowances.per_attempt.workers=1;manifest.allowances.cohort.workers=1;
  const ledger=new StudyLedger(join(root,'governance'),{projectRoot:root});
  const ref=ledger.registerStudy(manifest),reservation=ledger.reserveStudyAttempt(ref,manifest.schedule[0]!.slot);
  return {root,ledger,ref,reservation};
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
    cleanup:{confirmed:true,resident_worker_closed:true,resident_native_retired:true,sandbox_closed:true,history_reader_closed:true,store_closed:true,
      native_closed:true,runtime_closed:true,recorder_closed:true,journal_closed:true},
    media:{recording_manifest:null,frames:null,replay:null,playback:'pending_full_original_speed_review'}};
  const save=()=>{writeFileSync(reportPath,JSON.stringify(report));writeFileSync(join(directory,'platform-result.json'),JSON.stringify(result));};
  try {
    save();
    expect(runner.validateResult(directory,owner.reservation,"e01").result).toMatchObject({platform_status:'fail',cleanup_confirmed:true});
    for(const created of [true,undefined]){
      Object.assign(report,{native_fixture_created:created});save();
      expect(()=>runner.validateResult(directory,owner.reservation,"e01")).toThrow(/native/i);
    }
    Object.assign(report,{native_fixture_created:false,final_resident:{run_id:'unproven-owner'}});save();
    expect(()=>runner.validateResult(directory,owner.reservation,"e01")).toThrow(/native/i);
  } finally {owner.ledger.close();}
});

for(const mode of ['manifest-read','raw-timings-rename','final-result-rename'] as const)test(
  `SIGINT joins the real slot through durable publication while held at ${mode}`,async()=>{
    const owner=ownership(),directory=join(owner.root,'signal-slot'),manifestPath=join(owner.root,'invalid-manifest.json');
    // A real invalid declaration fences admission before NativeFixture.create.
    // The manifest-read case still performs this read after its explicit release.
    writeFileSync(manifestPath,'{}\n');
    const processOwner:{child:ChildProcess|null}={child:null};
    let closed=false,signals=0,releases=0,heldAcknowledgements=0;
    const sdkSignals:unknown[]=[],durable:string[]=[],protocolErrors:string[]=[];
    let beforeRelease:unknown,lateReportBeforeSignal:unknown;
    const send=(value:string)=>{
      const child=processOwner.child;
      if(child?.connected)child.send(value,error=>{if(error)protocolErrors.push(error.message);});
      else protocolErrors.push(`Child IPC closed before ${value}`);
    };
    const json=(name:string)=>JSON.parse(readFileSync(join(directory,name),'utf8'));
    const launched=runner.launchResidentBenchmarkChild({
      command:process.execPath,
      args:['--no-env-file',join(process.cwd(),'tests/helpers/resident-benchmark-signal.fixture.ts'),mode,
        JSON.stringify({project:owner.root,manifestPath,reservation:owner.reservation,reportDirectory:directory}),'--allow-native'],
      cwd:process.cwd(),
      env:{...process.env,GAMEHARNESS_NATIVE_PROOF:'1'},
      deadlineEpochMs:Date.now()+20_000,cleanupMs:10_000,
      setChild(value){
        processOwner.child=value;
        if(!value){closed=true;return;}
        value.on('message',message=>{
          if(message===null||typeof message!=='object'||!('fixture'in message)||
            message.fixture!=='resident-benchmark-signal'||!('event'in message))return;
          try {
            if(message.event==='ready'){
              if('seam'in message&&message.seam!==mode)protocolErrors.push('Unexpected held seam');
              if(signals!==0){protocolErrors.push('Duplicate ready notification');return;}
              if(mode==='final-result-rename')lateReportBeforeSignal=json('slot-report.json');
              signals++;
              if(!value.kill('SIGINT'))protocolErrors.push('Owned child rejected SIGINT');
            }
            if(message.event==='sdk-signal'){
              sdkSignals.push('reason'in message?message.reason:null);
              // The SDK observer has already returned without joining the slot.
              // A round trip while the real operation is still held establishes
              // ownership, rather than racing an immediate release against exit.
              send('check-held');
            }
            if(message.event==='held'){
              heldAcknowledgements++;
              beforeRelease={closed,held:'held'in message?message.held:null,released:'released'in message?message.released:null,
                report_exists:existsSync(join(directory,'slot-report.json')),
                result_exists:existsSync(join(directory,'platform-result.json')),
                ledger_cleanup_confirmed:owner.ledger.readStudy(owner.ref).attempts[0]!.cleanup.confirmed};
              if(releases!==0){protocolErrors.push('Duplicate held acknowledgement');return;}
              releases++;send('release');
            }
            if(message.event==='durable'&&'file'in message&&typeof message.file==='string'){
              // Receipt follows the real file sync, rename and directory sync.
              // Parse at receipt, not merely after eventual process termination.
              json(message.file);durable.push(message.file);
            }
          } catch(error){protocolErrors.push(String(error));}
        });
      },
    });
    try {
      const observed=await launched;
      expect(observed).toMatchObject({close_observed:true,signal:null,deadline_requested:false,kill_requested:false,
        error:null,phase:'finalizing'});
      // The installed SDK legitimately owns exit 130, but only after persistence.
      if(observed.exit_code===null)throw new Error('Expected a numeric exit code after resident child close');
      expect([0,130]).toContain(observed.exit_code);
      expect(closed).toBe(true);
      expect(signals).toBe(1);
      expect(sdkSignals).toEqual(['sigint']);
      expect(heldAcknowledgements).toBe(1);
      expect(releases).toBe(1);
      expect(beforeRelease).toEqual({closed:false,held:true,released:false,report_exists:mode==='final-result-rename',
        result_exists:false,ledger_cleanup_confirmed:false});
      expect(protocolErrors).toEqual([]);
      expect(new Set(durable)).toEqual(new Set(['raw-timings.json','slot-report.json','platform-result.json']));
      if(mode==='final-result-rename'){
        // This signal follows the committed outcome snapshot. Test publication
        // ownership, not a new protocol for rewriting already-published reports.
        expect(lateReportBeforeSignal).toMatchObject({interrupted:false,native_fixture_created:false,platform_status:'fail'});
      }
      const raw=json('raw-timings.json'),report=json('slot-report.json');
      const validated=runner.validateResult(directory,owner.reservation,"e01");
      expect(raw).toMatchObject({acks:[],steps:[],submissions:[],history:[],retirements:[],initial_evaluator_diagnostics:[],final_resident:null});
      expect(report).toMatchObject({study_id:owner.ref.studyId,reservation_id:owner.reservation.reservationId,slot:owner.reservation.slot,
        platform_status:'fail',native_fixture_created:false,full_window_completed:false,final_resident:null,
        native_retirements:[],agent_status:'not_run',provider_status:'not_called',actual_provider_calls:0,
        cleanup:{confirmed:true,runtime_closed:true,resident_worker_closed:true,resident_native_retired:true,sandbox_closed:true,history_reader_closed:true,
          store_closed:true,recorder_closed:true,journal_closed:true,native_closed:true,deadline_reached:false,errors:[]},
        history_reader:{created_host_ms:null,close_requested_host_ms:null,closed_host_ms:null,owner:null},
        media:{recording_manifest:null,frames:null,replay:null}});
      if(mode!=='final-result-rename')expect(report.interrupted).toBe(true);
      else expect(typeof report.interrupted).toBe('boolean');
      if(mode==='manifest-read')expect(report.failure).toContain('Slot interrupted by SIGINT');
      expect(validated.result).toMatchObject({study_id:owner.ref.studyId,reservation_id:owner.reservation.reservationId,
        slot:owner.reservation.slot,platform_status:'fail',cleanup_confirmed:true,native_report:null});
      expect(runner.residentBenchmarkCleanupConfirmed(observed,null)).toBe(false);
      expect(runner.residentBenchmarkCleanupConfirmed(observed,validated.result)).toBe(true);
      // These receipts cover only genuinely uncreated owners, never native drain.
      expect(existsSync(join(directory,'native-runtime'))).toBe(false);
      expect(owner.ledger.readStudy(owner.ref).attempts[0]!.cleanup.confirmed).toBe(false);
    } finally {
      // Contain any assertion/protocol regression: release the owned gate, then
      // stop and join the actual child before closing SQLite/removing its root.
      const remaining=processOwner.child;
      if(remaining){
        if(remaining.connected)remaining.send('release',()=>{});
        remaining.kill('SIGKILL');
      }
      await launched;
      owner.ledger.close();
    }
  },30_000);

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

test('E01 load abort joins the actual readonly child exit and pipe drain before writer cleanup',async()=>{
  const f=historyFixture(),reader=new HistoryReader(f.store.readLocation()),loadAbort=new AbortController();
  const originalDeadline=performance.now()+10_000;
  try{
    f.store.appendEvents(f.run.run_id,Array.from({length:4096},(_,index)=>({
      type:'benchmark.evaluator_history',summary:'Nonplaying evaluator-only history load',details:{index},
    })));
    const outcome=reader.query({kind:'benchmark_history',run_id:f.run.run_id,minimum_records:4096},
      {signal:loadAbort.signal,deadlineHostMs:originalDeadline}).then(()=>null,error=>error);
    const active=reader.snapshot();
    expect(active).toMatchObject({closed:false,active:true,queued:0});
    expect(active.child?.pid).toBeGreaterThan(0);
    const aborted=performance.now();
    loadAbort.abort(new Error('Original benchmark load scope closed'));
    expect(await outcome).toMatchObject({code:'aborted'});
    const drained=reader.snapshot();
    expect(drained).toMatchObject({active:false,queued:0});
    expect(drained.child?.pid).toBe(active.child?.pid);
    expect(drained.child?.exitObservedHostMs).toBeGreaterThanOrEqual(aborted);
    expect(drained.child?.stdoutDrainObservedHostMs).toBeNumber();
    expect(drained.child?.closedHostMs).toBeGreaterThanOrEqual(aborted);
    await reader.close();
    expect(reader.snapshot()).toMatchObject({closed:true,active:false,queued:0});
    expect(reader.snapshot().child?.closedHostMs).toBe(drained.child?.closedHostMs);
  }finally{
    loadAbort.abort();
    await reader.close();
    f.close();
  }
});

test('E01 reader close cancels queued work and preserves the original expired absolute deadline',async()=>{
  const f=historyFixture(),reader=new HistoryReader(f.store.readLocation());
  try{
    const options={deadlineHostMs:performance.now()+10_000};
    const first=reader.query({kind:'benchmark_history',run_id:f.run.run_id,minimum_records:4096},options)
      .then(()=>null,error=>error);
    const queued=reader.query({kind:'benchmark_history',run_id:f.run.run_id,minimum_records:4096},options)
      .then(()=>null,error=>error);
    expect(reader.snapshot()).toMatchObject({active:true,queued:1});
    const closing=reader.close();
    expect(reader.close()).toBe(closing);
    await closing;
    expect(await first).toMatchObject({code:'closed'});
    expect(await queued).toMatchObject({code:'closed'});
    expect(reader.snapshot()).toMatchObject({closed:true,active:false,queued:0});
    expect(reader.snapshot().child?.closedHostMs).toBeNumber();
    const fresh=new HistoryReader(f.store.readLocation());
    try{
      const deadlineHostMs=performance.now()-1;
      await expect(fresh.query({kind:'benchmark_history',run_id:f.run.run_id,minimum_records:4096},
        {deadlineHostMs})).rejects.toMatchObject({code:'deadline'});
      expect(fresh.snapshot().child).toBeNull();
    }finally{await fresh.close();}
  }finally{await reader.close();f.close();}
});

test('earlier original OS-monotonic workflow bounds preserve an in-budget finalization despite delayed phase IPC', async () => {
  const deadlineEpochMs = Date.now() + 5000;
  const deadlineMonotonicNs = osMonotonicNs() + 1_800_000_000n;
  const source = `
    import { osMonotonicNs } from ${JSON.stringify(new URL('../src/evaluation/os-monotonic.ts', import.meta.url).pathname)};
    process.on('message', value => {
      if (value === 'finalize') {
        const entered_epoch_ms = Date.now(), entered_monotonic_ns = osMonotonicNs().toString();
        setTimeout(() => process.send({type:'resident_benchmark_phase',version:1,phase:'finalizing',entered_epoch_ms,entered_monotonic_ns}), 650);
      }
      if (value === 'finish') process.exit(0);
    });
    process.send({observed:'ready'});
  `;
  let cutoffObserved = false;
  const observed = await runner.launchResidentBenchmarkChild({
    command: process.execPath, args: ['--no-env-file', '-e', source], cwd: process.cwd(), env: process.env,
    deadlineEpochMs, deadlineMonotonicNs, cleanupMs: 1300,
    setChild(child) {
      child?.on('message', value => {
        if (observedMessage(value) === 'ready') child.send('finalize');
        if (value && typeof value === 'object' && 'type' in value && value.type === 'resident_benchmark_phase') {
          cutoffObserved = osMonotonicNs() >= deadlineMonotonicNs - 1_300_000_000n;
          child.send('finish');
        }
      });
    },
  });
  expect(cutoffObserved).toBe(true);
  expect(observed).toMatchObject({ close_observed: true, exit_code: 0, signal: null,
    deadline_requested: false, kill_requested: false, phase: 'finalizing' });
  expect(Date.now()).toBeLessThan(deadlineEpochMs);
});

test('missing OS phase timestamp cannot replace the earlier workflow clock with a later wall allowance', async () => {
  const deadlineEpochMs = Date.now() + 5000;
  const observed = await runner.launchResidentBenchmarkChild({
    command: process.execPath,
    args: ['--no-env-file', '-e', `
      process.send({type:'resident_benchmark_phase',version:1,phase:'finalizing',entered_epoch_ms:Date.now()});
      setInterval(() => {}, 1000);
    `],
    cwd: process.cwd(), env: process.env, deadlineEpochMs,
    deadlineMonotonicNs: osMonotonicNs() + 1_000_000_000n,
    cleanupMs: 500, setChild() {},
  });
  expect(observed).toMatchObject({ close_observed: true, deadline_requested: true,
    kill_requested: true, signal: 'SIGKILL', phase: 'work' });
  expect(observed.error).toContain('OS-monotonic');
  expect(Date.now()).toBeLessThan(deadlineEpochMs);
  expect(runner.residentBenchmarkCleanupConfirmed(observed, { cleanup_confirmed: true })).toBe(false);
});

test('a forward wall jump fences active P13 child ownership without waiting for the old monotonic timer', async () => {
  const deadlineEpochMs = Date.now() + 5000;
  let changed: ReturnType<typeof vi.spyOn> | undefined;
  const began = performance.now();
  try {
    const observed = await runner.launchResidentBenchmarkChild({
      command: process.execPath,
      args: ['--no-env-file', '-e', "process.send({observed:'ready'}); setInterval(()=>{},1000);"],
      cwd: process.cwd(), env: process.env, deadlineEpochMs,
      deadlineMonotonicNs: osMonotonicNs() + 5_000_000_000n,
      cleanupMs: 500,
      setChild(child) {
        child?.on('message', value => {
          if (observedMessage(value) === 'ready')
            changed = vi.spyOn(Date, 'now').mockReturnValue(deadlineEpochMs + 1000);
        });
      },
    });
    expect(observed).toMatchObject({ close_observed: true, deadline_requested: true,
      kill_requested: true, signal: 'SIGKILL' });
    expect(performance.now() - began).toBeLessThan(2000);
    expect(runner.residentBenchmarkCleanupConfirmed(observed, { cleanup_confirmed: true })).toBe(false);
  } finally { changed?.mockRestore(); }
});

test('expired original workflow authority rejects before creating a child process', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'p13-expired-spawn-'));
  roots.push(directory);
  const emitted = join(directory, 'must-not-exist');
  let owned = false;
  const observed = await runner.launchResidentBenchmarkChild({
    command: process.execPath,
    args: ['--no-env-file', '-e', `await Bun.write(${JSON.stringify(emitted)},'forbidden late child');`],
    cwd: process.cwd(), env: process.env,
    deadlineEpochMs: Date.now() + 5000, deadlineMonotonicNs: osMonotonicNs() - 1n,
    cleanupMs: 500, setChild(child) { if (child) owned = true; },
  });
  expect(owned).toBe(false);
  expect(existsSync(emitted)).toBe(false);
  expect(observed).toMatchObject({ pid: null, deadline_requested: true, kill_requested: false });
  expect(observed.error).toContain('before spawn');
});

test('P13 cleanup cannot inherit an E01 pass over missing or unclosed dedicated reader ownership', () => {
  const owner = ownership(), directory = mkdtempSync(join(tmpdir(), 'p13-volume-result-'));
  roots.push(directory);
  const reportPath = join(directory, 'slot-report.json'), nativePath = join(directory, 'native-report.json');
  const volume = {
    closed: true, learning_closed: true, reader_closed: true, tasks_joined: true,
    reader_owner: { closed: true, active: false, queued: 0,
      child: { pid: 123, exitObservedHostMs: 1, stdoutDrainObservedHostMs: 2, closedHostMs: 3 } },
  };
  const report = {
    assay: 'p13_volume', classification: P13_VOLUME_CLASSIFICATION,
    native_fixture_created: true, full_window_completed: false,
    p13_volume_preparation_started: true, p13_volume: volume as unknown,
    cleanup: { confirmed: true, resident_worker_closed: true, resident_native_retired: true,
      sandbox_closed: true, history_reader_closed: true, store_closed: true, native_closed: true,
      runtime_closed: true, recorder_closed: true, journal_closed: true },
    media: { recording_manifest: null, frames: null, replay: null, playback: 'pending_full_original_speed_review' },
  };
  const result = { study_id: owner.ref.studyId, reservation_id: owner.reservation.reservationId,
    slot: owner.reservation.slot, platform_status: 'fail', cleanup_confirmed: true,
    report: reportPath, native_report: nativePath, classification: P13_VOLUME_CLASSIFICATION };
  try {
    writeFileSync(nativePath, JSON.stringify({ cleanup: true }));
    writeFileSync(join(directory, 'platform-result.json'), JSON.stringify(result));
    for (const invalid of [
      null, { ...volume, tasks_joined: false },
      { ...volume, reader_owner: { ...volume.reader_owner, child: { ...volume.reader_owner.child, stdoutDrainObservedHostMs: null } } },
      { ...volume, reader_owner: { ...volume.reader_owner, active: true } },
    ]) {
      report.p13_volume = invalid;
      writeFileSync(reportPath, JSON.stringify(report));
      expect(() => runner.validateResult(directory, owner.reservation, 'p13_volume')).toThrow('actually drained');
    }
    report.p13_volume = volume;
    writeFileSync(reportPath, JSON.stringify(report));
    expect(runner.validateResult(directory, owner.reservation, 'p13_volume').result.platform_status).toBe('fail');
  } finally { owner.ledger.close(); }
});
