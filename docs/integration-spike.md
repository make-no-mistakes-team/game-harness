# First integration: Minecraft desktop setup and spike history

## Minecraft Survival Agent

On the `experiment/minecraft-survival-agent` branch, the deterministic Fabric
client plays toward a resource goal or a Nether portal in a new Normal Survival
world. It uses the installed Minecraft Java 1.21.4 client and the project's
existing server download and EULA consent. Sign in with the official Launcher
before starting. On Linux it also needs Xvfb, xauth, FFmpeg with x11grab and
libx264, Bun, and JDK 21. Terra uses `scrot` 1.10 or newer from `/usr/bin` or
`/bin` for faster request-time screenshots when available; otherwise it uses
FFmpeg. The run recorder still requires FFmpeg.

```sh
# Select JDK 21 in JAVA_HOME, then run from the checkout root.
bun run build:agent
bun run play:agent diamond 1800
```

The seconds argument sets this attempt's wall time, including startup.
Other item goals are `wooden_pickaxe`, `stone_pickaxe`, and `iron_pickaxe`.
For `nether_portal`, the agent needs to build and light a frame and enter it.
Finding an existing portal or merely holding ten obsidian does not qualify.

To launch the same agent from the desktop, open **Settings → Minecraft Survival Agent**,
select a goal and click **Start in new world**. The main player view shows
the actual game. **Stop agent** saves and closes that run's world; **Choose
goal** starts the setup for another fresh world. The desktop will not take
over an ordinary agent run already active in a terminal. **Deterministic
(no model)** is the default and does not require a model login.

To use Terra in a new ordinary world, choose **Terra (gpt-6.1-terra)** under
**Agent strategy** before starting. The connected OpenAI account must offer
that exact model. Requests count toward account usage and may send live
game frames to OpenAI. If Terra cannot start, the app reports the failure rather
than switching models or starting a deterministic run. When a run closes,
the app reports a confirmed Terra action only if Minecraft supplied a
completion receipt. This is separate from verifying the vanilla goal.

From the terminal, put the strategy options before the goal:

```sh
bun run play:agent --strategy terra --macro-requests 8 --task 'Choose your next subgoal from what you can see.' diamond 360
```

When you select Terra, one of those requests may run during world loading.
It receives the task and a description of available actions, but no game
frame or inventory. Terra can suggest alternatives: craft from surplus wood
if the player has it, or gather wood if there is a tree in reach. Only one
branch can start. It must match an actual observation, even when the advice
refers to “the log you see” rather than a particular wood species. A branch
can include up to three jobs. If the opening asks for three logs and the
player already has three, the craft can start without sending the player
back to a tree. Existing logs earn no harvest credit. After work begins,
each handoff checks the previous job's receipt and the player's stock.
If the next job assumes a table the player doesn't
have, the player can keep gathering while Terra changes the plan. Ambiguous
advice grants no action. A rejected plan or a failed
startup can still use that request. Pass `--startup off` before the goal
to wait for the first observation before making a paid call.

Here Terra can make eight requests during a 360-second attempt. While it
thinks, the local player can continue an authorized job. For example, an
order can request a stock of planks and protect the last log. The player
chooses a visible tree, gathers the actual drops and rechecks the reserve
before taking an output from the crafting grid. Consecutive personal
recipes can share one open inventory, including across two approved jobs.
The player closes it when the next step needs the world, such as placing
the crafting table. Reaching the request limit
stops new calls; it does not grant more materials, extend a job, or end
Minecraft. A locally selected preset alone does not count as a Terra action.

If a requested survey disappears before the player turns, Terra can report
the missing view. Its return under the same safe conditions permits one
fresh decision. The player never executes the old turn on a stale view.
For a stalled run, `macro_survey_transition` in `events.jsonl` distinguishes
a lost first-person view from a survey the player already completed.

Once Terra sees carried raw iron and fuel, it can quote one live stock job
with `smelt:minecraft:iron_ingot`. The target is the total number of ingots
to hold. The policy names exact raw iron and fuel costs and preserves the
declared stock floors. Two raw iron need two oak planks, four sticks, or one
coal or charcoal in a cold furnace. A visible furnace is usable only after
the player opens it and checks that it is empty and cold.

To place a furnace, the job must separately allow `place:minecraft:furnace`,
budget one furnace, and leave room in `maxPlacements`. If the player also
needs to craft the furnace or make or place a crafting table, the job needs
those effects and costs too. `maxCrafts` covers both recipe executions and
the smelted units; the furnace batch uses that budget before collection.
The player reports loading, burning, and collection separately. Only the
matching completion receipt and live ingot stock establish the result.

For one raw iron, the player can wait at the open furnace until the ingot
is ready. Count the items loaded at the start: a batch of two is still a
batch of two after the first ingot cooks. A nearby threat takes priority.

A longer batch can free the player's hands. Suppose a bucket needs two
more ingots, but the player can already prospect the next cave section.
Terra can leave the iron cooking and start ordinary work with its own
effect and material budgets (`duringWaitFor`). The player can leave sight
of the furnace or change level. Finishing the cook does not interrupt
that job. If nothing useful is safe without the bucket, waiting is fine.

The player remembers the paid furnace and the dry route it actually
walked, including steps taken before setting up the workshop. When the
ingots are needed, a collection request follows a few remembered steps at
a time, checking each one against current terrain. A flooded or broken
step can postpone pickup. An ordinary continuation of a clean save can
retain these clues and protected stock floors, but not an executable
command.

Only opening the same furnace and taking its output puts the iron in
inventory. A bucket job proposed with `afterWorkId` must still wait for
collection and a fresh check of all three ingots, the protected stock
and the crafting table.

At a `renew` demand, Terra can extend the accepted ordinary job with
`renew-work`, its exact work order ID, and a later bounded expiry. The
player keeps the same action and spent budget. This can extend a cave leg
while the furnace stays parked; it cannot extend the paid batch or a bucket
fill. Use `afterWorkId` for a different objective that needs the predecessor
to finish, not for the stock target that completion would already satisfy.

Goal-only startup, built-in presets, generated skills, direct opportunities,
and work programs cannot grant furnace transfers. A completed smelt does not
establish a diamond pickup, bucket craft, or Nether entry.

Filling an empty bucket is a separate live Terra job. It targets one
`minecraft:water_bucket`, permits only `fill:minecraft:water`, and budgets one
`minecraft:bucket` above any empty-bucket reserve. The break, craft, and
placement caps must all be zero. The `fill_water` clue reports a lit, exposed
source in reach from dry footing. A flow-only clue, such as a waterfall
without a visible source, grants no fill.

The player stays on that footing, equips the empty bucket in the main hand,
and leaves the off hand empty. It checks the same source before one use.
The job completes only after vanilla accepts the use and inventory shows one
empty bucket replaced by one water bucket with the declared reserves intact.
No startup plan, work program, direct action, or generated skill can select
the clue or grant the fill. Pouring, collecting lava, placing filler, and
casting a portal remain outside this permission.

When an early stone, coal, or iron source is not in view, Terra can choose
a witnessed dry approach or an exact adjacent soil cap. A cap offer is one
break; it does not authorize descent or additional cuts. A work order can
check up to five new level footholds or descend a staircase one verified
tread at a time. Depth depends on the admitted break budget, the time
needed to return, and the player's physical condition. The player checks
each lit landing, dry clearance, and reverse climb before moving. Ordinary
tool presets allow dry soil and common rock as cover. A custom work order
needs an exact break permission for each cover type, charged against the
same break budget. The player keeps at least one break for the source.
Cover breaks, grounded travel, and stock pickups are confirmed separately.

For ordinary travel the player needs visible support through its
stopping distance, not a proved round trip to every waypoint.
`travelHint` names a visible resource or frontier and how far the
current view supports an approach. A diamond job can approach a cave
frontier even when no ore is visible. `woodland_frontier` points to a
visible canopy, not a known log or a species claim. Neither cue prices
a break or reports stock. The player checks each new view and brakes
when the known ground runs out.

The player can wade from dry footing when it can see a shallow,
supported crossing and a dry bank. Deep or swift water, lava, unknown
drops, and jumps do not qualify. A trip back to a paid furnace still
uses rechecked, actually walked legs; exploring a few steps forward
does not manufacture a return route.

When a camera check is still needed, Terra can add `openingViewId` from
`work.openingViewIds` to one priced mining or prospecting job. The host
issues that exact read first. After its accepted and completed receipts,
the first later safe view must show a matching dry landing, priced
harvest, approach window, or usable `prospectOpening` that wasn't
available before the check. Looking at one log can bind a start to
that log in reach or to a safe approach to it; another trunk or a
woodland cue does not count. The host then issues the priced work
without another model request.
The camera receipt does not prove a route or count as physical progress. An unchanged stance
does not gain a second bare survey from a new angle or ID; an exact new
face or lane can still be inspected. If the job already has a usable
witness, Terra should send `work` without an opening view. If an exact
opening clue disappears before the read starts, the host allows one new
decision when the matching physical offer or a distinct usable alternative
is in view. It does not replay the read or start the old job.

A diamond order that names only ore can mine an exposed vein. To look for
one below the current footing, Terra must also request
`prospect:minecraft:diamond` and name the cover it may break. A
`prospectOpening` can show where to start mining even when a dry rock wall
blocks the walking lane. The clue names one reachable wall face, its
tool, and possible item loss. It cannot be selected as an opportunity
and proves no future landing or ore. A torch costs
one carried torch and requires its own placement permission. The optional
`place:minecraft:cobblestone` effect needs an exact cobblestone cost cap
and shares `maxPlacements` with torches. The player spends one block above
its reserve only after witnessing an empty, dry adjacent cell, a reachable
attaching face, and clear forward and reverse space. It stays on the
original footing until a fresh view shows the new cobblestone top and
inventory shows the matching debit. Nearby fluid can veto the placement.
If the player cannot confirm the empty space, the refusal identifies the
bearing and what blocked the lower and upper sight lines.
On a flat shelf the player can cut an unused adjacent floor block to start
a downward tread, provided another usable exit or the walked return path
remains intact. Above Y=16, the player prefers a proved natural descent.
In an ordinary tunnel it can clear the visible front wall, then cut the
newly exposed floor from separate footing. It waits to see a lit, dry
landing with room to jump back before stepping down. After reaching the
lower block, it can continue in the same direction.
The report distinguishes placement, grounded arrival, and the lowest
footing reached. Only a diamond in inventory counts as a pickup.

The three-second planning deadline is a diagnostic target, not a
guarantee about the footage. If no safe, authorized action is available,
the player reports the obstruction. The idle deadline never chooses
a camera turn. A requested look can produce an observation receipt, but
turning toward a block does not reset the physical-progress clock. Check
`strategy.planningWait.longestPendingWithoutWorkMs` for the actual longest
idle interval, including blocked time. `rightCensored: true` means the final
interval may extend beyond the last observation. A provider timeout is a
separate limit. An audible creeper fuse can interrupt either planning or a
drag in the crafting grid before that limit matters.

For the rhythm of the whole run, inspect `outcome.json` → `pauseEvidence`.
It flags long stops and clusters of shorter ones and gives their times in
the recording. The provider overlap is reported separately: a pending
request can coincide with useful work, a necessary wait, or idle time.
Use those timestamps to inspect the recording at normal speed. Neither a
moving camera nor a successful craft shows that the intervening play felt
natural.

Terra can also write a function that chooses what to inspect or survey.
Before it can move the camera, the function must pass an isolated Docker worker
check and a test in a separate Minecraft world. Terra must then select the
tested version against a current observation. This permission does not cover
walking, crafting, or changing the client. Terra can request an existing
walk or recipe directly when the player can perform it. If it needs new client
code, it can leave a private patch for human review; the runner never builds
or applies the patch.

The runner prints the private attempt directory. Open `screen.mp4` there to
watch the actual client, including the inventory pointer. `outcome.json`
records why the attempt ended. For a diamond win, the live inventory must
contain a diamond and the saved vanilla statistics must show both ore mined
and a diamond picked up. The runner checks those statistics after the world
closes; the player does not receive them.

To continue at a later stage without replaying progress, keep the same official
Launcher profile and pass the basename of a previous agent attempt:

```sh
bun run play:agent nether_portal 3600 --continue-from "$RUN_BASENAME"
```

The parent must be a recorded agent attempt with a clean server exit.
Retry an unfinished goal or advance to a higher tier; a completed goal cannot
count as another win just by loading its save. The runner accepts no external world path. It copies the
saved vanilla world, including player inventory and statistics, into a new
attempt directory before starting a new server and recording. Only the
agent's own observed route and confirmed workstations can carry over as
navigation memory. The runner does not inspect the seed or map. The declaration and outcome mark the new attempt
as `world.fresh: false` and name its `world.parentRun`. Saved statistics can
corroborate progress anywhere in that chain; a continued win is not evidence
of an uninterrupted fresh run. Omit the flag for the fresh-world benchmark.

To watch as it plays, run `bun run watch:agent` in a second terminal and open
`http://127.0.0.1:4379/` on the same computer. Leave the tab open between
attempts. The read-only stream follows the agent's private display and
includes its cursor; the local recording continues if you close the tab.
To open an exported review clip from its existing playback link, run
`bun run review:agent` on the same computer first.

To stop an ordinary run from a second terminal or a progress watch, pass the
basename of that attempt's printed directory:

```sh
bun survival-agent/operator-stop.ts "$RUN_BASENAME"
```

Keep the launcher and its display running. The command only publishes the
request; `operator_stop_accepted` in `history.jsonl` is the runner's receipt.
Wait for the launcher to exit. A clean operator stop exits 1 and records
`closed` with status `interrupted`. If a server had started, confirm
`operatorStop.serverSaved: true` in `outcome.json` and `dimensionsSaved: true`
with no escalation in the `server_drained` event before treating the stop
as a clean save. Without those records, cleanup or saving is unconfirmed.

To test the single-bucket casting path without mining for supplies, run
`bun run diagnose:pool [SECONDS]`. This starts a separate Normal Survival
world on a flat plains map. The player starts facing south on a dry stone
bank, with one dry block between the player and a 7×6, one-block-deep pool
of 42 lava sources. The world clock is set to tick 1000 before the client
joins and advances normally afterward.

The starting hotbar contains one water bucket, flint and steel, a stone
pickaxe, 64 cobblestone and 8 cooked beef. There is no diamond, obsidian,
portal frame or mold at the start. All setup ends before the client joins;
the same agent handles casting, lighting and entry. At the four-block lava
edge, water cools two frame blocks in place. The agent pours the other eight
with the same bucket, recovers its water and lights the frame. A win requires
all ten positions, arrival in the Nether and corroborating vanilla statistics.
The default live view stays on ordinary runs. For the diagnostic,
run `bun run watch:agent --diagnostic` and open
`http://127.0.0.1:4382/`, or play `screen.mp4` from the printed attempt
directory. Diagnostic worlds cannot be used as continuation parents.

To replay an incident from a closed ordinary attempt on that same diagnostic
stream, use `bun run play:agent nether_portal 180 --replay-incident "$RUN_BASENAME"`.
This uses the same save-copy rules and player as `--continue-from`, without
fixture setup. The declaration and outcome record `world.type: "vanilla-incident-replay"`,
`world.fresh: false`, and `world.parentRun`. The replay is not a fresh-world
result. Stopping after observing an incident does not count as reaching the goal.

Use the same stream to watch an individual skill trial:

| Command | What the agent has to do |
| --- | --- |
| `bun run play:agent --diagnostic-urgent-creeper` | React on the first client tick after hearing a real fuse while a Terra request is outstanding. Uses the connected account; up to three requests in 120 seconds. |
| `bun run play:agent --diagnostic-urgent-craft` | Leave a real workbench drag before release, recover the carried stack, and escape the blast unharmed. No model calls. |
| `bun run play:agent --diagnostic-descent water 180` | Place water during a fall and land without damage. |
| `bun run play:agent --diagnostic-descent boat 240` | Place and board a boat on the ledge, then ride it down to a dry landing. |
| `bun run play:agent --diagnostic-descent cave 180` | Enter a lit chamber and follow its descending shelves. |
| `bun run play:agent --diagnostic-terrain birch 180` | Leave an unreachable birch log and harvest a reachable tree. |
| `bun run play:agent --diagnostic-terrain ceiling 180` | Deal with a low ceiling and reach the upper step. |

