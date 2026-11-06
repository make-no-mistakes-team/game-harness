import type { Agent } from "@oh-my-pi/pi-agent-core/agent";

type BeforeModelCallHook = Parameters<Agent["addBeforeModelCallHook"]>[0];

/** Hook lifecycle for deliberate synthetic evaluators, not an Agent replacement. */
export class DiagnosticModelHooks {
  private readonly hooks = new Set<BeforeModelCallHook>();

  add = (hook: BeforeModelCallHook): (() => void) => {
    this.hooks.add(hook);
    return () => { this.hooks.delete(hook); };
  };

  async run(signal: Parameters<BeforeModelCallHook>[0], context: Parameters<BeforeModelCallHook>[1]): Promise<void> {
    for (const hook of this.hooks) await hook(signal, context);
  }
}
