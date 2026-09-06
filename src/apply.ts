import * as fs from "node:fs";
import * as path from "node:path";
import { instrument, Plan } from "@precedence/instrument";
import { collectFiles, ProjectInfo } from "./detect";

export interface ApplyResult {
  changed: string[];
  applied: number;
  skipped: { id?: string; reason: string }[];
  warnings: { detail: string }[];
}

export function apply(cwd: string, project: ProjectInfo, plan: Plan, track?: string): ApplyResult {
  const files = project.srcDirs.flatMap((d) => collectFiles(path.join(cwd, d)));
  const inputs = files.map((abs) => ({
    file: path.relative(cwd, abs).replace(/\\/g, "/"),
    abs,
    source: fs.readFileSync(abs, "utf8"),
  }));

  const result = instrument(inputs, plan, { track });

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
  };
}
