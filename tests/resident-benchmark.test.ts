import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveStudyManifest } from "./helpers/study-manifest.ts";
import {
  DEFAULT_RESIDENT_BENCHMARK_PROTOCOL,
  RESIDENT_BENCHMARK_SOURCE,
  residentBenchmarkSchedule,
  validateResidentBenchmarkDeclaration,
} from "../src/evaluation/resident-benchmark.ts";
import * as benchmark from "../src/evaluation/resident-benchmark.ts";
import { StudyLedger } from "../src/evaluation/studies.ts";
import { HistoryReader } from "../src/server/history-reader.ts";
import { programEvidence } from "../src/server/program-evidence.ts";
import {
  finishHistoryExecution,
  historyExecution,
  historyFixture,
  historySpec,
} from "./helpers/history-fixture.ts";
import type { GameState } from "../src/shared/contracts.ts";
import {
  minecraftTestAdapter,
  minecraftTestBinding,
} from "./helpers/adapter-contract.ts";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture(mode: "cohort" | "calibration" = "cohort") {
  const root = mkdtempSync(join(tmpdir(), "gameharness-resident-benchmark-"));
  roots.push(root);
  const manifest = liveStudyManifest(root, "resident-benchmark-boundary");
  const protocol = {
    ...structuredClone(DEFAULT_RESIDENT_BENCHMARK_PROTOCOL),
    mode,
  };
  const checked = (path: string, text: string) => {
    writeFileSync(join(root, path), text);
    return { path, sha256: createHash("sha256").update(text).digest("hex") };
  };
  manifest.permission.record = checked(
    "permission.txt",
    "Local zero-provider technical benchmark fixture; no native or provider launch.",
  );
  manifest.task.text =
    "Measure native resident independence; not agent competence";
  manifest.task.identity = checked("task.txt", manifest.task.text);
  manifest.task.verifier = checked("protocol.json", JSON.stringify(protocol));
  manifest.task.horizon_ms = 165000;
  manifest.identities.controller = checked(
    "controller.mjs",
    RESIDENT_BENCHMARK_SOURCE,
  );
  manifest.identities.model = null;
  manifest.execution = {
    ...manifest.execution,
    controller_mode: "resident_platform",
    adaptation: "none",
    start_mode: "evaluator_prepared_world",
    request_paths: [],
  };
  const profile = manifest.identities.profile;
  const rates = mode === "calibration" ? [20] : [1, 5, 20],
    delays = mode === "calibration" ? [30000] : [15000, 30000, 90000];
  manifest.arms = rates.map((rate) => ({
    id: `hertz_${rate}`,
    description: "Synthetic mechanical source only",
    model: null,
    helpers: [],
    profile,
  }));
  manifest.initial_states = delays.map((delay) => ({
    id: `delay_${delay}`,
    mode: "evaluator_prepared_world",
    seed: null,
    save: null,
    settings: {
      difficulty: "normal",
      gamemode: "survival",
      cheats: true,
      level_type: "minecraft:normal",
      structures: true,
      hardcore: false,
      supplied_inventory: true,
      console_commands: true,
      fresh_world_per_slot: true,
    },
  }));
  manifest.repetitions = 3;
  manifest.optional_blocks = [];
  manifest.schedule = residentBenchmarkSchedule(manifest.study_id, mode);
  manifest.allowances = {
    per_attempt: {
      host_requests: 0,
      concurrent_requests: 0,
      workers: 1,
      wall_ms: 300000,
    },
    cohort: {
      host_requests: 0,
      concurrent_requests: 0,
      workers: 1,
      attempt_wall_ms: 300000 * manifest.schedule.length,
      elapsed_ms: 10800000,
    },
  };
  const update = () => {
    manifest.task.verifier = checked("protocol.json", JSON.stringify(protocol));
  };
  return {
    root,
    manifest,
    protocol,
    update,
    parse: () =>
      validateResidentBenchmarkDeclaration(manifest, { projectRoot: root }),
  };
}

