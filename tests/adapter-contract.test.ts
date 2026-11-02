import { expect, test } from "bun:test";
import { createConnection, type Server, type Socket } from "node:net";
import { GameBridgeClient } from "../src/server/game-bridge.ts";
import { validateProgramSource } from "../src/server/program-validation.ts";
import { observationSchema, skillCapabilitySchema } from "../src/shared/validation.ts";
import { minecraftActionSchema } from "../src/shared/minecraft.ts";
import { RegisteredAdapterContract } from "../src/server/registered-adapter.ts";
import { adapterDescriptorSchema } from "../src/shared/adapter.ts";
import { activeObservation, binding, descriptor, effectScope, historicalObservation, schemaCatalog, sha256 } from "./helpers/adapter-contract.ts";

// Actual production negotiation/admission/fingerprinting, with only native
// process ownership substituted; these fixtures never certify real gameplay.
const action = { kind: "look", yaw: 0.2, pitch: 0 };
function envelope() {
  const scope = effectScope();
  return { operation_id: "host-operation-A", compatibility_hash: binding().compatibility_hash, scope,
    invocation: { kind: "skill", execution_id: scope.execution_id, source_hash: scope.source_hash }, action, expected_screen: { kind: "absent" } };
}
async function transport(expected = descriptor()) {
  const options = { descriptor: expected, schemas: schemaCatalog(), onTiming: undefined };
  const bridge = new GameBridgeClient(process.cwd(), options);
  const scope = effectScope();
  const session = { secret: "1".repeat(64), world_id: scope.world_id, session_id: scope.session_id,
    epoch: scope.epoch, host: "127.0.0.1", port: 25565, control_port: 0, video_port: 0 };
  // Only the process-launch layer is replaced. Real TCP framing/hello/request and
  // production bridge validation execute; these receipts are NOT gameplay proof.
  Reflect.set(bridge, "owned", { child: { kill: () => true }, closed: Promise.resolve(),
    username: "contract-fixture", session, diagnostics: [] });
  Reflect.set(bridge, "state", { ...bridge.snapshot(), status: "connected", world_id: scope.world_id,
    epoch: scope.epoch, session_id: scope.session_id, binding: null,
    life: { life_id: scope.life_id, status: "alive", can_respawn: false, death: null },
    space: { dimension_id: "minecraft:overworld", space_epoch: scope.space_epoch }, screen: null });
  const requests: Record<string, unknown>[] = [];
  const peers: Socket[] = [];
  let receiptScopePatch: Record<string, unknown> = {};
  async function hello(patch: Record<string, unknown> = {}, kind: "control" | "video" = "control") {
    const port: number = await Reflect.get(bridge, "listener").call(bridge, kind);
    const server = (Reflect.get(bridge, "servers") as Server[]).at(-1)!;
    const received = Promise.withResolvers<void>();
    server.once("connection", socket => {
      let wire = "";
      socket.on("data", chunk => {
        wire += chunk.toString();
        if (wire.includes("\n")) setImmediate(received.resolve);
      });
    });
    const peer = createConnection({ host: "127.0.0.1", port }); peers.push(peer);
    peer.on("error", () => {});
    let wire = "";
    peer.on("data", chunk => {
      wire += chunk.toString();
      let end: number;
      while ((end = wire.indexOf("\n")) >= 0) {
        const request = JSON.parse(wire.slice(0, end)); wire = wire.slice(end + 1);
        requests.push(request);
        const result = { status: "succeeded", summary: "Transport-only receipt", evidence: { effect_confirmed: true } };
        const data = request.method === "observe" ? activeObservation({ fixture_counter: 3 }) : request.method === "cancel"
          ? { neutralized: true, matched_owner: false, generation: request.generation, session_id: session.session_id, life_id: scope.life_id }
          : request.method === "execute" && request.params.scope
            ? { operation_id: request.params.operation_id, scope: { ...request.params.scope, ...receiptScopePatch },
                compatibility_hash: request.params.compatibility_hash, result }
            : result;
        peer.write(JSON.stringify({ id: request.id, ok: true, data }) + "\n");
      }
    });
    await new Promise<void>(resolve => peer.once("connect", resolve));
    peer.write(JSON.stringify({ protocol: 4, secret: session.secret, world_id: session.world_id,
      session_id: session.session_id, epoch: session.epoch, native_boot_id: scope.native_boot_id,
      descriptor: expected, ...patch }) + "\n");
    await received.promise;
    return peer;
  }
  return { bridge, expected, session, requests, hello,
    corruptReceipt: (patch: Record<string, unknown>) => { receiptScopePatch = patch; },
    execute: (value = envelope()) => Reflect.apply(bridge.execute, bridge, [value, new AbortController().signal]),
    close: async () => { for (const peer of peers) peer.destroy(); await bridge.close(); } };
}

