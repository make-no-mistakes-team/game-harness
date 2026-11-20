import actorManifest from "../../survival-agent/src/main/resources/fabric.mod.json";
import { readNativeArtifactContract } from "./native-artifact.ts";

export const TERRA_ACTOR_REBUILD =
  "The Survival Agent mod is missing or incompatible with Terra. Run `bun run build:agent`, then try again.";

export class TerraActorCompatibilityError extends Error {
  constructor() { super(TERRA_ACTOR_REBUILD); }
}

const WORK_WIRE = "gameharness:terra_work_wire";
// Version 2 retains staged crafting and adds the guarded model-origin iron furnace order and progress phase.
// Bump the manifest value when host work orders start requiring new actor behavior.
const workWireVersion = actorManifest.custom[WORK_WIRE];

export async function requireTerraActorWire(stagedJar: string): Promise<string> {
  const { resource, artifact_sha256 } = await readNativeArtifactContract(stagedJar, "fabric.mod.json")
    .catch(() => { throw new TerraActorCompatibilityError(); });
  if (resource && typeof resource === "object" && !Array.isArray(resource) && resource.id === actorManifest.id) {
    const { custom } = resource;
    if (custom && typeof custom === "object" && !Array.isArray(custom) && custom[WORK_WIRE] === workWireVersion)
      return artifact_sha256;
  }
  throw new TerraActorCompatibilityError();
}
