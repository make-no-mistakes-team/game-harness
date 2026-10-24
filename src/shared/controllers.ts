import { createHash } from "node:crypto";
import { z } from "zod";

const text = z.string().min(1).refine(value => value.trim() === value && !/[\uD800-\uDFFF]/u.test(value));
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const count = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const pins = {
  steve1: "903b244796322f4d0073a8f62c05f51eac3aed52",
  mineclip: "e6c06a0245fac63dceb38bc9bd4fecd033dae735",
  vpt: "095519fbd4ee0e9281d19f19601e45629de9ac3f",
  minerl: "c0c9baa03b5306ffc3acddc849ec4141b6deb98e",
  mcp_reborn: "1e71be5bd4c49bc4d6ab0ee559c31b298b7697a3",
} as const;
export const REFERENCE_BUTTONS = Object.freeze([
  "attack", "back", "forward", "jump", "left", "right", "sneak", "sprint", "use", "drop", "inventory",
  "hotbar.1", "hotbar.2", "hotbar.3", "hotbar.4", "hotbar.5", "hotbar.6", "hotbar.7", "hotbar.8", "hotbar.9",
]);
const artifact = z.object({ id: text, url: text, sha256: hash, bytes: count, component: text }).strict();
export const referenceLimitsSchema = z.object({
  setup_wall_ms: count, behavior_wall_ms: count, total_wall_ms: count, inference_wall_ms: count,
  max_inferences: count, max_steps: count, max_behaviors: count, max_processes: count,
  max_rss_bytes: count, max_gpu_bytes: count, max_recording_bytes: count, max_download_bytes: count,
  max_disk_bytes: count, shutdown_wall_ms: count,
  setup_inferences: count.optional(), load_wall_ms: count.optional(), steps_per_behavior: count.optional(),
  cgroup_tasks: count.optional(), cpu_quota: count.optional(),
}).strict();
const schema = z.object({
  schema_version: z.literal(1), candidate: z.literal("steve-1-original"), purpose: z.literal("synchronous-reference"),
  sources: z.object({ steve1: z.literal(pins.steve1), mineclip: z.literal(pins.mineclip), vpt: z.literal(pins.vpt),
    minerl: z.literal(pins.minerl), mcp_reborn: z.literal(pins.mcp_reborn) }).strict(),
  artifacts: z.array(artifact).min(9),
  components: z.array(z.object({ id: text, terms: text, use_basis: text, evidence_url: text }).strict()).min(8),
  runtime: z.object({ python: text, torch: text, cuda: text, gym: text, java_major: z.literal(8),
    dependency_lock_sha256: hash, configuration_sha256: hash, configuration_changes: z.array(text) }).strict(),
  simulator: z.object({ game: z.literal("minecraft"), game_version: z.literal("1.16.5"),
    environment: z.literal("MineRLHumanSurvival-v0"), engine_artifact: z.literal("engine"),
    build: z.literal("local-mcp-reborn-plus-minerl-patch"), clock: z.literal("synchronous"), frameskip: z.literal(1),
    reset_seed: z.number().int().nonnegative().max(4294967295) }).strict(),
  preprocessing: z.object({ render_width: z.literal(640), render_height: z.literal(360), input_width: z.literal(128), input_height: z.literal(128),
    color: z.literal("RGB"), dtype: z.literal("uint8"), resize: z.literal("opencv-inter-linear"), normalization: z.literal("policy-internal-divide-255"),
    fov: z.literal(70), gamma: z.literal(2), gui_scale: z.literal(1), cursor_size: z.literal(16),
    mouse_sensitivity: z.literal(0.5), invert_mouse: z.literal(false), smooth_camera: z.literal(false) }).strict(),
  action_mapping: z.object({ implementation: z.literal("steve1-vendored-vpt"), camera_order: z.tuple([z.literal("pitch"), z.literal("yaw")]),
    camera_unit: z.literal("degrees"), camera_bins: z.literal(11), camera_binsize: z.literal(2), camera_maxval: z.literal(10), camera_mu: z.literal(10),
    camera_quantization: z.literal("mu_law"), buttons: z.array(text).refine(value => JSON.stringify(value) === JSON.stringify(REFERENCE_BUTTONS)) }).strict(),
  goal: z.object({ kind: z.literal("text"), cond_scale: z.literal(6), embedding_shape: z.tuple([z.literal(1), z.literal(512)]),
    embedding_dtype: z.enum(["float16", "float32"]), sample_once_per_goal: z.literal(true), prior_sampling: z.literal("stochastic"),
    tokenizer_revision: z.literal("57c216476eefef5ab752ec549e440a49ae4ae5f3"), seed: z.number().int().nonnegative().max(4294967295) }).strict(),
  recurrent: z.object({ kind: z.literal("transformer"), layout: z.literal("layer-list-of-mask-and-kv"), cfg_batch: z.literal(2),
    architecture_artifact: z.literal("architecture"), reset_on_episode: z.literal(true), reset_on_goal: z.literal(true) }).strict(),
  device: z.object({ policy: z.literal("cuda:0"), mineclip: z.literal("cuda:0"), prior: z.literal("cuda:0"),
    precision: z.literal("cuda-autocast-fp16"), runtime_compatibility_evidence: text }).strict(),
  isolation: z.object({ worker_count: z.literal(1), network: z.literal("none"), host_home: z.literal(false), host_auth: z.literal(false),
    operator_display: z.literal(false), operator_input: z.literal(false), unrelated_worlds: z.literal(false), evaluator_hints: z.literal(false), artifacts_read_only: z.literal(true) }).strict(),
  behaviors: z.array(z.object({ id: z.enum(["dirt", "wood"]), text,
    fixture_sha256: hash, verifier: z.enum(["positive-own-inventory-dirt-gain", "positive-own-inventory-log-gain"]), verifier_sha256: hash }).strict()).length(2),
  limits: referenceLimitsSchema,
  execution: z.object({ image: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    prepared_tree_sha256: hash, runner_tree_sha256: hash,
    artifact_paths: z.record(text, text), fixture_paths: z.record(text, text),
    renderer: z.object({ mode: z.literal("owned-in-environment-container"), display: z.string().regex(/^:[0-9]+$/),
      weston_version: text, command: z.array(text).min(2), identity_sha256: hash }).strict(),
    resource_partition: z.object({ policy_memory_bytes: z.literal(5368709120), environment_memory_bytes: z.literal(2684354560),
      supervision_memory_bytes: z.literal(536870912), policy_tasks: z.literal(128), environment_tasks: z.literal(96), supervision_tasks: z.literal(32),
      policy_cpus: z.literal(5), environment_cpus: z.literal(2), supervision_cpus: z.literal(1), java_heap_bytes: z.literal(1610612736),
      host_headroom_bytes: z.literal(1073741824) }).strict(),
    gpu_uuid: text, gpu_cdi_device: text, gpu_total_bytes: count,
    dependency_inventory_path: text, configuration_path: text,
    tokenizer_directory: text,
  }).strict().optional(),
}).strict();

