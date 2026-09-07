/**
 * Insert `<PrecedenceDevtools />` into the app's root layout — the one-time
 * setup step that makes the picker possible at all. Only Next.js App
 * Router's `app/layout.tsx` is auto-wired today: a real, deterministic AST
 * edit, applied only when the file matches the exact `<body>{children}</body>`
 * shape this can insert into safely — never a best-effort guess. Anything
 * else (Pages Router, Vite, CRA, or a layout.tsx that doesn't match) gets
 * the same snippet printed for a manual one-time paste instead, same
 * "never silently guess" rule @precedence/instrument already follows for
 * anchors it can't resolve.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import * as ts from "typescript";

const IMPORT_LINE = 'import { PrecedenceDevtools } from "@precedence/sdk/devtools";';
const DEVTOOLS_JSX = '{process.env.NODE_ENV !== "production" && <PrecedenceDevtools />}';
export const SNIPPET = `${IMPORT_LINE}\n\n// inside <body>, as a sibling of {children}:\n${DEVTOOLS_JSX}`;

export interface WireResult {
  applied: boolean;
  file?: string;
  reason?: string;
}

const LAYOUT_CANDIDATES = ["app/layout.tsx", "app/layout.jsx", "src/app/layout.tsx", "src/app/layout.jsx"];

export function findLayoutFile(cwd: string): string | null {
  for (const c of LAYOUT_CANDIDATES) {
    const p = path.join(cwd, c);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Finds a JSX <body> element whose children include a bare `{children}` expression —
 *  the standard Next.js App Router root layout shape — and returns where to insert
 *  right after it. Returns null rather than guess at anything looser. */