// Catches accepting old hello2 merely because its launch secret/session match.
test("API4 effects cannot bind through a legacy native hello2", async () => {
  const f = await transport();
  try {
    await f.hello({ protocol: 2, descriptor: undefined, native_boot_id: undefined });
    // Use an old-shaped action too: a historical active shim must not admit it.
    await Reflect.apply(f.bridge.execute, f.bridge, [action, new AbortController().signal]);
    expect(f.requests.filter(request => request.method === "execute")).toHaveLength(0);
  } finally { await f.close(); }
});

// Positive control prevents every mismatch test passing by rejecting all peers.
test("matching actual registered schemas and materialized profile bind before an effect is emitted", async () => {
  const f = await transport();
  try {
    await f.hello();
    const outcome = await f.execute();
    expect(outcome.status).toBe("succeeded");
    const effects = f.requests.filter(request => request.method === "execute");
    expect(effects).toHaveLength(1);
    expect(effects[0]!.params).toEqual(envelope());
    expect(effects[0]!.generation).not.toBe(effectScope().run_generation);
    expect(f.bridge.snapshot()).toMatchObject({ binding: { ready: true,
      compatibility_hash: sha256(f.expected), native_boot_id: "native-boot-A" } });
  } finally { await f.close(); }
});

const mismatches: Array<[string, (value: ReturnType<typeof descriptor>) => void]> = [
  ["game version", value => { value.game.version = "other-game-version"; }],
  ["native build", value => { value.adapter.build_hash = "0".repeat(64); }],
  ["observation schema", value => { value.observation.schema_version = 99; }],
  ["observation schema hash", value => { value.observation.schema_hash = "0".repeat(64); }],
  ["adapter payload schema", value => { value.observation.payload_schema.hash = "0".repeat(64); }],
  ["profile identity", value => { value.observation.profile.id = "strict_visual_v1"; }],
  ["profile hash", value => { value.observation.profile.configuration_hash = "0".repeat(64); }],
  ["materialized config with unchanged claimed hash", value => { value.observation.profile.configuration.sampler.radius_blocks = 32; }],
  ["unknown capability", value => { value.capabilities.push({ id: "gui.not_implemented", version: 1, schema_hash: "0".repeat(64) }); }],
  ["capability schema hash", value => { value.capabilities[0]!.schema_hash = "0".repeat(64); }],
  ["actuator", value => { value.actuator = "desktop"; }],
  ["executable API", value => { value.executable.api_version = 3; }],
  ["runtime", value => { value.executable.runtime_version = 3; }],
  ["validator", value => { value.executable.validator_version = 2; }],
];
for (const [name, mutate] of mismatches) {
  test(`${name} mismatch cannot dispatch even with the right native secret`, async () => {
    const f = await transport();
    try {
      const remote = descriptor(); mutate(remote);
      await f.hello({ descriptor: remote });
      await f.execute();
      expect(f.requests.filter(request => request.method === "execute")).toHaveLength(0);
      expect(Reflect.get(f.bridge.snapshot(), "binding")?.ready ?? false).toBe(false);
    } finally { await f.close(); }
  });
}

test("video cannot attach a second native boot to a negotiated control session", async () => {
  const f = await transport();
  try {
    await f.hello();
    await f.hello({ native_boot_id: "replacement-boot" }, "video");
    expect(f.bridge.latestFrame()).toBeNull();
    expect(Reflect.get(f.bridge, "videoSocket")).toBeNull();
  } finally { await f.close(); }
});

test("a stale-scope native receipt stays unknown and never replays the dispatched operation", async () => {
  const f = await transport();
  try {
    await f.hello(); f.corruptReceipt({ native_boot_id: "retired-native-boot" });
    const result = await f.execute();
    expect(result.status).toBe("unknown");
    expect(result.requires_reconnect).toBe(true);
    expect(f.requests.filter(request => request.method === "execute")).toHaveLength(1);
  } finally { await f.close(); }
});

