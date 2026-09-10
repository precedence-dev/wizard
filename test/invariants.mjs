/**
 * @precedence-dev/wizard invariants: project detection, the in-process scan, the
 * --ci scaffold, apply, the local picker receiver (pick), and the CLI's own
 * arg/diff contract — end to end against throwaway directories. No VCS involved.
 * The only stub is auth (see README); nothing to test there yet.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (p) => pathToFileURL(path.resolve(here, "../dist", p)).href;

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

fs.mkdirSync(path.join(tmp, "src"));
fs.writeFileSync(path.join(tmp, "src", "Checkout.tsx"), FIXTURE);
fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ dependencies: { react: "^18.0.0" } }));

/* ---- detection ---- */
const project = detectProject(tmp);
check("detect: package.json with a react dependency -> framework: react", project.framework === "react");
check("detect: an existing src/ dir is used, not the project root", project.srcDirs.includes("src") && !project.srcDirs.includes("."));
check("detect: devUrl defaults to :3000", project.devUrl === "http://localhost:3000");
check("detect: devUrl honours a --port in the dev script", (() => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pm-port-"));
  fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ dependencies: { next: "15" }, scripts: { dev: "next dev -p 4300" } }));
  const r = detectProject(d).devUrl;
  fs.rmSync(d, { recursive: true, force: true });
  return r === "http://localhost:4300";
})());
const files = collectFiles(path.join(tmp, "src"));
check("detect: finds the .tsx fixture", files.length === 1 && files[0].endsWith("Checkout.tsx"));
check("detect: package manager — no lockfile → npm", project.pm === "npm");
check("detect: package manager — lockfile + packageManager field", (() => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pm-pm-"));
  fs.writeFileSync(path.join(d, "package.json"), "{}");
  fs.writeFileSync(path.join(d, "pnpm-lock.yaml"), "");
  const byLock = detectProject(d).pm;
  fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ packageManager: "yarn@4.1.0" }));
  const byField = detectProject(d).pm;
  fs.rmSync(d, { recursive: true, force: true });
  return byLock === "pnpm" && byField === "yarn";
})());

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
check("scan: drops a .precedence/.gitignore for the catalog but not the plan",
  /(^|\n)catalog\.pcs\s*($|\n)/.test(dotIgnore) && !/plan\.json/.test(dotIgnore));

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

/* ---- parseArgs: the CLI's own contract ---- */
check("cli: --help is recognised, not rejected as an unknown option", parseArgs(["--help"]).help === true);
check("cli: -h too", parseArgs(["-h"]).help === true);
check("cli: --delegated carries its value", parseArgs(["--delegated", "src/pm-tracking.ts"]).delegated === "src/pm-tracking.ts");
check("cli: the removed --emit is now an unknown flag", (() => { try { parseArgs(["--emit", "runtime"]); return false; } catch { return true; } })());
check("cli: an unknown flag is rejected", (() => { try { parseArgs(["--nope"]); return false; } catch { return true; } })());
check("cli: the removed --allow-dirty is now an unknown flag", (() => { try { parseArgs(["--allow-dirty"]); return false; } catch { return true; } })());
check("cli: --track carries its value", parseArgs(["--track", "track from @/lib/analytics"]).track === "track from @/lib/analytics");
check("cli: --dir is repeatable, overrides source-dir auto-detection",
  JSON.stringify(parseArgs(["--dir", "apps/web/src", "--dir", "packages/ui"]).dirs) === JSON.stringify(["apps/web/src", "packages/ui"])
    && JSON.stringify(parseArgs([]).dirs) === "[]");
check("cli: --no-serve / -y / --app", parseArgs(["--no-serve"]).serve === false && parseArgs(["-y"]).yes === true
  && parseArgs([]).serve === true && parseArgs(["--app", "http://localhost:4000"]).app === "http://localhost:4000");

