import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { parse, version as acornVersion } from "acorn";
import { format, version as prettierVersion } from "prettier";
import { z } from "zod";
import type { SkillLimits, SkillSpec, SkillView } from "../shared/programs.ts";
import { MAX_SKILL_LIMITS, SKILL_API_VERSION } from "../shared/programs.ts";
import type { AdapterDescriptor, AdapterSchemaCatalog } from "../shared/contracts.ts";
import { adapterCompatibility, contractHash, executableContractStamp } from "./adapter-contract.ts";

export interface ExecutableValidationContext {
  descriptor: AdapterDescriptor;
  schemas: AdapterSchemaCatalog;
}

export const PROGRAM_LIMITS = Object.freeze({
  source_bytes: 16384,
  dependencies: 32,
});

export interface ProgramValidationIssue {
  code: string;
  message: string;
  location: { line: number; column: number } | null;
  limit: { maximum: number; actual: number } | null;
  path?: string;
}

export class ProgramValidationError extends Error {
  readonly issues: readonly ProgramValidationIssue[];

  constructor(issues: ProgramValidationIssue[]) {
    super("Program validation failed.");
    this.name = "ProgramValidationError";
    this.issues = issues;
  }
}

export interface ValidatedProgramSource {
  source: string;
  hash: string;
  validation: SkillView["validation"];
}

const text = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value.trim().length > 0);
const skillRefSchema = z
  .object({
    skill_id: text(160),
    version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
const skillSchema: z.ZodType<SkillSpec> = z
  .object({
    name: text(80),
    source: z.string(),
    card: z
      .object({
        purpose: text(1000),
        applicability: text(1000),
        method: text(2000),
        reason: text(1000),
        limitations: text(1000),
      })
      .strict(),
    dependencies: z.array(skillRefSchema).max(PROGRAM_LIMITS.dependencies),
  })
  .strict();
const limitsSchema: z.ZodType<SkillLimits> = z
  .object({
    duration_ms: z.number().int().min(1).max(MAX_SKILL_LIMITS.duration_ms),
    max_actions: z.number().int().min(1).max(MAX_SKILL_LIMITS.max_actions),
    max_calls: z.number().int().min(1).max(MAX_SKILL_LIMITS.max_calls),
    max_depth: z.number().int().min(1).max(MAX_SKILL_LIMITS.max_depth),
  })
  .strict();

const forbiddenAmbient = new Set([
  "globalThis",
  "global",
  "window",
  "self",
  "document",
  "navigator",
  "location",
  "process",
  "require",
  "module",
  "exports",
  "Buffer",
  "Deno",
  "Bun",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "Worker",
  "SharedWorker",
  "importScripts",
  "Function",
  "eval",
  "WebAssembly",
  "SharedArrayBuffer",
  "Atomics",
  "setTimeout",
  "setInterval",
  "setImmediate",
  "clearTimeout",
  "clearInterval",
  "clearImmediate",
  "queueMicrotask",
  "console",
  "arguments",
]);
const forbiddenSyntax: Record<string, true> = {
  ImportDeclaration: true,
  ImportExpression: true,
  ExportNamedDeclaration: true,
  ExportDefaultDeclaration: true,
  ExportAllDeclaration: true,
  MetaProperty: true,
  ThisExpression: true,
  WithStatement: true,
  DebuggerStatement: true,
};
const functionTypes: Record<string, true> = {
  FunctionDeclaration: true,
  FunctionExpression: true,
  ArrowFunctionExpression: true,
};
const nestedStatements: Record<string, true> = {
  IfStatement: true,
  ForStatement: true,
  ForInStatement: true,
  ForOfStatement: true,
  WhileStatement: true,
  DoWhileStatement: true,
  SwitchStatement: true,
  TryStatement: true,
  WithStatement: true,
};
const formatterOptions = {
  parser: "babel",
  embeddedLanguageFormatting: "off" as const,
  printWidth: 80,
  tabWidth: 2,
  useTabs: false,
  semi: true,
  singleQuote: false,
  trailingComma: "all" as const,
  endOfLine: "lf" as const,
  bracketSpacing: true,
  quoteProps: "as-needed" as const,
  arrowParens: "always" as const,
};

interface SyntaxNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}
function isNode(value: unknown): value is SyntaxNode {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string" &&
    "start" in value &&
    typeof value.start === "number" &&
    "end" in value &&
    typeof value.end === "number"
  );
}
function nodes(value: unknown): SyntaxNode[] {
  return Array.isArray(value) ? value.filter(isNode) : [];
}
function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function issue(
  code: string,
  message: string,
  location: ProgramValidationIssue["location"] = null,
  limit: ProgramValidationIssue["limit"] = null,
): ProgramValidationIssue {
  return { code, message, location, limit };
}
function metadataIssues(error: z.ZodError): ProgramValidationIssue[] {
  return error.issues.map((entry) => ({
    ...issue("invalid_metadata", "Invalid or unsupported program metadata."),
    path: entry.path.map(String).join("."),
  }));
}

