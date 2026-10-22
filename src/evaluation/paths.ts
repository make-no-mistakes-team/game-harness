import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface EvaluationPaths {
  /** Compact evaluation indexes and summaries; never heavy runtime evidence. */
  reportsRoot: string;
  /** Private worlds, dependencies, sessions and full evidence. */
  runtimeRoot: string;
  /** Durable reservations; independent of any individual run directory. */
  governanceRoot: string;
}

function xdgRoot(variable: string, fallback: string): string {
  const value = process.env[variable];
  // XDG requires absolute values. Ignore malformed values rather than putting
  // heavy/private artifacts in the current checkout through a relative base.
  return value && path.isAbsolute(value) ? value : path.join(homedir(), fallback);
}

/** Resolves paths without creating directories or changing application config.
 * GAMEHARNESS_DATA_DIR remains owned by the application/Electron launcher.
 */
export function evaluationPaths(
  projectRoot: string,
  overrides: Partial<EvaluationPaths> = {},
): EvaluationPaths {
  const resolved = path.resolve(projectRoot);
  // Canonicalize existing projects so opening a checkout through a symlink does
  // not accidentally create a new hypothesis ledger.
  let project = resolved;
  try { project = realpathSync(resolved); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const label = path.basename(project).replace(/[^a-zA-Z0-9_-]/g, "_") || "project";
  const scope = `${label}-${createHash("sha256").update(project).digest("hex").slice(0, 16)}`;
  const select = (key: keyof EvaluationPaths, variable: string, fallback: string) => {
    const value = overrides[key] ?? process.env[variable] ?? fallback;
    if (!value.trim()) throw new Error(`Evaluation ${key} must not be empty`);
    return path.resolve(project, value);
  };
  const paths = {
    reportsRoot: select("reportsRoot", "GAMEHARNESS_EVALUATION_REPORTS_ROOT", path.join(project, "reports/evaluation")),
    runtimeRoot: select("runtimeRoot", "GAMEHARNESS_EVALUATION_RUNTIME_ROOT", path.join(xdgRoot("XDG_CACHE_HOME", ".cache"), "gameharness/evaluation", scope, "runtime")),
    governanceRoot: select("governanceRoot", "GAMEHARNESS_EVALUATION_GOVERNANCE_ROOT", path.join(xdgRoot("XDG_STATE_HOME", ".local/state"), "gameharness/evaluation", scope, "governance")),
  };
  const roots = Object.values(paths);
  for (let a = 0; a < roots.length; a++) for (let b = a + 1; b < roots.length; b++) {
    const first = roots[a]!;
    const second = roots[b]!;
    const relative = path.relative(first, second);
    const reverse = path.relative(second, first);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) ||
        (!reverse.startsWith(`..${path.sep}`) && reverse !== ".." && !path.isAbsolute(reverse)))
      throw new Error("Evaluation reports, runtime and governance roots must be separate, non-nested directories");
  }
  return paths;
}
