# Integration evidence: platform, desktop and software checks

These retained checks are scoped to their source/artifact cohorts.
Routine repeated build logs were condensed; failed checks remain failures.
None is a substitute for gameplay acceptance or proof of controlled savings.

## Host and authorization

Fedora 44 x64 verification on 23 October 2026 used GNOME Wayland,
Bun 1.3.14, Node 24.18.0, Temurin JDK 21.0.13 and Docker/Moby 29.8.2
with SELinux Enforcing.
Frozen install, pinned image pull and full native/UI build succeeded after
prerequisite selection; both native proofs passed, as did typecheck and
304 Bun tests.
The actual 1440×900 Electron window showed the connected workspace with
renderer sandbox/context isolation and no Node integration.
Production readiness, two simultaneous policy workers and an isolated skill
passed synthetic zero-provider Docker smoke.

Initial failures exposed Debian-specific Java selection, shell startup
overwriting selected JDK and an unlabeled read-only runner mount blocked by
SELinux. Corrections retained isolation. Mapping/deprecation warnings remained.
The operator later reported acceptance of Minecraft, OpenAI OAuth and an
agent-task trial; that report is separate from independently observed build,
desktop and isolation checks, and is not controlled gameplay efficacy.

OAuth authorization and real Codex discovery succeeded with the trusted helper's
proxy environment. This did not independently qualify both browser/device-code
flows or a live vision request. No ambient OMP/Codex credentials were imported.
The optional Jev connection and two-provider bounded-task acceptance were not
established by configured credentials or discovery.

The selected native planning build passed on Java 21.
System-default Java 25 had failed Gradle Test construction; choosing the
documented JDK fixed that build without changing the system default or build
system. Known upstream mapping/deprecation warnings remained.

## Desktop and relay

Initial Electron checks established nonce-owned dynamic-port startup.
At 1000×650 the game occupied 75% of the main area without global overflow.
Authorized diagnostics returned 200; unauthenticated reads 401;
bad CSRF/Host/Origin 403; plain HTTP video 426; sending a message to the
read-only video socket closed it with 1008.
The probe started no game/model. SIGTERM exited 0 and closed the backend,
but did not test active-game/request/unknown-effect cleanup.
Usage initially fell below the fold; later inspected 1440×900 and 1000×650
captures showed all counters and 75% gameplay width.

Integrated native video initially went invalid/stale after a Mojang frame.
Correcting malformed/stale classification did not resolve a browser socket
stall after three/four frames. Separate relay probes delivered 15 frames;
a reported backend window forwarded all 15,173 native frames with sampled CPU
20.46% of one core, p95 forwarding 0.00472 ms and p99 event-loop lag 1.16 ms.
Those diagnostics did not prove working desktop presentation.

The relay moved coalesced delivery out of the native callback through
`setImmediate`, rechecking viewers. A 72-second window then had 2,149 published,
1,429 latest-frame sends, zero buffered bytes and final sequence 2,149.
Latest-frame transport was not lossless.
Independent raw TCP reproduced the old stall after one frame over eight seconds,
about 1.38 MB pending; the deferred path delivered 19 frames through sequence 67
in 2.24 s with zero pending. A permanent real-network regression was added.
OS capture showed authentic app world/hand/HUD with displayed 30 FPS,
7 ms capture-to-draw and 47 ms frame age: samples, not percentiles.
Full-RGBA CDP overloaded the observer helper; this was not established as the
relay cause. No model calls occurred. An idle creeper death remained retained.

Later alive-desktop inspection used a stopped run, signed-out provider and
1280×720 stream around 30 FPS at 1440×900 and 1000×650.
Minimum viewport game width was 732/976 px, 75%; hiding the pane gave 976 px.
Resize/reload preserved alive health 20 and session/life 1.
Trusted mouse/Escape restored focus; an untrusted DOM-click probe was discarded.
Trace was corrected to lead with condition/source/action/attribution and collapse
raw JSON. Actual minimum-size capture showed `i < 12`→true at 1:16, Raw closed.
All raw fields remained available; this was not hidden reasoning.
Diagnostic X11 window destruction later caused GPU-context loss and required
owned-group cleanup; it was not normal app quit evidence.
Normal-close evidence is separately retained in
[lifecycle](integration-lifecycle.md) and [revision](integration-gameplay-planning.md).

## Software-check milestones and limits

| Cohort | Recorded checks | Limits or failed predecessor |
| --- | --- | --- |
| Initial assembled desktop | 65 tests / 438 assertions / 11 files, 6.4 s | Not verification of later corrections |
| Program-primary cutover | 71 / 495 / 13 | Native/UI 16.18 s; source/API differ from first wood |
| Movement receipts | 71 / 495 / 13, 9.40 s; native/UI 18.29 s | External GLFW mapping warning retained |
| Death teardown correction | 73 / 514 / 14, 9.75 s; typecheck/build pass | Failed warm teardown stayed failed |
| Schema-2/r2 post-review | 143 / 1,021 / 20, 32.81 s | Earlier whole suite exceeded 600 s; eight reactive failures used invalid fixture yaw |
| Uncertainty reconciliation | 147 pass, one timeout of 148 | 100-child fixture exceeded five seconds; not all-pass |
| Readiness test correction | 100-child deadline 5→15 s, all 101 assertions retained | Actual durable-store run measured 5.14 s |
| Before final direct-policy fix | 152 / 1,115, typecheck/build pass | Does not verify subsequent retirement change |
| Post-fix targeted regressions | 27 / 214 / two files, 21.28 s | Separate invalid-payload live fixture failed |
| Planning opt-in / catalogue / revision contract | 163 / 1,231; 168 / 1,292; 170 / 1,319 | Each passed typecheck/build on its own source; no gameplay upgrade |
| Host-pinned planning | 177 / 1,355 / 20, 43.37 s | Same `f376…` JAR; full sequence 49.22 s |
| Task-field help | 38 / 286 / two files, 4.85 s | Targeted only; typecheck plus tests 5.48 s |
| Resumption repeat | 177 / 1,355 / 20, 44.21 s | 44.86 s with typecheck; no unchanged Java/UI rebuild |
| Projection consumer fixes | 14 / 120, 2.98 s; typecheck/UI pass | Three original consumer tests failed first, 847 ms |
| Before explicit provider strictness | 294 / 1,815 / 28, 45.51 s | Does not verify later setting |
| Explicit `strict:false` | 295 / 1,827 / 28, 45.53 s, typecheck pass | No model/native/UI rerun in that cohort |

Focused evaluation checks separately passed policy/config/tiers 17/143,
pagination 6/96, scenario/evidence/seed 22/106 and tier-command smoke 5/92.
Pure-library worker verification passed 192 cases with one opt-in Docker skip;
the opt-in guardian/shared-and-fresh-realm/step-root case subsequently passed.
Those are software/isolation results, not model adoption or useful play.
