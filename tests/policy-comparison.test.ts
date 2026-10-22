import { describe, expect, test } from "bun:test";
import type { PolicyView } from "../src/shared/contracts.ts";
import {
  comparePolicyVersions,
  type FieldChange,
  type PolicyComparisonResult,
  type SourceHunk,
} from "../web/src/policy-comparison.ts";

function policy(overrides: Partial<PolicyView> = {}): PolicyView {
  return {
    policy_id: "gather-wood",
    version: 1,
    hash: "before-hash",
    name: "Gather wood",
    source: "return { kind: 'continue' };\n",
    card: {
      purpose: "Collect wood",
      applicability: "Near a tree",
      method: "Dig logs",
      reason: "Supply crafting materials",
      limitations: "Requires a reachable tree",
    },
    priority: 10,
    interval_ms: 200,
    state: "active",
    evaluations: 3,
    effects: 1,
    last_error: null,
    ...overrides,
  };
}

function nextPolicy(overrides: Partial<PolicyView> = {}): PolicyView {
  return policy({ version: 2, hash: "after-hash", ...overrides });
}

type Success = Extract<PolicyComparisonResult, { ok: true }>;

function success(overrides: Partial<Success> = {}): Success {
  return {
    ok: true,
    before: {
      policy_id: "gather-wood",
      version: 1,
      hash: "before-hash",
    },
    after: {
      policy_id: "gather-wood",
      version: 2,
      hash: "after-hash",
    },
    source_changed: false,
    field_changes: [],
    source_hunks: [],
    ...overrides,
  };
}

describe("policy fields and identities", () => {
  test("ignores runtime state, counters, errors, and identity changes", () => {
    expect(
      comparePolicyVersions(
        policy(),
        nextPolicy({
          state: "quarantined",
          evaluations: 999,
          effects: 42,
          last_error: "Execution failed",
        }),
      ),
    ).toEqual(success());
  });

  test("accepts equal versions and identical objects", () => {
    const before = policy();
    expect(comparePolicyVersions(before, before)).toEqual(
      success({ after: success().before }),
    );
  });

  test("compares content even when version numbers match", () => {
    expect(
      comparePolicyVersions(
        policy(),
        nextPolicy({ version: 1, name: "Gather oak wood" }),
      ),
    ).toEqual(
      success({
        after: { ...success().after, version: 1 },
        field_changes: [
          { field: "name", before: "Gather wood", after: "Gather oak wood" },
        ],
      }),
    );
  });

  test("preserves caller order when versions decrease", () => {
    expect(comparePolicyVersions(nextPolicy(), policy())).toEqual(
      success({ before: success().after, after: success().before }),
    );
  });

  test("returns all changed fields in the specified order", () => {
    const before = policy();
    const after = nextPolicy({
      name: " Gather wood ",
      priority: 0,
      interval_ms: 400,
      card: {
        purpose: "Collect oak wood",
        applicability: "Near an oak tree",
        method: "Dig oak logs",
        reason: "Build a shelter",
        limitations: "Requires an oak tree",
      },
    });
    expect(comparePolicyVersions(before, after)).toEqual(
      success({
        field_changes: [
          { field: "name", before: "Gather wood", after: " Gather wood " },
          { field: "priority", before: 10, after: 0 },
          { field: "interval_ms", before: 200, after: 400 },
          {
            field: "card.purpose",
            before: "Collect wood",
            after: "Collect oak wood",
          },
          {
            field: "card.applicability",
            before: "Near a tree",
            after: "Near an oak tree",
          },
          { field: "card.method", before: "Dig logs", after: "Dig oak logs" },
          {
            field: "card.reason",
            before: "Supply crafting materials",
            after: "Build a shelter",
          },
          {
            field: "card.limitations",
            before: "Requires a reachable tree",
            after: "Requires an oak tree",
          },
        ],
      }),
    );
  });

  const fieldCases: {
    name: string;
    overrides: Partial<PolicyView>;
    change: FieldChange;
  }[] = [
    {
      name: "name",
      overrides: { name: "" },
      change: { field: "name", before: "Gather wood", after: "" },
    },
    {
      name: "priority",
      overrides: { priority: -1 },
      change: { field: "priority", before: 10, after: -1 },
    },
    {
      name: "interval_ms",
      overrides: { interval_ms: 500 },
      change: { field: "interval_ms", before: 200, after: 500 },
    },
    ...(
      ["purpose", "applicability", "method", "reason", "limitations"] as const
    ).map((field) => ({
      name: `card.${field}`,
      overrides: {
        card: { ...policy().card, [field]: `${policy().card[field]} ` },
      },
      change: {
        field: `card.${field}` as const,
        before: policy().card[field],
        after: `${policy().card[field]} `,
      },
    })),
  ];

  test.each(fieldCases)(
    "includes only the changed $name field without normalization",
    ({ overrides, change }) => {
      expect(comparePolicyVersions(policy(), nextPolicy(overrides))).toEqual(
        success({ field_changes: [change] }),
      );
    },
  );

  test("keeps card and interval changes in order when other fields are unchanged", () => {
    expect(
      comparePolicyVersions(
        policy(),
        nextPolicy({
          interval_ms: 300,
          card: { ...policy().card, purpose: "", reason: "Different reason" },
        }),
      ),
    ).toEqual(
      success({
        field_changes: [
          { field: "interval_ms", before: 200, after: 300 },
          { field: "card.purpose", before: "Collect wood", after: "" },
          {
            field: "card.reason",
            before: "Supply crafting materials",
            after: "Different reason",
          },
        ],
      }),
    );
  });
});

