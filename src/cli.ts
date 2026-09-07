#!/usr/bin/env node
/**
 * `precedence-wizard`: scan a repo, open the picker, preview, then apply.
 *
 *   npx @precedence/wizard          # scan -> tells you how to pick
 *   # ...pick outcomes in @precedence/viewer, save .precedence/plan.json...
 *   npx @precedence/wizard          # sees the plan, instruments it
 *
 *   npx @precedence/wizard --ci     # scan -> scaffold a draft plan.json to hand-edit
 *
 * Framework-agnostic: it never modifies your app. The scan runs the real
 * analyzer in-process; picking happens in the standalone viewer; applying is
 * @precedence/instrument. (A live in-app picker — click the running UI — is
 * future work; the previous React one was removed to keep the toolchain
 * framework-neutral.)
 *
 * One genuine stand-in: there's no account/registry backend yet, so
 * @precedence/cli is a local `file:` sibling (see README).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { isGitRepo, currentBranch, isCleanForApply } from "./git";
import { detectProject } from "./detect";
import { scan, writeCatalog } from "./scan";
import { readPlan, writeDraftPlan, planPath } from "./plan";
import { apply, preview } from "./apply";
import type { Plan } from "@precedence/instrument";

const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

interface Opts {
  allowDirty: boolean;
  apply: boolean;
  track?: string;
  emit: "direct" | "runtime";
  runtime?: string;
  types: boolean;
  ci: boolean;
  open: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Opts {
  const o: Opts = { allowDirty: false, apply: false, emit: "direct", types: false, ci: false, open: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") o.help = true;
    else if (a === "--allow-dirty") o.allowDirty = true;
    else if (a === "--apply") o.apply = true;
    else if (a === "--types") o.types = true;
    else if (a === "--ci") o.ci = true;
    else if (a === "--open") o.open = true;
    else if (a === "--no-open") o.open = false;
    else if (a === "--track") {
      const v = argv[++i]; if (!v) throw new Error("missing value for --track"); o.track = v;
    } else if (a === "--runtime") {
      const v = argv[++i]; if (!v) throw new Error("missing value for --runtime"); o.runtime = v;
    } else if (a === "--emit") {
      const v = argv[++i];
      if (v !== "direct" && v !== "runtime") throw new Error("--emit must be direct or runtime");
      o.emit = v;
    } else if (a.startsWith("-")) throw new Error(`unknown option: ${a}`);
  }
  return o;
}

const HELP = `precedence-wizard: scan a repo, pick outcomes, instrument them

USAGE
  npx @precedence/wizard                         scan and open the browser picker
  npx @precedence/wizard --track "track from @/lib/analytics"
                                                   preview the generated source diff
  npx @precedence/wizard --track "track from @/lib/analytics" --apply
                                                   apply the reviewed diff

OPTIONS
  --track <spec>    required for direct mode; e.g. "track from @/lib/analytics"
  --emit <mode>     direct (default) or runtime
  --runtime <file>  direct mode: write delegated-link listener here on --apply
  --apply           write source only after the preview has been reviewed
  --allow-dirty     let --apply proceed with uncommitted source changes
  --types           resolve declared types (slower, enables interprocedural outcomes)
  --ci              non-interactive: write a draft plan.json instead of the pick step
  --no-open         scan but do not launch the browser picker
  -h, --help
`;

/** Open the catalog in @precedence/viewer; print the manual command if we can't. */
function launchViewer(catalog: string): void {
  try {
    const entry = require.resolve("@precedence/viewer");
    const bin = path.resolve(path.dirname(entry), "..", "bin", "precedence-view.js");
    const r = spawnSync(process.execPath, [bin, catalog, "--open"], { stdio: "inherit" });
    if (!r.error && r.status === 0) return;
  } catch {
    // The command below is a usable fallback in remote terminals and CI.
  }
  console.log(yellow("\n  couldn't launch the viewer automatically."));
  console.log(`  run ${cyan(`npx @precedence/viewer ${catalog} --open`)}`);
}

/** A unified-ish diff for the preview: LCS over lines so an inserted import and
 *  an inserted call each read as their own `+` block, not one replaced region.
 *  Prefix/suffix fallback on huge files (the real review is `git diff` after
 *  --apply either way). */
function previewDiff(file: string, before: string, after: string): string {
  const a = before.split("\n"), b = after.split("\n");
  const head = [`--- a/${file}`, `+++ b/${file}`];
  const ops = a.length > 2500 || b.length > 2500 ? prefixSuffixOps(a, b) : lcsOps(a, b);
  return head.concat(condense(ops)).join("\n");
}

function lcsOps(a: string[], b: string[]): Array<[" " | "-" | "+", string]> {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops: Array<[" " | "-" | "+", string]> = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) ops.push([" ", a[i++]]), j++;
    else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push(["-", a[i++]]);
    else ops.push(["+", b[j++]]);
  }
  while (i < n) ops.push(["-", a[i++]]);
  while (j < m) ops.push(["+", b[j++]]);
  return ops;
}

function prefixSuffixOps(a: string[], b: string[]): Array<[" " | "-" | "+", string]> {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const ops: Array<[" " | "-" | "+", string]> = [];
  for (let i = 0; i < p; i++) ops.push([" ", a[i]]);
  for (let i = p; i < a.length - s; i++) ops.push(["-", a[i]]);
  for (let i = p; i < b.length - s; i++) ops.push(["+", b[i]]);
  for (let i = a.length - s; i < a.length; i++) ops.push([" ", a[i]]);
  return ops;
}