test("prospective E01 admits the full-stream declaration and refuses incomplete or superseded timing declarations before native admission", () => {
  for (const mode of ["cohort", "calibration"] as const)
    for (const change of [
      "missing",
      "ring only",
      "null",
      "version 2",
    ] as const) {
      const f = fixture(mode);
      f.parse();
      if (change === "missing")
        Reflect.deleteProperty(f.protocol, "timing_capture");
      if (change === "ring only")
        Reflect.set(f.protocol, "timing_capture", "retained_native_ring_only");
      if (change === "null") Reflect.set(f.protocol, "timing_capture", null);
      if (change === "version 2") Reflect.set(f.protocol, "schema_version", 2);
      f.update();
      expect(() => f.parse()).toThrow();
    }
});

test("benchmark refuses a missing, repeated or relabelled cell rather than claiming a partial cohort as E01", () => {
  for (const change of [
    "missing rate",
    "duplicate row",
    "wrong repetition",
    "reordered",
    "optional",
  ] as const) {
    const f = fixture();
    f.parse();
    if (change === "missing rate")
      f.manifest.schedule = f.manifest.schedule.filter(
        (row) => row.slot.arm !== "hertz_5",
      );
    if (change === "duplicate row")
      f.manifest.schedule[1] = {
        ...f.manifest.schedule[1]!,
        slot: { ...f.manifest.schedule[0]!.slot },
      };
    if (change === "wrong repetition")
      f.manifest.schedule[0]!.slot.repetition = 4;
    if (change === "reordered")
      [f.manifest.schedule[0], f.manifest.schedule[1]] = [
        f.manifest.schedule[1]!,
        f.manifest.schedule[0]!,
      ];
    if (change === "optional") f.manifest.schedule[0]!.optional_block = "skip";
    expect(() => f.parse()).toThrow();
  }
});

test("cohort retains all 27 ordered rate/delay/repetition cells independently of calibration", () => {
  const f = fixture();
  const parsed = f.parse();
  const cells = ([1, 5, 20] as const).flatMap((frequency_hz) =>
    ([15000, 30000, 90000] as const).flatMap((delay_ms) =>
      [1, 2, 3].map((repetition) => ({
        frequency_hz,
        delay_ms,
        repetition,
      })),
    ),
  );
  expect(parsed.cells).toEqual(cells);
  expect(parsed.manifest.schedule).toEqual(
    cells.map((cell, order) => ({
      order,
      group: `delay_${cell.delay_ms}`,
      optional_block: null,
      slot: {
        study_id: f.manifest.study_id,
        arm: `hertz_${cell.frequency_hz}`,
        initial_state_id: `delay_${cell.delay_ms}`,
        repetition: cell.repetition,
      },
    })),
  );
  expect(parsed.manifest.schedule).toHaveLength(27);
});

