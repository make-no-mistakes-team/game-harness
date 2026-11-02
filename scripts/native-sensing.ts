import path from "node:path";
import type { EvaluationCaps } from "../src/evaluation/contracts.ts";
import { NativeFixture, bounded, pause, requireProof, until } from "../src/evaluation/native-game.ts";
import { EpisodeRecorder } from "../src/server/recording.ts";
import { gameActionSchema } from "../src/shared/validation.ts";
import { minecraftControllerFrameSchema, type SoundCursor } from "../src/shared/minecraft.ts";
import { decodeNativeVideoHeader } from "../src/shared/video.ts";

/** Privileged sensor conformance only. No model, learned policy or reusable experience. */
export async function runNativeSensingFixture(project: string, caps: EvaluationCaps) {
  const fixture = await NativeFixture.create("native-sensing", { projectRoot: project, caps });
  const scope = new AbortController(), pending = new Set<Promise<unknown>>();
  let failure: unknown, recorder: EpisodeRecorder | undefined;
  const headers = new Map<number, NonNullable<ReturnType<typeof decodeNativeVideoHeader>>>();
  const track = <T>(work: Promise<T>): Promise<T> => {
    pending.add(work); void work.then(() => pending.delete(work), () => pending.delete(work)); return work;
  };
  const stop = (message: string) => { failure ??= new Error(message); scope.abort(failure); void fixture.close().catch(error => { failure ??= error; }); };
  const interrupt = () => stop("Native sensing proof interrupted");
  process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  const deadline = setTimeout(() => stop("Native sensing entire-process deadline"), caps.totalMs);
  let detachFrames = () => {};
  const read = async (cursor: SoundCursor | null = null) => minecraftControllerFrameSchema.parse(
    await fixture.bridge.queryCapability("minecraft.controller_frame", 2, { audio_cursor: cursor }));
  const neutral = { forward: false, back: false, left: false, right: false, jump: false,
    sprint: false, sneak: false, attack: false, use: false };
  const clip = (held: typeof neutral, ticks: number, edges: unknown[], yaw = 0, pitch = 0, selected: number | null = null) =>
    track(fixture.action(gameActionSchema.parse({ kind: "world_input", steps: [
      { ticks, held, edges, view: { kind: "delta", yaw_radians: yaw, pitch_radians: pitch }, selected_hotbar: selected },
      ...(held.forward || held.use ? [{ ticks: 1, held: neutral,
        edges: [{ kind: "button", button: held.use ? "use" : "forward", phase: "release", count: 1 }],
        view: { kind: "unchanged" }, selected_hotbar: null }] : []),
    ] }), 12_000, scope.signal));
  const run = async (name: string, work: (entry: Record<string, unknown>) => Promise<void>) => {
    await fixture.case(name, { evaluator_authored: true, privileged_setup: true, model_inference: false }, work);
    requireProof(fixture.cases.at(-1)?.status === "passed", `Sensing ${name} failed; later cases cannot hide it`);
  };
  fixture.report.actual_provider_calls = 0; fixture.report.actual_jev_calls = 0;
  fixture.report.classification = "Privileged actual client feedback conformance; no model competence, strict-visual or human-equivalence claim";
  fixture.report.audio_limit = "Actual positive channel/cursor/expiry proof; mute, stopped, relative and attenuation predicate boundaries are separately covered by the production-used pure native proof, not relabelled live mute tests";
  try {
    await fixture.start();
    detachFrames = fixture.bridge.subscribeFrames(packet => {
      const header = decodeNativeVideoHeader(packet);
      if (!header) return;
      if (headers.size === 128) headers.delete(headers.keys().next().value!);
      headers.set(header.sequence, header);
    });
    recorder = new EpisodeRecorder({ directory: path.join(fixture.evidenceDirectory, "feedback"), bridge: fixture.bridge,
      identity: { episode_id: crypto.randomUUID(), run_id: crypto.randomUUID(), world_id: fixture.bridge.snapshot().world_id!,
        session_id: fixture.bridge.snapshot().session_id! },
      limits: { maxDurationMs: 180_000, maxFrames: 6000, maxStoredFrameBytes: 2 * 1024 ** 3 }, onIncomplete: stop });
    await fixture.flat();
    await fixture.console(["clear @a", "effect clear @a", "setblock 0 240 2 minecraft:stone",
      "item replace entity @a hotbar.2 with minecraft:bow", "give @a minecraft:arrow 1",
      "item replace entity @a weapon.offhand with minecraft:shield", "item replace entity @a armor.head with minecraft:iron_helmet",
      "experience set @a 7 levels", "effect give @a minecraft:water_breathing 30 0"]);
    await run("own_body_and_vanilla_crosshair", async entry => {
      entry.look = await clip(neutral, 1, [], 0, -0.5, 2);
      const baseline = await fixture.observe(); entry.authoritative_baseline = baseline;
      const frame = await until(read, value => value.view.crosshair.kind === "block", caps.observationMs, "Actual block crosshair not sampled");
      entry.frame = frame;
      requireProof(frame.player.selected_hotbar === 2 && frame.player.xp_level === 7 &&
        frame.player.equipment.some(item => item.slot === "main" && item.item === "bow") &&
        frame.player.equipment.some(item => item.slot === "off" && item.item === "shield") &&
        frame.player.equipment.some(item => item.slot === "head" && item.item === "iron_helmet") &&
        frame.player.status_effects.some(effect => effect.id === "minecraft:water_breathing") &&
        frame.inventory.source === "client_prediction", "Own current feedback omitted actual supplied equipment/status/selection or mislabelled inventory");
      requireProof(frame.view.crosshair.kind === "block" && frame.view.crosshair.block_position.z === 2 &&
        frame.view.crosshair.target !== null, "Vanilla crosshair did not expose its actually permitted block binding");
      requireProof(frame.visible_world?.observation_seq === baseline.observation_seq && frame.visible_world.captured_at === baseline.captured_at,
        "Cached world was not the original authorized observation");
      entry.image = await fixture.frame("own-feedback");
    });
    await run("actual_capture_sequence_join", async entry => {
      for (let turn = 0; turn < 3; turn++) requireProof((await clip(neutral, 1, [], 2 * Math.PI)).status === "succeeded", "Ordinary full turn failed");
      const joined = await until(async () => {
        const frame = await read(), capture = frame.view.render_capture;
        const header = capture ? headers.get(capture.capture_sequence) : undefined;
        return capture && header?.capture.render ? { frame, capture, header } : null;
      }, value => value !== null, caps.observationMs, "No delivered actual GHV2 capture joined its scalar feedback");
      requireProof(joined, "Missing actual capture join");
      const render = joined.header.capture.render!;
      requireProof(joined.capture.sampled_native_ns === render.sampled_ns &&
        joined.capture.capture_native_ns === joined.header.capture.readback_started_ns &&
        joined.capture.client_tick === joined.header.capture.client_tick &&
        joined.capture.render_invocation === joined.header.capture.render_invocation &&
        joined.capture.position.x === render.position.x && joined.capture.position.y === render.position.y && joined.capture.position.z === render.position.z &&
        joined.capture.yaw_radians === render.yaw_radians && joined.capture.pitch_radians === -render.pitch_radians,
      "Actor-safe capture metadata did not join the exact produced-and-delivered header pose");
      entry.join = joined;
    });
    await run("actual_entity_and_miss_crosshair", async entry => {
      await fixture.console(["setblock 0 240 2 minecraft:air",
        'summon minecraft:sheep 0.5 240 2.5 {Tags:["gh_sensing_target"],NoAI:1b,NoGravity:1b,Invulnerable:1b}']);
      entry.look_entity = await clip(neutral, 1, [], 0, 0.15);
      const hit = await until(read, frame => frame.view.crosshair.kind === "entity", caps.observationMs,
        "Actual vanilla entity crosshair was not sampled");
      requireProof(hit.view.crosshair.kind === "entity" && hit.view.crosshair.target !== null,
        "Known visible nearby crosshair entity lost its permitted binding");
      entry.entity = hit;
      entry.look_sky = await clip(neutral, 1, [], 0, 2);
      entry.miss = await until(read, frame => frame.view.crosshair.kind === "miss", caps.observationMs,
        "Actual vanilla sky miss was not sampled");
      await fixture.console(["tp @e[tag=gh_sensing_target] 0 -60 0", "kill @e[tag=gh_sensing_target]"]);
    });
    await run("body_without_server_inventory_wait", async entry => {
      const before = await fixture.diagnostics(), original = await read(); let settled = false;
      let observation: Promise<unknown> | undefined;
      await fixture.suspendedServer(async () => {
        observation = track(fixture.observe().then(value => { settled = true; return value; }));
        const frames = [await read()]; await pause(150); frames.push(await read()); entry.frames = frames;
        const during = await fixture.diagnostics(); entry.during = during;
        const firstEffect = frames[0]!.player.status_effects.find(effect => effect.id === "minecraft:water_breathing");
        const nextEffect = frames[1]!.player.status_effects.find(effect => effect.id === "minecraft:water_breathing");
        requireProof(!settled && during.observation_count === before.observation_count &&
          frames[1]!.frame_seq > frames[0]!.frame_seq && frames[1]!.native_tick > frames[0]!.native_tick &&
          firstEffect && nextEffect && firstEffect.duration_ticks > nextEffect.duration_ticks &&
          frames.every(frame => frame.visible_world?.captured_at === original.visible_world?.captured_at),
        "Local feedback waited for or fabricated a server inventory/world sample while its server was stopped");
      });
      requireProof(observation, "Server inventory negative witness was not submitted");
      entry.resumed_observation = await observation; requireProof(settled, "Real inventory observation did not settle after server resume");
    });
    await run("actual_use_and_velocity", async entry => {
      const drawing = clip({ ...neutral, use: true }, 20, [{ kind: "button", button: "use", phase: "press", count: 1 }]);
      entry.active_use = await until(read, frame => frame.player.active_use?.item === "bow" && frame.player.active_use.elapsed_ticks >= 3,
        caps.observationMs, "Actual vanilla bow use did not reach feedback");
      entry.draw_result = await drawing;
      const released = await read(); entry.released = released;
      requireProof(released.player.active_use === null, "Finished ordinary use retained active-item state");
      await fixture.console(["setblock 0 240 2 minecraft:air"]);
      const walking = clip({ ...neutral, forward: true }, 20, [{ kind: "button", button: "forward", phase: "press", count: 1 }]);
      entry.moving = await until(read, frame => Math.abs(frame.player.velocity_blocks_per_tick.x) + Math.abs(frame.player.velocity_blocks_per_tick.z) > 0.01,
        caps.observationMs, "Actual walking velocity did not reach feedback");
      entry.walk_result = await walking;
    });
    await run("actual_heard_independent_cursors", async entry => {
      await fixture.flat(); const initial = await read(), cursor = initial.audible.next_cursor;
      entry.source = await fixture.console(["playsound minecraft:entity.creeper.primed master @a 0.5 240 2.5 1 1"]);
      const first = await until(() => read(cursor), frame => frame.audible.events.some(event => event.cue === "creeper_primed"),
        caps.observationMs, "Actually played priming cue never reached the permitted audible channel");
      const event = first.audible.events.find(event => event.cue === "creeper_primed")!;
      const second = await read(cursor); entry.first = first; entry.second = second;
      requireProof(second.audible.events.some(value => value.sequence === event.sequence && value.heard_at === event.heard_at && value.heard_native_ns === event.heard_native_ns),
        "One audible consumer consumed another's event or rewrote its heard time");
      const legacy = await fixture.observe(); entry.legacy = legacy;
      requireProof(legacy.data.sounds.some(sound => sound.category === "combat" && sound.observed_at === event.heard_at),
        "Legacy observation drained the ring or relabelled original heard time");
      requireProof(!(await read(first.audible.next_cursor)).audible.events.some(value => value.sequence === event.sequence), "A cursor replayed its prior event");
      await pause(1100); const expired = await read(cursor); entry.expired = expired;
      requireProof(expired.audible.gap && expired.audible.omitted_before > 0 && !expired.audible.events.some(value => value.sequence === event.sequence),
        "Expired heard event was replayed or silently omitted without a gap");
    });
    await run("actual_fluid_air_and_vehicle", async entry => {
      await fixture.flat(); await fixture.console(["effect clear @a", "fill -1 240 -1 1 242 1 minecraft:water"]);
      entry.water = await until(read, frame => frame.player.in_water && frame.player.submerged_in_water && frame.player.air_ticks < frame.player.max_air_ticks,
        caps.observationMs, "Actual underwater body and air loss were not sampled");
      await fixture.flat(); await fixture.console(["effect give @a minecraft:fire_resistance 30 0", "fill -1 240 -1 1 242 1 minecraft:lava"]);
      entry.lava = await until(read, frame => frame.player.in_lava, caps.observationMs, "Actual lava body state was not sampled");
      await fixture.flat(); await fixture.console(['summon minecraft:oak_boat 0.5 240 0.5 {Tags:["gh_sensing_vehicle"],Invulnerable:1b,NoGravity:1b}',
        "ride @p mount @e[type=minecraft:oak_boat,tag=gh_sensing_vehicle,limit=1]"]);
      entry.vehicle = await until(read, frame => frame.player.vehicle_type === "minecraft:oak_boat", caps.observationMs, "Actual own mounted vehicle was not sampled");
      await fixture.console(["ride @p dismount"]);
    });
    await run("scope_fences_cached_world_and_audio", async entry => {
      await fixture.flat(); const prior = await read(), oldEpoch = prior.space.space_epoch;
      await fixture.console(["tp @a 0.5 240 0.5 0 0"]);
      await until(async () => fixture.bridge.snapshot(), state => (state.space?.space_epoch ?? 0) > oldEpoch,
        caps.observationMs, "Authoritative relocation did not advance observed space");
      const current = await read(); entry.prior = prior; entry.current = current;
      requireProof(current.visible_world === null && current.audible.stream_id !== prior.audible.stream_id &&
        (current.view.render_capture === null || current.view.render_capture.capture_sequence !== prior.view.render_capture?.capture_sequence),
      "Old-scope world, sound or capture was relabelled as current feedback");
      let refused = false;
      try { await read(prior.audible.next_cursor); } catch (error) { refused = true; entry.old_cursor_refusal = String(error); }
      requireProof(refused, "Foreign old-scope cursor read a replacement stream");
    });
    fixture.report.frame = await fixture.frame("sensing-final");
  } catch (error) { failure ??= error; }
  finally {
    clearTimeout(deadline); process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt); detachFrames();
    if (failure) { scope.abort(failure); try { await fixture.close(); } catch (error) { failure ??= error; } }
    try { await bounded(Promise.allSettled([...pending]), caps.cleanupMs, "Sensing work did not drain"); } catch (error) { failure ??= error; }
    if (recorder) try {
      const recording = await recorder.finish({ endedAt: Date.now(), reason: failure ? "sensing_failed" : "sensing_completed" });
      fixture.report.recording = recording;
      if (!failure) {
        requireProof(recording.status === "complete", "Native sensing evidence is incomplete");
        fixture.report.replay = await recorder.renderReplay({ signal: scope.signal });
      }
    } catch (error) { failure ??= error; }
    try { await fixture.close(); } catch (error) { failure ??= error; }
    await fixture.finish(failure);
  }
  return fixture;
}
