import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import type { createBot as createBotFunction } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Item } from "prismarine-item";
import type { Entity } from "prismarine-entity";
import type {
  ControlName,
  GameAction,
  GameActionResult,
  BridgeConnection,
  GameState,
  BridgeNotice,
  InventoryItem,
  Json,
  Vec3Data,
} from "../shared/contracts.ts";
import type { BridgeBot } from "./types.ts";
import { gameActionSchema } from "../shared/validation.ts";
import {
  Perception,
  point,
  vec,
  distance,
  knownGeometry,
} from "./perception.ts";
import { HumanViewer } from "./viewer.ts";
import { TrustedDiagnostics } from "./diagnostics.ts";
const require = createRequire(import.meta.url);
const { createBot } = require("mineflayer") as {
  createBot: typeof createBotFunction;
};
const sleep = (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};
const faces: Record<string, Vec3Data> = {
  up: { x: 0, y: 1, z: 0 },
  down: { x: 0, y: -1, z: 0 },
  north: { x: 0, y: 0, z: -1 },
  south: { x: 0, y: 0, z: 1 },
  east: { x: 1, y: 0, z: 0 },
  west: { x: -1, y: 0, z: 0 },
};
const effectPackets: Record<string, true> = {
  block_dig: true,
  block_place: true,
  use_item: true,
  use_entity: true,
  attack: true,
  window_click: true,
  close_window: true,
};
const controlNames: ControlName[] = [
  "forward",
  "back",
  "left",
  "right",
  "jump",
  "sprint",
  "sneak",
];
const digStatus = z.object({ status: z.number().int() });
const inputAck = z.object({ sequenceId: z.number().int() });
const digInput = digStatus.extend({
  location: z.object({ x: z.number(), y: z.number(), z: z.number() }),
});
const entityInput = z.object({
  target: z.number().int().optional(),
  entityId: z.number().int().optional(),
});
const windowInput = z.object({ windowId: z.number().int() });
const result = (
  status: GameActionResult["status"],
  summary: string,
  evidence: Record<string, Json> = {},
  reconnect = false,
): GameActionResult => ({
  status,
  summary,
  evidence: { effect_confirmed: false, neutralized_effect: false, ...evidence },
  ...(reconnect ? { requires_reconnect: true } : {}),
});
class AdmissionError extends Error {}
class Interrupted extends Error {}
interface DigLifecycle {
  target_key: string;
  start?: number;
  finish?: number;
  abort?: number;
  cancel_deadline?: number;
  sdk_settled: boolean;
  wake_pending: boolean;
  changed: ReturnType<typeof Promise.withResolvers<void>>;
}
interface Owner {
  controller: AbortController;
  action: GameAction;
  targets: Map<
    string,
    {
      kind: "block" | "entity";
      state_id?: number;
      raw_id?: number;
      position: Vec3Data;
      continuation?: () => boolean;
    }
  >;
  unabortable: boolean;
  generation: number;
  cancel_requested: boolean;
  uncertain: boolean;
  held_channel: boolean;
  neutralized_effect: boolean;
  dig?: DigLifecycle;
  settled: Promise<void>;
  finish: () => void;
}
const blockPacket = z.object({
  location: z.object({ x: z.number(), y: z.number(), z: z.number() }),
  type: z.number(),
});
const multiPacket = z.object({
  chunkCoordinates: z.object({ x: z.number(), y: z.number(), z: z.number() }),
  records: z.array(z.number()).max(4096),
});
const slotPacket = z.object({
  windowId: z.number().int(),
  slot: z.number().int(),
  item: z.object({}).passthrough(),
});
const inventoryPacket = z.object({
  windowId: z.number().int(),
  items: z.array(z.object({}).passthrough()).max(256),
});
const itemLoader = require("prismarine-item") as (registry: object) => {
  fromNotch(raw: object): Item | null;
};
export class TrustedGame {
  private bot: BridgeBot | null = null;
  private perception: Perception | null = null;
  private viewer: HumanViewer | null = null;
  private generation = 0;
  private active: Owner | null = null;
  private fenced = false;
  private inventoryRevision = 0;
  private blockEvidence = new Map<
    string,
    { state: number; revision: number }
  >();
  private blockRevision = 0;
  private inputSequence = 0;
  private acknowledgedSequence = 0;
  private serverInventory = new Map<number, InventoryItem>();
  private lastWindow: {
    id: number;
    start: number;
    end: number;
    slots: number;
  } | null = null;
  private hurtRevision = 0;
  private hurtEvents = new Map<number, number>();
  private openedWindows = 0;
  private diagnostics: TrustedDiagnostics | null = null;
  private state: GameState = {
    status: "disconnected",
    username: "GameHarness",
    version: "1.21.4",
    world_id: null,
    epoch: 0,
    viewer_ready: false,
    viewer_url: null,
    last_observation_at: null,
    player: null,
    error: null,
  };
  constructor(private notice: (notice: BridgeNotice) => void) {}
  snapshot() {
    return this.state;
  }
  private publish() {
    this.notice({ type: "state", data: this.state });
  }
  async connect(config: BridgeConnection) {
    await this.disconnect();
    const generation = ++this.generation;
    this.fenced = false;
    this.inventoryRevision = 0;
    this.serverInventory.clear();
    this.lastWindow = null;
    this.blockEvidence.clear();
    this.blockRevision = 0;
    this.inputSequence = 0;
    this.acknowledgedSequence = 0;
    this.hurtEvents.clear();
    this.openedWindows = 0;
    this.state = {
      ...this.state,
      status: "connecting",
      username: config.username,
      world_id: config.world_id,
      epoch: config.epoch,
      error: null,
    };
    this.publish();
    // The pinned entity/physics plugins install fields absent from Mineflayer's declaration.
    const bot = createBot({
      host: config.host,
      port: config.port,
      username: config.username,
      version: config.version,
      auth: "offline",
      hideErrors: true,
      viewDistance: "short",
    }) as unknown as BridgeBot;
    this.bot = bot;
    this.trackInputs(bot, generation);
    bot.on("error", () => {
      // Socket errors caused by our fence must not replace the known death or
      // lifecycle cause after authority has already been revoked.
      if (this.bot === bot && !this.fenced) {
        this.state = {
          ...this.state,
          error: "The Minecraft connection reported an error.",
        };
        this.publish();
        if (this.active?.dig) {
          this.active.uncertain = true;
          this.active.controller.abort();
          void this.fence();
        }
      }
    });
    bot.on("end", () => {
      if (this.bot !== bot) return;
      this.fenced = true;
      this.active?.controller.abort();
      this.perception?.close();
      this.perception = null;
      this.state = {
        ...this.state,
        status: "disconnected",
        viewer_ready: false,
        viewer_url: null,
        player: null,
      };
      this.publish();
      if (this.viewer) {
        const viewer = this.viewer;
        this.viewer = null;
        void viewer.close();
      }
    });
    let itemCodec: { fromNotch(raw: object): Item | null } | undefined;
    const inventoryItem = (slot: number, raw: object) => {
      if (slot < 0 || slot > 45) return;
      itemCodec ??= itemLoader(bot.registry);
      const item = itemCodec.fromNotch(raw);
      if (item)
        this.serverInventory.set(slot, {
          name: item.name,
          display_name: item.displayName,
          count: item.count,
          slot,
        });
      else this.serverInventory.delete(slot);
    };
    const playerSlot = (id: number, slot: number, length?: number) => {
      if (id === 0) return slot;
      const window = bot.currentWindow;
      const mapping =
        window?.id === id
          ? {
              id: window.id,
              start: window.inventoryStart,
              end: window.inventoryEnd,
              slots: window.slots.length,
            }
          : this.lastWindow;
      if (
        !mapping ||
        mapping.id !== id ||
        (length !== undefined && mapping.slots !== length) ||
        slot < mapping.start ||
        slot >= mapping.end
      )
        return -1;
      return slot - (mapping.start - bot.inventory.inventoryStart);
    };
    bot._client.on("set_slot", (raw) => {
      const parsed = slotPacket.safeParse(raw);
      if (!parsed.success) return;
      const packet = parsed.data;
      inventoryItem(playerSlot(packet.windowId, packet.slot), packet.item);
      this.inventoryRevision++;
    });
    bot._client.on("window_items", (raw) => {
      const parsed = inventoryPacket.safeParse(raw);
      if (!parsed.success) return;
      const packet = parsed.data;
      for (let slot = 0; slot < packet.items.length; slot++)
        inventoryItem(
          playerSlot(packet.windowId, slot, packet.items.length),
          packet.items[slot]!,
        );
      this.inventoryRevision++;
    });
    bot._client.on("close_window", () => {
      const window = bot.currentWindow;
      if (window)
        this.lastWindow = {
          id: window.id,
          start: window.inventoryStart,
          end: window.inventoryEnd,
          slots: window.slots.length,
        };
    });
    bot.on("windowClose", (window: BridgeBot["currentWindow"]) => {
      if (window)
        this.lastWindow = {
          id: window.id,
          start: window.inventoryStart,
          end: window.inventoryEnd,
          slots: window.slots.length,
        };
    });
    bot.on("windowOpen", () => {
      this.openedWindows++;
    });
    bot.on("entityHurt", (entity: Entity) => {
      this.hurtEvents.set(entity.id, ++this.hurtRevision);
      if (this.hurtEvents.size > 256)
        this.hurtEvents.delete(this.hurtEvents.keys().next().value!);
    });
    const lifecycle = () => {
      if (this.state.status !== "connected") return;
      void this.cancel("The player lifecycle changed.");
      this.perception?.close();
      this.perception = null;
      this.state = {
        ...this.state,
        status: "error",
        error:
          "The player died or changed dimension. Reconnect before continuing.",
        player: null,
      };
      this.publish();
      void this.fence();
    };
    bot.on("death", lifecycle);
    bot.on("respawn", lifecycle);
    try {
      const spawnedGate = Promise.withResolvers<void>();
      const timer = setTimeout(
        () => finish(new Error("Minecraft spawn timed out.")),
        30000,
      );
      const spawned = () => finish();
      const ended = () =>
        finish(new Error("Minecraft disconnected before spawn."));
      const finish = (error?: Error) => {
        clearTimeout(timer);
        bot.off("spawn", spawned);
        bot.off("end", ended);
        error ? spawnedGate.reject(error) : spawnedGate.resolve();
      };
      bot.once("spawn", spawned);
      bot.once("end", ended);
      await spawnedGate.promise;
      if (this.generation !== generation || this.fenced)
        throw new Interrupted();
      const diagnostics = await TrustedDiagnostics.create(config);
      if (this.generation !== generation || this.fenced) {
        await diagnostics.close();
        throw new Interrupted();
      }
      this.diagnostics = diagnostics;
      this.viewer = new HumanViewer(bot, config);
      const url = await this.viewer.start();
      if (this.generation !== generation || this.fenced)
        throw new Interrupted();
      this.state = {
        ...this.state,
        status: "connected",
        viewer_ready: true,
        viewer_url: url,
        error: null,
      };
      this.perception = new Perception(
        bot,
        config,
        () =>
          [...this.serverInventory.values()]
            .filter((i) => i.slot >= 5)
            .sort((a, b) => a.slot - b.slot),
        (entry) => this.diagnostics?.record(entry),
        (observation) => {
          if (this.generation !== generation || this.fenced) return;
          this.state = {
            ...this.state,
            player: observation.player,
            last_observation_at: observation.captured_at,
          };
          this.notice({ type: "observation", data: observation });
        },
      );
      this.perception.start();
      this.publish();
      this.notice({
        type: "game_event",
        data: {
          type: "connected",
          summary: "The player joined the local Minecraft world.",
        },
      });
    } catch {
      await this.disconnect();
      this.state = {
        ...this.state,
        status: "error",
        error: "Could not join Minecraft or start its authenticated viewer.",
      };
      this.publish();
      throw new Error(this.state.error!);
    }
  }
  private recordBlock(p: Vec3Data, state: number) {
    const key = `${p.x},${p.y},${p.z}`;
    this.blockEvidence.set(key, {
      state,
      revision: ++this.blockRevision,
    });
    if (this.blockEvidence.size > 8192)
      this.blockEvidence.delete(this.blockEvidence.keys().next().value!);
    if (this.active?.dig?.target_key === key) this.signalDig();
  }
  private signalDig(dig = this.active?.dig) {
    if (!dig || dig.wake_pending) return;
    dig.wake_pending = true;
    dig.changed.resolve();
  }
  private trackInputs(bot: BridgeBot, generation: number) {
    const write = bot._client.write.bind(bot._client);
    const current = () =>
      this.bot === bot && this.generation === generation && !this.fenced;
    bot._client.on("block_change", (raw) => {
      if (!current()) return;
      const parsed = blockPacket.safeParse(raw);
      if (parsed.success)
        this.recordBlock(parsed.data.location, parsed.data.type);
    });
    bot._client.on("multi_block_change", (raw) => {
      if (!current()) return;
      const parsed = multiPacket.safeParse(raw);
      if (!parsed.success) return;
      for (const record of parsed.data.records) {
        const c = parsed.data.chunkCoordinates;
        this.recordBlock(
          {
            x: c.x * 16 + ((record >> 8) & 15),
            y: c.y * 16 + (record & 15),
            z: c.z * 16 + ((record >> 4) & 15),
          },
          record >> 12,
        );
      }
    });
    // All three packet kinds share the server's cumulative ACK namespace.
    bot._client.on("acknowledge_player_digging", (raw: unknown) => {
      if (!current()) return;
      const parsed = inputAck.safeParse(raw);
      if (
        !parsed.success ||
        parsed.data.sequenceId <= this.acknowledgedSequence ||
        parsed.data.sequenceId > this.inputSequence
      )
        return;
      this.acknowledgedSequence = parsed.data.sequenceId;
      const dig = this.active?.dig;
      if (dig?.abort !== undefined && this.acknowledgedSequence >= dig.abort)
        this.signalDig(dig);
    });
    bot._client.write = ((name, packet) => {
      if (this.fenced || this.bot !== bot || this.generation !== generation)
        throw new Interrupted("Connection fenced.");
      if (this.authorizeEmission(name, packet) === false) return;
      if (
        name === "block_dig" ||
        name === "block_place" ||
        name === "use_item"
      ) {
        if (
          bot._client.serializer.writable === false ||
          bot._client.socket?.destroyed ||
          bot._client.socket?.writable === false ||
          this.inputSequence >= 0x7fffffff
        ) {
          if (this.active) this.active.uncertain = true;
          throw new Interrupted("Input delivery could not be confirmed.");
        }
        const sequence = ++this.inputSequence;
        packet = { ...packet, sequence };
        const phase = name === "block_dig" ? digInput.safeParse(packet) : null;
        const dig = this.active?.dig;
        const bound =
          this.active?.action.kind === "dig"
            ? this.active.targets.get(this.active.action.target_id)
            : undefined;
        if (
          dig &&
          phase?.success &&
          bound &&
          distance(bound.position, phase.data.location) === 0
        ) {
          if (phase.data.status === 0) dig.start = sequence;
          else if (phase.data.status === 2) dig.finish = sequence;
          else if (phase.data.status === 1) dig.abort = sequence;
        }
        // Register before write: a synchronous/coalesced ACK must not be missed.
        try {
          return write(name, packet);
        } catch (error) {
          if (this.active) this.active.uncertain = true;
          throw error;
        }
      }
      return write(name, packet);
    }) as typeof bot._client.write;
  }
  private connected() {
    if (
      !this.bot ||
      !this.perception ||
      this.fenced ||
      this.state.status !== "connected"
    )
      throw new AdmissionError("The player must reconnect before acting.");
    return { bot: this.bot, perception: this.perception };
  }
  observe() {
    return this.connected().perception.snapshot();
  }
  private neutralize() {
    if (!this.bot) return;
    this.bot.clearControlStates();
    this.bot.jumpQueued = false;
    this.bot.stopDigging();
    this.bot.deactivateItem();
  }
  private async fence() {
    const bot = this.bot;
    if (!bot) return;
    this.fenced = true;
    this.active?.controller.abort();
    // Destroy the actual transport before acknowledging uncertainty; delayed SDK calls hit the write fence.
    bot._client.socket?.destroy();
    bot._client.end("GameHarness input fence");
    this.perception?.close();
    this.perception = null;
    if (this.viewer) {
      const viewer = this.viewer;
      this.viewer = null;
      await viewer.close();
    }
    if (this.diagnostics) {
      const diagnostics = this.diagnostics;
      this.diagnostics = null;
      await diagnostics.close();
    }
    this.state = {
      ...this.state,
      status: "disconnected",
      viewer_ready: false,
      viewer_url: null,
      player: null,
    };
    this.publish();
  }
  async cancel(_reason: string) {
    const active = this.active,
      bot = this.bot;
    const held =
      !!active &&
      (active.held_channel || !!bot?.targetDigBlock || !!bot?.usingHeldItem);
    if (active) {
      active.cancel_requested = true;
      if (active.dig) active.dig.cancel_deadline ??= performance.now() + 1500;
      active.uncertain ||= active.unabortable && !active.dig;
      active.controller.abort();
    }
    try {
      this.neutralize();
    } catch {
      if (active) active.uncertain = true;
      await this.fence();
    }
    if (
      (active?.unabortable && !active.dig) ||
      active?.uncertain ||
      this.state.status === "connecting"
    )
      await this.fence();
    if (active && !active.dig && held && bot && !this.fenced) {
      active.neutralized_effect =
        controlNames.every((control) => !bot.getControlState(control)) &&
        !bot.jumpQueued &&
        !bot.targetDigBlock &&
        !bot.usingHeldItem;
      active.held_channel = false;
    }
    if (active) await active.settled;
  }
  async disconnect() {
    try {
      await this.cancel("Disconnect");
    } finally {
      await this.fence();
      this.bot = null;
      this.generation++;
      this.state = {
        ...this.state,
        status: "disconnected",
        viewer_ready: false,
        viewer_url: null,
        player: null,
        last_observation_at: null,
      };
      this.publish();
    }
  }
  private check(owner: Owner) {
    if (
      owner.controller.signal.aborted ||
      owner.generation !== this.generation ||
      this.fenced
    )
      throw new Interrupted();
  }
  private authorizeEmission(name: string, packet: unknown) {
    if (!Object.hasOwn(effectPackets, name)) return;
    if (name === "block_dig") {
      const body = digStatus.safeParse(packet);
      // Stopping a dig or releasing item use is permitted during neutralization.
      if (body.success && (body.data.status === 1 || body.data.status === 5))
        return;
    }
    const owner = this.active;
    if (!owner) throw new Interrupted("No effect owner.");
    this.check(owner);
    const action = owner.action;
    if (name === "block_dig" && action.kind === "dig") {
      const body = digInput.safeParse(packet);
      const bound = owner.targets.get(action.target_id);
      if (body.success && body.data.status === 2) {
        const { bot, perception } = this.connected();
        if (
          bound?.kind === "block" &&
          bound.continuation?.() &&
          distance(bound.position, body.data.location) === 0 &&
          distance(
            perception.eye(),
            vec(bound.position).offset(0.5, 0.5, 0.5),
          ) <= 5 &&
          bot.blockAt(vec(bound.position), false)?.stateId === bound.state_id
        )
          return;
        // Mineflayer emits completion from a timer, outside the SDK promise.
        // Reject that input through the owning operation, not an uncaught
        // callback exception. Cancellation removes its timer/listeners.
        owner.uncertain = true;
        owner.controller.abort();
        try {
          this.neutralize();
        } catch {
          // The owning SDK gate remains rejected; transport fencing below
          // is required when releasing the held channel cannot be confirmed.
        } finally {
          void this.fence();
        }
        return false;
      }
      if (
        !body.success ||
        !bound ||
        distance(bound.position, body.data.location) !== 0
      )
        throw new AdmissionError("The admitted dig target changed.");
    }
    let id: string | undefined;
    if (
      action.kind === "dig" ||
      action.kind === "place" ||
      action.kind === "interact" ||
      action.kind === "attack"
    )
      id = action.target_id;
    else if (action.kind === "craft") id = action.table_id;
    else if (action.kind === "move") id = action.interaction?.target_id;
    if (id) {
      const attacking =
        action.kind === "attack" ||
        (action.kind === "move" && action.interaction?.kind === "attack");
      const target = this.target(
        id,
        true,
        attacking ? 3 : action.kind === "dig" ? 5 : 4.5,
      );
      if (name === "use_entity" || name === "attack") {
        const body = entityInput.safeParse(packet);
        if (
          !body.success ||
          !target.entity ||
          (body.data.target ?? body.data.entityId) !== target.entity.id
        )
          throw new Interrupted("The authorized entity changed.");
      }
    }
    if (name === "window_click" || name === "close_window") {
      const body = windowInput.safeParse(packet);
      if (
        !body.success ||
        body.data.windowId !== (this.bot!.currentWindow?.id ?? 0)
      )
        throw new Interrupted("The interaction UI session changed.");
    }
  }
  private target(id: string, current = true, reach?: number) {
    const { bot, perception } = this.connected();
    const entry = perception.target(id, current);
    if (!entry)
      throw new AdmissionError(
        "The target is unknown or no longer currently observed.",
      );
    if (
      reach !== undefined &&
      distance(
        perception.eye(),
        entry.kind === "block"
          ? vec(entry.value.position).offset(0.5, 0.5, 0.5)
          : entry.value.position,
      ) > reach
    )
      throw new AdmissionError(
        "The known target is outside interaction reach.",
      );
    if (!current) return { entry, block: null, entity: null };
    if (this.active) {
      const bound = this.active.targets.get(id);
      if (
        bound &&
        (bound.kind !== entry.kind ||
          bound.state_id !== entry.state_id ||
          bound.raw_id !== entry.raw_id ||
          distance(bound.position, entry.value.position) > 0)
      )
        throw new AdmissionError(
          "The admitted target changed during this action.",
        );
      if (!bound)
        this.active.targets.set(id, {
          kind: entry.kind,
          state_id: entry.state_id,
          raw_id: entry.raw_id,
          position: point(entry.value.position),
          ...(this.active.action.kind === "dig" && entry.kind === "block"
            ? { continuation: perception.retainBlockProof(id) ?? undefined }
            : {}),
        });
    }
    if (entry.kind === "block") {
      const block = bot.blockAt(vec(entry.value.position), false);
      if (!block || block.stateId !== entry.state_id)
        throw new AdmissionError(
          "The known target changed; request a new observation.",
        );
      return { entry, block, entity: null };
    }
    const entity = bot.entities[entry.raw_id!];
    if (!entity || distance(entity.position, entry.value.position) > 0)
      throw new AdmissionError(
        "The known target moved; request a new observation.",
      );
    return { entry, block: null, entity };
  }
  private async sdk<T>(
    owner: Owner,
    work: () => Promise<T>,
    timeout = 8000,
    reversible = false,
  ): Promise<T> {
    this.check(owner);
    let started = false,
      settled = false;
    const gate = Promise.withResolvers<never>();
    const timer = setTimeout(
      () => gate.reject(new Error("Uncertain SDK completion.")),
      timeout,
    );
    const abort = () => gate.reject(new Interrupted());
    // Forced look is a bounded setpoint, not an irreversible transaction.
    // Keep its owner until the real promise settles; abort must not abandon
    // a late camera continuation and transfer the controls underneath it.
    if (!reversible)
      owner.controller.signal.addEventListener("abort", abort, { once: true });
    try {
      const operation = Promise.resolve().then(async () => {
        this.check(owner);
        started = true;
        owner.unabortable = !reversible;
        try {
          return await work();
        } finally {
          settled = true;
        }
      });
      const value = await Promise.race([operation, gate.promise]);
      this.check(owner);
      return value;
    } catch (error) {
      if ((started && !settled) || owner.uncertain) {
        owner.uncertain ||= started && !reversible;
        await this.fence();
      }
      throw error;
    } finally {
      clearTimeout(timer);
      owner.controller.signal.removeEventListener("abort", abort);
      owner.unabortable = false;
    }
  }
  private async wait(owner: Owner, predicate: () => boolean, timeout = 1500) {
    const until = performance.now() + timeout;
    while (performance.now() < until) {
      this.check(owner);
      if (predicate()) return true;
      await sleep(25);
    }
    return predicate();
  }
  private async dig(
    owner: Owner,
    bot: BridgeBot,
    block: Block,
    targetId: string,
  ): Promise<GameActionResult> {
    const p = point(block.position),
      revision = this.blockRevision;
    const dig: DigLifecycle = {
      target_key: `${p.x},${p.y},${p.z}`,
      sdk_settled: false,
      wake_pending: false,
      changed: Promise.withResolvers<void>(),
    };
    owner.dig = dig;
    const confirmed = () => {
      const evidence = this.blockEvidence.get(dig.target_key);
      return (
        !!evidence &&
        evidence.revision > revision &&
        ["air", "cave_air", "void_air"].includes(
          bot.registry.blocksByStateId[evidence.state]?.name ?? "",
        )
      );
    };
    const neutral = () =>
      controlNames.every((control) => !bot.getControlState(control)) &&
      !bot.jumpQueued &&
      !bot.targetDigBlock &&
      !bot.usingHeldItem;
    let sdkError: unknown;
    let deadline =
      performance.now() +
      Math.min(30000, Math.max(5000, bot.digTime(block) + 3000));
    let cancelling = false,
      cleaned = false,
      completionDeadline = false;
    const abort = () => this.signalDig(dig);
    owner.controller.signal.addEventListener("abort", abort);
    // Never race away from the real SDK task and release its owner. Its initial
    // look can still resume; the write gate rejects a cancelled late START.
    void Promise.resolve()
      .then(() => {
        this.check(owner);
        return bot.dig(block, true);
      })
      .catch((error: unknown) => {
        sdkError = error;
      })
      .finally(() => {
        dig.sdk_settled = true;
        this.signalDig(dig);
      });
    try {
      while (true) {
        if (dig.wake_pending) {
          dig.wake_pending = false;
          dig.changed = Promise.withResolvers<void>();
        }
        if (
          this.fenced ||
          this.bot !== bot ||
          owner.generation !== this.generation ||
          owner.uncertain ||
          bot._client.socket?.destroyed ||
          bot._client.socket?.writable === false
        )
          throw new Interrupted();
        if (owner.cancel_requested && !cancelling) {
          cancelling = true;
          deadline = dig.cancel_deadline ?? performance.now() + 1500;
          // A START write can synchronously trigger cancellation before the SDK
          // installs its stop closure. Retry cleanup after that stack unwinds.
          this.neutralize();
        }
        if (performance.now() >= deadline) throw new Interrupted();
        if (dig.sdk_settled) {
          if (!cleaned) {
            this.neutralize();
            cleaned = true;
          }
          if (!neutral()) throw new Interrupted();
          if (confirmed())
            return result(
              "succeeded",
              "The server confirmed the known block was removed.",
              {
                effect_confirmed: true,
                target_id: targetId,
                source: "server_block_update",
              },
            );
          if (cancelling) {
            const acknowledged =
              dig.abort !== undefined && this.acknowledgedSequence >= dig.abort;
            if (
              dig.finish === undefined &&
              (dig.start === undefined || acknowledged)
            )
              return result(
                "cancelled",
                "Digging was stopped. Earlier block, camera, or other effects remain unverified; cancellation is not rollback.",
                {
                  cancellation_confirmed: true,
                  prior_effects: "unverified",
                  dig_started: dig.start !== undefined,
                  dig_finish_submitted: false,
                  sdk_settled: true,
                  local_channels_neutral: true,
                  abort_acknowledged: acknowledged,
                  target_id: targetId,
                },
              );
          } else {
            if (sdkError !== undefined) throw sdkError;
            if (!completionDeadline) {
              completionDeadline = true;
              deadline = performance.now() + 1500;
            }
          }
        }
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new Interrupted();
        const changed = dig.changed.promise;
        const timeout = Promise.withResolvers<void>();
        const timer = setTimeout(timeout.resolve, remaining);
        try {
          await Promise.race([changed, timeout.promise]);
        } finally {
          clearTimeout(timer);
        }
      }
    } catch {
      owner.uncertain = true;
      await this.fence();
      return result(
        "unknown",
        "Digging or its shutdown could not be confirmed. Earlier effects remain unverified; reconnect before continuing.",
        {
          cancellation_confirmed: false,
          prior_effects: "unverified",
          dig_started: dig.start !== undefined,
          dig_finish_submitted: dig.finish !== undefined,
          sdk_settled: dig.sdk_settled,
          abort_acknowledged:
            dig.abort !== undefined && this.acknowledgedSequence >= dig.abort,
          target_id: targetId,
          ...(confirmed()
            ? { effect_confirmed: true, source: "server_block_update" }
            : {}),
        },
        true,
      );
    } finally {
      owner.controller.signal.removeEventListener("abort", abort);
    }
  }
  recipes(item: string): Json {
    if (!/^[a-z][a-z0-9_]{0,79}$/.test(item))
      throw new AdmissionError("Use a registry item name.");
    const { bot } = this.connected(),
      definition = Object.hasOwn(bot.registry.itemsByName, item)
        ? bot.registry.itemsByName[item]
        : undefined;
    if (!definition) return { item, recipes: [] };
    const all = bot.recipesAll(definition.id, null, true).slice(0, 32);
    const available = bot.recipesFor(definition.id, null, 1, true);
    const table = bot.recipesAll(definition.id, null, false);
    return {
      item,
      recipes: all.map((recipe) => ({
        result: {
          item: bot.registry.items[recipe.result.id]?.name ?? item,
          count: recipe.result.count,
        },
        requires_table: !table.some(
          (r) => JSON.stringify(r) === JSON.stringify(recipe),
        ),
        craftable_with_inventory: available.some(
          (r) => JSON.stringify(r) === JSON.stringify(recipe),
        ),
        ingredients: recipe.delta
          .filter((d) => d.count < 0)
          .map((d) => ({
            item: bot.registry.items[d.id]?.name ?? "unknown",
            count: -d.count,
          })),
      })),
    };
  }
  async execute(input: unknown): Promise<GameActionResult> {
    const parsed = gameActionSchema.safeParse(input);
    if (!parsed.success)
      return result(
        "failed",
        "The action does not match the allowed game-action schema.",
      );
    if (this.active)
      return result("failed", "Another game action owns the controls.");
    const completion = Promise.withResolvers<void>();
    const owner: Owner = {
      controller: new AbortController(),
      action: parsed.data,
      targets: new Map(),
      unabortable: false,
      generation: this.generation,
      cancel_requested: false,
      uncertain: false,
      held_channel: false,
      neutralized_effect: false,
      settled: completion.promise,
      finish: completion.resolve,
    };
    this.active = owner;
    const action = parsed.data;
    try {
      const { bot } = this.connected();
      this.check(owner);
      let output: GameActionResult;
      switch (action.kind) {
        case "look": {
          const before = { yaw: bot.entity.yaw, pitch: bot.entity.pitch };
          await this.sdk(
            owner,
            () => bot.look(action.yaw, action.pitch, true),
            8000,
            true,
          );
          const changed =
            Math.abs(
              Math.atan2(
                Math.sin(bot.entity.yaw - before.yaw),
                Math.cos(bot.entity.yaw - before.yaw),
              ),
            ) > 1e-5 || Math.abs(bot.entity.pitch - before.pitch) > 1e-5;
          output = result(
            "succeeded",
            "The player camera reached the requested orientation.",
            {
              effect_confirmed: changed,
              source: "client_observed_pose",
              before,
              after: { yaw: bot.entity.yaw, pitch: bot.entity.pitch },
            },
          );
          break;
        }
        case "move":
          output = await this.move(action, owner);
          break;
        case "navigate":
          output = await this.navigate(action, owner);
          break;
        case "equip": {
          const item = bot.inventory
            .items()
            .find(
              (i) =>
                i.name === action.item &&
                this.serverInventory.get(i.slot)?.name === i.name,
            );
          if (!item)
            throw new AdmissionError(
              "The requested item is not in the confirmed player inventory.",
            );
          const slots: Record<string, number> = {
            "off-hand": 45,
            head: 5,
            torso: 6,
            legs: 7,
            feet: 8,
          };
          const beforeSlot =
            action.destination === "hand"
              ? bot.quickBarSlot + bot.inventory.hotbarStart
              : slots[action.destination]!;
          const beforeName = this.serverInventory.get(beforeSlot)?.name ?? null;
          await this.sdk(owner, () => bot.equip(item, action.destination));
          const slot =
            action.destination === "hand"
              ? bot.quickBarSlot + bot.inventory.hotbarStart
              : slots[action.destination]!;
          const equipped = this.serverInventory.get(slot);
          output =
            equipped?.name === action.item
              ? result(
                  "succeeded",
                  "The requested item is selected in the equipment slot.",
                  {
                    effect_confirmed:
                      beforeSlot !== slot || beforeName !== equipped.name,
                    item: action.item,
                    destination: action.destination,
                    source: "server_inventory_and_selected_slot",
                  },
                )
              : result("unknown", "Equipment selection was not confirmed.");
          break;
        }
        case "dig": {
          const target = this.target(action.target_id, true, 5);
          if (!target.block || !bot.canDigBlock(target.block))
            throw new AdmissionError(
              "The known target cannot be dug from the current position.",
            );
          output = await this.dig(owner, bot, target.block, action.target_id);
          break;
        }
        case "place": {
          const target = this.target(action.target_id, true, 4.5);
          if (!target.block)
            throw new AdmissionError(
              "Placement requires a currently observed block face.",
            );
          const item = bot.inventory
            .items()
            .find((i) => i.name === action.item);
          if (!item)
            throw new AdmissionError(
              "The requested placement item is not in inventory.",
            );
          await this.sdk(owner, () => bot.equip(item, "hand"));
          this.check(owner);
          const fresh = this.target(action.target_id, true, 4.5);
          if (!fresh.block)
            throw new AdmissionError("The placement reference changed.");
          const face = faces[action.face]!,
            p = fresh.block.position.plus(vec(face)),
            revision = this.blockRevision;
          const beforeCount = [...this.serverInventory.values()]
            .filter((i) => i.name === action.item)
            .reduce((n, i) => n + i.count, 0);
          owner.uncertain = true;
          await this.sdk(owner, () => bot.placeBlock(fresh.block!, vec(face)));
          const confirmed = await this.wait(owner, () => {
            const e = this.blockEvidence.get(`${p.x},${p.y},${p.z}`);
            const afterCount = [...this.serverInventory.values()]
              .filter((i) => i.name === action.item)
              .reduce((n, i) => n + i.count, 0);
            return (
              !!e &&
              e.revision > revision &&
              bot.registry.blocksByStateId[e.state]?.name === action.item &&
              afterCount < beforeCount
            );
          });
          owner.uncertain = !confirmed;
          if (!confirmed) await this.fence();
          output = confirmed
            ? result(
                "succeeded",
                "The server confirmed the placed block and inventory consumption.",
                {
                  effect_confirmed: true,
                  target_id: action.target_id,
                  item: action.item,
                  face: action.face,
                  source: "server_block_and_inventory_update",
                },
              )
            : result(
                "unknown",
                "Placement was sent, but its resulting block was not confirmed.",
                {},
                true,
              );
          break;
        }
        case "craft": {
          const definition = Object.hasOwn(
            bot.registry.itemsByName,
            action.item,
          )
            ? bot.registry.itemsByName[action.item]
            : undefined;
          if (!definition)
            throw new AdmissionError("The requested recipe item is not known.");
          let table: Block | null = null;
          if (action.table_id) {
            const target = this.target(action.table_id, true, 4.5);
            if (target.block?.name !== "crafting_table")
              throw new AdmissionError(
                "Crafting requires a currently observed reachable crafting table.",
              );
            table = target.block;
          }
          const recipe = bot.recipesFor(definition.id, null, 1, table)[0];
          if (!recipe)
            throw new AdmissionError(
              "No recipe is currently craftable with the supplied inventory and table.",
            );
          const before = [...this.serverInventory.values()]
              .filter((i) => i.slot >= 9 && i.name === action.item)
              .reduce((n, i) => n + i.count, 0),
            revision = this.inventoryRevision;
          owner.uncertain = true;
          await this.sdk(
            owner,
            () => bot.craft(recipe, action.executions, table ?? undefined),
            12000,
          );
          const expected = recipe.result.count * action.executions;
          const confirmed = await this.wait(
            owner,
            () =>
              this.inventoryRevision > revision &&
              [...this.serverInventory.values()]
                .filter((i) => i.slot >= 9 && i.name === action.item)
                .reduce((n, i) => n + i.count, 0) >=
                before + expected,
          );
          owner.uncertain = !confirmed;
          if (!confirmed) await this.fence();
          output = confirmed
            ? result(
                "succeeded",
                "The server inventory confirmed the crafted output.",
                {
                  effect_confirmed: true,
                  item: action.item,
                  executions: action.executions,
                  output_count: expected,
                  source: "server_inventory_update",
                },
              )
            : result(
                "unknown",
                "Craft execution ended without confirmed output inventory.",
                {},
                true,
              );
          break;
        }
        case "attack": {
          const target = this.target(action.target_id, true, 3);
          if (!target.entity)
            throw new AdmissionError(
              "Attack requires a currently observed reachable entity.",
            );
          const id = target.entity.id,
            revision = this.hurtRevision;
          this.performAttack(action.target_id, owner);
          const hurt = await this.wait(
            owner,
            () => (this.hurtEvents.get(id) ?? 0) > revision,
            650,
          );
          output = hurt
            ? result(
                "succeeded",
                "The server reported hurt on the known target after the attack.",
                {
                  effect_confirmed: true,
                  target_id: action.target_id,
                  source: "server_entity_hurt",
                  attribution: "post_input_target_event",
                },
              )
            : result(
                "unknown",
                "An attack packet was sent; damage or a hit was not verified.",
                { target_id: action.target_id, source: "input_emitted" },
              );
          break;
        }
        case "interact": {
          const target = this.target(action.target_id, true, 4.5),
            revision = this.blockRevision,
            windows = this.openedWindows;
          owner.uncertain = true;
          await this.interact(action.target_id, owner);
          const verified = await this.wait(
            owner,
            () => {
              if (this.openedWindows > windows) return true;
              if (!target.block) return false;
              const update = this.blockEvidence.get(
                `${target.block.position.x},${target.block.position.y},${target.block.position.z}`,
              );
              return (
                !!update &&
                update.revision > revision &&
                update.state !== target.entry.state_id
              );
            },
            650,
          );
          owner.uncertain = !verified;
          if (!verified) await this.fence();
          output = verified
            ? result(
                "succeeded",
                "The server confirmed an interaction UI or changed known-target block.",
                {
                  effect_confirmed: true,
                  target_id: action.target_id,
                  source:
                    this.openedWindows > windows
                      ? "server_interaction_ui"
                      : "server_block_update",
                },
              )
            : result(
                "unknown",
                "Interaction input completed; its game effect was not verified.",
                { target_id: action.target_id, source: "input_emitted" },
                true,
              );
          break;
        }
      }
      this.notice({
        type: "game_event",
        data: {
          type: "action_result",
          kind: action.kind,
          status: output.status,
          summary: output.summary,
        },
      });
      return output;
    } catch (error) {
      if (error instanceof AdmissionError)
        return result("failed", error.message);
      if (owner.cancel_requested)
        return owner.uncertain
          ? result(
              "unknown",
              "Cancellation fenced an in-flight SDK operation; its effects remain uncertain.",
              {},
              true,
            )
          : result(
              "cancelled",
              this.fenced
                ? "The action was cancelled and the connection fenced."
                : "The action was cancelled and controls released.",
              { neutralized_effect: owner.neutralized_effect },
              this.fenced,
            );
      await this.fence();
      return result(
        "unknown",
        "The game operation could not be confirmed. Reconnect before continuing.",
        {},
        true,
      );
    } finally {
      try {
        if (!owner.dig) this.neutralize();
      } catch {
        await this.fence();
      }
      if (this.active === owner) this.active = null;
      owner.finish();
    }
  }
  private performAttack(id: string, owner: Owner) {
    this.check(owner);
    const target = this.target(id, true, 3);
    if (!target.entity)
      throw new AdmissionError(
        "Attack requires a currently observed reachable entity.",
      );
    this.bot!.attack(target.entity);
  }
  private async interact(id: string, owner: Owner, timeout = 8000) {
    const target = this.target(id, true, 4.5);
    await this.sdk(
      owner,
      () =>
        target.block
          ? this.bot!.activateBlock(target.block)
          : this.bot!.activateEntity(target.entity!),
      timeout,
    );
  }
  private async move(
    action: Extract<GameAction, { kind: "move" }>,
    owner: Owner,
  ) {
    const { bot } = this.connected();
    const before = point(bot.entity.position),
      beforeLook = { yaw: bot.entity.yaw, pitch: bot.entity.pitch };
    this.check(owner);
    if (action.interaction?.kind === "attack") {
      if (!action.interaction.target_id)
        throw new AdmissionError("Composite attack requires a known target.");
      const target = this.target(action.interaction.target_id, true, 3);
      if (!target.entity)
        throw new AdmissionError(
          "Composite attack requires a known reachable entity.",
        );
    } else if (action.interaction?.target_id)
      this.target(action.interaction.target_id, true, 4.5);
    // Set held controls before camera/interaction awaits: all channels share one owner and overlap.
    for (const [control, value] of Object.entries(action.controls))
      bot.setControlState(control as ControlName, value!);
    owner.held_channel = Object.values(action.controls).some(Boolean);
    const deadline = performance.now() + action.duration_ms;
    const release = setTimeout(() => {
      bot.clearControlStates();
      bot.jumpQueued = false;
      owner.held_channel = false;
      try {
        bot.deactivateItem();
      } catch {
        void this.fence();
      }
    }, action.duration_ms);
    try {
      if (action.look)
        await this.sdk(
          owner,
          () => bot.look(action.look!.yaw, action.look!.pitch, true),
          Math.max(1, deadline - performance.now()),
          true,
        );
      if (action.interaction?.kind === "attack") {
        if (!action.interaction.target_id)
          throw new AdmissionError("Composite attack requires a known target.");
        this.performAttack(action.interaction.target_id, owner);
      } else if (action.interaction?.kind === "use") {
        if (action.interaction.target_id)
          await this.interact(
            action.interaction.target_id,
            owner,
            Math.max(1, deadline - performance.now()),
          );
        else {
          this.check(owner);
          bot.activateItem();
          owner.held_channel = true;
        }
      }
      while (performance.now() < deadline) {
        this.check(owner);
        await sleep(Math.min(25, Math.max(1, deadline - performance.now())));
      }
      this.check(owner);
      const after = point(bot.entity.position),
        afterLook = { yaw: bot.entity.yaw, pitch: bot.entity.pitch };
      const moved = distance(before, after),
        lookChanged =
          Math.abs(
            Math.atan2(
              Math.sin(afterLook.yaw - beforeLook.yaw),
              Math.cos(afterLook.yaw - beforeLook.yaw),
            ),
          ) > 1e-5 || Math.abs(afterLook.pitch - beforeLook.pitch) > 1e-5;
      return result(
        moved > 0.01 || lookChanged ? "succeeded" : "unknown",
        moved > 0.01
          ? "The bounded input produced observed player movement."
          : lookChanged
            ? "The bounded input changed the player camera."
            : "The bounded inputs ended; no displacement or camera change was confirmed.",
        {
          effect_confirmed: moved > 0.01 || lookChanged,
          source: "client_observed_pose",
          before,
          after,
          before_look: beforeLook,
          after_look: afterLook,
          displacement: moved,
          interaction_effect: action.interaction
            ? "unverified"
            : "not_requested",
        },
      );
    } finally {
      clearTimeout(release);
      bot.clearControlStates();
      bot.jumpQueued = false;
      owner.held_channel = false;
    }
  }
  private plan(target: Vec3Data, range: number): Vec3Data[] | null {
    const { bot } = this.connected(),
      feet = point(bot.entity.position),
      origin = {
        x: Math.floor(feet.x),
        y: Math.floor(feet.y),
        z: Math.floor(feet.z),
      },
      started = performance.now();
    let visits = 0,
      expanded = 0,
      peakQueue = 1;
    const cells = new Set<string>(),
      reads: Vec3Data[] = [];
    try {
      const geometry = (p: Vec3Data) => {
        if (
          distance({ x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.5 }, feet) > 8 ||
          Math.abs(p.x - origin.x) > 8 ||
          Math.abs(p.y - origin.y) > 8 ||
          Math.abs(p.z - origin.z) > 8
        )
          return null;
        if (visits >= 8192 || performance.now() - started >= 5)
          throw new AdmissionError(
            "Local geometry planning could not establish a bounded route.",
          );
        const k = `${p.x},${p.y},${p.z}`;
        if (!cells.has(k) && cells.size >= 4913)
          throw new AdmissionError(
            "Local geometry planning reached its bound.",
          );
        cells.add(k);
        visits++;
        reads.push(point(p));
        const block = bot.blockAt(vec(p), false);
        return knownGeometry(bot, block) ? block.shapes : null;
      };
      const passable = (p: Vec3Data) => {
        const feetShapes = geometry(p),
          headShapes = geometry({ x: p.x, y: p.y + 1, z: p.z }),
          support = geometry({ x: p.x, y: p.y - 1, z: p.z });
        return (
          feetShapes !== null &&
          headShapes !== null &&
          support !== null &&
          !feetShapes.length &&
          !headShapes.length &&
          support.some((s) => s[4] === 1)
        );
      };
      type Node = { p: Vec3Data; g: number; f: number; parent: Node | null };
      const heuristic = (p: Vec3Data) =>
        Math.hypot(p.x + 0.5 - target.x, p.z + 0.5 - target.z) +
        Math.abs(p.y - target.y);
      const open: Node[] = [
          { p: origin, g: 0, f: heuristic(origin), parent: null },
        ],
        best = new Map<string, number>([
          [`${origin.x},${origin.y},${origin.z}`, 0],
        ]);
      while (
        open.length &&
        expanded < 2048 &&
        performance.now() - started < 5
      ) {
        expanded++;
        open.sort(
          (a, b) =>
            a.f - b.f ||
            a.g - b.g ||
            a.p.x - b.p.x ||
            a.p.y - b.p.y ||
            a.p.z - b.p.z,
        );
        const node = open.shift()!;
        const localFeet = { x: node.p.x + 0.5, y: node.p.y, z: node.p.z + 0.5 };
        if (
          distance(localFeet, target) <= range ||
          (distance(feet, target) > 7 &&
            distance(localFeet, feet) >= 5 &&
            heuristic(node.p) < heuristic(origin))
        ) {
          const path: Vec3Data[] = [];
          let cursor: Node | null = node;
          while (cursor?.parent) {
            path.unshift(cursor.p);
            cursor = cursor.parent;
          }
          return path;
        }
        const neighbors: Vec3Data[] = [];
        for (const [dx, dz] of [
          [-1, 0],
          [0, -1],
          [0, 1],
          [1, 0],
        ])
          for (const dy of [-1, 0, 1])
            neighbors.push({
              x: node.p.x + dx!,
              y: node.p.y + dy,
              z: node.p.z + dz!,
            });
        neighbors.sort((a, b) => a.x - b.x || a.y - b.y || a.z - b.z);
        for (const p of neighbors) {
          const k = `${p.x},${p.y},${p.z}`,
            g = node.g + 1 + Math.abs(p.y - node.p.y) * 0.25;
          if ((best.get(k) ?? Infinity) <= g) continue;
          if (!passable(p)) continue;
          if (p.y > node.p.y) {
            const sourceHead = geometry({
              x: node.p.x,
              y: node.p.y + 2,
              z: node.p.z,
            });
            if (sourceHead === null || sourceHead.length) continue;
          }
          best.set(k, g);
          if (open.length >= 4096) return null;
          open.push({ p, g, f: g + heuristic(p), parent: node });
          peakQueue = Math.max(peakQueue, open.length);
        }
      }
      return null;
    } finally {
      this.diagnostics?.record({
        type: "local_geometry_plan",
        basis: "authorized_target_location",
        target: point(target),
        feet,
        range,
        cell_visits: visits,
        distinct_cells: cells.size,
        expanded_nodes: expanded,
        peak_queued_nodes: peakQueue,
        duration_ms: performance.now() - started,
        read_cells: reads,
      });
    }
  }
  private async navigate(
    action: Extract<GameAction, { kind: "navigate" }>,
    owner: Owner,
  ) {
    const { bot } = this.connected();
    const target = this.target(action.target_id, false).entry.value.position;
    const before = point(bot.entity.position),
      deadline = performance.now() + action.duration_ms;
    let reached = distance(before, target) <= action.range;
    let invalidated = false,
      nextPlanAt = 0;
    const invalidate = () => {
      invalidated = true;
      bot.clearControlStates();
      bot.jumpQueued = false;
      owner.held_channel = false;
    };
    bot.on("blockUpdate", invalidate);
    bot.on("forcedMove", invalidate);
    bot.on("chunkColumnUnload", invalidate);
    try {
      while (!reached && performance.now() < deadline) {
        this.check(owner);
        while (performance.now() < nextPlanAt && performance.now() < deadline) {
          await sleep(
            Math.ceil(Math.min(nextPlanAt, deadline) - performance.now()),
          );
          this.check(owner);
        }
        if (performance.now() >= deadline) break;
        invalidated = false;
        const planStarted = performance.now();
        nextPlanAt = planStarted + 100;
        let path: Vec3Data[] | null;
        try {
          path = this.plan(target, action.range);
        } catch (error) {
          if (error instanceof AdmissionError)
            return result(
              "failed",
              "A bounded geometry-only local route could not be established.",
              {
                effect_confirmed: distance(before, bot.entity.position) > 0.01,
                target_id: action.target_id,
                before,
                after: point(bot.entity.position),
              },
            );
          throw error;
        }
        if (!path?.length)
          return result(
            "failed",
            "No bounded local route to the known target was established.",
            {
              effect_confirmed: distance(before, bot.entity.position) > 0.01,
              target_id: action.target_id,
              before,
              after: point(bot.entity.position),
            },
          );
        const next = path[0]!,
          dx = next.x + 0.5 - bot.entity.position.x,
          dz = next.z + 0.5 - bot.entity.position.z;
        await this.sdk(
          owner,
          () => bot.look(Math.atan2(-dx, -dz), bot.entity.pitch, true),
          Math.max(1, deadline - performance.now()),
          true,
        );
        this.check(owner);
        if (!invalidated) {
          bot.setControlState("forward", true);
          bot.setControlState(
            "jump",
            next.y > Math.floor(bot.entity.position.y),
          );
          owner.held_channel = true;
        }
        await sleep(
          Math.max(
            1,
            Math.min(
              100 - (performance.now() - planStarted),
              deadline - performance.now(),
            ),
          ),
        );
        this.check(owner);
        bot.clearControlStates();
        bot.jumpQueued = false;
        owner.held_channel = false;
        reached = distance(bot.entity.position, target) <= action.range;
      }
      return result(
        reached ? "succeeded" : "failed",
        reached
          ? "The player reached the requested range of the known location."
          : "The navigation duration ended before reaching the known location.",
        {
          effect_confirmed: distance(before, bot.entity.position) > 0.01,
          target_id: action.target_id,
          source: "client_observed_pose",
          before,
          after: point(bot.entity.position),
          reached,
        },
      );
    } finally {
      bot.off("blockUpdate", invalidate);
      bot.off("forcedMove", invalidate);
      bot.off("chunkColumnUnload", invalidate);
    }
  }
}
