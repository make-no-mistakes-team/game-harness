# Original released-policy reference

The original STEVE-1 reference is a separate **synchronous research condition**,
not the ordinary local Java player or a production Minecraft controller.
Reference reproduction, independent live-clock behavior and production-port
outcomes are separate claims. Synchronous steps/fixed-rate footage cannot prove
a live player.

The [controller validator](../../src/shared/controllers.ts) and
[reference admission](../../src/evaluation/policy-reference-study.ts) own exact
manifest fields. Freeze the real manifest and all artifact/dependency/config/
fixture hashes; do not substitute a DTO summary for it.

## Pinned identity and interpretation

| Source | Exact commit |
| --- | --- |
| STEVE-1 | `903b244796322f4d0073a8f62c05f51eac3aed52` |
| MineCLIP | `e6c06a0245fac63dceb38bc9bd4fecd033dae735` |
| VPT | `095519fbd4ee0e9281d19f19601e45629de9ac3f` |
| MineRL | `c0c9baa03b5306ffc3acddc849ec4141b6deb98e` |
| MCP-Reborn | `1e71be5bd4c49bc4d6ab0ee559c31b298b7697a3` |

Use original Minecraft **1.16.5**, Java **8**, `MineRLHumanSurvival-v0`,
locally built MCP-Reborn/MineRL engine, synchronous clock and frameskip **1**.
This is not the production Fabric 1.21.4 observation3 descriptor. The reference
profile is original **RGB/schema1**, `pov` only, **640×360** render →
**128×128** OpenCV linear resize, uint8 RGB with internal divide-by-255.
FOV **70**, gamma **2**, GUI scale **1**, cursor **16**, sensitivity **0.5**;
invert mouse/smooth camera disabled.

Original vendored-VPT mapping uses pitch then yaw in degrees, **11** mu-law
camera bins, bin size **2**, max **10**, mu **10**, and exact declared buttons.
Text goal uses scale **6**, one stochastic prior embedding per goal, shape
**1×512**, declared float16/float32 and pinned tokenizer revision
`57c216476eefef5ab752ec549e440a49ae4ae5f3`. CFG batch **2** transformer
mask/KV state resets per episode/goal. Policy/MineCLIP/prior use `cuda:0` and
CUDA-autocast fp16 with actual compatibility evidence.

## Admission and finite limits

One immutable live slot, one arm/state/repetition, no optional blocks, no
helpers/sidecars/provider request paths. Model/provider identities are null;
host requests and concurrent requests are **zero**; one worker. Freeze the
controller's actual setup/behavior/total/inference walls, inference/step/
behavior/process/resource/download/disk/recording/shutdown limits. Study horizon
and per-attempt/cohort attempt wall equal that controller total; elapsed cohort
allowance cannot be smaller. Generic permission grants no replacement attempts.

Two declared behaviors are **dirt** and **wood**, with independent positive own
inventory gain verifiers and exact fixtures. The fixture bundle pins actual
bytes and **seed before each effective reset**, not a restored matched save.
A negative completed behavior preserves the next scheduled behavior; invalidating
boundary/platform/resource failure stops safely. Keep negative outcomes intact.

Registration:
`bun scripts/policy-reference.ts register --study-manifest <manifest>`.
Registration verifies source/controller/profile/dependencies/configuration/
fixtures without loading a game/model. Dedicated `run` needs the same study/slot,
pinned controller, independently verified prepared artifacts/private fixtures,
new private output and both `--allow-native --allow-inference`. It reserves
before external preparation; no downloading replacements, checkpoint switching
or runtime fallback.

## Isolation and release

Learned and trusted environment processes use separate network-none containers.
Only environment gets worlds/verifier/recording/owned renderer. No host home/
auth/display/input, unrelated worlds, evaluator hints or writable policy
artifacts. Verify actual partitions/mounts and kernel cgroup measurements:

| Partition | Memory | CPUs | Tasks |
| --- | --- | --- | --- |
| Policy | **5 GiB** | **5** | **128** |
| Environment | **2.5 GiB** | **2** | **96** |
| Supervision | **512 MiB** | **1** | **32** |

Java heap is **1.5 GiB** with **1 GiB** host headroom. Record real GPU identity/
capacity, resource measurements, image/runner/dependency inventory and renderer
identity. Unknown ownership/resources fence execution. Outcomes and confirmed
drain are independent.

Code/admission tests establish neither reproduction, memory fit, hardware
compatibility nor competence. Those need separately admitted real loading,
action/behavior screens and retained original-speed recordings. Review applicable
component terms before distributing weights/source/simulator; OMP's license does
not license these independent artifacts.
