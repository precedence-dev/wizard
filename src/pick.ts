/**
 * The pick step: serve the picker (@precedence-dev/viewer), open the user's running
 * app at `?precedence=pick` so its @precedence-dev/sdk loads the agent, wait for the
 * agent to POST the plan, write it to .precedence/plan.json.
 */
import * as fs from "node:fs";
import { servePlan, openInBrowser } from "@precedence-dev/viewer";
import type { Catalog } from "@precedence-dev/cli";
import { planPath, readPlan } from "./plan";

type ViewerCatalog = Parameters<typeof servePlan>[0];

export interface PickResult { plan: { events?: unknown[] } & Record<string, unknown>; path: string; }

export async function pick(cwd: string, catalog: Catalog, opts: { devUrl: string; open?: boolean }): Promise<PickResult> {
  const existing = readPlan(cwd); // seeds the picker so it shows / merges what's already tracked
  const plan = (await servePlan(catalog as unknown as ViewerCatalog, {
    open: false,
    plan: existing ?? undefined,
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
