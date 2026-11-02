import { fileURLToPath } from "node:url";
import { NativeFixture, bounded, evidence, requireProof, until } from "../src/evaluation/native-game.ts";
import { assertNativeArtifactFresh, requireTierOptIn } from "../src/evaluation/tiers.ts";
import type { GameActionResult } from "../src/shared/contracts.ts";
import { ActionArbiter } from "../src/server/action-arbiter.ts";

const project = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
requireTierOptIn("native-game", { allowNative: args.includes("--allow-native") });
const caseNames = [
  "actual_java_safe_long_and_matching_contract", "authoritative_short_teleport_fences_queued_effect",
  "real_block_replacement_rejects_old_target_on_game_thread", "actual_dimension_replacement_changes_space_not_life",
  "actual_same_class_screen_incarnation_and_queued_precondition", "genuine_native_descriptor_mismatch_grants_no_authority",
] as const;
const selected = new Set<string>();
for (let index = 0; index < args.length; index++) {
  if (args[index] === "--allow-native") continue;
  requireProof(args[index] === "--case" && args[index + 1] && caseNames.some(name => name === args[index + 1]),
    "Native contract proof accepts --allow-native and exact --case <declared-name> selectors only; no inference is available");
  selected.add(args[++index]!);
}
const artifact = assertNativeArtifactFresh(project, "native/minecraft/build/libs/gameharness-native-1.0.0.jar");
process.env.GAMEHARNESS_NATIVE_PROOF = "1";
process.env.GAMEHARNESS_PROOF_EXPECTED_JAR_SHA256 = artifact.sha256;
const fixture = await NativeFixture.create("native-contract-verification", { projectRoot: project, initialEpoch: Number.MAX_SAFE_INTEGER });
let failure: unknown;
const interrupted = () => { failure ??= new Error("Native contract proof interrupted"); void fixture.close(); };
process.once("SIGINT", interrupted); process.once("SIGTERM", interrupted);
const deadline = setTimeout(interrupted, fixture.caps.totalMs);
try {
  await fixture.start();
  await fixture.flat();
  fixture.report.classification = "Real pinned Fabric native contract/hook proof, privileged synthetic host diagnostic source, zero providers; not model gameplay, a second game, desktop input, GUI production, learning or efficiency evidence";
  fixture.report.native_artifact = artifact;
  fixture.report.actual_provider_calls = 0;
  fixture.report.case_selection = { declared: [...caseNames], selected: selected.size ? [...selected] : [...caseNames],
    scope: selected.size ? "Explicit continuation only; original reports/outcomes remain unchanged" : "Original full declared contract proof" };
  const proofCase: typeof fixture.case = async (name, conditions, run) => {
    if (selected.size && !selected.has(name)) return;
    await fixture.case(name, conditions, run);
  };
  const queued = () => {
    const broker = ActionArbiter.current(fixture.bridge);
    const entries: unknown = broker && Reflect.get(broker, "entries");
    return Array.isArray(entries) ? entries.length : 0;
  };
  await proofCase("actual_java_safe_long_and_matching_contract", { epoch: Number.MAX_SAFE_INTEGER, greater_than_java_int: true }, async entry => {
    const before = await fixture.observe(), binding = fixture.bridge.snapshot().binding;
    requireProof(binding?.ready && binding.descriptor.executable.api_version === 5 && before.schema_version === 3, "Actual native negotiation did not grant the canonical contract");
    const result = await fixture.action({ kind: "look", yaw: before.data.player.yaw + .3, pitch: before.data.player.pitch });
    const proof = evidence(result), after = await fixture.observe();
    requireProof(result.status === "succeeded" && proof.native_baseline_receipt_confirmed === true && proof.camera_changed === true && after.epoch === Number.MAX_SAFE_INTEGER,
      "Actual Java baseline/application/receipt did not preserve the inclusive safe-long ceiling");
    fixture.sameSession(fixture.identity(before), after);
    entry.actual_binding = binding; entry.result = result; entry.before = before; entry.after = after;
  });
  await proofCase("authoritative_short_teleport_fences_queued_effect", { same_dimension: true, same_life: true, no_position_jump_threshold: true }, async entry => {
    await fixture.flat();
    const before = await fixture.observe();
    const first = fixture.action({ kind: "move", controls: { forward: true, sneak: true }, duration_ms: 2000 });
    await until(() => fixture.diagnostics(), value => value.motor_active, fixture.caps.diagnosticsMs, "First genuine motor did not start");
    const second = fixture.action({ kind: "look", yaw: before.data.player.yaw + 1, pitch: 0 });
    await until(async () => queued(), count => count > 0, fixture.caps.diagnosticsMs, "Second diagnostic did not enter the existing arbiter queue");
    const immediatelyBeforeTeleport = await fixture.observe();
    await fixture.console(["execute as @a at @s run tp @s ~1 ~ ~"]);
    const after = await until(() => fixture.observe(), value => value.space.space_epoch > before.space.space_epoch,
      fixture.caps.observationMs, "Actual pinned position packet hook did not fence a one-block teleport");
    const [a, b] = await bounded(Promise.all([first, second]), fixture.caps.observationMs + fixture.caps.cleanupMs, "Scoped diagnostic queue did not drain");
    const displacement = {
      x: after.data.player.position.x - immediatelyBeforeTeleport.data.player.position.x,
      y: after.data.player.position.y - immediatelyBeforeTeleport.data.player.position.y,
      z: after.data.player.position.z - immediatelyBeforeTeleport.data.player.position.z,
    };
    entry.before = before; entry.immediately_before_teleport = immediatelyBeforeTeleport;
    entry.after = after; entry.actual_displacement = displacement; entry.active_outcome = a; entry.queued_outcome = b;
    const rejected = evidence(b);
    const hostRejected = b.status === "cancelled" && rejected.dispatched === false;
    const nativeRejected = b.status === "failed" && rejected.scope_rejection_stage === "receive" &&
      rejected.world_effect_emitted === false && rejected.effect_confirmed === false;
    entry.rejection_layer = hostRejected ? "host_before_dispatch" : nativeRejected ? "native_receive_before_application" : "not_established";
    await fixture.flush();
    fixture.sameSession(fixture.identity(before), after);
    requireProof(Math.abs(displacement.x - 1) <= .15 && Math.abs(displacement.y) <= .1 && Math.abs(displacement.z) <= .5,
      "The evaluator did not establish an actual one-block player-relative teleport; console-origin relocation is not short-teleport evidence");
    requireProof(after.life.life_id === before.life.life_id && after.space.dimension_id === before.space.dimension_id &&
      after.space.space_epoch > before.space.space_epoch && (hostRejected || nativeRejected) &&
      a.status === "unknown" && evidence(a).world_effect_emitted === true,
      "Short same-life relocation did not preserve uncertain prior effects and establish old-space queued rejection before new emissions");
  });
  await proofCase("real_block_replacement_rejects_old_target_on_game_thread", { same_coordinates: true, same_block_name: true }, async entry => {
    await fixture.flat(); await fixture.console(["setblock 0 240 3 minecraft:oak_log"]);
    const first = await until(() => fixture.observe(), value => value.data.blocks.some(block => block.name === "oak_log" && Math.floor(block.position.x) === 0 && Math.floor(block.position.y) === 240 && Math.floor(block.position.z) === 3), fixture.caps.observationMs, "Real log target is not in permitted native perception");
    const target = first.data.blocks.find(block => block.name === "oak_log" && Math.floor(block.position.x) === 0 && Math.floor(block.position.y) === 240 && Math.floor(block.position.z) === 3)!;
    await fixture.console(["setblock 0 240 3 minecraft:air", "setblock 0 240 3 minecraft:oak_log"]);
    const replaced = await until(() => fixture.observe(), value => value.data.blocks.some(block => block.name === "oak_log" && Math.floor(block.position.x) === 0 && Math.floor(block.position.y) === 240 && Math.floor(block.position.z) === 3 &&
      (block.target.target_id !== target.target.target_id || block.target.incarnation !== target.target.incarnation)), fixture.caps.observationMs, "Actual block update hooks reused a replaced target incarnation");
    const result = await fixture.action({ kind: "dig", target: target.target });
    const proof = evidence(result);
    requireProof(result.status === "failed" && /incarnation.*game-thread application/.test(result.summary) && proof.native_baseline_receipt_confirmed === true && proof.world_effect_emitted === false && proof.camera_changed === false,
      "Stale target was not rejected by the actual game-thread application guard before camera/world emission");
    requireProof((await fixture.observe()).data.blocks.some(block => block.name === "oak_log" && Math.floor(block.position.x) === 0 && Math.floor(block.position.y) === 240 && Math.floor(block.position.z) === 3), "Rejected stale target changed the replacement block");
    entry.target = target; entry.replacement = replaced; entry.result = result;
  });
  await proofCase("actual_dimension_replacement_changes_space_not_life", { same_coordinates: true, no_life_reset: true }, async entry => {
    await fixture.flat();
    const before = await fixture.observe();
    await fixture.console(["execute in minecraft:the_nether run forceload add -16 -16 15 15"], { acknowledgement_ms: fixture.caps.authMs, phase: "arena_chunk_generation" });
    await until(() => fixture.console(["execute in minecraft:the_nether if loaded -2 239 -2 if loaded 2 239 2 run say contract_nether_ready"]),
      output => output.includes("contract_nether_ready"), fixture.caps.authMs, "Actual destination chunks did not load");
    await fixture.console(["execute in minecraft:the_nether run fill -2 239 -2 2 239 2 minecraft:stone", "execute in minecraft:the_nether run tp @a 0.5 240 0.5 0 0"]);
    const after = await until(() => fixture.observe(), value => value.space.dimension_id === "minecraft:the_nether" && value.space.space_epoch > before.space.space_epoch,
      fixture.caps.observationMs, "Actual pinned dimension/world replacement hooks did not publish a new space");
    fixture.sameSession(fixture.identity(before), after);
    requireProof(after.life.life_id === before.life.life_id && after.life.status === "alive", "Ordinary dimension travel incorrectly created a new life");
    entry.before = before; entry.after = after;
    await fixture.console(["execute in minecraft:overworld run tp @a 0.5 240 0.5 0 0"]);
    await until(() => fixture.observe(), value => value.space.dimension_id === "minecraft:overworld" && value.space.space_epoch > after.space.space_epoch,
      fixture.caps.observationMs, "Actual return dimension transition did not fence its prior space");
  });
  await proofCase("actual_same_class_screen_incarnation_and_queued_precondition", { input_primitive_claim: false, gui_production_claim: false }, async entry => {
    await fixture.flat(); await fixture.console(["setblock 0 240 2 minecraft:crafting_table", "give @a minecraft:oak_planks 4"]);
    const visible = await fixture.observe(), table = visible.data.blocks.find(block => block.name === "crafting_table" && Math.floor(block.position.x) === 0 && Math.floor(block.position.y) === 240 && Math.floor(block.position.z) === 2);
    entry.initial_observation = visible; entry.target = table;
    await fixture.flush();
    requireProof(table, "Actual crafting table target is not in permitted perception");
    requireProof(visible.screen === null, "No-screen queue proof must begin from a genuinely closed native view");
    let openingWork: Promise<GameActionResult> | undefined, closedViewQueued: Promise<GameActionResult> | undefined;
    await fixture.suspendedServer(async () => {
      openingWork = fixture.action({ kind: "interact", target: table.target });
      await until(() => fixture.diagnostics(), value => value.motor_active, fixture.caps.diagnosticsMs,
        "Opening helper did not wait for its actual server baseline");
      closedViewQueued = fixture.action({ kind: "look", yaw: visible.data.player.yaw, pitch: visible.data.player.pitch });
      await until(async () => queued(), count => count > 0, fixture.caps.diagnosticsMs,
        "Explicit absent-screen work did not enter the existing arbiter queue while the view was closed");
    });
    const [firstInteraction, noScreenOutcome] = await bounded(Promise.all([openingWork!, closedViewQueued!]),
      fixture.caps.observationMs + fixture.caps.cleanupMs, "Opening and explicit absent-screen queue did not drain");
    entry.first_interaction = firstInteraction; entry.closed_view_queued_outcome = noScreenOutcome;
    entry.closed_view_admission_precondition = { expected_screen: { kind: "absent" } };
    const noScreenEvidence = evidence(noScreenOutcome);
    const noScreenHostRejection = noScreenOutcome.status === "cancelled" && noScreenEvidence.dispatched === false;
    const noScreenNativeRejection = noScreenOutcome.status === "failed" && noScreenEvidence.scope_rejection_reason === "STALE_SCREEN" &&
      noScreenEvidence.world_effect_emitted === false && noScreenEvidence.effect_confirmed === false;
    entry.closed_view_rejection_layer = noScreenHostRejection ? "host_before_dispatch" : noScreenNativeRejection ? "native_before_application" : "not_established";
    await fixture.flush();
    requireProof(firstInteraction.status === "succeeded", "First declared interaction did not establish an actual opened-screen effect");
    requireProof(noScreenHostRejection || noScreenNativeRejection,
      "Work admitted with explicit screen absence applied to a newly opened native handler");
    const first = await until(() => fixture.observe(), value => value.screen !== null, fixture.caps.observationMs, "Actual screen instance did not open");
    const firstDiagnostics = await fixture.diagnostics();
    entry.first_observation = first; entry.first_diagnostics = firstDiagnostics;
    // The current look helper owns closing a handled view after its apply-time
    // screen check. This is a disclosed existing mechanical helper, not a new
    // UI/input primitive or permission to keep an unavailable world target.
    const closeView = await fixture.action({ kind: "look", yaw: first.data.player.yaw, pitch: first.data.player.pitch });
    const reopenedBasis = await fixture.observe();
    const currentTable = reopenedBasis.data.blocks.find(block => block.name === "crafting_table" &&
      Math.floor(block.position.x) === 0 && Math.floor(block.position.y) === 240 && Math.floor(block.position.z) === 2 && block.current);
    entry.close_view_helper = closeView; entry.reopen_basis = reopenedBasis; entry.reacquired_target = currentTable;
    await fixture.flush();
    requireProof(closeView.status === "succeeded" && reopenedBasis.screen === null && currentTable,
      "Existing look helper did not close its handled view and reestablish a fresh permitted table reference");
    const secondInteraction = await fixture.action({ kind: "interact", target: currentTable.target });
    entry.second_interaction = secondInteraction; entry.after_second_interaction = await fixture.observe();
    await fixture.flush();
    requireProof(secondInteraction.status === "succeeded", "Second interaction was rejected before replacement; inspect its exact application_rejection evidence");
    const second = await until(() => fixture.observe(), value => value.screen !== null && value.screen.screen_id !== first.screen!.screen_id,
      fixture.caps.observationMs, "Same-class replacement screen reused the prior instance");
    requireProof((await fixture.diagnostics()).screen_type === firstDiagnostics.screen_type, "Screen proof did not replace the same native class");
    let craft: Promise<GameActionResult> | undefined, late: Promise<GameActionResult> | undefined;
    await fixture.suspendedServer(async () => {
      craft = fixture.action({ kind: "craft", item: "crafting_table", executions: 1 });
      await until(() => fixture.diagnostics(), value => value.motor_active, fixture.caps.diagnosticsMs, "Real helper did not wait for its server baseline");
      late = fixture.action({ kind: "look", yaw: visible.data.player.yaw + .2, pitch: 0 });
      await until(async () => queued(), count => count > 0, fixture.caps.diagnosticsMs, "Old-screen effect was not durably queued");
    });
    const [a, b] = await bounded(Promise.all([craft!, late!]), fixture.caps.observationMs + fixture.caps.cleanupMs, "Actual helper/screen-bound queue did not drain");
    entry.helper_outcome = a; entry.queued_outcome = b; entry.after_helper = await fixture.observe(); await fixture.flush();
    requireProof(a.status === "succeeded" && b.status === "cancelled" && evidence(b).dispatched === false && (await fixture.observe()).screen === null,
      "Actual owned helper UI transition did not fence the queued prior-screen precondition");
    entry.first = first.screen; entry.second = second.screen; entry.same_class = firstDiagnostics.screen_type;
    entry.helper_outcome = a; entry.queued_outcome = b; entry.frame = await fixture.frame("screen-incarnation");
  });
  await proofCase("genuine_native_descriptor_mismatch_grants_no_authority", { expected_host_descriptor_deliberately_wrong: true }, async entry => {
    const state = fixture.bridge.snapshot();
    requireProof(state.binding?.ready && state.world_id, "Matching native descriptor was not established before negative reconnect");
    const descriptor = structuredClone(state.binding.descriptor); descriptor.adapter.build_hash = "0".repeat(64);
    const schemas = fixture.bridge.adapter()!.schemas;
    await fixture.bridge.disconnect();
    const options = Reflect.get(fixture.bridge, "options");
    Reflect.set(options, "descriptor", descriptor); Reflect.set(options, "schemas", schemas);
    // Rebuild the trusted host registration from this deliberately incompatible
    // selection; do not merely mutate unused launch options or echo a hash.
    Reflect.set(fixture.bridge, "registration", null); Reflect.set(fixture.bridge, "expectedDescriptor", null);
    Reflect.set(fixture.bridge, "runtimeAdapter", null);
    const connecting = fixture.bridge.connect({ host: "127.0.0.1", port: fixture.port, version: "1.21.4", world_id: state.world_id, epoch: Number.MAX_SAFE_INTEGER });
    const outcome = connecting.then(() => ({ accepted: true, error: null }), error => ({ accepted: false, error: String(error) }));
    const owner = await until(async () => Reflect.get(fixture.bridge, "owned"), value => Boolean(value), fixture.caps.authMs, "Negative proof did not launch the actual native client");
    if (!fixture.clients.includes(owner)) fixture.clients.push(owner);
    const rejected = await bounded(outcome, fixture.caps.totalMs, "Actual incompatible native handshake did not settle");
    requireProof(!rejected.accepted && fixture.bridge.snapshot().binding === null && fixture.bridge.snapshot().status !== "connected", "Actual incompatible native descriptor granted effect authority");
    await bounded(owner.closed, fixture.caps.cleanupMs, "Rejected actual native process was not closed");
    entry.rejection = rejected; entry.native_pid = owner.child.pid; entry.state = fixture.bridge.snapshot();
    entry.no_effect_authority = true;
  });
} catch (error) { failure ??= error; }
finally {
  clearTimeout(deadline); process.off("SIGINT", interrupted); process.off("SIGTERM", interrupted);
  await fixture.finish(failure);
}
