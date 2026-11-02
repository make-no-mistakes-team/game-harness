import { expect, test } from 'bun:test';
import { evidenceProfileSchema, normalizeRecordingLimits, normalizeJournalLimits } from '../src/shared/evidence-limits.ts';

test('recording and journal bounds reject nonfinite, unsafe and silently misspelled resource fields',()=>{
  for(const invalid of [0,-1,NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER+1]) {
    expect(()=>normalizeRecordingLimits({maxFrames:invalid})).toThrow();
    expect(()=>normalizeRecordingLimits({maxDurationMs:invalid})).toThrow();
    expect(()=>normalizeJournalLimits({maxTextBytes:invalid})).toThrow();
  }
  expect(()=>normalizeRecordingLimits({maxPendingRawBytes:512*1024**2+1})).toThrow();
  expect(()=>normalizeJournalLimits({maxPendingBytes:64*1024**2+1})).toThrow();
  expect(()=>normalizeRecordingLimits({maxFrmaes:1})).toThrow();
  expect(()=>normalizeJournalLimits({maxImageBytes:32*1024**3+1})).toThrow();
  expect(()=>normalizeJournalLimits({maxImages:12001})).toThrow();
});

test('a frozen external evidence profile must be complete and cannot default missing duration or storage authority',()=>{
  const profile={schema_version:1,recording:{maxDurationMs:2000000,maxFrames:60000,maxStoredFrameBytes:32*1024**3,maxPendingRawBytes:128*1024**2},
    journal:{maxTextBytes:2*1024**3,maxPendingBytes:16*1024**2,maxImageBytes:32*1024**3,maxImages:12000},render_timeout_ms:300000};
  expect(evidenceProfileSchema.safeParse(profile).success).toBe(true);
  for(const field of ['maxDurationMs','maxFrames','maxStoredFrameBytes','maxPendingRawBytes']) {
    const recording:Record<string,number>={...profile.recording};delete recording[field];
    expect(evidenceProfileSchema.safeParse({...profile,recording}).success).toBe(false);
  }
  expect(evidenceProfileSchema.safeParse({...profile,recording:{...profile.recording,max_pending_bytes:1}}).success).toBe(false);
  expect(evidenceProfileSchema.safeParse({...profile,render_timeout_ms:2147483648}).success).toBe(false);
});
