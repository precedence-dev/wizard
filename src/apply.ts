import * as fs from "node:fs";
import * as path from "node:path";
import { instrument, Plan, type InstrumentResult } from "@precedence-dev/instrument";
import { collectFiles, ProjectInfo } from "./detect";

export interface ApplyResult {
  changed: string[];
  applied: number;
  skipped: { id?: string; reason: string }[];
  warnings: { detail: string }[];
  delegatedModule?: string;
}

export interface WizardInstrumentOpts {
  track?: string;
  types?: boolean;
}

function inputsFor(cwd: string, project: ProjectInfo) {
  const files = project.srcDirs.flatMap((d) => collectFiles(path.join(cwd, d)));
  return files.map((abs) => ({
    file: path.relative(cwd, abs).replace(/\\/g, "/"),
    abs,
    source: fs.readFileSync(abs, "utf8"),
  }));
}

function toOpts(trackOrOpts?: string | WizardInstrumentOpts): WizardInstrumentOpts {
  return typeof trackOrOpts === "string" ? { track: trackOrOpts } : trackOrOpts || {};
}

/** Resolve the proposed edits without writing anything — the review step before apply(). */
export function preview(cwd: string, project: ProjectInfo, plan: Plan, trackOrOpts?: string | WizardInstrumentOpts): InstrumentResult {
  const opts = toOpts(trackOrOpts);
  return instrument(inputsFor(cwd, project), plan, opts);
}

export function apply(cwd: string, project: ProjectInfo, plan: Plan, trackOrOpts?: string | WizardInstrumentOpts): ApplyResult {
  const inputs = inputsFor(cwd, project);
  const result = instrument(inputs, plan, toOpts(trackOrOpts));

  const changed: string[] = [];
  for (const f of result.files) {
    if (f.before !== f.after) {
      fs.writeFileSync(inputs.find((i) => i.file === f.file)!.abs, f.after);
      changed.push(f.file);
    }
  }

  return {
    changed,
    applied: result.applied.length,
    skipped: result.skipped,
    warnings: result.warnings,
    delegatedModule: result.delegatedModule,
  };
}
