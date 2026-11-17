import { InlineCognitionContext } from "../../src/server/cognition-context.ts";
import { CognitionWire } from "../../src/server/cognition-wire.ts";
import type { ContextCustodyTransfer, PassiveContextState } from "../../src/server/cognition-context-custody.ts";
import type { ContextAssemblyInput } from "../../src/server/strategic-context-protocol.ts";
import type { StoreReadLocation } from "../../src/server/store-read.ts";
import type { Json } from "../../src/shared/contracts.ts";

// Infrastructure-only child: actual readonly reducer and private bounded pipe,
// no Agent, provider, tool result, gameplay execution or effect/native owner.
let owner: InlineCognitionContext | null = null;
let sequence = 0;
let active: string | null = null;
async function transfer(kind: ContextCustodyTransfer["kind"], state: PassiveContextState): Promise<void> {
  await wire.call("context_custody", { sequence: ++sequence, kind,
    context_id: kind === "assembled" ? active : null, state } satisfies ContextCustodyTransfer);
}
const wire = new CognitionWire(process.stdin, process.stdout, async (method, body) => {
  if (method === "start") {
    if (owner) throw new Error("Already owned");
    const input = body as { location: StoreReadLocation; state: PassiveContextState };
    owner = new InlineCognitionContext(input.location, undefined, async state => { await transfer("assembled", state); });
    owner.restore(input.state); owner.open();
    return { pid: process.pid };
  }
  if (!owner) throw new Error("Not owned");
  if (method === "remember") {
    const input = body as { topic: string; value: Json; source: { name: string; version: number } };
    owner.rememberHelp(input.topic, input.value);
    owner.selectProgram(input.source.name, input.source.version);
    await transfer("journal", owner.capture());
    return null;
  }
  if (method === "assemble") {
    const input = body as { input: ContextAssemblyInput; id: string; deadline_os_ns: string };
    active = input.id;
    let successful = false;
    try {
      const result = await owner.assemble(input.input, { deadlineOsNs: BigInt(input.deadline_os_ns) });
      successful = true; return result;
    } finally {
      await wire.call("context_end", { id: input.id, successful });
      active = null;
    }
  }
  if (method === "close") {
    await owner.close(); await transfer("closed", owner.capture());
    return null;
  }
  throw new Error("Unknown passive operation");
}, () => { process.exitCode = 1; process.stdin.destroy(); });
void wire.ended.then(async () => { await owner?.close(); process.stdin.destroy(); }).catch(() => {});
