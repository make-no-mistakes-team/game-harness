export type ToolRole = "ordinary" | "authoring" | "speculative" | "review";
export type ToolModule = "reflex" | "memory";

export const TOOL_POLICY = Object.freeze({
  observe: { roles: ["ordinary", "authoring", "speculative", "review"], module: null },
  program_write: { roles: ["ordinary", "authoring", "speculative", "review"], module: null },
  program_submit: { roles: ["ordinary"], module: null },
  program_run: { roles: ["ordinary"], module: null },
  program_inspect: { roles: ["ordinary", "authoring", "speculative", "review"], module: null },
  program_review: { roles: ["ordinary", "review"], module: null },
  help: { roles: ["ordinary", "authoring", "speculative", "review"], module: null },
  task_finish: { roles: ["ordinary"], module: null },
  prepare_next: { roles: ["speculative"], module: null },
  reflex: { roles: ["ordinary"], module: "reflex" },
  memory: { roles: ["ordinary"], module: "memory" },
} as const satisfies Record<string, { roles: readonly ToolRole[]; module: ToolModule | null }>);

export function isToolAllowed(role: ToolRole, name: string): boolean {
  if (!Object.hasOwn(TOOL_POLICY, name)) return false;
  const entry = TOOL_POLICY[name as keyof typeof TOOL_POLICY];
  return (entry.roles as readonly ToolRole[]).includes(role);
}

export function isSpeculativeTool(name: string): boolean {
  return isToolAllowed("speculative", name);
}

export function toolCatalogAllows(role: ToolRole, name: string, modules: ReadonlySet<ToolModule>): boolean {
  if (!isToolAllowed(role, name)) return false;
  const entry = TOOL_POLICY[name as keyof typeof TOOL_POLICY];
  return entry.module === null || modules.has(entry.module);
}
