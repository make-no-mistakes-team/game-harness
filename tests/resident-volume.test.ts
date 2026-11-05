import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_RESIDENT_BENCHMARK_PROTOCOL,
  RESIDENT_BENCHMARK_SOURCE,
  residentBenchmarkSchedule,
  validateResidentBenchmarkDeclaration,
} from "../src/evaluation/resident-benchmark.ts";
import {
  P13_VOLUME_ACTIONS,
  p13VolumeProtocolSchema,
  residentTimingSchedule,
  residentTimingWorkflowBounds,
  residentVolumeCleanupConfirmed,
  validateResidentTimingAssay,
  type P13VolumeProtocol,
} from "../src/evaluation/resident-volume.ts";
import { StudyLedger } from "../src/evaluation/studies.ts";
import { studyManifest } from "./helpers/study-manifest.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

// Finite local declaration bytes only; neither this grant nor any fixture is
// submitted to a native owner, provider or game process by these tests.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "gameharness-resident-volume-"));
  roots.push(root);
  const manifest = studyManifest(root, "p13-volume-boundary");
  const checked = (path: string, text: string) => {
    writeFileSync(join(root, path), text);
    return { path, sha256: createHash("sha256").update(text).digest("hex") };
  };
  const authority = {
    schema_version: 1,
    authorization:
      "Synthetic finite assay grant for local validator tests; no execution authority.",
    allowed_volumes: [30, 300, 3000, 10000, 60000],
    native_slots_max: 5,
    automatic_retries: false,
    full27_e01_authorized: false,
    llm_jev_allowed: false,
    audio_allowed: false,
    selected_control_hz: 20,
    warmup_ms: 30000,
    measurement_ms: 120000,
    root_ms: 165000,
    slot_ms: 300000,
    overall_cleanup_reserve_ms: 25000,
    series_ms: 10800000,
    workflow_started_wall_ns: "1700000000123456789",
    workflow_started_monotonic_ns: "1000000000000",
    workflow_deadline_wall_ns: "1700010800123456789",
    workflow_deadline_monotonic_ns: "11800000000000",
    deadline_policy:
      "Synthetic fixed wall and monotonic deadlines include preparation and playback.",
  };
  const grant = checked("authority.json", JSON.stringify(authority));
  const protocol: P13VolumeProtocol = {
    ...structuredClone(DEFAULT_RESIDENT_BENCHMARK_PROTOCOL),
    schema_version: 4,
    mode: "p13_volume",
    volume_actions: [30, 300, 3000, 10000, 60000],
    workload: {
      corpus: "raw_admitted_terminal_owned_actions",
      initial_projection: "measurement_only",
      late_update_offsets_ms: [20000, 40000, 60000, 80000, 100000],
      sample_interval_ms: 2000,
      memory_interval_ms: 1000,
      raw_seed_actions_per_turn: 16,
      page_limit: 8,
      feedback_limit: 16,
    },
    workflow: {
      authority: grant,
      started_epoch_ms: 1700000000123,
      deadline_epoch_ms: 1700010800123,
      started_monotonic_ns: "1000000000000",
      deadline_monotonic_ns: "11800000000000",
      includes_preparation_and_playback: true,
    },
  };
  manifest.admission_mode = "live";
  manifest.permission = {
    record: grant,
    scope: "live",
    granted_by: "local-declaration-fixture",
  };
  manifest.identities.adapter = "fabric-owned-client";
  manifest.identities.game = { id: "minecraft", version: "1.21.4" };
  manifest.identities.controller = checked(
    "controller.mjs",
    RESIDENT_BENCHMARK_SOURCE,
  );
  manifest.identities.model = null;
  manifest.task.horizon_ms = 165000;
  manifest.execution = {
    ...manifest.execution,
    start_mode: "evaluator_prepared_world",
    adaptation: "none",
    controller_mode: "resident_platform",
    request_paths: [],
  };
  const states = (ids: string[]) =>
    ids.map((id) => ({
      id,
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
  const arms = (rates: number[]) =>
    rates.map((rate) => ({
      id: `hertz_${rate}`,
      description: "Evaluator-only mechanical fixture",
      model: null,
      helpers: [],
      profile: manifest.identities.profile,
    }));
  manifest.arms = arms([20]);
  manifest.initial_states = states(
    P13_VOLUME_ACTIONS.map((actions) => `history_actions_${actions}`),
  );
  manifest.repetitions = 3;
  manifest.optional_blocks = [];
  manifest.schedule = residentTimingSchedule(manifest.study_id, protocol);
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
      attempt_wall_ms: 1500000,
      elapsed_ms: 10800000,
    },
  };
  const update = () => {
    manifest.task.verifier = checked("protocol.json", JSON.stringify(protocol));
  };
  const updateAuthority = () => {
    manifest.permission.record = checked(
      "authority.json",
      JSON.stringify(authority),
    );
    protocol.workflow.authority = manifest.permission.record;
    update();
  };
  const useE01 = (mode: "cohort" | "calibration") => {
    const e01 = {
      ...structuredClone(DEFAULT_RESIDENT_BENCHMARK_PROTOCOL),
      mode,
    };
    manifest.arms = arms(mode === "cohort" ? [1, 5, 20] : [20]);
    manifest.initial_states = states(
      (mode === "cohort" ? [15000, 30000, 90000] : [30000]).map(
        (delay) => `delay_${delay}`,
      ),
    );
    manifest.schedule = residentBenchmarkSchedule(manifest.study_id, mode);
    manifest.allowances.cohort.attempt_wall_ms =
      manifest.schedule.length * 300000;
    const write = () => {
      manifest.task.verifier = checked("protocol.json", JSON.stringify(e01));
    };
    write();
    return { protocol: e01, update: write };
  };
  update();
  return {
    root,
    manifest,
    protocol,
    authority,
    checked,
    update,
    updateAuthority,
    useE01,
    parse: () => validateResidentTimingAssay(manifest, { projectRoot: root }),
  };
}

