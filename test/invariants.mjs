/**
 * @precedence/wizard invariants: exercises the real, working pieces
 * (git preconditions, detection, scan, plan scaffold, apply) end to end
 * against a throwaway git repo. Skips the two stand-in steps (auth, picker)
 * since there's nothing real to test yet — see README.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (p) => pathToFileURL(path.resolve(here, "../dist", p)).href;

const { isGitRepo, isClean } = await import(dist("git.js"));
const { detectProject, collectFiles } = await import(dist("detect.js"));
const { scan, writeCatalog } = await import(dist("scan.js"));
const { scaffoldPlan, writeDraftPlan, readPlan } = await import(dist("plan.js"));
const { apply } = await import(dist("apply.js"));

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
check("scan: writes .precedence/catalog.pcs, valid JSON", JSON.parse(fs.readFileSync(catalogFile, "utf8")).tool === "precedence");

/* ---- plan: scaffold from the real catalog, since the picker doesn't exist yet ---- */
check("plan: no plan.json yet -> readPlan returns null", readPlan(tmp) === null);
const draft = scaffoldPlan(catalog);
check("plan: scaffold produces at least one real anchor id from the catalog",
  draft.events.length > 0 && draft.events.every((e) => e.anchors[0].id.includes("#Checkout::")),
  JSON.stringify(draft));
const draftPath = writeDraftPlan(tmp, catalog);
check("plan: writes .precedence/plan.json a developer can hand-edit", fs.existsSync(draftPath));

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

fs.rmSync(tmp, { recursive: true, force: true });

console.log(fails ? `\n${fails} FAILED` : "\nall invariants hold");
process.exit(fails ? 1 : 0);