test("calibration admits only the matched 20Hz/30-second logical repetition-2 cell once without earlier attempts or retries", () => {
  const f = fixture("calibration");
  const parsed = f.parse();
  expect(parsed.protocol.mode).toBe("calibration");
  expect(parsed.cells).toHaveLength(1);
  expect(parsed.cells[0]).toMatchObject({
    frequency_hz: 20,
    delay_ms: 30000,
    repetition: 2,
  });
  const selected = {
    study_id: f.manifest.study_id,
    arm: "hertz_20",
    initial_state_id: "delay_30000",
    repetition: 2,
  };
  expect(parsed.manifest.schedule).toEqual([
    {
      order: 0,
      group: "delay_30000",
      optional_block: null,
      slot: selected,
    },
  ]);
  expect(parsed.manifest.repetitions).toBe(3);
  expect(parsed.manifest.initial_states.map((state) => state.id)).toEqual([
    "delay_30000",
  ]);
  const ledger = new StudyLedger(join(f.root, "governance"), {
    projectRoot: f.root,
  });
  try {
    const ref = ledger.registerStudy(parsed.manifest);
    expect(ledger.readStudy(ref).attempts).toHaveLength(0);
    for (const repetition of [1, 3])
      expect(() =>
        ledger.reserveStudyAttempt(ref, { ...selected, repetition }),
      ).toThrow();
    const reservation = ledger.reserveStudyAttempt(ref, selected);
    expect(reservation.slot).toEqual(selected);
    expect(ledger.readStudy(ref).attempts).toMatchObject([
      { slot: selected, state: "reserved" },
    ]);
    expect(ledger.readStudy(ref).attempts).toHaveLength(1);
    expect(() => ledger.reserveStudyAttempt(ref, selected)).toThrow();
    expect(ledger.readStudy(ref).attempts).toHaveLength(1);
  } finally {
    ledger.close();
  }
  for (const change of [
    "15-second substitute",
    "90-second substitute",
    "obsolete 90-second repetition 3",
    "5Hz substitute",
    "repetition 1",
    "repetition 3",
    "missing row",
    "duplicate row",
    "additional repetition",
    "wrong order",
    "wrong group",
    "extra state",
    "cohort relabel",
  ] as const) {
    const rejected = fixture("calibration");
    if (
      change === "15-second substitute" ||
      change === "90-second substitute" ||
      change === "obsolete 90-second repetition 3"
    ) {
      const state =
        change === "15-second substitute" ? "delay_15000" : "delay_90000";
      rejected.manifest.initial_states[0]!.id = state;
      rejected.manifest.schedule[0]!.slot.initial_state_id = state;
      rejected.manifest.schedule[0]!.group = state;
    }
    if (
      change === "repetition 1" ||
      change === "repetition 3" ||
      change === "obsolete 90-second repetition 3"
    )
      rejected.manifest.schedule[0]!.slot.repetition =
        change === "repetition 1" ? 1 : 3;
    if (change === "5Hz substitute") {
      rejected.manifest.arms[0]!.id = "hertz_5";
      rejected.manifest.schedule[0]!.slot.arm = "hertz_5";
    }
    if (change === "missing row") rejected.manifest.schedule = [];
    if (change === "duplicate row" || change === "additional repetition") {
      rejected.manifest.schedule.push({
        ...structuredClone(rejected.manifest.schedule[0]!),
        order: 1,
      });
      if (change === "additional repetition")
        rejected.manifest.schedule[1]!.slot.repetition = 1;
      rejected.manifest.allowances.cohort.attempt_wall_ms = 600000;
    }
    if (change === "wrong order") rejected.manifest.schedule[0]!.order = 1;
    if (change === "wrong group")
      rejected.manifest.schedule[0]!.group = "delay_90000";
    if (change === "extra state")
      rejected.manifest.initial_states.push({
        ...structuredClone(rejected.manifest.initial_states[0]!),
        id: "delay_90000",
      });
    if (change === "cohort relabel") {
      rejected.protocol.mode = "cohort";
      rejected.update();
    }
    expect(() => rejected.parse()).toThrow();
  }
});

test("prospective E01 admits only the approved 300-second slot within the unchanged three-hour cohort", () => {
  for (const mode of ["cohort", "calibration"] as const) {
    const f = fixture(mode),
      admitted = f.parse();
    expect(admitted.manifest.allowances).toMatchObject({
      per_attempt: { wall_ms: 300000 },
      cohort: {
        attempt_wall_ms: mode === "cohort" ? 8100000 : 300000,
        elapsed_ms: 10800000,
      },
    });
    expect(admitted.manifest.task.horizon_ms).toBe(165000);
    expect(admitted.protocol).toMatchObject({
      root_ms: 165000,
      warmup_ms: 30000,
      measurement_ms: 120000,
    });
    for (const wallMs of [240000, 299999, 300001]) {
      f.manifest.allowances.per_attempt.wall_ms = wallMs;
      f.manifest.allowances.cohort.attempt_wall_ms =
        wallMs * f.manifest.schedule.length;
      expect(() => f.parse()).toThrow();
    }
    f.manifest.allowances.per_attempt.wall_ms = 300000;
    f.manifest.allowances.cohort.attempt_wall_ms =
      300000 * f.manifest.schedule.length - 1;
    expect(() => f.parse()).toThrow();
    f.manifest.allowances.cohort.attempt_wall_ms =
      300000 * f.manifest.schedule.length;
    f.manifest.allowances.cohort.elapsed_ms = 10800001;
    expect(() => f.parse()).toThrow();
  }
});

test("new E01 admission requires 50/100 ms and rejects the superseded 75 ms declaration", () => {
  for (const mode of ["cohort", "calibration"] as const) {
    const f = fixture(mode);
    f.protocol.acceptance = { p95_ms: 50, p99_ms: 100, max_gap_ms: 1000 };
    f.update();
    const admitted = f.parse();
    expect(admitted.cells).toHaveLength(mode === "cohort" ? 27 : 1);
    f.protocol.acceptance.p95_ms = 75;
    f.update();
    expect(() => f.parse()).toThrow();
  }
});

