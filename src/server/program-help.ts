import { z } from "zod";
import type { RuntimeAdapter } from "../shared/contracts.ts";
import { getGameAPIReference, policyDecisionSchema } from "../shared/validation.ts";
import { DEFAULT_SKILL_LIMITS, PROGRAM_RESULT_GUIDANCE } from "../shared/programs.ts";
import { PROGRAM_LIMITS } from "./program-validation.ts";
import { controllerStepResultSchema, executiveStepResultSchema, residentActivationResultSchema, DEFAULT_RESIDENT_LIMITS, RESIDENT_STEP_RESPONSE_MS } from "../shared/resident.ts";
import { controlSessionConfigSchema, executiveSnapshotSchema } from "../shared/control-session.ts";
import { helpSchema, memorySchema, nextConfigSchema, prepareNextSchema, programEditSchema, programInspectSchema, programReviewSchema, programRunSchema, programSubmitSchema, programWriteSchema, reflexSchema, taskFinishSchema } from "./program-interface.ts";
import { RuntimeFault } from "./runtime-fault.ts";

const MINECRAFT_IDENTIFIERS = "Minecraft block/entity/inventory name, dropped item_name, equipment item, active_use.item and screen-slot item use registry paths without a namespace prefix (for example oak_log, zombie, wooden_sword), not minecraft:oak_log. These are distinct from full identifiers such as space.dimension_id, player.vehicle_type and status_effects[].id. Compare the exact projected strings; display_name is presentation text.";
const MINECRAFT_LOCAL_COVERAGE = "Pure step receives bounded JSON, not RGB pixels. Main's separate actor image can depict things outside the local structured projection. In this r8 profile, terrain is an occlusion-filtered spherical eight-block neighborhood around the player's block, not a world map; block.position is already the block centre, not its integer corner. Empty rows do not establish absence outside that neighborhood. Camera-bound entity rows are partial too. Your JSON state may explicitly retain earlier permitted evidence with its original capture/scope; memory is not populated automatically. Historical positions may inform model-chosen bounded raw movement checked against fresh own-body/local feedback, without assuming old geometry is current. Old handles never grant live target authority: targeted effects still require fresh ordinary admission. Remembering evidence supplies no automatic navigation or recovery.";
const MINECRAFT_HEARING = "World compass, not screen-left/right: N=-Z,E=+X,S=+Z,W=-X; diagonals combine axes. Compare with actual applied yaw. here means horizontal separation<1block, no useful bearing. Coarse3D distance:near<8,mid<16,far<=32. Retain original heard time/cursor; redelivery is not a new sound. Creature groups reveal no exact identity/position/handle or hidden entity geometry.";

// Shape reference only. Full generated JSON schemas remain in game/programs;
// duplicating every constraint and description here evicts the callable shape
// from the next bounded request as soon as the model has written useful code.
function typeShape(value: unknown, references: ReadonlyMap<string, string>): string {
  if (value === true) return "Json";
  if (value === false) return "never";
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a generated schema object");
  const node = value as Record<string, unknown>;
  if ("const" in node) {
    const literal = JSON.stringify(node.const);
    if (literal === undefined) throw new Error("Expected a JSON schema constant");
    return literal;
  }
  if (Array.isArray(node.enum)) return node.enum.map(item => JSON.stringify(item)).join(" | ");
  const union = node.anyOf ?? node.oneOf;
  if (Array.isArray(union)) return union.map(child => typeShape(child, references)).join(" | ");
  if (typeof node.$ref === "string") {
    const reference = references.get(node.$ref);
    if (!reference) throw new Error("Controller shape has an unresolved schema reference");
    return reference;
  }
  if (Array.isArray(node.type)) return node.type.map(type => typeShape({ type }, references)).join(" | ");
  if (node.type === "object") {
    if (!node.properties || typeof node.properties !== "object" || Array.isArray(node.properties))
      return node.additionalProperties === false ? "{}" : `Record<string, ${typeShape(node.additionalProperties ?? true, references)}>`;
    const required = new Set(Array.isArray(node.required) ? node.required : []);
    return `{ ${Object.entries(node.properties).map(([name, child]) =>
      `${JSON.stringify(name)}${required.has(name) ? "" : "?"}: ${typeShape(child, references)}`).join("; ")} }`;
  }
  if (node.type === "array") return `Array<${typeShape(node.items ?? true, references)}>`;
  if (node.type === "integer" || node.type === "number") return "number";
  if (node.type === "string" || node.type === "boolean" || node.type === "null") return node.type;
  if (Object.keys(node).every(key => ["$schema", "description", "title"].includes(key))) return "Json";
  throw new Error("Unsupported generated controller shape");
}

function fieldShapes(value: unknown) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected generated controller fields");
  const node = value as Record<string, unknown>;
  if (!node.properties || typeof node.properties !== "object" || Array.isArray(node.properties))
    throw new Error("Expected generated controller fields");
  const definitions = node.$defs && typeof node.$defs === "object" && !Array.isArray(node.$defs) ? Object.entries(node.$defs) : [];
  const references = new Map(definitions.map(([name], index) =>
    [`#/$defs/${name.replaceAll("~", "~0").replaceAll("/", "~1")}`, `Data${index}`]));
  return {
    fields: Object.fromEntries(Object.entries(node.properties).map(([name, child]) => [name, typeShape(child, references)])),
    types: Object.fromEntries(definitions.map(([, child], index) => [`Data${index}`, typeShape(child, references)])),
  };
}

const actionReferences = new WeakMap<RuntimeAdapter, Map<string, object>>();
const constraintKeys = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minLength", "maxLength", "pattern", "minItems", "maxItems", "description"];

