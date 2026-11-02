import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { GameActionResult, MotorProfile } from "../src/shared/contracts.ts";
import type { WorldHeld, WorldInputEdge, WorldInputStep, ViewInput } from "../src/shared/control.ts";
import { gameActionSchema } from "../src/shared/validation.ts";
import { EpisodeRecorder } from "../src/server/recording.ts";
import { NativeFixture, bounded, evidence, pause, requireProof, until, wrap } from "../src/evaluation/native-game.ts";
import type { EvaluationCaps } from "../src/evaluation/contracts.ts";
import { ownedWindowInput } from "../src/evaluation/owned-window-input.ts";

const neutral: WorldHeld = { forward: false, back: false, left: false, right: false, jump: false,
  sprint: false, sneak: false, attack: false, use: false };
const unchanged: ViewInput = { kind: "unchanged" };
const step = (ticks: number, held: Partial<WorldHeld> = {}, edges: WorldInputEdge[] = [],
  view: ViewInput = unchanged, selected_hotbar: number | null = null): WorldInputStep =>
  ({ ticks, held: { ...neutral, ...held }, edges, view, selected_hotbar });
const press = (button: "attack" | "use" | "inventory", count = 1): WorldInputEdge =>
  ({ kind: "button", button, phase: "press", count });
const release = (button: "attack" | "use"): WorldInputEdge =>
  ({ kind: "button", button, phase: "release", count: 1 });
const applicationSchema = z.looseObject({ schema_version: z.literal(1), clock_id: z.string(),
  applied_ticks: z.number().int().nonnegative(), applied_steps: z.number().int().nonnegative(),
  ordered_edge_prefix: z.number().int().nonnegative(),
  first_applied_native_ns: z.string().nullable(), last_applied_native_ns: z.string().nullable(),
  applied_client_tick: z.number().int().nonnegative().nullable(),
  applied_pose: z.object({ yaw_radians: z.number().finite(), pitch_radians: z.number().finite() }).nullable(),
  input_application: z.enum(["confirmed", "partial", "unknown"]), effect_status: z.enum(["not_observed", "unknown"]),
  stop_reason: z.enum(["completed", "screen_opened", "cancelled", "expired", "stale", "failed"]),
});
const ownInputSchema = z.looseObject({ active: z.boolean(), using_item: z.boolean(), blocking: z.boolean(),
  item_use_ticks: z.number().int().nonnegative(), active_hand: z.enum(["main", "off"]).nullable(),
  selected_hotbar: z.number().int().min(0).max(8), consumed_ticks: z.number().int().nonnegative(),
  attack_presses_consumed: z.number().int().nonnegative(), use_presses_consumed: z.number().int().nonnegative(),
});
const isolationSchema = z.looseObject({
  owned_input_cursor_locked: z.boolean(), owned_window_glfw_forward_pressed: z.boolean(),
  owned_window_glfw_control_pressed: z.boolean(), game_forward_poll_pressed: z.boolean(),
  blocked_keyboard_callbacks: z.number().int().nonnegative(), blocked_mouse_callbacks: z.number().int().nonnegative(),
});

