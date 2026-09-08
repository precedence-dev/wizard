#!/usr/bin/env node
/**
 * `precedence-wizard`: scan a project, open the picker, preview, then apply.
 *
 *   npx @precedence/wizard                    # scan -> open @precedence/viewer
 *   # ...pick outcomes, save .precedence/plan.json...
 *   npx @precedence/wizard --track "<spec>"           # preview the source diff
 *   npx @precedence/wizard --track "<spec>" --apply   # write it
 *
 *   npx @precedence/wizard --ci     # scan -> scaffold a draft plan.json to hand-edit
 *
 * Framework-agnostic and VCS-agnostic: it reads and writes plain files, the
 * scan runs the real analyzer in-process, picking happens in the standalone
 * viewer, applying is @precedence/instrument. --apply is a separate step from
 * the preview, so it's on you to have committed first if you want that.
 *
 * Until the packages are on npm, @precedence/cli / instrument / viewer are local
 * `file:` siblings (see README). All Apache-2.0.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { detectProject, type ProjectInfo } from "./detect";
import { scan, writeCatalog } from "./scan";
import { readPlan, writeDraftPlan, planPath } from "./plan";
import { pick, bakePicker } from "./pick";
import * as wire from "./wire";
import { apply, preview, type WizardInstrumentOpts } from "./apply";
import type { Plan } from "@precedence/instrument";

const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

interface Opts {
  apply: boolean;
  yes: boolean;
  track?: string;
  emit: "direct" | "runtime";
  runtime?: string;
  types: boolean;
  ci: boolean;
  serve: boolean;
  open: boolean;
  app?: string;
  help: boolean;
}

/** one option's effect on `o`; `next()` yields (and consumes) its value argument. */
type OptHandler = (o: Opts, next: () => string) => void;

const OPTIONS = new Map<string, OptHandler>([
  ["-h", (o) => { o.help = true; }],
  ["--help", (o) => { o.help = true; }],
  ["--apply", (o) => { o.apply = true; }],
  ["-y", (o) => { o.yes = true; }],
  ["--yes", (o) => { o.yes = true; }],
  ["--types", (o) => { o.types = true; }],
  ["--ci", (o) => { o.ci = true; }],
  ["--serve", (o) => { o.serve = true; }],
  ["--no-serve", (o) => { o.serve = false; }],
  ["--open", (o) => { o.open = true; }],
  ["--no-open", (o) => { o.open = false; }],
  ["--app", (o, next) => { o.app = next(); }],
  ["--track", (o, next) => { o.track = next(); }],
  ["--runtime", (o, next) => { o.runtime = next(); }],
  ["--emit", (o, next) => {
    const v = next();
    if (v !== "direct" && v !== "runtime") throw new Error("--emit must be direct or runtime");
    o.emit = v;
  }],
]);

function parseArgs(argv: string[]): Opts {
  const o: Opts = { apply: false, yes: false, emit: "direct", types: false, ci: false, serve: true, open: true, help: false };
  const cur = { i: 0 };
  const next = (a: string): string => {
    const v = argv[++cur.i];
    if (!v) throw new Error(`missing value for ${a}`);
    return v;
  };
  for (cur.i = 0; cur.i < argv.length; cur.i++) {
    const a = argv[cur.i];
    const handler = OPTIONS.get(a);
    if (handler) handler(o, () => next(a));
    else if (a.startsWith("-")) throw new Error(`unknown option: ${a}`);
  }
  return o;
}

const HELP = `precedence-wizard: scan a project, pick outcomes, instrument them

USAGE
  npx @precedence/wizard --track "track from @/lib/analytics"
      scan, open the picker, and print the diff when you send it back
  npx @precedence/wizard --track "track from @/lib/analytics" --apply
      ...and write it (asks first when run interactively)

OPTIONS
  --track <spec>    required for direct mode; e.g. "track from @/lib/analytics"
  --emit <mode>     direct (default) or runtime
  --runtime <file>  direct mode: write delegated-link listener here on --apply
  --apply           write source after the preview
  -y, --yes         skip the "apply?" confirmation
  --types           resolve declared types (slower, enables interprocedural outcomes)
  --app <url>        your running dev server (default: guessed from package.json)
  --ci              non-interactive: write a draft plan.json instead of the pick step
  --no-serve        bake a static picker to export by hand instead of serving it
  --no-open         don't launch a browser
  -h, --help
`;