test("P13 v4 admits only the five finite volumes as 20Hz/30-second repetition-2 cells", () => {
  const f = fixture();
  const validated = f.parse();
  expect(validated.assay).toBe("p13_volume");
  expect(validated.protocol).toEqual(f.protocol);
  expect(validated.source).toBe(RESIDENT_BENCHMARK_SOURCE);
  expect(validated.cells).toEqual(
    [30, 300, 3000, 10000, 60000].map((actions) => ({
      frequency_hz: 20,
      delay_ms: 30000,
      repetition: 2,
      actions,
    })),
  );
  expect(validated.manifest.schedule).toEqual(
    [30, 300, 3000, 10000, 60000].map((actions, order) => ({
      slot: {
        study_id: f.manifest.study_id,
        arm: "hertz_20",
        initial_state_id: `history_actions_${actions}`,
        repetition: 2,
      },
      order,
      group: `history_actions_${actions}`,
      optional_block: null,
    })),
  );
  expect(validated.manifest.repetitions).toBe(3);
  expect(residentTimingWorkflowBounds(validated.protocol)).toEqual({
    deadlineEpochMs: 1700010800123,
    deadlineMonotonicNs: 11800000000000n,
  });
});

test("P13 refuses changed volumes, order, schedule labels and extra cells without native admission", () => {
  for (const change of [
    "volume",
    "volume order",
    "missing volume",
    "extra volume",
    "missing cell",
    "extra cell",
    "reordered",
    "repetition",
    "group",
    "optional",
    "arm",
    "state order",
    "repetitions",
  ] as const) {
    const f = fixture();
    if (change === "volume") Reflect.set(f.protocol.volume_actions, 0, 31);
    if (change === "volume order") f.protocol.volume_actions.reverse();
    if (change === "missing volume") f.protocol.volume_actions.pop();
    if (change === "extra volume") f.protocol.volume_actions.push(60000);
    if (change === "missing cell") f.manifest.schedule.pop();
    if (change === "extra cell")
      f.manifest.schedule.push({
        ...f.manifest.schedule[4]!,
        order: 5,
        slot: { ...f.manifest.schedule[4]!.slot, repetition: 3 },
      });
    if (change === "reordered") {
      [f.manifest.schedule[0], f.manifest.schedule[1]] = [
        f.manifest.schedule[1]!,
        f.manifest.schedule[0]!,
      ];
      f.manifest.schedule.forEach((row, order) => {
        row.order = order;
      });
    }
    if (change === "repetition") f.manifest.schedule[0]!.slot.repetition = 1;
    if (change === "group") f.manifest.schedule[0]!.group = "delay_30000";
    if (change === "optional") f.manifest.schedule[0]!.optional_block = "retry";
    if (change === "arm") f.manifest.arms[0]!.id = "hertz_5";
    if (change === "state order") f.manifest.initial_states.reverse();
    if (change === "repetitions") f.manifest.repetitions = 2;
    f.update();
    expect(() => f.parse()).toThrow();
  }
});

