/**
 * @precedence/wizard invariants: exercises the real, working pieces (git
 * preconditions, detection, scan, wiring the devtools panel into a layout
 * file, the picker's plan-receiving server, plan scaffold, apply) end to
 * end against a throwaway git repo. The only stub is auth — see README —
 * there's nothing real to test there yet.
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
const { scan, writeCatalog, publishCatalogForDevtools } = await import(dist("scan.js"));
const { scaffoldPlan, writeDraftPlan, readPlan } = await import(dist("plan.js"));
const { apply } = await import(dist("apply.js"));
const { startPickServer } = await import(dist("pick.js"));
const { findLayoutFile, wireDevtools, addDevtoolsDependency, SNIPPET, findNextConfigFile, wireStampLoader } = await import(dist("wire.js"));
const ts = (await import("typescript")).default;

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

check("publishCatalogForDevtools: no public/ dir yet -> null, doesn't create one itself",
  publishCatalogForDevtools(tmp, catalog) === null);
fs.mkdirSync(path.join(tmp, "public"));
const published = publishCatalogForDevtools(tmp, catalog);
check("publishCatalogForDevtools: with public/ present, writes catalog.pcs there for same-origin fetch",
  published === path.join(tmp, "public", "precedence-catalog.pcs") &&
    JSON.parse(fs.readFileSync(published, "utf8")).tool === "precedence");

/* ---- wire: a real Next.js App Router layout.tsx, AST-edited ---- */
{
  const layoutDir = path.join(tmp, "app");
  fs.mkdirSync(layoutDir);
  const layoutPath = path.join(layoutDir, "layout.tsx");
  const original = `export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html><body>
      {children}
    </body></html>
  );
}
`;
  fs.writeFileSync(layoutPath, original);

  check("wire: finds app/layout.tsx", findLayoutFile(tmp) === layoutPath);

  const wired = wireDevtools(tmp);
  check("wire: applies a real edit to a <body>{children}</body> layout",
    wired.applied === true && wired.file === layoutPath);
  const after = fs.readFileSync(layoutPath, "utf8");
  check("wire: adds the import and the JSX line, still valid syntax",
    after.includes('import { PrecedenceDevtools } from "@precedence/sdk/devtools";') &&
      after.includes('{process.env.NODE_ENV !== "production" && <PrecedenceDevtools />}'));

  const again = wireDevtools(tmp);
  check("wire: re-running is idempotent — recognises it's already wired, doesn't duplicate the edit",
    again.applied === true && again.reason === "already wired" &&
      (after.match(/PrecedenceDevtools/g) || []).length === (fs.readFileSync(layoutPath, "utf8").match(/PrecedenceDevtools/g) || []).length);

  fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ dependencies: { react: "^18.0.0" } }));
  check("addDevtoolsDependency: adds @precedence/sdk to package.json", addDevtoolsDependency(tmp) === true);
  check("addDevtoolsDependency: real semver, not a stray file: path",
    JSON.parse(fs.readFileSync(path.join(tmp, "package.json"), "utf8")).dependencies["@precedence/sdk"] === "^0.1.0");
  check("addDevtoolsDependency: re-running doesn't re-add it (already there)", addDevtoolsDependency(tmp) === false);

  check("SNIPPET: the manual fallback names the exact import + JSX to paste by hand",
    SNIPPET.includes('@precedence/sdk/devtools') && SNIPPET.includes("PrecedenceDevtools"));

  // a shape this can't confidently insert into — no <body>{children}</body> — must not guess
  const weirdProject = fs.mkdtempSync(path.join(os.tmpdir(), "pm-weird-layout-"));
  fs.mkdirSync(path.join(weirdProject, "app"));
  fs.writeFileSync(path.join(weirdProject, "app", "layout.tsx"), `export default function X() { return <div>no body/children here</div>; }`);
  const notWired = wireDevtools(weirdProject);
  check("wire: a layout.tsx that doesn't match <body>{children}</body> is left untouched, not guessed at",
    notWired.applied === false && /not guessing/.test(notWired.reason) &&
      fs.readFileSync(path.join(weirdProject, "app", "layout.tsx"), "utf8") === `export default function X() { return <div>no body/children here</div>; }`);
  fs.rmSync(weirdProject, { recursive: true, force: true });

  const noLayoutProject = fs.mkdtempSync(path.join(os.tmpdir(), "pm-no-layout-"));
  check("wire: no layout.tsx at all -> a clear reason, not an exception",
    wireDevtools(noLayoutProject).reason.includes("no app/layout.tsx found"));
  fs.rmSync(noLayoutProject, { recursive: true, force: true });
}

