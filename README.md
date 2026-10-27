# GameHarness

GameHarness is a desktop harness where AI agents write and improve their own game-playing programs. Game integrations are adapter-based, with Minecraft Java Edition as the first.

## Quickstart

Requires Linux x64, Bun **1.3.14+**, Node.js **24+**, a selected **JDK 21**, Python 3 with `python3-dbus`, `flock` and a local Docker Engine. Complete the [setup prerequisites](docs/integration-spike.md#install-and-start), including legitimate game access, before building. Fedora users should first follow the [Fedora setup](docs/integration-spike.md#fedora-linux-x64).

From a fresh clone:

```sh
# Keep credentials, run evidence, and worlds out of version control.
printf '\n/local/\n' >> .git/info/exclude
bun install --frozen-lockfile
docker pull node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
bun run build
bun run start
```

For Electron sandbox errors, follow the [sandbox-helper setup](docs/integration-spike.md#electron-sandbox-helper); do not disable Chromium's sandbox.

## Documentation

- [Game setup and operating guide](docs/integration-spike.md)
- [Playable acceptance contract](docs/implementation-mvp.md)
- [Product requirements](docs/prds/gameharness-v1.0-prd.md)
- [Architecture](docs/architecture/overview.md)
- [Runtime and adapter contracts](docs/runtime-contracts.md)
- [Learning and evaluation](docs/learning-and-evaluation.md)
- [Operations and security](docs/operations-and-security.md)
- [oh-my-pi reuse and source evidence](docs/upstream-reuse.md)