/** non-Next: the picker's one-time bundler wiring (Next goes through wire.ts) */
function stampLoaderHint(_framework: string): string {
  return [
    "  the picker resolves clicks via @precedence/cli/stamp-loader — wire it into",
    "  your bundler for *.jsx/*.tsx (dev only) and load precedencePicker() from",
    "  @precedence/sdk at startup, then restart.",
  ].join("\n");
}

function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(/^y(es)?$/i.test(a.trim())); }));
}

/** A unified-ish diff for the preview: LCS over lines so an inserted import and
 *  an inserted call each read as their own `+` block, not one replaced region.
 *  Prefix/suffix fallback on huge files (the real review is the on-disk diff
 *  after --apply either way). */
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

type ChangedFile = ReturnType<typeof preview>["files"][number];

/** framework-specific one-time wiring hints. false = a blocker was printed, stop. */
function printWiringHint(cwd: string, project: ProjectInfo): boolean {
  if (project.framework !== "next") {
    console.log(stampLoaderHint(project.framework));
    return true;
  }
  if (!wire.hasSdk(cwd)) {
    console.log(yellow("  install @precedence/sdk and @precedence/cli, then re-run:"));
    console.log(`    ${cyan("npm i @precedence/sdk @precedence/cli")}`);
    return false;
  }
  const ic = wire.instrumentationClient(cwd);
  console.log(ic.status === "created" ? `  wrote ${cyan(ic.file)} (loads the picker in dev)`
    : ic.status === "present" ? `  ${dim(ic.file + " already loads the picker")}`
    : yellow(`  ${ic.file} exists — add a \`precedencePicker()\` call to it`));
  const nc = wire.nextConfig(cwd);
  if (!nc.wired) {
    console.log("");
    console.log(wire.wrapHint(nc.file));
    console.log(dim("\n  ...then restart your dev server (Next reads next.config once)."));
  }
  return true;
}

/** Serve the picker (or bake it / scaffold a draft) and wait for the browser to
 *  send a plan back. null = handled here, nothing more for main() to do. */
async function scanThenPick(cwd: string, project: ProjectInfo, opts: Opts): Promise<Plan | null> {
  console.log(`  framework: ${project.framework === "unknown" ? dim("not detected (scanning anyway)") : project.framework}`);
  console.log(`  scanning: ${project.srcDirs.join(", ")}`);
  const { catalog, fileCount } = scan(cwd, project, { types: opts.types });
  const catalogFile = writeCatalog(cwd, catalog);
  console.log(`  ${cyan(catalogFile)}`);
  console.log(`  ${fileCount} file(s), ${catalog.elements.length} element(s), ${catalog.attachPoints} attach point(s)`);
  if (!catalog.attachPoints) { console.log(yellow("\n  nothing trackable found — nothing to pick.")); return null; }

  if (opts.ci) {
    const draft = writeDraftPlan(cwd, catalog);
    console.log(`\n  wrote draft ${cyan(draft)} — edit it, then re-run with --track.`);
    return null;
  }
  if (!opts.serve) {
    const html = bakePicker(cwd, catalog, { open: opts.open });
    console.log(`\n  picker baked: ${cyan(html)}`);
    console.log(`  pick outcomes, export to ${cyan(planPath(cwd))}, then re-run.`);
    return null;
  }

  const devUrl = opts.app || project.devUrl;
  console.log("");
  if (!printWiringHint(cwd, project)) return null;

  console.log(dim(`\n  waiting for your app at ${devUrl} ...`));
  if (!(await wire.waitForServer(devUrl))) {
    console.log(yellow(`  not reachable — start your dev server and re-run (or --app <url>).`));
    return null;
  }
  console.log("");
  const picked = await pick(cwd, catalog, { devUrl, open: opts.open });
  const n = Array.isArray(picked.plan.events) ? picked.plan.events.length : 0;
  if (!n) { console.log(yellow("\n  nothing sent from the picker — no events to instrument.")); return null; }
  console.log(`  received ${bold(String(n))} event(s) → ${cyan(picked.path)}`);
  return picked.plan as Plan;
}

/** An existing plan.json, else the scan → pick flow. null = nothing more to do. */
async function resolvePlan(cwd: string, project: ProjectInfo, opts: Opts): Promise<Plan | null> {
  const existing = readPlan(cwd) as Plan | null;
  if (!existing) return scanThenPick(cwd, project, opts);
  const events = Array.isArray(existing.events) ? existing.events.length : 0;
  console.log(`  plan: ${cyan(planPath(cwd))} — ${events} event(s)`);
  return existing;
}

