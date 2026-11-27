# Architecture and ownership

GameHarness pairs a local Java 21 Fabric 1.21.4 Survival player with an
asynchronous TypeScript strategist and host runner. Model selection is
provider-agnostic; local gameplay continues without waiting for model replies.
See [playing Survival](../survival/play.md) and
[behavior](../survival/behavior.md).

## Repository layout

| Path | Ownership |
| --- | --- |
| `mod/` | Fabric 1.21.4 client mod (`mod/gradlew`, `mod/build.gradle`, `mod/settings.gradle`), JUnit 5 suites under `mod/src/test/java/io/gameharness/survival/`, and launcher helpers in `mod/bootstrap/` (`Bootstrap.java`, `launcher-auth.py`). |
| `src/agent/` | CLI runner (`run.ts`), option parsing (`strategy-options.ts`), SQLite admission/storage (`storage.ts`, `storage-campaign.ts`, `paths.ts`), continuation and recovery (`crash-autosave.ts`, `orphan-source.ts`, `release-orphan.ts`, `operator-stop.ts`), life/pause tracking (`lives.ts`, `pause-evidence.ts`), verification (`verify.ts`), and local stream/review servers (`watch.ts`, `reviews.ts`). |
| `src/strategist/` | Asynchronous macro strategist (`strategist.ts`) connecting authenticated providers to the Java mod's bridge. |
| `src/minecraft/` | Managed Fabric client/server launch and artifact handling (`client.ts`, `fabric-profile.ts`, `server-artifact.ts`, `mod-artifact.ts`, `java-network.ts`, `launch-fault.ts`). |
| `src/auth/` | Provider authentication, credential store, session drain, and inference transport (`manager.ts`, `worker.ts`, `protocol.ts`, `network.ts`, `session.ts`, `inference.ts`). |
| `src/diagnostics/` | Prepared single-mechanism and parallel test runners (`pool.ts`, `combat.ts`, `descent.ts`). |
| `src/shared/` | Shared goal and auth contracts (`goals.ts`, `auth-types.ts`). |
| `src/server/`, `web/`, `desktop/` | Minimal local HTTP/video server (`index.ts`, `survival-agent.ts`, `video.ts`), browser UI, and Electron shell for auth, EULA consent, launch, and live viewing. |
| `scripts/`, `tests/` | Check and desktop launch scripts (`check.ts`, `dev.ts`, `start.ts`, `desktop.ts`) and Bun test suites. |

Private runtime state, credentials, worlds, and recordings stay gitignored
under `local/runtime/`, `local/survival-agent/`, and `local/survival-pilot/`.

## v2 Java Survival mod

All gameplay execution runs inside the Minecraft client under
`mod/src/client/java/io/gameharness/survival/`:

| Module | Responsibility |
| --- | --- |
| `AgentClient` | Client tick entry point, lifecycle hooks, telemetry snapshots, and bridge wiring. |
| `TaskRunner` | Top-level Survival progression loop: wood, stone, ores, crafting, smelting, food, and goal transitions. |
| `Motor` | Bounded variable-speed camera aiming, gimbal-safe pitch/yaw handling, and movement keys. |
| `Perception`, `AgentOpticalSight` | Camera-projected block/entity observation, baked-model alpha ray checks, and local terrain memory. |
| `Pathfinder`, `RouteExecutor` | 3D A* path planning, headroom/staircase checks, pillar execution, and unreachable target blacklisting. |
| `GuiHands`, `AgentGuiPointer`, `AgentCraftClick`, `AgentFurnaceSync` | Organic cursor movement, inventory/crafting/furnace interactions, and mixed-stack batch clamping. |
| `SurvivalReflexes`, `CombatPlanner` | Hostile threat scoring, combat-flow escape checks, shielding, creeper kiting, emergency shelters, and gravel suffocation recovery. |
| `SafeDescent` | Multi-method high-drop and cliff descent (water clutch/pour, boat drop, stairs, edge blocks) with lava/unseen-floor refusal. |
| `CaveExplorer` | Perception-honest cave, ravine, and descending frontier tracking plus tunnel lighting. |
| `PortalCaster` | Single-bucket shore-cast Nether portal builder for surface and deep (`y = -54`) lava pools, ignition, and entry. |
| `InventoryTriage` | Automated clutter disposal while protecting tools, fuel, food, torches, buckets, and ore. |
| `StrategistBridge`, `AgentPauseEpisodes` | Non-blocking advice intake from `src/strategist/strategist.ts` and pause-window telemetry. |

## Host and UI process boundaries

`src/agent/run.ts` supervises one attempt at a time per lane: it validates
admission and artifact budgets via `src/agent/storage.ts`, launches an isolated
`Xvfb` display, managed 1.21.4 server, FFmpeg recorder, and Fabric client, and
optionally runs `src/strategist/strategist.ts` alongside play. Clean shutdown
drains the server and writes `outcome.json` before `src/agent/verify.ts` reads
saved vanilla statistics.

The minimal desktop app (`desktop/` + `web/` + `src/server/`) is a launcher
and read-only viewer for the same v2 agent, plus account login and EULA setup.
It never injects raw gameplay input or hijacks a terminal-owned run.
See [providers](providers.md) and [security](security.md) for auth and
isolation boundaries.
