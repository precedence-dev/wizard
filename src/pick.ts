/**
 * The pick step.
 *
 * Default (`pick`): serve @precedence/viewer's picker locally, wait for the user
 * to click "send to wizard", write the plan to .precedence/plan.json. No file to
 * move by hand.
 *
 * Fallback (`bakePicker`, used by --no-serve): write a static copy of the picker
 * with the catalog baked in; the user exports a file and re-runs.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { servePlan, renderHtml, openInBrowser } from "@precedence/viewer";
import type { Catalog } from "@precedence/cli";
import { planPath } from "./plan";

type ViewerCatalog = Parameters<typeof servePlan>[0];

export interface PickResult { plan: { events?: unknown[] } & Record<string, unknown>; path: string; }

export async function pick(cwd: string, catalog: Catalog, opts: { open?: boolean } = {}): Promise<PickResult> {
  const plan = (await servePlan(catalog as unknown as ViewerCatalog, {
    open: opts.open,
    onListen: (url) => {
      process.stdout.write(`  picker: ${url}\n`);
      process.stdout.write("  select outcomes, name them, then click “send to wizard”\n");
    },
  })) as PickResult["plan"];

  const out = planPath(cwd);
  fs.writeFileSync(out, JSON.stringify(plan, null, 2) + "\n");
  return { plan, path: out };
}

export function bakePicker(cwd: string, catalog: Catalog, opts: { open?: boolean } = {}): string {
  const out = path.join(cwd, ".precedence", "viewer.html");
  fs.writeFileSync(out, renderHtml(catalog as unknown as ViewerCatalog));
  if (opts.open !== false) openInBrowser(out);
  return out;
}
