/**
 * One-time project setup for the live picker: install the two packages the app
 * itself imports, write `instrumentation-client.ts` (Next auto-loads it), and
 * wrap `next.config` with `withPrecedence`. The wizard asks before it installs
 * or edits config; a config it can't safely edit falls back to a printed
 * one-line hint. It never touches `layout.tsx`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import type { PackageManager } from "./detect";

/** imported by the app's own code, so they must resolve from the project, not
 *  from the wizard's npx cache: `sdk` ships to the browser, `cli` provides the
 *  `withPrecedence` next-config wrapper + the dev stamp loader. */
const RUNTIME_DEP = "@precedence-dev/sdk";
const DEV_DEP = "@precedence-dev/cli";

const IC_BODY = `import { precedencePicker } from "@precedence-dev/sdk";\n\n// dev-only: loads the Precedence picker when opened with ?precedence=pick\nprecedencePicker();\n`;

function resolves(cwd: string, pkg: string): boolean {
  try { createRequire(path.join(cwd, "package.json")).resolve(pkg); return true; }
  catch { return false; }
}

/** can `@precedence-dev/sdk` be resolved from the target project? */
export function hasSdk(cwd: string): boolean {
  return resolves(cwd, RUNTIME_DEP);
}

/** which of the two packages the project is still missing */
export function missingDeps(cwd: string): { deps: string[]; devDeps: string[] } {
  return {
    deps: resolves(cwd, RUNTIME_DEP) ? [] : [RUNTIME_DEP],
    devDeps: resolves(cwd, DEV_DEP) ? [] : [DEV_DEP],
  };
}

/** `[prod add verb, dev add verb]` per package manager */
const ADD: Record<PackageManager, [string, string]> = {
  npm: ["install", "install --save-dev"],
  pnpm: ["add", "add -D"],
  yarn: ["add", "add -D"],
  bun: ["add", "add -d"],
};

/** the exact command(s) the wizard would run (also shown to the user) */
export function installLines(pm: PackageManager, deps: string[], devDeps: string[]): string[] {
  const [prod, dev] = ADD[pm];
  const out: string[] = [];
  if (deps.length) out.push(`${pm} ${prod} ${deps.join(" ")}`);
  if (devDeps.length) out.push(`${pm} ${dev} ${devDeps.join(" ")}`);
  return out;
}

/** run the install(s), inheriting stdio so npm/pnpm output is visible.
 *  returns false if any step exits non-zero. */
export function installDeps(cwd: string, pm: PackageManager, deps: string[], devDeps: string[]): boolean {
  for (const line of installLines(pm, deps, devDeps)) {
    try {
      execSync(line, { cwd, stdio: "inherit" });
    } catch {
      return false;
    }
  }
  return true;
}

export function instrumentationClient(cwd: string): { file: string; status: "created" | "present" | "foreign" } {
  const dir = fs.existsSync(path.join(cwd, "src")) ? path.join(cwd, "src") : cwd;
  for (const ext of ["ts", "js", "mts", "mjs"]) {
    const f = path.join(dir, `instrumentation-client.${ext}`);
    if (fs.existsSync(f)) {
      const has = fs.readFileSync(f, "utf8").includes("precedencePicker");
      return { file: path.relative(cwd, f), status: has ? "present" : "foreign" };
    }
  }
  const f = path.join(dir, "instrumentation-client.ts");
  fs.writeFileSync(f, IC_BODY);
  return { file: path.relative(cwd, f), status: "created" };
}

export function nextConfig(cwd: string): { file: string | null; wired: boolean } {
  for (const name of ["next.config.ts", "next.config.mjs", "next.config.js"]) {
    const f = path.join(cwd, name);
    if (fs.existsSync(f)) return { file: name, wired: fs.readFileSync(f, "utf8").includes("withPrecedence") };
  }
  return { file: null, wired: false };
}

/** Wrap `next.config` with `withPrecedence` in place — but only when the export
 *  is an unambiguous `export default <ident>` / `module.exports = <ident>`.
 *  Anything else (inline object, a function, a chained wrapper) returns
 *  `"manual"` and the caller prints `wrapHint`. */
export function wrapNextConfig(cwd: string): {
  file: string;
  status: "wrapped" | "already" | "manual" | "none";
} {
  const found = nextConfig(cwd);
  if (!found.file) return { file: "next.config.mjs", status: "none" };
  if (found.wired) return { file: found.file, status: "already" };

  const p = path.join(cwd, found.file);
  const src = fs.readFileSync(p, "utf8");
  const esm = /\.(mjs|ts)$/.test(found.file) || /^\s*export\s+default\b/m.test(src);

  const esmM = src.match(/(^|\n)export default (\w+);?[ \t]*(\r?\n|$)/);
  const cjsM = src.match(/(^|\n)module\.exports\s*=\s*(\w+);?[ \t]*(\r?\n|$)/);

  if (esm && esmM) {
    const out =
      `import { withPrecedence } from "@precedence-dev/cli/next";\n` +
      src.replace(esmM[0], `${esmM[1]}export default withPrecedence(${esmM[2]});${esmM[3]}`);
    fs.writeFileSync(p, out);
    return { file: found.file, status: "wrapped" };
  }
  if (!esm && cjsM) {
    const out =
      `const { withPrecedence } = require("@precedence-dev/cli/next");\n` +
      src.replace(cjsM[0], `${cjsM[1]}module.exports = withPrecedence(${cjsM[2]});${cjsM[3]}`);
    fs.writeFileSync(p, out);
    return { file: found.file, status: "wrapped" };
  }
  return { file: found.file, status: "manual" };
}

/** the manual change to make — printed only when `wrapNextConfig` returns "manual" / "none" */
export function wrapHint(file: string | null): string {
  const f = file || "next.config.mjs";
  const esm = /\.(mjs|ts)$/.test(f);
  return [
    `  wrap ${f} with withPrecedence (one time):`,
    "",
    esm
      ? `    import { withPrecedence } from "@precedence-dev/cli/next";`
      : `    const { withPrecedence } = require("@precedence-dev/cli/next");`,
    esm
      ? `    export default withPrecedence(nextConfig);   // was: export default nextConfig`
      : `    module.exports = withPrecedence(nextConfig);  // was: module.exports = nextConfig`,
  ].join("\n");
}

export async function waitForServer(url: string, timeoutMs = 120_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { method: "HEAD" });
      if (r.status < 500) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}
