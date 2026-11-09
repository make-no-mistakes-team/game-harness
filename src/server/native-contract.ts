import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AdapterDescriptor, AdapterSchemaCatalog } from "../shared/contracts.ts";
import { observationV3Schema } from "../shared/observations.ts";
import { minecraftActionSchema, minecraftBlockRemovalFactSchema, minecraftControllerFrameRequestSchema, minecraftEffectUncertaintyFactSchema, minecraftGuiTransactionFactSchema, minecraftObservationDataSchema, minecraftProductionFactSchema,
  minecraftProfileConfiguration, minecraftRecipesRequestSchema, minecraftVisibleScreenRequestSchema } from "../shared/minecraft.ts";
import { jsonSchema } from "../shared/primitives.ts";
import { adapterCompatibility, contractHash } from "./adapter-contract.ts";

export const NATIVE_CONTRACT_BUILD_INPUTS = [
  "native/minecraft/build.gradle", "native/minecraft/settings.gradle", "native/minecraft/gradlew",
  "package.json", "bun.lock", "scripts/build-native-contract.ts",
  "src/shared/contracts.ts", "src/shared/control.ts", "src/shared/controller.ts", "src/shared/resident.ts", "src/shared/control-session.ts", "src/shared/observations.ts", "src/shared/minecraft.ts", "src/shared/primitives.ts", "src/shared/adapter.ts",
  "src/shared/validation.ts", "src/shared/programs.ts", "src/shared/video.ts", "src/server/adapter-contract.ts", "src/server/native-contract.ts",
  "src/server/minecraft-adapter.ts", "src/server/actor-frames.ts", "src/server/video.ts",
];
export interface NativeBuildIdentity {
  schema_version: 1;
  inputs: { path: string; sha256: string }[];
  pins: { minecraft: string; yarn: string; fabric_loader: string; fabric_api: string; java_release: number };
}
export interface NativeContractResource {
  resource_schema: 1;
  build_inputs: NativeBuildIdentity;
  descriptor: AdapterDescriptor;
  schemas: AdapterSchemaCatalog;
}

export async function nativeBuildIdentity(projectRoot: string): Promise<NativeBuildIdentity> {
  const files = [...NATIVE_CONTRACT_BUILD_INPUTS];
  async function collect(relative: string): Promise<void> {
    const entries = await readdir(path.join(projectRoot, relative), { withFileTypes: true });
    for (const entry of entries) {
      const next = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await collect(next);
      else if (entry.isFile()) files.push(next);
      else throw new Error(`Native build input is not an ordinary file: ${next}`);
    }
  }
  await collect("native/minecraft/src/main");
  await collect("native/minecraft/src/client");
  files.sort();
  const inputs: NativeBuildIdentity["inputs"] = [];
  for (const relative of files) inputs.push({ path: relative,
    sha256: createHash("sha256").update(await readFile(path.join(projectRoot, relative))).digest("hex") });
  const build = await readFile(path.join(projectRoot, "native/minecraft/build.gradle"), "utf8");
  function pin(pattern: RegExp, label: string): string {
    const value = pattern.exec(build)?.[1];
    if (!value) throw new Error(`Pinned native ${label} is missing from actual build inputs`);
    return value;
  }
  return { schema_version: 1, inputs, pins: {
    minecraft: pin(/minecraft\s+'com\.mojang:minecraft:([^']+)'/, "Minecraft"),
    yarn: pin(/mappings\s+'net\.fabricmc:yarn:([^']+)'/, "Yarn"),
    fabric_loader: pin(/modImplementation\s+'net\.fabricmc:fabric-loader:([^']+)'/, "loader"),
    fabric_api: pin(/modImplementation\s+'net\.fabricmc\.fabric-api:fabric-api:([^']+)'/, "Fabric API"),
    java_release: Number(pin(/options\.release\s*=\s*(\d+)/, "Java release")),
  } };
}

/** Build/preparation only. Native ticks and video frames never recompute source/schema hashes. */
export function minecraftSchemaCatalog(): AdapterSchemaCatalog {
  return {
    observation: jsonSchema.parse(z.toJSONSchema(observationV3Schema)),
    payload: jsonSchema.parse(z.toJSONSchema(minecraftObservationDataSchema)),
    capabilities: {
      "minecraft.action@4": jsonSchema.parse(z.toJSONSchema(minecraftActionSchema)),
      "minecraft.recipes@1": jsonSchema.parse(z.toJSONSchema(minecraftRecipesRequestSchema)),
      "minecraft.visible_screen@1": jsonSchema.parse(z.toJSONSchema(minecraftVisibleScreenRequestSchema)),
      "minecraft.controller_frame@2": jsonSchema.parse(z.toJSONSchema(minecraftControllerFrameRequestSchema)),
    },
    evidence: {
      "minecraft_item_production_v1@1": jsonSchema.parse(z.toJSONSchema(minecraftProductionFactSchema)),
      "minecraft_gui_transaction_v1@1": jsonSchema.parse(z.toJSONSchema(minecraftGuiTransactionFactSchema)),
      "minecraft_block_removal_v1@1": jsonSchema.parse(z.toJSONSchema(minecraftBlockRemovalFactSchema)),
      "minecraft_effect_uncertainty_v1@1": jsonSchema.parse(z.toJSONSchema(minecraftEffectUncertaintyFactSchema)),
    },
  };
}

export async function buildNativeContract(projectRoot: string): Promise<NativeContractResource> {
  const buildInputs = await nativeBuildIdentity(projectRoot);
  const schemas = minecraftSchemaCatalog();
  const configuration = minecraftProfileConfiguration();
  const descriptor: AdapterDescriptor = { descriptor_schema: 1, game: { id: "minecraft", version: buildInputs.pins.minecraft },
    adapter: { id: "fabric-owned-client", version: "1.0.0", build_hash: contractHash(buildInputs) },
    observation: { schema_version: 3, schema_hash: contractHash(schemas.observation),
      payload_schema: { id: "minecraft_observation_v1", version: 2, hash: contractHash(schemas.payload) },
      profile: { id: "minecraft_assisted_rgb_360_r8_control_v6", version: 6, configuration,
        configuration_hash: contractHash(configuration) } },
    capabilities: Object.entries(schemas.capabilities).map(([key, schema]) => {
      const separator = key.lastIndexOf("@");
      return { id: key.slice(0, separator), version: Number(key.slice(separator + 1)), schema_hash: contractHash(schema) };
    }),
    actuator: "native", executable: { api_version: 5, validator_version: 5, runtime_version: 5 },
  };
  const compatible = adapterCompatibility(descriptor, schemas);
  return { resource_schema: 1, build_inputs: buildInputs, descriptor: compatible.descriptor, schemas };
}

/** Validate a generated resource independently against CURRENT source/build inputs before launch. */
export async function assertNativeContractFresh(projectRoot: string, generatedResource: unknown): Promise<NativeContractResource> {
  const current = await buildNativeContract(projectRoot);
  if (contractHash(generatedResource) !== contractHash(current))
    throw new Error("Native artifact contract is stale; rebuild from the current schema/profile/build inputs");
  return current;
}
