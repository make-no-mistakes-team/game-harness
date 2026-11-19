export interface TerraOptions {
  strategy: "terra";
  maxRequests: number;
  task?: string;
}

/** No provider call, credentials lookup, or upload unless this run explicitly selects Terra. */
export function readStrategy(args: string[]): { game: string[]; macro?: TerraOptions } {
  if (args[0] !== "--strategy") return { game: args };
  if (args[1] !== "terra") throw new Error("Expected --strategy terra. Omit it for model-free play.");
  let i = 2, maxRequests: number | undefined, task: string | undefined;
  while (args[i] === "--macro-requests" || args[i] === "--task") {
    const option = args[i++], value = args[i++];
    if (option === "--macro-requests" && maxRequests === undefined &&
        value !== undefined && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))) {
      maxRequests = Number(value);
    } else if (option === "--task" && task === undefined && value?.trim() && value.length <= 2048
        && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
      task = value;
    } else throw new Error(`Invalid or repeated ${option}.`);
  }
  if (!args[i] || args[i]!.startsWith("--")) throw new Error("Select a Survival goal after the strategy options.");
  const game = args.slice(i);
  if (game.includes("--replay-incident")) throw new Error("Strategic play uses the ordinary lane, not an incident replay.");
  return { game, macro: { strategy: "terra", maxRequests: maxRequests ?? 8, ...(task ? { task } : {}) } };
}
