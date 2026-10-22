import type { Agent } from "@oh-my-pi/pi-agent-core/agent";
import type { AgentTool } from "@oh-my-pi/pi-agent-core/types";
import type { AuthManager } from "../server/auth.ts";
import type { Store } from "../server/store.ts";
import type { AuthState } from "../shared/contracts.ts";
import { bounded, requireProof } from "./native-game.ts";

const MODEL = "zero-provider-native-diagnostic";
const definitions = [
  { name: "Infrastructure predecessor", source: 'for (let step = 0; step < 2; step++) { await game.observe(); const result = await game.action({kind:"move",controls:{forward:true,sneak:true},duration_ms:1000}); if (result.status !== "succeeded") return {status:"blocked",summary:"Bounded infrastructure motor did not succeed",result}; } return {status:"completed",summary:"Two infrastructure motor probes completed; not a gameplay goal",result:null};' },
  { name: "Infrastructure follow-up", source: 'const observation = await game.observe(); if (observation.life.status !== "alive") return {status:"blocked",summary:"Infrastructure probe requires an alive observation",result:null}; const result = await game.action({kind:"look",yaw:observation.player.yaw + 0.05,pitch:0}); return {status:result.status === "succeeded" ? "completed" : "blocked",summary:"One infrastructure gaze probe; not gameplay success",result};' },
] as const;
export const DIAGNOSTIC_PROGRAMS = Object.freeze({ predecessor: definitions[0].name, followup: definitions[1].name });
type Resolvers<T> = ReturnType<typeof Promise.withResolvers<T>>;
export interface PlanningDiagnosticProbe {
  readonly run_id: string;
  readonly guard_source: string | undefined;
  readonly allow: boolean;
  readonly activation: "manual" | "on_predecessor_success";
  readonly entered: Resolvers<{ tools: string[] }>;
  readonly release: Resolvers<void>;
  readonly staged: Resolvers<unknown>;
  capturedActivate: (() => Promise<unknown>) | null;
  owner: object | null;
}
type Probe = "planning_root" | "planning_activate" | "planning_capture";
interface Choice { run_id: string; probe: Probe; admitted: Resolvers<unknown> }

/** Only the strategist is synthetic. No credentials, provider sockets, gameplay strategy or promotion. */
export class DiagnosticAgent {
  readonly model_id = MODEL;
  readonly transcript: Array<Record<string, unknown>> = [];
  synthetic_gate_admissions = 0;
  agents_created = 0;
  #choices: Choice[] = [];
  #waiting: { owner: object; delivery: Resolvers<Choice | null> } | null = null;
  #planning: PlanningDiagnosticProbe | null = null;
  readonly #choiceTimeoutMs: number;
  readonly #planningHoldMs: number;
  constructor(private readonly store: Store, options: { choiceTimeoutMs?: number; planningHoldMs?: number } = {}) {
    this.#choiceTimeoutMs = options.choiceTimeoutMs ?? 25_000;
    this.#planningHoldMs = options.planningHoldMs ?? 12_000;
  }