function actionNotes(value: Record<string, unknown>, prefix: string, output: Record<string, object>): void {
  const notes = Object.fromEntries(constraintKeys.filter(key => key in value).map(key => [key, value[key]]));
  if (Object.keys(notes).length) output[prefix || "<root>"] = notes;
  const visit = (child: unknown, name: string) => {
    if (child && typeof child === "object" && !Array.isArray(child))
      actionNotes(child as Record<string, unknown>, name, output);
  };
  if (value.properties && typeof value.properties === "object" && !Array.isArray(value.properties))
    for (const [name, child] of Object.entries(value.properties)) visit(child, prefix ? `${prefix}.${name}` : name);
  if (value.items) visit(value.items, `${prefix}[]`);
  for (const key of ["anyOf", "oneOf", "allOf"])
    if (Array.isArray(value[key]))
      value[key].forEach((child, index) => visit(child, `${prefix}.${key}[${index}]`));
}

function actionHelp(adapter: RuntimeAdapter, kind?: string): object {
  let cached = actionReferences.get(adapter);
  if (!cached) { cached = new Map(); actionReferences.set(adapter, cached); }
  const previous = cached.get(kind ?? "");
  if (previous) return previous;
  const capability = adapter.action_capability;
  if (!capability) throw new RuntimeFault("precondition_failed", "This adapter has no action capability");
  const root = adapter.schemas.capabilities[`${capability.id}@${capability.version}`] as Record<string, unknown>;
  const alternatives = root.anyOf ?? root.oneOf ?? [root];
  if (!Array.isArray(alternatives)) throw new Error("Expected registered action alternatives");
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const alternative of alternatives) {
    const branch = alternative as Record<string, unknown>;
    const properties = branch.properties as Record<string, Record<string, unknown>> | undefined;
    const discriminator = properties?.kind?.const;
    if (typeof discriminator !== "string") throw new Error("Action reference requires a registered kind discriminator");
    const family = groups.get(discriminator);
    if (family) family.push(branch); else groups.set(discriminator, [branch]);
  }
  let result: object;
  if (kind !== undefined) {
    const family = groups.get(kind);
    if (!family) throw new RuntimeFault("not_found", "This action kind is not registered for the current adapter");
    result = { kind, reference: "Complete registered input schema for this exact action family; adapter-owned semantic predicates and current authority still apply.",
      schema: { ...root, anyOf: family } };
  } else {
    const full = getGameAPIReference(adapter);
    const methods = Object.fromEntries(Object.entries(Reflect.get(full, "methods")).map(([name, value]) => {
      const { result_schema: _result, ...method } = value as Record<string, unknown>;
      return [name, method];
    }));
    const definitions = root.$defs && typeof root.$defs === "object" && !Array.isArray(root.$defs) ? Object.entries(root.$defs) : [];
    const references = new Map(definitions.map(([name], index) =>
      [`#/$defs/${name.replaceAll("~", "~0").replaceAll("/", "~1")}`, `Data${index}`]));
    const actions: Record<string, object[]> = {};
    for (const [name, family] of groups) {
      if (name === "world_input" || name === "screen_input") continue;
      actions[name] = family.map(branch => {
        const constraints: Record<string, object> = {};
        actionNotes(branch, "", constraints);
        return { shape: typeShape(branch, references), constraints };
      });
    }
    result = {
      reference: "Compact semantic taskflow reference. Shapes are not validators. Each action family retains all alternatives; generated constraints retain scalar/collection bounds and descriptions. Request help({topic:'actions',kind:'craft'}) or another listed kind for its complete exact schema. Full native reader/result and observation schemas remain in help game; raw frame/input work uses help controller.",
      binding: "game", asynchronous: true, concurrent_calls: false, methods,
      available_kinds: [...groups.keys()], actions,
      types: Object.fromEntries(definitions.map(([, child], index) => [`Data${index}`, typeShape(child, references)])),
      observation_fields: fieldShapes(adapter.schemas.payload),
      result_schemas: Object.fromEntries(["GameActionResult", "SkillResult", "ProgramAttention"].map(name =>
        [name, Reflect.get(Reflect.get(full, "schemas"), name)])),
      native_bindings: Reflect.get(full, "native_bindings"), validation: Reflect.get(full, "validation"),
      lifecycle: Reflect.get(full, "lifecycle"),
    };
  }
  cached.set(kind ?? "", result);
  return result;
}