describe("source replacement hunks", () => {
  const cases: {
    name: string;
    before: string;
    after: string;
    hunk: SourceHunk;
  }[] = [
    {
      name: "insertion in the middle",
      before: "a\nb\n",
      after: "a\nx\nb\n",
      hunk: {
        before_start_line: 2,
        after_start_line: 2,
        removed_lines: [],
        added_lines: ["x\n"],
      },
    },
    {
      name: "deletion in the middle",
      before: "a\nx\nb\n",
      after: "a\nb\n",
      hunk: {
        before_start_line: 2,
        after_start_line: 2,
        removed_lines: ["x\n"],
        added_lines: [],
      },
    },
    {
      name: "insertion at the start",
      before: "a\nb\n",
      after: "x\na\nb\n",
      hunk: {
        before_start_line: 1,
        after_start_line: 1,
        removed_lines: [],
        added_lines: ["x\n"],
      },
    },
    {
      name: "insertion after the last line",
      before: "a\nb\n",
      after: "a\nb\nx",
      hunk: {
        before_start_line: 3,
        after_start_line: 3,
        removed_lines: [],
        added_lines: ["x"],
      },
    },
    {
      name: "deletion at the start",
      before: "x\na\nb\n",
      after: "a\nb\n",
      hunk: {
        before_start_line: 1,
        after_start_line: 1,
        removed_lines: ["x\n"],
        added_lines: [],
      },
    },
    {
      name: "deletion at the end",
      before: "a\nb\nx",
      after: "a\nb\n",
      hunk: {
        before_start_line: 3,
        after_start_line: 3,
        removed_lines: ["x"],
        added_lines: [],
      },
    },
    {
      name: "complete replacement",
      before: "a\nb",
      after: "x\ny\n",
      hunk: {
        before_start_line: 1,
        after_start_line: 1,
        removed_lines: ["a\n", "b"],
        added_lines: ["x\n", "y\n"],
      },
    },
    {
      name: "empty before",
      before: "",
      after: "a\nb\n",
      hunk: {
        before_start_line: 1,
        after_start_line: 1,
        removed_lines: [],
        added_lines: ["a\n", "b\n"],
      },
    },
    {
      name: "empty after",
      before: "a\nb\n",
      after: "",
      hunk: {
        before_start_line: 1,
        after_start_line: 1,
        removed_lines: ["a\n", "b\n"],
        added_lines: [],
      },
    },
    {
      name: "trailing newline added",
      before: "a",
      after: "a\n",
      hunk: {
        before_start_line: 1,
        after_start_line: 1,
        removed_lines: ["a"],
        added_lines: ["a\n"],
      },
    },
    {
      name: "trailing newline removed",
      before: "a\n",
      after: "a",
      hunk: {
        before_start_line: 1,
        after_start_line: 1,
        removed_lines: ["a\n"],
        added_lines: ["a"],
      },
    },
    {
      name: "LF to CRLF",
      before: "a\nb\n",
      after: "a\r\nb\r\n",
      hunk: {
        before_start_line: 1,
        after_start_line: 1,
        removed_lines: ["a\n", "b\n"],
        added_lines: ["a\r\n", "b\r\n"],
      },
    },
    {
      name: "CRLF to LF",
      before: "a\r\n",
      after: "a\n",
      hunk: {
        before_start_line: 1,
        after_start_line: 1,
        removed_lines: ["a\r\n"],
        added_lines: ["a\n"],
      },
    },
    {
      name: "standalone CR is not a separator",
      before: "a\rb\nend",
      after: "a\rX\nend",
      hunk: {
        before_start_line: 1,
        after_start_line: 1,
        removed_lines: ["a\rb\n"],
        added_lines: ["a\rX\n"],
      },
    },
    {
      name: "empty versus a blank line",
      before: "",
      after: "\n",
      hunk: {
        before_start_line: 1,
        after_start_line: 1,
        removed_lines: [],
        added_lines: ["\n"],
      },
    },
    {
      name: "blank line versus empty",
      before: "\n",
      after: "",
      hunk: {
        before_start_line: 1,
        after_start_line: 1,
        removed_lines: ["\n"],
        added_lines: [],
      },
    },
    {
      name: "repeated lines do not overlap the prefix on deletion",
      before: "a\na\n",
      after: "a\n",
      hunk: {
        before_start_line: 2,
        after_start_line: 2,
        removed_lines: ["a\n"],
        added_lines: [],
      },
    },
    {
      name: "repeated lines do not overlap the prefix on insertion",
      before: "a\n",
      after: "a\na\n",
      hunk: {
        before_start_line: 2,
        after_start_line: 2,
        removed_lines: [],
        added_lines: ["a\n"],
      },
    },
    {
      name: "repeated suffix is trimmed only after the prefix",
      before: "a\nx\na\n",
      after: "a\na\n",
      hunk: {
        before_start_line: 2,
        after_start_line: 2,
        removed_lines: ["x\n"],
        added_lines: [],
      },
    },
    {
      name: "separated changes include unchanged interior lines",
      before: "start\na\nkeep\nb\nend\n",
      after: "start\nx\nkeep\ny\nend\n",
      hunk: {
        before_start_line: 2,
        after_start_line: 2,
        removed_lines: ["a\n", "keep\n", "b\n"],
        added_lines: ["x\n", "keep\n", "y\n"],
      },
    },
  ];

  test.each(cases)("$name", ({ before, after, hunk }) => {
    expect(
      comparePolicyVersions(
        policy({ source: before }),
        nextPolicy({ source: after }),
      ),
    ).toEqual(success({ source_changed: true, source_hunks: [hunk] }));
  });

  test.each(["", "\n", "a", "a\n", "a\r\nb\r", "a\na\n"])(
    "equal sources produce no hunk: %j",
    (source) => {
      expect(
        comparePolicyVersions(policy({ source }), nextPolicy({ source })),
      ).toEqual(success());
    },
  );

  test("equal hashes cannot hide different source strings", () => {
    expect(
      comparePolicyVersions(
        policy({ source: "a" }),
        nextPolicy({ source: "b", hash: "before-hash" }),
      ),
    ).toEqual(
      success({
        after: { ...success().after, hash: "before-hash" },
        source_changed: true,
        source_hunks: [
          {
            before_start_line: 1,
            after_start_line: 1,
            removed_lines: ["a"],
            added_lines: ["b"],
          },
        ],
      }),
    );
  });
});