/** Privileged input conformance only. Never imported into actor source or experience. */
export async function runNativeWorldInputFixture(project: string, caps: EvaluationCaps) {
  const fixture = await NativeFixture.create("native-world-input", { projectRoot: project, caps });
  const signal = new AbortController();
  const pendingEffects = new Set<Promise<GameActionResult>>();
  let recorder: EpisodeRecorder | undefined, failure: unknown;
  const stop = (reason: string) => {
    failure ??= new Error(reason); signal.abort(failure);
    void fixture.close().catch(error => { failure ??= error; });
  };
  const interrupt = () => stop("World-input proof interrupted");
  process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  const deadline = setTimeout(() => stop("World-input entire-process deadline"), caps.totalMs);
  fixture.report.classification = "Privileged evaluator-authored vanilla-input conformance; real native/arbiter/recording, no model competence claim";
  fixture.report.actual_provider_calls = 0;
  fixture.report.actual_jev_calls = 0;
  fixture.report.application_is_not_game_effect_confirmation = true;
  const open = () => requireProof(!signal.signal.aborted, "World-input fixture authority closed");
  const act = (steps: WorldInputStep[], abort = signal.signal) => {
    const result = fixture.action(gameActionSchema.parse({ kind: "world_input", steps }), 12_000, abort);
    pendingEffects.add(result);
    void result.then(() => pendingEffects.delete(result), () => pendingEffects.delete(result));
    return result;
  };
  const own = async () => ownInputSchema.parse((await fixture.diagnostics()).ordinary_input);
  const application = (result: GameActionResult) => applicationSchema.parse(evidence(result).ordinary_input);
  const completed = (result: GameActionResult, ticks: number) => {
    const applied = application(result);
    requireProof(result.status === "succeeded" && applied.input_application === "confirmed" &&
      applied.stop_reason === "completed" && applied.applied_ticks === ticks &&
      evidence(result).effect_confirmed === false, "Ordinary-input completion lacks exact application evidence or invents effect confirmation");
    requireProof(applied.first_applied_native_ns !== null && applied.last_applied_native_ns !== null &&
      BigInt(applied.last_applied_native_ns) >= BigInt(applied.first_applied_native_ns), "Input application lacks ordered native timestamps");
    return applied;
  };
  const server = async (condition: string, label: string) => {
    const marker = `ghp02_${randomUUID().replaceAll("-", "")}`;
    const output = await fixture.console([`execute ${condition} run say ${marker}`]);
    requireProof(output.includes(marker), `Independent server consequence missing: ${label}`);
    return { label, condition, marker, output };
  };
  const health = async (condition: "damaged" | "unchanged") => {
    await fixture.console(["execute store result score ghp02_health ghp02 run data get entity @e[tag=ghp02_target,limit=1] Health 100"]);
    return server(`if score ghp02_health ghp02 matches ${condition === "damaged" ? "1..1999" : "2000"}`, `target health ${condition}`);
  };
  const reset = async (commands: string[] = []) => {
    open();
    // A killed living entity keeps its client death animation briefly. Move
    // retiring targets out of reach before killing, so their bodies cannot
    // intercept the next case's ordinary crosshair click.
    await fixture.console(["clear @a", "tp @e[tag=ghp02_target] 0 -60 0", "kill @e[tag=ghp02_target]", "kill @e[type=minecraft:arrow]",
      "kill @e[type=minecraft:item]", "kill @e[type=minecraft:oak_boat]",
      "fill -5 240 -5 5 244 9 minecraft:air", "tp @a 0.5 240 0.5 0 0", ...commands]);
    await until(() => fixture.observe(), value => value.data.player.on_ground &&
      Math.abs(value.data.player.position.y - 240) < .05 && Math.abs(value.data.player.yaw) < .02,
      caps.observationMs, "Reset own pose was not freshly observed");
  };
  // Summon centers integer X/Z arguments; decimals keep this runtime origin exact.
  const target = "summon minecraft:husk 0.5 240 3.0 {NoAI:1b,Silent:1b,PersistenceRequired:1b,Tags:[\"ghp02_target\"]}";
  const count = async (name: string) => (await fixture.observe()).data.player.inventory
    .filter(item => item.name === name || item.name === `minecraft:${name}`).reduce((sum, item) => sum + item.count, 0);
  const runCase = async (name: string, setup: string[], body: (entry: Record<string, unknown>) => Promise<void>) => {
    await fixture.case(name, { evaluator_authored: true, model_inference: false,
      privileged_setup_and_server_checks: true, original_speed_recording: true }, async entry => {
      await reset(setup);
      if (setup.includes(target))
        await until(async () => {
          const value = await fixture.observe(); entry.target_observation = value; return value;
        }, value => value.data.entities.some(entity =>
          entity.current && entity.name === "husk" && Math.abs(entity.position.z - 3) < .05 &&
          Math.abs(entity.position.y - 240) < .05), caps.observationMs, "Fresh mechanical target was not actually projected");
      recorder = new EpisodeRecorder({ directory: path.join(fixture.evidenceDirectory, name), bridge: fixture.bridge,
        identity: { episode_id: randomUUID(), run_id: randomUUID(), world_id: fixture.bridge.snapshot().world_id!,
          session_id: fixture.bridge.snapshot().session_id! },
        limits: { maxDurationMs: 30_000, maxFrames: 1000, maxStoredFrameBytes: 512 * 1024 ** 2 }, onIncomplete: stop });
      open(); await body(entry); open();
      entry.after = await fixture.observe();
      entry.native_after = await fixture.diagnostics();
      entry.frame = await fixture.frame(`${name}_after`);
      const recording = await recorder!.finish({ endedAt: Date.now(), reason: `${name}_settled` });
      entry.recording = recording;
      requireProof(recording.status === "complete", "World-input recording incomplete");
      entry.replay = await recorder!.renderReplay({ signal: signal.signal });
    });
    requireProof(fixture.cases.at(-1)?.status === "passed", `World-input ${name} failed`);
    recorder = undefined;
  };
  try {
    await fixture.start(); await fixture.flat(); open();
    await fixture.console(["scoreboard objectives add ghp02 dummy"]);
    // Reuse the archived native motor proof's 90deg/small/wrap scenarios with
    // current scoped actions and actual recordings; old reports stay unchanged.
    for (const profile of ["precise", "balanced", "fast"] satisfies MotorProfile[]) {
      await fixture.bridge.setMotorProfile(profile);
      for (const turn of [{ name: "90deg", from: 0, to: 90 }, { name: "3deg", from: 0, to: 3 },
        { name: "wrap", from: 179, to: -178 }]) {
        await runCase(`assisted_camera_${profile}_${turn.name}`, [], async entry => {
          const from = turn.from * Math.PI / 180, to = turn.to * Math.PI / 180;
          const setup = await fixture.action({ kind: "look", yaw: from, pitch: 0 });
          requireProof(setup.status === "succeeded", "Assisted camera setup failed");
          const samples: Array<{ yaw: number; at_ms: number }> = [];
          let done = false;
          const turning = fixture.action({ kind: "look", yaw: to, pitch: 0 }, 8000, signal.signal)
            .finally(() => { done = true; });
          pendingEffects.add(turning);
          void turning.then(() => pendingEffects.delete(turning), () => pendingEffects.delete(turning));
          while (!done) {
            open();
            const observed = await fixture.observe();
            samples.push({ yaw: observed.data.player.yaw, at_ms: performance.now() });
            if (!done) await pause(20);
          }
          const result = await turning, settled = await fixture.observe();
          entry.result = result; entry.samples = samples;
          requireProof(result.status === "succeeded" && Math.abs(wrap(settled.data.player.yaw - to)) < .011,
            "Assisted camera did not settle to the requested wrapped orientation");
          const facts = evidence(result);
          requireProof(typeof facts.native_action_ms === "number" && facts.native_action_ms < 2000,
            "Assisted camera exceeded the declared two-second mechanical envelope");
          let last = from, travel = 0;
          for (const sample of samples) {
            travel += wrap(sample.yaw - last); last = sample.yaw;
            requireProof(Math.abs(travel) <= Math.abs(wrap(to - from)) + .013,
              "Assisted camera took the long path or overshot its target");
          }
          await pause(120);
          const held = await fixture.observe();
          requireProof(Math.abs(wrap(held.data.player.yaw - settled.data.player.yaw)) < .002,
            "Assisted camera drifted after settlement");
          entry.claim = "Actual constrained assisted-servo regression, not equivalent smoothness or model gameplay";
        });
      }
    }
    await fixture.bridge.setMotorProfile("balanced");
    await runCase("held_block_breaking", ["setblock 0 241 2 minecraft:oak_planks"], async entry => {
      const result = await act([step(80, { attack: true }, [press("attack")]), step(1, {}, [release("attack")])]);
      entry.result = result; completed(result, 81);
      entry.server = await server("if block 0 241 2 minecraft:air", "held attack removed real planks");
      const consumed = await own();
      requireProof(consumed.attack_presses_consumed === 1 && !consumed.active,
        "Held block breaking was replaced by repeated entity clicks");
      entry.consumption = consumed;
    });
    await runCase("held_entity_attack", [target], async entry => {
      const result = await act([step(30, { attack: true }, [press("attack")]), step(1, {}, [release("attack")])]);
      entry.result = result; completed(result, 31);
      entry.server = await health("damaged");
      const consumption = await own(); entry.consumption = consumption;
      requireProof(consumption.attack_presses_consumed === 1,
        "Held attack generated repeated entity clicks without authored presses");
    });
    await runCase("counted_entity_clicks", [target], async entry => {
      const result = await act([step(1, { attack: true }, [press("attack", 3)]), step(1, {}, [release("attack")])]);
      entry.result = result; completed(result, 2);
      entry.server = await health("damaged");
      const consumption = await own(); entry.consumption = consumption;
      requireProof(consumption.attack_presses_consumed === 3,
        "Counted attack edges were lost or replaced by held-state repetition");
    });
    await runCase("current_crosshair_miss", [target], async entry => {
      const result = await act([step(8, { attack: true }, [press("attack")],
        { kind: "delta", yaw_radians: Math.PI / 2, pitch_radians: 0 }), step(1, {}, [release("attack")])]);
      entry.result = result;
      const applied = completed(result, 9);
      requireProof(applied.applied_pose && Math.abs(applied.applied_pose.yaw_radians - Math.PI / 2) < .03,
        "View delta did not reach actual applied pose before the attack");
      entry.server = await health("unchanged");
    });
    await runCase("main_pass_offhand_shield", ["item replace entity @a hotbar.0 with minecraft:stick",
      "item replace entity @a weapon.offhand with minecraft:shield"], async entry => {
      const result = act([step(40, { use: true }, [press("use")]), step(1, {}, [release("use")])]);
      const held = await until(own, value => value.active && value.using_item && value.blocking && value.item_use_ticks >= 6,
        1800, "Offhand shield did not become active through main-hand PASS");
      entry.held = held;
      requireProof(held.active_hand === "off", "Shield use silently forced the main hand");
      entry.held_frame = await fixture.frame("shield_held");
      const settled = await result; entry.result = settled; completed(settled, 41);
      const released = await own(); entry.released = released;
      requireProof(!released.using_item && !released.blocking, "Shield remained active after ordinary release");
    });
    await runCase("bow_draw_turn_release", ["item replace entity @a hotbar.0 with minecraft:bow",
      "item replace entity @a inventory.0 with minecraft:arrow 8", "fill -5 240 8 5 244 8 minecraft:stone"], async entry => {
      const result = act([step(20, { use: true }, [press("use")]),
        step(10, { use: true }, [], { kind: "rate", yaw_radians_per_second: .8, pitch_radians_per_second: 0 }),
        step(1, {}, [release("use")])]);
      entry.draw = await until(own, value => value.active && value.using_item && value.item_use_ticks >= 8,
        1400, "Bow draw did not remain active");
      entry.before_release = await server("unless entity @e[type=minecraft:arrow]", "no projectile before bow release");
      entry.draw_frame = await fixture.frame("bow_drawn");
      const settled = await result; entry.result = settled;
      const applied = completed(settled, 31);
      requireProof(applied.applied_pose && Math.abs(applied.applied_pose.yaw_radians - .4) < .04,
        "Bow turn rate was not integrated once per actual client tick");
      entry.projectile = await server("if entity @e[type=minecraft:arrow]", "later server projectile after release");
      requireProof(!(await own()).using_item && await count("arrow") === 7, "Bow release did not settle ordinary use/ammunition");
    });
    await reset(["effect give @a minecraft:hunger 8 255 true"]);
    await until(() => fixture.observe(), value => value.data.player.food <= 12, 6000, "Eating fixture did not acquire hunger");
    await fixture.console(["effect clear @a minecraft:hunger"]);
    await runCase("eating_complete", ["item replace entity @a hotbar.0 with minecraft:bread 3"], async entry => {
      const before = await fixture.observe();
      const result = await act([step(38, { use: true }, [press("use")]), step(1, {}, [release("use")])]);
      entry.result = result; completed(result, 39);
      const after = await fixture.observe();
      requireProof(await count("bread") === 2 && after.data.player.food > before.data.player.food,
        "Completed eating lacks actual own food/item consequences");
      entry.food = { before: before.data.player.food, after: after.data.player.food };
    });
    await runCase("eating_interrupted", ["item replace entity @a hotbar.0 with minecraft:bread 3"], async entry => {
      const result = await act([step(8, { use: true }, [press("use")]), step(1, {}, [release("use")])]);
      entry.result = result; completed(result, 9);
      requireProof(await count("bread") === 3 && !(await own()).using_item,
        "Interrupted eating consumed the item or left use stuck");
    });
    await runCase("bucket_ordinary_fallback", ["item replace entity @a hotbar.0 with minecraft:bucket",
      "setblock 0 241 2 minecraft:water"], async entry => {
      const result = await act([step(1, { use: true }, [press("use")]), step(1, {}, [release("use")])]);
      entry.result = result; completed(result, 2);
      requireProof(await count("water_bucket") === 1, "Ordinary bucket item fallback did not acquire water");
      entry.server = await server("if block 0 241 2 minecraft:air", "bucket removed actual water source");
    });
    await runCase("boat_ordinary_fallback", ["item replace entity @a hotbar.0 with minecraft:oak_boat",
      "fill -2 240 1 2 240 5 minecraft:water"], async entry => {
      const result = await act([step(1, { use: true }, [press("use")],
        { kind: "delta", yaw_radians: 0, pitch_radians: -.6 }), step(1, {}, [release("use")])]);
      entry.result = result; completed(result, 2);
      entry.server = await server("if entity @e[type=minecraft:oak_boat]", "ordinary boat item placement");
      requireProof(await count("oak_boat") === 0, "Boat placement lacks item consumption");
    });
    await runCase("hotbar_swap_drop", ["item replace entity @a hotbar.0 with minecraft:dirt 8",
      "item replace entity @a hotbar.1 with minecraft:stone 7"], async entry => {
      const select = await act([step(1, {}, [], unchanged, 1)]); entry.select = select; completed(select, 1);
      requireProof((await own()).selected_hotbar === 1, "Hotbar selection did not reach ordinary own selection");
      const swap = await act([step(1, {}, [{ kind: "hand_swap" }])]); entry.swap = swap; completed(swap, 1);
      entry.offhand = await server("if items entity @a weapon.offhand minecraft:stone", "normal offhand swap");
      const single = await act([step(1, {}, [{ kind: "drop", all: false }], unchanged, 0)]); entry.single = single; completed(single, 1);
      entry.single_after = await until(() => fixture.observe(), value => value.data.player.inventory
        .filter(item => item.name === "dirt").reduce((sum, item) => sum + item.count, 0) === 7,
        caps.observationMs, "Single-drop own inventory did not settle to seven dirt");
      entry.single_server = await server('if data entity @a[limit=1] Inventory[{Slot:0b,id:"minecraft:dirt",count:7}]',
        "single drop retained seven dirt in the server slot");
      const all = await act([step(1, {}, [{ kind: "drop", all: true }])]); entry.all = all; completed(all, 1);
      entry.all_after = await until(() => fixture.observe(), value => !value.data.player.inventory.some(item => item.name === "dirt"),
        caps.observationMs, "Owned control modifier did not drop the remaining stack");
      entry.empty = await server("unless data entity @a[limit=1] Inventory[{Slot:0b}]", "drop-all emptied selected server slot");
    });
    await runCase("simultaneous_attack_use", [target, "item replace entity @a hotbar.0 with minecraft:stick",
      "item replace entity @a weapon.offhand with minecraft:shield"], async entry => {
      const result = act([step(30, { attack: true, use: true }, [press("attack"), press("use")]),
        step(1, {}, [release("attack"), release("use")])]);
      const held = await until(own, value => value.blocking && value.active, 1200, "Simultaneous ordinary use did not enter shield hold");
      entry.held = held;
      requireProof(held.attack_presses_consumed === 1 && held.use_presses_consumed === 1,
        "Simultaneous inputs did not follow vanilla attack-then-use consumption");
      const settled = await result; entry.result = settled; completed(settled, 31);
      entry.server = await health("damaged");
    });
    await runCase("active_owner_physical_isolation", [target,
      "item replace entity @a hotbar.0 with minecraft:dirt 8",
      "item replace entity @a weapon.offhand with minecraft:shield"], async entry => {
      const before = await fixture.observe();
      const beforeNative = isolationSchema.parse(await fixture.diagnostics());
      requireProof(!beforeNative.owned_input_cursor_locked, "Owned cursor override leaked before input admission");
      const result = act([step(60), step(1, {}, [{ kind: "drop", all: false }]), step(10)]);
      await until(own, value => value.active, 1200, "Neutral ordinary owner did not start for isolation probe");
      const probe = ownedWindowInput(fixture.ownedClient().child.pid!);
      entry.injection = { native_pid: fixture.ownedClient().child.pid, window_id: probe.window_id,
        mechanism: "XSendEvent to the verified owned window only; no focus, global pointer or global modifier changes" };
      try {
        probe.press();
        const during = await until(async () => isolationSchema.parse(await fixture.diagnostics()),
          value => value.owned_window_glfw_forward_pressed && value.owned_window_glfw_control_pressed &&
            value.blocked_keyboard_callbacks >= beforeNative.blocked_keyboard_callbacks + 2 &&
            value.blocked_mouse_callbacks >= beforeNative.blocked_mouse_callbacks + 3,
          1800, "Injected owned-window keyboard/mouse events did not reach the suppression boundary");
        entry.during = during;
        requireProof(during.owned_input_cursor_locked && !during.game_forward_poll_pressed,
          "Owned cursor route failed or physical key polling leaked into game input");
        const settled = await result; entry.result = settled; completed(settled, 71);
        const after = await fixture.observe(), afterNative = isolationSchema.parse(await fixture.diagnostics());
        const consumed = await own();
        entry.after_injection = { observation: after, native: afterNative, consumed };
        requireProof(Math.hypot(after.data.player.position.x - before.data.player.position.x,
          after.data.player.position.z - before.data.player.position.z) < .02 &&
          Math.abs(after.data.player.yaw - before.data.player.yaw) < .001 &&
          Math.abs(after.data.player.pitch - before.data.player.pitch) < .001 &&
          consumed.attack_presses_consumed === 0 && consumed.use_presses_consumed === 0 && !consumed.using_item,
          "Physical input changed movement, view or vanilla attack/use under a neutral authored owner");
        requireProof(!afterNative.owned_input_cursor_locked && afterNative.owned_window_glfw_forward_pressed &&
          !afterNative.game_forward_poll_pressed && !consumed.active,
          "Owned cursor override survived release or physical polling became an implicit owner");
        entry.target = await health("unchanged");
        entry.drop = await server('if data entity @a[limit=1] Inventory[{Slot:0b,id:"minecraft:dirt",count:7}]',
          "authored single drop ignored physically held Control");
      } finally {
        probe.release();
      }
      entry.released_physical = await until(async () => isolationSchema.parse(await fixture.diagnostics()),
        value => !value.owned_window_glfw_forward_pressed && !value.owned_window_glfw_control_pressed,
        1200, "Targeted physical key releases did not drain");
    });
    await runCase("cancel_active_bow", ["item replace entity @a hotbar.0 with minecraft:bow",
      "item replace entity @a inventory.0 with minecraft:arrow 8"], async entry => {
      const abort = new AbortController();
      const result = act([step(100, { use: true }, [press("use")])], abort.signal);
      entry.draw = await until(own, value => value.active && value.using_item && value.item_use_ticks >= 6,
        1800, "Cancellation fixture never reached real bow use");
      abort.abort(); const settled = await result; entry.result = settled;
      requireProof(settled.status !== "succeeded", "Cancelled unfinished input falsely completed");
      entry.neutral = await until(async () => ({ diagnostics: await fixture.diagnostics(), own: await own() }),
        value => value.diagnostics.controls_neutral && !value.own.active && !value.own.using_item,
        caps.cleanupMs, "Cancellation did not clear actual keys and active item use");
      entry.claim = "Cancellation may release a projectile; its consequences are not replayed or relabelled absent";
    });
    // Last because ordinary input deliberately cannot close an already visible screen.
    await runCase("inventory_screen_fences_world_input", [], async entry => {
      const opened = await act([step(1, {}, [press("inventory")]),
        step(5, { attack: true }, [press("attack")])]);
      entry.open = opened;
      const applied = application(opened);
      requireProof(applied.stop_reason === "screen_opened" && applied.applied_steps === 1 && applied.applied_ticks === 1,
        "Opening inventory did not stop later world-input steps");
      const screen = await fixture.observe(); requireProof(screen.screen !== null, "Input completion auto-closed the visible inventory");
      entry.screen_frame = await fixture.frame("inventory_open");
      const refused = await act([step(1)]); entry.refused = refused;
      requireProof(refused.status === "failed" && (await fixture.observe()).screen !== null,
        "World input against an open screen was accepted or auto-closed it");
    });
  } catch (error) { failure ??= error; }
  finally {
    clearTimeout(deadline); process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
    if (failure) {
      signal.abort(failure);
      try { await fixture.close(); } catch (error) { failure ??= error; }
    }
    try { await bounded(Promise.allSettled([...pendingEffects]), caps.cleanupMs, "World-input effect cleanup timed out"); }
    catch (error) { failure ??= error; }
    if (recorder) {
      try { fixture.report.interrupted_recording = await recorder.finish({ endedAt: Date.now(), reason: "world_input_failed" }); }
      catch (error) { failure ??= error; }
    }
    await fixture.finish(failure);
  }
  return fixture;
}
