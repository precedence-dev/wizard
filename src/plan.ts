/**
 * plan.json: read it, write it, or (for --ci, where there's no browser to
 * run the picker in) scaffold a draft from the real catalog instead — every
 * anchor in the draft is real, copied off actual OutcomeBranch/Action
 * records, so the only editing needed is naming events and trimming which
 * ones to keep.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Catalog, OutcomeBranch } from "@precedence/cli";

export interface DraftAnchor {
  id: string;
  fingerprint: { handler: string; conditionKey: string };
  suggestedName: string;
  properties: string[];
}

function terminalBranches(bs: OutcomeBranch[], out: OutcomeBranch[] = []): OutcomeBranch[] {
  for (const b of bs) {
    if (b.terminal || b.children.length === 0) out.push(b);
    terminalBranches(b.children, out);
  }
  return out;
}

/** Every terminal outcome across the catalog, capped so the draft stays skimmable. */
export function draftAnchors(catalog: Catalog, limit = 25): DraftAnchor[] {
  const anchors: DraftAnchor[] = [];
  for (const el of catalog.elements) {
    for (const action of el.actions) {
      for (const b of terminalBranches(action.branches)) {
        anchors.push({
          id: b.id,
          fingerprint: { handler: b.fingerprint.handler, conditionKey: b.fingerprint.conditionKey },
          suggestedName: b.suggestedName,
          properties: b.candidateProps.map((p) => p.name),
        });
        if (anchors.length >= limit) return anchors;
      }
    }
  }
  return anchors;
}

export function scaffoldPlan(catalog: Catalog, limit = 25): object {
  return {
    events: draftAnchors(catalog, limit).map((a) => ({
      name: a.suggestedName,
      properties: a.properties,
      anchors: [{ id: a.id, fingerprint: a.fingerprint }],
    })),
  };
}

export function planPath(cwd: string): string {
  return path.join(cwd, ".precedence", "plan.json");
}

export function readPlan(cwd: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(planPath(cwd), "utf8"));
  } catch {
    return null;
  }
}

export function writeDraftPlan(cwd: string, catalog: Catalog): string {
  return writePlan(cwd, scaffoldPlan(catalog));
}

export function writePlan(cwd: string, plan: unknown): string {
  const out = planPath(cwd);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(plan, null, 2) + "\n");
  return out;
}