test("P13 refuses altered workload or fields that would prepare projection outside measurement", () => {
  for (const [field, value] of [
    ["corpus", "synthetic_projection"],
    ["initial_projection", "warmup"],
    ["late_update_offsets_ms", [20000, 40000, 60000, 80000]],
    ["late_update_offsets_ms", [20000, 40000, 60000, 80000, 100001]],
    ["sample_interval_ms", 4000],
    ["memory_interval_ms", 2000],
    ["raw_seed_actions_per_turn", 32],
    ["page_limit", 9],
    ["feedback_limit", 17],
    ["automatic_retries", true],
  ] as const) {
    const f = fixture();
    Reflect.set(f.protocol.workload, field, value);
    f.update();
    expect(() => f.parse()).toThrow();
  }
  const f = fixture();
  Reflect.set(f.protocol, "optional_retry", true);
  expect(() => p13VolumeProtocolSchema.parse(f.protocol)).toThrow();
});

test("the original five-slot grant is checked by identity and complete contents, not its label", () => {
  for (const [field, value] of [
    ["schema_version", 2],
    ["authorization", ""],
    ["authorization", "x".repeat(4097)],
    ["allowed_volumes", [30, 300, 3000, 10000]],
    ["native_slots_max", 6],
    ["automatic_retries", true],
    ["full27_e01_authorized", true],
    ["llm_jev_allowed", true],
    ["audio_allowed", true],
    ["selected_control_hz", 5],
    ["warmup_ms", 1000],
    ["measurement_ms", 1000],
    ["root_ms", 180000],
    ["slot_ms", 600000],
    ["overall_cleanup_reserve_ms", 0],
    ["series_ms", 21600000],
    ["workflow_started_wall_ns", "1700000000123456790"],
    ["workflow_deadline_wall_ns", "1700010800123456790"],
    ["workflow_started_monotonic_ns", "1000000000001"],
    ["workflow_deadline_monotonic_ns", "11800000000001"],
    ["deadline_policy", ""],
    ["deadline_policy", "x".repeat(4097)],
    ["extra_authority", true],
  ] as const) {
    const f = fixture();
    Reflect.set(f.authority, field, value);
    f.updateAuthority();
    expect(() => f.parse()).toThrow();
  }
  const f = fixture();
  f.protocol.workflow.authority = f.checked(
    "other-authority.json",
    JSON.stringify(f.authority),
  );
  f.update();
  expect(() => f.parse()).toThrow("original checked permission");
});

