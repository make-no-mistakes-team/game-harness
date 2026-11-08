import { z } from "zod";
import type { RuntimeAdapter } from "../shared/contracts.ts";
import { getGameAPIReference, policyDecisionSchema } from "../shared/validation.ts";
import { DEFAULT_SKILL_LIMITS, PROGRAM_RESULT_GUIDANCE } from "../shared/programs.ts";
import { PROGRAM_LIMITS } from "./program-validation.ts";
import { controllerStepResultSchema, DEFAULT_RESIDENT_LIMITS, RESIDENT_STEP_RESPONSE_MS } from "../shared/resident.ts";
import { helpSchema, memorySchema, nextConfigSchema, prepareNextSchema, programInspectSchema, programReviewSchema, programRunSchema, programSubmitSchema, programWriteSchema, reflexSchema, taskFinishSchema } from "./program-interface.ts";
import { RuntimeFault } from "./runtime-fault.ts";

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
    write: schema(programWriteSchema), submit: schema(programSubmitSchema), run: schema(programRunSchema), inspect: schema(programInspectSchema), review: schema(programReviewSchema),
    body: "Select entry explicitly; omitted actor entry defaults to run only. run source is an async JavaScript function BODY with game,args, no wrapper/import/export, awaiting one capability at a time and returning {status:'completed'|'blocked'|'failed',summary:string,result:JSON}. step/analyze source is an ordinary module with exactly one synchronous named function export: step(frame,state,intent) or analyze(input). Pure helpers/constants and comments are allowed; imports/packages/ambient host access are not. Original and canonical source each remain <=16 KiB UTF-8; structural metrics are descriptive. A selected entry is immutable, never guessed from source or retried as another format.",
    world_view: "Common to ordinary world_input and resident streams. delta is relative radians applied once at step/snapshot entry, not spread over its duration. rate is radians/sec; each actual client simulation tick applies rate * 0.05, not render or wall time. Positive yaw turns right: 0 faces +Z, +pi/2 faces -X, -pi/2 faces +X. Positive pitch is up. Actual body/ACK applied_pose wraps yaw to [-pi,pi) and clamps pitch to [-pi/2,pi/2] under vanilla player/vehicle constraints; a request is not applied-pose evidence. An ordinary rate lasts for the step's ticks, followed by the next step or final cleanup. A stream retains its view rate between commands, even after its input ACK, until replaced, cleared by a screen transition or control retires/expires. Submit unchanged or zero rate when rotation should stop; neutral held or silence alone does not stop a prior rate. Stop clears owned held input and pending presses without undoing rotation or prior effects. Held transitions and explicit counted presses remain separate.",
    target_transitions: "Author bounded temporal turns across target changes. In step/analyze, motion.turn is an available deterministic pure math binding, not a game capability; see temporal_turn. Prefer an explicit short turn profile to fixed tiny per-frame deltas or prolonged low-rate plateaus. Choose the orientation, duration and rate cap yourself, using fresh permitted evidence and actual applied pose. A full target-error delta still applies immediately; raw inputs do not smooth it. Wrapped yaw is not a physical full turn. No target acquisition, retries or alignment promise is added.",
    temporal_turn: {
      signature: "motion.turn({native_tick,pose:{yaw_radians,pitch_radians},target:{yaw_radians,pitch_radians},duration_ticks,max_rate,tolerance?},state=null) -> {view,state,finished,aligned,error:{yaw_radians,pitch_radians}}",
      availability: "Frozen pure math binding in synchronous step/analyze; no import, game call, dependency or extra export. No host access, clock, observations, target acquisition, movement or internal mutable state.",
      inputs: "Use frame.native_tick and frame.view.applied_pose. Choose duration_ticks (positive integer 50ms client ticks) and required max_rate (per-axis rad/sec in (0,20*pi]); neither has a default. tolerance defaults 0.01 radians, range [0,pi]. Numbers finite; native_tick nonnegative safe integer; pose pitch valid. Target pitch clamps [-pi/2,pi/2]; yaw takes shortest wrapped path. Pass null or prior returned state, explicitly retained in next_state; invalid input/state throws.",
      timing: "Cubic acceleration/braking reference; raw rate corrects next-tick reference against actual pose, capped by max_rate. Sample fresh native ticks, normally 20Hz; same-tick calls do not advance. Delays/skips, low frequency or inadequate duration/rate may miss alignment. Changed target/duration, null state or regressed tick rebases from actual pose; noisy target updates restart. Keep target/duration stable. Rate/tolerance changes alone do not restart.",
      completion: "Apply view:{kind:'rate',yaw_radians_per_second,pitch_radians_per_second} as ordinary world input; raw inputs never smooth themselves. At duration, zero rates and finished:true even if missed. aligned reports current actual-pose tolerance, not input application, target hit or task success. No automatic extension, retry or action. Retain state each frame; continue submitting/checking and explicitly choose another turn only as your taskflow warrants.",
      example: `export function step(frame,state,intent) {
  const turn = motion.turn({native_tick:frame.native_tick,pose:frame.view.applied_pose,
    target:intent.orientation,duration_ticks:intent.turn_ticks,max_rate:intent.max_turn_rate},state?.turn ?? null);
  return {input:{kind:"world",held:{forward:false,back:false,left:false,right:false,jump:false,
    sprint:false,sneak:false,attack:false,use:false},view:turn.view,selected_hotbar:null},
    next_state:{turn:turn.state},status:"running",events:[]};
}`,
      example_scope: "A math/neutral-input illustration, not a useful complete gameplay controller. The model supplies intent orientation/timing/rate, integrates transitions with its taskflow and chooses when to finish. Omitted edges mechanically release any previously submitted held controls; no gameplay decision is added.",
    },
    resident: {
      result: z.toJSONSchema(controllerStepResultSchema, { unrepresentable: "any", io: "output" }),
      response: {
        max_host_response_ms: RESIDENT_STEP_RESPONSE_MS,
        contract: "step_ms bounds isolated evaluation including serialization, not host IPC/scheduling delay. Host response wait never extends the original root deadline and sends no heartbeat. A returned running decision must still pass native150ms capture freshness and exact scope/intent checks before renewal/state publication. timings.step_ms is host round-trip wall time, not CPU.",
      },
      contract: "step has no game/native/provider/job capability. It receives the registered Minecraft controller frame, explicit JSON state and intent; args is initial intent, initial_state defaults null. Return one coherent input, next_state, status and events; never a Promise. State and intent <=16 KiB JSON UTF-8/depth32; complete result/envelope/newline <=64 KiB. Processed state is not submitted or applied input: frame.last_input and later effect_updates retain actual native acknowledgment and separate receipts. Fresh valid steps renew only the short native lease, never the original root deadline. Blocked/yielded/completed retires this execution; only a successful drained predecessor and explicit next permission may activate a prepared successor. No implicit rescue. Stop waits for worker/jobs and actual native retirement.",
      operations: "program_run start entry step requires matching source and resident limits. Optional handoff:{name,version,execution_ordinal} pins the exact latest predecessor, live or naturally succeeded; submit/start requires confirmed retirement and fresh scope, without a cloud Stop/Start round. Resident predecessors retire immediately. Semantic run predecessors fence future capabilities after preflight and retire after only the current admitted bounded capability settles. Stop/tool abort revoke immediately and refuse the successor. Blocked/cancelled/failed/unknown or superseded predecessors are refused. Optional next prepares a successor after natural successful completion, not cancellation. Inspect intent_version (initially0) before update_intent; an in-flight old-intent result is discarded. Pure analyze never changes intent or input automatically. Only run sources can declare playing child dependencies.",
      input_transitions: "Supply all nine desired world held booleans and normally omit edges. The host derives one press/release per changed boolean from the last successfully submitted state, initially neutral, not the lagging native ACK. Unchanged held attack/use never adds another click. Explicit edges instead preserve exact counted presses and order: every held change then needs its matching press/release (release count one). An explicit inconsistent list, including [], is rejected, never repaired. Retain submitted held in next_state only when constructing explicit transitions; do not use frame.last_input as that baseline. Before screen input, submit neutral world held, with edges omitted or exact releases. A non-running result retires without submitting its input. Normal outcome feedback includes a bounded resident failure diagnostic; execution inspection retains full details.",
      gui_completion: "A visible GUI gesture can span several ticks. A changed cursor or slot is not proof that the preceding input finished. Keep the resident running with empty screen operations while awaiting its actual correlated input acknowledgment and terminal effect_updates receipt before submitting a dependent GUI operation. Receipts retain their input sequence; do not guess completion from a fixed sleep or replay an unknown operation. Fresh screen identity and local cursor/slot predicates remain required.",
      sensing: "Use the controller_frame capability schema in help topic game for frame contents. Input uses ordinary world held/edges/view/selection or current visible-screen operations, not tactical helpers. All source, life, native boot, space, screen and native-age checks remain host-owned.",
    },
    result: PROGRAM_RESULT_GUIDANCE,
    completion: "A program's completed status is execution-only, not task success. For a custom task, call the separate ordinary-only task_finish lifecycle tool as soon as actual authorized evidence shows the whole task done; do not run another no-op/check or review loop. It stops the run with an unverified model report. Built-in goals still require independent trusted verification.",
    composition: "program_write/program_submit dependencies list only already authored named programs for game.call({name,version?},args). The host pins their exact validated versions; omitted version requires an unambiguous captured name, never a new latest version. Native reads are direct positional game.<binding>(...parameters) methods listed by help topic game, not named program calls or dependency declarations. Their capability_id/version are trusted metadata, not a NamedProgramRef or extra arguments.",
    local_feedback: "game.actionAndObserve(action) preserves the raw result; observes only without requires_reconnect after succeeded, or failed with neutralized:true and (world_effect_emitted:false or failure_outcome_confirmed:true). This native-owned boolean is not an action argument/capability. Settled failure may include attempted input, partial movement and other world changes. Check your own postcondition before bounded fresh selection; feedback grants no goal success, retry or unknown-action replay. Both calls use existing budgets/authority; revocation throws. Other outcomes give observation:null.",
    local_feedback_example: LOCAL_FEEDBACK_EXAMPLE,
    attention: "run may await game.attention({urgency:'ordinary'|'urgent',summary,details}) to request cognition while continuing local work. It returns void and charges existing root max_calls, not an action. game.progress only retains notes. See help game for the exact ProgramAttention schema and authority contract.",
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
      launch: "program_submit({entry:'step',name,source,args:null}) writes and starts exact source exporting one synchronous step(frame,state,intent). Required args is JSON initial intent. initial_state defaults null; limits accepts individual overrides. Helpers/constants are allowed; imports and game calls are not. Keep useful local transitions running while requesting attention; blocked means the algorithm cannot continue, not that one input finished.",
      frame_fields: fieldShapes(frame.result.schema),
      result_fields: fieldShapes(reference.resident.result),
      sensing: "player.position is feet; velocity is blocks per client tick. visible_world is separately acquired assisted r8 geometry, normally refreshed every500ms and stale after1000ms, not a20Hz enemy tracker. Block positions are cell centers; entity positions are origins, not supplied body heights. Inventory is client prediction, not server-confirmed goal evidence. Current view/crosshair, audio cursor and later receipts have separate capture times; no atomic RGB alignment.",
      input_transitions: reference.resident.input_transitions,
      constraints: "Return all four fields. State/intent <=16KiB JSON; complete result/envelope/newline <=64KiB/depth32. All nine held booleans and selected_hotbar are required; selected_hotbar:null means no slot change, integer0..8 selects that slot. Omitted edges derive single held changes; explicit ordered edges remain exact, <=256 expanded presses/operations per input, release count1. Screen operations <=16. Events <=16 per step; summary1..1000characters, details JSON. Cumulative frame/step/edge/event limits still apply.",
      default_limits: reference.default_resident_limits,
      world_view: reference.world_view,
      temporal_turn: {
        signature: reference.temporal_turn.signature,
        inputs: reference.temporal_turn.inputs,
        timing: reference.temporal_turn.timing,
        completion: reference.temporal_turn.completion,
      },
      operations: reference.resident.operations,
      gui_completion: reference.resident.gui_completion,
      response: reference.resident.response,
      buttons: "Ordinary vanilla semantics: held attack continues block breaking, but does not repeatedly strike entities. Each deliberate additional entity strike requires a fresh attack press edge; use/attack decisions, timing, view and equipment remain yours. Held use supports ongoing vanilla item/offhand use. Press counts are explicit, not inferred from a held boolean. A successful input ACK is not evidence of damage, a kill, block break or defense.",
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
    tools: ["observe", "program_write", "program_submit", "program_run", "program_inspect", "program_review", "reflex", "help"],
    lifecycle: {
      task_finish: schema(taskFinishSchema),
      contract: "Separate from the gameplay/program verbs. Ordinary role and custom tasks only. As soon as actual authorized evidence shows the whole task complete, call task_finish with a brief evidence summary instead of more no-op/check programs or review. It immediately revokes admission and stops the run; completion is model-reported and unverified, never goal.verified. Program completed statuses are execution-only. Built-in goals cannot bypass their trusted verifier.",
    },
    topics: ["actions", "controller", "game", "programs", "planning", "reflex", "memory"],
    advanced: "Reflex is available in ordinary planning; read its reference before authoring. Request help memory to disclose that optional module. Help never grants playing authority to authoring, speculative or post-goal roles.",
    observation: "The observe tool returns permitted adapter projection data/metadata without host authority identities. Program game.observe() and guards use ObservationV3 with adapter-owned data. Historical schema2 artifacts are read-only. Arguments, results and detailed traces retain opaque JSON keys; byte-budget omissions remain explicit.",
    workflow: "Observe authorized state; submit a compact named taskflow with required args (null if unused), or intentionally write without starting and later run an existing version. Let admitted work proceed. Inspect exact source/outcomes/trace/feedback when useful. Revise with based_on equal to the latest stored version. card.reason describes motivation; omit top-level reason for ordinary revisions, or supply it only to link an experiment to that exact parent's actual outcome. Assessments are optional. Host preflight owns readiness, not a mandatory model bootstrap ceremony.",
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
