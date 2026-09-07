/**
 * @precedence/wizard invariants: git preconditions, project detection, the
 * in-process scan, the --ci draft-plan scaffold, and apply — end to end against
 * a throwaway git repo. The only stub is auth (see README); nothing to test
 * there yet. The wizard modifies nothing in the target app.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (p) => pathToFileURL(path.resolve(here, "../dist", p)).href;

const { isGitRepo, isClean, isCleanForApply } = await import(dist("git.js"));
const { detectProject, collectFiles } = await import(dist("detect.js"));
const { scan, writeCatalog } = await import(dist("scan.js"));
const { scaffoldPlan, writeDraftPlan, readPlan, planPath, catalogPath } = await import(dist("plan.js"));
const { apply } = await import(dist("apply.js"));
const { parseArgs, previewDiff } = await import(dist("cli.js"));

let fails = 0;
const check = (name, ok, detail) => {
  console.log((ok ? "  ok   " : "  FAIL ") + name + (ok || !detail ? "" : "\n         " + detail));
  if (!ok) fails++;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pm-wizard-"));
const run = (args) => execFileSync("git", args, { cwd: tmp, encoding: "utf8" });

const FIXTURE = `import { useState } from "react";
export function Checkout({ user }: { user: { id: string } | null }) {
  const [note, setNote] = useState("");
  async function onSubmit() {
    if (!user) { alert("sign in first"); return; }
    const result = await chargeCard();
    if (result.ok) { setNote("done"); } else { setNote("failed"); }
  }
  return <form onSubmit={onSubmit}><button>Pay</button></form>;
}
declare function chargeCard(): Promise<{ ok: boolean; receiptUrl?: string }>;
`;

/* ---- git preconditions, against a real repo ---- */
check("git: an uninitialised directory is not a git repo", !isGitRepo(fs.mkdtempSync(path.join(os.tmpdir(), "pm-notgit-"))));

run(["init", "-q"]);
run(["config", "user.email", "t@t.com"]);
run(["config", "user.name", "t"]);
check("git: an initialised repo is recognised", isGitRepo(tmp));
check("git: a fresh repo with nothing to commit is clean", isClean(tmp));

fs.mkdirSync(path.join(tmp, "src"));
fs.writeFileSync(path.join(tmp, "src", "Checkout.tsx"), FIXTURE);
fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ dependencies: { react: "^18.0.0" } }));
check("git: an untracked file makes the tree dirty", !isClean(tmp));

run(["add", "-A"]);
run(["commit", "-q", "-m", "init"]);
check("git: after committing, the tree is clean again", isClean(tmp));

/* ---- detection ---- */
const project = detectProject(tmp);
check("detect: package.json with a react dependency -> framework: react", project.framework === "react");
check("detect: an existing src/ dir is used, not the repo root", project.srcDirs.includes("src") && !project.srcDirs.includes("."));
const files = collectFiles(path.join(tmp, "src"));
check("detect: finds the .tsx fixture, skips node_modules/.git implicitly", files.length === 1 && files[0].endsWith("Checkout.tsx"));

/* ---- scan: the real analyzer, run in-process ---- */
const { catalog, fileCount } = scan(tmp, project, {});
check("scan: analyzed exactly the one fixture file", fileCount === 1);
check("scan: found the guard branch (!user) and the result.ok outcome",
  catalog.attachPoints > 0 &&
    catalog.elements.some((e) => e.actions.some((a) => a.branches.some((b) => /ok/.test(b.conditionKey)))),
  JSON.stringify(catalog.elements.map((e) => e.actions.map((a) => a.branches.map((b) => b.conditionKey)))));
const catalogFile = writeCatalog(tmp, catalog);
check("scan: writes .precedence/catalog.pcs, valid JSON", catalogFile === catalogPath(tmp) && JSON.parse(fs.readFileSync(catalogFile, "utf8")).tool === "precedence");
const dotIgnore = fs.readFileSync(path.join(tmp, ".precedence", ".gitignore"), "utf8");
check("scan: drops a .precedence/.gitignore that ignores the catalog but not the plan",
  /(^|\n)catalog\.pcs\s*($|\n)/.test(dotIgnore) && !/plan\.json/.test(dotIgnore));
check("git: isCleanForApply tolerates the scan artifacts on an otherwise-committed tree",
  isCleanForApply(tmp));

/* ---- plan: scaffold from the real catalog (--ci, no picker) ---- */
check("plan: no plan.json yet -> readPlan returns null", readPlan(tmp) === null);
const draft = scaffoldPlan(catalog);
check("plan: scaffold produces at least one real anchor id from the catalog",
  draft.events.length > 0 && draft.events.every((e) => e.anchors[0].id.includes("#Checkout::")),
  JSON.stringify(draft));
