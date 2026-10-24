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
- A user-designated research or design source takes precedence over conflicting
  project design and workflow rules. Reconcile those rules when the user
  authorizes the change; keep factual claims separate from requirements and
  preserve private-source publication boundaries.
- When a decision changes, reconcile affected documentation and examples instead
  of accumulating contradictory descriptions. Preserve useful historical
  evidence with its original scope; do not present it as current verification.
- Keep the approved ordinary-module, disclosed-helper, RGB-profile, prepared
  development-task, checkpoint-recovery and explicit compatible cross-model
  reuse requirements distinct from the current compact-body implementation.
  Jev is optional; the first complete autonomous chain must work without it.
  Current limits and unavailable modes belong in implementation sections,
  not as permanent reductions of the product requirements.
- Before editing agent instruction files, also read and apply
  `writing-for-agents`.

## Verification and live evaluation

Before selecting checks, diagnosing a live model failure, changing evaluation
limits or models, or reporting cost/results, read and follow the canonical
[verification and live-evaluation policy](docs/learning-and-evaluation.md#verification-and-live-evaluation-policy).

- Workers hand off edits without running checks, builds, providers or services.
  The parent runs the smallest affected checks after handoff and a combined final
  regression/build only when relevant inputs changed.
- Preserve platform results and agent outcomes independently. Diagnostic live
  attempts stop after two unsuccessful attempts on one technical hypothesis
  unless concrete new platform evidence authorizes another attempt; a
  prompt/model change alone does not reset the limit. Predeclared finite
  experimental cohorts use the separate study-admission rules in the canonical
  policy, retaining every scheduled outcome rather than stopping at a preferred
  result or relabeling diagnostic retries.
- Use a registered immutable manifest and assigned slot for study execution.
  Admission-only mode exercises governance without a model or game; initial
  live study support is cold fresh-world whole-agent execution. Read the
  canonical policy's capability limits before selecting another condition.
- Record finite limits and actual usage before making claims. Retain failed
  attempts and unknown costs; never repeat a paid control just to obtain a pass.

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

Keep `main` linear and preserve individual commits. Prefer fast-forward to
preserve hashes when possible. If a PR or feature branch has diverged from
`main`, **Rebase and merge** or a local rebase on a temporary integration branch
is allowed without separate approval; preserve authorship and commit boundaries,
but changed hashes are acceptable. Do not create merge commits or squash unless
I explicitly request it.

Before integrating or pushing, fetch `origin/main` and check the final result
against it. Never rewrite or force-push published `main`. Ask if local `main`
has diverged from `origin/main` or rebase conflicts leave the intended behavior
unclear. Check that the open PR's base and status reflect the integration.

Before every push, review the exact commit tree and every outgoing commit for
private files, secrets, and personal information, including newly added files,
reports, machine-specific paths, and Git author/committer metadata, unless I
explicitly ask to skip this pre-push review for that push. Keep local
plans, credentials, auth databases, worlds, raw run evidence, and generated
artifacts out of the publication; include reports only after reviewing their
contents as intentionally public. As part of this review, inspect the staged
diff and run a secret scanner; `.gitignore` and a clean scan alone are not
sufficient. Repeat the review if the publication changes. Resolve confirmed
findings before pushing; if safe publication is uncertain, stop and report the
blocker without exposing the sensitive data or rewriting shared history.

Delivery is complete only after the push succeeds, including any required Git
LFS uploads. Report the branch, commit hash, and push result. If publication is
blocked, state the blocker and that the changes remain local; a local commit
alone does not make the work available to teammates.
