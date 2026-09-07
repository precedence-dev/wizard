/**
 * What to scan, with no config. Enough to find real React/Next source in the
 * common layouts; anything unusual is what --dir is for.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface ProjectInfo {
  framework: "next" | "react" | "unknown";
  srcDirs: string[];
}

function readPackageJson(cwd: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

export function detectProject(cwd: string): ProjectInfo {
  const pkg = readPackageJson(cwd);
  const deps = { ...(pkg?.dependencies as object), ...(pkg?.devDependencies as object) } as Record<string, string>;
  const framework: ProjectInfo["framework"] = deps.next ? "next" : deps.react ? "react" : "unknown";

  const candidates = ["src", "app", "pages", "components"];
  const srcDirs = candidates.filter((d) => fs.existsSync(path.join(cwd, d)) && fs.statSync(path.join(cwd, d)).isDirectory());

  return { framework, srcDirs: srcDirs.length ? srcDirs : ["."] };
}

const EXT = /\.(tsx|jsx|ts|js|mts|cts|mjs|cjs)$/;
const SKIP_DIR = new Set(["node_modules", ".git", ".next", "dist", "build", ".precedence"]);

/** Recursively collect .tsx/.jsx/.ts files under a directory. No git/--changed-since
 *  logic here on purpose — that's @precedence/cli's own discover.ts; this just needs
 *  "everything under the detected source dirs" for a first-run scan. */
export function collectFiles(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIR.has(e.name)) collectFiles(full, out);
    } else if (EXT.test(e.name) && !e.name.endsWith(".d.ts") && !e.name.includes(".test.")) {
      out.push(full);
    }
  }
  return out;
}
