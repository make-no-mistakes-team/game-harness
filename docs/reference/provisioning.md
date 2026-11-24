# Native provisioning and private account bootstrap

Generic GameHarness's native adapter uses Java 21/Fabric 1.21.4, Normal Survival and ordinary privileges. Setup/launch steps are in [setup](../setup.md). These are trusted host implementation boundaries, never model tools or supplied gameplay state.

## Server artifacts and installer

Trusted options may select an existing project-owned public server artifact directory. Validate canonical directory/ownership, regular nonsymlink files, metadata version/URL, exact 56,880,250-byte Minecraft 1.21.4 JAR and SHA-1 `4707d00eb834b446575d89a61a11b5d548d8c001`. Stream private destination copy without changing source.

This copies no world/seed/inventory/credentials/client state. Omission uses normal download. Fabric retains downloadMinecraft, pinned loader/version and 240,000-ms installer deadline plus its own validation.

Launcher presence is not completed installation. Completion receipt follows actual successful installer closure; server SHA-1 and launcher SHA-256 recheck before reuse/launch. Failure retains fixed stage and timeout/caller-abort/nonzero/spawn category, numeric exit and safe signal, never third-party stdout/stderr.

Installer translates HTTP_PROXY/HTTPS_PROXY (lowercase aliases/ALL_PROXY fallback) into JVM properties. Only credential-free HTTP proxy URLs are supported; default loopback bypass stays. NO_PROXY supports IP/domain suffix/*, not credentialed/scheme-invalid/port/CIDR bypass. Reject unsupported configuration before preparation rather than ignore. Without proxy, unused bypass does not block installation. Restricted child environment excludes ambient JVM options/provider credentials.

## Game account and admission

Legitimate game access/EULA belong to operator. Official Launcher local account is used only through private trusted client bootstrap, never copied into repo/model/evidence.

Linux bearer may live in unlocked GNOME Secret Service while JSON token is blank. Narrow one-shot system Python/dbus helper reads **active account's exact token key** via private pipe, then launcher verifies matching official profile. No alternate account/keyring unlock/unrelated credential import. Bearer never reaches argv/logs/workers/model. This is OS binding, not Python gameplay orchestration.

Optional official-session readiness preflight uses same cached reader/profile verification without revealing account/credential or refreshing/changing it. It grants no launch authority; actual launch checks again after Source. Pure source/offline analysis needs none. Fixed confirmed-absence failure is not a diagnosis of expiry/mismatch; arbitrary faults stay redacted.

Managed Fabric server verifies private session proof before ordinary login/duplicate-player handling so same-name peer cannot displace owner. Name/whitelist/player cap is insufficient. Host-admin adversary/public multiplayer are outside scope.

Control authenticates session/world/epoch separately from latest-frame video. Physical gameplay/menu input suppression does not give renderer or human view raw actor capability. Game/account/control/video failure categories stay separate.

## Optional server obfuscation

Paper Anti-Xray is optional defense in depth, not delivered/tested deployment here and never permission enforcement. Adapter must pass hidden-state checks with it disabled; it does not protect entities/navigation/all indirect leaks.

If used, retain actual flavor/build/game, effective per-world/dimension enabled state and applicable mode/block/height/update config hash outside actor inputs. Freeze across comparisons. Masked/fake ores are not genuine discovery; current upstream docs do not automatically describe pinned older builds.

Sources: [`fabric-client-profile.ts`](../../src/server/fabric-client-profile.ts), [`adapter-contract.ts`](../../src/server/adapter-contract.ts), [native source](../../native/minecraft/). See [security](security.md), [preparation](preparation.md), [adapters](adapters.md).
