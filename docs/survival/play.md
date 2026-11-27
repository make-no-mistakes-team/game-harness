# Play ordinary Survival

The Fabric 1.21.4 local player handles movement, mining, crafting, combat,
descent, and portal construction. A configured model can advise it
asynchronously. Neither the implementation nor retained
[Survival evidence](../evidence/survival.md) proves diamonds and Nether entry
in one fresh campaign yet; see [behavior](behavior.md) for the acceptance bar.

Complete [setup](../setup.md) first (Minecraft 1.21.4, official Launcher login,
explicit EULA consent, and server download).

```sh
bun run build:agent
bun run play:agent diamond 1800
```

Available goals (owned by [`src/shared/goals.ts`](../../src/shared/goals.ts)):
`wooden_pickaxe`, `stone_pickaxe`, `iron_pickaxe`, `diamond`,
`diamond_pickaxe`, and `nether_portal`. The final numeric argument bounds wall
time in seconds including startup (default `900`, up to `2,147,483`). Only a
verified goal exits `0`; startup, recording, storage, heartbeat, and progress
failures report distinct exit states.

## Add asynchronous model advice

After connecting a supported model account in the desktop launcher:

```sh
bun run play:agent --strategy model --model PROVIDER/MODEL --macro-requests 160 diamond 7200
```

Replace `PROVIDER/MODEL` with a connected provider-qualified model identifier.
Place strategy flags **before** the goal and continuation/recovery flags
**after** the seconds argument. The default request budget is `8`; always set a
finite positive limit per attempt.

Local execution starts immediately and keeps playing if the strategist is slow,
abstains, hits its request cap, or loses connectivity. Advice selects a macro
task or target direction at safe transitions via `StrategistBridge`; it cannot
inject raw clicks, spend items directly, or pause combat reflexes. Routine
prompts send goal, inventory, health, hunger, status, and available methods as
text; repeated stalls can attach a private first-person frame. Requests count
toward account usage.

## Minimal desktop launcher and viewer

Run `bun run start` (or `bun run dev` / `bun run desktop`) to open the minimal
desktop launcher. It handles provider login, Minecraft EULA consent, server
preparation, goal/strategy selection, start/stop controls, and a read-only live
view of the active client. It will not take over an already running CLI
attempt.

## Watch and inspect runs

In a second terminal:

```sh
bun run watch:agent
```

Open `http://127.0.0.1:4379/` locally. Closing the browser tab never stops
recording; keep it open across attempts. To view exported review packages
locally, run `bun run review:agent`.

Each launch prints its private attempt directory under `local/survival-agent/`.
Inspect `screen.mp4` at 1× speed alongside `outcome.json`, `events.jsonl`, and
`history.jsonl`. Never commit or publish raw run paths or payloads.
`pauseEvidence` flags long stalls and clusters of short stops separately from
provider overlap.

## Stop without losing the save

Use the printed **run basename** (not a filesystem path):

```sh
RUN_BASENAME='replace-with-the-printed-run-basename'
bun run stop:agent "$RUN_BASENAME"
```

Wait for the launcher and its private display to exit cleanly. The script
([`src/agent/operator-stop.ts`](../../src/agent/operator-stop.ts)) posts a stop
request; the runner acknowledges it with `operator_stop_accepted`, exits `1`,
and records `closed` / `interrupted`. Confirm `operatorStop.serverSaved: true`
in `outcome.json` and `dimensionsSaved: true` with no escalation in
`server_drained`. Killing the launcher or display directly leaves save closure
unconfirmed.

To continue or recover a saved campaign, follow [recovery](recovery.md).
Reloading a save that already finished the requested goal never earns a new
win.

## Two independent worlds

Run a second fresh or cleanly continued Survival world in parallel:

```sh
bun run play:agent --parallel-world --strategy model --model PROVIDER/MODEL --macro-requests 160 nether_portal 7200
bun run watch:agent --parallel-world
```

The second slot streams on `http://127.0.0.1:4383/` with its own display,
world, inventory, recording, and run ID. It shares capacity with single-lane
diagnostics and cannot combine with crash/orphan recovery or incident replay.
Both slots share artifact accounting owned by
[`src/agent/storage.ts`](../../src/agent/storage.ts) and governed by
[model runs](../development/model-runs.md).

A diamond in one world and Nether entry in another do not satisfy the
same-campaign target. Report failed attempts alongside successes, and keep
[diagnostics](diagnostics.md) separate from campaign claims.
