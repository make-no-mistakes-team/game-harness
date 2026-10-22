import type { PolicyView } from "../../src/shared/contracts.ts";

export type PolicyIdentity = Pick<PolicyView, "policy_id" | "version" | "hash">;

export type StringField =
  | "name"
  | "card.purpose"
  | "card.applicability"
  | "card.method"
  | "card.reason"
  | "card.limitations";

export type FieldChange =
  | { field: StringField; before: string; after: string }
  | { field: "priority" | "interval_ms"; before: number; after: number };

export type SourceHunk = {
  before_start_line: number;
  after_start_line: number;
  removed_lines: string[];
  added_lines: string[];
};

export type PolicyComparisonResult =
  | { ok: false; error: "different_policy" | "source_too_large" }
  | {
      ok: true;
      before: PolicyIdentity;
      after: PolicyIdentity;
      source_changed: boolean;
      field_changes: FieldChange[];
      source_hunks: SourceHunk[];
    };

const MAX_SOURCE_BYTES = 32_768;

function identity(policy: PolicyView): PolicyIdentity {
  return {
    policy_id: policy.policy_id,
    version: policy.version,
    hash: policy.hash,
  };
}

function sourceHunks(before: string, after: string): SourceHunk[] {
  if (before === after) return [];

  // Keep each LF with its line, including CRLF, without a trailing empty line.
  const beforeLines = before.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const afterLines = after.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix++;
  }

  let beforeEnd = beforeLines.length;
  let afterEnd = afterLines.length;
  // The suffix can only consume lines left after removing the prefix.
  while (
    beforeEnd > prefix &&
    afterEnd > prefix &&
    beforeLines[beforeEnd - 1] === afterLines[afterEnd - 1]
  ) {
    beforeEnd--;
    afterEnd--;
  }

  return [
    {
      before_start_line: prefix + 1,
      after_start_line: prefix + 1,
      removed_lines: beforeLines.slice(prefix, beforeEnd),
      added_lines: afterLines.slice(prefix, afterEnd),
    },
  ];
}

/** Compare caller-resolved policy versions without fetching or executing source. */
export function comparePolicyVersions(
  before: PolicyView,
  after: PolicyView,
): PolicyComparisonResult {
  if (before.policy_id !== after.policy_id) {
    return { ok: false, error: "different_policy" };
  }

  const encoder = new TextEncoder();
  if (
    encoder.encode(before.source).byteLength > MAX_SOURCE_BYTES ||
    encoder.encode(after.source).byteLength > MAX_SOURCE_BYTES
  ) {
    return { ok: false, error: "source_too_large" };
  }

  const field_changes: FieldChange[] = [];
  if (before.name !== after.name) {
    field_changes.push({
      field: "name",
      before: before.name,
      after: after.name,
    });
  }
  for (const field of ["priority", "interval_ms"] as const) {
    if (before[field] !== after[field]) {
      field_changes.push({ field, before: before[field], after: after[field] });
    }
  }
  for (const field of [
    "purpose",
    "applicability",
    "method",
    "reason",
    "limitations",
  ] as const) {
    if (before.card[field] !== after.card[field]) {
      field_changes.push({
        field: `card.${field}`,
        before: before.card[field],
        after: after.card[field],
      });
    }
  }

  return {
    ok: true,
    before: identity(before),
    after: identity(after),
    source_changed: before.source !== after.source,
    field_changes,
    source_hunks: sourceHunks(before.source, after.source),
  };
}