test("P13 preserves both original clocks and conservative wall-ms derivation", () => {
  for (const [field, value] of [
    ["started_epoch_ms", 1700000000124],
    ["deadline_epoch_ms", 1700010800124],
    ["started_monotonic_ns", "1000000000001"],
    ["deadline_monotonic_ns", "11800000000001"],
    ["started_monotonic_ns", "+1000000000000"],
    ["deadline_monotonic_ns", "011800000000000"],
    ["includes_preparation_and_playback", false],
    ["registered_epoch_ms", 1700000000123],
  ] as const) {
    const f = fixture();
    Reflect.set(f.protocol.workflow, field, value);
    f.update();
    expect(() => f.parse()).toThrow();
  }
  const f = fixture();
  f.protocol.workflow.started_epoch_ms += 1000;
  f.protocol.workflow.deadline_epoch_ms += 1000;
  f.protocol.workflow.started_monotonic_ns = String(
    BigInt(f.protocol.workflow.started_monotonic_ns) + 1000000000n,
  );
  f.protocol.workflow.deadline_monotonic_ns = String(
    BigInt(f.protocol.workflow.deadline_monotonic_ns) + 1000000000n,
  );
  f.update();
  expect(() => f.parse()).toThrow();
  // Only an actual replacement of the checked permission file can authorize
  // another clock pair; changing the protocol alone cannot renew authority.
  f.authority.workflow_started_wall_ns = String(
    BigInt(f.authority.workflow_started_wall_ns) + 1000000000n,
  );
  f.authority.workflow_deadline_wall_ns = String(
    BigInt(f.authority.workflow_deadline_wall_ns) + 1000000000n,
  );
  f.authority.workflow_started_monotonic_ns =
    f.protocol.workflow.started_monotonic_ns;
  f.authority.workflow_deadline_monotonic_ns =
    f.protocol.workflow.deadline_monotonic_ns;
  f.authority.authorization =
    "Another synthetic operator-controlled test grant.";
  f.authority.deadline_policy = "Another synthetic fixed-pair policy.";
  f.updateAuthority();
  expect(f.parse().assay).toBe("p13_volume");
});

test("later real study registration never renews the earlier P13 workflow authority", () => {
  const f = fixture();
  const original = f.parse();
  const ledger = new StudyLedger(join(f.root, "governance"), {
    projectRoot: f.root,
  });
  try {
    const ref = ledger.registerStudy(original.manifest);
    const registered = ledger.readStudy(ref);
    expect(registered.registeredAt).toBeGreaterThan(
      original.protocol.mode === "p13_volume"
        ? original.protocol.workflow.started_epoch_ms
        : Infinity,
    );
    const revalidated = validateResidentTimingAssay(registered.manifest, {
      projectRoot: f.root,
    });
    expect(residentTimingWorkflowBounds(revalidated.protocol)).toEqual(
      residentTimingWorkflowBounds(original.protocol),
    );
    f.protocol.workflow.started_epoch_ms = registered.registeredAt;
    f.protocol.workflow.deadline_epoch_ms = registered.registeredAt + 10800000;
    f.update();
    expect(() => f.parse()).toThrow();
  } finally {
    ledger.close();
  }
});

test("P13 retains every E01 timing, load, acceptance and evidence bound", () => {
  for (const [field, value] of [
    ["warmup_ms", 29999],
    ["measurement_ms", 119999],
    ["root_ms", 165001],
    ["step_ms", 26],
    ["history_records", 4095],
    ["history_interval_ms", 2001],
    ["timing_capture", "retained_native_ring_only"],
    ["measured_frontier", "after_root"],
    ["acceptance", { p95_ms: 51, p99_ms: 100, max_gap_ms: 1000 }],
    ["acceptance", { p95_ms: 50, p99_ms: 101, max_gap_ms: 1000 }],
    ["acceptance", { p95_ms: 50, p99_ms: 100, max_gap_ms: 1001 }],
  ] as const) {
    const f = fixture();
    Reflect.set(f.protocol, field, value);
    f.update();
    expect(() => f.parse()).toThrow();
  }
  for (const field of Object.keys(
    DEFAULT_RESIDENT_BENCHMARK_PROTOCOL.recording,
  )) {
    const f = fixture();
    Reflect.set(
      f.protocol.recording,
      field,
      Number(Reflect.get(f.protocol.recording, field)) - 1,
    );
    f.update();
    expect(() => f.parse()).toThrow();
  }
  for (const field of Object.keys(
    DEFAULT_RESIDENT_BENCHMARK_PROTOCOL.journal,
  )) {
    const f = fixture();
    Reflect.set(
      f.protocol.journal,
      field,
      Number(Reflect.get(f.protocol.journal, field)) - 1,
    );
    f.update();
    expect(() => f.parse()).toThrow();
  }
});

