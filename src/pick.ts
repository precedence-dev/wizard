/**
 * The picker, real v0: the "file-scoped pick one" fallback @precedence/cli's
 * README already documents as one of the picker's three resolution modes —
 * not click-on-the-page DOM picking (that needs the stamp loader wired into
 * the target's bundler config, or React's dev-mode _debugSource fiber, and
 * this wizard doesn't touch either yet). A searchable tree over the real
 * catalog, served locally, no framework, no external requests: everything
 * needed to render is embedded in the one page this serves.
 *
 * Flow: start a local server, serve the page + catalog, wait for the picker's
 * "Save & continue" POST, write plan.json, shut down. Ctrl+C or closing the
 * tab without saving just leaves no plan.json — same fallback the CLI already
 * had (rerun later) still applies.
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { execFile } from "node:child_process";
import type { Catalog } from "@precedence/cli";

function openBrowser(url: string): void {
  // Windows' "start" is a cmd.exe builtin, not a real executable — invoke it
  // through cmd.exe directly (no shell:true) so args are never re-parsed by a shell.
  const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]]
    : ["xdg-open", [url]];
  try { execFile(cmd, args); } catch { /* best-effort only */ }
}

const PAGE = (catalogJson: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Precedence picker</title>
<style>
  body { font: 14px -apple-system, Segoe UI, sans-serif; margin: 0; display: flex; height: 100vh; color: #1a1a1a; }
  #tree { width: 60%; overflow: auto; padding: 16px; border-right: 1px solid #ddd; }
  #plan { width: 40%; overflow: auto; padding: 16px; background: #fafafa; }
  #search { width: 100%; padding: 8px; box-sizing: border-box; margin-bottom: 12px; font-size: 14px; }
  .file { font-weight: 600; margin-top: 16px; }
  .comp { margin-left: 12px; color: #555; margin-top: 8px; }
  .branch { margin-left: 24px; padding: 4px 8px; cursor: pointer; border-radius: 4px; display: flex; justify-content: space-between; }
  .branch:hover { background: #eef; }
  .branch.added { background: #e6f7e6; }
  .fires { color: #888; font-size: 12px; }
  .plan-item { background: #fff; border: 1px solid #ddd; border-radius: 6px; padding: 10px; margin-bottom: 10px; }
  .plan-item input[type=text] { width: 100%; box-sizing: border-box; padding: 4px; margin: 4px 0; }
  .plan-item label { display: block; font-size: 12px; }
  button { cursor: pointer; }
  #save { width: 100%; padding: 10px; margin-top: 12px; background: #1a1a1a; color: #fff; border: none; border-radius: 6px; font-size: 14px; }
  #save:disabled { background: #999; }
  .remove { color: #c00; background: none; border: none; cursor: pointer; font-size: 12px; }
</style></head>
<body>
  <div id="tree">
    <input id="search" placeholder="filter by component, action, event name…">
    <div id="list"></div>
  </div>
  <div id="plan">
    <h3>Plan (<span id="count">0</span> events)</h3>
    <div id="items"></div>
    <button id="save" disabled>Save &amp; continue</button>
  </div>
<script>
const catalog = ${catalogJson};
const plan = new Map(); // anchor id -> { name, properties: Set, allProps, fingerprint }

function branchNodes(el, action, b, path) {
  const nodes = [{ el, action, b, path: path.concat(b.path) }];
  for (const c of b.children) nodes.push(...branchNodes(el, action, c, path.concat(b.path)));
  return nodes;
}

function allEntries() {
  const out = [];
  for (const el of catalog.elements) {
    for (const action of el.actions) {
      if (action.synthetic) {
        out.push({ el, action, kind: "action", id: action.attachId, fingerprint: action.fingerprint,
          label: action.suggestedName, fires: action.firesWhen, props: action.candidateProps });
      }
      for (const b of action.branches) {
        for (const n of branchNodes(el, action, b, [])) {
          out.push({ el, action: n.action, kind: "branch", id: n.b.id, fingerprint: n.b.fingerprint,
            label: n.b.suggestedName, fires: n.b.firesWhen, props: n.b.candidateProps });
        }
      }
    }
  }
  return out;
}
const entries = allEntries();

function render(filter) {
  const list = document.getElementById("list");
  list.innerHTML = "";
  const q = (filter || "").toLowerCase();
  let lastFile = null, lastComp = null;
  for (const e of entries) {
    const hay = (e.el.file + " " + e.el.component + " " + e.action.name + " " + e.label).toLowerCase();
    if (q && !hay.includes(q)) continue;
    if (e.el.file !== lastFile) {
      const h = document.createElement("div"); h.className = "file"; h.textContent = e.el.file;
      list.appendChild(h); lastFile = e.el.file; lastComp = null;
    }
    if (e.el.component !== lastComp) {
      const h = document.createElement("div"); h.className = "comp"; h.textContent = e.el.component + " · " + e.el.tag;
      list.appendChild(h); lastComp = e.el.component;
    }
    const row = document.createElement("div");
    row.className = "branch" + (plan.has(e.id) ? " added" : "");
    row.innerHTML = "<span>" + e.action.name + " → " + e.label + "</span><span class=\\"fires\\">" + (plan.has(e.id) ? "added" : "+ add") + "</span>";
    row.onclick = () => { addToPlan(e); render(document.getElementById("search").value); };
    list.appendChild(row);
  }
}

function addToPlan(e) {
  if (plan.has(e.id)) return;
  plan.set(e.id, { name: e.label, properties: new Set(e.props.map(p => p.name)), allProps: e.props.map(p => p.name), fingerprint: e.fingerprint });
  renderPlan();
}
function removeFromPlan(id) { plan.delete(id); renderPlan(); render(document.getElementById("search").value); }

function renderPlan() {
  const items = document.getElementById("items");
  items.innerHTML = "";
  document.getElementById("count").textContent = plan.size;
  document.getElementById("save").disabled = plan.size === 0;
  for (const [id, entry] of plan) {
    const div = document.createElement("div"); div.className = "plan-item";
    const nameInput = document.createElement("input");
    nameInput.type = "text"; nameInput.value = entry.name;
    nameInput.oninput = () => { entry.name = nameInput.value; };
    div.appendChild(nameInput);
    for (const p of entry.allProps) {
      const label = document.createElement("label");
      const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = entry.properties.has(p);
      cb.onchange = () => { cb.checked ? entry.properties.add(p) : entry.properties.delete(p); };
      label.appendChild(cb); label.appendChild(document.createTextNode(" " + p));
      div.appendChild(label);
    }
    const rm = document.createElement("button"); rm.className = "remove"; rm.textContent = "remove";
    rm.onclick = () => removeFromPlan(id);
    div.appendChild(rm);
    items.appendChild(div);
  }
}

document.getElementById("search").oninput = (e) => render(e.target.value);
document.getElementById("save").onclick = async () => {
  const events = [...plan.entries()].map(([id, e]) => ({
    name: e.name, properties: [...e.properties], anchors: [{ id, fingerprint: e.fingerprint }],
  }));
  await fetch("/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events }) });
  document.body.innerHTML = "<div style='padding:40px;font-size:18px'>Saved — back to the terminal.</div>";
};
render("");
</script>
</body></html>`;

export interface PickServer {
  url: string;
  /** resolves with the plan once the page POSTs it; the server closes itself first */
  plan: Promise<{ events: unknown[] }>;
  close: () => void;
}

/** The server on its own — no browser, no console output — so it's directly testable.
 *  Resolves once the socket is actually listening, so `url` is real, not guessed. */
export function startPickServer(catalog: Catalog): Promise<PickServer> {
  return new Promise((resolveServer) => {
    let server!: http.Server;
    const plan = new Promise<{ events: unknown[] }>((resolvePlan) => {
      server = http.createServer((req, res) => {
        if (req.method === "GET" && req.url === "/") {
          res.writeHead(200, { "content-type": "text/html" });
          res.end(PAGE(JSON.stringify(catalog)));
        } else if (req.method === "POST" && req.url === "/plan") {
          let body = "";
          req.on("data", (c) => (body += c));
          req.on("end", () => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end("{}");
            const parsed = JSON.parse(body);
            server.close();
            resolvePlan(parsed);
          });
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        resolveServer({ url: `http://127.0.0.1:${port}/`, plan, close: () => server.close() });
      });
    });
  });
}

export async function runPicker(catalog: Catalog): Promise<{ events: unknown[] }> {
  const { url, plan } = await startPickServer(catalog);
  console.log(`\n  picker: ${url}`);
  console.log(`  (opening your browser — pick outcomes, name them, "Save & continue")`);
  openBrowser(url);
  return plan;
}
