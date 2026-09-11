#!/usr/bin/env node
/**
 * `precedence-wizard`: scan a project, open the picker, preview, then apply.
 *
 *   npx @precedence-dev/wizard                    # scan -> open @precedence-dev/viewer
 *   # ...pick outcomes, save .precedence/plan.json...
 *   npx @precedence-dev/wizard --track "<spec>"           # preview the source diff
 *   npx @precedence-dev/wizard --track "<spec>" --apply   # write it
 *
 *   npx @precedence-dev/wizard --ci     # scan -> scaffold a draft plan.json to hand-edit
 *
 * Framework-agnostic and VCS-agnostic: it reads and writes plain files, the
 * scan runs the real analyzer in-process, picking happens in the standalone
 * viewer, applying is @precedence-dev/instrument. --apply is a separate step from
 * the preview, so it's on you to have committed first if you want that.
 *
 * @precedence-dev/cli / instrument / viewer are normal semver deps from npm.
 * All FSL-1.1-ALv2 (each release converts to Apache-2.0 two years after it ships).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { detectProject, type ProjectInfo } from "./detect";
import { scan, writeCatalog } from "./scan";
import { readPlan, writeDraftPlan, planPath } from "./plan";
import { pick } from "./pick";
import * as wire from "./wire";
import { apply, preview, type WizardInstrumentOpts } from "./apply";
import type { Plan } from "@precedence-dev/instrument";
import { pushCatalog } from "./client";
import { DEFAULT_SERVER, resolveConfig, saveApiKey, serverOrigin, writeProjectConfig, type ServerClient } from "./config";

const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

interface Opts {
  apply: boolean;
  yes: boolean;
  track?: string;
  delegated?: string;
  dirs: string[];
  types: boolean;
  ci: boolean;
  open: boolean;
  app?: string;
  server?: string;
  apiKey?: string;
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
  ["--open", (o) => { o.open = true; }],
  ["--no-open", (o) => { o.open = false; }],
  ["--app", (o, next) => { o.app = next(); }],
  ["--dir", (o, next) => { o.dirs.push(next()); }],
  ["--track", (o, next) => { o.track = next(); }],
  ["--delegated", (o, next) => { o.delegated = next(); }],
  ["--server", (o, next) => { o.server = next(); }],
  ["--api-key", (o, next) => { o.apiKey = next(); }],
]);

function parseArgs(argv: string[]): Opts {
  const o: Opts = { apply: false, yes: false, dirs: [], types: false, ci: false, open: true, help: false };
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
  npx @precedence-dev/wizard
      scan, open the picker, and print the diff when you send it back
  npx @precedence-dev/wizard --apply
      ...and write it (asks first when run interactively)

On a Next.js project the wizard installs @precedence-dev/sdk (+ -D
@precedence-dev/cli) with your package manager and wraps next.config with
withPrecedence — asking first, unless -y.

Picking outcomes always talks to a Precedence server (Cloud or your own BYOC
deployment) — paste an API key the first time you run it and it's remembered
per-server in ~/.precedence/auth.json. There's no fully-offline picker mode.

OPTIONS
  --dir <path>       source dir to scan, repeatable (default: auto — src / app /
                    pages / components, else the repo root). Use for monorepos.
  --track <spec>     override the call target (default: precedence.track from
                    @precedence-dev/sdk); e.g. "myTrack from @/lib/analytics"
  --delegated <file> write the synthetic-anchor listener here on --apply (links /
                    bare buttons only); import it once at your app root
  --apply           write source after the preview
  -y, --yes         skip the install + "apply?" confirmations
  --types           resolve declared types (slower, enables interprocedural outcomes)
  --app <url>        your running dev server (default: guessed from package.json)
  --server <url>     Precedence server (default: Cloud, or .precedence/config.json)
  --api-key <key>    project API key (default: PRECEDENCE_API_KEY, or the saved one)
  --ci              non-interactive: write a draft plan.json and push the catalog
  --no-open         don't launch a browser
  -h, --help
`;

/** non-Next: the picker's one-time bundler wiring (Next goes through wire.ts) */
function stampLoaderHint(_framework: string): string {
  return [
    "  wire the picker into your bundler (dev only):",
    "    - add @precedence-dev/cli/stamp-loader for *.jsx/*.tsx",
    "    - import { precedencePicker } from \"@precedence-dev/sdk\" and call it at startup",
    "  then restart your dev server.",
  ].join("\n");
}

/** Install the two packages the app imports, prompting first. Returns false when
 *  the user declines or the install fails (the caller prints the manual line). */
