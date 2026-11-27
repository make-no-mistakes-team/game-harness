# Continue or recover a Survival campaign

A new attempt can copy a recorded ordinary world from this checkout. It never
accepts an arbitrary external directory, imports a seed or map, or replays an
unfinished command. Always pass the printed **run basename** under the same
official Launcher profile.

## Clean continuation

After a wall-time expiry or a
[confirmed clean stop](play.md#stop-without-losing-the-save):

```sh
RUN_BASENAME='replace-with-the-closed-run-basename'
bun run play:agent --strategy model --model PROVIDER/MODEL --macro-requests 160 nether_portal 3600 --continue-from "$RUN_BASENAME"
```

The parent must be a recorded ordinary Survival attempt whose server exited
cleanly and whose declaration carries campaign provenance (prepared diagnostics
and `--diagnostic-reveal-ores` runs cannot be continued as ordinary campaigns).
The runner copies the vanilla world, inventory, and statistics into a fresh
attempt directory with new server and recording owners.

The new attempt records `world.fresh: false` and `world.parentRun`. Saved
vanilla statistics corroborate cumulative progress across the chain, but a
continued win is never reported as an uninterrupted fresh-world win. Reloading
an already satisfied goal earns no new credit.

## Host-reboot autosave recovery

If a host reboot prevented clean closure, recover on the next launch with:

```sh
bun run play:agent diamond 1800 --recover-crash-autosave "$RUN_BASENAME"
```

The runner copies the latest eligible vanilla autosave into a new attempt while
leaving the interrupted directory untouched. Only what Minecraft actually saved
to disk survives; video may show later progress that never flushed. Prior goal
claims and lifecycle receipts do not transfer. Once the recovered attempt
closes cleanly, switch back to `--continue-from`.

## Same-boot orphan recovery

When a primary runner process dies without a host reboot, its incomplete run
cannot use `--continue-from`. Same-boot recovery requires the original run to
have launched inside an isolated **systemd user scope** (including transient
scopes):

```sh
export SURVIVAL_AGENT_ORPHAN_SCOPE='replace-with-the-original-user-scope.scope'
bun run play:agent diamond 1800 --recover-orphan-autosave "$RUN_BASENAME"
```

Launch on a separate private display (handled automatically by `play:agent`,
including nested `TMPDIR` Xauthority files). Before copying,
[`src/agent/orphan-source.ts`](../../src/agent/orphan-source.ts) proves that
the exact original scope has stopped, checks read-only client asset links and
indices, and acquires the vanilla world lock. Merely checking that a process
name is absent is insufficient. An unrelated `--parallel-world` slot can keep
running untouched.

Lost unsaved progress stays lost; no in-memory state, pending plan, or prior
claim carries over. Crash and orphan recovery cannot combine with
`--parallel-world`.

## Verified orphan reservation release

If an orphaned run is **not** going to be recovered (or after its scope has
stopped and left a lingering storage reservation), release the reservation
explicitly rather than editing SQLite by hand:

```sh
bun run release-orphan "$RUN_BASENAME" --scope "$SURVIVAL_AGENT_ORPHAN_SCOPE"
```

[`src/agent/release-orphan.ts`](../../src/agent/release-orphan.ts) verifies the
stopped scope through the same ownership proof as orphan recovery, then calls
`releaseOrphanReservation` in [`src/agent/storage.ts`](../../src/agent/storage.ts)
so artifact accounting and slot locks clear without corrupting active runs.

## Incident replay (diagnostic)

To reproduce a bug from a closed ordinary save without touching campaign
accounting:

```sh
bun run play:agent nether_portal 180 --replay-incident "$RUN_BASENAME"
bun run watch:agent --diagnostic
```

Incident replay runs on the diagnostic lane (`http://127.0.0.1:4382/`) with no
fixture edits and records `world.type: "vanilla-incident-replay"` and
`world.fresh: false`. It cannot combine with model strategy flags, and its save
cannot become a continuation parent. See [`src/agent/run.ts`](../../src/agent/run.ts)
and [`src/agent/crash-autosave.ts`](../../src/agent/crash-autosave.ts) for
exact admission checks.
