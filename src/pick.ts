/**
 * The pick step: serve the picker (@precedence/viewer), open the user's running
 * app at `?precedence=pick` so its @precedence/sdk loads the agent, wait for the
 * agent to POST the plan, write it to .precedence/plan.json.
 *
 * `bakePicker` is the --no-serve fallback: a static viewer.html to export by hand.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { servePlan, renderHtml, openInBrowser } from "@precedence/viewer";
import type { Catalog } from "@precedence/cli";
import { planPath } from "./plan";

type ViewerCatalog = Parameters<typeof servePlan>[0];

export interface PickResult { plan: { events?: unknown[] } & Record<string, unknown>; path: string; }

export async function pick(cwd: string, catalog: Catalog, opts: { devUrl: string; open?: boolean }): Promise<PickResult> {
  const plan = (await servePlan(catalog as unknown as ViewerCatalog, {
    open: false,
    onListen: (serverUrl) => {
      const at = serverUrl.replace(/\/$/, "");
      const appUrl = `${opts.devUrl.replace(/\/$/, "")}/?precedence=pick&at=${encodeURIComponent(at)}`;
      process.stdout.write(`  picker server: ${at}\n`);
      process.stdout.write(`  opening your app: ${appUrl}\n`);
      process.stdout.write("  click elements to track, name them, then “send to wizard”\n");
      if (opts.open !== false) openInBrowser(appUrl);
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
