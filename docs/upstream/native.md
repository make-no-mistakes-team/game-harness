# Current native Minecraft sources

The selected client/server are Java 21/Fabric projects in
[`native/minecraft`](../../native/minecraft/), targeting Minecraft 1.21.4.
Electron **45.0.0** owns the desktop and Vite builds its renderer. Actual final
framebuffer capture replaces reconstructed terrain; separate control/video
authorization does not widen actor perception. Source/API availability is not
proof of actual app compatibility, capture performance or gameplay.

| Source | What it supports |
| --- | --- |
| [Official 1.21.4 manifest][minecraft], [Loader 0.16.10][loader] | Exact launch/runtime dependency metadata, not entitlement or successful launch |
| [Fabric 1.21.4 guidance][fabric], [Loom 1.9.2][loom], [Fabric API 0.119.4+1.21.4][api] | Pinned development compatibility |
| [Yarn build.8 GameRenderer][renderer], [Framebuffer][framebuffer] | Version-specific capture surfaces, not working post-world/hand/HUD evidence |
| [Keyboard][keyboard], [Mouse][mouse], [InputUtil][input], [KeyBinding][binding] | Distinct callback/polling surfaces requiring suppression |
| [Pinned login gate mixin][login] | Login-query gate seam; real unrelated/same-name rejection still needs evidence |
| [glReadPixels][pixels], [GLFW offscreen guidance][glfw] | Readback/context and hidden-window limits, not measured FPS/latency |

Lawful accounts/acquisition/EULA remain operator responsibilities. Native
conformance, authentic view, isolation and ordinary gameplay have separate
[evidence](../evidence/evaluation-mechanics.md).

## Related work

[Voyager](https://github.com/MineDojo/Voyager) informs generated programs and
reusable skill libraries. The [reported Minecraft system arXiv:2610.22319][paper]
uses four agents, Easy difficulty and structured Mineflayer access. Its reported
completion proves neither this single-model Normal Survival system nor another
supported game. These references establish no scientific novelty/performance
advantage. Mineflayer/pathfinder/viewer are [retired-adapter sources](retired-adapter.md),
not selected native dependencies or automatic fallback.

[minecraft]: https://piston-meta.mojang.com/v1/packages/ee8ab0f6ec89b3127436d35e36aa766c1e85c3a9/1.21.4.json
[loader]: https://meta.fabricmc.net/v2/versions/loader/1.21.4/0.16.10/profile/json
[fabric]: https://fabricmc.net/2024/12/02/1214.html
[loom]: https://maven.fabricmc.net/net/fabricmc/fabric-loom/1.9.2/fabric-loom-1.9.2.pom
[api]: https://maven.fabricmc.net/docs/fabric-api-0.119.4+1.21.4/
[renderer]: https://maven.fabricmc.net/docs/yarn-1.21.4+build.8/net/minecraft/client/render/GameRenderer.html
[framebuffer]: https://maven.fabricmc.net/docs/yarn-1.21.4+build.8/net/minecraft/client/gl/Framebuffer.html
[keyboard]: https://maven.fabricmc.net/docs/yarn-1.21.4+build.8/net/minecraft/client/Keyboard.html
[mouse]: https://maven.fabricmc.net/docs/yarn-1.21.4+build.8/net/minecraft/client/Mouse.html
[input]: https://maven.fabricmc.net/docs/yarn-1.21.4+build.8/net/minecraft/client/util/InputUtil.html
[binding]: https://maven.fabricmc.net/docs/yarn-1.21.4+build.8/net/minecraft/client/option/KeyBinding.html
[login]: https://github.com/FabricMC/fabric-api/blob/7347d6186858dcfcf7fccf747e8029067caaece5/fabric-networking-api-v1/src/main/java/net/fabricmc/fabric/mixin/networking/ServerLoginNetworkHandlerMixin.java#L63-L69
[pixels]: https://registry.khronos.org/OpenGL-Refpages/gl4/html/glReadPixels.xhtml
[glfw]: https://www.glfw.org/docs/3.4/context_guide.html#context_offscreen
[paper]: https://arxiv.org/abs/2610.22319
