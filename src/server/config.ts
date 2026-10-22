import path from "node:path";

export const PROJECT_ROOT = path.resolve(import.meta.dir, "../..");
export const DATA_DIR = path.resolve(
  process.env.GAMEHARNESS_DATA_DIR ?? path.join(PROJECT_ROOT, "local/runtime"),
);
export const APP_PORT = Number(process.env.GAMEHARNESS_PORT ?? 4317);
const desktop = process.env.GAMEHARNESS_DESKTOP === "1";
if (
  !Number.isInteger(APP_PORT) ||
  (APP_PORT === 0 ? !desktop : APP_PORT < 1024 || APP_PORT > 65535)
)
  throw new Error(
    "GAMEHARNESS_PORT must be 1024–65535, or 0 for an owned desktop backend",
  );
export let APP_ORIGIN = `http://127.0.0.1:${APP_PORT}`;
export const OPERATOR_ORIGINS = [
  APP_ORIGIN,
  `http://localhost:${APP_PORT}`,
  ...(!desktop ? ["http://127.0.0.1:5173", "http://localhost:5173"] : []),
];

export function setListeningPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("The backend did not obtain a valid listening port");
  APP_ORIGIN = `http://127.0.0.1:${port}`;
  OPERATOR_ORIGINS[0] = APP_ORIGIN;
  OPERATOR_ORIGINS[1] = `http://localhost:${port}`;
}
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
