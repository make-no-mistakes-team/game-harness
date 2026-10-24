import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalContractJson } from "../src/server/adapter-contract.ts";
import { buildNativeContract } from "../src/server/native-contract.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = path.join(projectRoot, "native/minecraft/build/generated/nativeContract");
const contract = await buildNativeContract(projectRoot);
await mkdir(directory, { recursive: true });
await writeFile(path.join(directory, "gameharness-native-contract.json"), canonicalContractJson(contract) + "\n");
