import { createHash } from "node:crypto";
import { mkdir, open, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { normalizeJournalLimits, type JournalLimits } from "../shared/evidence-limits.ts";

export interface JournalFinalization { journal: string; manifest: string; evidence_complete: boolean }
/** Permitted SDK-visible evidence, not secret storage or a wire-transport tap. */
export class PrivateJournal {
  private readonly limits;
  private text = 0; private pending = 0; private imageBytes = 0;
  private acceptedText = 0; private acceptedImageBytes = 0;
  private peakPending = 0; private peakText = 0; private peakImageBytes = 0;
  private readonly images = new Map<string, { file: string; sha256: string; bytes: number; mime_type: string }>();
  private readonly storedImages = new Set<string>();
  private readonly failures: string[] = [];
  private tail: Promise<void> = Promise.resolve();
  private readonly file: Promise<FileHandle>;
  private finalized: Promise<JournalFinalization> | null = null;
  readonly journal: string; readonly manifest: string;
  private readonly artifactPrefix: string;
  constructor(private readonly directory: string, readonly runId: string,
    private readonly stop: (runId: string, reason: string) => void, limits: Partial<JournalLimits> = {}) {
    this.limits = normalizeJournalLimits(limits);
    // Run IDs are host UUIDs, but keep path authority independent of a caller's spelling.
    const key = createHash("sha256").update(runId).digest("hex");
    this.artifactPrefix = `run-${key}`;
    this.journal = `run-${key}-journal.jsonl`; this.manifest = `run-${key}-manifest.json`;
    this.file = mkdir(directory, { recursive: true, mode: 0o700 }).then(() => open(path.join(directory, this.journal), "ax", 0o600));
    void this.file.catch(() => this.fail("private_journal_persistence_failed"));
  }
  private fail(reason: string) {
    if (this.failures.includes(reason)) return;
    this.failures.push(reason); this.stop(this.runId, reason);
  }
  private enqueue(bytes: number, operation: () => Promise<unknown>) {
    this.pending += bytes;
    this.peakPending = Math.max(this.peakPending, this.pending);
    this.tail = this.tail.then(operation).then(() => {}, () => this.fail("private_journal_persistence_failed")).finally(() => { this.pending -= bytes; });
  }
  private sanitize(value: unknown, opaque = false): unknown {
    if (Array.isArray(value)) return value.map(entry => this.sanitize(entry, opaque));
    if (value === null || typeof value !== "object") return value;
    const data = value as Record<string, unknown>;
    if (!opaque && (data.type === "thinking" || data.type === "redactedThinking" || data.type === "reasoning" || typeof data.type === "string" && /^(thinking|reasoning)_/.test(data.type)))
      return { type: "reasoning_redacted", policy: "Private provider reasoning is not captured" };
    if (!opaque && data.type === "image" && typeof data.data === "string" && typeof data.mimeType === "string") {
      const bytes = Buffer.from(data.data, "base64"), sha256 = createHash("sha256").update(bytes).digest("hex");
      let artifact = this.images.get(sha256);
      if (!artifact) {
        if (bytes.length > 2 * 1024 * 1024 || this.acceptedImageBytes + bytes.length > this.limits.maxImageBytes ||
          this.images.size >= this.limits.maxImages || this.pending + bytes.length > this.limits.maxPendingBytes) {
          this.fail("private_image_evidence_capacity_bound"); return { type: "image_omitted", reason: "private_image_evidence_capacity_bound", sha256 };
        }
        artifact = { file: `${this.artifactPrefix}-image-${sha256}.png`, sha256, bytes: bytes.length, mime_type: data.mimeType };
        this.images.set(sha256, artifact); this.acceptedImageBytes += bytes.length;
        const name = artifact.file;
        this.enqueue(bytes.length, async () => {
          await this.file;
          const artifact = await open(path.join(this.directory, name), "wx", 0o600);
          try { await artifact.writeFile(bytes); await artifact.sync(); } finally { await artifact.close(); }
          this.storedImages.add(sha256); this.imageBytes += bytes.length;
          this.peakImageBytes = Math.max(this.peakImageBytes, this.imageBytes);
        });
      }
      return { type: "image_artifact", ...artifact };
    }
    const clean: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(data)) {
      if (!opaque && /^(?:thinkingSignature|reasoningSignature|encrypted_content)$/i.test(key)) clean[key] = "reasoning_redacted";
      else if (!opaque && /^(?:apiKey|accessToken|refreshToken|authorization|headers|credential|credentials)$/i.test(key)) clean[key] = "secret_field_not_captured";
      // Arbitrary authorized JSON is data, not a provider content-block schema.
      // SDK execution events use `args`, while model tool calls use `arguments`.
      // Literal gameplay keys/content must not become reasoning or artifacts.
      else clean[key] = this.sanitize(entry, opaque || ["arguments", "details", "payload"].includes(key) ||
        key === "args" && (data.type === "tool_execution_start" || data.type === "tool_execution_update"));
    }
    return clean;
  }
  append(kind: string, value: unknown): boolean {
    if (this.finalized || this.failures.length) return false;
    try {
      const record = { kind, run_id: this.runId, monotonic_ms: performance.now(), value: this.sanitize(value) };
      if (this.failures.length) return false;
      const line = JSON.stringify(record) + "\n", bytes = Buffer.byteLength(line);
      if (this.acceptedText + bytes > this.limits.maxTextBytes || this.pending + bytes > this.limits.maxPendingBytes) {
        this.fail(this.acceptedText + bytes > this.limits.maxTextBytes ? "private_journal_text_capacity_bound" : "private_journal_pending_capacity_bound"); return false;
      }
      this.acceptedText += bytes;
      this.enqueue(bytes, async () => {
        const file = await this.file; await file.writeFile(line);
        this.text += bytes; this.peakText = Math.max(this.peakText, this.text);
      });
      return true;
    } catch { this.fail("private_journal_serialization_failed"); return false; }
  }
  finalize(input: { status: string; reason: string }): Promise<JournalFinalization> {
    if (this.finalized) return this.finalized;
    this.append("finalization", input);
    this.finalized = (async () => {
      await this.tail;
      try {
        const file = await this.file;
        try {
          // Reserved failure marker is independent of the exhausted ordinary allowance.
          if (this.failures.length) {
            const marker = JSON.stringify({ kind: "evidence_failure", run_id: this.runId,
              monotonic_ms: performance.now(), failures: this.failures }) + "\n";
            await file.writeFile(marker);
            this.text += Buffer.byteLength(marker); this.peakText = Math.max(this.peakText, this.text);
          }
          await file.sync();
        } finally { await file.close(); }
      } catch { this.fail("private_journal_flush_failed"); }
      const value = { ...input, run_id: this.runId, evidence_complete: !this.failures.length, failures: this.failures,
        journal: this.journal, image_artifacts: [...this.images.values()].filter(image => this.storedImages.has(image.sha256)),
        text_bytes: this.text, peak_text_bytes: this.peakText, pending_bytes: this.pending, peak_pending_bytes: this.peakPending,
        image_bytes: this.imageBytes, peak_image_bytes: this.peakImageBytes, image_count: this.storedImages.size,
        accepted_text_bytes: this.acceptedText, accepted_image_bytes: this.acceptedImageBytes, accepted_images: this.images.size,
        limits: { max_text_bytes: this.limits.maxTextBytes, max_pending_bytes: this.limits.maxPendingBytes,
          max_image_bytes: this.limits.maxImageBytes, max_images: this.limits.maxImages },
        context_provenance: "SDK-visible context retained before request assembly and at the final supplemented stream invocation; neither is wire payload. Wire attempts remain unknown.",
        reasoning: "Private/hidden provider reasoning is redacted, never evidence.",
        omissions: this.failures.length ? ["Evidence is incomplete; capacity or persistence failure stopped the attempt."] : [],
        scope: "Authorized observations, capability requests/results before ordinary trace caps, visible Agent events, immutable source snapshots and native receipts. No secret-store or hidden-evaluator capture." };
      await writeFile(path.join(this.directory, this.manifest), JSON.stringify(value, null, 2), { mode: 0o600, flag: "wx" });
      return { journal: this.journal, manifest: this.manifest, evidence_complete: value.evidence_complete };
    })();
    return this.finalized;
  }
}
