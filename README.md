# GameHarness

GameHarness runs a Minecraft Java Survival player with optional model-directed
strategy. The local player handles ordinary actions while the model considers
the next objective. The repository also retains the separate general harness
for experiments with model-authored game-playing programs.

## Install and launch

Requires Linux x64, Bun **1.3.14+**, Node.js **24+**, **JDK 21**, Python 3 with
`python3-dbus`, `flock`, Docker Engine, and **FFmpeg 6.1+** with `ffprobe` and
`libx264`. Survival runs also require Xvfb/xauth, legitimate Minecraft Java
access, an installed **1.21.4** client and explicit EULA consent.
Complete the [setup guide](docs/setup.md) before building.

```sh
# Exclude credentials, worlds and private run evidence in this checkout.
printf '\n/local/\n' >> .git/info/exclude
bun install --frozen-lockfile
docker pull node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
bun run build
bun run start
```

Select JDK 21 through `JAVA_HOME`. For Electron sandbox errors, use the setup
guide's sandbox-helper instructions; do not disable Chromium's sandbox.

For a prepared checkout, launch ordinary Survival directly:

```sh
bun run play:agent --strategy model --model PROVIDER/MODEL --macro-requests 160 diamond 7200
```

Replace `PROVIDER/MODEL` with an authenticated catalog selection.
Omit `--strategy model` and `--model` for model-free play.
See [playing Survival](docs/survival/play.md) for operation and safety.

## Documentation

Start with the [documentation index](docs/index.md). For gameplay work, read
the [behavior contract](docs/survival/behavior.md); for runtime internals, use the
[architecture reference](docs/reference/architecture.md). Historical results and
research requirements are separate from current operating instructions.