test("benchmark rejects shortened waits, insufficient lifetime/evidence capacity and changed controller identity", () => {
  for (const mode of ["cohort", "calibration"] as const)
    for (const change of [
      "warmup",
      "measurement",
      "root lifetime",
      "protocol root",
      "step",
      "history records",
      "history interval",
      "recording duration",
      "recording frames",
      "storage",
      "pending frames",
      "journal storage",
      "pending journal",
      "controller",
      "provider",
      "workers",
      "relaxed target",
      "relaxed p99",
      "relaxed gap",
    ] as const) {
      const f = fixture(mode);
      if (change === "warmup") f.protocol.warmup_ms = 29999;
      if (change === "measurement") f.protocol.measurement_ms = 119999;
      if (change === "root lifetime") f.manifest.task.horizon_ms = 150000;
      if (change === "protocol root") f.protocol.root_ms = 164999;
      if (change === "step") f.protocol.step_ms = 24;
      if (change === "history records") f.protocol.history_records = 4095;
      if (change === "history interval") f.protocol.history_interval_ms = 2001;
      if (change === "recording duration") f.protocol.recording.maxDurationMs--;
      if (change === "recording frames") f.protocol.recording.maxFrames--;
      if (change === "storage") f.protocol.recording.maxStoredFrameBytes--;
      if (change === "pending frames")
        f.protocol.recording.maxPendingRawBytes--;
      if (change === "journal storage") f.protocol.journal.maxTextBytes--;
      if (change === "pending journal") f.protocol.journal.maxPendingBytes--;
      if (change === "controller")
        f.manifest.identities.controller = {
          ...f.manifest.identities.controller!,
          sha256: "f".repeat(64),
        };
      if (change === "provider")
        f.manifest.allowances.per_attempt.host_requests = 1;
      if (change === "workers") f.manifest.allowances.cohort.workers = 2;
      if (change === "relaxed target") f.protocol.acceptance.p95_ms = 100;
      if (change === "relaxed p99") f.protocol.acceptance.p99_ms = 101;
      if (change === "relaxed gap") f.protocol.acceptance.max_gap_ms = 1001;
      f.update();
      expect(() => f.parse()).toThrow();
    }
});

test("both benchmark modes authenticate protocol bytes and reject even a reauthenticated alternate controller", () => {
  for (const mode of ["cohort", "calibration"] as const) {
    const protocol = fixture(mode);
    writeFileSync(
      join(protocol.root, protocol.manifest.task.verifier.path),
      `${JSON.stringify(protocol.protocol)}\n`,
    );
    expect(() => protocol.parse()).toThrow();

    const controller = fixture(mode);
    const identity = controller.manifest.identities.controller!;
    const source = `${RESIDENT_BENCHMARK_SOURCE}\n`;
    writeFileSync(join(controller.root, identity.path), source);
    identity.sha256 = createHash("sha256").update(source).digest("hex");
    expect(() => controller.parse()).toThrow();
  }
});

test("benchmark rejects unsupported terrain and structure declarations before native admission", () => {
  for (const settings of [
    { level_type: "minecraft:flat" },
    { structures: false },
  ]) {
    const f = fixture();
    Object.assign(f.manifest.initial_states[0]!.settings!, settings);
    expect(() => f.parse()).toThrow(/normal|structures/);
  }
});

test("actual owned world properties are checked and only safe selected settings are retained", () => {
  expect(typeof benchmark.checkResidentBenchmarkWorldProperties).toBe(
    "function",
  );
  const check = benchmark.checkResidentBenchmarkWorldProperties;
  const properties =
    "gamemode=survival\nforce-gamemode=true\ndifficulty=normal\nhardcore=false\nlevel-type=minecraft\\:normal\ngenerate-structures=true\nlevel-seed=PRIVATE\nrcon.password=SECRET\n";
  expect(check(properties)).toEqual({
    gamemode: "survival",
    "force-gamemode": "true",
    difficulty: "normal",
    hardcore: "false",
    "level-type": "minecraft:normal",
    "generate-structures": "true",
  });
  expect(() =>
    check(
      properties.replace(
        "generate-structures=true",
        "generate-structures=false",
      ),
    ),
  ).toThrow();
  expect(() =>
    check(properties.replace("minecraft\\:normal", "minecraft\\:flat")),
  ).toThrow();
  expect(() => check(`${properties}difficulty=peaceful\n`)).toThrow();
});

