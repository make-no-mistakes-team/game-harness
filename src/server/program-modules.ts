import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { parse } from "acorn";
import type { ExecutableModuleBundle, SkillRef, SkillView } from "../shared/programs.ts";
import { executableModuleBundleHash } from "../shared/program-modules.ts";
import { programFingerprint, ProgramValidationError } from "./program-validation.ts";
import type { Store } from "./store.ts";

export const MODULE_LIMITS = Object.freeze({ modules: 32, depth: 8, source_bytes: 65536, envelope_bytes: 262144 });
export const LOCAL_MODULE_ALIAS = /^\.\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:js|mjs)$/;
type Definition = Pick<SkillView, "entry" | "name" | "source" | "hash" | "dependencies" | "validation">;
/** Trusted immutable catalog: no run, native identity or playing authority is implied. */
export interface ProgramArtifactCatalog {
  readonly compatibility_hash: string;
  read(ref: SkillRef): SkillView;
}
type ModuleRow = ExecutableModuleBundle["modules"][number];
type Node = { type: string; [key: string]: unknown };
type Binding = { node: Node | null; identity: string };
function node(value: unknown): Node | null {
  return value !== null && typeof value === "object" && "type" in value && typeof value.type === "string" ? value as Node : null;
}
function list(value: unknown): Node[] { return Array.isArray(value) ? value.flatMap(value => { const result = node(value); return result ? [result] : []; }) : []; }
function name(value: unknown): string { const selected = node(value); return String(selected?.name ?? selected?.value ?? ""); }
function fail(code: string, message: string): never {
  throw new ProgramValidationError([{ code, message, location: null, limit: null }]);
}
function sha(source: string): string { return createHash("sha256").update(source, "utf8").digest("hex"); }

/** Evidence must compare the admitted realm, not just the root file's bytes. */
export function programExecutionHash(store: Pick<Store, "skill" | "getRun">, runId: string, ref: SkillRef): string {
  const root = store.skill(runId, ref);
  return root.entry === "step" && (root.validation.runtime_features?.length ||
    root.dependencies.some(dependency => dependency.import_path !== undefined))
    ? executableModuleBundleHash("step", resolveProgramModuleClosure(store, runId, root, undefined, "historical")) : root.hash;
}

/** Resolve only exact run-local references, never files, package names or latest versions. */
export function resolveProgramModuleClosure(store: Pick<Store, "skill" | "getRun">, runId: string, root: Definition,
  compatible?: (definition: Definition) => void, dependencyState: "validated" | "historical" = "validated"): ModuleRow[] {
  const run = store.getRun(runId);
  if (!run?.compatibility_hash) fail("invalid_modules", "Module closure requires the current run adapter profile.");
  return resolveArtifactModuleClosure({ compatibility_hash: run.compatibility_hash, read: ref => store.skill(runId, ref) },
    root, compatible, dependencyState);
}

