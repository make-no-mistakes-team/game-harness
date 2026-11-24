# Documentation maintenance

Read before adding, moving or expanding repository documentation.

## Size and structure

- Keep `docs/index.md` a routing page, at most about **60 lines**. Readers choose
  a task; they should not need to load the whole directory.
- Aim for **150 lines and 10 KiB or less** per topic. Before a document exceeds
  **200 lines or 12 KiB**, split it at a real reader-task or contract boundary.
  Long single-line paragraphs do not evade the byte limit.
- Add a subdirectory when it groups a real subject. Prefer descriptive filenames
  over chronological appendices, numbered fragments or generic dumping grounds.
- A split must reduce what a reader needs to load. Moving an unchanged monolith
  into an archive, or making every child link to every other child, does not.

## One owner per meaning

Current operating instructions, normative contracts, future requirements and
historical evidence have distinct homes. Label implemented behavior separately
from demonstrated outcomes; keep failures and uncertainty.

Retain each rule, requirement and result once. Link its canonical topic from
other guides rather than copying paragraphs. Preserve stable requirement IDs
and frozen experiment identities/allocations when reorganizing.

Source types, validators, command help and configuration own exact field lists
and defaults. Document the invariant, procedure or non-obvious reason rather
than maintaining a second schema catalogue.

## Updating evidence

Put bounded historical results in `docs/evidence`, not running diaries in
contracts or setup guides. Record the outcome, assistance, allocation and claim
limit; do not repeat entire build logs. Raw recordings, private plans,
credentials and worlds stay outside public documentation.

Remove obsolete instructions once their replacement and callers are migrated.
Keep legacy material only when it still serves a named investigation or frozen
claim, clearly separated from current guidance.

After moving or deleting documents, repair incoming links and verify local
destinations/anchors. Apply the writing skills specified in `AGENTS.md`.