async function ensureDeps(cwd: string, project: ProjectInfo, opts: Opts): Promise<boolean> {
  const { deps, devDeps } = wire.missingDeps(cwd);
  if (!deps.length && !devDeps.length) return true;

  const lines = wire.installLines(project.pm, deps, devDeps);
  console.log(yellow(`\n  ${[...deps, ...devDeps].join(", ")} not installed in this project.`));
  const go = opts.yes || !process.stdin.isTTY || (await confirm(`  install now with ${project.pm}? [Y/n] `, true));
  if (!go) {
    lines.forEach((l) => console.log(`    ${cyan(l)}`));
    console.log(dim("  ...then re-run the wizard."));
    return false;
  }
  console.log("");
  if (!wire.installDeps(cwd, project.pm, deps, devDeps)) {
    console.log(yellow("\n  install failed — run it yourself:"));
    lines.forEach((l) => console.log(`    ${cyan(l)}`));
    return false;
  }
  return true;
}

function confirm(question: string, defaultYes = false): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => {
    rl.close();
    const t = a.trim();
    resolve(t === "" ? defaultYes : /^y(es)?$/i.test(t));
  }));
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

/** framework-specific one-time wiring. false = a blocker was printed, stop. */
async function printWiringHint(cwd: string, project: ProjectInfo, opts: Opts, client: ServerClient): Promise<boolean> {
  if (!(await ensureDeps(cwd, project, opts))) return false;

  if (project.framework !== "next") {
    console.log("");
    console.log(stampLoaderHint(project.framework));
    return true;
  }

  const ic = wire.instrumentationClient(cwd, new URL(client.server).hostname);
  console.log(ic.status === "created" ? `  wrote ${cyan(ic.file)} (loads the picker in dev)`
    : ic.status === "present" ? `  ${dim(ic.file + " already loads the picker")}`
    : yellow(`  ${ic.file} exists — add a \`precedencePicker()\` call to it`));

  const nc = wire.wrapNextConfig(cwd);
  if (nc.status === "wrapped") console.log(`  wrapped ${cyan(nc.file)} with withPrecedence`);
  else if (nc.status === "already") console.log(dim(`  ${nc.file} already wrapped`));
  else {
    console.log("");
    console.log(wire.wrapHint(nc.status === "none" ? null : nc.file));
  }

  if (ic.status === "created" || nc.status === "wrapped")
    console.log(dim("\n  restart your dev server — Next reads next.config + instrumentation-client once."));
  return true;
}

/** Push the catalog + (in --ci) scaffold a draft, or open a picker session and
 *  wait for the browser to send a plan back. null = handled here, nothing
 *  more for main() to do. */
async function scanThenPick(cwd: string, project: ProjectInfo, opts: Opts, client: ServerClient): Promise<Plan | null> {
  console.log(`  framework: ${project.framework === "unknown" ? dim("not detected (scanning anyway)") : project.framework}`);
  console.log(`  scanning: ${project.srcDirs.join(", ")}`);
  const { catalog, fileCount } = scan(cwd, project, { types: opts.types });
  const catalogFile = writeCatalog(cwd, catalog);
  console.log(`  ${cyan(catalogFile)}`);
  console.log(`  ${fileCount} file(s), ${catalog.elements.length} element(s), ${catalog.attachPoints} attach point(s)`);
  if (!catalog.attachPoints) { console.log(yellow("\n  nothing trackable found — nothing to pick.")); return null; }

  if (opts.ci) {
    try {
      await pushCatalog(client, { blob: catalog });
      console.log(`  pushed catalog to ${cyan(client.server)}`);
    } catch (e) {
      console.log(yellow(`  ! couldn't push the catalog: ${e instanceof Error ? e.message : e}`));
    }
    const draft = writeDraftPlan(cwd, catalog);
    console.log(`\n  wrote draft ${cyan(draft)} — edit it down to the events you want, then re-run.`);
    return null;
  }

  const devUrl = opts.app || project.devUrl;
  if (!(await printWiringHint(cwd, project, opts, client))) return null;

  console.log(dim(`\n  waiting for your app at ${devUrl} ...`));
  if (!(await wire.waitForServer(devUrl))) {
    console.log(yellow(`  not reachable — start your dev server and re-run (or --app <url>).`));
    return null;
  }
  console.log("");
  const picked = await pick(cwd, catalog, { devUrl, open: opts.open, client });
  const n = Array.isArray(picked.plan.events) ? picked.plan.events.length : 0;
  if (!n) { console.log(yellow("\n  nothing sent from the picker — no events to instrument.")); return null; }
  console.log(`  received ${bold(String(n))} event(s) → ${cyan(picked.path)}`);
  return picked.plan as Plan;
}

/** An existing plan.json, else the scan → pick flow. null = nothing more to do.
 *  When a plan exists, offer the picker anyway (seeded with it) so you can see
 *  what's tracked and add more — default is to use it as-is. */