test("decision-window latency includes a final slow confirmed ACK received after the window", () => {
  expect(typeof benchmark.residentBenchmarkDecisionPopulation).toBe("function");
  const population = benchmark.residentBenchmarkDecisionPopulation({
    start: 100,
    end: 200,
    submissions: [
      {
        host_ms: 110,
        captured_host_ms: 105,
        frame_seq: 1,
        result: { sequence: 1, status: "submitted", reason: null },
      },
      {
        host_ms: 195,
        captured_host_ms: 190,
        frame_seq: 2,
        result: { sequence: 2, status: "submitted", reason: null },
      },
      {
        host_ms: 205,
        captured_host_ms: 205,
        frame_seq: 3,
        result: { sequence: 3, status: "submitted", reason: null },
      },
    ],
    acks: [
      {
        received_host_ms: 115,
        age_ms: 10,
        ack: { sequence: 1, input_application: "confirmed" },
      },
      {
        received_host_ms: 250,
        age_ms: 120,
        ack: { sequence: 2, input_application: "confirmed" },
      },
      {
        received_host_ms: 210,
        age_ms: 5,
        ack: { sequence: 3, input_application: "confirmed" },
      },
    ],
    terminalReason: "benchmark_full_original_window_completed",
  });
  expect(population.input_age_ms).toMatchObject({
    count: 2,
    p95: 120,
    p99: 120,
    max: 120,
    omitted_samples: 0,
  });
  expect(population.confirmed_after_window).toBe(1);
  expect(population.decisions.map((row) => row.disposition)).toEqual([
    "confirmed",
    "confirmed",
  ]);
});

test("evaluator settlement waits for the last measured ACK without admitting a post-window decision", async () => {
  const acks: Array<{
    received_host_ms: number;
    age_ms: number;
    ack: { sequence: number; input_application: "confirmed" };
  }> = [];
  const read = () =>
    benchmark.residentBenchmarkDecisionPopulation({
      start: 100,
      end: 200,
      terminalReason: null,
      frames: [
        { frame_seq: 7, captured_host_ms: 150 },
        { frame_seq: 8, captured_host_ms: 201 },
      ],
      submissions: [
        {
          frame_seq: 7,
          captured_host_ms: 150,
          host_ms: 160,
          result: { sequence: 11, status: "submitted", reason: null },
        },
        {
          frame_seq: 8,
          captured_host_ms: 201,
          host_ms: 211,
          result: { sequence: 12, status: "submitted", reason: null },
        },
      ],
      acks,
    });
  const timer = setTimeout(
    () =>
      acks.push({
        received_host_ms: 300,
        age_ms: 120,
        ack: { sequence: 11, input_application: "confirmed" },
      }),
    15,
  );
  try {
    const settled = await benchmark.settleResidentBenchmarkMeasuredInputs(
      read,
      {
        signal: new AbortController().signal,
        deadline_host_ms: performance.now() + 1000,
        current: () => true,
      },
    );
    expect(settled).toMatchObject({
      admitted_decisions: 1,
      confirmed_decisions: 1,
      unconfirmed_decisions: 0,
      confirmed_after_window: 1,
      input_age_ms: { count: 1, p95: 120, max: 120 },
    });
    expect(settled.decisions.map((row) => row.frame_seq)).toEqual([7]);
  } finally {
    clearTimeout(timer);
  }
});

