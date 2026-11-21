import { SURVIVAL_AGENT_GOALS, type SurvivalAgentGoal } from "../src/shared/survival-agent-ui.ts";

export interface TerraOptions {
  strategy: "terra";
  control: "local" | "preset" | "constrained";
  maxRequests: number;
  startup: "allow" | "off";
  skillTrials: "allow" | "off";
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
    // These verbs repeat what the vanilla item verifier already requires.
    const proofVerb = goal === "diamond" ? "mine" : "craft";
    return phrase === `obtain ${item}` || phrase === `${proofVerb} ${item}`;
  });
}

/** No provider call, credentials lookup, or upload unless this run explicitly selects Terra. */
export function readStrategy(args: string[]): { game: string[]; terra?: TerraOptions } {
  if (args[0] !== "--strategy") return { game: args };
  if (args[1] !== "terra") throw new Error("Expected --strategy terra. Omit it for model-free play.");
  let i = 2, maxRequests: number | undefined, task: string | undefined;
  let startup: TerraOptions["startup"] | undefined, skillTrials: TerraOptions["skillTrials"] | undefined;
  let requestedControl: "local" | "constrained" | undefined;
  while (args[i] === "--macro-requests" || args[i] === "--task" || args[i] === "--startup" ||
      args[i] === "--skill-trials" || args[i] === "--control") {
    const option = args[i++], value = args[i++];
    if (option === "--macro-requests" && maxRequests === undefined &&
        value !== undefined && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))) {
      maxRequests = Number(value);
    } else if (option === "--startup" && startup === undefined && (value === "allow" || value === "off")) {
      startup = value;
    } else if (option === "--skill-trials" && skillTrials === undefined && (value === "allow" || value === "off")) {
      skillTrials = value;
    } else if (option === "--control" && requestedControl === undefined && (value === "local" || value === "constrained")) {
      requestedControl = value;
    } else if (option === "--task" && task === undefined && value?.trim() && value.length <= 2048
        && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
      task = value;
    } else throw new Error(`Invalid or repeated ${option}.`);
  }
  const rawGoal = args[i];
  if (!rawGoal || rawGoal.startsWith("--")) throw new Error("Select a Survival goal after the strategy options.");
  const goal = SURVIVAL_AGENT_GOALS.find(item => item === rawGoal);
  if (!goal) throw new Error(`Unknown Survival goal ${JSON.stringify(rawGoal)}. Choose ${SURVIVAL_AGENT_GOALS.join(", ")}.`);
  const game = args.slice(i);
  if (game.includes("--replay-incident")) throw new Error("Strategic play uses the ordinary lane, not an incident replay.");
  const taskGoal = task && namedGoal(task);
  if (taskGoal && taskGoal !== goal)
    throw new Error(`--task names ${taskGoal}, but the selected goal is ${goal}. Select the matching goal or remove --task.`);
  if (task && !taskGoal && requestedControl !== "constrained")
    throw new Error(`Local Terra cannot enforce custom instructions. Omit --task or use --strategy terra --control constrained --task TEXT ${goal}.`);
  if (requestedControl === "constrained" && !task)
    throw new Error("--control constrained requires --task TEXT. Omit --control constrained to play the built-in goal locally.");
  if (requestedControl === "local" && skillTrials === "allow")
    throw new Error("--control local cannot be combined with --skill-trials allow.");
  const control = requestedControl ?? (skillTrials === "allow" ? (task ? "constrained" : "preset") : "local");
  if (control === "local" && startup === "allow")
    throw new Error("Local Terra waits for a live observation. Omit --startup allow or use an explicit constrained run or skill study.");
  return { game, terra: { strategy: "terra", control, maxRequests: maxRequests ?? 8,
    startup: startup ?? (control === "local" ? "off" : "allow"), skillTrials: skillTrials ?? "off",
    ...(task ? { task } : {}) } };
}
