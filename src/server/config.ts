import { createHash } from "node:crypto";
import path from "node:path";

export const PROJECT_ROOT = path.resolve(import.meta.dir, "../..");
export const DATA_DIR = path.resolve(
  process.env.GAMEHARNESS_DATA_DIR ?? path.join(PROJECT_ROOT, "local/runtime"),
);
export const APP_PORT = Number(process.env.GAMEHARNESS_PORT ?? 4317);
if (!Number.isInteger(APP_PORT) || APP_PORT < 1024 || APP_PORT > 65535)
  throw new Error("GAMEHARNESS_PORT must be an integer from 1024 to 65535");
export const APP_ORIGIN = `http://127.0.0.1:${APP_PORT}`;
export const OPERATOR_ORIGINS = [
  APP_ORIGIN,
  `http://localhost:${APP_PORT}`,
  "http://127.0.0.1:5173",
  "http://localhost:5173",
];
export const OWNER_ID = createHash("sha256")
  .update(DATA_DIR)
  .digest("hex")
  .slice(0, 12);
export const MINECRAFT_VERSION = "1.21.4" as const;
export const MINECRAFT_PORT = Number(
  process.env.GAMEHARNESS_MINECRAFT_PORT ?? 25565,
);
if (
  !Number.isInteger(MINECRAFT_PORT) ||
  MINECRAFT_PORT < 1024 ||
  MINECRAFT_PORT > 65535
)
  throw new Error("Invalid Minecraft port");
export const MINECRAFT_SERVER_URL =
  "https://piston-data.mojang.com/v1/objects/4707d00eb834b446575d89a61a11b5d548d8c001/server.jar";
export const MINECRAFT_SERVER_SHA1 = "4707d00eb834b446575d89a61a11b5d548d8c001";
export const JAVA_IMAGE =
  "eclipse-temurin:21-jre@sha256:227118764cccd3c3294617061aaa93a08309c63a395eefa83e6b35032992ea99";
export const NODE_IMAGE =
  "node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5";
export const BOT_USERNAME = "GameHarness";