async function resolvePlan(cwd: string, project: ProjectInfo, opts: Opts, client: ServerClient): Promise<Plan | null> {
  const existing = readPlan(cwd) as Plan | null;
  if (!existing) return scanThenPick(cwd, project, opts, client);

  const events = Array.isArray(existing.events) ? existing.events.length : 0;
  console.log(`  plan: ${cyan(planPath(cwd))} — ${events} event(s)`);

  const canPick = !opts.ci && process.stdin.isTTY;
  if (canPick && (await confirm("  open the picker to review / add to it? [y/N] "))) {
    return scanThenPick(cwd, project, opts, client); // pick() seeds from the plan on disk and returns the merged result
  }
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
  if (proposed.delegatedModule) console.log(dim("\n  Links / bare buttons need a generated listener: pass --delegated src/pm-tracking.ts when applying."));
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

function reportApplyResult(result: ReturnType<typeof apply>, client: ServerClient): void {
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
  console.log(dim(
    "\n  Then call installPrecedence({ endpoint: \"<your collector>\", planUrl: \"" + client.server.replace(/\/$/, "") +
    "/v1/plan\", planToken: \"<api key>\" }) once at your app root" +
    "\n  (omit endpoint to console.debug in dev; planUrl/planToken let you retune events without a rebuild).",
  ));
}

function applyPhase(cwd: string, project: ProjectInfo, plan: Plan, opts: Opts, iOpts: WizardInstrumentOpts, client: ServerClient): void {
  const result = apply(cwd, project, plan, iOpts);
  if (opts.delegated && result.delegatedModule) {
    const output = path.resolve(opts.delegated);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, result.delegatedModule);
    console.log(`\n  wrote delegated listener ${cyan(output)}`);
  }
  reportApplyResult(result, client);
}

/** Picking outcomes always needs a server — no fully-offline mode. Resolve
 *  --server/--api-key/env/config, and when no key is found, ask for one
 *  interactively (saved for next time) or fail fast with instructions in CI. */
async function resolveServerClient(cwd: string, opts: Opts): Promise<ServerClient | null> {
  const resolved = resolveConfig(cwd, { server: opts.server, apiKey: opts.apiKey });
  if (resolved.apiKey) return { server: resolved.server, apiKey: resolved.apiKey };

  if (!process.stdin.isTTY) {
    console.error(
      `error: no Precedence API key configured for ${resolved.server}\n\n` +
      "  set PRECEDENCE_API_KEY (and PRECEDENCE_SERVER for a BYOC deployment), or pass\n" +
      "  --api-key <key> [--server <url>]. Create a project + key with:\n" +
      "    npm run create-project -- \"<name>\"   (in your @precedence-dev/server checkout)\n",
    );
    process.exitCode = 2;
    return null;
  }

  console.log(yellow(`\n  no API key found for ${resolved.server}.`));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const apiKey = await new Promise<string>((resolve) =>
    rl.question("  paste your Precedence API key (from your project settings): ", (a) => { rl.close(); resolve(a.trim()); }));
  if (!apiKey) { console.error("error: an API key is required — nothing else to do."); process.exitCode = 2; return null; }

  saveApiKey(resolved.server, apiKey);
  if (!resolved.serverExplicit) console.log(dim(`  using the default server (${DEFAULT_SERVER}) — pass --server for BYOC.`));
  else if (serverOrigin(resolved.server) !== serverOrigin(DEFAULT_SERVER)) writeProjectConfig(cwd, { server: resolved.server });
  console.log(dim(`  saved to ~/.precedence/auth.json — won't ask again for this server.\n`));
  return { server: resolved.server, apiKey };
}

async function main(): Promise<void> {
  let opts: Opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(`error: ${e instanceof Error ? e.message : e}\n\n${HELP}`); process.exitCode = 2; return; }
  if (opts.help) { process.stdout.write(HELP); return; }

  const cwd = process.cwd();
  console.log(bold("\nprecedence-wizard\n"));

  const client = await resolveServerClient(cwd, opts);
  if (!client) return;

  const project = detectProject(cwd);
  if (opts.dirs.length) project.srcDirs = opts.dirs;   // --dir overrides auto-detection (monorepos, non-standard layouts)

  const plan = await resolvePlan(cwd, project, opts, client);
  if (!plan) return;

  const iOpts: WizardInstrumentOpts = { track: opts.track, types: opts.types };
  const changed = previewPhase(cwd, project, plan, iOpts);
  if (!changed) return;
  if (!(await shouldApply(opts, changed.length))) return;

  applyPhase(cwd, project, plan, opts, iOpts, client);
}

if (require.main === module) void main();
export { main, parseArgs, previewDiff };
