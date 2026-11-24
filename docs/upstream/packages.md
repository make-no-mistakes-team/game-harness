# Pinned OMP packages and source boundaries

The read-only OMP source inspection on **20 October 2026** used commit
[`2220e58146ebe31508e7a216242840d373e082d0`][source].
Published package smoke used exact **18.12.3** artifacts, not a build of that
checkout. Equal version strings do not prove npm build-to-commit provenance;
registry integrity/attestation records were available, but signatures and that
relationship were not verified. Record actual resolved integrity, Bun/native
platform and artifact provenance separately.

| Direct package | Reused public surface |
| --- | --- |
| [`@oh-my-pi/pi-ai@18.12.3`][npm-ai] | Provider streams/messages/tools/validation, auth, `/judgment` |
| [`@oh-my-pi/pi-agent-core@18.12.3`][npm-agent] | `/agent`, `/compaction` |
| [`@oh-my-pi/pi-catalog@18.12.3`][npm-catalog] | `/models`, auth/model/pricing metadata; direct dependency when imported |

Use manifest name `pi-agent-core`, not an old README's `pi-agent`. Pin exact
versions/lockfile, not `latest`/caret. Bun **1.3.14+** and transitive native/
tokenizer dependencies remain required: agent includes `snapcompact`; catalog
reaches `pi-natives` through `pi-utils`. `/agent` does not eliminate native
requirements. Native Minecraft uses Java 21; isolated workers use Node.

## Reuse without importing coding-agent authority

`streamSimple`/`completeSimple` decode/validate messages; schemas execute nothing
and grant no authority. Check terminal `stopReason`, not thrown errors alone.
`Agent` starts with no tools; supply only app capabilities. Concurrent `prompt()`
on one instance is rejected. Public `streamFn` is a per-agent seam; global
`registerCustomApi` exists but is unnecessary for the selected path.

`Context.systemPrompt` is an array of strings. Current tools accept plain JSON
Schema or upstream schema types, not only old TypeBox examples. Provider argument
normalization never substitutes for app permission/bounds/freshness checks.
Catalog metadata establishes neither live availability nor account entitlement.

Pinned implementation evidence: [AI exports][exports], [Agent options][agent],
[tool/event contracts][tools], [context/schema types][types] and
[argument validation][validation].

Upstream tool batches are awaited; a tool waiting for long navigation can block
the next strategic turn. Steering is cooperative, not cancellation proof; asides
arrive at turn boundaries, not as renewed effect authority. App tools promptly
submit jobs/return IDs; independent runtime owns effects, neutralization, policy
evaluation and freshness. See [programs](../reference/programs.md).

Compaction preserves complete tool-result groups but remains lossy and
coding-oriented. Adapt summaries to goals, uncertainty and outcomes; retain
original events/source separately. Conversation checkpoints/rewind restore
history, not closures, pending promises, game state or executable stacks.

Coding-agent dynamic tool registration is mutable process memory, not immutable
policy persistence. Its session journal is workspace/TUI/indexing-coupled and
flush does not call `fsync`. Epoch checks and unmatched-tool unknown diagnostics
are useful patterns, not game-effect proof. Narrow extraction must retain original
commit/path, destination/modifications and notices; no full CLI fork, terminal UI
or unrestricted coding tools are needed.

The coding evaluator uses `globalThis.eval` and exposes real filesystem/imports/
process; launcher environment is no secret boundary. Bun workers/subprocesses/
VMs alone are not a sandbox. App OS isolation/brokered capabilities remain
mandatory; see [security](../reference/security.md).

## Credential-free smoke evidence

Exact packages imported AI, Agent, catalog and judgment with native dependency.
Tool validation accepted integers/rejected strings. One `beforeModelCall` gate
stopped before inference; events were `agent_start`, `message_start`,
`message_end`, `agent_end`. Temporary installed directory measured **266M**,
not download size/RAM. Sample pricing was unknown with zero placeholders.
No provider/auth/Jev/game request occurred; no gameplay/render/isolation/
compatibility or full model/tool round trip follows from this smoke.

[source]: https://github.com/can1357/oh-my-pi/tree/2220e58146ebe31508e7a216242840d373e082d0
[npm-ai]: https://registry.npmjs.org/@oh-my-pi%2Fpi-ai/18.12.3
[npm-agent]: https://registry.npmjs.org/@oh-my-pi%2Fpi-agent-core/18.12.3
[npm-catalog]: https://registry.npmjs.org/@oh-my-pi%2Fpi-catalog/18.12.3
[exports]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/ai/src/index.ts#L1-L72
[agent]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/agent/src/agent.ts#L110-L191
[tools]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/agent/src/types.ts#L1100-L1293
[types]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/ai/src/types.ts#L1580-L1682
[validation]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/ai/src/utils/validation.ts#L1993-L2068