test("user Stop aborts measured-frontier waiting instead of waiting for an application or the root deadline", async () => {
  const controller = new AbortController(),
    stop = new Error("Actual user Stop");
  const read = () =>
    benchmark.residentBenchmarkDecisionPopulation({
      start: 100,
      end: 200,
      terminalReason: null,
      submissions: [
        {
          frame_seq: 7,
          captured_host_ms: 150,
          host_ms: 160,
          result: { sequence: 11, status: "submitted", reason: null },
        },
      ],
      acks: [],
    });
  const timer = setTimeout(() => controller.abort(stop), 15);
  try {
    await expect(
      benchmark.settleResidentBenchmarkMeasuredInputs(read, {
        signal: controller.signal,
        deadline_host_ms: performance.now() + 1000,
        current: () => true,
      }),
    ).rejects.toBe(stop);
  } finally {
    clearTimeout(timer);
  }
});

test("a confirmed measured population cannot revive an expired or no-longer-current root", async () => {
  const read = () =>
    benchmark.residentBenchmarkDecisionPopulation({
      start: 100,
      end: 200,
      terminalReason: null,
      submissions: [
        {
          frame_seq: 7,
          captured_host_ms: 150,
          host_ms: 160,
          result: { sequence: 11, status: "submitted", reason: null },
        },
      ],
      acks: [
        {
          received_host_ms: 190,
          age_ms: 30,
          ack: { sequence: 11, input_application: "confirmed" },
        },
      ],
    });
  for (const root of [
    { deadline_host_ms: performance.now() - 1, current: () => true },
    { deadline_host_ms: performance.now() + 1000, current: () => false },
  ]) {
    await expect(
      benchmark.settleResidentBenchmarkMeasuredInputs(read, {
        signal: new AbortController().signal,
        ...root,
      }),
    ).rejects.toThrow();
  }
});

test("confirmed settlement cannot cross the original deadline inside synchronous authority or population reads", async () => {
  const confirmed = () =>
    benchmark.residentBenchmarkDecisionPopulation({
      start: 100,
      end: 200,
      terminalReason: null,
      submissions: [
        {
          frame_seq: 7,
          captured_host_ms: 150,
          host_ms: 160,
          result: { sequence: 11, status: "submitted", reason: null },
        },
      ],
      acks: [
        {
          received_host_ms: 190,
          age_ms: 30,
          ack: { sequence: 11, input_application: "confirmed" },
        },
      ],
    });
  for (const slow of ["authority", "population"]) {
    const deadline = performance.now() + 25;
    const cross = () =>
      Bun.sleepSync(Math.max(0, deadline - performance.now() + 2));
    await expect(
      benchmark.settleResidentBenchmarkMeasuredInputs(
        () => {
          if (slow === "population") cross();
          return confirmed();
        },
        {
          signal: new AbortController().signal,
          deadline_host_ms: deadline,
          current: () => {
            if (slow === "authority") cross();
            return true;
          },
        },
      ),
    ).rejects.toThrow();
  }
});

test("an abort during a confirmed population read remains Stop rather than normal completion", async () => {
  const controller = new AbortController(),
    stop = new Error("Stop during reconstruction");
  await expect(
    benchmark.settleResidentBenchmarkMeasuredInputs(
      () => {
        controller.abort(stop);
        return benchmark.residentBenchmarkDecisionPopulation({
          start: 100,
          end: 200,
          terminalReason: null,
          submissions: [
            {
              frame_seq: 7,
              captured_host_ms: 150,
              host_ms: 160,
              result: { sequence: 11, status: "submitted", reason: null },
            },
          ],
          acks: [
            {
              received_host_ms: 190,
              age_ms: 30,
              ack: { sequence: 11, input_application: "confirmed" },
            },
          ],
        });
      },
      {
        signal: controller.signal,
        deadline_host_ms: performance.now() + 1000,
        current: () => true,
      },
    ),
  ).rejects.toBe(stop);
});

