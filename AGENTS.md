## Documentation and GitHub issues

- Write all repository documentation in English.
- When creating or editing GitHub issues, write their descriptions in Russian.
- Before creating or editing Markdown documentation, read and apply the `sepia` skill.
- For `README.md`, also read and apply `crafting-effective-readmes`.
- These skill requirements are optional for Markdown files kept local and untracked.
- Before writing or editing GitHub issue titles or descriptions, read and apply `sepia`.
- Keep useful instructions, requirements, and verified facts; remove repetition and material that does not help the reader.

### Product framing and source boundaries

- Describe GameHarness as an extensible harness for multiple supported games.
  Minecraft is the first integration, not the product's permanent identity.
  Keep game-specific setup, mechanics, rendering, and verification in explicitly
  scoped adapter sections. Adding another game requires an adapter and evidence;
  extensibility does not mean automatic support for arbitrary games.
- Keep `README.md` a concise product entry point: purpose, essential prerequisites,
  installation and launch commands, and documentation links. Put interface
  walkthroughs, button behavior, lifecycle explanations, feature inventories, and
  behavior users can discover in the app in detailed guides or in-app help.
  Retain setup and safety instructions needed before the app can be used.
  Omit development progress, unfinished-feature lists, prototype history, and
  passed or unpassed MVP/release milestones.
- Record implementation status, limitations, acceptance gates, and verification
  evidence in the relevant technical documents. Distinguish requirements,
  implemented behavior, observed results, and historical snapshots. A successful
  build, selected fixture, or model response is not proof of gameplay success,
  full-suite coverage, or a measured improvement.
- Keep general architecture language-agnostic at component seams. Describe
  concrete languages and game integrations in their own modules; replacing a
  performance-critical implementation must not require changing the agent
  runtime, skill format, or game-adapter contract.
- Keep private plans, team/course details, credentials, worlds, and run evidence
  under locally excluded storage. Public documentation must not expose or link
  to `local/`. A checkout-local Git exclusion does not sanitize archives or
  already tracked files.
- When the user designates a design dialogue as requirements, treat unchallenged
  proposals as accepted and later replacements as superseding earlier proposals.
  Preserve archived dialogues verbatim in their original language; write new
  summaries in English. Dialogue claims about third-party APIs or performance
  still require source evidence or actual measurements.
- When a decision changes, reconcile affected documentation and examples instead
  of accumulating contradictory descriptions. Preserve useful historical
  evidence with its original scope; do not present it as current verification.
- Before editing agent instruction files, also read and apply
  `writing-for-agents`.

## Animation references

When designing or changing UI animations, strongly consider browsing
[Kinetics](https://kinetics.colorion.co/) for relevant references and inspiration.
This is a recommendation, not a requirement; original animations are welcome.
For desktop applications, these web animation references can still be useful:
adapt the motion to the desktop frontend's language and UI framework.
Adapt references to GameHarness's visual style, live game viewer, and session
controls rather than copying them unchanged.

## Tooling and dependencies

The agent may install any tooling or dependencies needed for the task without
asking permission. This includes packages, libraries, CLIs, SDKs, and build or
test dependencies, through apt, brew, npm, pnpm, yarn, pip, pipx, uv, cargo, go,
gem, composer, or other package managers.

Missing dependencies are setup work. Install tools that improve correctness,
performance, maintainability, or diagnostics rather than choosing a weaker
implementation to avoid installation.

Prefer project-local, temporary, or virtual-environment installs when practical.
Use system-wide installation when needed. Report changes to tracked lockfiles,
manifests, and configuration as part of the workspace changes.

## Committing and integrating into main

In this shared repository, a request to commit changes to `main` or integrate a
feature into `main` includes pushing the result to `origin/main`, unless I
explicitly request a local-only operation. No separate push confirmation is
needed for these requests.

When asked to integrate a feature branch into `main`, default to preserving
every commit: advance `main` to the branch tip by fast-forward only, without a
merge commit or squash. Check the base of any open PR so its status reflects
the integration. Use another method only if I request it.

Before integrating or pushing, fetch `origin/main` and verify fast-forward
ancestry. If history has diverged, stop and discuss how to proceed rather than
rewriting or force-pushing shared history.

Delivery is complete only after the push succeeds, including any required Git
LFS uploads. Report the branch, commit hash, and push result. If publication is
blocked, state the blocker and that the changes remain local; a local commit
alone does not make the work available to teammates.