  preparePlanning(run_id: string, guard_source: string | undefined, allow: boolean, options: { activation?: "manual" | "on_predecessor_success" } = {}): PlanningDiagnosticProbe {
    requireProof(this.#planning?.run_id !== run_id, "One planning experiment is permitted per diagnostic run");
    const probe: PlanningDiagnosticProbe = { run_id, guard_source, allow, activation: options.activation ?? "manual",
      entered: Promise.withResolvers(), release: Promise.withResolvers(), staged: Promise.withResolvers(), capturedActivate: null, owner: null };
    void probe.entered.promise.catch(() => {});
    void probe.staged.promise.catch(() => {});
    this.#planning = probe;
    return probe;
  }

  choose(run_id: string, probe: Probe): Promise<unknown> {
    const choice: Choice = { run_id, probe, admitted: Promise.withResolvers() };
    void choice.admitted.promise.catch(() => {});
    if (this.#waiting) { const waiting = this.#waiting; this.#waiting = null; waiting.delivery.resolve(choice); }
    else this.#choices.push(choice);
    return bounded(choice.admitted.promise, this.#choiceTimeoutMs, `Synthetic ${probe} was not consumed by the real scheduler`);
  }

  auth(): AuthManager {
    const state: AuthState = { status: "ready", authenticated: true, provider: "openai-codex", account_label: "Synthetic native infrastructure diagnostic; zero provider calls",
      models: [{ id: MODEL, name: "Synthetic infrastructure caller (not a provider)", provider: "private-diagnostic", context_window: null }], login: null, error: null };
    return {
      snapshot: () => state,
      createAgent: async (options: { tools: AgentTool[] }) => {
        this.agents_created++;
        const owner = {};
        let gate: Parameters<Agent["setBeforeModelCall"]>[0] | undefined;
        let cancelled = false;
        let active: Promise<void> = Promise.resolve();
        let tools = [...options.tools];
        const api = {
          beforeToolCall: undefined as ((context: { tool: AgentTool }, signal?: AbortSignal) => unknown) | undefined,
          setBeforeModelCall: (hook: Parameters<Agent["setBeforeModelCall"]>[0]) => { gate = hook; },
          subscribe: () => () => {}, replaceMessages: () => {},
          setTools: (selected: AgentTool[]) => { tools = [...selected]; this.transcript.push({ type: "synthetic_sdk_tools_set", tools: tools.map(tool => tool.name) }); },
          abort: () => {
            cancelled = true;
            if (this.#waiting?.owner === owner) { this.#waiting.delivery.resolve(null); this.#waiting = null; }
            if (this.#planning?.owner === owner) { this.#planning.release.resolve(); this.#planning.staged.reject(new Error("Synthetic independent request aborted")); }
          },
          waitForIdle: async () => { await active.catch(() => {}); },
          prompt: (text: string) => {
            cancelled = false;
            active = (async () => {
              const context = JSON.parse(text) as { phase?: string; role?: string; speculative_plan?: unknown };
              const probe = this.#planning;
              requireProof(probe && this.store.getRun(probe.run_id), "Synthetic planning request has no current infrastructure run");
              const runId = probe.run_id;
              this.transcript.push({ type: "synthetic_prompt", run_id: runId, phase: context.phase, role: context.role });
              const admission = await gate?.({ systemPrompt: [], messages: [], tools });
              if (admission?.stop || cancelled) return;
              this.synthetic_gate_admissions++;
              const call = async (name: string, args: Record<string, unknown>) => {
                const tool = tools.find(candidate => candidate.name === name);
                requireProof(tool, `Production tool ${name} is unavailable`);
                const accepted = await api.beforeToolCall?.({ tool });
                requireProof(!cancelled && !(accepted && typeof accepted === "object" && "block" in accepted && accepted.block), `Production dispatch gate blocked diagnostic ${name}`);
                const result = await tool.execute(`native-diagnostic-${crypto.randomUUID()}`, args);
                this.transcript.push(JSON.parse(JSON.stringify({ type: "synthetic_tool", run_id: runId, tool: name, args, result: result.details, isError: result.isError === true })));
                return result;
              };
              if (context.role === "speculative") {
                requireProof(context.speculative_plan !== null && context.speculative_plan !== undefined, "Speculative caller has no prepared-next context");
                requireProof(tools.some(tool => tool.name === "prepare_next")
                  && tools.every(tool => ["observe", "program_inspect", "help", "prepare_next"].includes(tool.name)),
                  "Actual speculative SDK catalog retained write/effect authority");
                probe.owner = owner;
                probe.entered.resolve({ tools: tools.map(tool => tool.name) });
                try {
                  await bounded(probe.release.promise, this.#planningHoldMs, "Held independent request exceeded the finite diagnostic allowance");
                  if (cancelled) return;
                  const result = await call("prepare_next", { name: DIAGNOSTIC_PROGRAMS.followup, args: { allow: probe.allow },
                    limits: { duration_ms: 10_000, max_actions: 1, max_calls: 4, max_depth: 1 },
                    ...(probe.guard_source === undefined ? {} : { guard_source: probe.guard_source }) });
                  requireProof(!result.isError, `Production prepare_next rejected infrastructure candidate: ${JSON.stringify(result.details)}`);
                  probe.staged.resolve(result.details);
                } catch (error) { probe.staged.reject(error); throw error; }
                return;
              }
              if (context.role === "review" || context.phase === "reviewing") return;
              for (const definition of definitions) {
                if (this.store.skills(runId).some(skill => skill.name === definition.name)) continue;
                const result = await call("program_write", { ...definition, dependencies: [], card: {
                  purpose: "Exercise the native Runtime planning boundary", applicability: "Evaluator-owned isolated infrastructure fixture only",
                  method: "Bounded observation and neutral motor probes", reason: "Real Fabric, Docker, bridge, source integrity and admission evidence",
                  limitations: "Synthetic caller, no provider/model authorship, resource strategy, gameplay success, promotion or efficiency claim",
                } });
                requireProof(!result.isError, `Production program validation rejected ${definition.name}: ${JSON.stringify(result.details)}`);
              }
              let choice = this.#choices.shift() ?? null;
              if (!choice) {
                const delivery = Promise.withResolvers<Choice | null>();
                this.#waiting = { owner, delivery };
                choice = await delivery.promise;
                if (this.#waiting?.owner === owner) this.#waiting = null;
              }
              if (!choice || cancelled) return;
              try {
                requireProof(choice.run_id === runId, "Synthetic choice belongs to an obsolete infrastructure task");
                if (choice.probe === "planning_capture") {
                  const tool = tools.find(candidate => candidate.name === "program_run");
                  requireProof(tool, "Current main execution-control tool cannot be captured");
                  probe.capturedActivate = async () => {
                    const result = await tool.execute(`native-stale-${crypto.randomUUID()}`, { operation: "activate_next" });
                    const receipt = JSON.parse(JSON.stringify({ details: result.details, isError: result.isError === true }));
                    this.transcript.push({ type: "synthetic_stale_activation_result", run_id: runId, ...receipt });
                    return receipt;
                  };
                  choice.admitted.resolve({ captured: true });
                  return;
                }
                const result = await call("program_run", choice.probe === "planning_activate" ? { operation: "activate_next" } : {
                  operation: "start", name: DIAGNOSTIC_PROGRAMS.predecessor, args: null,
                  limits: { duration_ms: 25_000, max_actions: 3, max_calls: 8, max_depth: 1 },
                  next: { after_ms: 0, reason: "Zero-provider native planning infrastructure diagnostic", budget: { calls: 1, tools: 2, duration_ms: 20_000 }, activation: probe.activation },
                });
                requireProof(!result.isError, `Production ${choice.probe} rejected diagnostic: ${JSON.stringify(result.details)}`);
                choice.admitted.resolve(result.details);
              } catch (error) { choice.admitted.reject(error); throw error; }
            })();
            return active;
          },
        };
        return api as unknown as Agent;
      },
      releaseAgent: async (agent: Agent) => { agent.abort(); await agent.waitForIdle(); },
    } as unknown as AuthManager;
  }
}