export function validateSkillLimits(value: unknown): SkillLimits {
  const parsed = limitsSchema.safeParse(value);
  if (!parsed.success)
    throw new ProgramValidationError(metadataIssues(parsed.error));
  return parsed.data;
}

function identifierIsReference(
  node: SyntaxNode,
  parent: SyntaxNode | null,
  key: string,
): boolean {
  if (!parent) return true;
  if (
    (parent.type === "MemberExpression" ||
      parent.type === "PropertyDefinition" ||
      parent.type === "MethodDefinition") &&
    key === "property" &&
    !parent.computed
  )
    return false;
  if (
    (parent.type === "Property" ||
      parent.type === "MethodDefinition" ||
      parent.type === "PropertyDefinition") &&
    key === "key" &&
    !parent.computed
  ) {
    return parent.shorthand === true;
  }
  if (
    (parent.type === "LabeledStatement" ||
      parent.type === "BreakStatement" ||
      parent.type === "ContinueStatement") &&
    key === "label"
  )
    return false;
  if (
    key === "id" &&
    (parent.type === "VariableDeclarator" ||
      functionTypes[parent.type] ||
      parent.type === "ClassDeclaration" ||
      parent.type === "ClassExpression")
  )
    return false;
  return node.type === "Identifier";
}

function parseBody(source: string, kind: "skill" | "policy" | "guard") {
  const parameters = kind === "skill" ? "game, args" : kind === "guard" ? "observation, args" : "context, state";
  const prefix = `async function __gameharness_program(${parameters}) {\n"use strict";\n`;
  const wrapped = `${prefix}${source}\n}\n`;
  const legacyComments: Array<{ start: number; length: number }> = [];
  const locate = (position: number) => {
    const before = source.slice(
      0,
      Math.max(0, Math.min(source.length, position - prefix.length)),
    );
    const lines = before.split("\n");
    return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
  };
  let ast: SyntaxNode;
  try {
    ast = parse(wrapped, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowImportExportEverywhere: true,
      onComment: (block, _text, start) => {
        if (block || wrapped.startsWith("//", start)) return;
        legacyComments.push({ start, length: wrapped.startsWith("<!--", start) ? 4 : 3 });
      },
    }) as unknown as SyntaxNode;
  } catch (error) {
    const position =
      typeof error === "object" &&
      error !== null &&
      "pos" in error &&
      typeof error.pos === "number"
        ? error.pos
        : prefix.length;
    throw new ProgramValidationError([
      issue(
        "invalid_syntax",
        "Source must be a valid asynchronous JavaScript function body.",
        locate(position),
      ),
    ]);
  }
  const top = nodes(ast.body);
  const fn = top[0];
  if (
    top.length !== 1 ||
    !fn ||
    fn.type !== "FunctionDeclaration" ||
    fn.end !== wrapped.length - 1 ||
    !isNode(fn.body)
  ) {
    throw new ProgramValidationError([
      issue(
        "invalid_syntax",
        "Source must remain inside the program function body.",
      ),
    ]);
  }
  // Acorn admits script-only HTML line comments. Give the formatter ordinary
  // line-comment markers, using parser ranges so literal text is untouched.
  // Keep marker widths and line terminators, including the wrapper's final
  // newline: a trailing line comment must never swallow the closing brace.
  let formatterSource = wrapped;
  if (legacyComments.length) {
    const parts: string[] = [];
    let cursor = 0;
    for (const comment of legacyComments) {
      parts.push(wrapped.slice(cursor, comment.start), "//", " ".repeat(comment.length - 2));
      cursor = comment.start + comment.length;
    }
    parts.push(wrapped.slice(cursor));
    formatterSource = parts.join("");
  }
  return { fn, body: fn.body, formatterSource, locate };
}