describe("comparison errors and UTF-8 limits", () => {
  test.each(["Gather-wood", "gather-wood ", "other-policy"])(
    "requires an exact policy ID match: %j",
    (policy_id) => {
      expect(
        comparePolicyVersions(policy(), nextPolicy({ policy_id })),
      ).toEqual({ ok: false, error: "different_policy" });
    },
  );

  test.each(["before", "after", "both"])(
    "different_policy takes priority over oversized %s source",
    (side) => {
      const oversized = "a".repeat(32_769);
      expect(
        comparePolicyVersions(
          policy({ source: side === "after" ? "" : oversized }),
          nextPolicy({
            policy_id: "other-policy",
            source: side === "before" ? "" : oversized,
          }),
        ),
      ).toEqual({ ok: false, error: "different_policy" });
    },
  );

  const byteCases = [
    { name: "ASCII", source: "a".repeat(32_768) },
    { name: "two-byte characters", source: "я".repeat(16_384) },
    { name: "three-byte characters", source: "界".repeat(10_922) + "aa" },
    { name: "four-byte characters", source: "🙂".repeat(8_192) },
    {
      name: "unpaired UTF-16 surrogates",
      source: "\ud800".repeat(10_922) + "aa",
    },
  ];

  for (const side of ["before", "after"] as const) {
    test.each(byteCases)(
      `accepts exactly 32,768 UTF-8 bytes on ${side}: $name`,
      ({ source }) => {
        expect(new TextEncoder().encode(source).byteLength).toBe(32_768);
        expect(
          comparePolicyVersions(
            policy({ source: side === "before" ? source : "" }),
            nextPolicy({ source: side === "after" ? source : "" }),
          ),
        ).toEqual(
          success({
            source_changed: true,
            source_hunks: [
              {
                before_start_line: 1,
                after_start_line: 1,
                removed_lines: side === "before" ? [source] : [],
                added_lines: side === "after" ? [source] : [],
              },
            ],
          }),
        );
      },
    );

    test.each(byteCases)(
      `rejects 32,769 UTF-8 bytes on ${side}: $name`,
      ({ source }) => {
        const oversized = source + "a";
        expect(new TextEncoder().encode(oversized).byteLength).toBe(32_769);
        expect(
          comparePolicyVersions(
            policy({ source: side === "before" ? oversized : "" }),
            nextPolicy({ source: side === "after" ? oversized : "" }),
          ),
        ).toEqual({ ok: false, error: "source_too_large" });
      },
    );
  }

  test("rejects equal oversized sources even if their hashes match", () => {
    const before = policy({ source: "a".repeat(32_769) });
    expect(comparePolicyVersions(before, before)).toEqual({
      ok: false,
      error: "source_too_large",
    });
  });
});

