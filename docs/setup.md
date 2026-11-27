# Install and launch

GameHarness runs a local Fabric 1.21.4 Survival player with optional
asynchronous advice from a configured model provider, launched either from the
CLI or through a minimal desktop launcher and viewer.

## Prerequisites

The supported host is Linux x64. Install:

- Bun **1.3.14+**, Node.js **24+**, and a **Java 21 JDK**. Export `JAVA_HOME`
  pointing to that JDK and put its `bin` directory first on `PATH`.
- `Xvfb`, `xauth`, and **FFmpeg 6.1+** with `x11grab`, `libx264`, and `ffprobe`.
  Each Survival run creates its own private display; never target a personal
  desktop display.
- `/usr/bin/python3` with `python3-dbus` for Linux Secret Service lookups of
  the official Minecraft Launcher session.
- A working graphical session and the official Minecraft Launcher signed in to
  an entitled Java Edition account with **Minecraft 1.21.4** installed.
  GameHarness reads those client assets without importing personal worlds or
  settings.

Ubuntu packages:

```sh
sudo apt-get update
sudo apt-get install --yes ffmpeg xvfb xauth python3-dbus
```

Fedora packages:

```sh
sudo dnf install nodejs24 python3 python3-dbus curl unzip \
  gtk3 nss alsa-lib libXScrnSaver xorg-x11-server-Xvfb xorg-x11-xauth
```

Select Java 21 even when the system defaults to a newer JDK. Official releases
are available from
[Bun](https://github.com/oven-sh/bun/releases/tag/bun-v1.3.14) and
[Eclipse Temurin](https://adoptium.net/temurin/releases/?version=21); verify
checksums before extracting. On Fedora, `ffmpeg-free` lacks `libx264`; install
a full FFmpeg build (for example via
[RPM Fusion](https://rpmfusion.org/Howto/Multimedia)) after reviewing its
repository terms.

When launching the Electron viewer on GNOME Wayland, keep the session's own
`DISPLAY`, `XAUTHORITY`, and `XDG_RUNTIME_DIR` for XWayland.

## Build and prepare Minecraft

Run from the repository root:

```sh
bun --version && node --version && java -version && javac -version
bun install --frozen-lockfile
bun run build:agent
```

Useful build and check scripts:

| Command | Action |
| --- | --- |
| `bun run build:agent` / `bun run build:mod` | Build the Fabric 1.21.4 mod JAR (`mod/gradlew -p mod build`). |
| `bun run check:types` | TypeScript typecheck across `src/`, `scripts/`, `tests/`, and `web/`. |
| `bun run check:unit` | Run the Bun unit test suite. |
| `bun run start` / `bun run dev` | Start the minimal desktop launcher and live viewer. |

Before the first Survival run, accept the
[Minecraft EULA](https://www.minecraft.net/en-us/eula) and download the managed
1.21.4 server through the desktop launcher's server preparation settings. The
CLI requires that existing consent and server artifact; it never consents
silently.

Before starting a client, GameHarness verifies the official Minecraft Launcher
session via `mod/bootstrap/launcher-auth.py`. On GNOME, the helper reads the
unlocked Secret Service entry for the active account without unlocking the
keyring, switching accounts, or printing tokens. A verification timeout is not
a gameplay failure; refresh the official Launcher login if the grant has
expired.

## Connect a model provider

Model-free runs need no provider login. To enable asynchronous model advice,
open the desktop launcher's provider connection settings and complete OAuth
authorization on the backend machine (either browser callback on
`localhost:1455` or device code). Model discovery must finish before selecting
a `PROVIDER/MODEL` identifier.

GameHarness keeps its own credential store and never imports ambient CLI or
third-party credentials. If outbound traffic needs a proxy, export
`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` (or lowercase
equivalents), and optional `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, or
`SSL_CERT_DIR` before launch. Keep `localhost,127.0.0.1,::1` in `NO_PROXY`.

## Local failures and private data

If Electron reports a misconfigured SUID sandbox helper:

```sh
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

Reinstalling dependencies can overwrite that helper. Never pass `--no-sandbox`.
Renderer sandboxing and context isolation stay enabled with Node integration
disabled.

Keep credentials, worlds, raw logs, and recordings private. Private runtime
storage lives under `local/runtime/`, `local/survival-agent/`, and
`local/survival-pilot/` (or Electron `userData/runtime` / `GAMEHARNESS_DATA_DIR`).
Do not copy an open SQLite database without its WAL sidecars. Next, read
[playing Survival](survival/play.md).
