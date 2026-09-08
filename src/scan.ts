/**
 * Runs the real analyzer, in-process, against the files this project detected.
 *
 * Calls @precedence/cli directly rather than shelling out to `precedence` —
 * same as @precedence/instrument does, one code path, no stdout-parsing.
 * (@precedence/cli is a `file:` sibling until the packages are published.)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { buildCatalog } from "@precedence/cli/build";
import type { Catalog } from "@precedence/cli";
import { collectFiles, ProjectInfo } from "./detect";
import { catalogPath } from "./plan";

export interface ScanResult { catalog: Catalog; fileCount: number; }

export function scan(cwd: string, project: ProjectInfo, opts: { types?: boolean; tsconfig?: string } = {}): ScanResult {
  const files = project.srcDirs.flatMap((d) => collectFiles(path.join(cwd, d)));
  const inputs = files.map((abs) => ({
    file: path.relative(cwd, abs).replace(/\\/g, "/"),
    abs,
    source: fs.readFileSync(abs, "utf8"),
  }));
  const catalog = buildCatalog(inputs, { types: opts.types, tsconfig: opts.tsconfig });
  return { catalog, fileCount: files.length };
}

export function writeCatalog(cwd: string, catalog: Catalog): string {
  const out = catalogPath(cwd);
  const dir = path.dirname(out);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(out, JSON.stringify(catalog, null, 2) + "\n");
  // A courtesy for git users: the catalog + baked picker are regenerable
  // artifacts; the plan is the reviewed source of truth and stays tracked.
  const ignore = path.join(dir, ".gitignore");
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "# regenerable artifacts\ncatalog.pcs\nviewer.html\n");
  return out;
}
