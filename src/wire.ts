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