test("native scope loss rejects frontier settlement while resident status is still running", async () => {
  const binding = minecraftTestBinding(minecraftTestAdapter());
  const state: GameState = {
    status: "connected",
    username: "fixture",
    version: "1.21.4",
    world_id: "world",
    epoch: 1,
    session_id: "session",
    life: { life_id: 1, status: "alive", can_respawn: false, death: null },
    binding,
    space: { dimension_id: "minecraft:overworld", space_epoch: 1 },
    screen: null,
    presentation: null,
    video: {
      status: "idle",
      width: 0,
      height: 0,
      fps: null,
      frames: 0,
      last_frame_at: null,
      error: null,
    },
    last_observation_at: null,
    error: null,
  };
  const scope = {
    world_id: "world",
    session_id: "session",
    native_boot_id: "fixture-native-boot",
    epoch: 1,
    life_id: 1,
    space_epoch: 1,
  };
  expect(benchmark.residentBenchmarkNativeScopeCurrent(state, scope)).toBe(
    true,
  );
  await expect(
    benchmark.settleResidentBenchmarkMeasuredInputs(
      () => {
        state.space = { dimension_id: "minecraft:overworld", space_epoch: 2 };
        return benchmark.residentBenchmarkDecisionPopulation({
          start: 100,
          end: 200,
          terminalReason: null,
          submissions: [
            {
              frame_seq: 7,
              captured_host_ms: 150,
              host_ms: 160,
              result: { sequence: 11, status: "submitted", reason: null },
            },
          ],
          acks: [
            {
              received_host_ms: 190,
              age_ms: 30,
              ack: { sequence: 11, input_application: "confirmed" },
            },
          ],
        });
      },
      {
        signal: new AbortController().signal,
        deadline_host_ms: performance.now() + 1000,
        current: () =>
          benchmark.residentBenchmarkNativeScopeCurrent(state, scope),
      },
    ),
  ).rejects.toThrow();
  const invalidStates: GameState[] = [
    {
      ...state,
      space: { dimension_id: "minecraft:overworld", space_epoch: 1 },
      world_id: "other",
    },
    {
      ...state,
      space: { dimension_id: "minecraft:overworld", space_epoch: 1 },
      session_id: "other",
    },
    {
      ...state,
      space: { dimension_id: "minecraft:overworld", space_epoch: 1 },
      epoch: 2,
    },
    {
      ...state,
      space: { dimension_id: "minecraft:overworld", space_epoch: 1 },
      binding: minecraftTestBinding(minecraftTestAdapter(), "other-boot"),
    },
    {
      ...state,
      space: { dimension_id: "minecraft:overworld", space_epoch: 1 },
      life: { life_id: 2, status: "alive", can_respawn: false, death: null },
    },
    {
      ...state,
      space: { dimension_id: "minecraft:overworld", space_epoch: 1 },
      binding: null,
    },
    {
      ...state,
      space: { dimension_id: "minecraft:overworld", space_epoch: 1 },
      error: "transport failure",
    },
  ];
  for (const invalid of invalidStates)
    expect(benchmark.residentBenchmarkNativeScopeCurrent(invalid, scope)).toBe(
      false,
    );
});

test("terminal decisions retain censoring, partial, unknown, refused and coalesced dispositions", () => {
  expect(typeof benchmark.residentBenchmarkDecisionPopulation).toBe("function");
  const population = benchmark.residentBenchmarkDecisionPopulation({
    start: 100,
    end: 200,
    submissions: [
      {
        host_ms: 110,
        captured_host_ms: 105,
        frame_seq: 1,
        result: { sequence: 1, status: "submitted", reason: null },
      },
      {
        host_ms: 120,
        captured_host_ms: 115,
        frame_seq: 2,
        result: { sequence: 2, status: "coalesced", reason: null },
      },
      {
        host_ms: 130,
        captured_host_ms: 125,
        frame_seq: 3,
        result: { sequence: 3, status: "submitted", reason: null },
      },
      {
        host_ms: 140,
        captured_host_ms: 135,
        frame_seq: 4,
        result: { sequence: 4, status: "submitted", reason: null },
      },
      {
        host_ms: 150,
        captured_host_ms: 145,
        frame_seq: 5,
        result: { sequence: 4, status: "rejected", reason: "fenced" },
      },
    ],
    acks: [
      {
        received_host_ms: 140,
        age_ms: null,
        ack: { sequence: 2, input_application: "partial" },
      },
      {
        received_host_ms: 150,
        age_ms: null,
        ack: { sequence: 3, input_application: "unknown" },
      },
    ],
    terminalReason: "benchmark_full_original_window_completed",
  });
  expect(population.decisions.map((row) => row.disposition)).toEqual([
    "coalesced",
    "partial",
    "unknown",
    "terminal_censored",
    "refused",
  ]);
  expect(population).toMatchObject({
    admitted_decisions: 5,
    confirmed_decisions: 0,
    unconfirmed_decisions: 5,
    full_population_confirmed: false,
    input_age_ms: { count: 0, omitted_samples: 5 },
  });
  expect(population.decisions[3]).toMatchObject({
    terminal_reason: "benchmark_full_original_window_completed",
  });
});

