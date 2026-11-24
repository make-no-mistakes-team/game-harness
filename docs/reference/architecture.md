# Architecture and ownership

The primary product is an ordinary Java Survival player with an asynchronous model advisor. Model selection is provider-agnostic; authorization for a particular gameplay test does not restrict the product to that model. Local activity must remain purposeful without waiting for advice. See [Survival play](../survival/play.md) and [behavior](../survival/behavior.md). The generic generated-program GameHarness described here is a retained experimental system. Its model-authored policy boundary is not a restriction on the ordinary Java player's implementation.

## Generic GameHarness

The trusted core owns lifecycle, strategic scheduling, authorization, persistence and the action ledger. A trusted GameAdapter owns the raw connection, filtered observations, mechanical capabilities, authentic view and game-specific verification. Generated JavaScript requests bounded capabilities; it cannot mutate the game directly.

The strategist chooses procedures and repairs them. Disclosed helpers may execute selected movement, aiming, inventory transfers or recipes. Generic helpers must not conceal recursive gathering, combat strategy or task completion. Richer controllers require a declared assistance/comparator condition and provenance.

Minecraft Java 1.21.4/Fabric under Java 21 is the first implemented adapter. Descriptor negotiation does not deliver another game or arbitrary trusted-plugin loading. The [context](../architecture/c4-context.md) and [container](../architecture/c4-containers.md) diagrams describe this experimental system.

| Owner | Responsibility |
| --- | --- |
| `Runtime` | Lifecycle, goal and trusted observation authority; composition seam |
| `ActionArbiter` | Durable action admission, exclusive leaf-effect lease, retirement |
| `StrategicPlanner` | Serialized requests, wakes, bounded context and usage |
| `ReactiveRuntime` | Authored JS/Jev policies, trials and fenced preemption |
| `SourcePrograms` | Source validation, exact dependency closure and publication |
| `ProgramOperations` / `ProgramWorkspace` | Named authoring, execution, review and evidence use cases |
| `SkillManager` | Execution trees, shared budgets, workers and capability broker |
| `ControlSession` / `SessionEffects` | Executive decisions, keyed tasks, supervision and joined producer switching |
| `ResidentAnalysis` | Effect-free analysis beside local control |
| `ExperienceLibrary` | Compatible snapshots, fresh hydration and evidence-qualified reuse |
| Program evidence/history | Attributable outcomes, immutable revisions and bounded derived views |

Implementations live in [`src/server`](../../src/server/). DTOs and validators own exact fields; these pages explain invariants rather than maintaining a second API schema.

## Process boundaries

Default Runtime puts `StrategicPlanner`, actual SDK Agent callbacks and retained-context construction in one owned cognition process. The physical host retains native transport, capture/ACK handling, local-program supervision, action arbitration and retirement. An explicitly embedded Agent factory does not establish default-process isolation.

The cognition child reads canonical history readonly and submits bounded ordered metadata. Only the host writes canonical run state or admits tools. Request, turn, role, root, generation, scope and original deadline are checked before and after asynchronous work. A child snapshot cannot grant effects.

Operator history/source serialization and SSE publication have a separate readonly process. The authenticated host handles controls, including Stop, and forwards encoded publication bytes. Live publication permits one update in flight and one latest dirty state; binary video retains finite viewers and per-viewer backpressure.

The derived history writer is a separate owned process, started on first use. Canonical persistence and physical control still share the host. Isolating cognition/publication does not protect control from the host's own stalls.

Factories own partial-startup rollback and joined shutdown. SQLite construction closes partial resources on failure. Importing the server entry creates no application, lock or signal handlers.

## Language and deployment

The reference deployment is local Linux x64: Bun 1.3.14+, TypeScript orchestration, Electron renderer, Java Fabric perception/motors/capture, isolated JavaScript workers and SQLite/immutable files. These are implementation choices, not a supported-platform matrix.

Bounded versioned messages, deadlines, cancellation and authority checks define language-independent seams. A measured native optimization must preserve them; it cannot introduce a second skill format or bypass the adapter. TypeScript is not the per-tick gameplay motor.

Strategic inference, local execution and optional reactive evaluation have independent lifetimes. A provider wait owns no avatar lease. Only a leaf effect owns the foreground lease; parents awaiting children do not. Compatible channels may overlap inside one bounded composite action.

## Delivered and required

Current async `run` uses a bounded body; pure `step`, `analyze` and `library` support pinned local modules. Ordinary async modules with `run(game,args,checkpoint)` and durable serializable task checkpoints remain requirements. They do not grant packages, ambient files/network/processes or saved JavaScript stacks.

Current restart closes interrupted runs safely; it does not transparently continue them. General game checkpoint/reset/restore support, richer knowledge/search/startup bundles and another game require separate delivery evidence. See [recovery](recovery.md), [adapters](adapters.md), [experience](experience.md) and [runtime evidence](../evidence/runtime-processes.md).
