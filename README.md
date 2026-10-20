# GameHarness

An adapter-based runtime for LLM game agents. The current **integration spike** connects an OMP-backed OpenAI account to a real Minecraft Java player, live viewpoint viewer, and model-authored JavaScript policies. The [first complete playable MVP](docs/implementation-mvp.md) remains a separate, unpassed acceptance gate.

## Quickstart

Use Linux x64 with Bun **1.3.14+**, Node.js **24+**, `flock`, and a running local Docker Engine accessible to your user at `/usr/bin/docker`. You need an OpenAI account entitled to Codex access and must accept the Minecraft server EULA. A desktop Minecraft client is optional.

From a fresh clone:

```sh
# Keep credentials, run evidence, and worlds out of version control.
printf '\n/local/\n' >> .git/info/exclude
bun install --frozen-lockfile
docker pull node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
bun run build
bun run start
```

Open **http://127.0.0.1:4317**.

1. In **Setup**, choose **Connect in browser** or **Use device code** and finish OpenAI authorization. Browser login uses callback port **1455**. Follow the [proxy setup](docs/integration-spike.md#openai-authorization-and-proxies) before starting the app if needed.
2. Accept the EULA, click **Prepare server**, then **Start world**. Preparation downloads the pinned Java runtime and Minecraft 1.21.4 server; it does **not** pull the Node policy image above. Wait for the player and viewer to connect.
3. Select a discovered strategic model and goal, enter the task, click **Create run**, then **Start**. Inspect activity, inventory, and policy evidence. **Stop run** closes the player session; **Stop world** also stops the server. Closing the browser does neither.

Runtime data defaults to `local/runtime/`, including private app-owned OAuth storage. Do not commit or share this directory. The [integration guide](docs/integration-spike.md) covers storage, development mode, source access, stop uncertainty, and the evidence and limits of this spike.

## Documentation

- [Integration spike: setup, current evidence, and limits](docs/integration-spike.md)
- [First complete playable MVP contract](docs/implementation-mvp.md)
- [Product requirements](docs/prds/gameharness-v1.0-prd.md)
- [Architecture](docs/architecture/overview.md)
- [Runtime and adapter contracts](docs/runtime-contracts.md)
- [Learning and evaluation](docs/learning-and-evaluation.md)
- [Operations and security](docs/operations-and-security.md)
- [oh-my-pi reuse and source evidence](docs/upstream-reuse.md)
