## Documentation and GitHub issues

- Write all repository documentation in English.
- When creating or editing GitHub issues, write their descriptions in Russian.
- Before creating or editing Markdown documentation other than `AGENTS.md`,
  read and apply the `sepia` skill.
- For `README.md`, also read and apply `crafting-effective-readmes`.
- These skill requirements are optional for Markdown files kept local and untracked.
- Before writing or editing GitHub issue titles or descriptions, read and apply `sepia`.
- Before editing agent instruction files, read and apply `writing-for-agents`.
  For `AGENTS.md`, this is the only required writing skill; `sepia` is not required.
- Keep useful instructions, requirements, and verified facts; remove repetition and material that does not help the reader.

### README scope

- Keep `README.md` a concise product entry point: purpose, essential prerequisites,
  installation and launch commands, and documentation links. Put interface
  walkthroughs, button behavior, lifecycle explanations, feature inventories, and
  behavior users can discover in the app in detailed guides or in-app help.
  Retain setup and safety instructions needed before the app can be used.
  Omit development progress, unfinished-feature lists, prototype history, and
  passed or unpassed MVP/release milestones.

### Private material

- Keep private plans, team/course details, credentials, worlds, and run evidence
  under locally excluded storage. Public documentation must not expose or link
  to `local/`. A checkout-local Git exclusion does not sanitize archives or
  already tracked files.

## Gameplay delivery

The product goal is purposeful, human-like play driven by model-authored
behavior. Infrastructure milestones support that outcome; they do not replace it.

- Keep a small end-to-end gameplay slice on the critical path. Within authorized
  budgets and working safety boundaries, exercise it with a real model early,
  before expanding supporting work. Escalate conflicting prerequisites rather
  than silently bypassing gates or indefinitely postponing product feedback.
- Verify the control path the model actually uses. A smooth alternate driver,
  synthetic fixture, special prompt or evaluator assistance does not establish
  the ordinary default experience. Declare those differences.
- Check natural control transitions on that actual path. A high-frequency
  stream can still snap between targets; continuous activity can still be
  ineffective. Neither is a substitute for the requested gameplay quality.
- Lead status reports with the observed user-facing outcome and what remains
  failed or unproven. Under a deadline, reserve time for a representative run,
  inspection, user review and handoff; report a missing demonstration early
  instead of substituting more infrastructure or an easier task.

## Model-run authorization

The user grants standing permission for development and gameplay runs with
`gpt-6-luna`; no per-run approval is needed. Use it for early real-model feedback,
not only for last-minute demonstrations. For more expensive SOTA models,
normally ask first unless the current request already authorizes their use.

This permission does not override safety, finite run budgets, frozen experiment
protocols or manual-review pauses. It does not permit silently substituting
Luna for a different model in a declared experiment.

## Manual gameplay review

After changes likely to noticeably affect how the agent plays, show
representative gameplay and explicitly ask the user for manual visual review.
Pause development, including subagent work, until the user gives feedback on
that gameplay.

Inspect the actual rendered behavior at original speed before presenting it.
Playback completion and sampled screenshots are not a visual-quality verdict.
If available tools cannot support that assessment, state the limitation rather
than claiming a visual review.
Identify obvious defects yourself; label failed footage honestly rather than
presenting it as improved gameplay for the user to discover the problem.

Small changes may be grouped to avoid frequent pauses. Briefly track gameplay
changes since the last review and request another review when their combined
effect could become noticeable to an ordinary user.

Tests, metrics, code volume and your own inspection are supporting evidence,
not proof that gameplay improved. The user's visual judgment is decisive.

## Tooling and dependencies

Choose tools and programming languages based on what best serves the task, not
on what is already installed. If a better implementation, investigation, or
verification requires additional software, install it as part of the work
without asking permission. This includes tools, applications, programming
languages, runtimes, SDKs, libraries, and build or test dependencies.

Prefer project-local, temporary, or virtual-environment installs when practical;
use system-wide installation when needed. Report changes to tracked lockfiles,
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