test("P13 preserves zero-provider allowances, exact slot bounds, prepared inventory and profile", () => {
  for (const change of [
    "provider",
    "model",
    "arm model",
    "sidecar",
    "adaptation",
    "worker",
    "slot",
    "root",
    "series",
    "total",
    "fresh",
    "level",
    "structures",
    "inventory",
    "profile",
    "source",
  ] as const) {
    const f = fixture();
    if (change === "provider") f.manifest.execution.request_paths = ["jev"];
    if (change === "model" || change === "arm model") {
      const model = {
        provider: "openai-codex",
        id: "fixture-only",
        api: "openai-codex-responses",
        access: "oauth_subscription",
      };
      if (change === "model") f.manifest.identities.model = model;
      else f.manifest.arms[0]!.model = model;
    }
    if (change === "sidecar") f.manifest.execution.sidecars = ["jev"];
    if (change === "adaptation")
      f.manifest.execution.adaptation = "whole_agent_run_private";
    if (change === "worker") f.manifest.allowances.cohort.workers = 2;
    if (change === "slot") f.manifest.allowances.per_attempt.wall_ms = 299999;
    if (change === "root") f.manifest.task.horizon_ms = 165001;
    if (change === "series") f.manifest.allowances.cohort.elapsed_ms = 10800001;
    if (change === "total")
      f.manifest.allowances.cohort.attempt_wall_ms = 1500001;
    if (change === "fresh")
      f.manifest.initial_states[0]!.settings!.fresh_world_per_slot = false;
    if (change === "level")
      f.manifest.initial_states[0]!.settings!.level_type = "minecraft:flat";
    if (change === "structures")
      f.manifest.initial_states[0]!.settings!.structures = false;
    if (change === "inventory")
      f.manifest.initial_states[0]!.settings!.supplied_inventory = false;
    if (change === "profile")
      f.manifest.identities.profile = f.checked(
        "profile.json",
        JSON.stringify({ profile: "labels-only" }),
      );
    if (change === "source")
      f.manifest.identities.controller = f.checked(
        "controller.mjs",
        `${RESIDENT_BENCHMARK_SOURCE}\n`,
      );
    expect(() => f.parse()).toThrow();
  }
});

test("generic identity validation rejects changed protocol, authority, source and incomplete inventories", () => {
  for (const change of [
    "protocol",
    "authority",
    "source",
    "build",
    "dependencies",
    "profile",
    "new source",
    "missing source",
  ] as const) {
    const f = fixture();
    if (change === "protocol")
      writeFileSync(
        join(f.root, "protocol.json"),
        `${JSON.stringify(f.protocol)}\n`,
      );
    if (change === "authority")
      writeFileSync(
        join(f.root, "authority.json"),
        `${JSON.stringify(f.authority)}\n`,
      );
    if (change === "source")
      writeFileSync(
        join(f.root, "controller.mjs"),
        `${RESIDENT_BENCHMARK_SOURCE}\n`,
      );
    if (change === "build")
      writeFileSync(
        join(f.root, f.manifest.identities.build.path),
        "changed build",
      );
    if (change === "dependencies")
      writeFileSync(
        join(f.root, f.manifest.identities.dependencies.path),
        "changed dependencies",
      );
    if (change === "profile")
      writeFileSync(
        join(f.root, f.manifest.identities.profile.path),
        "changed profile",
      );
    if (change === "new source")
      writeFileSync(
        join(f.root, "src/new-module.ts"),
        "export const changed = true;\n",
      );
    if (change === "missing source") f.manifest.identities.source = [];
    expect(() => f.parse()).toThrow();
  }
});

