import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MacroObservation } from "../src/server/survival-macro/protocol.ts";
import {
  SurvivalMacroSkills, type MacroSkillTrialAttestation, type SurvivalMacroSkillOptions,
} from "../src/server/survival-macro/skills.ts";

const syntheticOrdinary: MacroObservation = {
  v: 1, run: "ordinary-fixture", life: 1, epoch: 81, tick: 240, goal: "wooden_pickaxe",
  health: 20, food: 20, inventory: {}, recent: [], quiescent: true,
  opportunities: [
    { id: "offer-survey", verb: "survey", risk: "read", summary: "Read the skyline.", evidence: "visible-skyline" },
  ],
};
const safeSelector = `export function analyze(o) {
  return o.opportunities.find(offer => offer.verb === "survey" && offer.risk === "read")?.id ?? null;
}`;
const healthySelector = `export function analyze(o) {
  if (o.health <= 5) return null;
  return o.opportunities.find(offer => offer.verb === "survey" && offer.risk === "read")?.id ?? null;
}`;

function setup(overrides: Partial<SurvivalMacroSkillOptions> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "survival-macro-skills-"));
  const options: SurvivalMacroSkillOptions = {
    directory, projectRoot: new URL("..", import.meta.url).pathname,
    worldId: syntheticOrdinary.run, actorJarSha256: "a".repeat(64),
    capabilityVersion: "survival-macro/v1", adapterVersion: "test-adapter/v1",
    lowRiskVerbs: ["survey", "approach"], readTrial: () => null,
    isNeutralHandoff: obs => obs === syntheticOrdinary,
    ...overrides,
  };
  const skills = new SurvivalMacroSkills(options);
  return { skills, options, async close() {
    try { await skills.close(); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  } };
}

test("skill admission quarantines ambient code and cannot extend automatic game permissions", async () => {
  const f = setup();
  try {
    for (const source of [
      `export function analyze(o) { return process.env.PATH; }`,
      `export function analyze(o) { return game.click(o.opportunities[0].id); }`,
      `export function analyze(o) { return import("node:fs"); }`,
      `export function analyze(o) { return Date.now() > 0 ? o.opportunities[0].id : null; }`,
      `let count = 0; export function analyze(o) { return ++count ? o.opportunities[0].id : null; }`,
      `export async function analyze(o) { return o.opportunities[0].id; }`,
    ]) {
      const hash = f.skills.draft({ source, parentGeneration: 0, verbs: ["survey"] });
      expect(await f.skills.validate(hash)).toBe(false);
      expect(f.skills.status(hash)).toBe("quarantined");
      expect(f.skills.promote(hash, 0, syntheticOrdinary)).toBe(false);
    }
    expect(() => f.skills.draft({ source: safeSelector, parentGeneration: 0, verbs: ["break"] }))
      .toThrow("capability scope");
    expect(await f.skills.select(syntheticOrdinary)).toBeNull();
  } finally { await f.close(); }
});

test("a draft digest is immutable, scoped to its original run and generation, and cannot start a trial", async () => {
  const f = setup();
  try {
    const hash = f.skills.draft({ source: safeSelector, parentGeneration: 0, verbs: ["survey"] });
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(f.skills.draft({ source: safeSelector, parentGeneration: 0, verbs: ["survey"] })).toBe(hash);
    expect(() => f.skills.draft({ source: safeSelector, parentGeneration: 0, verbs: ["approach"] }))
      .toThrow("immutable binding");
    expect(() => f.skills.draft({ source: safeSelector, parentGeneration: 1, verbs: ["survey"] }))
      .toThrow("generation is stale");
    expect(() => f.skills.beginTrial(hash, "trial-fixture")).toThrow("not eligible");
    await f.skills.close();
    expect(() => new SurvivalMacroSkills({ ...f.options, worldId: "another-run" }))
      .toThrow("pinned to another run");
    const reopened = new SurvivalMacroSkills(f.options);
    try {
      expect(reopened.status(hash)).toBe("draft");
      expect(reopened.selection()).toEqual({ generation: 0, hash: null });
    } finally { await reopened.close(); }
  } finally { await f.close(); }
});

