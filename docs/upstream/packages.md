# Pinned OMP packages and reuse boundaries

GameHarness pins exact published `@oh-my-pi/*` **18.12.3** packages in
`package.json` and `bun.lock` for provider catalog metadata, OAuth/API-key
authentication primitives, and streaming model calls used by `src/auth/` and
`src/strategist/`.

The read-only upstream source audit on **20 October 2026** inspected commit
[`2220e58146ebe31508e7a216242840d373e082d0`][source]. Equal version strings do
not prove npm-to-commit build provenance; keep exact lockfile versions and
integrity hashes rather than floating ranges.

| Direct package | Reused public surface |
| --- | --- |
| [`@oh-my-pi/pi-ai@18.12.3`][npm-ai] | Provider streams, message/tool decoding, and auth helpers |
| [`@oh-my-pi/pi-agent-core@18.12.3`][npm-agent] | Agent/compaction primitives where needed |
| [`@oh-my-pi/pi-catalog@18.12.3`][npm-catalog] | Model/auth catalog and pricing metadata |
| `@oh-my-pi/pi-utils@18.12.3` | Shared utilities and transitive native bindings |

Bun **1.3.14+** and native transitive dependencies (`snapcompact`,
`pi-natives`) remain required on Linux x64.

## Reuse boundaries

- `streamSimple` / `completeSimple` decode and validate messages; schemas grant
  no execution authority. Always check terminal `stopReason`, not thrown errors
  alone.
- Provider argument normalization never replaces GameHarness bounds, budget, or
  freshness checks in `src/auth/` and `src/strategist/`.
- Catalog metadata establishes neither live provider reachability nor account
  entitlement.
- Do not import coding-agent CLI tools, terminal UIs, unrestricted `eval`
  helpers, or ambient workspace credentials from upstream packages. See
  [providers](../reference/providers.md) and [security](../reference/security.md).

Upstream source references: [AI exports][exports], [Agent options][agent],
[tool/event contracts][tools], [context/schema types][types], and
[argument validation][validation].

## Credential-free smoke baseline

A credential-free import smoke against the pinned **18.12.3** packages verified
module loading, tool schema validation, and pre-call gating with zero live
provider requests. Sample pricing entries reported unknown/zero placeholders.
Smoke checks establish neither live auth nor gameplay competence.

[source]: https://github.com/can1357/oh-my-pi/tree/2220e58146ebe31508e7a216242840d373e082d0
[npm-ai]: https://registry.npmjs.org/@oh-my-pi%2Fpi-ai/18.12.3
[npm-agent]: https://registry.npmjs.org/@oh-my-pi%2Fpi-agent-core/18.12.3
[npm-catalog]: https://registry.npmjs.org/@oh-my-pi%2Fpi-catalog/18.12.3
[exports]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/ai/src/index.ts#L1-L72
[agent]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/agent/src/agent.ts#L110-L191
[tools]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/agent/src/types.ts#L1100-L1293
[types]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/ai/src/types.ts#L1580-L1682
[validation]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/ai/src/utils/validation.ts#L1993-L2068
