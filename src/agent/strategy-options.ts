import { SURVIVAL_AGENT_GOALS, survivalModelIdentity, type SurvivalAgentGoal,
  type SurvivalModelSelection } from "../shared/goals.ts";

export interface StrategyOptions {
  strategy: "model";
  model: SurvivalModelSelection;
  maxRequests: number;
  task?: string;
}
function namedGoal(task: string): SurvivalAgentGoal | undefined {
  const text = task.trim().toLowerCase().replace(/\s+/g, " ").replace(/\.$/, "");
  const phrase = text.replace(/ in survival$/, "");
  return SURVIVAL_AGENT_GOALS.find(goal => {
    const label = goal.replaceAll("_", " ");
    if (text === goal || text === label) return true;
    if (goal === "nether_portal") return phrase === "enter the nether";
    const item = `${goal === "iron_pickaxe" ? "an" : "a"} ${label}`;
    return phrase === `obtain ${item}` || phrase === `${goal === "diamond" ? "mine" : "craft"} ${item}`;
  });
}
export function readModelSelection(value: string | undefined): SurvivalModelSelection {
  const slash = value?.indexOf("/") ?? -1;
  if (!value || slash < 1) throw new Error("Select an explicit model with --model PROVIDER/MODEL.");
  const selection = { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
  survivalModelIdentity(selection);
  return selection;
}
/** Parsing never opens credentials, contacts a provider, or substitutes a model. */
export function readStrategy(args: string[]): { game: string[]; model?: StrategyOptions } {
  if (args[0] !== "--strategy") return { game: args };
  if (args[1] !== "model") throw new Error("Expected --strategy model. Omit it for model-free play.");
  let i = 2, maxRequests: number | undefined, task: string | undefined, model: SurvivalModelSelection | undefined;
  while (["--macro-requests", "--task", "--model"].includes(args[i] ?? "")) {
    const option = args[i++], value = args[i++];
    if (option === "--model" && model === undefined) model = readModelSelection(value);
    else if (option === "--macro-requests" && maxRequests === undefined && value !== undefined &&
        /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))) maxRequests = Number(value);
    else if (option === "--task" && task === undefined && value?.trim() && value.length <= 2048 &&
        !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) task = value;
    else throw new Error(`Invalid or repeated ${option}.`);
  }
  if (!model) throw new Error("--strategy model requires --model PROVIDER/MODEL.");
  const rawGoal = args[i];
  if (!rawGoal || rawGoal.startsWith("--")) throw new Error("Select a Survival goal after the supported strategy options.");
  const goal = SURVIVAL_AGENT_GOALS.find(item => item === rawGoal);
  if (!goal) throw new Error(`Unknown Survival goal ${JSON.stringify(rawGoal)}. Choose ${SURVIVAL_AGENT_GOALS.join(", ")}.`);
  const game = args.slice(i);
  if (game.includes("--replay-incident")) throw new Error("Strategic play uses the ordinary lane, not an incident replay.");
  const taskGoal = task && namedGoal(task);
  if (taskGoal && taskGoal !== goal) throw new Error(`--task names ${taskGoal}, but the selected goal is ${goal}.`);
  if (task && !taskGoal) throw new Error("Local Model accepts only the selected built-in goal; custom constrained programs are no longer supported.");
  return { game, model: { strategy: "model", model, maxRequests: maxRequests ?? 8, ...(task ? { task } : {}) } };
}
