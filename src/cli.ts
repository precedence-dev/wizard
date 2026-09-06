#!/usr/bin/env node
/**
 * `precedence-wizard`: one command, from a bare repo to instrumented code.
 * Checks preconditions, authenticates, does the work, shows exactly what
 * changed, leaves a manual fallback wherever automation can't run yet.
 *
 * Two genuine stand-ins, not finished:
 *   - auth: there's no registry/account backend yet. `core` is depended on
 *     as a local `file:` sibling for now (see README) instead of fetched
 *     post-login.
 *   - @precedence/sdk isn't published anywhere yet, so the dependency
 *     this adds to your package.json is real but `npm install` won't
 *     resolve it until it is.
 * Everything else — git preconditions, the scan, wiring <PrecedenceDevtools />
 * into app/layout.tsx, wiring the stamp loader into next.config, launching
 * the picker, applying a plan — is real.
 */
import { isGitRepo, isClean, currentBranch } from "./git";
import { detectProject } from "./detect";
import { scan, writeCatalog, publishCatalogForDevtools } from "./scan";
import { readPlan, writeDraftPlan, writePlan, planPath } from "./plan";
import { runPicker } from "./pick";
import { wireDevtools, addDevtoolsDependency, SNIPPET, wireStampLoader, STAMP_SNIPPET } from "./wire";
import { apply } from "./apply";
import type { Plan } from "@precedence/instrument";

const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

interface Opts { allowDirty: boolean; track?: string; types: boolean; ci: boolean; devUrl: string; help: boolean; }

function parseArgs(argv: string[]): Opts {
  const o: Opts = { allowDirty: false, types: false, ci: false, devUrl: "http://localhost:3000", help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--allow-dirty") o.allowDirty = true;
    else if (a === "--types") o.types = true;
    else if (a === "--ci") o.ci = true;
    else if (a === "--track") o.track = argv[++i];
    else if (a === "--dev-url") o.devUrl = argv[++i];
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
  --dev-url <url>   your running dev server (default http://localhost:3000)
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

  let plan = readPlan(cwd) as Plan | null;
  if (!plan && opts.ci) {
    const draft = writeDraftPlan(cwd, catalog);
    console.log(yellow(`\n  --ci: wrote a draft plan instead of opening the picker:`));
    console.log(`  ${cyan(draft)}`);
    console.log(`  Edit it, then run again (without --ci to apply, or with --ci once it's ready).`);
    return;
  }

  // 5. wire <PrecedenceDevtools /> + the stamp loader into the app, then pick outcomes
  if (!plan) {
    const wire = wireDevtools(cwd);
    if (!wire.applied) {
      console.log(yellow(`\n  couldn't auto-wire the devtools panel (${wire.reason}).`));
      console.log(`  Add this once, by hand:\n`);
      for (const line of SNIPPET.split("\n")) console.log(`    ${line}`);
      console.log(`\n  Then run this again to pick outcomes.`);
      return;
    }
    const wiredDevtoolsNow = wire.reason !== "already wired";
    if (wiredDevtoolsNow) {
      addDevtoolsDependency(cwd);
      console.log(`\n  wired ${cyan("<PrecedenceDevtools />")} into ${cyan(wire.file!)}`);
    }

    const stamp = wireStampLoader(cwd);
    if (!stamp.applied) {
      console.log(yellow(`\n  couldn't auto-wire the stamp loader (${stamp.reason}).`));
      console.log(`  It's optional — the picker still works via React's dev-mode fiber, except on Next.js's`);
      console.log(`  default SWC compiler or React 19. Add this once, by hand, for those:\n`);
      for (const line of STAMP_SNIPPET.split("\n")) console.log(`    ${line}`);
    } else if (stamp.reason !== "already wired") {
      console.log(`  wired the stamp loader into ${cyan(stamp.file!)}`);
    }

    if (wiredDevtoolsNow) {
      console.log(yellow(`\n  @precedence/sdk isn't published anywhere yet, so \`npm install\` won't resolve it until it is — see this repo's README.`));
      console.log(`  Once it resolves: npm install, restart your dev server, then run this again to pick outcomes.`);
      return;
    }
    if (stamp.applied && stamp.reason !== "already wired") {
      console.log(`\n  Restart your dev server (a build config changed), then run this again to pick outcomes.`);
      return;
    }

    const catalogPath = publishCatalogForDevtools(cwd, catalog);
    if (!catalogPath) {
      console.log(yellow("\n  no public/ dir found — couldn't publish catalog.pcs for the devtools panel to fetch. Create one and run again."));
      return;
    }
    console.log(`  published ${cyan(catalogPath)}`);

    plan = (await runPicker(opts.devUrl)) as Plan;
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
