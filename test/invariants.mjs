/**
 * @precedence/wizard invariants: exercises the real, working pieces (git
 * preconditions, detection, scan, the picker server, plan scaffold, apply)
 * end to end against a throwaway git repo. The only stub is auth — see
 * README — there's nothing real to test there yet.
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
const { startPickServer, fiberSource, findElement } = await import(dist("pick.js"));

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

/* ---- resolution algorithm: the exact functions shipped into the browser overlay ---- */
{
  // a fake DOM node with a React-style fiber tag, several hops up from where _debugSource lives
  const leafFiber = { return: { return: { _debugSource: { fileName: "src/Checkout.tsx", lineNumber: 42 }, return: null } } };
  const domNode = { __reactFiber$abc123: leafFiber, parentElement: null };
  check("fiberSource: walks up the fiber's `return` chain to find _debugSource",
    JSON.stringify(fiberSource(domNode)) === JSON.stringify({ fileName: "src/Checkout.tsx", lineNumber: 42 }));

  const plainDiv = { parentElement: domNode }; // no fiber tag on this node itself, but its DOM parent has one
  check("fiberSource: climbs parentElement when the clicked node itself has no fiber tag",
    fiberSource(plainDiv)?.lineNumber === 42);

  check("fiberSource: a node with no fiber anywhere in its ancestry resolves to null (the SWC/React 19 case)",
    fiberSource({ parentElement: { parentElement: null } }) === null);

  const el = catalog.elements[0];
  check("findElement: resolves an absolute-looking path by file suffix + a small line tolerance",
    findElement(catalog, "C:\\\\repo\\\\" + el.file, el.line + 1)?.ref === el.ref);
  check("findElement: a real file but a line far from any element resolves to null, not a wrong guess",
    findElement(catalog, el.file, el.line + 500) === null);
  check("findElement: a file not in the catalog resolves to null",
    findElement(catalog, "src/NotScanned.tsx", 1) === null);
}

/* ---- picker server: real click-on-the-DOM picking, via an injected overlay ---- */
{
  const picker = await startPickServer(catalog);
  check("picker: serves a real listening URL", /^http:\/\/127\.0\.0\.1:\d+$/.test(picker.url));
  check("picker: the bookmarklet is a javascript: URI pointing at this server",
    picker.bookmarklet.startsWith("javascript:") && decodeURIComponent(picker.bookmarklet).includes(picker.url + "/overlay.js"));

  const overlayRes = await fetch(picker.url + "/overlay.js");
  const overlayJs = await overlayRes.text();
  check("overlay.js: served with a JS content-type", (overlayRes.headers.get("content-type") || "").includes("javascript"));
  check("overlay.js: syntactically valid (parses as a function body)",
    (() => { try { new Function(overlayJs); return true; } catch { return false; } })());
  check("overlay.js: does real fiber-based resolution (_debugSource), no catalog text baked in — fetched at click time",
    overlayJs.includes("_debugSource") && overlayJs.includes("/catalog.pcs") && !overlayJs.includes(catalog.elements[0].file));

  const catalogRes = await fetch(picker.url + "/catalog.pcs");
  check("picker: /catalog.pcs serves the real catalog, CORS-enabled for the target app's origin",
    (await catalogRes.json()).tool === "precedence" && catalogRes.headers.get("access-control-allow-origin") === "*");

  const okBranch = catalog.elements.flatMap((e) => e.actions).flatMap((a) => a.branches).find((b) => /ok/.test(b.conditionKey));
  const chosen = { events: [{ name: "checkout_ok", properties: ["result"], anchors: [{ id: okBranch.id, fingerprint: okBranch.fingerprint }] }] };
  const postRes = await fetch(picker.url + "/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(chosen) });
  check("picker: POST /plan (what the overlay's Save button sends) is accepted", postRes.ok);
  const resolved = await picker.plan;
  check("picker: the server's `plan` promise resolves with exactly what was POSTed",
    JSON.stringify(resolved) === JSON.stringify(chosen));

  const afterClose = await fetch(picker.url + "/catalog.pcs").catch(() => null);
  check("picker: the server closes itself once a plan is saved", afterClose === null);
}

/* ---- plan: scaffold from the real catalog, for --ci (no browser to run the picker in) ---- */
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