const draftPath = writeDraftPlan(tmp, catalog);
check("plan: writes .precedence/plan.json a developer can hand-edit", draftPath === planPath(tmp) && fs.existsSync(draftPath));

/* ---- apply: instrument the fixture with a plan built from its own real anchor ---- */
const okAnchor = catalog.elements
  .flatMap((e) => e.actions)
  .flatMap((a) => a.branches)
  .find((b) => /ok/.test(b.conditionKey) && !/!/.test(b.conditionKey));
const plan = { events: [{ name: "checkout_ok", properties: [], anchors: [{ id: okAnchor.id, fingerprint: okAnchor.fingerprint }] }] };
const result = apply(tmp, project, plan, "track");
check("apply: instruments the real fixture in place, on disk",
  result.changed.length === 1 &&
    fs.readFileSync(path.join(tmp, "src", "Checkout.tsx"), "utf8").includes('track("checkout_ok"'),
  JSON.stringify(result));
check("apply: re-running is idempotent (already-instrumented, unchanged)",
  apply(tmp, project, plan, "track").changed.length === 0);

/* ---- isCleanForApply: source edits and an uncommitted plan both block --apply ---- */
fs.rmSync(planPath(tmp)); // the draft plan from earlier; start this section from just the source edit
check("git: a modified source file blocks --apply", !isCleanForApply(tmp));
run(["checkout", "--", "src/Checkout.tsx"]);
check("git: with the source reverted, the scan artifacts alone are fine again", isCleanForApply(tmp));
fs.writeFileSync(planPath(tmp), JSON.stringify(plan));
check("git: an uncommitted plan.json blocks --apply (it must be reviewed first)", !isCleanForApply(tmp));
fs.rmSync(planPath(tmp));

/* ---- parseArgs: the CLI's own contract ---- */
check("cli: --help is recognised, not rejected as an unknown option", parseArgs(["--help"]).help === true);
check("cli: -h too", parseArgs(["-h"]).help === true);
check("cli: --emit runtime is accepted", parseArgs(["--emit", "runtime"]).emit === "runtime");
check("cli: a bogus --emit value is rejected", (() => { try { parseArgs(["--emit", "sideways"]); return false; } catch { return true; } })());
check("cli: an unknown flag is rejected", (() => { try { parseArgs(["--nope"]); return false; } catch { return true; } })());
check("cli: --track carries its value", parseArgs(["--track", "track from @/lib/analytics"]).track === "track from @/lib/analytics");

/* ---- the published binary actually runs main() (not just when run directly) ---- */
{
  const bin = path.resolve(here, "../bin/precedence-wizard.js");
  let out = "", status = 0;
  try { out = execFileSync("node", [bin, "--help"], { encoding: "utf8" }); }
  catch (e) { out = (e.stdout || "") + (e.stderr || ""); status = e.status ?? 1; }
  check("cli: `precedence-wizard --help` via the bin wrapper prints usage and exits 0",
    status === 0 && /USAGE/.test(out) && /--track/.test(out), JSON.stringify({ status, out: out.slice(0, 120) }));
}

/* ---- previewDiff: the engineering-review surface ---- */
{
  const before = ["function onSubmit() {", "  if (!user) return;", "  charge();", "}"].join("\n");
  const after = ["function onSubmit() {", "  if (!user) return;", '  try { track("x", {}); } catch {}', "  charge();", "}"].join("\n");
  const d = previewDiff("src/Checkout.tsx", before, after);
  check("cli: previewDiff shows the inserted line as +, keeps unchanged lines as context, no phantom -",
    d.includes('+  try { track("x", {}); } catch {}')
      && d.includes(" function onSubmit() {")
      && !/\n-/.test(d)
      && d.startsWith("--- a/src/Checkout.tsx\n+++ b/src/Checkout.tsx\n"));

  // an import near the top + a call in the middle = two separate + blocks, not one replaced region
  const b2 = ["import a from 'a';", "", "function f() {", "  return g();", "}"].join("\n");
  const a2 = ["import a from 'a';", "import { track } from '@/x';", "", "function f() {", '  try { track("y"); } catch {}', "  return g();", "}"].join("\n");
  const body = previewDiff("src/f.ts", b2, a2).split("\n").slice(2); // drop the --- / +++ header
  check("cli: previewDiff keeps two insertions as two + lines with no deletions",
    body.filter((l) => l.startsWith("+")).length === 2 && body.filter((l) => l.startsWith("-")).length === 0,
    body.join("\n"));
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(fails ? `\n${fails} FAILED` : "\nall invariants hold");
process.exit(fails ? 1 : 0);
