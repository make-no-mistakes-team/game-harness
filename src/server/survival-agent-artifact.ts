import actorManifest from "../../survival-agent/src/main/resources/fabric.mod.json";
import { readNativeArtifactContract } from "./native-artifact.ts";

export const MODEL_ACTOR_REBUILD =
  "The Survival Agent mod is missing or incompatible with model strategy. Run `bun run build:agent`, then try again.";

export class ModelActorCompatibilityError extends Error {
  constructor() { super(MODEL_ACTOR_REBUILD); }
}

const WORK_WIRE = "gameharness:model_work_wire";
// The manifest is the authority for both staging and the macro capability version.
const workWireVersion = actorManifest.custom[WORK_WIRE];

export async function requireModelActorWire(stagedJar: string): Promise<string> {
  const { resource, artifact_sha256 } = await readNativeArtifactContract(stagedJar, "fabric.mod.json")
    .catch(() => { throw new ModelActorCompatibilityError(); });
  if (resource && typeof resource === "object" && !Array.isArray(resource) && resource.id === actorManifest.id) {
    const { custom } = resource;
    if (custom && typeof custom === "object" && !Array.isArray(custom) && custom[WORK_WIRE] === workWireVersion)
      return artifact_sha256;
  }
  throw new ModelActorCompatibilityError();
}
