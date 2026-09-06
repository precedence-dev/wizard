/**
 * Runs the real analyzer, in-process, against files this project detected.
 *
 * This calls @precedence/cli directly rather than shelling out to `precedence`,
 * same as @precedence/instrument does — one code path, no stdout-parsing.
 * Today that's a temporary `file:` sibling dependency (see this repo's README);
 * once there's a real auth-gated registry, this step is where the install
 * happens before the require, not a different code path.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { buildCatalog } from "@precedence/cli/build";
import type { Catalog } from "@precedence/cli";
import { collectFiles, ProjectInfo } from "./detect";

export interface ScanResult { catalog: Catalog; fileCount: number; }

export function scan(cwd: string, project: ProjectInfo, opts: { types?: boolean; tsconfig?: string } = {}): ScanResult {
  const files = project.srcDirs.flatMap((d) => collectFiles(path.join(cwd, d)));
  const inputs = files.map((abs) => ({
    file: path.relative(cwd, abs).replace(/\\/g, "/"),
    abs,
    source: fs.readFileSync(abs, "utf8"),
  }));
  const catalog = buildCatalog(inputs, {
    types: opts.types,
    tsconfig: opts.tsconfig,
  });
  return { catalog, fileCount: files.length };
}

export function writeCatalog(cwd: string, catalog: Catalog): string {
  const dir = path.join(cwd, ".precedence");
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, "catalog.pcs");
  fs.writeFileSync(out, JSON.stringify(catalog, null, 2) + "\n");
  return out;
}

/** <PrecedenceDevtools />'s default catalogUrl fetches this same-origin from the target app. */
export function publishCatalogForDevtools(cwd: string, catalog: Catalog): string | null {
  const publicDir = path.join(cwd, "public");
  if (!fs.existsSync(publicDir)) return null;
  const out = path.join(publicDir, "precedence-catalog.pcs");
  fs.writeFileSync(out, JSON.stringify(catalog));
  return out;
}
