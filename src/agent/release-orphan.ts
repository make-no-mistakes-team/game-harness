import path from "node:path";
import type { SurvivalAgentGoal as Goal } from "../shared/goals.ts";
import { openOrphanAutosave, ordinaryRunBasename } from "./crash-autosave.ts";
import { releaseOrphanReservation } from "./storage.ts";

function parseArgs(argv: string[]) {
  let run: string | undefined;
  let scope = process.env.SURVIVAL_AGENT_ORPHAN_SCOPE;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--scope") {
      scope = argv[++i];
      if (!scope) throw new Error("--scope requires a systemd user scope name.");
    } else if (arg.startsWith("--scope=")) {
      scope = arg.slice("--scope=".length);
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!run) {
      run = arg;
    } else {
      throw new Error(`Unexpected extra argument: ${arg}`);
    }
  }
  if (!run || !ordinaryRunBasename.test(run)) {
    throw new Error("Usage: bun src/agent/release-orphan.ts <RUN_BASENAME> [--scope <SCOPE>]");
  }
  return { run, scope };
}

async function main() {
  const { run, scope } = parseArgs(process.argv.slice(2));
  const project = path.resolve(import.meta.dir, "../..");
  const local = path.join(project, "local");
  const artifactRoot = path.join(local, "survival-agent");
  const runs = path.join(artifactRoot, "runs");
  const historicRuns = path.join(local, "survival-pilot", "runs");
  const live = path.join(artifactRoot, "live.json");
  const goal = run.slice(25, -7) as Goal;
  const signal = AbortSignal.timeout(20_000);

  const orphan = await openOrphanAutosave({ runs, historicRuns, live, run, goal, scope, signal });
  try {
    const receipt = await releaseOrphanReservation({
      kind: "same-boot-orphan-autosave",
      sourceRun: run,
      priorReserveBytes: orphan.reservation.priorReserveBytes,
      signal,
      assertSource: () => {
        orphan.assertSource();
        orphan.assertLatestPrimary();
      },
      assertQuiescent: (activeSignal) => orphan.assertQuiescent(activeSignal),
    });
    console.log(JSON.stringify({ released: true, scope: orphan.scope, ...receipt }));
  } finally {
    await orphan.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
