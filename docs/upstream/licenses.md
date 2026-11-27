# Licensing and distribution evidence

OMP first-party code at inspected commit
[`2220e58146ebe31508e7a216242840d373e082d0`][mit] is MIT, with copyright notices
for Mario Zechner, Can Bölük, and Stencil Labs. MIT permits reuse and
modification provided copyright and permission notices accompany copies or
substantial portions. Keeping upstream notices neither chooses this
repository's own license nor implies one has been assigned.

The upstream [aggregate notices][notices] do not replace individual package
licenses or grant rights to third-party fonts, assets, or marks. Audit every
shipped artifact — including native libraries and packaged bundles — before
redistribution; do not assume every dependency is MIT.

| Component | Distribution obligation |
| --- | --- |
| Native `inferno` (CDDL-1.0) | Preserve license; distributing covered executables requires covered-source availability and recipient access notice. |
| Silver font (CC BY 4.0) | If shipped, include author/source attribution, license, and modification notes. |
| Optional `sharp` / `libvips` (LGPL-3.0-or-later) | Review notices, source availability, and relinking terms if bundled rather than runtime-fetched. |
| MPL and vendored assets | Distinguish build-only from shipped files; retain covered-file source notices and inherited MIT/BSD terms. |

Keep upstream legal payloads inside distributed bundles, not only in source
repositories. Any narrow source extraction must record original commit, path,
destination, and modifications alongside original notices.

Minecraft binaries, assets, and accounts remain governed by the
[Minecraft EULA](https://www.minecraft.net/en-us/eula) and
[usage guidelines](https://www.minecraft.net/en-us/usage-guidelines). Never
redistribute game binaries, assets, or account credentials without
authorization.

This is an engineering distribution checklist, not legal advice.

[mit]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/LICENSE
[notices]: https://github.com/can1357/oh-my-pi/blob/2220e58146ebe31508e7a216242840d373e082d0/THIRD-PARTY-NOTICES.txt