/** Same resolver for trusted prejoin artifacts and admitted run-local artifacts. */
export function resolveArtifactModuleClosure(catalog: ProgramArtifactCatalog, root: Definition,
  compatible?: (definition: Definition) => void, dependencyState: "validated" | "historical" = "validated",
  requireActivate = false): ModuleRow[] {
  if (!catalog.compatibility_hash) fail("invalid_modules", "Module closure requires a trusted artifact profile.");
  const check = (definition: Definition) => {
    const validation = definition.validation, features = validation.runtime_features;
    if (!definition.entry || validation.runtime_version !== 5 || validation.api_version !== 5 || validation.validator_version !== 5 ||
      validation.compatibility_hash !== catalog.compatibility_hash || (features !== undefined &&
        (features.length > 1 || (features.length === 1 && features[0] !== "pure_modules_v1"))) ||
      validation.fingerprint !== programFingerprint(definition.hash, definition.entry === "run" ? "skill" : definition.entry,
        catalog.compatibility_hash, undefined, features)) fail("invalid_modules", "Module validation is incompatible with this artifact.");
    if (sha(definition.source) !== definition.hash) fail("invalid_modules", "Immutable module source hash does not match its bytes.");
    if (Buffer.byteLength(definition.source, "utf8") > 16384) fail("module_source_limit", "Module source exceeds 16 KiB.");
    if (definition.dependencies.length > 32) fail("invalid_dependencies", "A definition cannot declare more than 32 dependencies.");
    compatible?.(definition);
  };
  const rows = new Map<string, ModuleRow>(), exports = new Map<string, Map<string, Binding>>(), active = new Set<string>();
  const heights = new Map<string, number>(), declarations = new Map<string, string>();
  let total = 0;
  const visit = (definition: Definition, id: string, depth: number): Map<string, Binding> => {
    if (depth > MODULE_LIMITS.depth) fail("module_depth_limit", "Module closure exceeds depth eight.");
    if (active.has(id)) fail("module_cycle", "Module imports cannot contain cycles.");
    const previous = rows.get(id);
    const declaration = JSON.stringify(definition.dependencies.map(dependency => [dependency.import_path ?? null,
      dependency.skill_id, dependency.version]).sort());
    if (previous) {
      if (previous.source !== definition.source || previous.source_hash !== definition.hash || declarations.get(id) !== declaration)
        fail("invalid_modules", "A named immutable module identity has conflicting content.");
      if (depth + heights.get(id)! - 1 > MODULE_LIMITS.depth)
        fail("module_depth_limit", "Module closure exceeds depth eight.");
      return exports.get(id)!;
    }
    check(definition);
    if (definition.entry !== "step" && definition.entry !== "analyze" && definition.entry !== "library")
      fail("invalid_modules", "Only pure modules can participate in an imported closure.");
    if (rows.size >= MODULE_LIMITS.modules) fail("module_count_limit", "Module closure exceeds 32 modules.");
    total += Buffer.byteLength(definition.source, "utf8");
    if (total > MODULE_LIMITS.source_bytes) fail("module_bytes_limit", "Module closure exceeds 64 KiB of canonical source.");
    const row: ModuleRow = { id, source: definition.source, source_hash: definition.hash, imports: [] };
    rows.set(id, row); declarations.set(id, declaration); active.add(id);
    const ast = node(parse(definition.source, { ecmaVersion: "latest", sourceType: "module" }))!;
    const body = list(ast.body);
    const usedAliases = new Set(body.filter(item => item.type === "ImportDeclaration" || item.type.startsWith("Export"))
      .filter(item => item.source !== null && item.source !== undefined).map(item => name(item.source)));
    if ((definition.entry === "library" || usedAliases.size > 0 ||
      body.some(item => item.type.startsWith("Export") && (item.type !== "ExportNamedDeclaration" || !node(item.declaration)))) &&
      !definition.validation.runtime_features?.includes("pure_modules_v1"))
      fail("invalid_modules", "Static module features require current feature-tagged validation.");
    const aliases = new Map<string, Map<string, Binding>>();
    const declaredAliases = new Set<string>();
    for (const dependency of definition.dependencies) {
      const selected = catalog.read(dependency);
      if (selected.skill_id !== dependency.skill_id || selected.version !== dependency.version ||
        (dependencyState === "validated" && selected.state !== "validated"))
        fail("invalid_modules", "Dependency is not the exact validated run-local reference.");
      if (dependency.import_path === undefined) {
        if (definition.entry !== "step" || selected.entry !== "run")
          fail("invalid_dependencies", "Only step roots can declare semantic run children without import aliases.");
        continue;
      }
      if (dependency.import_path.length > 512 || !LOCAL_MODULE_ALIAS.test(dependency.import_path) || declaredAliases.has(dependency.import_path))
        fail("invalid_dependencies", "Local import aliases must be canonical and unambiguous per definition.");
      if (selected.entry !== "library" && !(definition.entry === "analyze" && selected.entry === "step"))
        fail("invalid_dependencies", "Imports require pure libraries; analyze may also import an exact step definition as software.");
      declaredAliases.add(dependency.import_path);
      if (!usedAliases.has(dependency.import_path)) { check(selected); continue; }
      const moduleId = "module:" + JSON.stringify([selected.name, selected.version]);
      const values = visit(selected, moduleId, depth + 1);
      aliases.set(dependency.import_path, values);
      row.imports.push({ specifier: dependency.import_path, module_id: moduleId });
    }
    const locals = new Map<string, Binding>(), result = new Map<string, Binding>();
    const imported = (source: unknown) => {
      const specifier = name(source), values = aliases.get(specifier);
      if (!LOCAL_MODULE_ALIAS.test(specifier) || !values) fail("unbound_import", "Every static import must use an explicitly pinned local pure-module alias.");
      return values;
    };
    const lookup = (values: Map<string, Binding>, key: string) => {
      let value = values.get(key);
      if (!value) fail("invalid_module_export", "An imported or re-exported binding does not exist or is ambiguous.");
      const seen = new Set<string>();
      while (values === locals && value.node?.type === "Identifier") {
        const key = name(value.node);
        if (seen.has(key)) fail("invalid_module_export", "Exported local aliases cannot contain binding cycles.");
        seen.add(key);
        const next = locals.get(key);
        if (!next) break;
        value = next;
      }
      return value;
    };
    const bindDeclaration = (declaration: Node | null) => {
      if (!declaration) return;
      if (declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") {
        const key = name(declaration.id); if (key) locals.set(key, { node: declaration, identity: `${id}:${key}` });
      } else if (declaration.type === "VariableDeclaration") {
        const bindPattern = (pattern: Node | null, value: Node | null) => {
          if (!pattern) return;
          if (pattern.type === "Identifier") locals.set(name(pattern), { node: value, identity: `${id}:${name(pattern)}` });
          else for (const child of Object.values(pattern)) {
            if (Array.isArray(child)) for (const item of child) bindPattern(node(item), null);
            else if (node(child)) bindPattern(node(child), null);
          }
        };
        for (const item of list(declaration.declarations)) bindPattern(node(item.id), node(item.init));
      }
    };
    for (const item of body) {
      if (item.type === "ImportDeclaration") {
        const values = imported(item.source);
        for (const specifier of list(item.specifiers)) {
          const value = specifier.type === "ImportNamespaceSpecifier" ? { node: null, identity: `${id}:namespace:${name(item.source)}` }
            : lookup(values, specifier.type === "ImportDefaultSpecifier" ? "default" : name(specifier.imported));
          locals.set(name(specifier.local), value);
        }
      } else bindDeclaration(item.type.startsWith("Export") ? node(item.declaration) : item);
    }
    const stars: Map<string, Binding>[] = [];
    for (const item of body) {
      if (item.type === "ExportDefaultDeclaration") {
        const declaration = node(item.declaration)!;
        result.set("default", declaration.type === "Identifier" ? lookup(locals, name(declaration)) : { node: declaration, identity: `${id}:default` });
      } else if (item.type === "ExportNamedDeclaration") {
        const declaration = node(item.declaration);
        if (declaration) {
          if (declaration.type === "VariableDeclaration") {
            const gather = (pattern: Node | null): void => {
              if (!pattern) return;
              if (pattern.type === "Identifier") result.set(name(pattern), lookup(locals, name(pattern)));
              else if (pattern.type === "Property") gather(node(pattern.value));
              else if (pattern.type === "RestElement") gather(node(pattern.argument));
              else if (pattern.type === "AssignmentPattern") gather(node(pattern.left));
              else for (const child of Object.values(pattern)) if (Array.isArray(child)) for (const value of child) gather(node(value));
            };
            for (const item of list(declaration.declarations)) gather(node(item.id));
          } else result.set(name(declaration.id), lookup(locals, name(declaration.id)));
        } else {
          const values = item.source ? imported(item.source) : locals;
          for (const specifier of list(item.specifiers)) result.set(name(specifier.exported), lookup(values, name(specifier.local)));
        }
      } else if (item.type === "ExportAllDeclaration") {
        const values = imported(item.source);
        if (item.exported) result.set(name(item.exported), { node: null, identity: `${id}:namespace:${name(item.source)}` });
        else stars.push(values);
      }
    }
    const explicit = new Set(result.keys()), ambiguous = new Set<string>();
    for (const values of stars) for (const [key, value] of values) {
      if (key === "default" || explicit.has(key) || ambiguous.has(key)) continue;
      const previous = result.get(key);
      if (previous && previous.identity !== value.identity) { result.delete(key); ambiguous.add(key); }
      else result.set(key, value);
    }
    if (definition.entry !== "library") {
      const arity = definition.entry === "step" ? 3 : 1;
      for (const [key, value] of result) {
        const fn = value.node;
        if ((key !== definition.entry && !(definition.entry === "step" && key === "activate")) || !fn ||
          !["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(fn.type) || fn.async || fn.generator ||
          list(fn.params).length !== arity || list(fn.params).some(parameter => parameter.type !== "Identifier"))
          fail("invalid_entry", "Selected root exports must be synchronous functions with the declared plain-parameter arity.");
      }
      if (!result.has(definition.entry)) fail("invalid_entry", "Module does not export its selected entry.");
      if (id === "root" && requireActivate && (definition.entry !== "step" || !result.has("activate")))
        fail("invalid_entry", "Prepared executives must explicitly export a synchronous activate(frame, state, intent).");
    }
    row.imports.sort((a, b) => a.specifier < b.specifier ? -1 : a.specifier > b.specifier ? 1 : 0);
    heights.set(id, 1 + Math.max(0, ...row.imports.map(binding => heights.get(binding.module_id)!)));
    exports.set(id, result); active.delete(id); return result;
  };
  visit(root, "root", 1);
  return [...rows.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Build a self-contained, byte-verified execution realm before any producer is retired. */
export function buildExecutableModuleBundle(store: Pick<Store, "skill" | "getRun">, runId: string, root: SkillView,
  compatible?: (definition: Definition) => void): ExecutableModuleBundle {
  const run = store.getRun(runId);
  if (!run?.compatibility_hash) fail("invalid_modules", "Module closure requires the current run adapter profile.");
  return buildArtifactModuleBundle({ compatibility_hash: run.compatibility_hash, read: ref => store.skill(runId, ref) }, root, compatible);
}

export function buildArtifactModuleBundle(catalog: ProgramArtifactCatalog, root: SkillView,
  compatible?: (definition: Definition) => void, requireActivate = false): ExecutableModuleBundle {
  const selected = catalog.read(root);
  const identity = (definition: SkillView) => JSON.stringify([definition.skill_id, definition.version, definition.name,
    definition.entry, definition.source, definition.hash, definition.validation,
    definition.dependencies.map(dependency => [dependency.import_path ?? null, dependency.skill_id, dependency.version])]);
  if (selected.state !== "validated" || identity(selected) !== identity(root))
    fail("invalid_modules", "Execution requires the exact immutable root definition from this run.");
  root = selected;
  if (root.entry !== "step" && root.entry !== "analyze") fail("invalid_entry", "Only step and analyze roots acquire executable module bundles.");
  const modules = resolveArtifactModuleClosure(catalog, root, compatible, "validated", requireActivate);
  const bundle: ExecutableModuleBundle = { schema_version: 1, entry: root.entry, root: "root",
    source_hash: executableModuleBundleHash(root.entry, modules), modules };
  if (Buffer.byteLength(JSON.stringify(bundle), "utf8") > MODULE_LIMITS.envelope_bytes)
    fail("module_envelope_limit", "Module bundle exceeds the execution envelope byte limit.");
  return bundle;
}