/** keep only changed lines plus `ctx` lines of surrounding context. */
function condense(ops: Array<[" " | "-" | "+", string]>, ctx = 3): string[] {
  const keep = new Array(ops.length).fill(false);
  ops.forEach(([k], i) => {
    if (k === " ") return;
    for (let d = -ctx; d <= ctx; d++) if (i + d >= 0 && i + d < ops.length) keep[i + d] = true;
  });
  const out: string[] = [];
  let gap = false;
  ops.forEach(([k, line], i) => {
    if (keep[i]) { if (gap) { out.push("@@"); gap = false; } out.push(k + line); }
    else if (out.length) gap = true;
  });
  return out.length ? out : ["@@", " (no textual change)"];
}

function main(): void {
  let opts: Opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(`error: ${e instanceof Error ? e.message : e}\n\n${HELP}`); process.exitCode = 2; return; }
  if (opts.help) { process.stdout.write(HELP); return; }
  const cwd = process.cwd();

  console.log(bold("\nprecedence-wizard\n"));

  // 1. preconditions
  if (!isGitRepo(cwd)) {
    console.error("error: not a git repository. Run this inside your project's repo.");
    process.exitCode = 2;
    return;
  }
  console.log(`  git: on ${dim(currentBranch(cwd) || "HEAD")}`);

  const project = detectProject(cwd);
  const plan = readPlan(cwd) as Plan | null;
  if (!plan) {
    console.log(`  framework: ${project.framework === "unknown" ? dim("not detected (scanning anyway)") : project.framework}`);
    console.log(`  scanning: ${project.srcDirs.join(", ")}`);
    const { catalog, fileCount } = scan(cwd, project, { types: opts.types });
    const catalogFile = writeCatalog(cwd, catalog);
    console.log(`  ${cyan(catalogFile)}`);
    console.log(`  ${fileCount} file(s), ${catalog.elements.length} element(s), ${catalog.attachPoints} attach point(s)`);
    if (!catalog.attachPoints) { console.log(yellow("\n  nothing trackable found — nothing to pick.")); return; }
    if (opts.ci) {
      const draft = writeDraftPlan(cwd, catalog);
      console.log(`\n  wrote draft ${cyan(draft)} — edit it, commit it, then preview.`);
      return;
    }
    console.log(bold("\n  browser picker: define the shared event vocabulary"));
    console.log("  Growth/marketing: select outcomes, name them, define what each means, and choose properties.");
    console.log(`  Export the plan to ${cyan(planPath(cwd))}, then commit that plan for engineering review.`);
    if (opts.open) launchViewer(catalogFile);
    return;
  }

  const events = Array.isArray(plan.events) ? plan.events.length : 0;
  console.log(`  plan: ${cyan(planPath(cwd))} — ${events} event(s)`);
  if (opts.emit === "direct" && !opts.track) {
    console.log(yellow("\n  next: preview the source diff this plan produces."));
    console.log(`  ${cyan('npx @precedence/wizard --track "track from @/lib/analytics"')}`);
    console.log(dim("  (--track names the import for the generated calls; --emit runtime skips it)"));
    process.exitCode = 2;
    return;
  }
  const instrumentOpts = { track: opts.track, emit: opts.emit, types: opts.types } as const;
  const proposed = preview(cwd, project, plan, instrumentOpts);
  const changed = proposed.files.filter((f) => f.before !== f.after);
  console.log(bold("\n  proposed instrumentation (nothing written):"));
  proposed.warnings.forEach((w) => console.log(yellow(`  ! ${w.detail}`)));
  proposed.skipped.forEach((s) => console.log(yellow(`  - ${s.id || s.event}: ${s.reason}`)));
  changed.forEach((f) => console.log("\n" + previewDiff(f.file, f.before, f.after)));
  if (proposed.runtimeModule) console.log(dim("\n  Links/bare buttons need a generated listener: pass --runtime src/pm-tracking.ts when applying."));
  if (!opts.apply) { console.log(`\n  review the diff, then rerun with ${cyan("--apply")}.`); return; }
  if (!opts.allowDirty && !isCleanForApply(cwd)) {
    console.error("\nerror: commit the reviewed plan and any source changes before --apply (generated .precedence/catalog.pcs is allowed). Pass --allow-dirty only to override.");
    process.exitCode = 1;
    return;
  }

  const result = apply(cwd, project, plan, instrumentOpts);
  if (opts.runtime && result.runtimeModule) {
    const output = path.resolve(opts.runtime);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, result.runtimeModule);
    console.log(`\n  wrote delegated listener ${cyan(output)}`);
  }

  if (result.changed.length) {
    console.log(`\n  ${bold(String(result.applied))} call(s) applied across ${result.changed.length} file(s):`);
    for (const f of result.changed) console.log(`    ${cyan(f)}`);
  } else {
    console.log("\n  nothing changed (already instrumented, or nothing in the plan resolved).");
  }
  if (result.warnings.length) {
    console.log(yellow(`\n  ${result.warnings.length} drift warning(s):`));
    for (const w of result.warnings) console.log(`    ${w.detail}`);
  }
  if (result.skipped.length) {
    console.log(yellow(`\n  ${result.skipped.length} anchor(s) skipped:`));
    for (const s of result.skipped) console.log(`    ${s.id ? s.id + ": " : ""}${s.reason}`);
  }
  if (result.changed.length) console.log(`\n  ${bold("next")}: review with \`git diff\`, then commit.`);
  if (opts.emit === "runtime") console.log(dim("\n  Runtime mode also needs installPrecedence({ track, planUrl }) at your app root and the committed plan deployed to that URL."));
}

if (require.main === module) main();
export { main, parseArgs, previewDiff };
