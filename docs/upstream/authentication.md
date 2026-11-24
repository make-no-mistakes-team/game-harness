# Provider authentication and judgment evidence

Source inspection is pinned to OMP
[`2220e58146ebe31508e7a216242840d373e082d0`][source].
Upstream implementations are not proof of app connectivity, entitlement or
current provider acceptance. Product model selection is configurable, with no
silent fallback. Credentials stay in the trusted broker, never workers/prompts/
events/exports/tracked files.

## Auth seams

`AuthStorage` is public at root and `/auth-storage`, accepts a credential-store
interface and can open its SQLite store. Use namespaced credentials/keys/oauth/
affinity/usage APIs, not deprecated flat redirects. OAuth login persists a key
or grant through host URL/masked-prompt/cancellation/device callbacks; access
resolves refreshed credentials and transport identity.

Key precedence is runtime override, config override, stored OAuth, login-stored
key, config fallback, environment and remaining stored keys, subject to provider/
session restrictions. `AgentOptions.getApiKey(model)` is the strategic bridge.
The registry login list includes API-key providers; listing is not subscription
support. `getOAuthApiKey` needs a fresh grant and delegates refresh to storage.

Public engines/transport/refresh live in pi-ai, while provider policy is compiled
from pi-catalog `src/compat/rules/auth/*.kdl`. Not all auth code lives in pi-ai.

| Source-verified route | Constraint |
| --- | --- |
| [OpenAI API][openai] | Key route, distinct from subscription |
| [openai-codex][codex] | Browser PKCE/refresh; explicitly allowlisted localhost **1455**, no silent alternative |
| [openai-codex-device][device] | Headless device grant stored under openai-codex |
| [anthropic][anthropic] | Upstream Claude Pro/Max OAuth, inference scopes, organization identity/refresh |
| [github-copilot][copilot] | Custom login/refresh, structured routing metadata |
| [google-gemini-cli][gemini] | Cloud Code Assist browser/refresh, project metadata |
| [typesafe][typesafe] | Key, environment fallback, console login; endpoint validation belongs to login, not import smoke |

An implementation path, grant and model entitlement are separate facts. Use
legitimate supported flows under actual account/current terms; exercise refresh/
restrictions during integration. No credential-bearing flow was exercised in
the source/package investigation.

Select credential sources explicitly; never silently import OMP/Codex/browser/
home stores or unrestricted command-valued keys. The separately authorized
official Minecraft Launcher OS-keyring bootstrap is a narrow game-account path,
not permission to import model credentials.

## Jev deadlines and actual app boundary

Public `pi-ai/judgment` implements TypeSafe `POST /v1/systemone`, typed responses/
usage; default wire model is `jev-latest`, with catalog routing to concrete judges.
[TypeSafe's announcement][jev] establishes no measured app reaction speed.

Upstream NativeJudge defaults are **10 seconds/attempt, three attempts** with
backoff; split requests can add work. Factory connection settings do not expose
all constructor timeout options. Apply an absolute abort deadline, bound
outstanding judgments independently and prevent retry/backoff extending useful
authority. If using the constructor for shorter timeout, preserve catalog routing/
capability settings. Retain available partial usage even when output is discarded.

The documented app broker selects a bundled TypeSafe judge independently from
the strategic model: effective **2-second** deadline, **10-second** maximum,
**one attempt**, **two concurrent**, **60/minute**, no queue. Aborted requests
hold capacity until actual settlement. Configured status exposes model/deadline;
unavailable/closed selection is null. An app-owned stored key proves only
configuration; no live-key entitlement/connectivity/reaction pass was claimed.

Validate typed choices, then session/life/epoch, policy version, relevant changes,
age and lease immediately before effects. Exact equality with latest observation
sequence would wrongly discard every slow answer. Local JS is independent;
failed/unavailable Jev never becomes a successful local impersonation.

[source]: https://github.com/can1357/oh-my-pi/tree/2220e58146ebe31508e7a216242840d373e082d0
[openai]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/catalog/src/compat/rules/auth/openai.kdl
[codex]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/catalog/src/compat/rules/auth/openai-codex.kdl
[device]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/catalog/src/compat/rules/auth/openai-codex-device.kdl
[anthropic]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/catalog/src/compat/rules/auth/anthropic.kdl
[copilot]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/catalog/src/compat/rules/auth/github-copilot.kdl
[gemini]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/catalog/src/compat/rules/auth/google-gemini-cli.kdl
[typesafe]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/packages/catalog/src/compat/rules/auth/typesafe.kdl
[jev]: https://typesafe.ai/blog/introducing-system-one-models-and-jev