export function programHelp(topic: z.infer<typeof helpSchema>["topic"], adapter?: RuntimeAdapter, kind?: string) {
  const schema = (value: z.ZodType) => z.toJSONSchema(value, { unrepresentable: "any", io: "input" });
  if (topic === "actions") {
    if (!adapter) throw new Error("A negotiated adapter is required for the action reference");
    return actionHelp(adapter, kind);
  }
  if (topic === "game") {
    if (!adapter) throw new Error("A negotiated adapter is required for the executable game reference");
    return getGameAPIReference(adapter);
  }
  if (topic === "programs" || topic === "controller") {
    const reference = {
    write: schema(programWriteSchema), edit: schema(programEditSchema), submit: schema(programSubmitSchema), run: schema(programRunSchema), inspect: schema(programInspectSchema), review: schema(programReviewSchema),
    source_edits: "program_edit creates an inactive revision of an existing definition using exact latest based_on and 1..16 sequential {old_text,new_text} replacements. Each old_text must match exactly once in the selected canonical source; no fuzzy matching, inferred repair or partial save. Entry/card are retained. Omit dependencies to retain exact pins; an explicit complete list replaces them, and [] removes them. Every selected dependency must already exist. You may author a library first, then remove its helper text and add your import/pins without retyping the root. Full canonical source validation and byte/graph limits still apply; stale parent conflicts rather than rebases. It never changes a live worker or starts/selects code. Use actual returned version receipts for later analysis/selection. Optional top-level reason has the same exact-parent outcome-feedback requirement as program_write.",
    identifiers: MINECRAFT_IDENTIFIERS,
    coverage: MINECRAFT_LOCAL_COVERAGE,
    hearing: MINECRAFT_HEARING,
    compass_bearings: {
      convention: "Absolute actor yaw, not clockwise map azimuth: yaw0 faces South/+Z; East/+X is NEGATIVE yaw. This data converts a supplied coarse world bearing, never selects a target or applies a turn.",
      availability: "Help reference data only, not an injected variable or a motion method. Authored code carries any mapping it chooses to use.",
      yaw_radians: { here: null, N: Math.PI, NE: -3 * Math.PI / 4, E: -Math.PI / 2,
        SE: -Math.PI / 4, S: 0, SW: Math.PI / 4, W: Math.PI / 2, NW: 3 * Math.PI / 4 },
      half_sector_radians: Math.PI / 8,
      here: "No useful horizontal bearing; do not invent an orientation from it.",
    },
    body: "Select entry explicitly. run is an async JavaScript BODY with game,args, no wrapper/import/export. step exports synchronous step(frame,state,intent) and optionally activate(frame,state,intent); session mode requires both. analyze exports synchronous analyze(input) and may directly import the exact step candidate for pure software tests, without playing authority. library is a pure reusable ESM module, never a playing entry. step/analyze/library may use static named/default imports and re-exports through declared local .js/.mjs aliases only; packages, dynamic imports, import.meta and ambient host access are forbidden. Bind exports must retain the selected synchronous entry arity. Original and canonical source each remain<=16KiB UTF-8; a closure has<=32 modules, depth<=8 and<=64KiB canonical source. Entry is immutable, never guessed or retried as another format.",
    world_view: "Common to ordinary world_input and resident streams. delta applies relative radians once immediately at step/snapshot entry, not over its duration. rate is rad/sec: each admitted actual50ms simulation tick owns at most rate*0.05 rotation, split at ordinary mouse/render cadence by vanilla simulation progress, never wall-clock tick synthesis or extra angle at higher FPS. An authorized residual settles before the next tick's crosshair; revoked/expired/screen/retired ownership discards it. Nonzero-rate ACK/completion follows actual interval settlement. Positive yaw turns right:0 faces+Z,+pi/2 faces-X,-pi/2 faces+X; positive pitch is up. Actual body/ACK applied_pose wraps yaw[-pi,pi) and clamps pitch[-pi/2,pi/2] under vanilla constraints; a request is not pose evidence. A stream retains rate after ACK until replaced or cleared; submit unchanged/zero rate to stop. Neutral held or silence alone does not stop rotation. Stop clears future owned input without undoing earlier effects. No target, scan or trajectory is selected by the host.",
    target_transitions: "motion.turn profiles a stable chosen orientation; motion.track limits velocity/acceleration toward a changing one. Retain explicit state across callbacks. Neither selects a target/scan/tactic or guarantees alignment. Full-error delta snaps, including during pickup/recovery. Removed blocks are not automatic gaze targets; timed full-circle scans are not required sensing. Choose purposeful bounded view changes from actual permitted evidence. Wrapped yaw is not a physical full turn.",
    semantic_aiming: "Raw world input can combine held attack with a view rate; normal crosshair/vanilla rules decide what happens, and its ACK is not a block-removal receipt. Semantic dig separately aims at the selected block centre from the actual current pose, starting its own zero-velocity camera profile. It can mine while that camera still moves: its angular gate is less than3degrees per axis, not zero velocity or exact-centre alignment. A raw-to-semantic switch can therefore change the trajectory and quickly finish a small residual error. Neither a mandatory pre-aim stop nor artificial jitter is required. Choose supported action/motion timing yourself; preserve target validity, reach, exact ownership and honest effect evidence.",
    temporal_turn: {
      signature: "motion.turn({native_tick,pose:{yaw_radians,pitch_radians},target:{yaw_radians,pitch_radians},duration_ticks,max_rate,tolerance?},state=null) -> {view,state,finished,aligned,error:{yaw_radians,pitch_radians}}",
      availability: "Frozen pure step/analyze math; no import/dependency/extra export, host clock, observations, target/movement capability or internal retained state.",
      inputs: "Actual frame.native_tick (nonnegative safe integer), frame.view.applied_pose (valid pitch), finite chosen target; required positive integer duration_ticks (50ms), max_rate∈(0,20*pi]rad/s per axis. tolerance defaults0.01rad, range[0,pi]. Target pitch clamps, yaw wraps shortest. Pass null or retain returned state in next_state. Invalid input/state throws.",
      timing: "Cubic accelerate/brake reference; next-tick pose correction rate-capped. Fresh ticks normally20Hz; same tick does not advance. Delays/low cadence or inadequate bounds can miss. Target/duration change, null state or regressed tick rebases from actual pose; noisy retargets restart. Rate/tolerance change alone does not restart.",
      completion: "Submit returned rate view yourself. At duration:zero rate,finished:true even if missed; aligned measures current pose tolerance, not application/hit/task success. Retain state and check fresh feedback. No automatic extension/retry/action.",
    },
    temporal_tracking: {
      signature: "motion.track({native_tick,pose:{yaw_radians,pitch_radians},target:{yaw_radians,pitch_radians},max_rate,max_acceleration,response_ticks,tolerance?},state=null) -> {view,state,aligned,error:{yaw_radians,pitch_radians}}",
      inputs: "Pure step/analyze math; requires motion_track_v1. Supply actual tick/pose, chosen target, required max_rate∈(0,20*pi]rad/s, positive finite max_acceleration rad/s² and positive safe-integer response_ticks (50ms each). No gameplay/clock/target capability. tolerance defaults0.01rad, range[0,pi], alignment-only.",
      state: "Retain {last_tick,velocity:{yaw_radians_per_second,pitch_radians_per_second}}. Null/regressed tick resets to0; same tick does not advance; target changes preserve velocity. Invalid state, including carried speed above a lowered cap, throws. Reset only deliberately.",
      feedback: "Desired velocity=wrapped-yaw/clamped-pitch error/response time, rate-capped per axis; velocity change<=acceleration*elapsed native seconds. Apply returned rate yourself. May lag/overshoot, with no arrival/hit/damage promise. aligned is current actual pose, not applied input. You choose targets, resets and action timing.",
    },
    resident: {
      result: z.toJSONSchema(controllerStepResultSchema, { unrepresentable: "any", io: "output" }),
      executive_result: z.toJSONSchema(executiveStepResultSchema, { unrepresentable: "any", io: "output" }),
      activation_result: z.toJSONSchema(residentActivationResultSchema, { unrepresentable: "any", io: "output" }),
      executive_state: z.toJSONSchema(executiveSnapshotSchema, { unrepresentable: "any", io: "output" }),
      session: z.toJSONSchema(controlSessionConfigSchema, { unrepresentable: "any", io: "output" }),
      executive_contract: "step with session:{schema_version:1}; synchronous activate/step(frame,state,intent) return {choice,next_state,status,events}. Clean live activate runs once or refuses {refused:true,reason}; shadow globals/output discarded. frame.executive is software status, not world evidence. choice:raw(input),ensure_task(key,request),continue(handle),cancel(handle),observe. Tasks select one bounded action or exact declared run dependency. Keys advance by1; same key preserves task/result, changed content conflicts, expired keys never replay. Inspect status before a new key; child completion/cancellation does not end executive. Producer switches join exact retirement, then recompute; first switch-time raw input is not replayed. Only fresh continue/ensure_task renew selected semantic250ms supervision, not observe. Unknown effects never authorize replay. Children/restarts share max_tasks/actions/calls and original deadline. Restarts require recovery:'reset_safe',max_restarts>0 and fresh model-authored refusal-capable activate; no stack/checkpoint restoration.",
      response: {
        max_host_response_ms: RESIDENT_STEP_RESPONSE_MS,
        contract: "step_ms is a guarded wall-time allowance, not measured CPU. Its trusted guardian timer starts before dispatch through Docker, so container transport/scheduling, evaluation and serialization consume it; the container also has an independent worker watchdog. The separate host response wait never extends the original root deadline and sends no heartbeat. A returned running decision must still pass native150ms capture freshness and exact scope/intent checks before renewal/state publication. timings.step_ms is host round-trip wall time, not CPU.",
      },
      software_tests: "Write analyze importing activate/step from the exact pinned step candidate. Use your own explicitly synthetic inputs and selected initial state/intent. Optional validate_as:'activation'|'decision' on program_run analyze checks its returned output against the actual return schema after accounted evaluation; it grants no native authority or gameplay qualification. A valid refusal is only a valid activation return shape. Validated source throws expose bounded source_diagnostic marked advisory/untrusted, with the compiled realm's source_hash rather than only the root body hash; assertion text is not a host fact or authority. Analysis wrappers count against the same module/byte/depth bounds. Keep state explicitly bounded: frame envelopes can be much larger than the16KiB state allowance; test larger permitted projections, not only tiny fixtures.",
      contract: "step has no game/native/provider/job capability. It receives the registered Minecraft controller frame, explicit JSON state and intent; args is initial intent, initial_state defaults null. Return one coherent input, next_state, status and events; never a Promise. State and intent <=16 KiB JSON UTF-8/depth32; complete result/envelope/newline <=64 KiB. Processed state is not submitted or applied input: frame.last_input and later effect_updates retain actual native acknowledgment and separate receipts. Fresh valid steps renew only the short native lease, never the original root deadline. Blocked/yielded/completed retires this execution; only a successful drained predecessor and explicit next permission may activate a prepared successor. No implicit rescue. Stop waits for worker/jobs and actual native retirement.",
      operations: "program_run start entry step requires matching source and finite resident limits. handoff:{name,version,execution_ordinal} pins the exact latest live or successfully completed predecessor. The host probes a disposable candidate, prepares a separate clean worker before retirement, confirms worker/native drain, then activates on fresh state. Invalid/slow preparation leaves a viable incumbent running. Stop/abort/scope/intent changes refuse activation. Failed/cancelled/unknown predecessors cannot be replayed. Deadlines never renew. Session step may pin run dependencies for ensure_task program requests; analyze cannot. update_intent requires the inspected intent_version. A superseded computation cannot emit.",
      input_transitions: "Supply all9desired held booleans. Normally omit edges: host derives one press/release per change from last successfully submitted state (initially neutral), not lagging ACK. Unchanged held attack/use adds no click. Explicit edges retain exact counts/order; every held change needs its matching edge, release count1. Inconsistent lists including[] reject, never repair. Retain submitted held for explicit transitions, not frame.last_input. Screen input requires neutral submitted world held. Release world buttons while the screen is ABSENT; world input, even neutral, is forbidden once a screen is visible. A newly opened raw channel already starts neutral and needs no world-input barrier before its first screen input. Producer-switch input is still discarded, not applied. Non-running results retire without input. Inspect execution for full failure detail.",
      gui_completion: "A nonempty GUI gesture can span several ticks. Cursor/slot changes are not completion. While awaiting its correlated application ACK and terminal effect_updates receipt, choose {kind:'raw',input:null}: fresh callbacks/lease renewal continue WITHOUT submitting input. This neither neutralizes prior held/view controls nor emits an ACK/receipt. Do not enqueue even empty screen snapshots for polling after a close/layout-changing gesture: their layout can become stale before application and fence the producer. frame.executive.last_submission maps the source frame_seq of an accepted input to its actual controller_generation/sequence; retain that exact pair for ACK/effect correlation. Switch-time choices and null waits create no submission; absence of attribution never licenses a guessed sequence. World/empty-screen input have ACKs only, no separate effect receipt. Native tick, frame_seq and input sequence are independent. Keep strict screen/local predicates and never replay unknown effects.",
      sensing: "Use the controller_frame capability schema in help topic game for frame contents. Input uses ordinary world held/edges/view/selection or current visible-screen operations, not tactical helpers. All source, life, native boot, space, screen and native-age checks remain host-owned.",
    },
    result: PROGRAM_RESULT_GUIDANCE,
    completion: "A program's completed status is execution-only, not task success. For a custom task, call ordinary-only task_finish only when actual authorized evidence supports the WHOLE task; it immediately stops all local control. Unverified means model-reported completion, not unfinished work. For partial progress or missing evidence, end the planning response without this terminal tool and retain useful bounded control. After actual completion, do not run another no-op/check or review loop. Built-in goals still require independent trusted verification.",
    composition: "Declare dependencies as already authored named programs. For reusable pure code, write entry:'library', then declare {name,version,import_path:'./helper.js'} and import through that exact alias. The receipt pins the immutable library version; later revisions never replace it. Libraries may import other libraries; analyze/library dependencies require aliases. step may also declare run children without import_path; run dependencies remain semantic game.call children only, never inline imports. Omitted version requires an unambiguous captured name. Imported modules share the root's pure realm, with no host Game API. Native reads remain direct positional game.<binding>(...parameters) methods listed by help game, not named program imports.",
    local_feedback: "game.actionAndObserve(action) preserves the raw result; observes only without requires_reconnect after succeeded, or failed with neutralized:true and (world_effect_emitted:false or failure_outcome_confirmed:true). This native-owned boolean is not an action argument/capability. Settled failure may include attempted input, partial movement and other world changes. Check your own postcondition before bounded fresh selection; feedback grants no goal success, retry or unknown-action replay. Both calls use existing budgets/authority; revocation throws. Other outcomes give observation:null.",
    local_feedback_example: LOCAL_FEEDBACK_EXAMPLE,
    attention: "run may await game.attention({urgency:'ordinary'|'urgent',summary,details}) to request cognition while continuing local work. It returns void and charges existing root max_calls, not an action. step requests cognition with an authored kind:'attention' event; kind:'diagnostic' and game.progress only retain evidence/notes. Emit attention once at a meaningful transition before useful coverage runs out. During a pending Main turn it queues ordinary decision demand, not another concurrent owner, a provider response or renewed allowance. See help game for the exact ProgramAttention schema and authority contract.",
    revision: "A new name omits based_on; an existing name requires its latest stored version, even if unexecuted, not its latest executed version. Conflicts never silently rebase. card.reason describes motivation. Optional top-level reason links an experimental revision to actual outcome feedback for that exact parent; missing feedback refuses before new source or execution with precondition_failed and an issue at reason. For an ordinary revision, omit top-level reason and retain based_on, including for unexecuted source. No execution or review ritual is required. A prior keep/insufficient_evidence assessment stays immutable; a new candidate link is separate and proves no improvement or promotion.",
    selection: "Start without version selects latest validated once before admission. Exact version remains exact. Transport retry identity is host-bound; repeat delivery of one tool call never starts new work. A new decision is a distinct call.",
    reuse: "Inspect each retained compatible program's last outcome and historical argument sample. Reuse a suitable exact version with new compact args, or repair its actual defect with based_on before reuse. A blocked version is not qualified by its name. One coherent body may reuse parameterized local functions; do not add model turns or child calls merely to manufacture reuse. Historical coordinates guide fresh reacquisition; old handles never authorize effects.",
    submission: "Ordinary-only program_submit explicitly combines write arguments with required JSON args (pass null when unused), limits and optional next. It registers one immutable version and starts only that exact version through normal admission. program_write still only saves; program_run still starts existing programs. source.status persisted reports the saved name/version even if start.status is refused or unknown. Refused means no execution was acknowledged; unknown must be inspected, never blindly retried. Duplicate delivery cannot create another revision or execution. Stop/Pause and task/generation/owner changes between phases block start. Review and speculative planning cannot submit.",
    handoff: "Optional handoff:{name,version,execution_ordinal} pins the exact latest predecessor. Keep useful old work running during authoring. After successor preflight, all future capabilities in the semantic run tree are fenced immediately; only a currently admitted bounded leaf action/read may settle with its existing authority before retirement, never the rest of a procedure or a whole game.call child. With no admitted leaf, retirement is immediate. Resident predecessors retire immediately. Stop/tool abort, death, unknown effects and the original root deadline still revoke immediately and refuse the successor. A naturally succeeded predecessor can also hand off after confirmed drain in the same scope. Blocked/cancelled/failed/unknown predecessors, newer work, scope/screen changes or uncertain cleanup refuse effects. Fresh observations bracket retirement. Persistence is separate from start acknowledgment. Duplicate/interrupted delivery never cancels or dispatches another successor. No fallback, state migration, deadline extension or replay.",
    inspection: "Views are read-only. Follow next_after/has_more and explicit omissions. Feedback metrics carry kind replace with the complete metric, or retract with execution_removed and no metric; remove a retracted execution's current measurement, not its retained earlier generations. Both carry stable named program, execution_ordinal, revision and generation. current means unfinished execution; latest includes terminal outcomes. Trace continuation cursors pin the original execution even after newer work starts. Continue comparison pages using the exact named versions returned on page one. Review without version selects the latest matching outcome in that name family; an exact version stays exact. Named selection never rewrites captured execution/dependency references. Game-specific reads use the executable adapter bindings listed by help topic game, not additional program_inspect views.",
    continuity: "At meaningful intent/recovery changes, game.progress(summary,{current_subgoal,worksite,resource_requirements,recovery_reason}) or explicit root-result fields retain compact authored notes. worksite is an actually observed task site: establish or deliberately relocate it, never replace it with current position during travel/recovery. Omission retains notes; null clears them. Current position/inventory come from fresh observation; keep temporary recovery_position separate. Life/session/boot/space changes clear current notes; explicitly authored worksite/subgoal and unresolved effects may remain separately labelled historical references with their original scope, never current authority. Reobserve/reacquire before continuation; containment does not prove an unknown effect did not happen. Fresh run/task/world clears experience. Pause/provider recovery requires explicit Resume and fresh state; Stop is terminal, not automatic resume. Durable events reconstruct supported references, not workers, JS stacks or world state. No mandatory per-turn summary or inferred strategy.",
    movement_recovery: "Raw movement succeeded means the interval completed, not that the subgoal advanced. Compare sustained/net grounded standing-position changes relative to your selected destination or an observed postcondition, not cumulative travel/jump distance, arbitrary horizontal displacement, circling or transient airborne height. Bound the interval/distance you spend without reducing the relevant target error; after at most three ineffective bursts fresh-observe and change approach or return blocked with receipt evidence. Nearly vertical targets have unstable horizontal bearing: when horizontal separation is negligible, keep a deliberate yaw instead of chasing atan2 noise; yaw changes or horizontal circles do not solve height/reach mismatch. Bounded purposeful detours may move away temporarily. Never reissue an unchanged refusal. Raw forward follows the current camera during move.look turning; in confined geometry await a completed look first. Intentional stationary actions, looks and settling waits remain valid. Unknown effects stay fenced and must not be replayed.",
    resource_accounting: "Choose resource requirements for your own taskflow, then compare exact observed item names and counts, including recipe output multiplicities, planned consumption and remaining deficits. Similar-looking items are not interchangeable evidence. Reobserve current inventory after confirmed changes; an issued action or old note is not inventory. Check a required tool is actually present, usable and selected before dependent work; a generic successful collection interval does not prove its intended resource or quantity arrived.",
    bounded_crafting: "For a coherent model-selected batch, craft accepts either {kind:'craft',item,executions,table?} or {kind:'craft',sequence:[{item,executions},...],table?}, never both. Sequence has 1..8 ordered stages and at most 16 total executions (1..16 per stage). executions counts recipe consumptions, not output items. Compute needed quantities using recipe yields and inventory; batch repeated ingredients without over-crafting. One sequence owns one bounded screen/cursor session; the optional observed table applies throughout. The native executor follows your exact order, stops at first failure and reports confirmed per-stage effects/partial custody; it does not select recipes, complete missing prerequisites or retry. Inspect actual receipts/current inventory before dependent work, and never replay unknown effects.",
    execution_limits: "Omitted limits or {} uses documented defaults. Supply only fields to override; the host normalizes a complete strict object and records effective limits. Invalid values/types/unknown fields are rejected, never clamped. Maxima, remaining root/parent budgets, ownership and duplicate-delivery identity remain authoritative. This also applies to prepared successors.",
    limits: PROGRAM_LIMITS, default_execution_limits: DEFAULT_SKILL_LIMITS, default_resident_limits: DEFAULT_RESIDENT_LIMITS,
    };
    if (topic === "programs") return reference;
    if (!adapter) throw new Error("A negotiated adapter is required for the controller reference");
    const frame = adapter.bindings.find(binding => binding.capability_id === "minecraft.controller_frame");
    if (!frame?.result) throw new Error("This adapter has no registered resident controller frame");
    return {
      reference: "Generated field shapes, not validators or executable TypeScript. Each section has fields and its own type aliases; Json means finite JSON data. Full exact schemas and constraints remain in help game (registered frame) and programs (resident result). These shapes contain no current target or execution authority.",
      launch: "For a durable local executive use program_submit({entry:'step',name,source,args:null,session:{schema_version:1}}). Export step and activate, returning choice rather than input; finite child completion does not end it. Legacy raw-only mode omits session and returns input. Required args is JSON intent; initial_state defaults null and limits accepts individual overrides. Static imports require explicitly pinned pure library aliases; no ambient APIs or live promises. Every tactical choice is yours.",
      identifiers: reference.identifiers,
      coverage: reference.coverage,
      hearing: reference.hearing,
      compass_bearings: reference.compass_bearings,
      frame_fields: fieldShapes(frame.result.schema),
      result_fields: fieldShapes(reference.resident.result),
      executive_result_fields: fieldShapes(reference.resident.executive_result),
      executive_state_fields: fieldShapes(reference.resident.executive_state),
      executive_contract: reference.resident.executive_contract,
      session: reference.resident.session,
      activation: "Acceptance is a complete first {choice,next_state,status,events}, not {refused:false}. If the normal step already initializes from fresh state and checks applicability, activate(frame,state,intent) may return step(frame,state,intent). Otherwise write a separate fresh applicability/initialization branch. Refusal is only {refused:true,reason}. Both are real first-live results, not discarded probes.",
      task_keys: "The next unused key is frame.executive.task_high_water+1 (first key1). Repeated ensure_task with the same key/request returns the original invocation or outcome; it never starts another. Retain its handle or use frame.executive.tasks; continue(handle) renews only that exact running task. Inspect fresh observations before deciding continue/cancel; a pending child does not block your decision function.",
      sensing: "player.position is feet; velocity is blocks per client tick. dynamic_entities.source is rendered_camera_capture: original render time/tick, render_invocation and capture_sequence name the completed framebuffer witness. Rows retain interpolated rendered pose, bounds and aim_position within r8; missing/stale render or leaving view denies live entity access, including old target handles. This is partial camera-bound evidence, not an all-around scan or absence certificate. Actual-heard coarse sound events remain independent and never unlock hidden entity geometry. visible_world contains only assisted cached terrain at500ms with original time/staleness. player.blocking is actual readiness, active_use is use progress, equipment.durability is actual own damage/maximum. mechanics distinguishes attack key consumption from doAttack entry, neither accepted damage nor kill. Inventory is client prediction, not goal evidence. Sound cursors, receipts and strategic RGB selection remain separately timed.",
      input_transitions: reference.resident.input_transitions,
      constraints: "Return all four fields. State/intent <=16KiB JSON; complete result/envelope/newline <=64KiB/depth32. All nine held booleans and selected_hotbar are required; selected_hotbar:null means no slot change, integer0..8 selects that slot. Omitted edges derive single held changes; explicit ordered edges remain exact, <=256 expanded presses/operations per input, release count1. Screen operations <=16. Events <=16 per step; summary1..1000characters, details JSON. Cumulative frame/step/edge/event limits still apply.",
      default_limits: reference.default_resident_limits,
      world_view: reference.world_view,
      semantic_aiming: reference.semantic_aiming,
      temporal_turn: {
        signature: reference.temporal_turn.signature,
        inputs: reference.temporal_turn.inputs,
        timing: reference.temporal_turn.timing,
        completion: reference.temporal_turn.completion,
      },
      temporal_tracking: reference.temporal_tracking,
      operations: reference.resident.operations,
      gui_completion: reference.resident.gui_completion,
      response: reference.resident.response,
      software_tests: reference.resident.software_tests,
      attention: reference.attention,
      buttons: "Minecraft1.21.4: held attack continues mining but does not repeat entity strikes. Additional strikes need fresh counted presses or press/release transitions. When already using an item, release-use and attack in one tick may consume the attack without invoking it; active_use and mechanics report the distinction. A shield needs at least five use ticks before blocking. Attack indicator is cooldown, not a damage receipt. Timing, tracking, target/equipment choice and shield tactics remain model-authored. Starting motion.turn anew for each moving target resets its profile; raw view rate is available for authored feedback tracking. A key ACK/callback is not damage, a kill or defense.",
    };
  }
  if (topic === "planning") return {
    next: schema(nextConfigSchema), prepare_next: schema(prepareNextSchema),
    authority: "Only main root start, run or step, authorizes one speculative flight and chooses manual or on_predecessor_success activation. The restricted planner can observe, inspect, help, write immutable inactive source and prepare one exact named candidate, but cannot start or submit playing work. prepare_next entry defaults run; step selects resident limits and optional initial_state, with fresh intent supplied by args. The original finite deadline includes authoring, planning, predecessor drain, fresh observation, optional guard and durable admission; staging never extends it.",
    guard: "Optional guard_source is an async BODY with only observation,args bindings and strict boolean return. No context/state/task/source/predecessor bindings. Omission adds no model gameplay constraint; fresh observation and all host invariants remain mandatory. False/error never authorizes effects. No automatic repair or retry.",
    activation: "Stop/Pause/death/task/session/generation changes invalidate authority. Only successful exact predecessor closure/drain permits a successor. Main can deliberately activate a manually prepared candidate. No replay of uncertain effects.",
    finite_procedure: "To resume an existing resident after a finite procedure, authorize next activation:'on_predecessor_success' and prepare that exact named controller/args in the planning flight before useful procedure work ends. A manual Stop is cancellation, not success, and cannot trigger this path. Intentional live replacement instead uses ordinary submit/start handoff.",
  };
  if (topic === "reflex") return {
    tool: "reflex", schema: schema(reflexSchema), decisions: schema(policyDecisionSchema),
    contract: "Named model-authored reactions, available in ordinary play but never automatically written or activated. Prefer operation:'submit' with your spec and finite trial/watch bounds: one call persists the exact version, validates effect-free and explicitly activates it. Source persistence, validation and activation are separate receipt facts; unknown is inspection evidence, never retry permission. Redelivery never repeats validation/activation or renews budgets. A same-name revised version replaces its prior selection only after successful validation. Separate write/inspect/validate/activate remain available; keep requires real trial evidence. JavaScript uses async BODY(context,state), isolated and bounded. Jev uses real provider selection, never a local fallback. Retire revokes and drains effects. Validation is not efficacy proof.",
    context: "context={observation,action,program,task}. observation is ObservationV3: adapter facts are under observation.data; use help game for its exact schema. action is the current legacy ActionView or null. program is the own unfinished foreground program {name,version,entry:'run'|'step',status} or null. A resident normally has action:null; this does NOT mean idle. Program presence/status is software lifecycle, not proof of applied input or useful progress. No raw program state, intent, source or authority is supplied.",
    monitoring: "An already activated JavaScript reflex evaluates fresh ordinary observations independently while an async program awaits a capability. Configure coverage in ordinary role before long work; inactive authoring cannot activate it. Semantic program leaves have priority 0; an unrelated reflex must select a strictly higher priority to preempt one. Observation latency, the selected interval and evaluation still bound reaction time. Use only actual observation fields; controller audible cursors and own-body fields are a separate contract.",
    state_and_return: "Initial state is an empty JSON object. Mutate that object in place to retain your bounded state after a successful evaluation (<=16KiB JSON/depth32); assigning a new local state variable does not replace it. Return a PolicyDecision DIRECTLY, not {decision,state}, a resident result or a function wrapper. No game/provider/host calls exist in JavaScript evaluation. continue leaves an admitted action running. replace requests one action through exclusive cancellation/retirement, including cancellation of your own pending response. A changing look target makes a new action, not a cheap retarget; repeated replacements consume trial actions. Use your authored state and current action feedback to distinguish a new transition from an ongoing response. interrupt/replan request cognition; neither itself defends or moves the player.",
    passive_watch: "Local JavaScript trial activation may include watch:{duration_ms,evaluations}: both explicit positive integers, at most 1800000ms and 100000 checks. Continue consumes only finite watch time/checks until the first valid non-continue decision starts the original max_ms/max_actions/max_evaluations trial; that triggering check counts toward trial exposure. Its deadline is also clipped to the original watch deadline. Count exhaustion stops new proposals but lets the last already admitted action settle within the original time bound; time expiry, Stop, retirement and life loss still revoke immediately. Reselection, pause/life suspension and repeated triggers never replenish either budget. No watch on keep or Jev. Omitting watch preserves immediate-trial behavior. Policy events expose phase, watch and trial accounting, including selection closure; inspect them through program_inspect events. A replace/interrupt uses existing exclusive cancellation and retirement barriers, not a second actor or automatic tactical choice.",
  };
  if (topic === "memory") return {
    tool: "memory", schema: schema(memorySchema),
    contract: "Catalog latest compatible snapshot per name with durable numeric revisions and paging. Load {name,version?} pins one exact snapshot, latest when omitted, then freshly validates its captured dependencies without restoring observations,args,targets or worker state. qualify requires the existing trusted bounded goal/block/inventory evidence declaration. No self-rating or automatic promotion. Older same-name revisions remain selectable explicitly.",
  };
  return {
    tools: ["observe", "program_write", "program_edit", "program_submit", "program_run", "program_inspect", "program_review", "reflex", "help"],
    lifecycle: {
      task_finish: schema(taskFinishSchema),
      contract: "Ordinary role and custom tasks only. Call task_finish with an evidence summary only when the WHOLE task is supported. It immediately revokes admission and stops all control; unverified means model-reported completion, never goal.verified, not unfinished work. It is not a progress, failure-report or end-of-turn tool: if work remains, keep useful bounded control and end the planning response without it. Program completed statuses are execution-only. Built-in goals cannot bypass their trusted verifier.",
    },
    topics: ["actions", "controller", "game", "programs", "planning", "reflex", "memory"],
    advanced: "Reflex is available in ordinary planning; read its reference before authoring. Request help memory to disclose that optional module. Help never grants playing authority to authoring, speculative or post-goal roles.",
    observation: "The observe tool returns permitted adapter projection data/metadata without host authority identities. Program game.observe() and guards use ObservationV3 with adapter-owned data. Historical schema2 artifacts are read-only. Arguments, results and detailed traces retain opaque JSON keys; byte-budget omissions remain explicit.",
    workflow: "Observe authorized state; submit a compact named taskflow with required args (null if unused), or intentionally write without starting and later run an existing version. Let admitted work proceed. Inspect exact source/outcomes/trace/feedback when useful. Revise with based_on equal to the latest stored version; program_edit can retain unchanged code instead of retyping it. card.reason describes motivation; omit top-level reason for ordinary revisions, or supply it only to link an experiment to that exact parent's actual outcome. Assessments are optional. Host preflight owns readiness, not a mandatory model bootstrap ceremony.",
  };
}

