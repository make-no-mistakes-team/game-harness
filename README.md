# GameHarness

GameHarness runs a local Minecraft Java Survival player with optional
asynchronous strategy from an authenticated model provider. The Fabric mod owns
movement, mining, crafting, combat, descent, and portal building while the
configured model advises on macro direction.

## Prerequisites

- Linux x64, Bun **1.3.14+**, Node.js **24+**, and **JDK 21** (`JAVA_HOME`)
- Xvfb, `xauth`, Python 3 with `python3-dbus`, and **FFmpeg 6.1+** (`x11grab`,
  `libx264`, `ffprobe`)
- A legitimate Minecraft Java Edition account with **1.21.4** installed via the
  official Launcher and explicit EULA consent

Follow the [setup guide](docs/setup.md) before the first build.

## Install and launch

```sh
# Keep credentials, worlds, and private run evidence out of git in this checkout.
printf '\n/local/\n' >> .git/info/exclude
bun install --frozen-lockfile
bun run build:agent
```

Launch a fresh Survival run from the terminal:

```sh
bun run play:agent --strategy model --model PROVIDER/MODEL --macro-requests 160 diamond 7200
```

Replace `PROVIDER/MODEL` with an authenticated catalog model, or omit
`--strategy model` and `--model` for model-free play. Watch the live private
display in another terminal with `bun run watch:agent`.

For the minimal desktop launcher and live viewer (account login, EULA consent,
start/stop, and video stream), run `bun run start`. If Electron reports a
sandbox-helper error, fix `chrome-sandbox` permissions per the
[setup guide](docs/setup.md#local-failures-and-private-data); never disable the
Chromium sandbox.

## Documentation

Start at the [documentation index](docs/index.md). Read the
[behavior contract](docs/survival/behavior.md) before gameplay changes,
[playing Survival](docs/survival/play.md) for operation and stopping, and the
[architecture reference](docs/reference/architecture.md) for runtime ownership.
