import { z } from "zod";
import { osMonotonicNs } from "./os-monotonic.ts";
import { ProjectionLedger, type ProjectionControl } from "./projection-ledger.ts";
import { projectionMetadataExchange, readProjectionFrame, writeProjectionFrame } from "./projection-metadata-pipe.ts";
import { RuntimeFault } from "./runtime-fault.ts";
import { projectionJobSchema, projectionWorkerDataSchema, projectionWorkerInputSchema,
  projectionWireError, type ProjectionMetadata } from "./projection-writer-protocol.ts";

const args = z.tuple([z.string(), z.string(), z.string(), z.string(), z.string()]).parse(process.argv.slice(2));
const data = projectionWorkerDataSchema.parse({ location: { database: args[0], artifacts: args[1], projection: args[2] },
  identity: { source_id: args[3], projection_id: args[4] } });
let current: z.infer<typeof projectionJobSchema> | null = null;
let serial = 0;
function active(): bigint {
  if (!current || osMonotonicNs() >= BigInt(current.deadline_os_ns))
    throw new RuntimeFault("history_deadline", "Derived history request deadline expired; persistence may already have completed");
  return BigInt(current.deadline_os_ns);
}
function metadata(command: ProjectionMetadata): unknown {
  const deadline = active();
  if (!Number.isSafeInteger(++serial)) throw new Error("Projection metadata identities exhausted");
  return projectionMetadataExchange({ v: 1, type: "metadata", job_id: current!.id, serial,
    deadline_os_ns: current!.deadline_os_ns, command }, serial, deadline);
}
const control: ProjectionControl = {
  publication: hash => z.object({ batch_hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().nullable().parse(metadata({ kind: "publication", hash })),
  acceptPublication: (runId, hash, sourceThrough) => { z.null().parse(metadata({ kind: "accept", run_id: runId, hash, source_through: sourceThrough })); },
  appendAudit: (receiptId, runId, payload) => z.int().positive().parse(metadata({ kind: "audit", receipt_id: receiptId, run_id: runId, payload })),
  publishAudit: eventSeq => { z.null().parse(metadata({ kind: "publish", event_seq: eventSeq })); },
};
const ledger = new ProjectionLedger(data.location, data.identity, control);
try {
  for (;;) {
    // No job deadline runs while idle. The owning process can always SIGKILL
    // this child and joins process exit plus its ordinary stdin/stdout closure.
    const request = projectionWorkerInputSchema.parse(readProjectionFrame());
    if (request.type === "close") break;
    current = request;
    try {
      active();
      // Recover durable metadata only, never a previous mutation or physical effect.
      ledger.drainAudit();
      let value: unknown = null;
      const command = request.command;
      if (command.kind === "begin") value = ledger.beginHistoryProjection(command.run_id, command.desired_through);
      else if (command.kind === "commit") ledger.commitHistoryProjectionBatch(command.run_id, command.batch);
      else if (command.kind === "resolve") value = ledger.resolveOpportunity(command.run_id, command.opportunity_id, command.resolution);
      writeProjectionFrame({ v: 1, type: "result", id: request.id, reply: { ok: true, value } }, active());
    } catch (error) {
      writeProjectionFrame({ v: 1, type: "result", id: request.id, reply: { ok: false, error: projectionWireError(error) } }, active());
    } finally { current = null; }
  }
} catch {
  // Lost framing, EOF and expired ownership terminate without a fabricated receipt.
  process.exitCode = 1;
} finally { ledger.close(); }
