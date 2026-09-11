/**
 * The pick step: open a picker session on the configured server, open the
 * user's running app at `?precedence=pick&at=<server>&s=<sid>` so its
 * @precedence-dev/sdk loads the agent, poll until the agent POSTs the plan
 * back to the server, write it to .precedence/plan.json.
 *
 * Replaces the old local one-shot @precedence-dev/viewer servePlan() — the
 * picker now always runs against a real server (Cloud or BYOC); see
 * docs/byoc.md.
 */
import * as fs from "node:fs";
import { openInBrowser } from "@precedence-dev/viewer";
import type { Catalog } from "@precedence-dev/cli";
import { createSession, sessionStatus, type ServerClient } from "./client";
import { planPath, readPlan } from "./plan";

export interface PickResult {
  plan: { events?: unknown[] } & Record<string, unknown>;
  path: string;
}

const POLL_MS = 1500;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pick(
  cwd: string,
  catalog: Catalog,
  opts: { devUrl: string; open?: boolean; client: ServerClient; timeoutMs?: number },
): Promise<PickResult> {
  const existing = readPlan(cwd); // seeds the picker so it shows / merges what's already tracked
  const { sid } = await createSession(opts.client, { catalog, existingPlan: existing ?? undefined });

  const at = opts.client.server.replace(/\/$/, "");
  const appUrl = `${opts.devUrl.replace(/\/$/, "")}/?precedence=pick&at=${encodeURIComponent(at)}&s=${encodeURIComponent(sid)}`;
  process.stdout.write(`  picker session: ${sid}\n`);
  process.stdout.write(`  opening your app: ${appUrl}\n`);
  process.stdout.write("  click elements to track, name them, then “send to wizard”\n");
  if (opts.open !== false) openInBrowser(appUrl);

  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  while (Date.now() < deadline) {
    const status = await sessionStatus(opts.client, sid);
    if (status.state === "resolved") {
      const plan = status.plan as PickResult["plan"];
      const out = planPath(cwd);
      fs.writeFileSync(out, JSON.stringify(plan, null, 2) + "\n");
      return { plan, path: out };
    }
    if (status.state === "expired") throw new Error("picker session expired — nothing was exported in time");
    await sleep(POLL_MS);
  }
  throw new Error("timed out waiting for the picker — nothing was exported");
}
