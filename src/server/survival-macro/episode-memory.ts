import {
  MACRO_MAX_STRATEGIC_EPISODES, MACRO_NOT_ISSUED_DISPOSITIONS,
  type MacroBasis, type MacroEpisodeOutcome, type MacroObservation, type MacroOpportunity,
  type MacroReceipt, type MacroStrategicEpisode,
} from "./protocol.ts";

const RETAINED_EPISODES = 8;
const MAX_TEXT_LENGTH = 160;

function excerpt(text: string): string {
  return text.length <= MAX_TEXT_LENGTH ? text : `${text.slice(0, MAX_TEXT_LENGTH - 1).trimEnd()}…`;
}

function normalized(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

export function episodeMatchesBasis({ basis: dated, outcome }: MacroStrategicEpisode, current: MacroBasis): boolean {
  return dated.run === current.run && dated.life === current.life && dated.epoch <= current.epoch &&
    dated.tick <= current.tick && (!("tick" in outcome) || outcome.tick <= current.tick);
}

interface PlanMemory {
  readonly requestId: string;
  readonly goal: string;
  readonly basis: MacroBasis;
  readonly hypothesis: MacroStrategicEpisode["hypothesis"];
  issued: boolean;
}

/** A per-controller projection of the ordinary plan/receipt events, not a replay of their logs. */
export class StrategicEpisodeLedger {
  private plan?: PlanMemory;
  private readonly recent: { readonly goal: string; readonly key: string; readonly episode: MacroStrategicEpisode }[] = [];

  chosen(requestId: string, observation: MacroObservation, subgoal: string, expected: string): void {
    const { run, life, tick, epoch, goal } = observation;
    this.plan = { requestId, goal, issued: false, basis: Object.freeze({ run, life, tick, epoch }),
      hypothesis: Object.freeze({ subgoal: excerpt(subgoal), expected: excerpt(expected) }) };
  }

  issued(requestId: string): void {
    if (this.plan?.requestId === requestId) this.plan.issued = true;
  }

  rejected(requestId: string, event: string): void {
    const plan = this.plan;
    if (!plan || plan.requestId !== requestId || plan.issued) return;
    const disposition = MACRO_NOT_ISSUED_DISPOSITIONS.find(code => code === event);
    if (disposition) this.remember(plan, { source: "host", status: "not-issued", disposition });
  }

  terminal(requestId: string, { verb, summary }: MacroOpportunity, receipt: MacroReceipt): void {
    const plan = this.plan;
    if (!plan || plan.requestId !== requestId || !plan.issued || receipt.status === "accepted" ||
        receipt.run !== plan.basis.run || receipt.life !== plan.basis.life) return;
    this.remember(plan, { source: "native", status: receipt.status, id: receipt.id, tick: receipt.tick,
      verb, summary: excerpt(summary), detail: excerpt(receipt.detail) });
  }

  withdrawn(requestId: string, { verb, summary }: MacroOpportunity, id: string, tick: number): void {
    const plan = this.plan;
    if (!plan || plan.requestId !== requestId || !plan.issued) return;
    this.remember(plan, { source: "host", status: "withdrawn", id, tick, verb, summary: excerpt(summary) });
  }

  forObservation(observation: MacroObservation): readonly MacroStrategicEpisode[] | undefined {
    const episodes: MacroStrategicEpisode[] = [];
    for (const { goal, episode } of this.recent) {
      if (goal !== observation.goal || !episodeMatchesBasis(episode, observation) ||
          episodes.some(prior => prior.requestId === episode.requestId)) continue;
      episodes.push(episode);
      if (episodes.length === MACRO_MAX_STRATEGIC_EPISODES) break;
    }
    return episodes.length ? Object.freeze(episodes) : undefined;
  }

  private remember({ requestId, goal, basis, hypothesis }: PlanMemory, outcome: MacroEpisodeOutcome): void {
    const tactic = "verb" in outcome ? [outcome.verb, outcome.summary, "detail" in outcome ? outcome.detail : null] :
      [outcome.disposition];
    const key = JSON.stringify([basis.run, basis.life, goal, normalized(hypothesis.subgoal),
      normalized(hypothesis.expected), outcome.source, outcome.status, tactic]);
    const duplicate = this.recent.findIndex(record => record.key === key);
    if (duplicate !== -1) this.recent.splice(duplicate, 1);
    this.recent.unshift({ goal, key, episode: Object.freeze({
      requestId, basis, hypothesis, objectiveStatus: "not-evaluated", outcome: Object.freeze(outcome),
    }) });
    if (this.recent.length > RETAINED_EPISODES) this.recent.pop();
  }
}
