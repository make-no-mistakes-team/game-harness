import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SurvivalMacroController } from "../src/server/survival-macro/controller.ts";
import {
  parseMacroIntent, type MacroIntent, type MacroObservation, type MacroOpportunity, type MacroProposal,
  type MacroReceipt, type MacroRequest,
} from "../src/server/survival-macro/protocol.ts";

test("later decisions use bounded, dated outcomes without reviving stale plans or prior lives", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "macro-memory-"));
  const run = "memory-test";
  const runDir = join(root, run);
  const requests: MacroRequest[] = [];
  const thirdDecision = Promise.withResolvers<void>();
  const survey: MacroOpportunity = {
    id: "survey-one", verb: "survey", summary: "Survey the nearby terrain", risk: "read", evidence: "A stationary view.",
  };
  const walk: MacroOpportunity = {
    id: "walk-one", verb: "approach", summary: "Walk toward the ridge", risk: "low", evidence: "A flat adjacent tile.",
  };
  const inspect: MacroOpportunity = {
    id: "inspect-one", verb: "inspect", summary: "Inspect the face", risk: "read", evidence: "A visible face.",
  };
  const surveyDetail = "The requested camera angle rendered.";
  const controller = new SurvivalMacroController({
    runDir, run, strategy: "terra", limits: { pollMs: 1_000 },
    confirmNativeExit: async () => true,
    strategist: async request => {
      requests.push(request);
      const { observation, strategicEpisodes } = request;
      const surveyHistory = strategicEpisodes?.find(episode => episode.outcome.source === "native" &&
        episode.outcome.verb === "survey" && episode.outcome.status === "completed" &&
        episode.outcome.detail === surveyDetail && episode.objectiveStatus === "not-evaluated");
      const rejected = (disposition: "stale" | "native_capability_gap") => strategicEpisodes?.some(({ outcome }) =>
        outcome.source === "host" && outcome.status === "not-issued" && outcome.disposition === disposition);
      let action: MacroProposal["action"] = { kind: "abstain" };
      let subgoal = "Find shelter";
      switch (requests.length) {
        case 1: action = { kind: "opportunity", opportunityId: survey.id }; break;
        case 2: if (surveyHistory) action = { kind: "opportunity", opportunityId: "survey-two" }; break;
        case 3:
          await thirdDecision.promise;
          subgoal = "Scout the ridge on foot";
          if (surveyHistory) action = { kind: "opportunity", opportunityId: walk.id };
          break;
        case 4:
          subgoal = "Find a safe way to the ridge";
          if (surveyHistory && rejected("stale")) {
            action = { kind: "gap", capability: "Verify that the far side of the ridge is safe." };
          }
          break;
        case 5:
          if (rejected("native_capability_gap")) {
            action = { kind: "opportunity", opportunityId: inspect.id };
          }
          break;
      }
      const { run, life, epoch, tick } = observation;
      return {
        basis: { run, life, epoch, tick }, model: "fixture-model", outcome: "completed",
        dispatched: false, usage: null, costUsd: null,
        proposal: { action, subgoal, successCondition: "See a sheltered entrance.", expiresTick: tick + 30,
          reason: "Check the visible terrain.", contingency: "Stop if the tile changes.", alternative: "Inspect from here." },
      };
    },
  });
  const publish = async (name: string, value: MacroObservation | MacroReceipt) => {
    const file = join(controller.directory, name);
    await writeFile(`${file}.next`, JSON.stringify(value), { mode: 0o600 });
    await rename(`${file}.next`, file);
  };
  const observe = (tick: number, epoch: number, life: number, opportunities: readonly MacroOpportunity[]) =>
    publish("observation.json", { v: 1, run, tick, epoch, life, opportunities, goal: "Explore nearby terrain",
      health: 20, food: 20, inventory: {}, recent: [], quiescent: true });
  const receive = (intent: MacroIntent, tick: number, status: MacroReceipt["status"], detail: string) =>
    publish("receipt.json", { v: 1, run, id: intent.id, life: intent.life, tick, status, detail });
  const until = async (condition: () => boolean) => {
    for (let i = 0; !condition() && i < 20; i++) await controller.poll();
    expect(condition()).toBe(true);
  };
  const intent = async (issued: number) => {
    await until(() => controller.status().issued === issued);
    return parseMacroIntent(JSON.parse(await readFile(join(controller.directory, "intent.json"), "utf8")));
  };

  try {
    await mkdir(runDir, { mode: 0o700 });
    await controller.start();
    await observe(10, 1, 1, [survey]);
    const first = await intent(1);
    expect(requests[0]?.strategicEpisodes).toBeUndefined();
    await receive(first, 11, "accepted", "The camera turn was accepted.");
    await observe(11, 1, 1, [survey]);
    await controller.poll();
    expect(requests).toHaveLength(1);

    await receive(first, 12, "completed", surveyDetail);
    await observe(12, 2, 1, [{ ...survey, id: "survey-two" }]);
    const repeat = await intent(2);
    expect(repeat.opportunityId).toBe("survey-two");
    expect(requests[1]?.strategicEpisodes?.[0]).toMatchObject({
      basis: { run, life: 1, tick: 10, epoch: 1 }, hypothesis: { subgoal: "Find shelter", expected: "See a sheltered entrance." },
      objectiveStatus: "not-evaluated", outcome: { source: "native", id: first.id, tick: 12, status: "completed", detail: surveyDetail },
    });

    await receive(repeat, 14, "completed", surveyDetail);
    await observe(14, 3, 1, [walk, inspect]);
    await until(() => requests.length === 3);
    expect(requests[2]?.strategicEpisodes).toHaveLength(1);
    expect(requests[2]?.strategicEpisodes?.[0]?.outcome).toMatchObject({ id: repeat.id });
    await observe(15, 3, 1, [inspect]);
    thirdDecision.resolve();
    const alternate = await intent(3);
    expect(alternate.opportunityId).toBe(inspect.id);
    expect(requests[3]?.strategicEpisodes).toHaveLength(2);
    expect(requests[3]?.strategicEpisodes?.[0]).toMatchObject({
      basis: { run, life: 1, tick: 14 }, hypothesis: { subgoal: "Scout the ridge on foot" },
      outcome: { source: "host", status: "not-issued", disposition: "stale" },
    });
    expect(requests[4]?.strategicEpisodes).toHaveLength(3);
    expect(requests[4]?.strategicEpisodes?.[0]?.outcome).toEqual({
      source: "host", status: "not-issued", disposition: "native_capability_gap",
    });
    expect(JSON.stringify(requests[4]?.strategicEpisodes)).not.toContain(walk.id);

    await receive(alternate, 16, "interrupted", "The face moved out of view.");
    await observe(16, 4, 1, [inspect]);
    await until(() => requests.length === 6);
    expect(requests[5]?.strategicEpisodes).toHaveLength(3);
    expect(requests[5]?.strategicEpisodes?.[0]?.outcome).toMatchObject({
      source: "native", status: "interrupted", id: alternate.id,
    });
    expect(requests[5]?.strategicEpisodes?.some(({ outcome }) => outcome.source === "native" && outcome.verb === "survey"))
      .toBe(false);

    await observe(17, 5, 2, [inspect]);
    await until(() => requests.length === 7);
    expect(requests[6]?.lastReceipt).toBeNull();
    expect(requests[6]?.strategicEpisodes).toBeUndefined();
  } finally {
    thirdDecision.resolve();
    try { await controller.stop(); } finally { await rm(root, { recursive: true, force: true }); }
  }
});
