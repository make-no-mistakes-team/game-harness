# Integration spike

This spike establishes real connections between the local UI, OMP-backed OpenAI inference, a Minecraft Java player, and a live human viewer. Model-authored JavaScript policies can propose actions through the trusted runtime. It is an integration result, not a completed survival task or the [first complete playable MVP](implementation-mvp.md).

The MVP contract's I03–I06 requirements remain mandatory for the next stage. In particular, the spike does not implement the full durable `skill.start`/`skill.get` execution contract. The [runtime contracts](runtime-contracts.md) remain the authority for those interfaces; the routes below describe only the current application.

## Install and start

The current reference host is Linux x64 with:

- Bun 1.3.14 or newer and Node.js 24 or newer on `PATH`. Bun runs the backend; the trusted Mineflayer bridge runs under Node.
- `flock` and a running local Docker Engine. The application user must be able to use `/usr/bin/docker` without an interactive `sudo` prompt. The policy supervisor uses the local daemon with a restricted environment, not a custom remote Docker context.
- Network access for package installation, pinned image/server acquisition, and OpenAI authorization/inference; an account with the required Codex entitlement.
- A browser capable of the viewer's WebGL rendering. A desktop Minecraft installation is not needed to run the bot.

Before the first launch, add `/local/` to this checkout's `.git/info/exclude`. This is a local exclusion, deliberately not a change to the shared `.gitignore`:

```sh
printf '\n/local/\n' >> .git/info/exclude
bun install --frozen-lockfile
docker pull node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
bun run build
bun run start
```

The exact policy image is pinned in [`src/server/sandbox.ts`](../src/server/sandbox.ts). Sandbox preparation uses `--pull=never`: a missing image makes policy isolation unavailable. **Prepare server** can retry sandbox preparation after you install the image, but does not download that image for you. There is no unsandboxed fallback.

Open **http://127.0.0.1:4317**. The UI redirects `localhost` to `127.0.0.1` before session-cookie bootstrap so the operator and viewer use a consistent host; the redirect and subsequent API access have been exercised in a real browser. Startup holds a nonblocking `flock` on the data directory; a second owner of that directory is rejected.

`bun run dev` builds the bridge, starts the watched backend, and runs Vite at **http://127.0.0.1:5173**, proxying `/v1` to the backend. Port selection is strict: Vite does not silently choose another port if 5173 is busy. Its filesystem access is restricted to `web`, `src/shared`, and `node_modules`, with explicit denials for environment files, certificates, `.git`, `local`, `.impeccable`, and `PRODUCT.md`. A private-canary probe originally exposed a development-filesystem leak; after the restriction, that canary returned **403** while browser-source and authenticated API-proxy requests returned **200**. This is a targeted regression result, not complete development-server security coverage. Production startup requires the preceding build and runs from the checkout, with its dependencies and sandbox files present.

### OpenAI authorization and proxies

In **Setup → OpenAI connection**, choose **Connect in browser**. Open the displayed provider link on the backend machine and finish authorization. The state-checked callback uses **localhost:1455**; keep that port available. Alternatively, choose **Use device code** and follow the provider instructions shown in the trusted UI. Supply input only when that flow requests it. Device-flow availability depends on the account/provider; its presence is not a claim that a separate device login was verified.

Wait for account model discovery to finish, then select a model from that result. **Refresh models** updates availability. An entitled account is required; an authorization/discovery failure is shown rather than replaced with an ambient API key. The current implemented connection is `openai-codex` OAuth through OMP 18.12.3. API-key connections, additional providers, and Jev gameplay remain separate work.

