# Survival diagnostics

Prepared trials isolate one mechanic under declared starting conditions. They
do not prove random-world resource discovery or the combined
[Survival acceptance target](behavior.md). Diagnostic worlds can never become
continuation parents.

## Single-lane diagnostics

Single-lane diagnostics share the second execution slot (mutually exclusive
with `--parallel-world`; a primary ordinary run may continue beside them).
Watch them locally on `http://127.0.0.1:4382/`:

```sh
bun run watch:agent --diagnostic
```

| Command | Scope and declared setup |
| --- | --- |
| `bun run diagnose:pool 600` | Shore-cast Nether portal in a flat Normal Survival world beside a 7×6 one-block-deep lava pool (42 sources, tick 1000). Supplied hotbar: water bucket, flint and steel, stone pickaxe, 64 cobblestone, 8 cooked beef. No initial obsidian, frame, or diamonds. `PortalCaster` must cast all ten frame blocks without flooding, reclaim water, light the frame, and enter the Nether (verified via vanilla stats). |
| `bun run play:agent --diagnostic-reveal-ores <goal> <seconds>` | Ordinary-world diagnostic with disclosed ore-reveal assistance (`claimScope: "ore-assisted-diagnostic"`, `campaignProof: false`). Cannot feed `--continue-from` as an unassisted campaign. |
| `bun run play:agent <goal> <seconds> --replay-incident <RUN_BASENAME>` | Replays a closed ordinary save on the diagnostic lane with no fixture edits; see [recovery](recovery.md#incident-replay-diagnostic). |

## Parallel multi-scenario harnesses

Two standalone harnesses test v2 combat and high-drop descent across multiple
prepared terrains in parallel. Each scenario creates its own private `Xvfb`
display, ephemeral loopback port, isolated client directory, 30 fps `screen.mp4`
recording, and telemetry verification without using the shared admission
database or primary/parallel/diagnostic lane locks:

| Command | Source and coverage |
| --- | --- |
| `bun run diagnose:combat` | [`src/diagnostics/combat.ts`](../../src/diagnostics/combat.ts) — complex-terrain hostile combat, shielding, creeper kiting/blocking, retreat, and emergency shelter scenarios. Outputs to `local/survival-agent/combat-diagnostics/` (or `--out-dir` / `COMBAT_DIAG_OUT_DIR`). |
| `bun run diagnose:descent` | [`src/diagnostics/descent.ts`](../../src/diagnostics/descent.ts) — high-drop and giant-cave descent scenarios (water clutch/pour, boat drop, carved stairs, edge blocks, lava/unseen-floor refusal). Outputs to `local/survival-agent/descent-diagnostics/` (or `--out-dir` / `DESCENT_DIAG_OUT_DIR`). |

Pass `--list` to print scenario names, `--scenarios <names>` or `--single` to
filter, `--concurrency <n>` to cap parallel worlds, `--seconds <n>` to adjust
per-scenario wall time, and `--model PROVIDER/MODEL` to include live strategist
advice. Because these standalone batches bypass `storage.ts` admission, clean
up old diagnostic directories manually when finished.

## Java unit tests

Fast deterministic verification of v2 Java mechanics runs without launching
Minecraft:

```sh
sh mod/gradlew -p mod test
```

Current JUnit 5 suites under `mod/src/test/java/io/gameharness/survival/` cover
`CaveExplorerTest`, `CombatPlannerTest`, `InventoryTriageTest`,
`PortalCasterTest`, `SafeDescentTest`, and `TaskRunnerTest`.

## Reading stalls and claim limits

Inspect `outcome.json` → `pauseEvidence` together with 1× `screen.mp4` playback
to separate useful work, legitimate waits (such as smelting), obstructions, and
idle gaps. A moving camera, a completed craft, or a passing prepared scenario
never substitutes for fresh-world campaign evidence. Keep declared assistance,
starting kits, and failure counts attached to every diagnostic report.
