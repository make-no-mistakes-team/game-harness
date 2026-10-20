import { mkdir, open, writeFile, type FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { BridgeConnection, Json } from "../shared/contracts.ts";
import {
  OBSERVATION_PROFILE,
  OBSERVATION_PROFILE_FINGERPRINT,
} from "./profile.ts";

/** Human/evaluator-only files. Nothing in this log is sent over the game API. */
export class TrustedDiagnostics {
  private chain: Promise<void> = Promise.resolve();
  private queuedBytes = 0;
  private dropped = 0;
  private failed = false;
  private constructor(private file: FileHandle) {}

  static async create(config: BridgeConnection) {
    const directory = resolve("local/runtime/bridge", randomUUID());
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      resolve(directory, "profile.json"),
      JSON.stringify({
        world_id: config.world_id,
        epoch: config.epoch,
        configuration: OBSERVATION_PROFILE,
        configuration_sha256: OBSERVATION_PROFILE_FINGERPRINT,
        minecraft_data_version: "3.117.0",
        started_at: new Date().toISOString(),
      }),
      { mode: 0o600, flag: "wx" },
    );
    const file = await open(
      resolve(directory, "private-diagnostics.jsonl"),
      "wx",
      0o600,
    );
    return new TrustedDiagnostics(file);
  }

  record(value: Json) {
    if (this.failed) return;
    const line =
      JSON.stringify({ at: new Date().toISOString(), data: value }) + "\n";
    const bytes = Buffer.byteLength(line);
    if (bytes > 262144 || this.queuedBytes + bytes > 1048576) {
      this.dropped++;
      return;
    }
    const gap = this.dropped;
    this.dropped = 0;
    this.queuedBytes += bytes;
    this.chain = this.chain
      .then(async () => {
        if (gap)
          await this.file.writeFile(
            JSON.stringify({ type: "diagnostic_gap", omitted_records: gap }) +
              "\n",
          );
        await this.file.writeFile(line);
      })
      .catch(() => {
        this.failed = true;
      })
      .finally(() => {
        this.queuedBytes -= bytes;
      });
  }

  async close() {
    await this.chain;
    await this.file.sync().catch(() => {});
    await this.file.close().catch(() => {});
  }
}
