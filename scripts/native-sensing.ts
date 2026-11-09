import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { EvaluationCaps } from "../src/evaluation/contracts.ts";
import { NativeFixture, bounded, pause, requireProof, until } from "../src/evaluation/native-game.ts";
import { EpisodeRecorder } from "../src/server/recording.ts";
import type { ControllerEffectUpdate, InputAppliedAck } from "../src/shared/controller.ts";
import { gameActionSchema } from "../src/shared/validation.ts";
import { minecraftControllerFrameSchema, type MinecraftControllerFrame, type SoundCursor } from "../src/shared/minecraft.ts";
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
  const worldProvenance = (frame: MinecraftControllerFrame, prior?: MinecraftControllerFrame) => {
    requireProof(frame.dynamic_entities.native_tick === frame.native_tick &&
      BigInt(frame.dynamic_entities.captured_native_ns) <= BigInt(frame.captured_native_ns) &&
      frame.dynamic_entities.entities.length <= 32 && frame.dynamic_entities.partial,
    "Dynamic sensing lost coherent tick, original time or bounded partial coverage");
    const world = frame.visible_world, previous = prior?.visible_world;
    if (!world) return;
    const age = BigInt(frame.captured_native_ns) - BigInt(world.captured_native_ns);
    requireProof(age >= 0n && world.stale === (age > 1_000_000_000n) &&
      [...world.blocks, ...world.entities].every(item => item.target.life_id === frame.life_id &&
        item.target.space.dimension_id === frame.space.dimension_id &&
        item.target.space.space_epoch === frame.space.space_epoch),
    "Geometry lost its original acquisition age or current life/space provenance");
    if (!previous) return;
    const sameScope = prior!.life_id === frame.life_id && prior!.space.dimension_id === frame.space.dimension_id &&
      prior!.space.space_epoch === frame.space.space_epoch;
    if (sameScope && world.observation_seq === previous.observation_seq) {
      requireProof(world.captured_native_ns === previous.captured_native_ns && world.captured_at === previous.captured_at,
        "Retained geometry was retimestamped without a new acquisition");
    } else {
      requireProof(world.observation_seq > previous.observation_seq &&
        BigInt(world.captured_native_ns) > BigInt(previous.captured_native_ns) &&
        (sameScope || BigInt(world.captured_native_ns) > BigInt(prior!.captured_native_ns)),
      "Replacement geometry reused an old acquisition identity or time");
    }
  };
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
      worldProvenance(frame);
      requireProof(frame.visible_world && frame.visible_world.observation_seq >= baseline.observation_seq &&
        (frame.visible_world.observation_seq === baseline.observation_seq
          ? frame.visible_world.captured_at === baseline.captured_at
          : BigInt(frame.visible_world.captured_native_ns) <= BigInt(frame.captured_native_ns)),
        "Controller geometry lost its authorized acquisition identity or time");
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
        worldProvenance(frames[0]!, original); worldProvenance(frames[1]!, frames[0]!);
        requireProof(!settled && during.observation_count === before.observation_count &&
          frames[1]!.frame_seq > frames[0]!.frame_seq && frames[1]!.native_tick > frames[0]!.native_tick &&
          firstEffect && nextEffect && firstEffect.duration_ticks > nextEffect.duration_ticks &&
          frames.every(frame => frame.inventory.source === "client_prediction"),
        "Local feedback waited for or fabricated a server inventory sample while its server was stopped");
        entry.geometry_limit = "Independent permitted client geometry may refresh while the authoritative inventory request remains pending; it is not a server observation";
      });
      requireProof(observation, "Server inventory negative witness was not submitted");
      entry.resumed_observation = await observation; requireProof(settled, "Real inventory observation did not settle after server resume");
    });
    await run("moving_dynamic_target_and_optical_occlusion", async entry => {
      await fixture.flat();
      await fixture.console(['summon minecraft:husk 0.5 240 4.5 {NoAI:1b,NoGravity:1b,Silent:1b,Tags:["gh_dynamic"]}']);
      const first = await until(read, frame => frame.dynamic_entities.entities.some(entity => entity.name === "husk"),
        caps.observationMs, "Dynamic local target was not projected");
      const target = first.dynamic_entities.entities.find(entity => entity.name === "husk")!;
      const moved: MinecraftControllerFrame[] = [];
      for (const x of [1.5, 2.5, 3.5]) {
        await fixture.console([`tp @e[tag=gh_dynamic] ${x} 240 4.5`]);
        const current = await until(read, frame => frame.dynamic_entities.entities.some(entity =>
          entity.target.target_id === target.target.target_id && Math.abs(entity.position.x - x) < .05),
        caps.observationMs, "Moving target retained old geometry or changed mechanical identity");
        moved.push(current);
      }
      entry.first = first; entry.moved = moved;
      const motor = track(fixture.action({ kind: "move", controls: {}, duration_ms: 1000 }, 4000, scope.signal));
      await until(() => fixture.diagnostics(), value => value.motor_active, caps.observationMs,
        "Semantic motor did not acquire custody for independent dynamic sensing");
      const underCustody = await read();
      await fixture.console(["tp @e[tag=gh_dynamic] 2.5 240 4.5"]);
      entry.semantic_custody = await until(read, frame => frame.native_tick > underCustody.native_tick &&
        frame.dynamic_entities.entities.some(entity => entity.target.target_id === target.target.target_id &&
          Math.abs(entity.position.x - 2.5) < .05), caps.observationMs,
      "Semantic target custody suppressed current dynamic sensing");
      entry.motor = await motor;
      const freshness: MinecraftControllerFrame[] = [];
      for (let sample = 0; sample < 8; sample++) {
        freshness.push(await read()); await pause(50);
      }
      requireProof(new Set(freshness.map(frame => frame.dynamic_entities.native_tick)).size >= 6 &&
        freshness.every(frame => frame.dynamic_entities.native_tick === frame.native_tick &&
          BigInt(frame.captured_native_ns) - BigInt(frame.dynamic_entities.captured_native_ns) < 150_000_000n),
      "Dynamic geometry retained the former 500ms acquisition cadence");
      entry.dynamic_freshness = freshness;
      await fixture.console(["fill -1 240 2 4 244 2 minecraft:stone"]);
      entry.occluded = await until(read, frame => !frame.dynamic_entities.entities.some(entity =>
        entity.target.target_id === target.target.target_id), caps.observationMs, "Opaque wall retained current hidden entity geometry");
      await fixture.console(["fill -1 240 2 4 244 2 minecraft:air", "fill -1 240 -1 4 243 5 minecraft:water",
        "effect give @a minecraft:water_breathing 30 0 true", "tp @e[tag=gh_dynamic] 0.5 240 4.5"]);
      entry.water = await until(read, frame => frame.player.submerged_in_water &&
        frame.dynamic_entities.entities.some(entity => entity.target.target_id === target.target.target_id),
      caps.observationMs, "Open-water optical rays blinded a visible dynamic target");
      await fixture.console(["fill -1 239 -1 4 239 5 minecraft:soul_sand",
        "fill -1 240 -1 4 243 5 minecraft:bubble_column[drag=false]"]);
      entry.bubbles = await until(read, frame => frame.dynamic_entities.entities.some(entity =>
        entity.target.target_id === target.target.target_id), caps.observationMs,
      "Bubble-column optical rays blinded a visible dynamic target");
      await fixture.console(["fill -1 240 2 1 243 2 minecraft:oak_leaves[waterlogged=true]"]);
      entry.waterlogged = await until(read, frame => !frame.dynamic_entities.entities.some(entity =>
        entity.target.target_id === target.target.target_id), caps.observationMs, "Waterlogged solid became optically open water");
      await fixture.console(["fill -1 240 2 1 243 2 minecraft:lava"]);
      entry.lava = await until(read, frame => !frame.dynamic_entities.entities.some(entity =>
        entity.target.target_id === target.target.target_id), caps.observationMs, "Lava became optically open water");
      await fixture.console(["fill -1 240 -1 4 243 5 minecraft:air", "tp @e[tag=gh_dynamic] 0.5 240 9.5"]);
      entry.out_of_range = await until(read, frame => !frame.dynamic_entities.entities.some(entity =>
        entity.target.target_id === target.target.target_id), caps.observationMs, "Dynamic sensing expanded the declared radius");
      await fixture.console(["tp @e[tag=gh_dynamic] 0.5 240 4.5", "effect give @e[tag=gh_dynamic] minecraft:invisibility 30 0 true"]);
      entry.invisible = await until(read, frame => !frame.dynamic_entities.entities.some(entity =>
        entity.target.target_id === target.target.target_id), caps.observationMs, "Dynamic sensing exposed an invisible entity");
      await fixture.console(["tp @e[tag=gh_dynamic] 0 -60 0", "kill @e[tag=gh_dynamic]"]);
      await fixture.flat();
    });
    await run("ordinary_stream_attack_callback_identity", async entry => {
      await fixture.flat();
      await fixture.console(['summon minecraft:husk 0.5 240 3.0 {NoAI:1b,Silent:1b,Tags:["gh_stream_attack"]}']);
      const source = createHash("sha256").update("ordinary-stream-attack-callback-proof").digest("hex");
      await fixture.withController(source, 8000, () => {}, () => {}, async channel => {
        const first = minecraftControllerFrameSchema.parse(await channel.sample(null));
        await channel.renew(null);
        const submitted = channel.submit(first, { kind: "world", held: { ...neutral, attack: true },
          edges: [{ kind: "button", button: "attack", phase: "press", count: 1 }],
          view: { kind: "unchanged" }, selected_hotbar: null });
        requireProof(submitted.status !== "rejected", "Stream attack was not admitted");
        const frames: MinecraftControllerFrame[] = [];
        for (let tick = 0; tick < 8; tick++) {
          await pause(50); const current = minecraftControllerFrameSchema.parse(await channel.sample(null));
          await channel.renew(null); frames.push(current);
        }
        const last = frames.at(-1)!;
        const callbacks = last.mechanics.filter(event => event.controller_generation === channel.controllerGeneration &&
          event.sequence === submitted.sequence && event.stage === "attack_callback");
        const consumed = last.mechanics.filter(event => event.controller_generation === channel.controllerGeneration &&
          event.sequence === submitted.sequence && event.stage === "key_consumed");
        requireProof(callbacks.length === 1 && consumed.length === 1 && callbacks[0]!.edge_ordinal === consumed[0]!.edge_ordinal,
          "Held attack repeated a callback or lost exact consumed-edge correlation");
        entry.submission = submitted; entry.frames = frames;
      });
      await fixture.console(["tp @e[tag=gh_stream_attack] 0 -60 0", "kill @e[tag=gh_stream_attack]"]);
    });
    await run("ordinary_bounded_geometry_refresh_without_observe", async entry => {
      const source = createHash("sha256").update(await readFile(new URL(import.meta.url))).digest("hex");
      const preflightBefore = await fixture.diagnostics();
      const newTiming = () => ({ requests: 0, observe_calls: 0, frame_reads: 0, owner_sample_reads: 0,
        generic_frame_reads: 0, missing_native_timing: 0, failed_requests: 0,
        frame_read_host_max_ms: 0, frame_read_native_max_ms: null as number | null });
      const preflightTiming = newTiming(), timing = newTiming(), postflightTiming = newTiming();
      let activeTiming = preflightTiming;
      const acks: InputAppliedAck[] = [], effects: ControllerEffectUpdate[] = [];
      const acquisitions = new Map<number, { observation_seq: number; captured_at: string; captured_native_ns: string;
        first_frame_seq: number; first_age_ms: number; last_age_ms: number; samples: number; scan_time_proxy_ms: number | null }>();
      const samples: Array<{ frame_seq: number; native_tick: number; observation_seq: number; age_ms: number;
        host_read_ms: number; captured_native_ns: string }> = [];
      const detachTiming = fixture.bridge.subscribeControlTiming(span => {
        const target = activeTiming;
        target.requests++;
        if (span.method === "observe") target.observe_calls++;
        if (span.status !== "ok") target.failed_requests++;
        if (span.method !== "controller_frame" && span.method !== "controller_sample") return;
        target.frame_reads++;
        if (span.method === "controller_sample") target.owner_sample_reads++;
        else target.generic_frame_reads++;
        target.frame_read_host_max_ms = Math.max(target.frame_read_host_max_ms,
          span.ended_monotonic_ms - span.started_monotonic_ms);
        if (!span.native_timing) { target.missing_native_timing++; return; }
        target.frame_read_native_max_ms = Math.max(target.frame_read_native_max_ms ?? 0,
          Number(BigInt(span.native_timing.replied_ns) - BigInt(span.native_timing.received_ns)) / 1e6);
      });
      entry.timing = timing; entry.samples = samples;
      entry.preflight = { before: preflightBefore, timing: preflightTiming };
      entry.postflight = { timing: postflightTiming };
      entry.application_acks = acks; entry.later_effect_receipts = effects;
      entry.limits = { sample_cap: 64, acquisition_cap: 32, sampling_window_ms: 1800,
        acquisition_interval_min_ms: 500, explicit_observe_allowed: false };
      entry.measurement_limit = "The measurement window begins after controller ownership admission and its diagnostic baseline, and ends after the final diagnostic sample while still owned. Admission observations and reads are reported separately as preflight, not claimed absent. Every in-window frame read must be an owner-bound controller_sample. Acquisition-to-first-frame age is a scan-time proxy, not an isolated scan timer. Native request duration includes queue/service work; host read duration includes transport and parsing. Missing timing remains unknown. Sampling cannot see unreturned acquisitions or prove behavior outside this finite same-scope window. No E01, visual, naturalness or model-competence claim.";
      try {
        await fixture.withController(source, 12_000, ack => acks.push(ack), effect => effects.push(effect), async channel => {
          entry.controller_owner = channel.owner; entry.controller_generation = channel.controllerGeneration;
          let renewing = true, renewalFailure: unknown;
          const renewals = track((async () => {
            while (renewing && !scope.signal.aborted) {
              await pause(80);
              if (!renewing) break;
              try { await channel.renew(null); } catch (error) { renewalFailure = error; break; }
            }
          })());
          let first: MinecraftControllerFrame | undefined, previous: MinecraftControllerFrame | undefined;
          let pressSequence: number | undefined, releaseSequence: number | undefined, retainedSamples = 0;
          try {
            // Native admission may legitimately observe; it is outside this ordinary sensing window.
            const before = await fixture.diagnostics();
            entry.preflight = { before: preflightBefore, after: before, timing: preflightTiming };
            entry.before = before;
            activeTiming = timing;
            const started = performance.now();
            entry.measurement_started_host_monotonic_ms = started;
            do {
              requireProof(samples.length < 64, "Ordinary refresh sampling exceeded its finite sample cap");
              const readStarted = performance.now();
              const frame: MinecraftControllerFrame = minecraftControllerFrameSchema.parse(await channel.sample(null));
              const hostReadMs = performance.now() - readStarted;
              first ??= frame;
              requireProof(frame.life_id === first.life_id && frame.space.dimension_id === first.space.dimension_id &&
                frame.space.space_epoch === first.space.space_epoch && frame.screen === null,
              "Ordinary refresh proof left its original life/space/screen scope");
              worldProvenance(frame, previous);
              const world = frame.visible_world;
              requireProof(world && !world.stale && world.blocks.length > 0,
                "Ordinary production sensing did not supply fresh permitted geometry");
              const ageMs = Number(BigInt(frame.captured_native_ns) - BigInt(world.captured_native_ns)) / 1e6;
              const retained = acquisitions.get(world.observation_seq);
              if (retained) {
                requireProof(retained.captured_at === world.captured_at && retained.captured_native_ns === world.captured_native_ns &&
                  ageMs > retained.last_age_ms, "Repeated geometry did not retain its original acquisition time and increasing age");
                retained.last_age_ms = ageMs; retained.samples++; retainedSamples++;
              } else {
                requireProof(acquisitions.size < 32, "Ordinary refresh acquisitions exceeded their finite retention cap");
                if (previous?.visible_world) requireProof(world.observation_seq === previous.visible_world.observation_seq + 1 &&
                  BigInt(world.captured_native_ns) - BigInt(previous.visible_world.captured_native_ns) >= 500_000_000n,
                "Ordinary sensing skipped an acquisition identity or acquired geometry faster than 2Hz");
                acquisitions.set(world.observation_seq, { observation_seq: world.observation_seq, captured_at: world.captured_at,
                  captured_native_ns: world.captured_native_ns, first_frame_seq: frame.frame_seq,
                  first_age_ms: ageMs, last_age_ms: ageMs, samples: 1,
                  scan_time_proxy_ms: previous && BigInt(world.captured_native_ns) > BigInt(previous.captured_native_ns) ? ageMs : null });
              }
              samples.push({ frame_seq: frame.frame_seq, native_tick: frame.native_tick, observation_seq: world.observation_seq,
                age_ms: ageMs, host_read_ms: hostReadMs, captured_native_ns: frame.captured_native_ns });
              if (pressSequence === undefined || (releaseSequence === undefined && performance.now() - started >= 300)) {
                const pressing = pressSequence === undefined;
                const submission = channel.submit(frame, { kind: "world", held: pressing ? { ...neutral, forward: true } : neutral,
                  edges: [{ kind: "button", button: "forward", phase: pressing ? "press" : "release", count: 1 }],
                  view: { kind: "unchanged" }, selected_hotbar: null });
                requireProof(submission.status !== "rejected", `Ordinary refresh control input refused: ${submission.reason}`);
                if (pressing) pressSequence = submission.sequence; else releaseSequence = submission.sequence;
              }
              previous = frame;
              await pause(50);
            } while (performance.now() - started < 1800);
            const state = channel.snapshot();
            const pressAck = acks.find(ack => ack.sequence === pressSequence);
            const releaseAck = acks.find(ack => ack.sequence === releaseSequence);
            requireProof(first && previous && BigInt(previous.captured_native_ns) - BigInt(first.captured_native_ns) >= 1_500_000_000n &&
              previous.frame_seq > first.frame_seq && previous.native_tick > first.native_tick &&
              Math.hypot(previous.player.position.x - first.player.position.x, previous.player.position.z - first.player.position.z) > .1 &&
              pressSequence !== undefined && releaseSequence !== undefined && state.applied_sequence >= releaseSequence &&
              state.last_input?.sequence === releaseSequence && state.last_input.input_application === "confirmed" &&
              !state.last_input.held.forward && state.ordered_edge_prefix === 2 && !state.fenced &&
              pressAck?.controller_generation === channel.controllerGeneration && pressAck.input_application === "confirmed" &&
              pressAck.held.forward && pressAck.ordered_edge_prefix === 1 &&
              releaseAck?.controller_generation === channel.controllerGeneration && releaseAck.input_application === "confirmed" &&
              !releaseAck.held.forward && releaseAck.ordered_edge_prefix === 2 &&
              releaseAck.applied_native_tick >= pressAck.applied_native_tick &&
              BigInt(releaseAck.applied_native_ns) >= BigInt(pressAck.applied_native_ns),
            "Geometry sampling did not preserve independent body progress and confirmed ordinary press/release application");
            requireProof(acquisitions.size >= 3 && retainedSamples > 0,
              "Ordinary sensing did not demonstrate repeated bounded acquisitions and original-age cache reuse");
            entry.first = first; entry.last = previous; entry.final_input_state = state;
            entry.press_ack = pressAck; entry.release_ack = releaseAck;
            const after = await fixture.diagnostics();
            entry.after = after;
            const ended = performance.now();
            entry.measurement_ended_host_monotonic_ms = ended; entry.elapsed_host_ms = ended - started;
            activeTiming = postflightTiming;
            requireProof(timing.observe_calls === 0 && after.observation_count === before.observation_count &&
              timing.frame_reads === samples.length && timing.owner_sample_reads === samples.length &&
              timing.generic_frame_reads === 0 && timing.failed_requests === 0,
            "Ordinary geometry refresh issued an explicit observation or lost an owner-bound sampled native request");
          } finally {
            activeTiming = postflightTiming;
            renewing = false; await renewals;
            if (renewalFailure) throw renewalFailure;
          }
        });
      } finally {
        detachTiming();
        entry.acquisitions = [...acquisitions.values()];
        entry.maxima = { scan_time_proxy_ms: [...acquisitions.values()].reduce<number | null>((max, value) =>
          value.scan_time_proxy_ms === null ? max : Math.max(max ?? 0, value.scan_time_proxy_ms), null),
          sampled_acquisition_age_ms: samples.reduce((max, value) => Math.max(max, value.age_ms), 0),
          host_frame_read_ms: samples.reduce((max, value) => Math.max(max, value.host_read_ms), 0) };
      }
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
      const ordinary = await fixture.observe(); entry.ordinary = ordinary;
      requireProof(ordinary.data.sounds.some(sound => sound.category === "combat" && sound.cue === "creeper_primed" &&
        sound.observed_at === event.heard_at && sound.direction === event.direction && sound.distance === event.distance),
        "Ordinary observation lost the actually heard cue, coarse bins or original heard time");
      requireProof(!(await read(first.audible.next_cursor)).audible.events.some(value => value.sequence === event.sequence), "A cursor replayed its prior event");
      await pause(1100); const expired = await read(cursor); entry.expired = expired;
      requireProof(expired.audible.gap && expired.audible.omitted_before > 0 && !expired.audible.events.some(value => value.sequence === event.sequence),
        "Expired heard event was replayed or silently omitted without a gap");
      const actualCombat: MinecraftControllerFrame[] = [];
      for (const [sound, cue] of [["minecraft:item.shield.block", "shield_block"],
        ["minecraft:item.shield.break", "shield_break"], ["minecraft:entity.item.break", "item_break"],
        ["minecraft:entity.player.attack.nodamage", "attack_nodamage"], ["minecraft:entity.husk.hurt", "mob_hurt"],
        ["minecraft:entity.husk.death", "mob_death"]]) {
        const after = (await read()).audible.next_cursor;
        await fixture.console([`playsound ${sound} master @a 0.5 240 2.5 1 1`]);
        actualCombat.push(await until(() => read(after), frame => frame.audible.events.some(event => event.cue === cue),
          caps.observationMs, `Actually played ${cue} never reached actor sound feedback`));
      }
      entry.actual_heard_combat = actualCombat;
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
      worldProvenance(current, prior);
      requireProof(current.space.space_epoch > prior.space.space_epoch &&
        current.audible.stream_id !== prior.audible.stream_id &&
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