type DeepReadonly<T> = T extends readonly (infer U)[] ? readonly DeepReadonly<U>[] : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export type ControllerManifest = DeepReadonly<z.infer<typeof schema>>;
export type ReferenceLimits = DeepReadonly<z.infer<typeof referenceLimitsSchema>>;

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** One wire identity in TS/Python: UTF-8, sorted ASCII schema keys, compact JSON. */
export function canonicalReferenceJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalReferenceJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalReferenceJson(child)}`).join(",")}}`;
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Nonfinite reference identity");
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Non-JSON reference identity");
  return encoded;
}

export function validateControllerManifest(input: unknown): ControllerManifest {
  const parsed = schema.parse(input);
  const artifacts = new Map(parsed.artifacts.map(value => [value.id, value]));
  const components = new Set(parsed.components.map(value => value.id));
  if (artifacts.size !== parsed.artifacts.length || components.size !== parsed.components.length) throw new Error("Duplicate artifact/component identity");
  for (const id of ["source", "architecture", "policy", "prior", "mineclip", "tokenizer", "engine", "dependencies", "configuration"])
    if (!artifacts.has(id)) throw new Error(`Missing required artifact ${id}`);
  for (const id of ["steve1", "vpt", "mineclip", "clip-tokenizer", "minerl", "minecraft", "mcp_reborn", "runtime"])
    if (!components.has(id)) throw new Error(`Missing component terms ${id}`);
  if (parsed.artifacts.some(value => !components.has(value.component))) throw new Error("Artifact has unresolved component ownership");
  if (artifacts.get("dependencies")!.sha256 !== parsed.runtime.dependency_lock_sha256
    || artifacts.get("configuration")!.sha256 !== parsed.runtime.configuration_sha256) throw new Error("Runtime lock/configuration identity mismatch");
  if (new Set(parsed.behaviors.map(value => value.id)).size !== 2) throw new Error("Declare exactly the two distinct selected behaviors");
  for (const behavior of parsed.behaviors) {
    const expected = behavior.id === "dirt" ? "positive-own-inventory-dirt-gain" : "positive-own-inventory-log-gain";
    const prompt = behavior.id === "dirt" ? "get dirt, dig hole, dig dirt, gather a ton of dirt, collect dirt"
      : "chop down the tree, gather wood, pick up wood, chop it down, break tree";
    if (behavior.verifier !== expected || behavior.text !== prompt) throw new Error("Frozen behavior prompt/verifier mismatch");
  }
  if (parsed.limits.max_behaviors < parsed.behaviors.length) throw new Error("Behavior allocation cannot cover the scheduled cases");
  if (parsed.goal.seed === parsed.simulator.reset_seed) throw new Error("Private fixture reset seed must not be reused as the policy's public RNG seed");
  if (parsed.limits.inference_wall_ms > parsed.limits.total_wall_ms || parsed.limits.setup_wall_ms > parsed.limits.total_wall_ms
    || parsed.limits.behavior_wall_ms > parsed.limits.total_wall_ms) throw new Error("Phase limit exceeds the screen limit");
  if (parsed.execution) {
    const safe = (path: string) => !path.startsWith("/") && !path.split(/[\\/]/).some(part => !part || part === "." || part === "..");
    for (const path of [...Object.values(parsed.execution.artifact_paths), ...Object.values(parsed.execution.fixture_paths),
      parsed.execution.dependency_inventory_path, parsed.execution.configuration_path, parsed.execution.tokenizer_directory])
      if (!safe(path)) throw new Error("Prepared reference paths must be relative without traversal");
    for (const id of artifacts.keys()) if (!parsed.execution.artifact_paths[id]) throw new Error(`Missing artifact path ${id}`);
    if (parsed.execution.configuration_path !== parsed.execution.artifact_paths.configuration
      || parsed.execution.dependency_inventory_path !== parsed.execution.artifact_paths.dependencies)
      throw new Error("Effective configuration/dependency inventory must use their pinned artifact paths");
    for (const behavior of parsed.behaviors) if (!parsed.execution.fixture_paths[behavior.id]) throw new Error(`Missing fixture path ${behavior.id}`);
    if (parsed.runtime.python !== "3.10.22" || parsed.runtime.torch !== "2.7.1" || parsed.runtime.cuda !== "12.8"
      || !parsed.runtime.configuration_changes.length) throw new Error("Execution requires the explicitly declared modernized runtime");
    const partition = parsed.execution.resource_partition;
    if (partition.policy_memory_bytes + partition.environment_memory_bytes + partition.supervision_memory_bytes > parsed.limits.max_rss_bytes
      || partition.policy_tasks + partition.environment_tasks + partition.supervision_tasks > (parsed.limits.cgroup_tasks ?? 0)
      || partition.policy_cpus + partition.environment_cpus + partition.supervision_cpus > (parsed.limits.cpu_quota ?? 0))
      throw new Error("Resource partitions exceed the frozen aggregate allocation");
    const allocation = { setup_wall_ms: 7200000, behavior_wall_ms: 600000, total_wall_ms: 8700000, inference_wall_ms: 5000,
      max_inferences: 2500, max_steps: 2500, max_behaviors: 2, max_processes: 32, max_rss_bytes: 8589934592,
      max_gpu_bytes: 12884901888, max_recording_bytes: 4294967296, max_download_bytes: 12884901888, max_disk_bytes: 42949672960,
      shutdown_wall_ms: 30000, setup_inferences: 16, load_wall_ms: 180000, steps_per_behavior: 1200, cgroup_tasks: 256, cpu_quota: 8 };
    for (const [key, expected] of Object.entries(allocation))
      if (parsed.limits[key as keyof typeof allocation] !== expected) throw new Error(`Execution allocation differs from the approved finite screen: ${key}`);
  }
  return freeze(parsed);
}

export function controllerManifestHash(manifest: ControllerManifest): string {
  return createHash("sha256").update(canonicalReferenceJson(manifest)).digest("hex");
}
