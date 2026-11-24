# Commits and publication

Read before committing, integrating or pushing.

## Local checkpoints

During substantial implementation, commit each independent feature/fix or logical
checkpoint after its relevant checks pass, before accumulating unrelated work.
Select only intended changes; keep private material excluded. Local checkpoint
commits, including on `main`, need no separate approval and do not authorize push.

An explicit request to commit to `main` or integrate into `main` includes pushing
to `origin/main`, unless the user requests local-only operation.

## Linear integration

Keep `main` linear and preserve individual commits. Prefer fast-forward, retaining
hashes. For diverged feature/PR branches, rebase-and-merge or rebase on a temporary
integration branch is allowed without separate approval; preserve authorship and
commit boundaries. Changed hashes are acceptable. Merge commits and squash
require explicit user request.

Before integrating or pushing, fetch `origin/main` and check the final result
against it. Never rewrite or force-push published `main`. Ask if local `main`
has diverged from `origin/main`, or rebase conflicts leave intended behavior
unclear. Check the open PR's base/status reflects integration.

## Immediately before every push

Unless the user explicitly waives this review for that push:

1. Inspect the exact outgoing commit tree, every outgoing commit diff and any
   staged diff, including newly added files.
2. Review private files, secrets, personal information, reports, machine-specific
   paths and author/committer metadata.
3. Run a secret scanner. A clean scan and ignore rules alone are insufficient.
4. Resolve confirmed findings. If safe publication remains uncertain, stop and
   report the blocker without exposing sensitive data or rewriting shared history.

Repeat the review if the publication changes. Local plans, credentials, auth
databases, worlds, raw run evidence and generated artifacts stay unpublished.
Include reports only after intentional public-content review.