const dockerTest = process.env.GAMEHARNESS_DOCKER_MODULE_SMOKE === "1" ? test : test.skip;

dockerTest("real isolated computation passes independent gates but selection additionally requires exact trial proof", async () => {
  // This is a trust-seam test of promotion policy, not a game trial. The real
  // game verifier supplies this attestation in production.
  let latest = syntheticOrdinary;
  const attestations = new Map<string, MacroSkillTrialAttestation>();
  const f = setup({
    readTrial: binding => attestations.get(binding.skillHash) ?? null,
    isNeutralHandoff: observation => observation === latest,
  });
  const { skills } = f;
  const prepareTrial = async (source: string, generation: number, run: string) => {
    const hash = skills.draft({ source, parentGeneration: generation, verbs: ["survey"] });
    expect(await skills.validate(hash)).toBe(true);
    expect(await skills.shadow(hash, syntheticOrdinary)).toEqual({ opportunityId: "offer-survey", skillHash: hash });
    const binding = skills.beginTrial(hash, run);
    const diagnostics = { ...syntheticOrdinary, run };
    expect(await skills.probeTrial(hash, diagnostics)).toEqual({ opportunityId: "offer-survey", skillHash: hash });
    expect(await skills.probeTrial(hash, diagnostics)).toBeNull();
    const proof: MacroSkillTrialAttestation = {
      ...binding, run, life: diagnostics.life, intentId: "actual-trial-intent-adapter-fixture",
      opportunityId: "offer-survey", verb: "survey", receiptTick: 242, effectRef: `sha256:${"b".repeat(64)}`,
    };
    return { hash, proof };
  };
  try {
    const blind = skills.draft({
      source: "export function analyze(o) { return o.opportunities[0]?.id ?? null; }",
      parentGeneration: 0, verbs: ["survey"],
    });
    expect(await skills.validate(blind)).toBe(false);
    expect(skills.status(blind)).toBe("quarantined");
    const first = await prepareTrial(safeSelector, 0, "trial-one");
    expect(await skills.select(syntheticOrdinary)).toBeNull();
    expect(skills.promote(first.hash, 0, syntheticOrdinary)).toBe(false);
    attestations.set(first.hash, { ...first.proof, actorJarSha256: "c".repeat(64) });
    expect(skills.promote(first.hash, 0, syntheticOrdinary)).toBe(false);
    attestations.set(first.hash, { ...first.proof, opportunityId: "other-trial-action" });
    expect(skills.promote(first.hash, 0, syntheticOrdinary)).toBe(false);
    attestations.set(first.hash, first.proof);
    expect(skills.promote(first.hash, 0, { ...syntheticOrdinary, quiescent: false })).toBe(false);
    expect(skills.promote(first.hash, 0, { ...syntheticOrdinary })).toBe(false);
    latest = { ...syntheticOrdinary, tick: 248, opportunities: [{
      ...syntheticOrdinary.opportunities[0]!, evidence: "different-visible-skyline",
    }] };
    expect(skills.promote(first.hash, 0, latest)).toBe(false);
    expect(await skills.shadow(first.hash, latest)).toEqual({ opportunityId: "offer-survey", skillHash: first.hash });
    expect(skills.promote(first.hash, 0, latest)).toBe(true);
    latest = syntheticOrdinary;
    expect(await skills.select(syntheticOrdinary)).toEqual({ opportunityId: "offer-survey", skillHash: first.hash });

    const second = await prepareTrial(healthySelector, 1, "trial-two");
    attestations.set(second.hash, second.proof);
    expect(skills.promote(second.hash, 0, syntheticOrdinary)).toBe(false);
    expect(skills.promote(second.hash, 1, syntheticOrdinary)).toBe(true);
    skills.quarantine(second.hash, "observed regression");
    expect(await skills.select(syntheticOrdinary)).toBeNull();
    expect(skills.revert(2, syntheticOrdinary)).toBe(true);
    expect(skills.selection()).toEqual({ generation: 3, hash: first.hash });
    expect(await skills.select(syntheticOrdinary)).toEqual({ opportunityId: "offer-survey", skillHash: first.hash });
  } finally { await f.close(); }
}, 120_000);
