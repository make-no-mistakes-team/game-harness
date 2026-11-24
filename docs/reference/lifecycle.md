# Runs, sessions and player lives

These are generic GameHarness lifetimes. The ordinary Java Survival player has its own [operating guide](../survival/play.md).

| Term | Invariant |
| --- | --- |
| Run | One recorded attempt with task, model, world, selected snapshot and interventions |
| Session | One owned native connection, identified by session/world and connection epoch; can span runs and lives |
| World | Environment lineage; replacement creates a new world ID, restoration records a rollback branch |
| Epoch | Durable connection fence advanced before reconnect/recovery effects; ordinary new runs and respawns do not advance it |
| Life | Authoritative player incarnation; confirmed replacement advances life independently of session and space |
| Observation | Filtered evidence with original capture time/provenance, never permission to inspect hidden state |
| Action | Bounded ledger job with stable identity, preconditions, deadline and outcome |
| Lease | Exclusive foreground effect authority; at most one |
| Validation / trial | Software admissibility / bounded real gameplay use; neither is automatically efficacy |

## Readiness and life changes

The host preflight checks provider/isolation readiness, negotiated compatibility and fresh authoritative state. No model ceremony is required to reconfirm host-known facts. Initial alive readiness requires no screen, `overlay_present:false` and `world_input_events_ready:true`; null screen alone does not prove the vanilla loading overlay is gone. Missing diagnostics keep the connection pending. Saved-dead sessions remain available for explicit recovery without world-input readiness.

Native evidence owns `loading`, `alive`, `dead` and `respawning` transitions. Death retains the deceased ID; a confirmed replacement establishes another incarnation even if it dies before full inventory readiness. Dimension travel changes space, not life. Short authoritative teleports fence space without a coordinate-jump heuristic.

Normal death immediately revokes old-life targets, commands, JS/Jev/lookahead output and held inputs, drains affected work and wakes strategy once. It retains the healthy session, real DeathScreen video, active run and `game.error:null`. Startup and handlers never respawn automatically. Readonly observation/recipes remain available while dead/loading/respawning.

Only explicit authored `game.respawn()` or the equivalent ordinary action requests vanilla respawn through the sole arbiter. It checks DeathScreen readiness, requests once and awaits authoritative new-life health/world readiness. Timeout stays unknown without replay. Only the root linked to its own confirmed successful respawn can adopt that life; other old-life work stays fenced.

A late alive observation may update life after unknown respawn without rewriting that outcome. Replacement followed by death before readiness records a new dead life and unknown respawn, with no successful adoption. Saved-dead startup preserves `death:null` when no new death episode was observed. Readiness notices can update `can_respawn` without an action/read/reconnect or duplicate death event.

## Run controls

| State | Meaning and transitions |
| --- | --- |
| `created` | Preflight permits running; Stop or admission failure closes it |
| `bootstrapping` | Historical phase, not a current mandatory stage |
| `running` | May pause, recover, stop, review or finish; death alone does not change run state |
| `pausing` | Admission fenced; remains pending until neutralization or declared safety fence |
| `paused` | Safe agent-control state, not world freeze; explicit Resume needs prior-owner drain and fresh state |
| `recovering` | Reconciliation preserves prior Pause/Stop intent |
| `reviewing` | Bounded effect-free review after trusted verified goal |
| `stopping` | Neutralization and worker/planner/action drain pending |
| `stopped`, `completed`, `failed` | Terminal; later reconciliation evidence does not reopen effects |

Pause, Stop run, goal closure and model-reported custom completion revoke run authority and join actual native neutralization and emitter drain. Verified completion requires objective evidence and no live effect lease. A healthy session/video remains connected and the world keeps ticking; survival is not guaranteed. No effects occur while paused, stopped or reviewing. Resume creates fresh execution generations, never queued-command replay, old stacks or renewed allowances. Unconfirmed native/emitter drain additionally requires a fresh epoch; a changed native session/profile requires a new run.

Stop has highest priority. Duplicate requests share the pending barrier. Native retirement has one reserved slot through its drained ACK; expected-owner cleanup keeps its original owner, while global Stop uses explicit emergency authority and a matched-owner receipt. Missing/invalid ACKs fence emitters without fabricating safety or resolving past effects.

Stop world, world replacement and desktop close normally own game-process teardown. Genuine unconfirmable emitter/transport failure may require fail-closed termination. Neither death nor historical uncertainty alone justifies disconnecting a healthy session.

## Completion and history

Custom tasks default to no automatic verifier. `task_finish` requires a boolean: false records optional progress without changing control; true affirms the whole request, fences further inference/effects and returns stopping before ordinary drain. It is model-reported, unverified completion, not `goal.verified`, promotion or post-goal review. Identical calls retain their receipt; changed arguments under the same identity conflict.

Preset verifiers remain separate. `break_log` needs server-confirmed eligible log removal; `collect_wood` needs receipted own-inventory gain against the run-start baseline, preserved across death. A successful program is not whole-task success. Editing preset text switches to Custom even if the text is restored.

IDs are opaque, never paths/seeds/secrets or access grants. Events increase durably per run across epochs; observation sequences are compared with their epoch/scope. UTC is for human correlation. Local monotonic values are not subtractable across boots/processes.

Sources: [`contracts.ts`](../../src/shared/contracts.ts), [`control.ts`](../../src/shared/control.ts), [`observations.ts`](../../src/shared/observations.ts), [`Runtime`](../../src/server/runtime.ts). See [action authority](actions.md), [recovery](recovery.md) and [operations](operations.md).