function analyze(source: string, kind: "skill" | "policy" | "guard") {
  const parsed = parseBody(source, kind);
  const issues: ProgramValidationIssue[] = [];
  let maximumComplexity = 1;
  let maximumNesting = 0;
  const visit = (
    node: SyntaxNode,
    parent: SyntaxNode | null,
    key: string,
    nesting: number,
    complexity: { value: number },
  ) => {
    if (functionTypes[node.type]) {
      complexity = { value: 1 };
      nesting = 0;
    }
    if (forbiddenSyntax[node.type]) {
      issues.push(
        issue(
          "forbidden_syntax",
          "Imports, exports and ambient execution syntax are not permitted.",
          parsed.locate(node.start),
        ),
      );
    }
    if (
      node.type === "Identifier" &&
      typeof node.name === "string" &&
      forbiddenAmbient.has(node.name) &&
      identifierIsReference(node, parent, key)
    ) {
      issues.push(
        issue(
          "forbidden_api",
          "Ambient host APIs are not permitted; use the program capabilities.",
          parsed.locate(node.start),
        ),
      );
    }
    const bareBlock =
      node.type === "BlockStatement" &&
      parent !== null &&
      !functionTypes[parent.type] &&
      !nestedStatements[parent.type] &&
      parent.type !== "CatchClause";
    if (nestedStatements[node.type] || bareBlock) nesting++;
    maximumNesting = Math.max(maximumNesting, nesting);
    if (
      node.type === "IfStatement" ||
      node.type === "ConditionalExpression" ||
      node.type === "LogicalExpression" ||
      node.type === "CatchClause" ||
      node.type === "ForStatement" ||
      node.type === "ForInStatement" ||
      node.type === "ForOfStatement" ||
      node.type === "WhileStatement" ||
      node.type === "DoWhileStatement" ||
      (node.type === "SwitchCase" && node.test !== null) ||
      ((node.type === "MemberExpression" || node.type === "CallExpression") &&
        node.optional === true) ||
      (node.type === "AssignmentExpression" &&
        ["&&=", "||=", "??="].includes(String(node.operator)))
    ) {
      complexity.value++;
      maximumComplexity = Math.max(maximumComplexity, complexity.value);
    }
    for (const [childKey, value] of Object.entries(node)) {
      if (isNode(value)) visit(value, node, childKey, nesting, complexity);
      else if (Array.isArray(value)) {
        for (const child of value)
          if (isNode(child)) visit(child, node, childKey, nesting, complexity);
      }
    }
  };
  try {
    visit(parsed.fn, null, "", 0, { value: 1 });
  } catch {
    throw new ProgramValidationError([
      issue("analysis_limit", "Source is too deeply nested to analyze safely."),
    ]);
  }
  if (issues.length) throw new ProgramValidationError(issues);
  return { ...parsed, complexity: maximumComplexity, nesting: maximumNesting };
}

