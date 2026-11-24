# Repository instructions

## Before gameplay changes

Read [the behavior contract](docs/survival/behavior.md) for product goals,
control ownership, perception, uncertainty and gameplay acceptance.

## Evidence

Keep a small real-model end-to-end slice on the critical path. Verify the ordinary
default control path and its natural transitions, not an easier alternate driver,
special prompt, fixture or evaluator-assisted substitute. Declare differences.
Continuous input is not purposeful progress; smoothing alone is not natural aim.
Natural waits need no substitute motion. User-reported defects are ground truth.

Lead status with the observed gameplay outcome and what remains failed or
unproven. Reserve time for a representative run, inspection and user feedback.
Before model runs, continuation, review or artifact cleanup, read
[model-run and evidence rules](docs/development/model-runs.md).

## Documentation and privacy

- Repository documentation is English; GitHub issue descriptions are Russian.
- Before Markdown edits other than this file, apply `sepia`; for `README.md`,
  also apply `crafting-effective-readmes`. Local untracked Markdown is exempt.
- Before agent-instruction edits, apply `writing-for-agents`; `sepia` is not
  required for `AGENTS.md`. Before issue titles/descriptions, apply `sepia`.
- Start at [docs/index.md](docs/index.md); load only the relevant topic.
  Before adding, moving or expanding docs, follow the
  [documentation maintenance rules](docs/development/documentation.md).
  Keep each fact once; split by reader task instead of growing monoliths.
- Keep README to purpose, prerequisites, installation, launch and guide links.
  Put walkthroughs and lifecycle/feature details in focused guides.
- Private plans, team/course details, credentials, worlds and raw run evidence
  stay locally excluded. Public docs must not expose or link private storage;
  local exclusions do not sanitize tracked files or archives.

## Tools and integration
Install the tools best suited to the task without asking; prefer local or
temporary installs. Report tracked dependency/configuration changes.
At verified logical checkpoints, make focused local commits, preserving unrelated
work. Before committing, integrating or pushing, read
[publication rules](docs/development/publication.md).
