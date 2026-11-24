# Documentation

Read one route, not the entire tree.

## Run and improve Survival

- [Setup](setup.md): prerequisites, game access, build and host configuration.
- [Play](survival/play.md): ordinary local play with optional Terra strategy.
- [Behavior](survival/behavior.md): purposeful rhythm, motion, survival and goals.
- [Recovery](survival/recovery.md): stopping, clean continuation and autosaves.
- [Diagnostics](survival/diagnostics.md): prepared trials and their claim limits.
- [Survival evidence](evidence/survival.md): observed outcomes and user feedback.

## Understand the systems

The ordinary Survival Agent uses a developer-written local player. The separate
general harness runs model-authored programs. Their authorship requirements,
control paths and perception profiles are not interchangeable.

- [Architecture](reference/architecture.md): ownership and entry points.
- [Lifecycle](reference/lifecycle.md): session/run/life, fences and closure.
- [Survival perception](survival/perception.md): optical sight and terrain hypotheses.
- [Generic adapter perception](reference/perception.md): the separate harness profile.
- [Security](reference/security.md): isolation, credentials and private data.
- [Providers](reference/providers.md): authentication, request ownership and usage.
- [Programs](reference/programs.md): the general harness's execution interface.

## Evaluate or investigate history

- [Evaluation policy](evaluation/policy.md) and [measurement](evaluation/measurement.md).
- Frozen protocols: [E01](evaluation/e01.md), [P13](evaluation/p13.md),
  [released reference](evaluation/released-reference.md).
- [Research scope](product/research.md) and [requirements](product/requirements.md)
  describe the general harness; they are not a competing ordinary-player design.
- [Pinned upstream packages](upstream/packages.md) and [licenses](upstream/licenses.md).
- [Evidence navigation](reference/evidence.md): historical results grouped by
  subject, separate from current instructions and fresh-world competence.

## Development rules

- Before adding or expanding docs: [documentation maintenance](development/documentation.md).
- Before model runs, review or cleanup: [model runs and evidence](development/model-runs.md).
- Before commits or publication: [publication](development/publication.md).

Source types, validators and command help own field catalogues. Guides explain
invariants and procedures; add historical outcomes to evidence, not contracts.