If your network needs a proxy, configure it in the environment that launches `bun run start` or `bun run dev`. The trusted OAuth helper receives the allowlisted `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` variables, their lowercase equivalents, and `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, and `SSL_CERT_DIR`. Keep loopback traffic direct by including `localhost,127.0.0.1,::1` in `NO_PROXY` and its lowercase equivalent when used. Proxy credentials and custom certificates belong in private operator configuration, never in tracked files, screenshots, or shared logs.

OAuth authorization and real Codex model discovery have succeeded with the trusted helper's proxy environment configured; this does not establish separate successful verification of both login modes. No existing OMP/Codex home credentials are imported. The app stores only credentials obtained through its own authorization flow; generated policies never receive them.

### Start the game and a run

1. In **Setup → Minecraft**, read and accept the [Minecraft EULA](https://www.minecraft.net/en-us/eula), then click **Prepare server**. This records consent, downloads the hash-pinned Minecraft Java **1.21.4** server JAR, and pulls the pinned **Eclipse Temurin Java 21 JRE** image if missing. You do not need host Java.
2. Click **Start world**. This starts the real vanilla server and connects the `GameHarness` player and viewer. Wait for connected state and actual rendered terrain, not just a loaded page.
3. In **Task and model**, select a discovered strategic model and a goal. Use its prompt or enter your task, click **Create run**, then **Start**. Creation alone does not submit the first strategic request.
4. Inspect activity, actual inventory, run/action evidence, and policy source/cards. Bootstrap is bounded; the runtime enters ordinary execution without another human prompt. Policy authoring remains available during play, but a policy's registration or validation alone is not a useful effect.
5. Use **Pause**, **Resume**, or **Stop run** as appropriate. **Stop world** also stops the server. Stop the run and world before selecting **Create new world**. That operation selects a new ordinary world while preserving previous world directories and recorded runs.

The managed server is Normal Survival with ordinary world generation, no agent operator privileges, and an empty seed setting. Its loopback mapping defaults to **127.0.0.1:25565**. It uses `online-mode=false` for this local bot deployment, with RCON/query disabled. Do not expose it to a network or treat it as an authenticated public server. A human desktop client is optional and is not the bot's control path.

## Local data and configuration

The default root is `local/runtime/`. Keep the whole tree private:

| Location relative to the data root | Contents |
| --- | --- |
| `auth/gameharness.sqlite` and SQLite sidecars | App-owned OAuth credentials. The auth directory is restricted to mode `0700`; credential files to `0600`. |
| `runs.sqlite` and sidecars | Run, action, event, and policy metadata. |
| `artifacts/` | Immutable generated policy source. |
| `minecraft/` | Downloaded server JAR, current-world record, world directories, and server logs. Saves and logs can contain privileged world information. |
| `provisioning-consent.json` | Local Minecraft EULA consent record. |
| `app.lock` | Single-owner startup lock. |

Configuration is read from the launching process:

| Variable | Default | Purpose |
| --- | --- | --- |
| `GAMEHARNESS_DATA_DIR` | `local/runtime` under the checkout | Trusted persistent storage root. Prefer an absolute path when overriding. |
| `GAMEHARNESS_PORT` | `4317` | Loopback operator backend port. |
| `GAMEHARNESS_MINECRAFT_PORT` | `25565` | Loopback host port mapped to the managed server. |

If you choose another in-repository data directory, exclude it locally before launch too. An exclusion does not untrack files already committed, secure a backup, or redact an export. Never publish auth databases, device codes, login URLs, tokens, raw server logs, worlds, or privileged evaluator records. Do not move an open SQLite database by copying only its main file; WAL sidecars may hold live data.

## Inspecting source and live evidence

The current source API is the authenticated run snapshot, rather than a general filesystem endpoint:

- `GET /v1/state` returns the current app snapshot; policy source is at `run.policies[].source`.
- `GET /v1/runs/{run_id}` returns a retained run and its policies, including each immutable `source`, `hash`, `version`, and StrategyCard.
- `GET /v1/events` is the authenticated activity SSE stream.

Open the application first to establish the local session through `GET /v1/session`. Browser mutations require that session and its CSRF token; the UI handles these. Reads do not grant filesystem, execution, or activation authority. The **Policies** panel displays source using text content, so HTML/script-like source remains inert. A source file or successful validation does not prove invocation or a game effect.

The viewer is read-only for the human operator, on a separate dynamically allocated loopback origin. HTTP and Socket.IO access require the private viewer cookie and permitted Host/Origin. Its stream does not forward mouse/control messages into the game. The model and policy workers have no HTTP/viewer capability, and the renderer's backing chunks are not agent observations.

Pinned renderer patches cover modern world height, section indexing, and negative-Y meshing; incompatible bundle seams fail closed. Main-app and viewer-document scripts remain restricted to their own origin. Only the pinned trusted `worker.js` response permits `unsafe-eval` for its AJV/NBT dependencies. Terrain rendering was exercised in independent Chrome without disabling CSP. An OMP-managed browser had a blob-worker/CSP conflict; that environment-specific failure must not be reported as a successful viewer check.

## Stop, disconnect, and uncertainty

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

The integration session exercised real OMP OAuth/account discovery and **16 provider-reported inference calls** with `gpt-6-luna` in a new ordinary Survival world. The model authored, validated, and activated two local-JS policies. The first produced no confirmed effects and was retired. The second, “Search toward observed oak canopy,” produced an attributed action with approximately **7.28 blocks of observed movement and a camera change**. Action/policy attribution was retained in the event ledger.

The inventory remained empty and the model reported the task incomplete. This is evidence of inference and a model-authored policy effect, **not wood collection, useful survival-task completion, a measured speedup, or a passed playable MVP**. Other discovered models remain selectable; their appearance is not evidence of a verified gameplay run.

Separately, exercised sandbox scenarios established the actual **128 MiB / 0.5 CPU / 32 PID**, no-network, unprivileged, read-only, all-capabilities-dropped profile; termination/reaping of infinite JavaScript; private JSON state persistence; rejection of an invalid shell-like proposal; and host-loss cleanup by the detached guardian. These are infrastructure results, not policy effectiveness or full release-security coverage.

Controlled vanilla-server fixtures also passed behind-camera observation, concealed-ore exclusion followed by an actual dig and independently observed reveal, occluded-entity last-seen memory, coarse delivered sound, and rejection of an unknown navigation target before private geometry access. A long-dig defect was corrected: unrelated distant chunk arrivals no longer revoke the unchanged admitted visibility proof; relevant chunk and ray changes still do.

The full navigation comparison did **not** pass. After partial movement, one replan reached the declared 5 ms guard at approximately 5.42 ms. The action reported failure rather than arrival, and the second material-substitution variant was not reached. This is a measured bounded-planner limitation, not a completed detour/substitution proof; the budget and acceptance criteria were not relaxed.

The current navigation executor uses conservative bounded geometry, not an unrestricted stock pathfinder. Full observation/navigation conformance, complete composite-control/strategic-request integration, confirmed useful task results, recovery coverage, and durable skill admission still need their required retained evidence. Complete durable skills, autonomous improvement, warm memory, Jev, and release recovery/soak coverage are not delivered by this spike. The [MVP contract](implementation-mvp.md) and [release PRD](prds/gameharness-v1.0-prd.md) retain their original requirements, including the eventual full Minecraft objective.
