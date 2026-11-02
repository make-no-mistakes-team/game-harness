import { z } from 'zod';

const bytes = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const recordingLimitsSchema = z.object({
  maxPendingRawBytes: bytes.max(512*1024**2), maxFrames: bytes.max(2_000_000),
  maxStoredFrameBytes: bytes, maxDurationMs: bytes.max(2_147_483_647),
}).strict();
export type RecordingLimits = z.infer<typeof recordingLimitsSchema>;
export const DEFAULT_RECORDING_LIMITS: Readonly<RecordingLimits> = Object.freeze({
  maxPendingRawBytes:128*1024**2,maxFrames:12000,maxStoredFrameBytes:32*1024**3,maxDurationMs:600000,
});
export const journalLimitsSchema = z.object({maxTextBytes:bytes,maxPendingBytes:bytes.max(64*1024**2),
  maxImageBytes:bytes.max(32*1024**3),maxImages:bytes.max(12000)}).strict();
export type JournalLimits = z.infer<typeof journalLimitsSchema>;
export const DEFAULT_JOURNAL_LIMITS: Readonly<JournalLimits> = Object.freeze({
  maxTextBytes:256*1024**2,maxPendingBytes:16*1024**2,maxImageBytes:32*1024**3,maxImages:12000,
});
export const evidenceProfileSchema = z.object({schema_version:z.literal(1),recording:recordingLimitsSchema,
  journal:journalLimitsSchema,render_timeout_ms:bytes.max(600000)}).strict();
export type EvidenceProfile = z.infer<typeof evidenceProfileSchema>;
export const DEFAULT_EVIDENCE_PROFILE: Readonly<EvidenceProfile> = Object.freeze({schema_version:1,
  recording:DEFAULT_RECORDING_LIMITS,journal:DEFAULT_JOURNAL_LIMITS,render_timeout_ms:120000});

/** Partial trusted constructor configuration is normalized once; published files require complete profiles. */
export function normalizeRecordingLimits(input:unknown={}) {
  return Object.freeze(recordingLimitsSchema.parse({...DEFAULT_RECORDING_LIMITS,...recordingLimitsSchema.partial().parse(input)}));
}
export function normalizeJournalLimits(input:unknown={}) {
  return Object.freeze(journalLimitsSchema.parse({...DEFAULT_JOURNAL_LIMITS,...journalLimitsSchema.partial().parse(input)}));
}