test("a measured frame cancelled during worker evaluation remains an explicit unsubmitted decision", () => {
  expect(typeof benchmark.residentBenchmarkDecisionPopulation).toBe("function");
  const population = benchmark.residentBenchmarkDecisionPopulation({
    start: 100,
    end: 200,
    submissions: [],
    acks: [],
    frames: [{ frame_seq: 7, captured_host_ms: 190 }],
    terminalReason: "benchmark_full_original_window_completed",
  });
  expect(population).toMatchObject({
    admitted_decisions: 1,
    unconfirmed_decisions: 1,
    full_population_confirmed: false,
    input_age_ms: { count: 0, omitted_samples: 1 },
  });
  expect(population.decisions[0]).toMatchObject({
    frame_seq: 7,
    result: null,
    disposition: "terminal_censored",
    terminal_reason: "benchmark_full_original_window_completed",
    age_ms: null,
  });
});

test("E01 background history reads the genuine complete 4096-row corpus and program evidence in its owned readonly child", async () => {
  const f = historyFixture();
  const reader = new HistoryReader(f.store.readLocation());
  const deadlineHostMs = performance.now() + 10_000;
  const loadAbort = new AbortController();
  try {
    const skill = await f.store.registerSkill(f.run.run_id, historySpec(f.run));
    const execution = historyExecution(f.store, f.run, skill);
    finishHistoryExecution(f.store, execution);
    const existingEvents = f.store.eventsAfter(f.run.run_id, 0, 500).length;
    f.store.appendEvents(f.run.run_id, Array.from({ length: 4096 }, (_, index) => ({
      type: "benchmark.evaluator_history",
      summary: "Nonplaying evaluator-only history load",
      details: { index },
    })));
    const expected = {
      events: existingEvents + 4096,
      program_evidence: programEvidence(f.store, f.run.run_id),
      programs: f.store.skills(f.run.run_id),
    };
    expect(expected.events).toBeGreaterThanOrEqual(4096);
    expect(expected.program_evidence).toHaveLength(1);
    expect(expected.programs).toHaveLength(1);
    // These writer-side projections must not be the benchmark's read backend.
    const original = {
      eventsAfter: f.store.eventsAfter,
      allSkillExecutions: f.store.allSkillExecutions,
      skills: f.store.skills,
    };
    f.store.eventsAfter = () => { throw new Error("Parent synchronous event history invoked"); };
    f.store.allSkillExecutions = () => { throw new Error("Parent synchronous evidence history invoked"); };
    f.store.skills = () => { throw new Error("Parent synchronous program history invoked"); };
    try {
      const result = await reader.query({
        kind: "benchmark_history", run_id: f.run.run_id, minimum_records: 4096,
      }, { signal: loadAbort.signal, deadlineHostMs });
      expect(result).toEqual(expected);
      expect(reader.snapshot()).toMatchObject({ active: false, queued: 0, closed: false });
      expect(reader.snapshot().child?.pid).toBeGreaterThan(0);
    } finally {
      Object.assign(f.store, original);
    }
  } finally {
    loadAbort.abort();
    await reader.close();
    const owner = reader.snapshot();
    f.close();
    expect(owner).toMatchObject({ closed: true, active: false, queued: 0 });
    expect(owner.child?.exitObservedHostMs).toBeNumber();
    expect(owner.child?.stdoutDrainObservedHostMs).toBeNumber();
    expect(owner.child?.closedHostMs).toBeNumber();
  }
});

test("E01 compound history refuses an incomplete original corpus rather than returning empty evidence as success", async () => {
  const f = historyFixture();
  const reader = new HistoryReader(f.store.readLocation());
  try {
    await expect(reader.query({
      kind: "benchmark_history", run_id: f.run.run_id, minimum_records: 4096,
    }, { deadlineHostMs: performance.now() + 10_000 })).rejects.toMatchObject({ code: "conflict" });
  } finally {
    await reader.close();
    f.close();
  }
});