test("comparison is deterministic, leaves frozen inputs unchanged, and preserves HTML as data", () => {
  const oldHtml = '<script>alert("before")</script>\n';
  const newHtml = '<img src=x onerror="alert(1)">\n';
  const before = policy({
    name: oldHtml,
    source: oldHtml,
    card: { ...policy().card, method: oldHtml },
  });
  const after = nextPolicy({
    name: newHtml,
    source: newHtml,
    card: { ...policy().card, method: newHtml },
  });
  const originalBefore = structuredClone(before);
  const originalAfter = structuredClone(after);
  Object.freeze(before.card);
  Object.freeze(before);
  Object.freeze(after.card);
  Object.freeze(after);

  const expected = success({
    source_changed: true,
    field_changes: [
      { field: "name", before: oldHtml, after: newHtml },
      { field: "card.method", before: oldHtml, after: newHtml },
    ],
    source_hunks: [
      {
        before_start_line: 1,
        after_start_line: 1,
        removed_lines: [oldHtml],
        added_lines: [newHtml],
      },
    ],
  });
  expect(comparePolicyVersions(before, after)).toEqual(expected);
  expect(comparePolicyVersions(before, after)).toEqual(expected);
  expect(before).toEqual(originalBefore);
  expect(after).toEqual(originalAfter);
});