/* ---- wireStampLoader: real config edits, matching the exact shapes validated
   against live Next.js apps (Turbopack rules object, and an existing webpack()
   with a `return config;`) ---- */
{
  // no next.config at all
  const noConfigProject = fs.mkdtempSync(path.join(os.tmpdir(), "pm-no-nextconfig-"));
  check("wireStampLoader: no next.config.* -> a clear reason, not an exception",
    wireStampLoader(noConfigProject).reason.includes("no next.config"));
  fs.rmSync(noConfigProject, { recursive: true, force: true });

  // greenfield: no turbopack, no webpack key -> insert the dev-gated turbopack.rules spread
  const greenfield = fs.mkdtempSync(path.join(os.tmpdir(), "pm-greenfield-"));
  const greenfieldConfig = `import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: { formats: ["image/avif"] },
  compress: true,
};

export default nextConfig;
`;
  fs.writeFileSync(path.join(greenfield, "next.config.ts"), greenfieldConfig);
  check("wireStampLoader: finds next.config.ts", findNextConfigFile(greenfield) === path.join(greenfield, "next.config.ts"));
  const gfResult = wireStampLoader(greenfield);
  check("wireStampLoader: applies a real turbopack.rules edit to a plain exported config object",
    gfResult.applied === true, JSON.stringify(gfResult));
  const gfAfter = fs.readFileSync(path.join(greenfield, "next.config.ts"), "utf8");
  check("wireStampLoader: the edit is dev-gated, references the copied loader, leaves the rest of the config untouched",
    gfAfter.includes('process.env.NODE_ENV === "development"') &&
      gfAfter.includes("turbopack") && gfAfter.includes(".precedence/stamp-loader.cjs") &&
      gfAfter.includes('images: { formats: ["image/avif"] }'));
  check("wireStampLoader: the edited config is still syntactically valid TS",
    ts.createSourceFile("next.config.ts", gfAfter, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX).parseDiagnostics.length === 0);
  check("wireStampLoader: copies the real stamp-loader.js in, not a stub",
    fs.readFileSync(path.join(greenfield, ".precedence", "stamp-loader.cjs"), "utf8").includes("data-pm-el"));
  check("wireStampLoader: re-running is idempotent",
    wireStampLoader(greenfield).reason === "already wired");
  fs.rmSync(greenfield, { recursive: true, force: true });

  // an existing webpack(config, { dev }) { ... return config; } — the riskier shape, matching a real working config
  const webpackProject = fs.mkdtempSync(path.join(os.tmpdir(), "pm-webpack-"));
  const webpackConfig = `const path = require("path");

const nextConfig = {
  webpack(config, { dev }) {
    if (dev) {
      config.resolve.alias["@"] = path.join(__dirname, "src");
    }
    return config;
  },
};

module.exports = nextConfig;
`;
  fs.writeFileSync(path.join(webpackProject, "next.config.js"), webpackConfig);
  const wpResult = wireStampLoader(webpackProject);
  check("wireStampLoader: inserts into an existing webpack() before its `return config;`, doesn't disturb the rest",
    wpResult.applied === true, JSON.stringify(wpResult));
  const wpAfter = fs.readFileSync(path.join(webpackProject, "next.config.js"), "utf8");
  check("wireStampLoader: the webpack() edit is dev-gated, keeps the pre-existing alias config intact, still valid",
    /if \(dev\) \{[^}]*config\.module\.rules\.push/.test(wpAfter) &&
      wpAfter.includes('config.resolve.alias["@"]') &&
      ts.createSourceFile("next.config.js", wpAfter, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX).parseDiagnostics.length === 0);
  fs.rmSync(webpackProject, { recursive: true, force: true });

  // a turbopack key already present in some other shape -> must not guess/overwrite it
  const existingTurbopack = fs.mkdtempSync(path.join(os.tmpdir(), "pm-existing-turbopack-"));
  fs.writeFileSync(path.join(existingTurbopack, "next.config.ts"), `const nextConfig = {
  turbopack: { resolveAlias: { "@": "./src" } },
};
export default nextConfig;
`);
  const existingResult = wireStampLoader(existingTurbopack);
  check("wireStampLoader: an existing turbopack key in an unfamiliar shape is left untouched, not guessed at",
    existingResult.applied === false && /not guessing/.test(existingResult.reason) &&
      fs.readFileSync(path.join(existingTurbopack, "next.config.ts"), "utf8").includes('resolveAlias: { "@": "./src" }') &&
      !fs.readFileSync(path.join(existingTurbopack, "next.config.ts"), "utf8").includes("stamp-loader"));
  fs.rmSync(existingTurbopack, { recursive: true, force: true });
}