for (const corruption of ["unregistered schema hash", "tampered materialized configuration"] as const) {
  test(`agreement on ${corruption} is not negotiation against trusted actual schemas/config`, async () => {
    const corrupt = descriptor();
    if (corruption === "unregistered schema hash") corrupt.capabilities[0]!.schema_hash = "0".repeat(64);
    else corrupt.observation.profile.configuration.sampler.radius_blocks = 32;
    // Host expectation and hello deliberately agree: equality/echo alone cannot
    // satisfy the real-schema/config validation requirement.
    const f = await transport(corrupt);
    try {
      await f.hello();
      await f.execute();
      expect(f.requests.filter(request => request.method === "execute")).toHaveLength(0);
      expect(Reflect.get(f.bridge.snapshot(), "binding")?.ready ?? false).toBe(false);
    } finally { await f.close(); }
  });
}

for (const [name, value] of [["signed-int overflow", 2 ** 31 + 17], ["safe integer endpoint", Number.MAX_SAFE_INTEGER]] as const) {
  test(`scope ${name} crosses native JSON without truncation`, async () => {
    const f = await transport();
    try {
      await f.hello();
      const request = envelope(); request.scope.run_generation = value;
      expect((await f.execute(request)).status).toBe("succeeded");
      const effect = f.requests.find(request => request.method === "execute")!;
      expect(effect.params).toMatchObject({ scope: { epoch: 2 ** 31 + 17, run_generation: value } });
    } finally { await f.close(); }
  });
}
for (const bad of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "7", null]) {
  test(`malformed cross-language scope counter ${JSON.stringify(bad)} emits zero effects`, async () => {
    const f = await transport();
    try {
      await f.hello();
      const request = envelope(); Reflect.set(request.scope, "space_epoch", bad);
      const result = await f.execute(request);
      expect(result.status).not.toBe("succeeded");
      expect(f.requests.filter(request => request.method === "execute")).toHaveLength(0);
    } finally { await f.close(); }
  });
}

for (const [field, invalid] of [
  ["session_id", ""], ["world_id", ""], ["native_boot_id", ""], ["run_id", ""], ["execution_id", ""],
  ["source_hash", "not-a-sha256"], ["source_hash", "F".repeat(64)],
] as const) {
  test(`malformed ${field} identity cannot cross the active native dispatch seam`, async () => {
    const f = await transport();
    try {
      await f.hello();
      const request = envelope(); Reflect.set(request.scope, field, invalid);
      expect((await f.execute(request)).status).not.toBe("succeeded");
      expect(f.requests.filter(request => request.method === "execute")).toHaveLength(0);
    } finally { await f.close(); }
  });
}

// A valid foreign payload is not required to imitate Minecraft player/inventory.
test("active observation validator accepts a generic data envelope and never promotes schema2 to active", () => {
  const current = activeObservation({ fixture_counter: 3 });
  const parsed = observationSchema.safeParse(current);
  expect(parsed.success).toBe(true);
  if (parsed.success) {
    expect(parsed.data).toHaveProperty("data", { fixture_counter: 3 });
    expect(parsed.data).not.toHaveProperty("player");
  }
  expect(observationSchema.safeParse(historicalObservation()).success).toBe(false);
});

test("copying host scope into worker capability args cannot create effect authority", () => {
  expect(skillCapabilitySchema.safeParse({ kind: "action", action, scope: effectScope() }).success).toBe(false);
  // Generic adapter JSON may legitimately name mechanical data scope/epoch.
  // This selected Minecraft capability does not declare a scope field, so its
  // actual registered consumer must reject it before effect admission.
  const registry = new RegisteredAdapterContract(adapterDescriptorSchema.parse(descriptor()), schemaCatalog());
  expect(() => registry.parseCapability("minecraft.action", 4, { ...action, scope: effectScope() })).toThrow();
});

test("Minecraft target references retain space and incarnation through the real action validator", () => {
  const target = { target_id: "opaque-block", incarnation: 2, life_id: 3,
    space: { dimension_id: "minecraft:overworld", space_epoch: 4 } };
  const first = minecraftActionSchema.safeParse({ kind: "dig", target });
  const otherSpace = minecraftActionSchema.safeParse({ kind: "dig", target: { ...target,
    space: { dimension_id: "minecraft:the_nether", space_epoch: 5 } } });
  const replacement = minecraftActionSchema.safeParse({ kind: "dig", target: { ...target, incarnation: 3 } });
  expect(first.success).toBe(true);
  expect(otherSpace.success).toBe(true);
  expect(replacement.success).toBe(true);
  if (first.success && otherSpace.success && replacement.success) {
    // Coordinates are deliberately identical and do not participate in identity.
    expect(first.data).toHaveProperty("target", target);
    expect(first.data).not.toEqual(otherSpace.data);
    expect(first.data).not.toEqual(replacement.data);
  }
});

