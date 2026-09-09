/**
 * One-time project setup for the live picker, the Sentry way: never touch
 * layout.tsx. Write a new `instrumentation-client.ts` (Next auto-loads it) and
 * check that `next.config` is wrapped with `withPrecedence` — printing the
 * one-line change if it isn't, never AST-editing it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

const IC_BODY = `import { precedencePicker } from "@precedence-dev/sdk";\n\n// dev-only: loads the Precedence picker when opened with ?precedence=pick\nprecedencePicker();\n`;

/** can `@precedence-dev/sdk` be resolved from the target project? */
export function hasSdk(cwd: string): boolean {
  try { createRequire(path.join(cwd, "package.json")).resolve("@precedence-dev/sdk"); return true; }
  catch { return false; }
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

/** the manual change to make — one line, not a snippet to paste into webpack() */
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
