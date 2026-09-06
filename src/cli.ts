#!/usr/bin/env node
/**
 * `precedence-wizard`: one command, from a bare repo to instrumented code.
 * Same shape as @sentry/wizard and @posthog/wizard: check preconditions,
 * authenticate, do the work, show exactly what changed, leave a manual
 * fallback wherever automation can't run yet.
 *
 * One step here is a genuine stand-in, not finished:
 *   - auth: there's no registry/account backend yet. `core` is depended on
 *     as a local `file:` sibling for now (see README) instead of fetched
 *     post-login.
 * The picker (src/pick.ts) is real, but it's the "file-scoped pick one"
 * fallback @precedence/cli's README already documents, not click-on-the-page
 * DOM picking — that needs either the stamp loader wired into the target's
 * bundler config or React's dev-mode fiber, and this wizard doesn't touch
 * either yet. --ci skips the browser entirely and writes the same kind of
 * draft plan.json a human would produce by hand, for scripted/CI runs.
 * Everything else (git preconditions, the scan, applying a plan) is real.
 */
import { isGitRepo, isClean, currentBranch } from "./git";
import { detectProject } from "./detect";
import { scan, writeCatalog } from "./scan";
import { readPlan, writeDraftPlan, writePlan, planPath } from "./plan";
import { runPicker } from "./pick";
import { apply } from "./apply";
import type { Plan } from "@precedence/instrument";

const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

interface Opts { allowDirty: boolean; track?: string; types: boolean; ci: boolean; help: boolean; }

function parseArgs(argv: string[]): Opts {
  const o: Opts = { allowDirty: false, types: false, ci: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--allow-dirty") o.allowDirty = true;
    else if (a === "--types") o.types = true;
    else if (a === "--ci") o.ci = true;
    else if (a === "--track") o.track = argv[++i];
    else if (a === "-h" || a === "--help") o.help = true;
  }
  return o;
}

const HELP = `precedence-wizard: scan a repo, pick outcomes, instrument them

USAGE
  npx @precedence/wizard [options]

OPTIONS
  --allow-dirty     proceed with uncommitted changes present
  --types           resolve declared types (slower, enables interprocedural outcomes)
  --track <spec>    "track from @/lib/analytics" adds the import; default console.log
  --ci              non-interactive: write a draft plan.json instead of opening the picker
  -h, --help
`;

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { process.stdout.write(HELP); return; }
  const cwd = process.cwd();

  console.log(bold("\nprecedence-wizard\n"));

  // 1. preconditions
  if (!isGitRepo(cwd)) {
    console.error("error: not a git repository. Run this inside your project's repo.");
    process.exitCode = 2;
    return;
  }
  if (!isClean(cwd) && !opts.allowDirty) {
    console.error("error: uncommitted changes present. Commit or stash first, or pass --allow-dirty.");
    console.error("       (this keeps every wizard run in its own reviewable commit)");
    process.exitCode = 2;
    return;
  }
  console.log(`  git: on ${dim(currentBranch(cwd) || "HEAD")}, tree clean`);

  const project = detectProject(cwd);
  console.log(`  framework: ${project.framework === "unknown" ? dim("not detected (scanning anyway)") : project.framework}`);
  console.log(`  scanning: ${project.srcDirs.join(", ")}`);

  // 2. auth (stub — no registry/account backend exists yet)
  console.log(dim("\n  auth: skipped — no account backend yet, using the local @precedence/cli sibling"));

  // 3 + 4. scan
  console.log("\n  running the analyzer...");
  const { catalog, fileCount } = scan(cwd, project, { types: opts.types });
  const catalogFile = writeCatalog(cwd, catalog);
  console.log(`  ${cyan(catalogFile)}`);
  console.log(`  ${fileCount} file(s), ${catalog.elements.length} element(s), ${catalog.attachPoints} attach point(s)`);

  if (catalog.attachPoints === 0) {
    console.log(yellow("\n  nothing trackable found — nothing to pick, stopping here."));
    return;
  }

  // 5. pick outcomes
  let plan = readPlan(cwd) as Plan | null;
  if (!plan) {
    if (opts.ci) {
      const draft = writeDraftPlan(cwd, catalog);
      console.log(yellow(`\n  --ci: wrote a draft plan instead of opening the picker:`));
      console.log(`  ${cyan(draft)}`);
      console.log(`  Edit it, then run again (without --ci to apply, or with --ci once it's ready).`);
      return;
    }
    plan = (await runPicker(catalog)) as Plan;
    writePlan(cwd, plan);
    console.log(`  saved ${cyan(planPath(cwd))}`);
  }

  // 6. instrument
  console.log(`\n  applying ${dim(planPath(cwd))}...`);
  const result = apply(cwd, project, plan, opts.track);

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

  if (result.changed.length) {
    console.log(`\n  ${bold("next")}: review with \`git diff\`, then commit.`);
  }
}

if (require.main === module) main();
export { main };
