# Play ordinary Survival

The Java local player controls movement, mining, tools, inventory and survival.
A selected model can advise it asynchronously. Neither this implementation nor the
historical [integration evidence](../evidence/integration-gameplay.md) proves
diamonds and Nether entry in one fresh campaign. The required behavior and
claim boundary are in [behavior](behavior.md).

Complete [setup](../setup.md), including Minecraft 1.21.4, official Launcher
login, explicit EULA consent and server preparation.

```sh
bun run build:agent
bun run play:agent diamond 1800
```

The goal choices are `wooden_pickaxe`, `stone_pickaxe`, `iron_pickaxe`,
`diamond`, and `nether_portal`. Seconds bound this attempt's wall time,
including startup; the default is 900. The CLI accepts 1–2,147,483 seconds.
Only a verified result exits 0. Startup, recording, storage, heartbeat and
progress failures remain distinct outcomes.

## Add model advice

After connecting the app's OpenAI account:

```sh
bun run play:agent --strategy model --model PROVIDER/MODEL --macro-requests 8 diamond 1800
```

Replace `PROVIDER/MODEL` with a connected model's provider-qualified identifier.
Put strategy options **before** the goal and continuation flags **after**
the seconds argument. The default allowance is eight requests for this attempt.
Choose a finite positive allowance; request, wall-time, evidence and cleanup
accounting remain per attempt.

Ordinary model advice defaults to local control, live-observation startup and no
skill-trial worlds. The local player starts immediately and continues when
the advisor is slow, abstains, reaches its request limit or cannot connect.
Advice selects a method at a safe decision point; it cannot grant a click,
spend an item or require combat to wait. A native advice receipt establishes
method application, not resource acquisition.

Routine advice receives the goal, carried stock, health, hunger, activity and
available methods as text. Repeated local failures can add a private
first-person image and a short incident history. The exact transmitted image
is retained privately. Requests count toward account usage.

The desktop equivalent is **Settings → Minecraft Survival Agent**:
choose a goal and either model-free control or an available model advisor,
then **Start in new world**. The main view shows the actual client.
**Stop agent** saves and closes that run; **Choose goal** prepares another
fresh world. The desktop will not take over a terminal-owned ordinary run.
Its goal form is not a free-form task editor.

## Watch and inspect

In a second terminal:

```sh
bun run watch:agent
```

Open `http://127.0.0.1:4379/` on the same computer. The read-only stream follows
the private display and cursor; closing the tab does not stop recording.
Keep the tab open between attempts. Existing exported review links require
`bun run review:agent` on the same computer.

The runner prints the private attempt directory. Inspect `screen.mp4` at
normal speed, the finalized `outcome.json`, and receipts in `history.jsonl`
and `events.jsonl`. Never publish raw run paths or private payloads.
`pauseEvidence` identifies long stops and clusters of short ones;
provider overlap is separate from useful work. A moving camera or completed
craft does not prove natural pacing.

## Stop without discarding the save

Use the basename printed for this attempt, not a world path:

```sh
RUN_BASENAME='replace-with-the-printed-run-basename'
bun survival-agent/operator-stop.ts "$RUN_BASENAME"
```

Keep the launcher and its private display alive until they exit.
The command publishes a request; `operator_stop_accepted` is its runner receipt.
A clean operator stop exits 1 and records `closed` / `interrupted`.
If the server started, require `operatorStop.serverSaved: true` in the outcome
and `dimensionsSaved: true` with no escalation in `server_drained`.
Without these records, saving or cleanup is unconfirmed. Do not kill the
launcher/display and call it a clean stop.

Use [clean continuation or explicit recovery](recovery.md) for another attempt
in that campaign. Reaching an already completed goal by loading its save earns
no new win.

## Two independent worlds

The second slot can run an ordinary fresh world or clean continuation:

```sh
bun run play:agent --parallel-world --strategy model --model PROVIDER/MODEL --macro-requests 8 nether_portal 7200
bun run watch:agent --parallel-world
```

Its stream is `http://127.0.0.1:4383/`. Displays, worlds, inventory, recording
and run IDs are separate; neither player sees the other's world.
The second slot shares capacity with diagnostics and cannot combine with
recovery, incident replay or skill trials. Both slots share artifact accounting;
[`storage.ts`](../../survival-agent/storage.ts) owns admission details.
Development-run authorization and artifact policy are maintained separately in
[model runs](../development/model-runs.md).

A diamond in one world and Nether entry in the other do not satisfy the
same-campaign objective. Include unsuccessful attempts alongside any win.
Use [diagnostics](diagnostics.md) only for explicitly prepared or constrained
experiments; those are separate evidence classes.