test("E01 cohort/calibration delegation remains exact and cannot admit P13 declarations", () => {
  for (const mode of ["cohort", "calibration"] as const) {
    const f = fixture();
    const e01 = f.useE01(mode);
    const delegated = f.parse();
    const unchanged = validateResidentBenchmarkDeclaration(f.manifest, {
      projectRoot: f.root,
    });
    expect(delegated).toEqual({ assay: "e01", ...unchanged });
    expect(
      residentTimingSchedule(f.manifest.study_id, delegated.protocol),
    ).toEqual(residentBenchmarkSchedule(f.manifest.study_id, mode));
    expect(residentTimingWorkflowBounds(delegated.protocol)).toBeNull();
    expect(delegated.cells).toHaveLength(mode === "cohort" ? 27 : 1);
    Reflect.set(e01.protocol, "volume_actions", [30, 300, 3000, 10000, 60000]);
    e01.update();
    expect(() => f.parse()).toThrow();
  }
  const f = fixture();
  expect(() =>
    validateResidentBenchmarkDeclaration(f.manifest, { projectRoot: f.root }),
  ).toThrow();
  for (const mode of ["cohort", "calibration"] as const) {
    Reflect.set(f.protocol, "mode", mode);
    f.update();
    expect(() => f.parse()).toThrow();
  }
});

test("dispatcher never broadens E01 bounds when routing the unchanged validator", () => {
  for (const mode of ["cohort", "calibration"] as const)
    for (const [field, value] of [
      ["warmup_ms", 29999],
      ["measurement_ms", 119999],
      ["root_ms", 165001],
      ["history_records", 4095],
      ["history_interval_ms", 1999],
      ["step_ms", 24],
    ] as const) {
      const f = fixture();
      const e01 = f.useE01(mode);
      Reflect.set(e01.protocol, field, value);
      e01.update();
      expect(() => f.parse()).toThrow();
    }
});

test("P13 cleanup requires every owner receipt and actual child exit/stdout drain", () => {
  const completed = () => ({
    closed: true,
    learning_closed: true,
    reader_closed: true,
    tasks_joined: true,
    reader_owner: {
      closed: true,
      active: false,
      queued: 0,
      child: {
        pid: 123,
        exitObservedHostMs: 10,
        stdoutDrainObservedHostMs: 11,
        closedHostMs: 12,
      },
    },
  });
  expect(residentVolumeCleanupConfirmed(completed())).toBe(true);
  expect(
    residentVolumeCleanupConfirmed({
      ...completed(),
      reader_owner: { closed: true, active: false, queued: 0, child: null },
    }),
  ).toBe(true);
  for (const value of [
    null,
    undefined,
    [],
    {},
    true,
    { closed: true },
    { reader_closed: true },
  ])
    expect(residentVolumeCleanupConfirmed(value)).toBe(false);
  for (const field of [
    "closed",
    "learning_closed",
    "reader_closed",
    "tasks_joined",
  ]) {
    for (const value of [false, null, 1, "true"]) {
      const receipt = completed();
      Reflect.set(receipt, field, value);
      expect(residentVolumeCleanupConfirmed(receipt)).toBe(false);
    }
    const receipt = completed();
    Reflect.deleteProperty(receipt, field);
    expect(residentVolumeCleanupConfirmed(receipt)).toBe(false);
  }
  for (const field of ["closed", "active", "queued", "child"]) {
    const receipt = completed();
    Reflect.deleteProperty(receipt.reader_owner, field);
    expect(residentVolumeCleanupConfirmed(receipt)).toBe(false);
  }
  for (const [field, value] of [
    ["closed", false],
    ["active", true],
    ["queued", 1],
    ["queued", "0"],
  ] as const) {
    const receipt = completed();
    Reflect.set(receipt.reader_owner, field, value);
    expect(residentVolumeCleanupConfirmed(receipt)).toBe(false);
  }
  for (const field of [
    "pid",
    "exitObservedHostMs",
    "stdoutDrainObservedHostMs",
    "closedHostMs",
  ]) {
    const receipt = completed();
    Reflect.deleteProperty(receipt.reader_owner.child, field);
    expect(residentVolumeCleanupConfirmed(receipt)).toBe(false);
    for (const value of [NaN, Infinity, -1, null, "12"]) {
      const invalid = completed();
      Reflect.set(invalid.reader_owner.child, field, value);
      expect(residentVolumeCleanupConfirmed(invalid)).toBe(false);
    }
  }
  for (const value of [0, 1.5]) {
    const receipt = completed();
    receipt.reader_owner.child.pid = value;
    expect(residentVolumeCleanupConfirmed(receipt)).toBe(false);
  }
});