/* ---- picker server: every POST overwrites .precedence/plan.json immediately,
   GET reads it back — this IS the persistence layer now, not localStorage ---- */
{
  const pickTmp = fs.mkdtempSync(path.join(os.tmpdir(), "pm-pick-"));
  const picker = await startPickServer(pickTmp, 0); // :0 = any free port, never touch the real default port during tests
  check("picker: serves a real listening URL", /^http:\/\/127\.0\.0\.1:\d+$/.test(picker.url));

  const preflight = await fetch(picker.url + "/plan", { method: "OPTIONS" });
  check("picker: answers the CORS preflight for the cross-origin POST from the target app", preflight.status === 204);

  const empty = await (await fetch(picker.url + "/plan")).json();
  check("picker: GET /plan before anything's picked -> {events:[]}, not a 404/throw", JSON.stringify(empty) === JSON.stringify({ events: [] }));

  const okBranch = catalog.elements.flatMap((e) => e.actions).flatMap((a) => a.branches).find((b) => /ok/.test(b.conditionKey));
  const chosen = { events: [{ name: "checkout_ok", properties: ["result"], anchors: [{ id: okBranch.id, fingerprint: okBranch.fingerprint }] }] };
  const postRes = await fetch(picker.url + "/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(chosen) });
  check("picker: POST /plan (what <PrecedenceDevtools /> sends on every pick) is accepted", postRes.ok);
  check("picker: the POST immediately overwrote .precedence/plan.json on disk — not buffered for a later 'save' step",
    JSON.stringify(JSON.parse(fs.readFileSync(path.join(pickTmp, ".precedence", "plan.json"), "utf8"))) === JSON.stringify(chosen));

  const afterPost = await (await fetch(picker.url + "/plan")).json();
  check("picker: GET /plan after a POST reads back exactly what was saved — this is how the panel rehydrates on reload",
    JSON.stringify(afterPost) === JSON.stringify(chosen));

  // a second, smaller pick overwrites — the file always reflects the CURRENT full state, not an append log
  const revised = { events: [{ name: "checkout_ok_renamed", properties: [], anchors: [{ id: okBranch.id, fingerprint: okBranch.fingerprint }] }] };
  await fetch(picker.url + "/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(revised) });
  check("picker: a later POST replaces the file's contents, doesn't merge/append",
    JSON.parse(fs.readFileSync(path.join(pickTmp, ".precedence", "plan.json"), "utf8")).events[0].name === "checkout_ok_renamed");

  picker.close();
  const afterClose = await fetch(picker.url + "/plan", { method: "OPTIONS" }).catch(() => null);
  check("picker: close() actually stops the server", afterClose === null);
  fs.rmSync(pickTmp, { recursive: true, force: true });
}

/* ---- picker server: falls back to a free port when its default is already taken ---- */
{
  const net = await import("node:net");
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(51820, "127.0.0.1", r));
  const pickTmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "pm-pick2-"));
  const picker = await startPickServer(pickTmp2); // no explicit port -> the real default, which is occupied
  check("picker: falls back to a free port instead of failing when the default port is busy",
    !picker.url.endsWith(":51820") && /^http:\/\/127\.0\.0\.1:\d+$/.test(picker.url));
  picker.close();
  await new Promise((r) => blocker.close(r));
  fs.rmSync(pickTmp2, { recursive: true, force: true });
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
