import { expect, test } from "bun:test";
import { serverProperties } from "../src/agent/run.ts";
test("ordinary v2 worlds are fresh random Normal Survival worlds with no operator seed or diagnostic provisioning", () => {
  const properties = serverProperties(25565);
  expect(properties).toContain("server-ip=127.0.0.1\nserver-port=25565\n");
  expect(properties).toContain("gamemode=survival\ndifficulty=normal\n");
  expect(properties).not.toContain("level-seed=");
  expect(properties).not.toContain("level-type=minecraft\\:flat");
  expect(properties).toContain("max-players=1\n");
  expect(properties).toContain("enable-rcon=false\n");
});