function findInsertionPoint(sf: ts.SourceFile): number | null {
  let insertAt: number | null = null;
  const visit = (node: ts.Node) => {
    if (insertAt !== null) return;
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(sf) === "body") {
      const childrenExpr = node.children.find(
        (c): c is ts.JsxExpression => ts.isJsxExpression(c) && !!c.expression && ts.isIdentifier(c.expression) && c.expression.text === "children"
      );
      if (childrenExpr) insertAt = childrenExpr.getEnd();
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return insertAt;
}

function lastImportEnd(sf: ts.SourceFile): number {
  let end = 0;
  for (const stmt of sf.statements) if (ts.isImportDeclaration(stmt)) end = stmt.getEnd();
  return end;
}

function isValidSyntax(file: string, source: string): boolean {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return ((sf as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics || []).length === 0;
}

export function wireDevtools(cwd: string): WireResult {
  const file = findLayoutFile(cwd);
  if (!file) return { applied: false, reason: "no app/layout.tsx found (only Next.js App Router is auto-wired today)" };

  const original = fs.readFileSync(file, "utf8");
  if (original.includes("PrecedenceDevtools")) return { applied: true, file, reason: "already wired" };

  const sf = ts.createSourceFile(file, original, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const insertAt = findInsertionPoint(sf);
  if (insertAt === null) {
    return { applied: false, file, reason: "couldn't find a <body>{children}</body> shape to insert after — not guessing" };
  }

  let out = original.slice(0, insertAt) + `\n      ${DEVTOOLS_JSX}` + original.slice(insertAt);
  const afterImports = lastImportEnd(ts.createSourceFile(file, out, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX));
  out = afterImports
    ? out.slice(0, afterImports) + `\n${IMPORT_LINE}` + out.slice(afterImports)
    : `${IMPORT_LINE}\n` + out;

  if (!isValidSyntax(file, out)) {
    return { applied: false, file, reason: "the edit would have produced invalid syntax — not applying it" };
  }

  fs.writeFileSync(file, out);
  return { applied: true, file };
}

/** Adds @precedence/sdk to package.json's dependencies if it isn't already there. */
export function addDevtoolsDependency(cwd: string, version = "^0.1.0"): boolean {
  const pkgPath = path.join(cwd, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  if (pkg.dependencies?.["@precedence/sdk"]) return false;
  pkg.dependencies = { ...pkg.dependencies, "@precedence/sdk": version };
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  return true;
}

/**
 * The stamp loader: wires @precedence/cli's already-tested browser/stamp-loader.js
 * into next.config so `<PrecedenceDevtools />` can resolve a click regardless of
 * compiler (Next's default SWC and React 19 don't set `_debugSource`, the fiber
 * rung's only source — see @precedence/sdk). Copies the loader in (not an npm
 * dependency of the target app — nothing proprietary in it, same reasoning
 * discover.ts/util.ts are duplicated rather than imported), then makes one of
 * two narrow, deterministic edits to the existing config, applied only when the
 * shape matches exactly — never a best-effort guess:
 *
 *   - no `turbopack` key at all: add one new top-level property, dev-gated
 *     (`...(isDev ? { turbopack: { rules: {...} } } : {})`) — the same shape
 *     real, working Next.js configs already use for this.
 *   - an existing `webpack(config, { dev }) { ... return config; }` (first
 *     param literally named `config`, a `return config;` present): insert
 *     `if (dev) { config.module.rules.push({...}); }` right before that return.
 *
 * Anything else (a `turbopack` key already present in some other shape, no
 * `return config;` to anchor on, no next.config file, config export isn't a
 * plain object literal) prints the same edit for a manual one-time paste.
 */
const STAMP_LOADER_REL = ".precedence/stamp-loader.cjs";
const NEXT_CONFIG_CANDIDATES = ["next.config.ts", "next.config.mjs", "next.config.js"];

export interface StampWireResult {
  applied: boolean;
  file?: string;
  reason?: string;
}

export function findNextConfigFile(cwd: string): string | null {
  for (const c of NEXT_CONFIG_CANDIDATES) {
    const p = path.join(cwd, c);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Copies the real, already-tested stamp loader in from @precedence/cli. Idempotent. */
export function copyStampLoader(cwd: string): string {
  const dest = path.join(cwd, STAMP_LOADER_REL);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const src = require.resolve("@precedence/cli/stamp-loader");
  fs.copyFileSync(src, dest);
  return dest;
}

function unwrapExpr(e: ts.Expression): ts.Expression {
  while (ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression;
  return e;
}

/** The exported config object literal, resolved through `export default <ident>`,
 *  `export default {...}`, or `module.exports = ...` — whichever the file uses. */
function findConfigObjectLiteral(sf: ts.SourceFile): ts.ObjectLiteralExpression | null {
  const varInits = new Map<string, ts.Expression>();
  for (const stmt of sf.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer) varInits.set(decl.name.text, decl.initializer);
      }
    }
  }
  const resolve = (e: ts.Expression): ts.Expression => {
    e = unwrapExpr(e);
    return ts.isIdentifier(e) && varInits.has(e.text) ? resolve(varInits.get(e.text)!) : e;
  };
  for (const stmt of sf.statements) {
    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      const r = resolve(stmt.expression);
      if (ts.isObjectLiteralExpression(r)) return r;
    }
    if (ts.isExpressionStatement(stmt) && ts.isBinaryExpression(stmt.expression) &&
        stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = stmt.expression.left;
      if (ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.expression) &&
          left.expression.text === "module" && left.name.text === "exports") {
        const r = resolve(stmt.expression.right);
        if (ts.isObjectLiteralExpression(r)) return r;
      }
    }
  }
  return null;
}

function findProperty(obj: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralElementLike | undefined {
  return obj.properties.find((p) => p.name && ts.isIdentifier(p.name) && p.name.text === name);
}

/** The `webpack(config, ...) { ... }` function body, only when written as a plain
 *  method or property whose first param is literally named `config`. */
function webpackFunctionBody(prop: ts.ObjectLiteralElementLike | undefined): { body: ts.Block; params: ts.NodeArray<ts.ParameterDeclaration> } | null {
  const fn = prop && ts.isMethodDeclaration(prop) ? prop
    : prop && ts.isPropertyAssignment(prop) && (ts.isFunctionExpression(prop.initializer) || ts.isArrowFunction(prop.initializer))
      ? prop.initializer
      : null;
  if (!fn || !fn.body || !ts.isBlock(fn.body)) return null;
  const first = fn.parameters[0];
  if (!first || !ts.isIdentifier(first.name) || first.name.text !== "config") return null;
  return { body: fn.body, params: fn.parameters };
}

function findReturnConfig(body: ts.Block): ts.ReturnStatement | null {
  for (const stmt of body.statements) {
    if (ts.isReturnStatement(stmt) && stmt.expression && ts.isIdentifier(stmt.expression) && stmt.expression.text === "config") return stmt;
  }
  return null;
}

function isEsm(file: string): boolean {
  return file.endsWith(".ts") || file.endsWith(".mjs");
}

function ensurePathImport(source: string, esm: boolean): string {
  if (esm ? /^import\s+path\s+from\s+["']node:path["'];?$/m.test(source) : /require\(["']path["']\)/.test(source)) return source;
  const line = esm ? 'import path from "node:path";\n' : 'const path = require("path");\n';
  return line + source;
}

function isValidJs(file: string, source: string): boolean {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return ((sf as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics || []).length === 0;
}

export const STAMP_SNIPPET = `// next.config: no turbopack key yet
const isDev = process.env.NODE_ENV === "development";
export default {
  ...(isDev ? { turbopack: { rules: {
    "*.tsx": { loaders: [{ loader: path.resolve(__dirname, "${STAMP_LOADER_REL}"), options: {} }] },
    "*.jsx": { loaders: [{ loader: path.resolve(__dirname, "${STAMP_LOADER_REL}"), options: {} }] },
  } } } : {}),
  // ...your other config
};

// OR, inside an existing webpack(config, { dev }) { ... return config; }:
if (dev) {
  config.module.rules.push({
    test: /\\.(t|j)sx$/,
    enforce: "pre",
    use: [path.resolve(__dirname, "${STAMP_LOADER_REL}")],
  });
}`;

export function wireStampLoader(cwd: string): StampWireResult {
  const file = findNextConfigFile(cwd);
  if (!file) return { applied: false, reason: "no next.config.{ts,mjs,js} found (only Next.js is auto-wired today)" };

  const original = fs.readFileSync(file, "utf8");
  if (original.includes("stamp-loader")) return { applied: true, file, reason: "already wired" };

  const sf = ts.createSourceFile(file, original, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const configObj = findConfigObjectLiteral(sf);
  if (!configObj) return { applied: false, file, reason: "couldn't find a plain exported config object — not guessing" };

  copyStampLoader(cwd);
  const esm = isEsm(file);
  const loaderPath = `path.resolve(__dirname, ${JSON.stringify(STAMP_LOADER_REL)})`;

  const webpackProp = findProperty(configObj, "webpack");
  if (webpackProp) {
    const fn = webpackFunctionBody(webpackProp);
    if (!fn) return { applied: false, file, reason: "an existing webpack() doesn't match the shape this can insert into safely — not guessing" };
    const ret = findReturnConfig(fn.body);
    if (!ret) return { applied: false, file, reason: "existing webpack() has no `return config;` to insert before — not guessing" };
    const insertion = `if (dev) { config.module.rules.push({ test: /\\.(t|j)sx$/, enforce: "pre", use: [${loaderPath}] }); }\n  `;
    let out = original.slice(0, ret.getStart(sf)) + insertion + original.slice(ret.getStart(sf));
    out = ensurePathImport(out, esm);
    if (!isValidJs(file, out)) return { applied: false, file, reason: "the webpack() edit would have produced invalid syntax — not applying it" };
    fs.writeFileSync(file, out);
    return { applied: true, file };
  }

  if (findProperty(configObj, "turbopack")) {
    return { applied: false, file, reason: "an existing turbopack config is already present in a shape this doesn't merge into — not guessing" };
  }

  const insertion = `...(process.env.NODE_ENV === "development" ? { turbopack: { rules: {\n` +
    `    "*.tsx": { loaders: [{ loader: ${loaderPath}, options: {} }] },\n` +
    `    "*.jsx": { loaders: [{ loader: ${loaderPath}, options: {} }] },\n` +
    `  } } } : {}),\n  `;
  const insertAt = configObj.getStart(sf) + 1; // just inside the opening `{`
  let out = original.slice(0, insertAt) + "\n  " + insertion + original.slice(insertAt);
  out = ensurePathImport(out, esm);
  if (!isValidJs(file, out)) return { applied: false, file, reason: "the turbopack.rules edit would have produced invalid syntax — not applying it" };
  fs.writeFileSync(file, out);
  return { applied: true, file };
}

/**
 * Runs the install for a new dependency wireDevtools/addDevtoolsDependency
 * just added — no reason to make the developer type it themselves, the way
 * `--allow-dirty`'s git check already keeps this safe: nothing uncommitted
 * for `npm install` to put at risk. Deliberately not a restart of the dev
 * server itself (see devserver.ts's doc comment) — that's a different kind
 * of action, on a process this doesn't own.
 */
export type PackageManager = "npm" | "yarn" | "pnpm";

export function detectPackageManager(cwd: string): PackageManager {
  if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(cwd, "yarn.lock"))) return "yarn";
  return "npm";
}

export interface InstallResult { ok: boolean; manager: PackageManager; error?: string; }

export function installDependencies(cwd: string): InstallResult {
  const manager = detectPackageManager(cwd);
  // Windows package-manager shims (npm.cmd etc.) need cmd.exe to invoke —
  // same reasoning as openBrowser in pick.ts: wrap via cmd /c rather than
  // shell:true, so nothing here is re-parsed by a shell.
  const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", manager, "install"]] : [manager, ["install"]];
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (result.error) return { ok: false, manager, error: result.error.message };
  if (result.status !== 0) return { ok: false, manager, error: (result.stderr || result.stdout || "").trim().slice(-2000) };
  return { ok: true, manager };
}
