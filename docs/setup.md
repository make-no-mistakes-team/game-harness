# Install and launch

The ordinary [Survival player](survival/play.md) uses a local Java controller,
with optional asynchronous model advice. The separate experimental
[GameHarness workflow](reference/operations.md) runs model-authored programs.

## Prerequisites

The reference platform is Linux x64. Install:

- Bun 1.3.14+, Node.js 24+, and a Java 21 **development kit**.
  Export `JAVA_HOME` for the selected JDK and put its `bin` first on `PATH`.
- Xvfb, xauth, and FFmpeg with `x11grab`, `libx264`, and `ffprobe`.
  The Survival runner creates a private display; do not launch it against a
  personal desktop display.
- A working graphical session and the official Minecraft Launcher.
  Sign in to an entitled Java Edition account and install Minecraft 1.21.4.
  The owned client reads those client artifacts/assets without importing
  personal worlds or configuration.
- For the desktop and model-authored program system: `flock`, local Docker
  Engine, and `/usr/bin/python3` with `python3-dbus` for Linux Secret Service.
  The application user must access `/usr/bin/docker` without interactive sudo.
  Docker access grants substantial host authority; `podman-docker` is not an
  implemented substitute.

FFmpeg on Ubuntu:

```sh
sudo apt-get update
sudo apt-get install --yes ffmpeg xvfb xauth
```

Fedora desktop prerequisites:

```sh
sudo dnf install nodejs24 python3 python3-dbus curl unzip util-linux \
  gtk3 nss alsa-lib libXScrnSaver moby-engine docker-cli xorg-x11-server-Xvfb xorg-x11-xauth
sudo systemctl enable --now docker
```

Select Java 21 even if Fedora defaults to a newer JDK. Bun and Temurin releases
are available from [Bun](https://github.com/oven-sh/bun/releases/tag/bun-v1.3.14)
and [Eclipse Temurin](https://adoptium.net/temurin/releases/?version=21);
verify the release checksums before extraction. On Fedora, use an approved full
FFmpeg build with libx264; `ffmpeg-free` alone is insufficient.
[RPM Fusion's instructions](https://rpmfusion.org/Howto/Multimedia) describe
one third-party option. Review its repository policy and proposed transaction.

Launch Electron from the graphical session. On GNOME Wayland, retain the
session's actual `DISPLAY`, `XAUTHORITY` and `XDG_RUNTIME_DIR` for XWayland.
Do not substitute another user's display or authority file. SELinux can remain
Enforcing; the sandbox labels only its trusted read-only runner mount.

## Prepare the checkout

Run from the checkout root with the selected toolchain:

```sh
bun --version
node --version
java -version
javac -version
bun install --frozen-lockfile
docker pull node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
bun run build
bun run start
```

The pinned policy image is defined in
[`sandbox.ts`](../src/server/sandbox.ts). Sandbox preparation uses
`--pull=never`; install the image before retrying **Prepare server**.
There is no unsandboxed fallback.

`build` builds both Fabric clients and the renderer. Individual commands are
`build:native`, `build:agent`, and `build:ui`. `dev` builds once and opens the
desktop; it is not a watched browser server. Keep the checkout, dependencies,
build outputs and both sandbox files available while running.

In **Settings → Isolated Minecraft world**, read and accept the
[Minecraft EULA](https://www.minecraft.net/en-us/eula), then choose
**Prepare server**. The Survival CLI requires this existing consent and server
download; it does not silently consent for you.

Both Survival modes verify the official Minecraft session before client
startup. A verification timeout is neither a gameplay failure nor proof that
the account is signed out. A warm Fabric cache needs no loader-profile lookup.
On the reference GNOME host, the Launcher token is obtained through the unlocked
Secret Service for the exact active account. The helper does not select another
account, unlock the keyring or print/store the bearer. Refresh the official
Launcher login if the grant is unavailable.

## Connect a model advisor or strategic model

Model-free Survival needs no model login. For model advice, open **Settings → OpenAI
connection → Connect in browser**, complete authorization on the backend
machine, and leave `localhost:1455` available for the state-checked callback.
The app validates the provider HTTPS authorization address. If browser callback
login is unsuitable, **Use device code** supplies the trusted alternative.
Flow availability is not evidence that every login mode was exercised.

The app uses credentials obtained through its own flow, not ambient OMP/Codex
home credentials or an API-key fallback. Model discovery must finish before
selecting a strategic model; the generic program system requires advertised
image input. Discovery alone does not prove a successful live vision request.
See [platform evidence](evidence/integration-platform.md) for observed scope.

If needed, export the host's proxy settings before `start` or `dev`.
The trusted OAuth helper accepts `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`,
`NO_PROXY`, lowercase equivalents, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`,
and `SSL_CERT_DIR`. Keep `localhost,127.0.0.1,::1` direct through `NO_PROXY`.
Store proxy credentials and certificates privately.

## Local failures and private data

If Electron reports a misconfigured SUID sandbox helper, apply the host's
security policy to the trusted installed dependency:

```sh
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

Reinstallation can replace that helper. Never use `--no-sandbox`.
Renderer sandbox and context isolation remain enabled; Node integration is off.

Keep credentials, worlds, raw logs, recordings and evaluator records private.
Desktop storage defaults to Electron's `userData/runtime`;
`GAMEHARNESS_DATA_DIR` selects another private root. Use an absolute external
root for direct-backend operation. An ignore rule does not untrack a committed
file or secure a backup. Do not copy a live SQLite database without its WAL
sidecars. See [desktop operations](reference/operations.md) for storage and
shutdown, or [start ordinary Survival](survival/play.md).