test("registered Minecraft navigation preserves explicit arrival mechanics and legacy omission", () => {
  const target = { target_id: "opaque-block", incarnation: 2, life_id: 3,
    space: { dimension_id: "minecraft:overworld", space_epoch: 4 } };
  const navigation = { kind: "navigate" as const, target, range: 2.5, duration_ms: 5000 };
  const registry = new RegisteredAdapterContract(adapterDescriptorSchema.parse(descriptor()), schemaCatalog());
  expect(registry.parseCapability("minecraft.action", 4, navigation)).toEqual(navigation);
  for (const arrival of ["position", "interaction"] as const) {
    const request = { ...navigation, arrival };
    expect(minecraftActionSchema.parse(request)).toEqual(request);
    expect(registry.parseCapability("minecraft.action", 4, request)).toEqual(request);
  }
  for (const arrival of ["horizontal", "", null, true])
    expect(() => registry.parseCapability("minecraft.action", 4, { ...navigation, arrival })).toThrow();
  for (const range of [0.49, 4.01])
    expect(() => registry.parseCapability("minecraft.action", 4, { ...navigation, arrival: "interaction", range })).toThrow();
});

function validate(source: string, kind: "skill" | "policy" | "guard", value = descriptor(), scope = effectScope(), schemas = schemaCatalog()) {
  return Reflect.apply(validateProgramSource, undefined, [source, kind, { descriptor: value, scope, schemas }]) as ReturnType<typeof validateProgramSource>;
}
const source = 'return {status:"completed",summary:"Contract only",result:null};';
for (const kind of ["skill", "policy", "guard"] as const) {
  test(`${kind} validation compatibility changes for actual stable contract changes`, async () => {
    const body = kind === "policy" ? 'return {kind:"continue"};' : kind === "guard" ? "return true;" : source;
    const original = await validate(body, kind);
    for (const mutate of [
      (value: ReturnType<typeof descriptor>) => { value.adapter.build_hash = "f".repeat(64); },
      (value: ReturnType<typeof descriptor>) => { value.observation.profile.configuration.motor_profile = "precise";
        value.observation.profile.configuration_hash = sha256(value.observation.profile.configuration); },
    ]) {
      const changed = descriptor(); mutate(changed);
      const next = await validate(body, kind, changed);
      expect(next.hash).toBe(original.hash);
      expect(next.validation.fingerprint).not.toBe(original.validation.fingerprint);
    }
  });
}

test("changed trusted registered payload schema changes validation compatibility without changing source", async () => {
  const original = await validate(source, "skill");
  const schemas = schemaCatalog(), changed = descriptor();
  schemas.payload.properties.fixture_counter.type = "number";
  changed.observation.payload_schema.hash = sha256(schemas.payload);
  const next = await validate(source, "skill", changed, effectScope(), schemas);
  expect(next.hash).toBe(original.hash);
  expect(next.validation.fingerprint).not.toBe(original.validation.fingerprint);
});

test("changed actual registered capability schema changes compatibility even with the same capability name", async () => {
  const original = await validate(source, "skill");
  const schemas = schemaCatalog(), changed = descriptor();
  schemas.capabilities["minecraft.action@4"].maxProperties = 7;
  changed.capabilities[0]!.schema_hash = sha256(schemas.capabilities["minecraft.action@4"]);
  const next = await validate(source, "skill", changed, effectScope(), schemas);
  expect(next.hash).toBe(original.hash);
  expect(next.validation.fingerprint).not.toBe(original.validation.fingerprint);
});

test("reusable source fingerprint excludes boot/run/life/space identity", async () => {
  const original = await validate(source, "skill");
  const dynamic = { ...effectScope(), native_boot_id: "other-boot", run_id: "other-run", run_generation: 40,
    session_id: "other-session", world_id: "other-world", life_id: 9, space_epoch: 20, execution_id: "other-invocation" };
  const next = await validate(source, "skill", descriptor(), dynamic);
  expect(next.hash).toBe(original.hash);
  expect(next.validation.fingerprint).toBe(original.validation.fingerprint);
});

test("validator rejects materialized profile tampering even if the claimed hash is unchanged", async () => {
  const changed = descriptor(); changed.observation.profile.configuration.sampler.radius_blocks = 32;
  await expect(validate(source, "skill", changed)).rejects.toThrow();
});