Only one diagnostic runs at a time. These trials prepare the terrain; the
bucket and boat trials also supply the item. They do not test finding a cave
or making a boat or bucket in a random world.

The desktop survival form takes a preset game goal, not a free-form task.
The separate model-driven GameHarness workflow is described below.

GameHarness is a desktop harness intended for many supported games through explicit adapters. This guide covers its first implemented adapter, Minecraft Java: an owned Fabric client/server, authentic video and compact model-authored programs. Other adapters are planned, not delivered automatically. Old Mineflayer/prismarine results below are scoped history and do not certify the native replacement.

The supported slice includes natural-language tasks, bounded model-authored programs, native movement and visible inventory mechanics, retained evidence and safe run closure. A reviewed two-trip task supports a small end-to-end gameplay result; it does not certify every criterion in the broader [playable gate](implementation-mvp.md) or release contract. The [runtime contracts](runtime-contracts.md#current-compact-program-interface) distinguish delivered pure local modules and async bodies from the future async-module/checkpoint interface.

Pure-library worker verification covers nested named/default/reexports,
same-realm sharing, fresh workers, exact alias/hash/size bounds and denied host
imports. `bun test tests/resident-worker.test.ts tests/resident-controller.test.ts`
passed 192 cases with one opt-in Docker case skipped. Running that case with
`GAMEHARNESS_DOCKER_MODULE_SMOKE=1` passed through the actual Docker guardian,
including shared/fresh analysis realms and a step root. These checks establish
software behavior, not model adoption, useful gameplay or a five-second pause
guarantee.

Game session, agent run and player life have separate lifetimes. Their current operating contract is below; retained death-disconnect/saved-dead-auto-respawn reports describe superseded cohorts. Historical promotion and exact warm invocation remain limited evidence: the inherited program blocked on absent observable prerequisites and a later program ended in death. Neither durable source nor successful hydration establishes useful warm-task performance.

## Install and start

The current reference host is Linux x64 with:

- Bun 1.3.14+, Node.js 24+, Python 3 at `/usr/bin/python3` with the `python3-dbus` module for Linux Secret Service access, and a Java 21 development kit. Set `JAVA_HOME` to the selected JDK, or select Java 21 through `PATH`; build and runtime no longer require a Debian installation path. The runtime resolves `PATH` Java before restricting child environments. Project package scripts use Bun's shell so host shell startup files cannot replace the exported toolchain.
- `flock` and a running local Docker Engine. The application user must be able to use `/usr/bin/docker` without an interactive `sudo` prompt. The policy supervisor uses the local daemon with a restricted environment, not a custom remote Docker context.
- FFmpeg 6.1+ with `ffprobe` and the `libx264` encoder for recorded replay export, `bun test` and `bun run check:integration`. The unit-only tier does not require these codec tools; full verification does. See the [codec setup](#replay-codec-prerequisites).
- Network access for package installation, pinned image/server acquisition, and OpenAI authorization/inference; an account with the required Codex entitlement.
- A working graphical session and an official Minecraft Launcher account entitled to Java Edition, with installed 1.21.4 client artifacts/assets under `~/.minecraft`. The owned client uses those files read-only and launches with isolated data, not personal worlds/configuration. Its account token crosses private bootstrap stdin, not model context or process arguments.

On the reference Linux host the official Launcher keeps the selected account's bearer in the unlocked GNOME Secret Service, while its account JSON may intentionally contain a blank token. A one-shot system-Python helper selects `activeAccountLocalId` and its exact `localId` token key through a private pipe; the trusted launcher verifies that the official Minecraft profile matches that account. It does not fall back to another account, unlock the keyring, read unrelated applications' secrets or print/store bearer values. Refresh the official Launcher login if the legitimate grant is unavailable. This narrow OS-keyring helper is not part of gameplay or the agent runtime.

Before the first launch, keep private application data outside public source and locally exclude any retained in-checkout private data.

```sh
bun install --frozen-lockfile
docker pull node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
bun run build
bun run start
```

The exact policy image is pinned in [`src/server/sandbox.ts`](../src/server/sandbox.ts). Sandbox preparation uses `--pull=never`: a missing image makes policy isolation unavailable. **Prepare server** can retry sandbox preparation after you install the image, but does not download that image for you. There is no unsandboxed fallback.

`bun run build` builds the native project, Minecraft Survival Agent and Vite renderer. The component commands are `bun run build:native`, `bun run build:agent` and `bun run build:ui`; the native wrapper command is `sh native/minecraft/gradlew -p native/minecraft build`. It pins Gradle 8.11.1, Loom 1.9.2, Fabric Loader 0.16.10, Yarn 1.21.4+build.8 and Fabric API 0.119.4+1.21.4.

`bun run start` opens Electron 45.0.0. `bun run dev` builds once and opens the same desktop; it is not a watched Vite browser server. Keep the checkout, dependencies, built renderer/native artifacts and both sandbox files available.

Electron spawns its own Bun backend, chooses a dynamic loopback port and verifies a private readiness nonce through stdout and `/v1/ready`. It neither reuses arbitrary services nor treats an occupied fixed port as its backend. Startup holds a nonblocking data-directory `flock`. Closing the window sends the owned backend SIGTERM; if cleanup exceeds 30 seconds the pending window remains, rather than claiming shutdown or force-killing unrelated processes.

### Replay codec prerequisites

On Ubuntu 24.04 or a newer supported Ubuntu host, install the distribution's
FFmpeg package, which supplies both command-line tools and libx264:

```sh
sudo apt-get update
sudo apt-get install --yes ffmpeg
```

On Fedora, use a full FFmpeg build with libx264 rather than `ffmpeg-free` alone.
If the host's policy permits RPM Fusion, follow its
[repository configuration](https://rpmfusion.org/Configuration) and
[full FFmpeg instructions](https://rpmfusion.org/Howto/Multimedia).
After repository setup, its documented replacement command is:

```sh
sudo dnf swap ffmpeg-free ffmpeg --allowerasing
```

Review the proposed package transaction before accepting it. RPM Fusion is a
third-party source; do not bypass the host's repository policy. A different
approved FFmpeg build is acceptable if it provides the required tools and encoder.

After installing project dependencies, verify the tools and actual export path:

```sh
ffmpeg -version
ffprobe -version
bun test tests/replay-timing.test.ts
```

These mandatory integration tests use the real local encoder and probe without
starting Minecraft, Docker or provider inference. Missing codec tools are setup
errors, not a reason to skip or replace the regressions. CI installs the same
Ubuntu package before running the default suite.

### Electron sandbox helper

The Linux reference installation initially rejected Electron's misconfigured SUID helper. The operator corrected the local installed dependency with:

```sh
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

The binary then reported `v45.0.0`. Apply privileged changes only to the trusted installed Electron helper under the host's security policy. Reinstallation may replace it. Never use `--no-sandbox`; renderer sandbox/context isolation remain enabled and Node integration disabled.

### Fedora Linux x64

Install the desktop and build prerequisites from Fedora's repositories:

```sh
sudo dnf install nodejs24 python3 python3-dbus curl unzip util-linux \
  gtk3 nss alsa-lib libXScrnSaver moby-engine docker-cli
sudo systemctl enable --now docker
```

The application user needs access to the local Docker daemon without interactive `sudo`. If group membership must change, log out and back in before continuing. Docker access grants substantial host authority. `podman-docker` is not a substitute for the implemented Docker isolation contract.

Fedora can install a newer default JDK and keep another Node version selected. The following user-local toolchain leaves those defaults unchanged. These pinned archives come from [Bun](https://github.com/oven-sh/bun/releases/tag/bun-v1.3.14) and [Eclipse Temurin](https://github.com/adoptium/temurin21-binaries/releases/tag/jdk-21.0.13%2B9); verify their checksums before extraction:

```sh
TOOLS="$HOME/.local/share/gameharness-tools"
mkdir -p "$TOOLS/bin"
curl --fail --location --proto '=https' --tlsv1.2 \
  https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-x64.zip \
  -o "$TOOLS/bun-linux-x64.zip"
printf '%s  %s\n' 951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f \
  "$TOOLS/bun-linux-x64.zip" | sha256sum --check
unzip -qo "$TOOLS/bun-linux-x64.zip" -d "$TOOLS"
curl --fail --location --proto '=https' --tlsv1.2 \
  'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13%2B9/OpenJDK21U-jdk_x64_linux_hotspot_21.0.13_9.tar.gz' \
  -o "$TOOLS/temurin21.tar.gz"
printf '%s  %s\n' d7f5d5cf865a2902b70ff549b97586a7d3f234e016f041ab447ea740c7d66d1c \
  "$TOOLS/temurin21.tar.gz" | sha256sum --check
tar -xzf "$TOOLS/temurin21.tar.gz" -C "$TOOLS"
ln -sfn /usr/bin/node-24 "$TOOLS/bin/node"
export JAVA_HOME="$TOOLS/jdk-21.0.13+9"
export PATH="$TOOLS/bun-linux-x64:$TOOLS/bin:$JAVA_HOME/bin:$PATH"
```

Keep these exports in the terminal used for the README commands. Confirm `bun --version`, `node --version`, `java -version` and `javac -version` select the required versions, then follow the README installation, build and start commands unchanged.

For a separate verification installation, optionally set `GAMEHARNESS_DATA_DIR="$HOME/.local/share/gameharness/fedora-runtime"` before starting. This keeps its credentials, worlds and run records separate from an existing installation without copying them.

Launch from the graphical desktop session. GNOME Wayland needs its working XWayland display for the native Minecraft client; retain the session's actual `DISPLAY`, `XAUTHORITY` and `XDG_RUNTIME_DIR`. Do not substitute another user's display or authority file. SELinux can remain Enforcing: Docker applies a shared label only to the trusted read-only sandbox runner, allowing concurrent workers without relabeling the checkout or disabling isolation.

Fedora 44 x64 verification on 23 October 2026 used GNOME Wayland, Bun 1.3.14, Node 24.18.0, Temurin JDK 21.0.13 and Docker/Moby 29.8.2 with SELinux Enforcing. After the documented prerequisite selection, the README's frozen install, image pull and full native/UI build succeeded; both native proof tasks passed. Typechecking and all 304 Bun tests passed on Fedora. The actual 1440×900 Electron window loaded the connected workspace with renderer sandbox/context isolation enabled and Node integration disabled. Production sandbox readiness and two concurrent policy workers plus an isolated skill passed a synthetic, zero-provider Docker smoke.

Initial checks exposed Debian-only Java selection, host shell startup replacing the selected JDK, and an unlabeled read-only runner mount rejected by SELinux. Those paths were corrected without disabling isolation. The successful build still emitted mapping/deprecation warnings. The operator subsequently confirmed successful manual acceptance of the requested Minecraft, OpenAI OAuth and agent-task trial on Fedora. That is operator-reported acceptance; the independently observed build, desktop and isolation evidence above does not establish controlled gameplay efficacy or a measured improvement.

### OpenAI authorization and proxies

Open **Settings → OpenAI connection** and choose **Connect in browser**. The app presents a validated HTTPS address at `auth.openai.com/oauth/authorize`, not the SDK's optional loopback `/launch` shortcut. Open it on the backend machine and finish authorization. The state-checked callback uses **localhost:1455**; keep that port available. If it is occupied or browser callback login is unsuitable, choose **Use device code** and follow the trusted UI's instructions at the validated provider device address. Supply input only when requested. Available flows are not proof that each has been independently exercised.

Wait for account model discovery, then select a discovered model whose SDK descriptor includes image input. The application requires [typed actor images](runtime-contracts.md#delivered-actor-images-and-recorded-episodes); unsupported models fail before inference, with no text-only fallback. Discovery establishes advertised modality support, not a successful live vision test. An authorization/discovery failure stays explicit, never replaced with an ambient key. Strategic `openai-codex` OAuth uses OMP 18.12.3. The optional Jev connection uses authenticated `GET/POST/DELETE /v1/jev` and a private TypeSafe key; a configured key is not proof of a connected service or real gameplay reaction. Both auth categories and two-provider bounded-task success remain release requirements.

If your network needs a proxy, configure it in the environment that launches `bun run start` or `bun run dev`. The trusted OAuth helper receives the allowlisted `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` variables, their lowercase equivalents, and `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, and `SSL_CERT_DIR`. Keep loopback traffic direct by including `localhost,127.0.0.1,::1` in `NO_PROXY` and its lowercase equivalent when used. Proxy credentials and custom certificates belong in private operator configuration, never in tracked files, screenshots, or shared logs.

OAuth authorization and real Codex model discovery have succeeded with the trusted helper's proxy environment configured; this does not establish separate successful verification of both login modes. No existing OMP/Codex home credentials are imported. The app stores only credentials obtained through its own authorization flow; generated policies never receive them.

### Start the game and a run

1. Open **Settings**. In **Isolated Minecraft world**, read and accept the [Minecraft EULA](https://www.minecraft.net/en-us/eula), then click **Prepare server** for the managed Java 21/Fabric 1.21.4 server. Consent remains private.
2. Click **Start world** (or **Reconnect client** for a disconnected player). Wait for player connection and authentic world/hand/HUD frames separately. No old adapter or synthetic view substitutes for a failed launch.
3. In **Task and strategic model**, select a discovered image-input-capable model and enter the natural-language **Task**. **Custom** is the default, with no automatic success check. Optional goal presets bind an exact trusted verifier and replace the task with its criterion; editing the task switches back to Custom. `break_log` verifies one eligible log removal, while `collect_wood` verifies receipted own-inventory gain. Click **Create run**, then the toolbar's **Start**. Creation saves the task; Start begins inference.
4. In **Program libraries**, choose **Continue this session’s same-model working programs** or **Fresh — omit working programs**. Working definitions have no retained invocation state and are not qualified experience. **Qualified compatible startup bundle** separately selects an eligible cross-session snapshot; missing or incompatible experience stays explicit.
5. Inspect actual inventory, compact-program executions, exact dependencies, source/cards, trace, comparison, learning, life and planning evidence in their dialogs. Bootstrap is bounded; execution does not require a human prompt per action. Registration, validation and a program's own completed result are not objective proof. For Custom, `task_finish` stops work with **Model reported completion · unverified**; only a trusted preset verifier produces **Goal verified**.
6. Use **Pause**, **Resume**, or **Stop run** as appropriate. These controls and goal completion retain a healthy client connection and authentic video with neutral inputs. Normal death retains the real vanilla DeathScreen; only the model's explicit `game.respawn()` requests respawn. A saved-dead world does not respawn on startup.
7. **Settings → Motor profile → Camera / movement profile → Apply profile** selects `precise`, `balanced` (default) or `fast`, persists the setting and applies it live. It is an operator mechanical setting, not a gameplay strategy or measured speedup.
8. **Stop world** ends the owned client session and server. Stop the run and world before **Create new world**, which preserves prior world directories and recorded runs. Closing the desktop drains its owned backend/game processes; it does not kill unrelated services.

The managed server runs as a local Java Fabric process in its own world directory, with Normal Survival, ordinary generation and no agent operator privileges. A private managed-session challenge gates admission before ordinary login/duplicate-player handling; a name, whitelist or player cap alone is insufficient. It is not a public multiplayer service. Physical keyboard/mouse gameplay/menu callbacks and polling in the owned client are suppressed; app Pause/Stop are the human controls.

Crafting uses the actual vanilla 2×2 inventory or 3×3 crafting-table screen. Equipment transfers and placement's implicit hand preparation share the same owned inventory-session mechanism; an already available hotbar item can be selected directly. Visible pointer motion and slot gestures are mechanical assistance, not a model-authored resource strategy or a claim of human-equivalent input. Only one inventory session owns the handler/cursor at a time. World time continues during gestures and model waits. Successful closure requires clean cursor/grid custody; cancellation revokes pending gestures and closes only the handler it still owns, without pretending partial transfers were undone.

The native adapter also uses authenticated own-inventory receipts after vanilla packet ordering, bound to the session/world/epoch connection, request nonce and motor generation. These return bounded item counts/slot names, not NBT, world/admin data or actions. Local click prediction or a packet promise cannot establish inventory gain: identical vanilla slot updates may be suppressed. Receipts are internal effect-verification infrastructure, not an extra model capability or proof that a gameplay task has passed.

The promotion gate requires `inventory_receipt_confirmed:true` with trusted own before/after counts, and the useful predicate event must fall inside the closed root's bounded interval. Trusted task verification can attribute delayed pickup to an exact craft/dig target within that interval; later pickup cannot retroactively qualify an ended root. Trusted-goal cancellation can close an eligible root without pretending self-completion. Model assertions/local prediction are insufficient. Warm hydration preserves exact refs/source and freshly matching canonical-validation fingerprints.

For program authoring, `help` topic `game` supplies the lazy host-validator-derived API reference, and topic `programs` supplies named workspace contracts. The canonical `GameAPI` lives in [`src/shared/programs.ts`](../src/shared/programs.ts). Inventory fields are `name`, `display_name`, `count`, `slot`, not `.item`. Static source validation does not prove DTO field correctness. See the [runtime contract](runtime-contracts.md#current-compact-program-interface) rather than maintaining a second copied API declaration. Host preflight checks readiness and captures authoritative state; the model need not spend several requests confirming host-known facts.

## Local data and configuration

Desktop storage defaults to Electron's `userData/runtime`. `GAMEHARNESS_DATA_DIR` explicitly selects another root, including a retained old-spike directory. Set it to a private external directory for direct-backend operation; the implementation's legacy checkout-local default is not a share directory. Keep the whole tree private:

| Location relative to the data root | Contents |
| --- | --- |
| `auth/gameharness.sqlite` and SQLite sidecars | App-owned OAuth credentials. The auth directory is restricted to mode `0700`; credential files to `0600`. |
| `runs.sqlite` and sidecars | Run/action/event, policy, skill and durable execution records. |
| `artifacts/` | Immutable canonical generated source. |
| `minecraft/` | Server provisioning, world directories and private logs; existing world directories remain retained. |
| `native-client/` | Isolated native client data; no personal world/configuration migration. |
| `native-session.json` | Private mode-0600 session/world/epoch admission secret; never export or show it. |
| `provisioning-consent.json` | Local Minecraft EULA consent record. |
| `app.lock` | Single-owner startup lock. |

Configuration is read from the launching process:

| Variable | Default | Purpose |
| --- | --- | --- |
| `GAMEHARNESS_DATA_DIR` | Electron `userData/runtime`; legacy checkout-local direct-backend default | Trusted private storage root; use an absolute external override for direct-backend operation. |
| `GAMEHARNESS_PORT` | Desktop `0` (dynamic); direct backend `4317` | Owned loopback backend port. |
| `GAMEHARNESS_MINECRAFT_PORT` | `25565` | Managed server's loopback listening port. |

If you choose another in-repository data directory, exclude it locally before launch too. An exclusion does not untrack files already committed, secure a backup, or redact an export. Never publish auth databases, device codes, login URLs, tokens, raw server logs, worlds, or privileged evaluator records. Do not move an open SQLite database by copying only its main file; WAL sidecars may hold live data.

Evaluation commands use a separate [external runtime/governance and compact-report layout](operations-and-security.md#private-evaluation-storage); they do not silently change application storage. Preserve historical worlds/reports unchanged and keep private evidence out of public source.

## Inspecting source and live evidence

Current authenticated read interfaces are bounded projections, not filesystem access:

- `GET /v1/state` returns the snapshot, including `run.skills`, `run.executions`, policies and token/cache/purpose accounting.
- `GET /v1/runs` returns `{runs}`; `GET /v1/runs/{run_id}` returns the retained run and immutable source/cards/dependencies.
- `GET /v1/runs/{run_id}/events` returns bounded retained history with a cursor and explicit `omitted_details` where needed.
- `GET /v1/runs/{run_id}/skill-evidence` returns `{evidence}` linked to executions/actions.
- `GET /v1/runs/{run_id}/trace?after=0&limit=100` returns bounded actual trace; add `execution_id` to filter an execution/root.
- `GET /v1/runs/{run_id}/improvements?after_opportunity=0&after_execution=0&limit=32` independently pages opportunities and execution metrics, returning structured `next_after`; old numeric `after` is rejected. `/deaths` uses numeric `after`/`limit`; `/planning` returns the bounded lookahead record. Omissions remain visible.
- `POST /v1/program-comparisons` accepts exact before/after run/program/version/hash references and returns bounded source/card differences and raw objective samples, never an automatic “improved” verdict.
- `GET /v1/experience?model_id=…` returns `{experience}`. Promotion through `POST /v1/runs/{run_id}/experience` requires an explicit declaration and proven useful-gameplay predicate, not a self-rating.
- `GET /v1/events` is the authenticated activity SSE stream.
- `GET /v1/performance` is authenticated operator-only diagnostics; it is not a model/program capability.

The application establishes its local session through `GET /v1/session`; renderer mutations require that session and CSRF token. Reads grant no filesystem, execution or activation authority. **Inspect programs** opens bounded source/card/execution evidence; **History** selects retained runs. Source uses inert text, including HTML/script-like content. A source file or successful validation does not prove invocation or effects.

`GET /v1/video` upgrades to a same-origin WebSocket with `gh_session` and Host/Origin checks; no CSRF token appears in its URL. Each live message has a validated 328-byte little-endian GHV2 header and tightly packed RGBA8 pixels. Frames come from native final-framebuffer capture after world/hand/HUD, independently of control IPC. Packet-bound render/scope diagnostics are described in the [capture contract](runtime-contracts.md#delivered-actor-images-and-recorded-episodes); actor PNG alignment with structured observations remains unsynchronized. Latest-frame buffering is bounded; target 1280×720 at 30 fps is not a measured guarantee. The renderer uses a read-only canvas, with explicit idle/starting/streaming/stale/error status. The structured controller-frame read does not expose raw video packets or pixel buffers.

The removed prismarine renderer's height/section patches and narrowly scoped AJV worker CSP exception were old-spike mechanisms, not native prerequisites. Historical Chrome terrain rendering and an OMP-managed browser's blob-worker conflict remain evidence about that renderer only.

### Performance diagnostics

Open **Settings → Performance diagnostics** for actual backend CPU as a percentage of one core, RSS, the reported CPU sample window, event-loop lag and bounded p50/p95/p99 observation/action/video-forward distributions. The dialog polls at most once per second while open and cancels on close/page hide. No samples, unavailable values and retained stale data remain explicit.

Action timing is total command round trip, including intentional gameplay duration; it is **not dispatch latency**. Native FPS/frame metadata and operator-only native diagnostics are separate from renderer capture-to-draw wall latency, which has same-host clock limitations. Program durations and CPU/latency evidence identify bottlenecks; no unmeasured native-language rewrite or token-saving claim follows from this display.

## Stop, disconnect, and uncertainty

Pause, Stop run and goal closure close strategic/program/reaction admission, fence execution trees, cancel the leaf owner and await actual native input neutralization plus worker/planner/action drain. Healthy session/video remain connected; the world keeps ticking and survival is not guaranteed. Unknown prior effects remain unknown. No effects are admitted during effect-free post-goal `reviewing`.

The status separates **Acting**, **Program running**, **Model thinking**, **Waiting**, **Blocked**, **Recovering** and explicit paused/closing states. These are current control/execution facts, not a diagnosis of model intent or a guarantee of progress. Program progress carries its execution link, event sequence and time and is labeled model-authored, unverified evidence. The task excerpt can be opened in full.

**Model request failed · paused** means a strategic request failed; it does not establish a provider-wide outage. Inspect the recorded cause and connection status. Refresh model discovery when appropriate; **Resume** requires readiness and fresh observations. Reauthorization requires **Stop run** first. Stop is terminal: a stopped run cannot Resume. During cleanup the control stays **Stopping**, or offers **Retry Stop** after an explicit cleanup error; retrying cleanup does not replay gameplay.

Ordinary death revokes old-life commands, target bindings and pending JS/Jev/lookahead results, drains affected workers and wakes the strategist once with compact authorized death evidence. It does not set a connection error, stop the run, disconnect the client or auto-respawn. Explicit model-selected `game.respawn()` uses the same arbiter as `{kind:"respawn"}` and waits for vanilla readiness plus confirmed new-life evidence. Session ID and epoch stay unchanged; life ID advances only on confirmed new alive readiness. No human respawn API is supplied.

Only explicit Stop world, world replacement and desktop close normally end the owned game session. A genuine unconfirmable transport/emitter failure may still require fail-closed client teardown. Neutralization acknowledgement and historical outcome certainty are separate: neither an unknown old effect nor death alone proves a live emitter. Missing control cannot be reported as confirmed neutralization.

For a healthy connected alive player, unknown-effect handling first fences old roots/planner/reactions/leases, drains workers and confirms actual native neutralization. With fresh same-session/life observation, it wakes one new strategic generation automatically; operator Resume is not required for this successfully reconciled case. The old effect stays unknown and is never replayed. Missing safety/readiness evidence instead pauses with admission closed; actual transport errors retain fail-closed teardown. These are current source semantics, not a successful-repeat claim for the separate seven-call model attempt.

Application restart retains inspectable run/events, immutable source and unresolved-effect evidence and closes interrupted work without automatic replay. It does not restore a live JavaScript stack, resume an old execution or restore the world to a runtime checkpoint. Create a new run to continue after restart; retained evidence is not transparent gameplay continuation.

### Episode recording and retained evidence

The evaluation recorder subscribes to delivered native frames independently of
the desktop's latest-frame display. Ordinary development writes live-compressed
video segments, a timestamped index and a completion/incompleteness manifest,
without a persistent PNG spool. MP4 assembly stream-copies those segments and
preserves actual waits. Exact model-visible images remain separate PNGs.
Frozen pixel-evidence protocols explicitly select lossless recording.

Default bounds are 12,000 delivered frames, ten minutes, 128 MiB pending raw data
and 32 GiB encoded media, including segments and canonical replay. Invalid frames,
changed dimensions/orientation, exhausted bounds or persistence/encoding failure
make capture incomplete and request Stop. Finalization joins actual encoder/file
owners. Audio is absent; capture/state clocks are not proven synchronized and
upstream renders can be omitted. Encoding proves neither visual quality nor task
success. See the [recording contract](runtime-contracts.md#delivered-actor-images-and-recorded-episodes)
and [artifact-retention policy](operations-and-security.md#private-evaluation-storage)
for fidelity, explicit lossless mode, pins and payload expiry. This is an
evaluation evidence path, not a desktop replay browser or world rewind.

### Historical spike cancellation and death evidence

The paragraphs below describe the retired Node/Mineflayer adapter and old browser UI. Their SDK/ABORT acknowledgements and fixture passes are retained history, not claims about native cancellation or current button layout. In particular, their death-disconnect and Stop-run-disconnect procedures are superseded by the current three-lifetime contract above.

**Pause** closes admission and cancels current work. When neutralization succeeds, the player can remain connected and the world continues ticking; pause does not guarantee survival. Uncertain cancellation can fence/disconnect the player and require a fresh connection before resume.

A connected player is also vulnerable when no run is active. In one idle observation period, the ordinary server recorded a Creeper killing the player. Death fences the player connection; it is not evidence of an OAuth or server-start failure. A separate real-death fixture verified disconnection, preservation of the first lifecycle-error cause, and absence of late gameplay writers. There is no handwritten survival behavior keeping an idle avatar safe.

Death can also interrupt active gameplay. The UI shows the adapter's connection event separately from an unverified action outcome for the same paused world and connection epoch. An `unknown` dig result alone does not diagnose why the player disconnected. **Go to Resume** only focuses the run control; pressing **Resume** itself reconnects and resumes model requests. The original action evidence remains unchanged.

If the run is still **created**, **Create run** has saved its task and model but has not started inference. When the player disconnects before **Start** while the same world remains running, use **Open setup → Reconnect player**. This keeps the existing run ID, task, goal, and model; **Start** becomes available after reconnection. Reconnecting does not start the model. A running or paused run retains its separate pause/resume/stop controls.

**Stop run** revokes model/policy/action generations, closes workers, and requires player-session disconnection before reporting `stopped`. It does not stop the separately managed Minecraft server. **Stop world** requests run closure and player disconnection before stopping that server. Closing the browser stops neither. Use the UI controls before stopping the application with Ctrl+C; an abrupt process kill is a failure, not a successful stop acknowledgement.

An unconfirmed cancellation or lost effect acknowledgement remains `unknown`, without automatic replay. A shutdown whose cleanup cannot be confirmed stays pending with admission closed; retry **Stop** as directed after restoring the underlying service. Do not start a replacement run to hide an uncertain one.

Digging now distinguishes confirmed stopping from its preceding game effects. For a dig stopped before FINISH, the adapter drains the actual SDK task, neutralizes local channels, and requires a server acknowledgement of ABORT when mining has started. It can then continue the connection with `cancelled`, while explicitly retaining `prior_effects: "unverified"`. This is neither mining success nor proof that the block stayed unchanged. An unconfirmed FINISH, missing acknowledgement, failed cleanup, or transport loss still fences the connection and records `unknown`.

The selected real-server pre-FINISH cancellation case passed: SDK cancellation and server acknowledgement were observed, no delayed FINISH appeared through the original SDK timer window, the player remained connected, and a subsequent permitted camera action succeeded. The independent witness recorded block state separately; the acknowledgement itself was not treated as a world-state snapshot. This selected case is not a full-suite pass and does not retroactively resolve earlier unknown actions.

A real integration session reached an uncertain-cancellation safety pause. The operator then used **Stop run** on the already-settled paused run: the UI reported `stopped` and the player was disconnected. **Reconnect player** (the running-world form of **Start world**, `POST /v1/game/start`) then rejoined successfully without another inference request.

After correcting reversible-look draining, selected real-server fixtures passed simultaneous movement, camera change and observed-target attack under one owner, rejection of a competing owner, cancellation, and post-cancel movement stability. A separate held-shield case verified release through server-observed hand metadata. The pending-inference interval in these fixtures was explicitly synthetic; these results do not establish every strategic-request/recovery case or a full-suite pass.

Policy containers have a separate cleanup owner: the detached host `sandbox/guardian.mjs`, not a handler inside generated-code execution. Ship it with `sandbox/worker.mjs`. Host-loss testing showed container removal even when a policy removed the in-container EOF handler. If Docker is unavailable, the guardian keeps removal pending until the daemon can confirm cleanup. Do not kill the guardian or label a missing acknowledgement as successful termination.

## Recorded integration results and remaining gates

Everything in this history retains its original cohort and outcome. References to work or runs pending at an earlier stage describe that stage, not current instructions or authorization to repeat it. The schema-2/r2 cutover supersedes terminal-death, client-exit-on-run-stop and saved-dead startup respawn behavior in the older reports. Their source/build/fixture/gameplay numbers do not certify the new lifecycle, motor, trace, learning or planning paths. The 31/13/7-call receipts and the operator's slow-camera, roughly five-second-pause and target-switch observations are not a controlled efficiency comparison or an explanation of model intent; exact unprovided run details remain unknown.

### Reviewed two-trip custom task — 27 October 2026

A GPT-6.1-Sol episode used explicit low reasoning, a fresh seed-1 Normal Survival world, empty inventory and fresh programs/experience, assisted observation, balanced motor settings, visible inventory mechanics and single-dispatch SSE. The uncut 1× recording was **203.44 seconds**, retaining **6,082/6,082 delivered frames** with upstream gaps disclosed. Independent receipt, observation, saved-state and footage inspection supported all six custom clauses: establish a crafting-table worksite, collect two new natural logs at least six horizontal blocks away and return, then collect four more on a second trip and return alive on the surface within interaction reach with at least six logs. Final inventory held **seven logs**. The operator accepted the recording on 28 October.

The runtime completion remains **`model_reported_unverified`**: independent episode review does not install a trusted automatic verifier. There were **11 admissions**, **100.825 seconds** in model-request spans and an **18.604-second** longest action-free gap. Cleanup was confirmed. This was not an improvement over the earlier 198.88-second episode and establishes no general reliability, latency or full-game claim.

Two partial-navigation unknowns were fenced and reconciled before fresh replanning; neither was replayed or rewritten as success. Local walking helpers were reused, but the second gathering trip used new source despite prior full procedure, arguments and outcome being available. Changed-quantity gathering reuse was not demonstrated, and no safely refused action exercised local refusal recovery. Broader I01, real inference-overlap/reaction, useful cross-session reuse and release requirements remain separately assessed.

### Current native planning baseline — 29 October 2026

The parent reran the real Fabric/Docker/Runtime/Store continuation baseline
before changing activation semantics. All eight cases passed: manual positive,
false-guard and Stop-revocation cases; automatic staging before and after
predecessor closure; automatic false/omitted guards; and Stop during a held
independent request. Peak simultaneous native effect ownership was one.
Runtime, sandbox and native cleanup were confirmed, with zero provider/Jev
calls and no experience promotion.

The first attempt failed before any program or native effect started: the
synthetic caller supplied only a tool to the SDK's pre-dispatch hook, while
the current raw-argument gate requires the full tool-call context. The caller
now constructs that typed context without bypassing the production hook.
A failing-before/passing-after regression exercises real named-source
registration and execution through that boundary. The failed attempt remains
separate from the successful repetition.

The selected native build used Java 21 and passed the boundary, contract and
motor proofs. The system-default Java 25 build had failed during Gradle Test
task construction; selecting the documented JDK resolved it without changing
the build system or system default. Existing mapping/deprecation warnings
remain. This baseline proves the exercised continuation/ownership path, not
resident tick-rate input, model-authored gameplay, learning or lower latency.

### Native control and capture timing — 29 October 2026

The GHV2 repetition passed the same eight continuation cases with confirmed
cleanup and zero provider calls. It retained 385 request timing samples with
no missing, invalid or omitted samples, 16 source timing events, and confirmed
startup and cleanup spans for all 12 worker executions. Fifteen successful
movement intervals joined actual native key sampling to their original
operation, request and native clock.

The separate recording proof retained all 132 delivered frames. Its replay
lasted 4,480 ms against 4,414 ms expected, within the declared 134 ms tolerance.
Inspected native images showed the live world, death menu and explicit respawn.
The compiled browser renderer also displayed the real 1280×720 native feed
through its WebGL path; the owned world and backend were stopped afterward.
These are infrastructure checks, not model gameplay or a frame-rate benchmark.

Applying the interval partitioner to a 56.374-second retained control window
left 2.747 seconds in overlapping categories and 29.445 seconds unattributed.
Neither value is measured idle time. A separate recording-process window
identified its explicit 1.600-second deliberate wait without subtracting clocks
between processes. The SDK's first complete received SSE event is observable;
raw network-first-byte timing is not. No pause reduction or faithful ordinary
attack/use semantics is established by this instrumentation.

### Ordinary native input conformance — 29 October 2026

The `minecraft.action@2` cutover adds bounded ordinary world-input clips while
retaining the current assisted profile. Start with fresh working programs
after this capability change; cached validation from action version 1 is not
a current grant. Older source and executions remain history, not a live alias.
The [ordinary input contract](runtime-contracts.md#ordinary-minecraft-world-input)
separates counted presses, held keys, declarative selection and applied view.

The rebuilt native artifact passed 24 zero-provider cases with confirmed
cleanup and 24 complete recordings. Nine cases checked assisted camera
settlement, small turns and yaw wrap in all three motor profiles. Ordinary
cases covered held digging versus entity clicks, counted clicks and crosshair
misses; main-hand PASS to an offhand shield; bow draw/turn/release with a later
server projectile; completed/interrupted eating; bucket and boat fallback;
hotbar/swap/single/all drop; simultaneous attack/use; cancellation and screen
fencing.

The real drop case exposed a production ordering defect: declarative selection
had been queued until after vanilla synchronized the selected slot. Client
prediction showed seven dirt while server-side consequences did not match.
Selection now applies at step entry before normal synchronization. The repeated
case independently confirmed seven dirt on the server, then an absent selected
slot after drop-all. Explicit hotbar key edges retain vanilla ordering.

The active-owner isolation case sent keyboard, Control, button and motion
events only to the verified owned X11 window. Raw GLFW key states and blocked
callback counters changed, but game polling, movement, view and attack/use did
not follow physical input. The owned cursor override disappeared after release
even while those raw keys remained held. A single authored drop stayed single
with physical Control held; independent server state confirmed it. This
evaluator uses `xdotool`, system Python and libX11, without focusing a window,
warping the global pointer or injecting global input. Normal app operation
does not depend on that evaluator helper.

All 24 clips completed browser playback at rate 1 with no media errors.
Selected native frames and bow, drop and camera sequences were inspected.
These checks establish the exercised input mechanics and presentation, not
equivalent visual smoothness, a model's skill acquisition or human-like
gameplay. The cancelled bow retained an unknown partial outcome with actual
use released. Inventory opening retained the visible screen and refused later
world input rather than auto-closing it or replaying unfinished steps.

### Persistent visible-screen checkpoint — 29 October 2026

The initial checkpoint used native control protocol 4, `minecraft.action@3`,
`minecraft.visible_screen@1` and the separate
`minecraft_assisted_rgb_360_r8_gui_v2` profile. Earlier action-v2/r8-v1
gameplay and conformance results keep their original identities. Fresh
working programs are required across this cutover; old nullable or untagged
screen grants are not accepted.

A bounded zero-provider native smoke passed with confirmed cleanup. It
opened the actual vanilla inventory, projected all 46 slots including empty
slots and an empty cursor, and retained that screen across reads, a no-input
operation and three ordinary pointer transfers. Left pickup carried four
planks; right placement left one in the slot and three on the cursor; the
last placement restored four with an empty cursor. Three matched server
transaction receipts recorded those transfers without inventing production.
Explicit close left no visible screen, and an independent server inventory
check confirmed all four planks. The inspected native frame showed the
persistent inventory. All 91 delivered frames were retained.

This checked native startup, read/slot/cursor/persistence/close and receipt
integration, not complete progression conformance. Chest and furnace
work/return, recipe-book crafting, merchant trades, anvil text/results,
resize/replacement races, delayed/lost acknowledgements and the corresponding
production hooks were outside that smoke's evidence. Custom-drawn enchantment,
beacon, loom and stonecutter choice regions rejected as unsupported in that
artifact. The current [visible-screen contract](runtime-contracts.md#persistent-visible-minecraft-screens)
uses action4 and includes rendered choices and targeted scrolling; the
earlier smoke retains its action3 identity.

### Complete visible-GUI conformance — 29 October 2026

The rebuilt action4 artifact passed all 18 declared zero-provider cases with
confirmed native, Runtime and Docker cleanup and one effect writer at a time.
Coverage includes chest/cursor conservation, direct and recipe-book crafting,
32/33/64-event shift-craft receipts, a conserved furnace top-up followed by
nearby work and three retained ingots, merchant paging and stale-row refusal,
anvil text, stonecutter, loom, enchanting and beacon controls. The isolated
worker used the real API, server production evidence and builtin goal verifier;
its verified run reached completed without promoting fixture source as experience.

Local source/cursor conflicts, physical modifiers, Escape, held resize and
handler replacement, delayed acknowledgement and lost/late acknowledgement
cases also passed. Lost effects remained unknown and were not replayed.
All 3,841 recorder-delivered frames were retained in 19 complete replay
segments. The resize transition separately retained 21 original packets and
PNGs across 1280×720 and 1024×640; no combined resize video was fabricated.
All 19 segments completed playback at 1× with no media-element errors, and
selected native GUI and resize frames were inspected. Audio was not recorded.
These evaluator-authored checks establish mechanics, not autonomous gameplay
quality or a model's ability to choose the demonstrated operations.

### Basic feedback conformance — 29 October 2026

Feedback profile v3 passed eight actual native cases and a separate isolated
Runtime/Docker/SDK worker check, with confirmed cleanup and zero provider calls.
The cases covered own body/equipment/status, vanilla block/entity/miss
crosshair, a delivered GHV2 pose join after full turns, bow use/release,
movement, water/air/lava/own vehicle, independent actual-heard priming cursors,
expiry and life/space fences. During a stopped server inventory request,
the own client effect duration decreased from 559 to 556 while the observation
count stayed unchanged; the inventory observation settled only after resumption.
That is a changing body-value witness, not just an advancing frame counter.

The current host also rejects obsolete GUI feedback after a coalesced
close/replacement notice. Three failing-before/passing-after parser regressions
cover close, replacement and reincarnation; a same-view content-revision
case remains accepted. The final bare suite passed 1,266 tests with no failures.
All 792 delivered frames were retained across two complete recordings, both
played at 1× with no media-element errors; selected priming, fluid, vehicle
and worker GUI frames were inspected. Audio was not recorded. Mute and
attenuation negatives have production-predicate proofs, not live mute-test credit.
This establishes the basic read interface, not resident streaming, expanded
visibility, multipart combat attribution or autonomous gameplay quality.

### Camera-bound entity perception — v7

The active [v7 profile](runtime-contracts.md#current-player-observable-structured-profile)
requires an actual entity-renderer witness in a completed framebuffer. Camera
rotation and dispatcher model placement are separate transforms in the pinned
client. Uncaptured renders cannot erase or refresh the previous completed
image's evidence; the next completed image replaces it atomically.

Four actual-client conformance cases passed: a visible front entity reached both
read paths; turning away removed it and rejected an old-target attack without
camera or world effects; a new silent entity behind the camera remained hidden
until a turn; and a genuinely played sound behind the camera remained audible
without granting entity geometry. All owners closed, with zero model calls.
Java 21 geometry, capture-boundary and sound proofs also passed. Earlier failed
native attempts exposed the capture-publication and camera-transform defects;
they remain failed, not additional successful repetitions.

This qualifies the exercised sensing boundary. It does not establish pixel-only
perception, model-authored combat competence or ordinary-world reliability.

### Native dynamic sensing and mechanical feedback — v6 cohort

The historical v6 assisted profile kept its eight-block, camera-independent range. Frame
schema 3 separates `dynamic_entities` from the 500 ms terrain cache in
`visible_world`. Dynamic geometry is acquired once per native tick on the
client thread, including while a semantic motor owns the avatar. A spatial
candidate cap of 128 precedes visibility filtering; at most 32 permitted rows
are returned. Coverage is always partial, without rejected-candidate counts.
Terrain keeps its original sequence, timestamp and one-second stale threshold.

The v6 results below do not qualify the changed v7 perception condition.

Entity optics permit air, open water and bubble columns. Waterlogged solids,
lava, unknown cells and opaque walls still block the conservative structured
projection. Vanilla visibility, invisibility, world and distance checks remain.
Visible bounds and an aim point describe permitted geometry, not hidden target
health or intent. Admitted mechanical targets have bounded active pins;
producer neutralization invalidates dependent caches and handles together.

Current body feedback includes actual blocking readiness, active-use ticks and
equipped-item durability. The bounded `mechanics` ring correlates stream attack
key consumption and ordinary attack-callback entry with generation, input
sequence and ordered edge. These are separate facts: a consumed key need not
invoke an attack, and callback entry proves neither accepted damage nor a kill.
Actually heard hurt/death, shield, item-break and attack sounds use the existing
coarse audible channel and independent cursors. They carry no source identity
or damage attribution.

Session children may carry an exact executive supervision identity. Only a
fresh retained native frame continuing that same child renews its 250 ms lease;
the original child deadline remains in force. Expiry fences further motor,
finite-input and GUI emission, then releases the exact producer. GUI cleanup
keeps its applied prefix and uncertain inventory effects and leaves the screen
open. The executive must inspect current screen/cursor state before choosing
another operation. Exact cancellation uses the existing out-of-band owner
retirement lane; queued old-generation operations cannot inherit a replacement
owner.

Holding attack still means an ordinary held key, not repeated entity strikes.
When use is already active, a same-tick release and attack press can be consumed
without invoking the attack callback. This is observable input behavior, not
a host-supplied combat policy. The native sensing and world-input fixtures
contain bounded probes for these mechanics; a passing conformance probe does
not establish model-authored combat competence.

Java 21 build proofs and actual Fabric sensing, world-input and controller-stream
fixtures passed on 9 November 2026. The latter two exercised 28 and 12 cases.
A separate connected supervision proof kept the game ticking during 500 ms
without renewal: semantic and GUI producers stopped, late renewal was refused
and the GUI retained its handler and uncertain cursor/slot effects. Sixteen
fresh renewals did not extend a 1,200 ms semantic child's original deadline;
its measured native duration was 1,239.87 ms. All admitted fixtures confirmed
cleanup and made zero provider calls. A stale-artifact admission failure and an
evaluator probe with an invalid movement duration remain failed attempts.
These results qualify the exercised mechanisms, not a combat win rate or
continuous useful model-authored play.

An initial integrated Luna episode remained a failed resource/resumption test.
Its own generated executive defeated one normal zombie with a wooden sword
while an admitted strategic request was withheld for 50 seconds. Independent
vanilla records confirmed the kill and zero deaths; observed health stayed
full. But it collected no logs: its first policy repeatedly replaced its own
finite digging tasks, then remained observation-only after the fight. A later
revision was additionally blocked by the diagnostic worker-frame byte cap.
The cap was an evaluator defect, not proof that the revised gameplay algorithm
failed. This episode demonstrates a possible local combat path, not the
integrated continuity gate, ordinary-world reliability or human-like appearance.

### Native controller transport conformance — 30 October 2026

Profile v4 and frame schema 2 passed eleven actual Fabric cases with confirmed
cleanup and zero provider/Jev calls. The same owner held a bow through new
turn snapshots and released a server-observed projectile. Ordinary
selection/drop retained exactly six of seven source items on the server.
A sixteen-operation visible-GUI sequence reached confirmed input application
after 7,145 ms, then produced a separate successful server receipt and retained
four planks. Its pointer/receipt timeline was not relabelled a 150 ms gesture.

Review found and corrected premature GUI retirement, duplicate movement
sample credit, a two-second deadline that truncated lawful GUI sequences,
and lost partial counted-press evidence. The GUI race has an actual
failing-before/passing-after witness: with FINISH stopped after application,
retirement now retains the unknown receipt and drains the old driver before
its ACK. A fresh controller can then acquire ownership while that server
is still stopped. Repeated movement representations remain partial rather
than inventing clicks; a counted inventory press retains its one consumed
press when screen entry clears the suffix.

A stopped native process also held retirement unresolved until resumption.
The measured retirement was 604 ms after capture, not within the nominal
250 ms lease; its stale queued attack was never credited. Separate writer
proofs exercised a real non-reading TCP peer, controlled full message/byte
queues, reserved ACK admission and cancellation without a game-thread
socket wait. The recording retained all 962 delivered frames, without audio.

The final cohort also passed all 24 finite-input cases and an isolated
Runtime/Docker/SDK GUI/frame check. Java 21 native proofs and typechecking
passed; the isolated bare Bun suite passed 1,299 tests with no failures.
All 26 resulting replays completed at 1×, with 26 playing/ended pairs and
no media-element errors. Selected bow, GUI and worker frames were inspected.
These are transport and vanilla-input conformance results. They do not
establish a generated resident scheduler, a 20 Hz performance benchmark
or better autonomous gameplay.

### Explicit recording profiles and a thirty-minute proof — 30 October 2026

Recording and journal limits now come from a checked evidence profile rather
than an implicit larger default. Profile admission precedes native preparation;
manifests retain effective limits, durable bytes, pending peaks, capture times
and incomplete outcomes. Ordinary short-run defaults remain unchanged.

A zero-provider controlled technical sample retained every delivered frame,
writing 10,023,045,412 durable PNG bytes. Peak pending raw storage was
11,060,184 bytes; pending frames, encoders and queued work were empty after
completion. Native, file and renderer cleanup was confirmed.

| Evidence | Images | Duration, ms |
|---|---:|---:|
| Original PNGs and native index including final hold | 54,004 | 1,800,141 |
| Initial MP4 projection | 45,006 | 1,800,240 |
| Corrected MP4, including the final boundary repeat | 54,005 | 1,800,142 |

Duration agreement alone did not establish frame-complete export: the initial
PNG demuxer used a 25 FPS time base, and a separate terminal-gap case exposed
an understated MP4 endpoint. The correction preserves millisecond presentation
timestamps and every image without B-frame reordering. All encoded packet
timestamps matched the original index; the unchanged 134 ms tolerance was met.
Original PNGs, indexes and initial movies remain unchanged.

The corrected full movie reached the end at 1× without seeking, rate changes
or media-element errors. Recovered source-abort requests remain in the temporary
viewer's browser log; the initial viewer's content-length errors are also
retained. Neither result is presented as error-free HTTP delivery.

The recording includes a deliberate wait, native effect interruption, the
vanilla death menu and explicit respawn in an evaluator-prepared arena.
It proves bounded evidence retention for this horizon, not autonomous survival,
model competence or sixteen-hour durability. Audio was absent; structured
observations and pixels remain unsynchronized, and upstream renders can be
omitted even when every delivered frame is retained.

### Bounded native episode-recording proof

The parent completed the separate zero-inference native recording proof with **PASS**, confirmed cleanup and **zero provider calls**. All **123 delivered frames** were retained as **123 PNGs**. Expected replay duration was **4,097 ms**, actual duration **4,160 ms**: the **63 ms** difference was within the predeclared **134 ms** tolerance. Maximum observed capture gap was **51 ms**; this proves retention of delivered frames, not every native render.

The parent inspected alive, death-menu and respawn PNGs and a six-frame replay grid: opaque RGB was readable, with the death-menu transition and respawn visible. The recording retained a deliberate **1,600 ms wait** and **1,400 ms menu hold**. The interrupted native motor receipt reported cancelled and neutralized; subsequent diagnostics showed neutral controls, an inactive motor and no action motion emitted.

This proof completed normally without an OS signal. It does not establish actual SIGINT handling or Runtime Stop. Audio was absent; the result does not establish synchronized capture, `strict_visual`, live model vision or gameplay efficacy. See the [bounded recording contract](runtime-contracts.md#delivered-actor-images-and-recorded-episodes) for implementation limits.

### Recorded collection-to-crafting attempt: goal not verified

One justified higher-capability GPT-6.1-Sol attempt used discovered text-and-image support for **“Collect wood and craft a crafting table.”** It started in fresh ordinary Normal Survival with empty inventory and fresh working programs, without supplied tactics, items or coordinates. The declaration allowed **30 host admissions, 300,000 ms gameplay and 900,000 ms total**. A concrete interface/evidence revision authorized this single attempt while retaining the two earlier unsuccessful wood attempts.

The recorded outcome was **platform pass / agent goal not verified / provider unknown**, stopped at the finite gameplay deadline, with all eight cleanup resources closed and native cleanup confirmed. Three search-program revisions and one recovery program validated and ran; no retained validation/capability failure was identified. The agent executed **28 camera actions, 81 movement intervals and one successful explicit respawn**. It issued no navigation, digging or crafting action, acquired no inventory and never established the wood milestone. Exploration encountered water and obstacles; two drowning deaths occurred while the world continued during replanning. The first recovery adopted a new life; the second recovery turn was cut short by the deadline. The final fresh observation was dead, in water and empty-handed. Blocked feedback reached later model contexts; no missing-critical-feedback or confirmed crafting/pathfinder fault was established. Low-level action success did not imply useful traversal or task progress.

There were **22 admissions, 22 SDK-visible contexts with image references and 22 usage events**: 19 tool-use completions and three aborts, two associated with death and one with the deadline. Reported subtotals were **69,635 uncached input / 103,552 cache-read / 0 cache-write / 3,586 output**. Complete host usage-event coverage does not establish complete provider consumption: the abort events had SDK-zero counters and no response ID. Their actual usage, wire-attempt counts and subscription cost remain unknown. No SDK-visible HTTP/provider error was retained. Observed host connections and actual SDK events support the configured local-proxy inference route, but connect-only tracing neither attributes every descendant connection nor equates socket connects with model requests.

The private journal retained **9,032 permitted evidence records** with no journal-level failure; hidden reasoning and credentials were intentionally excluded. It retained 1,234 pre-cap execution-evidence records, but branch instrumentation omitted diagnostic decisions for all three search roots. This is not a complete branch-by-branch trace. All **9,002 delivered PNGs** were stored, with one disclosed upstream missing sequence and a maximum capture gap of **65 ms**. The capture timeline was **300,176 ms**; the replay was **300,240 ms**, a **64 ms** difference. The replay is a review derivative, not one encoded frame per retained PNG, and has no audio. Parent inspection showed authentic terrain, water and underwater drowning; fresh native observations, rather than selected replay samples, establish the two deaths. Neither synchronized capture nor strict-visual perception is established.

At that stage, the selected follow-up was a **zero-inference movement, obstruction, water and progress-semantics investigation** on the existing native body with an explicitly synthetic controller. That historical diagnostic scope was not a gameplay result or authorization for repeated paid attempts. The failed episode establishes no learning, improvement or broader release pass.

### Verification scope after the published checkpoint

The named-program interface cutover is separate from the published `915c85c` checkpoint. Implementation and prepared fixtures do not establish a new full proof. Use the canonical [four-tier verification, model and stopping policy](learning-and-evaluation.md#verification-and-live-evaluation-policy), and report exact parent-owned results for the new source cohort before claiming it passed.

The single authorized GPT-6.1-Sol control subsequently passed the **old interface**: **10 host admissions / 10 reported usage messages**, real predecessor work during inference, staging, fresh validation, explicit main activation and successful follow-up. Cleanup was confirmed and the custom goal remained unverified. This is a technical API-control result, not ordinary gameplay efficacy, promotion, causal efficiency or acceptance of the new interface. It does not erase the unsuccessful Luna attempts, and it must not be repeated automatically.

Before the continuation cutover, the parent verified the real Fabric/Docker/Runtime/Store **manual-planning baseline** in **86.41 seconds**. All three cases passed: `current_manual_planning_positive`, `false_predicate` and `stop_revokes`; report, resource cleanup and runtime cleanup were true, with no cleanup errors and `baseline_gate:BASELINE_PASS`. The fixture used an explicitly synthetic strategic caller, a real isolated predicate, **zero provider/Jev calls and no experience**, with the unchanged `f376…` native artifact. This opens the integration-edit gate; it proves the exercised old manual path, not the new named interface, automatic continuation or gameplay efficacy.

The parent reported these focused evaluation checks, all with zero failures:

| Exercised boundary | Tests / assertions | Scope and elapsed |
| --- | --- | --- |
| Policy/config/tiers | 17 / 143 | Three files, 925 ms; precedes the pagination-cap correction. |
| Pagination-cap boundary | 6 / 96 | Config 500/501 boundary, 147 ms. |
| Results/scenarios/evidence/world seed | 22 / 106 | Four files, 424 ms; semantic goals, receipts, metrics, classification, pagination and seed contracts. |
| Tier command smoke | 5 / 92 | Actual CLI help and selected config unit command, 11 ms for the tests. |
| Program-interface consumer regressions | 14 / 120 | 2.98 s after correcting the three independently reproduced projection defects; whole typecheck also passed, 3.71 s combined. The original three consumer tests first failed in 847 ms and passed after production fixes without weakened expectations. |
| Frontend build | — | Vite built 111 modules in 86 ms after the actual web projection-parser change. No Gradle/JAR rebuild; `f376…` remained unchanged. |
| Combined Bun regression, before strictness correction | 294 / 1,815 | All 28 files passed in 45.51 s, 45.55 s wall time, after the projection fixes. This does not verify the later provider-strictness correction. |
| Final combined Bun regression, explicit strictness | 295 / 1,827 | All 28 files passed in 45.53 s after the one-setting provider correction; whole typecheck also passed. The parent verification sequence took 46.95 s. |

These results cover local contracts, whole typecheck, the affected frontend build and the final combined Bun regression. They do not establish actual natural-model acceptance or require rebuilding unchanged Java.

Before the provider-strictness correction, the parent verified the public native-planning suite in **104.05 seconds** on real Fabric/Docker/Runtime/Store, using the existing `f376…` artifact without a rebuild. All **eight cases passed**: manual positive, false guard and Stop revocation; automatic staging before predecessor closure and predecessor closure before staging; automatic false guard, omitted guard and Stop revocation while a request was held. The actual report recorded `cleanup:true`, `runtime_cleanup:true`, no cleanup errors and **zero actual provider/Jev calls**. This establishes those exercised manual/automatic admission and lifecycle paths with a synthetic strategic caller, not natural-model decisions, gameplay efficacy or promotion. The old three-case baseline retains its separate pre-cutover scope.

The parent also inspected the actual isolated Electron UI, signed out with no world/run and Start disabled. Trusted History, Settings, Escape dismissal and focus return worked at **1440×900** and **1000×650**, with no observed clipping, global scrolling or interaction exceptions. Normal window-manager close exited **0**, after which both owned service ports refused connections. An initial diagnostic CDP port mistake was corrected without restarting the app; a nonfatal Mesa permission warning remained separate. This is a startup/history/settings/shutdown smoke, not live-game UI or provider evidence.

#### Bounded natural wood comparison

The parent completed one plain wood-collection attempt each with Luna and Sol under the same technical hypothesis. **Both retained `platform_status:pass`, `agent_status:goal_not_verified` and `provider_status:unknown`**, with zero durable actions, registered sources or executions. All five cleanup resources were confirmed and neither evaluator recorded a terminal failure. Only wood ran live; crafting-table and stone scenarios remain implemented/tested definitions, not live results.

| Model | Wall elapsed | Host admissions / usage messages | Reported subtotals: uncached / cache-read / output |
| --- | --- | --- | --- |
| Luna | 109.15 s | 12 / 11 | 40,586 / 55,936 / 2,896 |
| Sol | 176.52 s | 12 / 11 | 15,148 / 106,624 / 3,352 |

Reported cache-write subtotals were zero. **Usage coverage is incomplete**: the table contains only the 11 reported messages in each attempt; full token totals and subscription cost remain null. These unsuccessful attempts support no invoice, savings or cost-per-success claim. The parent inspected the durable governance ledger: exactly two settled rows and two unsuccessful attempts under the same hypothesis, with no additional hidden attempt. Under the policy then in force, the shared allowance was exhausted and no third live attempt or budget reset was authorized.

Luna received five new-program conflicts after supplying `based_on:1`; Sol received six across two new names. Read-only SDK inspection confirmed that local JSON schemas made `based_on` optional and the host correctly rejected revision metadata for a new name. The actual SDK transport omitted `strict`; the effective remote grammar was not captured, so neither a strictness cause nor sole model fault is established.

The [official function-calling guide](https://developers.openai.com/api/docs/guides/function-calling#strict-mode) says Responses may normalize an omitted strict setting where compatible, with best-effort fallback otherwise; explicit `strict:false` opts out. A zero-network regression using the actual SDK request builder and a local model of that documented normalization first failed: **0 passed / 1 failed in 62.37 ms**, because initial program creation could not omit `based_on`. This is local transport-contract evidence, not captured remote grammar or proof of either live failure's cause.

The production correction was only an explicit `AgentTool.strict:false` setting, with host Zod/conflict/authority/source/ownership/lifecycle/isolation fences unchanged. The exact zero-network SDK-boundary test then passed **1 test / 12 assertions in 616 ms**, followed by the whole typecheck and **295-test final regression** recorded above. No model/native/UI rerun or build followed this provider-only setting; the native and desktop evidence retains its preceding scope.

At that checkpoint, post-setting gameplay was **untested** and the remote grammar's causal role remained unknown. The two original reports remain immutable negative outcomes; no third live attempt or budget reset was authorized for that comparison. Later development follows the [current model and attempt policy](learning-and-evaluation.md#attempt-admission-and-stopping), not a reopening of this comparison.

### Current native build and pure-controller proof

The parent compiled CameraMotion, NavigationGaze and MotorProof alone with Java 21 and reported the pure-Java proof passing. Balanced 90° settling measured **290/290/300 ms** with deterministic **5/10/20 ms** integration steps and a **100 ms** hold. Speed/acceleration, wrap/no-overshoot, monotonic-clock, route and strafe predicates passed.

The subsequent parent `bun run build:native` passed in **10.07 seconds**, compiling the lifecycle mixins and camera integration. Gradle `check` actually ran both `nativeBoundaryProof` and `nativeMotorProof`, which passed their pure-Java boundary/lifecycle/route predicates. The resulting JAR SHA-256 was `f1f0848c92384ddb17a3e40f72bd6dc51bcc76109fa9de4b54523534858884ef`. Known external GLFW-mapping, deprecated-API and Gradle warnings remained; this was not a warning-free build.

These are source integration and pure-controller results, not live Minecraft camera/render FPS, end-to-end turn latency, actual DeathScreen/respawn, goal closure or ordinary gameplay proof. The first TypeScript check reported three old fixture-field mismatches and a UI `planning_active` mismatch; the post-review results below retain that failed attempt separately from its successful repeat.

### First current native fixture: setup failure

The first live schema-2 fixture connected an authoritative alive player at health 20 with a real session UUID and received **159 native frames** before confirmed cleanup. Build, client and server hashes matched the `f1f0848c…` cohort above. Its evaluator-owned flat-platform setup tried to fill chunks before loading them; the server returned **“That position is not loaded”**, and the player fell instead of standing on the intended platform. No death case began (`cases:[]`).

Retain this as an unsuccessful fixture-setup receipt, not a product death/gaze/respawn failure or pass. Cleanup was confirmed. The frame count supplies no FPS/latency measurement, and the fixture's privileged commands are not model or production capabilities. A repeat requires corrected evaluator chunk readiness; current death/respawn/gameplay proof remains pending.

### Post-review checks and replacement native cohort

The parent reported `bun run check` passing after the fixture/UI corrections. Isolated instrumentation passed **17 tests / 71 assertions in 386 ms**; targeted planning, strategic-overlap, planning-admission and runtime-life/session checks passed **27 tests / 219 assertions in 13.11 s**. An earlier whole-suite attempt exceeded **600 seconds** and remains a failed check attempt. Eight isolated reactive test failures used an invalid fixture yaw of 12 radians outside the admitted ±2π range; the fixture was corrected to 0.2.

After fixture-data and clock/cleanup corrections, the isolated reactive repeat passed **9 tests / 42 assertions in 3.50 s** and the whole suite passed **143 tests, 0 failures, 1,021 assertions across 20 files in 32.81 s**. Typecheck passed on the same source, and the UI build passed with **111 modules in 86 ms**. These are implementation checks, not model gameplay or real-provider proof.

A later native build with three lifecycle-race corrections passed in **9.53 seconds**, producing SHA-256 `06ff798310da9154071cf6a1f66e02164d95fae608efbd737fc6f07c52158212`. The first actual death case on the earlier `f1f0848c…` cohort retained a connected dead session, `game.error:null` and native video. Its DeathScreen/composite probe did not pass; a mapped-class-name comparison was suspected and the evaluator changed to a stable instance check. This is state/stream evidence, not accepted visual DeathScreen proof or a diagnosis of a product failure. Live repetition on the `06ff7983…` cohort, confirmed respawn/goal closure and ordinary gameplay results remain pending.

The `06ff7983…` native death-driver repeat subsequently passed **two cycles**, neutralization and cleanup. The runtime DeathScreen class was `net.minecraft.class_418`, confirming that the earlier named-class string comparison was a fixture defect. The parent had not yet accepted the actual PNGs at this report. A separate motor probe failed a case and remained under investigation; no blanket native pass or performance improvement follows. All these native fixtures made **zero provider calls** and used diagnostic requests, so they do not establish a real model-selected respawn, task success or policy efficacy.

### Accepted current diagnostic life/recovery evidence

The parent subsequently inspected and accepted the actual native **“You Died!”** menu PNG, using the stable DeathScreen instance predicate rather than a mapped class-name string. Each of two dead holds retained **68 frames over 2,242 ms**. Explicit diagnostic vanilla respawn returned authoritative health 20 in **154.8 ms** and **238.5 ms**. These are two fixture samples, not latency percentiles, ordinary-gameplay efficacy or a model's decision to respawn.

The full current Runtime/native/Docker/Store/Bridge fixture then reported **PASS**, confirmed cleanup and **95.61 seconds** elapsed. Its recovery root adopted the confirmed new life while the same session, client and connection epoch were retained. The fixture used an explicitly identified diagnostic Agent and **zero provider calls**; it proves this integrated control path, not real LLM-authored recovery.

Separately, the actual UI exposed all eleven evidence tabs; Trace, Comparison, Learning, Life and Planning were exercised on legacy history without errors or global overflow at 1440 px. This is retained-history UI evidence, not a final current-game/minimum-viewport capture. The separate motor probe remained unpassed while evaluator block-center/integer-cell comparisons and cancellation assertions were corrected. No general motor/performance improvement, new ordinary-world goal, real Jev use or playable/release pass is established.

### Accepted current native motor and item-boundary fixture

After correcting evaluator block-center/cell comparisons and cancellation assertions, the `06ff7983…` motor fixture passed **all 16 cases** in **88.47 seconds**, with confirmed cleanup. Nine camera cases covered 90° turns, 3° settling and yaw wrap in all three profiles. Native 90° action durations were **484.910 ms precise**, **334.929 ms balanced** and **251.105 ms fast**; corresponding host round trips were **567.85 / 418.79 / 350.65 ms**. Do not conflate the native action and host timing, or treat these single-fixture samples as a controlled old/new speedup.

Five navigation cases—flat pitch settling, upstairs, downstairs, explicit free gaze and target gaze—returned successful range completion. Pitch varied with actual sampled route geometry rather than fixed slope constants. The item-boundary case exposed registry identities for eligible clear-line-of-sight items in front and behind the camera, while excluding occluded, out-of-range and invisible items and exact stack counts/NBT. This exercises the unchanged camera-independent structured profile, not a permission expansion or the complete I01 suite.

The fixture retained unknown cancellation/missing-receipt effects while confirming the real neutralization barrier and keeping the healthy session/video. Final native stream cadence measured **29.978 FPS** on this host. Readback/writer diagnostics were recorded, but no unprovided values, all-hardware guarantee or causal FPS improvement is inferred. This is zero-provider mechanical/conformance evidence. A separate first ordinary real-model goal attempt paused after **seven real calls**; its cause and detailed outcome were still under inspection and are not inferred from these successful fixtures.

### First current ordinary-model attempt: failed goal and diagnosed infrastructure behavior

The first ordinary real-model attempt on `06ff7983…` paused without completing its first goal after **7 calls**, reporting **40,355 uncached input**, **64,896 cache-read** and **682 output tokens**. No cache-write or cost value is supplied here. Its first dig selected an observable target about **5.8 m away**, outside mechanical reach. Only roughly **17 ms** of preparation and a tiny camera change occurred; no world-action packet was emitted.

The native generic emission flag nevertheless classified this rejection as `unknown` because it counted preparatory aiming. The core then paused the whole run despite authoritative alive state, healthy transport and confirmed native neutralization. This was not solely a model tactical failure: the target choice was out of reach, while outcome classification and the global pause prevented ordinary autonomous reconsideration.

The subsequent source correction separates `camera_changed` from `world_effect_emitted`, performs mechanical target preflight before aiming and tracks actual outgoing dig packets. Known pre-emission rejection can return failed; genuinely unconfirmed world/input emission still remains unknown. Healthy-session unknown reconciliation now fences old scope, confirms the actual barrier/worker drain, obtains fresh authorized same-life state and wakes one new strategic generation without replay or human Resume. Missing safety/readiness evidence still pauses, and actual transport/death handling remains separate.

A post-correction native build passed in **9.49 seconds**, producing SHA-256 `6aaf800414a748f3186539f81830aa6ea3a7ed02e05f238400135868248c95b0`. Its changes were limited to pre-world interaction emission/preflight classification; the camera/navigation implementation was unchanged. The measurements above remain actual `06ff7983…` cohort results, not reruns on the new JAR. Updated core-uncertainty tests, native emission/saved-dead fixtures on the new hash and the actual ordinary-model retry remained pending. Preserve the failed attempt, source versions and unknown ledger; no successful retry, reduced-call benefit or learned strategy follows from the correction alone.

### New-hash emission and saved-dead evidence

On the `6aaf8004…` artifact, the native effect fixture passed **two cases** with confirmed cleanup. A visible out-of-reach dig failed preflight with `world_effect_emitted:false`, `camera_changed:false` and unchanged block evidence; fresh reads and a follow-up look worked on the same healthy session/video without reconnect. A genuinely emitted movement cancellation remained `unknown` with `world_effect_emitted:true` and `neutralized:true`. This verifies the classification distinction without relabeling any historical unknown result.

That cohort's saved-dead startup driver disconnected and relaunched the same world with a new process/session and epoch 2. Its initial authoritative state was **dead, health 0, `death:null`**, with actual DeathScreen and held frames rather than automatic respawn. No evaluator respawn or NBT edit supplied that state. This is an observed startup path; the parent's final report verdict was still being extracted at that point.

The parent subsequently confirmed that saved-dead fixture **PASS** and cleanup. Connection took **8,823.74 ms**; the **2,242.16 ms** dead hold received **67 new frames**, with no automatic respawn and ordinary effect requests rejected. The new process/session and epoch 2 retained the same world; no NBT edit or evaluator respawn altered the start.

An actual Electron launch on that private saved-dead data displayed the authentic in-app death screen, connected with `game.error:null` and a sampled **31 drawn FPS**, with no provider authentication or active run. It also exposed a stale `can_respawn:false` projection and an incorrect waiting caption. Source corrections publish the actual readiness edge without changing life/session/epoch/generation or duplicating the death, and distinguish “no active run” from waiting for an absent model actor. Corrected native/UI builds, bridge regressions and the final corrected GUI capture were still pending at this report; the displayed FPS sample is not a cadence guarantee.

After the core uncertainty-reconciliation changes, the next full-suite attempt recorded **147 passes and one timeout out of 148 tests**; the 100-child fixture exceeded five seconds and remained under diagnosis. This is not an all-148 pass, and the earlier 143-test pass remains attached to its own cohort. Current death-screen UI capture and the ordinary real-model retry remained pending; these diagnostic results do not establish model-chosen recovery or gameplay success.

### Accepted corrected desktop death/readiness view

On the later `f376…` readiness-correction cohort, HTTP snapshots alone observed `can_respawn:false` → `true` for the same saved-dead session, life 1 and `death:null`, with `last_observation_at` unchanged. No native observation/action, provider authentication, model or run was used during the wait. This confirms spontaneous authoritative readiness projection rather than polling an action or starting another death episode.

The parent inspected actual Electron captures at **1440×900** and **1000×650** and accepted the clear vanilla **You Died / Respawn / Title Screen** menu with native hand/HUD imagery. It was authentic framebuffer video, not an HTML death overlay or human gameplay/respawn control. The DOM showed `game.error:null`, caption **“Life 1 · dead · no active run”**, zero error notices, no global overflow and all five unknown usage counters visible. Sampled drawn cadence was **31 then 30 FPS**, not a sustained-distribution guarantee.

The application was closed after capture to release resources before real-model experiments. Camera/navigation measurements remain the original `06ff7983…` cohort evidence; the readiness build is not an invented motor rerun. The final typecheck/full-suite repeat was still pending after a test-only `PlayerLife` literal fix and a 100-child test deadline adjustment from five to fifteen seconds, justified by an actual 5.14-second durable-store run while retaining all 101 assertions. No new all-suite or model-gameplay pass is inferred.

### Later ordinary-model attempts: healthy session, unsatisfied goals

The later ordinary `f376…` attempt retained a healthy alive player at health 20 without an application fault, but both the break and collection tasks reached their configured **30-request limit without satisfying the goal**. Break-task usage was **136,609 uncached input / 368,384 cache-read / 5,399 output / 30 calls**; collection usage was **118,778 uncached input / 343,680 cache-read / 3,628 output / 30 calls**. Known cost was null; no cache-write figure is inferred. These limits bounded the diagnostic attempts, not a product monetary cap or successful-task measurement.

The break program's first version ran three blocked roots, each with **12 observations and zero actions**, and no motion. The model chose `insufficient_evidence` once. It attempted revisions but encountered name/latest-parent conflicts and a complexity **13 versus maximum 12** rejection; no linked second version was produced. Retain the actual absent exploration and unmet goals without attributing them entirely to infrastructure or claiming autonomous gameplay improvement, efficiency or useful revision.

Revision-tool ergonomics were being corrected to inherit the parent's stable name when unchanged while retaining strict latest-parent and complexity gates. Generic candidate-experiment guidance supplies no wood strategy, and the model's historical source remains unmodified. Any subsequent controlled model recovery/planning/revision fixtures must be reported separately from these ordinary Survival attempts; passing diagnostic mechanics does not upgrade either goal outcome.

### Current root-to-JS-reaction handoff fixture

A real Fabric/Docker-worker/Runtime/Arbiter fixture passed a one-shot validated local-JS reaction handoff with confirmed cleanup and **zero provider/Jev calls**. It cancelled the old root's movement, retained that action's `unknown` outcome, confirmed worker closure and native neutralization **before** admitting the selected look action. Peak native effect ownership was one, with the same healthy session, life and run retained.

This proves the exercised root-to-JS handoff, not a model-authored ordinary-gameplay reaction, real Jev invocation or policy efficacy. Independent review subsequently identified a separate direct policy-to-policy retirement race without a root worker; source corrections and an extended fixture were still in progress. Full preemption coverage and I05/P07 are not closed by this scoped pass.

Before that final retirement correction, the parent reported a later full-suite pass of **152 tests, 0 failures and 1,115 assertions**, with typecheck and build passing. The subsequent source fix waits for actual captured-action retirement after cancellation/drain and before settled-lease capture/native neutralization; cancellation itself does not wait on retirement. The 152-test result remains the pre-fix cohort, not verification of the final change. Targeted regressions and the extended real policy-to-policy fixture were still pending.

Post-fix typecheck and targeted regressions subsequently passed **27 tests, 0 failures, 214 assertions across two files in 21.28 seconds**. The extended live fixture repeated the root-to-policy case successfully, but the direct policy case never began: its private finite-trial activation payload was rejected as `invalid_request` by the advertised schema before any policy movement. The overall report failed; finalization recorded runtime cleanup false, masking the primary payload error, while resource cleanup was true. Retain this unsuccessful fixture attempt without calling it a production retirement failure or a direct-policy pass. The evaluator payload/diagnostic cleanup correction and actual direct-policy repetition remained pending.

The corrected extended real fixture subsequently passed **both cases in 69.70 seconds**: root movement to a JS-selected look, and lower-priority policy movement to higher-priority JS look without a root worker. Actual cancellation retained the unknown outcome; action-pump retirement/lease advancement preceded the final native barrier, and replacement followed its acknowledgement. Peak native ownership was one, with healthy same-session/life/run continuity and both runtime/resource cleanup confirmed. The fixture made **zero provider/Jev calls** and loaded no experience. This closes the exercised direct-native handoff case, not model-authored reaction, live Jev, gameplay efficacy or all possible preemption coverage. The earlier invalid-payload fixture remains a separate failed attempt.

### Accepted current alive desktop and structured trace

The parent exercised the actual desktop with retained ordinary-run history, a live **1280×720** Fabric stream around 30 FPS, stopped run and signed-out provider. At **1440×900** and **1000×650**, there was no global overflow; the minimum viewport gave **732 px game width out of 976 px work width (75%)**, all five usage rows remained visible and hiding the pane gave the game all 976 px. Resize, pane changes and reload preserved the same session/life 1, authoritative alive health 20 and stopped run, with no model calls.

Trusted browser mouse/Escape input closed the top evidence dialog, then History, restoring visible focus. An untrusted DOM-click group-close probe was discarded. Trace inspection found raw JSON appearing before the actual condition; the corrected structure now presents condition decision, source/action and attribution first, with the complete raw record collapsed. The parent inspected the corrected minimum-size capture showing **`i < 12` → true at line 1:16**, with Raw closed. No record fields were removed. Typecheck and UI build passed, the latter **111 modules in 93 ms**. This is evidence presentation, not chain of thought or gameplay success.

After the valid captures, a diagnostic X11 window-close command destroyed the X window rather than performing normal application quit and triggered GPU-context loss. The owned service group was then stopped through the harness. Preserve that diagnostic cleanup incident without attributing it to normal app shutdown or claiming a new graceful-close proof. The earlier death-screen captures are separate evidence, and no live Jev or inference-efficiency result follows.

### Controlled real-model death and explicit recovery

A separate controlled `gpt-6-luna` recovery experiment passed in **105.40 seconds**. The model alone authored two first-version programs. The evaluator forced death during an actual root movement; the real DeathScreen retained **56 authentic frames over 1,860 ms** while still dead, with no driver respawn or automatic respawn. A new model-authored recovery root explicitly requested vanilla respawn, observed the fresh life and performed a subsequent fresh-life action.

The same run, world, session, connection epoch 1 and native process were retained while life **1 → 2** reached authoritative health 20. The recovery root succeeded and the run-start inventory baseline remained unchanged. All cleanup was confirmed. Usage reported **15 provider usage messages / 15 host requests**, **63,370 uncached input**, **191,744 cache-read**, **0 cache-write** and **3,309 output tokens**, with null known cost.

This is actual model-selected recovery, separate from the zero-provider diagnostic Agent fixtures. It remains a controlled technical run with evaluator-forced death, stopped by the observer after evidence collection: no objective was verifier-completed, no ordinary Survival learning/efficacy or experience promotion was established, and it does not erase the unsuccessful ordinary goals above. Real-model planning/revision experiments remained separate pending work, with no result inferred.

### First controlled real-model planning attempt: no overlap

The controlled planning attempt failed its speculative-execution criterion. It admitted **30 requests**, with **29 reported usage messages**, **125,752 uncached input**, **347,136 cache-read** and **3,560 output tokens**. The model authored four first-version sources and completed five roots, but produced **zero planning events and no speculative overlap**. Twice it requested lookahead after its selected root had already closed, and the stale requests were rejected.

The retained sequence explains the observed handoff: skill start at 18.823, strategic turn end at 18.890, root end at 24.409, next main turn at 24.524 and lookahead request at 27.018. Successful ordinary roots do not establish speculative concurrency. No benefit or successful planning activation follows from this attempt.

Inspection also found real requests spent solely calling the then-exposed `request_purpose_set` accounting tool. Those requests consumed inference/context without gameplay or planning admission. A clean host-attribution replacement was being implemented using scheduler role/reason and actual returned tool calls, without a callable alias or inferred chain of thought. Removal alone does not establish reduced paid-model usage; the failed trace and original accounting remain retained.

An explicit optional start-time lookahead admission was being implemented to arm one bounded planner before execution handoff; default behavior remains no opt-in. Existing root/life/source/precondition/budget gates remain mandatory, with no unsolicited model calls. A later private controlled probe would provide a longer useful-root window and request that explicit opt-in without altering model-authored source. Neither source work nor a planned repeat is proof; the failed attempt remains retained.

After start-time opt-in, host classification and test-nullability corrections landed, the parent ran `bun run check && bun test && bun run build` successfully. The suite passed **163 tests, 0 failures and 1,231 assertions across 20 files in 42.03 seconds**. The full command sequence took **47.66 seconds**, including native boundary/motor proofs and native/UI builds; the UI built **111 modules in 81 ms**. The native JAR remained the existing `f376…` readiness cohort. These results verify the integrated source/check paths, not a new native camera benchmark or successful paid-model planning attempt. The new canonical real-model planning run was in progress and revision had not yet run.

### Later controlled planning attempt: overlap observed, activation unproved

The next real-model planning experiment still failed its full staged/validated/activated-follow-up criterion, but established actual inference/execution overlap. It admitted **30 requests**, with **29 reported usage messages**, **208,908 uncached input**, **292,480 cache-read** and **2,889 output tokens**. There were no purpose-label tool calls; host attribution was recorded. Two first-version sources produced three successful roots and three model-selected lookaheads.

Authorized root API action/observation calls continued inside an independent model-request interval with exact execution/source/request references; the report marked `overlap_proved:true` and `speculative_overlap:true`. The first speculative stage attempt failed `invalid_program`/`invalid_syntax` at precondition line 1, column 16. Its plan was rejected without a staged candidate, fresh validation or activation. A later speculative worker attempted forbidden `skill_start`, which was rejected; other work exhausted its finite allowance.

The exact historical invalid predicate source was unavailable, so the syntax location alone does not establish a wrapper/binding mistake or another specific cause. A forbidden tool attempt likewise does not prove that the provider catalogue advertised it. Current source-chunk and catalogue evidence must be kept separate from those narrower historical observations.

Thus overlap is observed, while complete speculative continuation and useful-play benefit remain unproved. Owners were clarifying canonical precondition-body bindings, narrowing the advertised speculative tool catalogue and permitting explicit bounded repair of preflight authoring errors without automatic retry or deadline extension. These source changes and any later controlled repeat cannot retroactively pass the failed attempt, establish causal speedup or improve the unsuccessful ordinary goals.

After the catalogue/correction cutover, the parent again passed typecheck, tests and build: **168 tests, 0 failures, 1,292 assertions across 20 files in 42.83 seconds**. The complete sequence took **48.46 seconds**, including actual native boundary/motor proofs and native build; the UI built **111 modules in 83 ms**. Source review confirmed matching provider/dispatch read-only authority and finite whitelisted correction without extra retries, counter resets or deadline changes. These checks do not supply a new paid-model full-planning success. A controlled real-model revision experiment was then running, with the next planning repeat still separate.

### Controlled model revision: versions measured, resolution link missing

The controlled revision experiment failed its durable-resolution-link criterion despite actual model-authored versioning and execution. The model created **v1 → v2** on the same program ID with parent version 1 and distinct source hashes, increasing canonical lines **35 → 43**. Both native roots succeeded, each performing one neutral look and two observations. An actual version comparison contained **one sample per version**, with a descriptive-only conclusion; no better performance, survival or ordinary goal result follows.

Captured `improvement_resolve` arguments paired a v1 opportunity and exact v2 reference with `decision:"insufficient_evidence"`. That violated the existing invariant that only `revise` may attach a revision. A generic `backend_unavailable` response hid the semantic constraint, after which the model resolved both opportunities as insufficient evidence with null revision. The report therefore remained failed on linkage rather than treating the code change or successful roots as full acceptance.

Usage was **30 admitted requests / 29 reported messages**, **197,734 uncached input**, **585,344 cache-read** and **3,179 output tokens**, with null known cost. Owners were replacing the misleading error with an actionable typed domain error and clarifying that revise can name a candidate experiment without claiming proven improvement. The invariant and eligibility gates remain unchanged. A fresh real-model repeat is required; no historical report/source is rewritten into a pass.

The subsequent source passed typecheck, tests and build: **170 tests, 0 failures, 1,319 assertions across 20 files in 42.41 seconds**; the full sequence took **48.28 seconds**, including actual native boundary/motor proofs and native build, with **111 UI modules in 80 ms** and the same `f376…` native artifact. A consumer regression exercised contradictory decision/reference rejection as typed `invalid_request` with no persisted record, then explicit corrected revise/reference admission once without qualification; conflicting immutable resolution remained typed. This verifies the error/decision contract, not a replay or pass of the paid failed run. New real-model planning and revision repeats remained separate pending experiments.

### Further planning repeat: copied-reference errors, no activation

Another real-model repeat retained actual overlap but failed the full planning criterion: **30 admitted requests / 29 reported messages**, **170,750 uncached input**, **346,752 cache-read** and **2,525 output tokens**, with null known cost. Both roots succeeded and the model selected two lookaheads, but there was no successful stage or activation.

Actual captured arguments showed a placeholder candidate hash rejected by schema, followed by a skill read on the fourth allowed request. A main-turn attempt later used 64 zeros after root closure; another speculative attempt supplied a valid-shaped but wrong digest, producing `source_changed` behind a generic backend error. The captured predicates were valid function bodies in this repeat. These concrete arguments do not explain the earlier unavailable invalid-syntax source.

Owners were removing the redundant caller hash from the canonical staging reference, using the model-selected immutable skill ID/version while the host captures canonical source/dependency hashes. This is a clean input cutover, not silently accepting an incorrect hash, changing the candidate or weakening fresh source/life/task/precondition guards. No old-hash alias, retroactive stage success, causal benefit or ordinary efficacy is claimed; fresh integrated checks and the next full real-model result remained pending.

The completed host-pinning cutover then passed typecheck, tests and build: **177 tests, 0 failures, 1,355 assertions across 20 files in 43.37 seconds**, with the entire sequence **49.22 seconds**. Native boundary/motor proofs and native build ran; the UI built **111 modules in 83 ms**, retaining the same `f376…` artifact. Source review confirmed strict old-hash rejection, exact current-run ID/version and byte/hash matching, dependency pinning/authority checks after waits, and closure recapture after fresh observation/predicate before admission. This is source/infrastructure proof, not a new paid-model stage or activation result. The real-model revision retry was still running.

### Accepted controlled real-model revision retry

A new real-model revision experiment passed its complete technical linkage criterion in **92.87 seconds**. `gpt-6-luna` authored **v1 → v2** on the same program ID with exact parent 1 and distinct source hashes. Two native roots succeeded; the actual version comparison retained **one sample per version**, and the model's decision linked the exact revision and evidence correctly. The report had no remaining acceptance deficits. No source body or predicate was injected, no synthetic Agent supplied the decision and no historical source was edited.

Usage was **16 host admissions / 16 reported usage messages**, **115,769 uncached input**, **269,056 cache-read**, **0 cache-write** and **2,132 output tokens**, with null known cost. All resources were cleared. The observer stopped this custom technical run without verifier goal completion; there were **zero experience promotions**. This proves actual authored-version/execution/comparison/decision linkage, not better ordinary Survival, general improvement or causal speedup. The earlier failed-link run remains failed and separate. The new host-pinned planning repeat was still running, with no success inferred.

The parent subsequently inspected the actual comparison UI for that successful revision: exact v1/v2 hashes, one real sample per version, source/card differences and descriptive qualification were visible at 1440×900 and 1000×650 without global overflow or missing usage rows. The live 1280×720 stream stayed around 30 FPS on the same session with the run stopped and zero model calls. An initial offscreen Start-world click had not invoked the control and caused a probe wait timeout; scrolling the helper target into view corrected the probe without an application change.

Normal GNOME window-manager close then produced supervised exit code 0; a post-exit check found both the game and API ports refusing connections. This is one observed normal-close case, distinct from the earlier diagnostic X11 window destruction, not a universal shutdown guarantee.

### Host-pinned planning repeat: repaired and staged, predicate correctly false

The next controlled real-model run still failed complete activation/follow-up acceptance, but proved additional parts of the path. One plan was selected from the first root, with root API work overlapping inference. The first predicate copied a long task string with an unescaped apostrophe and failed parsing; the model explicitly repaired it on the **same plan within the remaining budget**. The candidate was then **staged** and **fresh validation started**.

The repaired predicate compared observed session identity with `context.task.session_id`, but `context.task` is a string. The precondition correctly evaluated false; no activation or follow-up occurred. The run ultimately failed after three no-runnable-work turns while the game remained healthy at health 20. This is not a runtime safety failure, and staging/fresh-validation evidence must not be described as absent merely because overall acceptance failed.

Usage reported **21 requests / 21 messages**, **108,125 uncached input**, **246,016 cache-read** and **2,434 output tokens**, with null known cost. Subsequent work was limited to clarifying typed field help and simplifying an overspecified private task; no DTO change, automatic predicate repair or weakened guard was proposed. Any further actual model/provider attempt remains a separate cohort, not a claimed pass for this run or evidence of improved ordinary gameplay.

After resumption, parent typecheck and targeted tests passed **38 tests, 0 failures and 286 assertions across two files in 4.85 seconds** (**5.48 seconds** including typecheck). The field help matched the actual task-string context and did not advertise a nonexistent dependencies field. The earlier 177-test result remains the latest full-suite pass; this targeted run is not a new all-suite pass. A new bounded Luna planning attempt was running with no result. Additional models were discovered in the real catalogue, but no stronger-model inference was performed; acceptance, bounds and model-authored source remained unchanged.

That single Luna attempt subsequently failed overall, reporting **24 requests / 24 messages**, **98,393 uncached input**, **297,728 cache-read** and **1,961 output tokens**, with null known cost. One first-root forecast achieved actual overlap and staging. Its model-selected 20-second allowance after a five-second delay left only **0.86 seconds** between root closure and the deadline; expiry was correctly enforced. The model twice used an all-zero plan ID and supplied the real ID only after expiry, so no fresh validation or activation occurred. Its predicate also referenced fields absent from the predecessor DTO, but it was never evaluated; that is not an established failure cause.

No engine patch or budget relaxation followed. The user authorized one separate GPT-6.1 Sol control under the same scenario, 30-request/five-minute bounds and no automatic rerun; it was running without a result. Parent typecheck/full Bun regressions were also running without rebuilding unchanged Java/UI artifacts. Neither pending operation supplies a new pass.

The final post-resumption typecheck and Bun regression run then passed **177 tests, 0 failures and 1,355 assertions across 20 files in 44.21 seconds** (**44.86 seconds** including typecheck). No Java or UI rebuild ran: their unchanged artifacts retain the separate earlier native/build evidence, alongside this resumption's actual comparison/normal-close checks. These are old-interface cohort results; the later Sol control is scoped above, and neither establishes verification of the named-program cutover.

### Historical spike model and movement result

The integration session exercised real OMP OAuth/account discovery and **16 provider-reported inference calls** with `gpt-6-luna` in a new ordinary Survival world. The model authored, validated, and activated two local-JS policies. The first produced no confirmed effects and was retired. The second, “Search toward observed oak canopy,” produced an attributed action with approximately **7.28 blocks of observed movement and a camera change**. Action/policy attribution was retained in the event ledger.

The inventory remained empty and the model reported the task incomplete. This is evidence of inference and a model-authored policy effect, **not wood collection, useful survival-task completion, a measured speedup, or a passed playable MVP**. Other discovered models remain selectable; their appearance is not evidence of a verified gameplay run.

Separately, exercised sandbox scenarios established the actual **128 MiB / 0.5 CPU / 32 PID**, no-network, unprivileged, read-only, all-capabilities-dropped profile; termination/reaping of infinite JavaScript; private JSON state persistence; rejection of an invalid shell-like proposal; and host-loss cleanup by the detached guardian. These are infrastructure results, not policy effectiveness or full release-security coverage.

Controlled vanilla-server fixtures also passed behind-camera observation, concealed-ore exclusion followed by an actual dig and independently observed reveal, occluded-entity last-seen memory, coarse delivered sound, and rejection of an unknown navigation target before private geometry access. A long-dig defect was corrected: unrelated distant chunk arrivals no longer revoke the unchanged admitted visibility proof; relevant chunk and ray changes still do.

The full navigation comparison did **not** pass. After partial movement, one replan reached the declared 5 ms guard at approximately 5.42 ms. The action reported failure rather than arrival, and the second material-substitution variant was not reached. This is a measured bounded-planner limitation, not a completed detour/substitution proof; the budget and acceptance criteria were not relaxed.

These navigation findings belong to the retired adapter and cannot certify native behavior. Later sections record scoped native primitive/desktop evidence and the first actual wood result. Native full observation/navigation conformance and program-primary/inference-overlap proof remain incomplete. Full recovery/soak, cold/warm and policy-capability comparisons, real Jev/code-only gameplay, both auth categories, two-provider task success and the full-game objective remain release obligations.

### Later user run, separately retained

A later user run confirmed a real log removal before another dig's preemption caused an unknown outcome and safety pause. A subsequent active-run snapshot corresponded to an actual Creeper death during digging, not evidence that the pre-FINISH correction had regressed. These are different runs/times from the initial 16-call movement-only run; neither upgrades that earlier empty-inventory result.

### New Docker program infrastructure

The actual Docker infrastructure smoke passed in **5.9 seconds**, exercising the restricted profile, a **1,200 ms host capability wait**, nested execution containers, cancellation without late capability calls and externally terminated infinite CPU work. This establishes that infrastructure path, not native rendering, useful gameplay, policy efficacy, token savings or release acceptance.

A separate parent-run Store/SkillManager/Docker program-tree smoke passed in **3.23 seconds**. It exercised a blocked child and a safely failed leaf handled by the authored parent, two successful root executions across two runs, explicit scoped import preserving literal dependency IDs/source, four synthetic broker actions, durable start-key identity after retry/reopen and persisted monotonic epochs. This is real container/persistence infrastructure proof using synthetic effects: no provider request, gameplay result or promotion eligibility was established. The temporary probe is not a supported startup command.

### Initial actual native proof

The parent received native report `native-proof-1792612881397` and visually inspected its authentic RGB capture: a real daytime world, player hand and HUD. The isolated licensed client, hidden GLFW window, blocked physical input, movement, cancellation and cleanup were exercised. Initial measured capture cadence was **20.57 FPS**, not the 30 FPS target.

An initial black PNG was an alpha-zero compositing artifact: raw RGB contained the authentic scene. That failed preview was neither successful PNG presentation nor absence of world rendering. Corrected opaque RGB matches the Minecraft presentation without inventing scene content. At this initial stage final cadence, integrated desktop and ordinary-world program proof were pending; the later native report below supersedes only its exercised primitive cases.

### First integrated desktop checks

The parent reported `bun run check` passing and `bun test` with **65 passed, 0 failed, 438 assertions across 11 files in 6.4 seconds**. These were the first assembled checks, not final verification of subsequent corrections.

An actual isolated Electron launch established owned-nonce readiness on a dynamic port. At 1000×650, gameplay occupied exactly 75% of the main area without global overflow; nested-dialog Escape/focus restoration and real CPU/event-loop diagnostics were exercised. HTTP probes returned 200 for authorized diagnostics, 401 for unauthorized access, and 403 for rejected CSRF/Host/Origin cases. Plain HTTP video access returned 426; a message sent to the read-only video WebSocket closed it with code 1008. This app probe started no new game or model request.

Graceful Electron SIGTERM subsequently exited with code 0 and closed its owned backend port. That observed shell/backend shutdown did not exercise an active game, model request or unknown-effect cleanup.

The minimum viewport initially left usage below the fold. A source correction had not yet received the coordinated rebuild/recheck at this reporting point. A pre-privacy native repeat measured 30.004 FPS, followed by review findings in observation/navigation/sound/occlusion/entity identity/attack attribution and unknown timeouts. That repeat is history, not the final artifact's cadence. Neither initial desktop checks nor capture cadence establish I01 or useful gameplay.

### Accepted post-review native primitive proof

The parent accepted report `native-proof-1792614304803` for the post-correction artifact with SHA-256 `02e5c8bd6a856d5ecda019f95021f30838d8fadb03823c3bbf3b5c3f225bb23a`. Its native build succeeded in nine seconds. A pure Java boundary proof passed sound-whitelist/grouping/expiry, conservative voxel-occlusion, damage-attribution and emitted-deadline predicates; this was not a live Minecraft security fixture. Source review marked all six findings resolved, with no partial/unresolved findings; source review is not full I01 conformance.

The actual licensed client joined its isolated world and captured authentic terrain, HUD and hand while its GLFW window remained hidden/unmapped. It delivered **361 frames in 12.147 seconds: 29.719 FPS at 1280×720**. Same-host capture-to-**backend** wall latency was **p50 4 ms, p95 22 ms, maximum 244 ms**; these values are not renderer draw latency.

Six yaw/position samples showed gradual turning and movement. Cancellation was acknowledged and settled position stayed stable. Targeted physical-input probes showed GLFW key state true while game polling stayed false, with blocked keyboard/mouse counters reaching eight/three. An unauthenticated same-name login was challenged and closed while the owned player remained connected. Owned client and server exits were confirmed.

This accepted result covers native primitives and the named pure predicates. It does not establish full observation/navigation conformance, live attack/invulnerability behavior, dig/place/craft/equip task effects, active integrated-desktop shutdown or ordinary-world model-authored program inventory gain. The playable/release gates remain unpassed.

### Integrated native-video failure and observed correction

Connecting the actual native stream to the desktop did not yet establish accepted live desktop presentation. The renderer first stayed invalid/stale after a Mojang frame. A stale-versus-malformed classification defect was corrected in source, but an open-socket stall remained under diagnosis: an independent Chrome probe received three or four valid frames before stalling without socket closure.

A separate Bun full-frame relay probe passed 15 frames. During a reported backend interval, forwarded counts matched all 15,173 native frames; sampled CPU was 20.46% of one core, forwarding p95 0.00472 ms and event-loop lag p99 1.16 ms. These scoped diagnostics neither resolve the browser stall nor justify a speculative language rewrite. The game/server were stopped cleanly before a controlled restart; no new model requests were made. Native capture proof must not be presented as successful integrated-desktop viewing.

The parent subsequently changed only relay scheduling: coalesced delivery now runs outside the native callback through `setImmediate`, rechecking viewer membership/open state. The earlier stall had four sends, roughly 3 MB pending and zero kernel queues. After the change, a 72-second observation reported 2,149 published frames, 1,429 latest-frame sends, zero buffered bytes and latest sequence 2,149. Published and sent counts differ because this transport keeps latest frames rather than promising lossless video.

An independent raw-TCP reproduction established the backend defect without CDP: inline drain stalled after one complete frame over eight seconds with about 1.38 MB pending. The production deferred path delivered 19 complete frames through sequence 67 in 2.24 seconds and ended with zero buffered bytes. A permanent real-network regression test was added; its later suite result must be reported separately from this exercised reproduction.

An independent OS capture then showed the actual GameHarness window streaming authentic world/HUD/hand at a displayed **30 drawn FPS**, with a displayed **7 ms capture-to-draw sample** and **47 ms latest-frame age**. These are observed same-host display samples, not latency percentiles or guarantees. Full-RGBA CDP traffic overloaded the operator's browser helper, so this visual proof used OS window capture; that helper limitation is not asserted as the relay's root cause.

No model request was made during this correction. The idle avatar naturally died during debugging; that death is retained, not recast as an OAuth failure or useful gameplay. Native death-lifecycle handling remained under correction at this reporting point. No wood acquisition or inventory gain is established.

The subsequent lifecycle artifact built in eight seconds with SHA-256 `9b6abf1a0a04a938a89f09db61d38d8fb7c215004a637665c286ff941a514aaa`. The earlier `02e5…` primitive report does not cover this new death path. Coordinated same-world explicit reconnect/ordinary respawn and causal-error preservation were still awaiting actual results; no automatic model resume or successful recovery is claimed.

### First actual wood result before direct-action cutover

A real `gpt-6-luna` run completed its declared wood goal in **65.66 seconds**, with server-verified `spruce_log` inventory **0→1**. It made **30 model calls**, reporting **70,793 uncached input**, **210,688 cache-read**, **0 cache-write** and **2,031 output tokens**; cost remained unknown.

The model authored a 25-line async function body, but its program executed only one dig over **4.51 seconds**, with no strategic request overlapping that interval. Four other actions retained `origin:"strategist"`. This is actual native inventory gain, **not** passed program-primary or real inference-overlap acceptance. It does not establish token savings, promotion eligibility or the full playable gate.

The exposed direct-action tools had enabled micromanagement. They were subsequently removed from the strategic catalogue, prompt and capabilities without aliases: new effects must come from a model-authored program's Game API or reaction, with an explicit owner. Historical strategist actions remain unchanged. A new ordinary-world proof after that cutover is required; the earlier result cannot be relabeled to pass it.

An actual promotion attempt for that first root returned **409**, “Evidence must come from this bounded execution interval”: goal event 823 followed the root's end. It was correctly not promoted. Before the API cutover restart, server/client closure returned 200 and the completed run retained 30 calls.

At that stage, the next scoped proof used a new ordinary world at day zero/20 HP, preserving all earlier worlds, reports, the first verified goal, its primary-program failure and idle death. The changed world/seed and API were new conditions, not a hidden rollback or a controlled percentage/token comparison.

### Accepted isolated death and explicit-resume fixture

The parent accepted the lifecycle fixture for the unchanged `9b6abf1a…` artifact. An actual licensed player entered the private fixture world at authoritative health 20/epoch 1. The evaluator alone killed it while a mechanical move was pending. The native death notice preserved the first cause, “player died”; the interrupted action separately remained `unknown` with reconnect required. The owned client exited **234 ms** after the kill.

A **1,500 ms** observation found no automatic respawn/client restart or new frames. An explicit new connection to the **same fixture world** advanced epoch to 2, rotated session authority and reached authoritative health 20 in **9,196 ms** through ordinary rejoin/respawn. Both clients and the fixture server closed with confirmed cleanup. This fixture made **zero model calls and zero promotions**.

This is privileged lifecycle evidence, not ordinary-task efficacy or I01. Exact respawn packet count was **unmeasured**; an at-most-one startup gate was covered by pure predicates, not a measured one-packet claim. At this stage typecheck and **71 tests / 495 assertions / 13 files** passed after the strategic-API cutover; the subsequent ordinary-world result is recorded separately below.

### Accepted clean-API program-primary wood proof

The second real `gpt-6-luna` run used the `9b6…` native cohort in a new ordinary world at health 20 with empty inventory. It reached trusted `oak_log` inventory **0→3** in **116.46 seconds**. All **14 admitted game actions had skill origin**, with no strategist actions. The model authored three async function bodies of **48, 71 and 74 canonical nonblank lines**, exercised through five executions.

One five-action series ran for **12.15 seconds** and one eight-action series for **14.89 seconds**, without intermediate strategic requests. Failed/blocked outcomes were retained; trusted goal completion cancelled the final root rather than converting its cancellation into program success. This passes the scoped primary-program gameplay proof, not the complete playable gate.

Actual usage was **31 provider requests**, **72,135 uncached input**, **230,528 cache-read**, **0 cache-write** and **4,942 output tokens**, with unknown cost. The model received three authoring rejections—93 lines exceeded 80, and complexity 13 exceeded 12 twice—and revised source without relaxed limits. Some authored inventory counting used the wrong `.item` field, so this is not bug-free or demonstrated-efficient programming.

The world/API differ from the first run; no controlled token/latency/cost improvement follows. No real strategic inference overlapped those pending program intervals: absence of intermediate requests demonstrates autonomous execution, not inference-overlap acceptance. This run does not prove cold/warm benefit, real policy/Jev use, I01 or release readiness. Positive promotion and exact warm reuse were still being prepared.

The parent also inspected actual desktop OS captures at 1440×900 and 1000×650: gameplay retained 75% of the main area and all usage counters were visible. This supersedes the earlier below-fold usage result for those inspected sizes, not untested display sizes or other lifecycle coverage.

Earlier schema/UI verification passed typecheck, **71 tests / 495 assertions / 13 files in 9.45 seconds**, and the combined native Gradle/Vite build in **16.18 seconds**. The newer receipt-cohort checks below supersede those timings, not the separate gameplay evidence.

A later promotion attempt was also rejected: a root that navigated to collect logs dug by a prior root lacked same-root useful-effect attribution. The gate was not weakened. The accepted task result remains distinct from eligible reusable-program evidence; positive promotion/exact warm proof was still pending.

### Ordered movement-receipt cohort

The movement-receipt cohort used native artifact SHA-256 `a119f9c18e9574b23cc5e9b6c0c3393b58c5d2e6bc58c3ebc9303f141bb17a3b`. In that cohort, movement released controls at its duration and then requested one ordered own-server inventory receipt. Only that real receipt set the confirmation flag; a missing receipt at the three-second deadline yielded unknown/reconnect and closed the emitter. This historical teardown behavior does not replace the current healthy-session reconciliation contract.

The parent accepted the isolated primitive report for this cohort: **365 frames / 12.205 s = 29.906 FPS at 1280×720**; same-host capture→backend **p50 5 ms / p95 8 ms / maximum 135 ms**, not draw latency. Six yaw samples showed gradual movement/turning; actual server before/after inventory confirmed the receipt flag; cancellation settled position stayed stable. Hidden-window/input-blocking, same-name rejection preserving the owned session and cleanup passed again. A compiler warning about an external GLFW mapping remained; actual hidden rendering was exercised, not a warning-free build.

In a separate zero-inference receipt-loss fixture, the evaluator paused only its own server after movement began. The action became `unknown` **3,597.6 ms after the pause**, required reconnect and had no confirmed-receipt flag; server resume and final cleanup succeeded. This elapsed interval is not the configured receipt deadline's start-to-end measurement. An earlier receipt-loss attempt failed because its fixture accessed the wrong PID; its normal probes passed, but that failed attempt does not count as receipt-loss proof.

Receipt-cohort verification passed typecheck, **71 tests / 495 assertions / 13 files in 9.40 s**, and native/UI build in **18.29 s**. Later teardown checks below supersede suite counts; neither set establishes I01, ordinary progression or promotion.

### Third ordinary result before movement-receipt correction

A third actual model run, before the movement-receipt fix, increased own oak logs **3→4** in **38.20 s**, with **13 requests**, **39,427 uncached input**, **106,496 cache-read**, **0 cache-write**, **1,995 output tokens** and unknown cost. It authored 56- and 63-line bodies using the correct inventory `name` field; a 91-line candidate was rejected without relaxing the limit.

Its two skill actions split digging and later movement/pickup across different roots. The old movement result lacked the new receipt flag, so this was not eligible same-root useful-program promotion. Different initial inventory/world history/API conditions prevent controlled cold/warm or savings claims. A fourth model-authored root on the new cohort was still running; no positive promotion result had yet been supplied.

### Accepted coherent-root result and useful promotion

The fourth actual model run used the `a119…` cohort and increased oak logs **4→5** in **23.29 s**. It made **7 requests**, reporting **29,116 uncached input**, **42,112 cache-read**, **0 cache-write**, **734 output tokens** and unknown cost. One **59-line** model-authored program executed one root for **8.872 s**, with two confirmed skill-owned dig actions, five capability calls and no strategic request inside that interval. There were no authoring rejections, and the source used inventory `name` correctly.

Trusted goal event 1372 closed the root as cancelled; it was not self-reported program completion. Unlike earlier cross-root pickup cases, the same bounded root's two dig actions supported its useful result. This is scoped coherent program execution, not an inference-overlap or comparative-efficiency result.

An actual promotion request returned **201** and created snapshot `b63d39b029f95dcec4c51f3dac3e352d5843a0ad059ba16d4493c97baee11bcf`, pinning exact program/source hash `704e4c1b7b5f44776c86e91706588d29ed15950c7c2a7d51154e9387d330e505`. Its declaration was portable with `retained_world_data:false`; source review found no retained coordinates, target IDs or world state, using fresh dynamic observations instead. Trusted goal 1372 and same-root action evidence qualified it without weakening the gate, and it appeared in the real model-scoped library.

This one eligible use is limited evidence, not demonstrated generalization. Exact cross-session warm reuse was the next unproved step. Different starting inventories/world histories and API cohorts forbid controlled savings comparisons with earlier runs; no full playable, policy/Jev, I01 or release pass follows.

### Exact warm attempt with blocked prerequisite and death

The subsequent warm run imported the qualified program's exact identity/version and source hash `704e4c1b7b5f44776c86e91706588d29ed15950c7c2a7d51154e9387d330e505`, then actually executed it. That inherited root returned `blocked` with **zero actions** because no log satisfied its observable precondition. This establishes exact qualified hydration and an attempted invocation, not useful reuse or a completed warm task.

The model then authored a new “Find nearby tree and acquire wood” program. It admitted **10 skill actions** before the player died; the root retained `unknown` and the original death cause. The engine fenced the client without automatic restart, but teardown failed: `pausing` at 22:48:05 was followed by a Stop probe returning **409** at 22:57:23, with stopping/shutdown unconfirmed. This was not a brief transition or merely an observer issue.

The run reported **13 calls**, **34,029 uncached input**, **100,992 cache-read** and **999 output tokens**. No unsupported cache-write/cost figure is inferred. Diagnosed defects conflated unknown past effects with a live emitter, treated retained death diagnostics as disconnect failure and missed worker drain on cancellation failure. This historical failure preceded the corrected-runtime fixture below. Its unfavorable gameplay/unknown ledger are not relabeled; no warm-goal success, generalization, savings or controlled benefit follows. The model received no human tactical correction.

### Verified full-runtime death teardown correction

The parent exercised the corrected full Runtime, real Fabric client/server, Docker, Store, SkillManager and arbiter with a diagnostic Agent—not a real provider or model-authored gameplay proof. In the `a119…` cohort, evaluator-only death followed an actual native motor tick during a pending two-second movement.

The runtime reached **paused in 375 ms**, only after owned-client closure and **zero remaining workers**. The first death cause and `game.error` remained available; action/root stayed `unknown` with reconnect required. Confirmed neutralization described emitter closure, **not rollback or knowledge of past effects**. A **1,500 ms** hold had zero frames, automatic reconnects and model-call events. Explicit Stop then reached stopped while retaining the cause and unknown history. Native/server cleanup and zero workers were confirmed, with no rejected cleanup result.

This scoped fixture passed and verifies the closure-barrier correction without erasing the earlier long pausing failure. The parent reported typecheck, **73 tests / 514 assertions / 14 files in 9.75 s**, and native/UI build PASS. The old app's actual global close drained its backend/server without administrative force-kill. The independent lifecycle proof below subsequently exercised supervisor loss and expected disconnect; neither result establishes new ordinary gameplay, warm success or release acceptance.

### Accepted desktop restart, normal stop and owner-loss proof

An actual application restart preserved the stopped run and original death cause, with server stopped/client disconnected and **no automatic game or model start**. The qualified exact program snapshot remained listed across that real process restart. An explicit game start rejoined the saved-dead world through ordinary respawn at health 20/epoch 14.

Explicit game stop completed in **1,695 ms**, leaving client disconnected, `game.error:null`, video idle with no error and server stopped. This verifies that expected EOF is not reported as a false disconnect fault. Another explicit start reached health 20/epoch 15 with the server running.

The owner-loss proof used an independently surviving Python service leader and Linux pidfd identity checks, not a cleanup side effect or stale TCP observer. Killing the actual Electron main process produced observed exits at **9 ms** for Electron, **145 ms** for the native client, **1,386 ms** for the managed server and **1,414 ms** for the backend. The server exited before backend completion, establishing awaited owned-process drain in this case. The independent service leader remained alive before and after the kill.

This proof made **zero real provider calls**, and all application processes were closed afterward. An earlier TCP observer had hung and was not valid evidence of a 45-second application failure or pass; the pidfd repetition supplies the definitive exit observations. Exact snapshot persistence is not successful warm gameplay, and these lifecycle results do not establish Jev, full I01, controlled savings or release readiness.
