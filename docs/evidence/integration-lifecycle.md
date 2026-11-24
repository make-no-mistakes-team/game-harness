# Integration evidence: ownership, death and closure

All results here used explicit diagnostic agents/controllers and zero
provider/Jev calls unless linked to a separately labeled real-model episode.
They qualify exercised lifecycle paths, not ordinary gameplay or full I01.
Historical disconnect-on-death, run-stop client exit and startup respawn were
superseded by the generic runtime's [three lifetimes](../reference/lifecycle.md).
They are not instructions for current Survival [save recovery](../survival/recovery.md).

## Early terminal-death and owner-loss cohorts

On `9b6abf1a…`, an evaluator killed a real health-20 player during movement.
The first cause stayed “player died”; the action stayed unknown/reconnect.
Client exit followed in 234 ms. A 1,500 ms hold saw no automatic restart,
respawn or new frames. Explicit connection to the same world rotated authority,
advanced epoch 1→2 and reached health 20 in 9,196 ms through ordinary
rejoin/respawn. Cleanup closed. Exact respawn packet count was unmeasured;
an at-most-one startup predicate was not a measured one-packet result.

The subsequent [warm gameplay attempt](integration-gameplay.md) exposed an
actual teardown failure lasting over nine minutes after death.
In the corrected full Runtime/Fabric/Docker/Store/SkillManager/arbiter fixture
on `a119…`, evaluator death followed a motor tick during two-second movement.
Paused arrived in 375 ms **after** client closure and zero workers.
Cause/error and unknown root/action remained; confirmed neutralization
described emitter closure, never rollback. A 1,500 ms hold had no frames,
automatic reconnects or model-call events. Explicit Stop then settled with
cleanup confirmed. That pass did not relabel the failed warm episode.

A real app restart retained the stopped run, original cause and qualified exact
snapshot, without automatic game/model start. Explicit start joined the saved
dead world through that cohort's ordinary respawn at health 20/epoch 14.
Game stop took 1,695 ms, leaving no false EOF fault, video idle and server stopped;
another explicit start reached epoch 15.
Owner-loss used an independently surviving Python service leader and pidfd
identities. Killing Electron produced exits at 9 ms Electron, 145 ms client,
1,386 ms server and 1,414 ms backend; the leader survived.
The server exited before backend completion in this case.
An earlier hung TCP observer was not valid 45-second failure/pass evidence.
These were zero-provider closure observations, not useful warm-task proof.

## Connected-death schema-2/r2 cohorts

The first `f1f0848c…` fixture received 159 frames from an alive health-20 player,
but evaluator platform construction failed with **“That position is not loaded”**
and the player fell. No death case began; cleanup closed.
It was a failed setup, not a product death/respawn result.
A later dead-session observation retained video and `game.error:null`, but
a mapped-class-name string probe failed. The corrected stable instance check
identified `net.minecraft.class_418`; this was a fixture defect.

On `06ff7983…`, two accepted dead holds each retained 68 frames over 2,242 ms.
Explicit diagnostic respawn reached health 20 in 154.8 and 238.5 ms.
The integrated Runtime/native/Docker/Store/Bridge recovery fixture passed in
95.61 s with same session/client/epoch and confirmed new life.
These two samples were not latency percentiles or model-selected recovery.
The separate actual Luna recovery experiment is
[model evidence](integration-gameplay-planning.md#death-recovery).

## Emission classification and saved-dead startup

The `6aaf8004…` fixture separated out-of-reach preflight from genuine effects:
dig refusal retained `world_effect_emitted:false`, `camera_changed:false`
and unchanged blocks; fresh reads/look worked without reconnect.
An actually emitted movement cancellation stayed unknown with
`world_effect_emitted:true` and `neutralized:true`.
No historical unknown was rewritten.

Saved-dead startup relaunched the same world with a new process/session,
epoch 2, health 0, dead and `death:null`, without NBT editing, driver respawn
or automatic respawn. Connection took 8,823.74 ms; a 2,242.16 ms hold received
67 new frames and rejected ordinary effects. The fixture passed with cleanup.
Initial Electron inspection exposed stale `can_respawn:false` and a misleading
waiting caption despite real DeathScreen imagery.

On the later `f376…` correction, HTTP-only snapshots observed
`can_respawn:false`→`true` for the same saved-dead session/life 1 and unchanged
observation timestamp, without actions, provider auth, model or run.
Actual 1440×900 and 1000×650 captures showed vanilla death menu, authentic
hand/HUD, `game.error:null`, **“Life 1 · dead · no active run”**, five unknown
usage counters and no global overflow. Sampled draw cadence was 31 then 30 FPS,
not a sustained guarantee.

## Root and direct-policy handoff

An initial root-to-JS reaction fixture cancelled movement, kept its unknown
effect and awaited worker closure/native neutralization before a selected look.
Same healthy session/life/run and peak one effect owner were retained.
Review then found a separate no-root policy-retirement race; this initial pass
did not close I05/P07 or all preemption.

After correction, the extended fixture first failed before direct-policy motion:
its finite-trial payload was rejected `invalid_request`. Resource cleanup was
true but runtime cleanup false masked that primary evaluator error.
This was neither a direct-policy pass nor a production retirement failure.

The corrected repeat passed both cases in 69.70 s: root movement→JS look, and
lower-priority policy movement→higher-priority JS look without a root worker.
Cancellation kept unknown effects; action-pump retirement/lease advancement
preceded the final native barrier and replacement followed its ACK.
Peak ownership stayed one; runtime/resource cleanup closed.
No experience was loaded. This is exercised handoff, not real Jev,
model-authored reaction or complete preemption coverage.

## Manual and automatic planning fixtures

The pre-cutover three-case manual baseline passed in 86.41 s on `f376…`:
positive, false predicate and Stop revocation, with isolated predicate,
synthetic strategic caller and no experience.
The eight-case continuation repetition added staging before/after predecessor
closure, false/omitted guards and Stop during held independent inference.
Peak effect ownership stayed one and cleanup closed.
An initial SDK-hook caller missing full tool-call context failed before
program/native effects; a corrected typed-context repeat passed without bypass.

A separate public eight-case native suite passed in 104.05 s before the
provider-strictness correction, using the same artifact without rebuilding.
These were real Fabric/Docker/Runtime/Store infrastructure checks, not natural
model decisions, tick-rate control, promotion or reduced latency.
