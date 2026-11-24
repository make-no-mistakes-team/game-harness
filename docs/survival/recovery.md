# Continue or recover a Survival campaign

A new attempt can copy a recorded world. It never accepts an arbitrary external
world path, imports a seed/map, or replays an unfinished command.
Use the same official Launcher profile and the printed **run basename**.

## Clean continuation

After a time limit or [confirmed clean stop](play.md#stop-without-discarding-the-save):

```sh
RUN_BASENAME='replace-with-the-closed-run-basename'
bun run play:agent --strategy model --model PROVIDER/MODEL --macro-requests 8 nether_portal 3600 --continue-from "$RUN_BASENAME"
```

The parent must be a recorded ordinary agent attempt with clean server exit.
Retry an unfinished goal or advance to a later one; reloading an already
achieved goal does not count as another win.
The runner copies the vanilla world, inventory and statistics into a new
attempt and starts new recording/server owners.

Only the agent's own observed route and confirmed workstation clues can carry
over as navigation memory. A clean ordinary Overworld save can retain a walked
exit toward confirmed woodland. Every next step is checked again from current
footing. Protected stock and paid-furnace clues may survive compatible clean
continuation; no executable command does.

The declaration/outcome mark `world.fresh: false` and `world.parentRun`.
Saved statistics can corroborate progress along that chain, but a continued
win is not an uninterrupted fresh-attempt result. Omit continuation for the
fresh-world benchmark; preserve the chain for same-campaign accounting.

## Host-reboot autosave recovery

If a host reboot prevented closure, use the explicit recovery flag on the
first launch afterward:

```sh
bun run play:agent diamond 1800 --recover-crash-autosave "$RUN_BASENAME"
```

The runner copies the latest eligible recorded vanilla autosave to a new
attempt and leaves the interrupted attempt untouched.
The recording can show more progress than Minecraft saved. Only the loaded
inventory, position and world count. Prior goal claims and lifecycle evidence
do not transfer, and this path does not import the clean-save route memory.
After this attempt closes normally, return to `--continue-from`.

## Same-boot orphan recovery

An ordinary parent whose runner died without reboot still fails the clean
continuation requirement. Recovery is available when the original primary run
was started in an isolated **user systemd scope**:

```sh
export SURVIVAL_AGENT_ORPHAN_SCOPE='replace-with-the-original-user-scope.scope'
bun run play:agent diamond 1800 --recover-orphan-autosave "$RUN_BASENAME"
```

Start on a different private display, as the `play:agent` wrapper does.
The runner must prove the exact original scope stopped and hold the vanilla
world lock while copying. Merely finding no process with a familiar name is
insufficient. An unrelated second-slot world can keep running.
This recovery imports no agent memory, pending work, prior claim or lifecycle
evidence. Lost progress remains lost; it does not supply a missing result.

Recovery cannot combine with `--parallel-world`; orphan recovery also forbids
skill trials. Consult the current
[`run.ts` CLI](../../survival-agent/run.ts) and
[`crash-autosave.ts`](../../survival-agent/crash-autosave.ts) /
[`orphan-source.ts`](../../survival-agent/orphan-source.ts) for admission rules.

## Incident replay is diagnostic

To examine an incident from a closed ordinary save:

```sh
bun run play:agent nether_portal 180 --replay-incident "$RUN_BASENAME"
bun run watch:agent --diagnostic
```

This copy uses the diagnostic lane, with no fixture setup. It records
`world.type: "vanilla-incident-replay"`, `world.fresh: false` and its parent.
Stopping after reproducing an incident is not goal completion.
Model strategy flags do not combine with incident replay.
Prepared diagnostic worlds cannot be continuation parents.

Do not confuse this with the experimental generic runtime's
[restart and uncertainty recovery](../reference/recovery.md): retained program
history is not a saved JavaScript stack or transparent world checkpoint.