// Static admission checks do not replace the isolated execution sandbox.
export async function validateProgramSource(
  source: unknown,
  kind: "skill" | "policy" | "guard",
  context: ExecutableValidationContext,
): Promise<ValidatedProgramSource> {
  const compatibility = adapterCompatibility(context.descriptor, context.schemas);
  if (kind !== "skill" && kind !== "policy" && kind !== "guard") {
    throw new ProgramValidationError([
      issue("invalid_kind", "Unsupported program kind."),
    ]);
  }
  if (typeof source !== "string" || !source.trim()) {
    throw new ProgramValidationError([
      issue(
        "invalid_source",
        "A nonempty JavaScript function body is required.",
      ),
    ]);
  }
  const bytes = Buffer.byteLength(source, "utf8");
  if (bytes > PROGRAM_LIMITS.source_bytes) {
    throw new ProgramValidationError([
      issue(
        "source_bytes_limit",
        "Source exceeds the UTF-8 byte limit.",
        null,
        { maximum: PROGRAM_LIMITS.source_bytes, actual: bytes },
      ),
    ]);
  }
  const analysis = analyze(source, kind);
  let canonical: string;
  try {
    const formatted = await format(analysis.formatterSource, formatterOptions);
    const formattedAst = parse(formatted, {
      ecmaVersion: "latest",
    }) as unknown as SyntaxNode;
    const formattedFunction = nodes(formattedAst.body)[0];
    const body =
      formattedFunction && isNode(formattedFunction.body)
        ? formattedFunction.body
        : null;
    const directive = body ? nodes(body.body)[0] : null;
    if (!body || !directive) throw new Error("Invalid formatted body");
    const literalRanges: Array<{ start: number; end: number }> = [];
    const pending: SyntaxNode[] = [body];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.type === "TemplateElement" || node.type === "Literal") {
        literalRanges.push({ start: node.start, end: node.end });
      }
      for (const value of Object.values(node)) {
        if (isNode(value)) pending.push(value);
        else if (Array.isArray(value)) pending.push(...value.filter(isNode));
      }
    }
    const bodyStart = directive.end + 1;
    let position = bodyStart;
    canonical =
      formatted
        .slice(bodyStart, body.end - 1)
        .replace(/\n *$/, "")
        .split("\n")
        .map((line) => {
          const insideLiteral = literalRanges.some(
            (range) => range.start <= position && position < range.end,
          );
          position += line.length + 1;
          return !insideLiteral && line.startsWith("  ") ? line.slice(2) : line;
        })
        .join("\n") + "\n";
  } catch {
    throw new ProgramValidationError([
      issue(
        "invalid_syntax",
        "Source could not be canonicalized as a JavaScript function body.",
      ),
    ]);
  }
  const lines = canonical
    .split("\n")
    .filter((line) => line.trim().length > 0).length;
  const canonicalBytes = Buffer.byteLength(canonical, "utf8");
  const issues: ProgramValidationIssue[] = [];
  if (canonicalBytes > PROGRAM_LIMITS.source_bytes) {
    issues.push(
      issue(
        "source_bytes_limit",
        "Canonical source exceeds the UTF-8 byte limit.",
        null,
        { maximum: PROGRAM_LIMITS.source_bytes, actual: canonicalBytes },
      ),
    );
  }
  if (issues.length) throw new ProgramValidationError(issues);
  const hash = digest(canonical);
  const fingerprint = programFingerprint(hash, kind, compatibility.compatibility_hash);
  return {
    source: canonical,
    hash,
    validation: {
      fingerprint,
      ...executableContractStamp(compatibility),
      formatted_lines: lines,
      complexity: analysis.complexity,
      nesting: analysis.nesting,
    },
  };
}

export async function validateSkill(
  spec: unknown,
  context: ExecutableValidationContext,
): Promise<SkillSpec & { validation: SkillView["validation"] }> {
  const parsed = skillSchema.safeParse(spec);
  if (!parsed.success)
    throw new ProgramValidationError(metadataIssues(parsed.error));
  const dependencies = new Set<string>();
  for (const dependency of parsed.data.dependencies) {
    const key = JSON.stringify([dependency.skill_id, dependency.version]);
    if (dependencies.has(key)) {
      throw new ProgramValidationError([
        {
          ...issue(
            "invalid_dependencies",
            "Dependencies must be unique exact immutable skill references.",
          ),
          path: "dependencies",
        },
      ]);
    }
    dependencies.add(key);
  }
  const program = await validateProgramSource(parsed.data.source, "skill", context);
  return {
    ...parsed.data,
    source: program.source,
    validation: program.validation,
  };
}

/** Recheck cached validation without rerunning parsing/formatting or changing immutable history. */
export function programFingerprint(hash: string, kind: "skill" | "policy" | "guard" | "jev", compatibilityHash: string, choices?: unknown): string {
  return contractHash({ validator: 4, runtime: 4, skill_api: SKILL_API_VERSION,
    comments: "permitted", structural_metrics: "descriptive_not_admission_limits", kind,
    parser: acornVersion, formatter: prettierVersion, formatterOptions, limits: PROGRAM_LIMITS,
    forbiddenAmbient: [...forbiddenAmbient], forbiddenSyntax: Object.keys(forbiddenSyntax), hash,
    compatibility_hash: compatibilityHash, ...(choices === undefined ? {} : { choices }) });
}