/* ---- the published binary actually runs main() (not just when run directly) ---- */
{
  const bin = path.resolve(here, "../bin/precedence-wizard.js");
  let out = "", status = 0;
  try { out = execFileSync("node", [bin, "--help"], { encoding: "utf8" }); }
  catch (e) { out = (e.stdout || "") + (e.stderr || ""); status = e.status ?? 1; }
  check("cli: `precedence-wizard --help` via the bin wrapper prints usage and exits 0",
    status === 0 && /USAGE/.test(out) && /--track/.test(out), JSON.stringify({ status, out: out.slice(0, 120) }));
}

/* ---- the wizard runs in a plain directory, no VCS required (--no-serve so it
       bakes the picker and exits instead of waiting on a browser) ---- */
{
  const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-nogit-"));
  fs.mkdirSync(path.join(plainDir, "src"));
  fs.writeFileSync(path.join(plainDir, "src", "Checkout.tsx"), FIXTURE);
  fs.writeFileSync(path.join(plainDir, "package.json"), JSON.stringify({ dependencies: { react: "^18.0.0" } }));
  const bin = path.resolve(here, "../bin/precedence-wizard.js");
  let out = "", status = 0;
  try { out = execFileSync("node", [bin, "--no-serve", "--no-open"], { cwd: plainDir, encoding: "utf8" }); }
  catch (e) { out = (e.stdout || "") + (e.stderr || ""); status = e.status ?? 1; }
  check("cli: a scan in a non-git directory succeeds (exit 0, catalog + baked picker written)",
    status === 0 && /attach point/.test(out)
      && fs.existsSync(path.join(plainDir, ".precedence", "catalog.pcs"))
      && fs.existsSync(path.join(plainDir, ".precedence", "viewer.html")),
    JSON.stringify({ status, out: out.slice(0, 160) }));
  fs.rmSync(plainDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/* ---- pick(): serves the picker and writes what the browser POSTs back ---- */
{
  const { pick } = await import(dist("pick.js"));
  const pickDir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-pick-"));
  fs.mkdirSync(path.join(pickDir, ".precedence"));
  const cat = { tool: "precedence", elements: [], attachPoints: 0 };

  // capture stdout, then POST a plan the way the in-page agent would
  const realWrite = process.stdout.write.bind(process.stdout);
  let sniffed = "";
  process.stdout.write = (s, ...a) => { sniffed += s; return realWrite(s, ...a); };
  const pending = pick(pickDir, cat, { devUrl: "http://localhost:3000", open: false });
  await new Promise((r) => setTimeout(r, 80));
  process.stdout.write = realWrite;

  check("pick: opens the app at ?precedence=pick&at=<server>", /localhost:3000\/\?precedence=pick&at=http%3A%2F%2F127\.0\.0\.1%3A\d+/.test(sniffed));
  const url = (sniffed.match(/picker server: (http:\/\/127\.0\.0\.1:\d+)/) || [])[1] + "/";
  const sent = { tool: "precedence-agent", events: [{ name: "e1", properties: [], anchors: [] }] };
  await fetch(url + "plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sent) });
  const res = await pending;
  check("pick: resolves with the posted plan and writes it to .precedence/plan.json",
    res.plan.events.length === 1
      && JSON.parse(fs.readFileSync(path.join(pickDir, ".precedence", "plan.json"), "utf8")).events[0].name === "e1");
  fs.rmSync(pickDir, { recursive: true, force: true });
}

/* ---- wire: one-time Next setup, without touching layout.tsx ---- */
{
  const wire = await import(dist("wire.js"));
  const w = fs.mkdtempSync(path.join(os.tmpdir(), "pm-wire-"));

  const ic = wire.instrumentationClient(w);
  check("wire: writes instrumentation-client.ts that calls precedencePicker() (no layout edit)",
    ic.status === "created" && ic.file === "instrumentation-client.ts"
      && fs.readFileSync(path.join(w, "instrumentation-client.ts"), "utf8").includes("precedencePicker()"));
  check("wire: re-running detects the existing file, doesn't overwrite", wire.instrumentationClient(w).status === "present");

  check("wire: nextConfig — none present", wire.nextConfig(w).file === null);
  fs.writeFileSync(path.join(w, "next.config.mjs"), "const nextConfig = {};\nexport default nextConfig;\n");
  check("wire: nextConfig — found but not wrapped", (() => { const n = wire.nextConfig(w); return n.file === "next.config.mjs" && n.wired === false; })());
  fs.writeFileSync(path.join(w, "next.config.mjs"), "import { withPrecedence } from '@precedence-dev/cli/next';\nexport default withPrecedence({});\n");
  check("wire: nextConfig — recognises withPrecedence", wire.nextConfig(w).wired === true);

  check("wire: wrapHint is one line, ESM for .mjs / CJS for .js",
    /export default withPrecedence/.test(wire.wrapHint("next.config.mjs")) && /module\.exports = withPrecedence/.test(wire.wrapHint("next.config.js")));

  /* wrapNextConfig: in-place edit for the unambiguous cases, "manual" otherwise */
  {
    const g = fs.mkdtempSync(path.join(os.tmpdir(), "pm-nc-"));
    fs.writeFileSync(path.join(g, "next.config.mjs"), "const nextConfig = { reactStrictMode: true };\nexport default nextConfig;\n");
    const r = wire.wrapNextConfig(g);
    const out = fs.readFileSync(path.join(g, "next.config.mjs"), "utf8");
    check("wire: wrapNextConfig wraps `export default <ident>` in place + adds the import",
      r.status === "wrapped"
        && /^import \{ withPrecedence \} from "@precedence-dev\/cli\/next";/.test(out)
        && /export default withPrecedence\(nextConfig\);/.test(out)
        && out.includes("reactStrictMode: true"));
    check("wire: wrapNextConfig is idempotent (already wrapped → 'already', file untouched)",
      wire.wrapNextConfig(g).status === "already" && fs.readFileSync(path.join(g, "next.config.mjs"), "utf8") === out);

    fs.writeFileSync(path.join(g, "next.config.js"), "module.exports = { images: {} };\n");
    fs.rmSync(path.join(g, "next.config.mjs"));
    check("wire: wrapNextConfig leaves an inline-object config alone → 'manual'", wire.wrapNextConfig(g).status === "manual");

    fs.writeFileSync(path.join(g, "next.config.js"), "const cfg = {};\nmodule.exports = cfg;\n");
    const r2 = wire.wrapNextConfig(g);
    check("wire: wrapNextConfig wraps a CJS `module.exports = <ident>` with require()",
      r2.status === "wrapped"
        && /^const \{ withPrecedence \} = require\("@precedence-dev\/cli\/next"\);/.test(fs.readFileSync(path.join(g, "next.config.js"), "utf8")));
    fs.rmSync(g, { recursive: true, force: true });
  }

  /* missingDeps / installLines: no @precedence-dev/* resolvable from a bare temp dir */
  {
    const b = fs.mkdtempSync(path.join(os.tmpdir(), "pm-dep-"));
    fs.writeFileSync(path.join(b, "package.json"), "{}");
    const m = wire.missingDeps(b);
    check("wire: missingDeps reports both packages when neither resolves",
      JSON.stringify(m.deps) === JSON.stringify(["@precedence-dev/sdk"])
        && JSON.stringify(m.devDeps) === JSON.stringify(["@precedence-dev/cli"]));
    check("wire: installLines match the package manager",
      JSON.stringify(wire.installLines("npm", m.deps, m.devDeps))
        === JSON.stringify(["npm install @precedence-dev/sdk", "npm install --save-dev @precedence-dev/cli"])
      && wire.installLines("pnpm", ["a"], [])[0] === "pnpm add a"
      && wire.installLines("bun", [], ["b"])[0] === "bun add -d b");
    fs.rmSync(b, { recursive: true, force: true });
  }

  fs.rmSync(w, { recursive: true, force: true });

  const http = await import("node:http");
  const srv = http.createServer((_q, r) => r.end("ok"));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  check("wire: waitForServer resolves true when the URL is up", (await wire.waitForServer(`http://127.0.0.1:${port}/`, 2000)) === true);
  srv.close();
  check("wire: waitForServer resolves false on timeout", (await wire.waitForServer("http://127.0.0.1:1/", 300)) === false);
}

/* ---- previewDiff: the review surface ---- */
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