/** Print the proposed edits. Returns the changed files, or null when there's
 *  nothing to apply (message already printed). */
function previewPhase(cwd: string, project: ProjectInfo, plan: Plan, iOpts: WizardInstrumentOpts): ChangedFile[] | null {
  const proposed = preview(cwd, project, plan, iOpts);
  const changed = proposed.files.filter((f) => f.before !== f.after);
  console.log(bold("\n  proposed instrumentation (nothing written yet):"));
  proposed.warnings.forEach((w) => console.log(yellow(`  ! ${w.detail}`)));
  proposed.skipped.forEach((s) => console.log(yellow(`  - ${s.id || s.event}: ${s.reason}`)));
  changed.forEach((f) => console.log("\n" + previewDiff(f.file, f.before, f.after)));
  if (proposed.runtimeModule) console.log(dim("\n  Links/bare buttons need a generated listener: pass --runtime src/pm-tracking.ts when applying."));
  if (!changed.length) { console.log("\n  nothing to apply."); return null; }
  return changed;
}

/** --apply gate: the reviewed hint, then the interactive confirmation. */
async function shouldApply(opts: Opts, changedCount: number): Promise<boolean> {
  if (!opts.apply) { console.log(`\n  reviewed? re-run with ${cyan("--apply")}.`); return false; }
  if (opts.yes || !process.stdin.isTTY) return true;
  const ok = await confirm(`\n  apply ${changedCount} file change(s)? [y/N] `);
  if (!ok) console.log("  nothing written.");
  return ok;
}

/** a header line + an indented list, printed only when there's something to list. */
function logList(header: string, items: string[]): void {
  if (!items.length) return;
  console.log(header);
  for (const it of items) console.log(`    ${it}`);
}

function reportApplyResult(result: ReturnType<typeof apply>, opts: Opts): void {
  if (result.changed.length) {
    console.log(`\n  ${bold(String(result.applied))} call(s) applied across ${result.changed.length} file(s):`);
    for (const f of result.changed) console.log(`    ${cyan(f)}`);
  } else {
    console.log("\n  nothing changed (already instrumented, or nothing in the plan resolved).");
  }
  logList(yellow(`\n  ${result.warnings.length} drift warning(s):`), result.warnings.map((w) => w.detail));
  logList(yellow(`\n  ${result.skipped.length} anchor(s) skipped:`),
    result.skipped.map((s) => `${s.id ? s.id + ": " : ""}${s.reason}`));
  if (result.changed.length) console.log(`\n  ${bold("next")}: review the diff and commit it on its own.`);
  if (opts.emit === "runtime") console.log(dim("\n  Runtime mode also needs installPrecedence({ track, planUrl }) at your app root and the committed plan deployed to that URL."));
}

function applyPhase(cwd: string, project: ProjectInfo, plan: Plan, opts: Opts, iOpts: WizardInstrumentOpts): void {
  const result = apply(cwd, project, plan, iOpts);
  if (opts.runtime && result.runtimeModule) {
    const output = path.resolve(opts.runtime);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, result.runtimeModule);
    console.log(`\n  wrote delegated listener ${cyan(output)}`);
  }
  reportApplyResult(result, opts);
}

async function main(): Promise<void> {
  let opts: Opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(`error: ${e instanceof Error ? e.message : e}\n\n${HELP}`); process.exitCode = 2; return; }
  if (opts.help) { process.stdout.write(HELP); return; }

  const cwd = process.cwd();
  console.log(bold("\nprecedence-wizard\n"));
  const project = detectProject(cwd);

  const plan = await resolvePlan(cwd, project, opts);
  if (!plan) return;

  if (opts.emit === "direct" && !opts.track) {
    console.log(yellow("\n  next: preview the diff this plan produces."));
    console.log(`  ${cyan('npx @precedence/wizard --track "track from @/lib/analytics" --apply')}`);
    console.log(dim("  (--track names the import for the generated calls; --emit runtime skips it)"));
    process.exitCode = 2;
    return;
  }

  const iOpts: WizardInstrumentOpts = { track: opts.track, emit: opts.emit, types: opts.types };
  const changed = previewPhase(cwd, project, plan, iOpts);
  if (!changed) return;
  if (!(await shouldApply(opts, changed.length))) return;

  applyPhase(cwd, project, plan, opts, iOpts);
}

if (require.main === module) void main();
export { main, parseArgs, previewDiff };