// Reference source only, not an injected worker binding or a gameplay strategy.
// The author supplies the intended predicate and a meaningful distinct choice.
export const LOCAL_FEEDBACK_EXAMPLE = `async function applyAndCheck(action, postcondition, chooseAlternative) {
  let observation = await game.observe();
  if (postcondition(observation))
    return {status:"completed",summary:"Postcondition already satisfied",result:{postcondition_met:true}};
  for (let attempt = 0; attempt < 2; attempt++) {
    const checked = await game.actionAndObserve(action);
    if (checked.observation) observation = checked.observation;
    if (checked.observation && postcondition(observation))
      return {status:"completed",summary:"Observed postcondition satisfied",result:{postcondition_met:true,action_status:checked.action.status}};
    const evidence = checked.action.evidence;
    const safe = checked.observation && checked.action.status === "failed" &&
      !checked.action.requires_reconnect && evidence?.neutralized === true &&
      (evidence?.world_effect_emitted === false || evidence?.failure_outcome_confirmed === true);
    if (!safe || attempt === 1)
      return {status:"blocked",summary:"Local postcondition not established",result:{postcondition_met:false,action_status:checked.action.status}};
    const alternative = chooseAlternative(observation, action);
    if (!alternative || JSON.stringify(alternative) === JSON.stringify(action))
      return {status:"blocked",summary:"No meaningful fresh alternative",result:{postcondition_met:false,action_status:checked.action.status}};
    action = alternative;
  }
}`;
