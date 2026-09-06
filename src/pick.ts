/**
 * The picker: real click-on-the-page DOM picking, against the developer's
 * actual running app — not a page we render ourselves.
 *
 * A bookmarklet injects an overlay script into whatever page is currently
 * open. On click, it walks up from the DOM node to the nearest React fiber
 * and reads `_debugSource` (file + line, set by the classic Babel/React dev
 * transform) to resolve it to a catalog element, same resolution rung
 * @precedence/cli's own README documents (stamp loader -> fiber -> a
 * file-scoped fallback; this is the fiber rung — no bundler config edited,
 * no stamp loader required). On a build where `_debugSource` isn't present
 * (SWC, Next.js's default compiler, React 19), the overlay says so plainly
 * instead of guessing.
 *
 * The overlay talks back to this local server (CORS-enabled, since it runs
 * on the target app's own origin, not ours) to fetch the catalog and POST
 * the finished plan.
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import type { Catalog } from "@precedence/cli";

const cors = (res: http.ServerResponse) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
};

/**
 * The actual resolution algorithm — real, typed, unit-tested (see
 * test/invariants.mjs) — not prose inside a template string. Embedded into
 * the browser overlay via `.toString()`, so the tested code and the shipped
 * code are provably the same text, not a hand-kept-in-sync copy.
 */
export function fiberSource(node: unknown): { fileName: string; lineNumber: number } | null {
  let n = node as (Record<string, unknown> & { parentElement?: unknown }) | null;
  while (n) {
    const key = Object.keys(n).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
    if (key) {
      let fiber = n[key] as { _debugSource?: { fileName: string; lineNumber: number }; return?: unknown } | undefined;
      while (fiber) {
        if (fiber._debugSource) return fiber._debugSource;
        fiber = fiber.return as typeof fiber;
      }
    }
    n = (n.parentElement as typeof n) || null;
  }
  return null;
}

export function findElement(catalog: Catalog, fileName: string, line: number): Catalog["elements"][number] | null {
  const norm = fileName.replace(/\\/g, "/");
  for (const el of catalog.elements) {
    if (norm.slice(-el.file.length) !== el.file) continue;
    if (Math.abs(el.line - line) > 2) continue;
    return el;
  }
  return null;
}

const OVERLAY = (wizardOrigin: string) => `(function(){
if (window.__pmPickerLoaded) return; window.__pmPickerLoaded = true;
var WIZARD = ${JSON.stringify(wizardOrigin)};
var catalog = null, active = false;
var plan = new Map();

var box = document.createElement("div");
box.style.cssText = "position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #4f46e5;background:rgba(79,70,229,.08);display:none;";
document.body.appendChild(box);

var panel = document.createElement("div");
panel.style.cssText = "position:fixed;top:0;right:0;width:340px;height:100vh;background:#fff;border-left:1px solid #ddd;z-index:2147483647;font:13px -apple-system,Segoe UI,sans-serif;overflow:auto;box-shadow:-2px 0 12px rgba(0,0,0,.15);display:none;color:#1a1a1a;";
panel.innerHTML =
  '<div style="padding:12px;border-bottom:1px solid #eee;font-weight:600">Precedence picker' +
  '<div style="font-weight:400;font-size:11px;color:#888;margin-top:2px">Alt+Shift+P to toggle &middot; click an element</div></div>' +
  '<div id="pm-body" style="padding:12px;color:#888">Click an element to inspect it.</div>' +
  '<div id="pm-plan" style="padding:0 12px"></div>' +
  '<button id="pm-save" style="margin:12px;padding:8px;width:calc(100% - 24px);cursor:pointer" disabled>Save &amp; continue</button>';
document.body.appendChild(panel);

function toggle() {
  active = !active;
  panel.style.display = active ? "block" : "none";
  if (!active) box.style.display = "none";
}
document.addEventListener("keydown", function (e) {
  if (e.altKey && e.shiftKey && e.key.toLowerCase() === "p") toggle();
});

document.addEventListener("mousemove", function (e) {
  if (!active || panel.contains(e.target)) { box.style.display = "none"; return; }
  var r = e.target.getBoundingClientRect();
  box.style.display = "block";
  box.style.left = r.left + "px"; box.style.top = r.top + "px";
  box.style.width = r.width + "px"; box.style.height = r.height + "px";
}, true);

var fiberSource = ${fiberSource.toString()};
var findElement = ${findElement.toString()};

function flatten(bs, out) {
  out = out || [];
  for (var i = 0; i < bs.length; i++) { out.push(bs[i]); flatten(bs[i].children, out); }
  return out;
}

function renderBody(el) {
  var body = document.getElementById("pm-body");
  body.innerHTML = "";
  var h = document.createElement("div");
  h.innerHTML = "<b>" + el.component + "</b> &middot; " + el.tag;
  body.appendChild(h);
  el.actions.forEach(function (action) {
    flatten(action.branches).forEach(function (b) {
      var row = document.createElement("div");
      row.style.cssText = "padding:6px 8px;margin-top:6px;border:1px solid #eee;border-radius:4px;cursor:pointer;display:flex;justify-content:space-between;";
      row.innerHTML = "<span>" + action.name + " &rarr; " + b.suggestedName + "</span><span style='color:#888;font-size:11px'>" + (plan.has(b.id) ? "added" : "+ add") + "</span>";
      row.onclick = function () { addToPlan(b); renderBody(el); };
      body.appendChild(row);
    });
  });
}

function addToPlan(b) {
  if (plan.has(b.id)) return;
  plan.set(b.id, { name: b.suggestedName, properties: new Set(b.candidateProps.map(function (p) { return p.name; })),
    allProps: b.candidateProps.map(function (p) { return p.name; }), fingerprint: b.fingerprint });
  renderPlan();
}
function removeFromPlan(id) { plan.delete(id); renderPlan(); }

function renderPlan() {
  var box2 = document.getElementById("pm-plan");
  box2.innerHTML = "<b>Plan (" + plan.size + ")</b>";
  plan.forEach(function (e, id) {
    var d = document.createElement("div");
    d.style.cssText = "background:#fafafa;border:1px solid #ddd;border-radius:6px;padding:8px;margin:8px 0;";
    var inp = document.createElement("input");
    inp.type = "text"; inp.value = e.name; inp.style.cssText = "width:100%;box-sizing:border-box;padding:4px;";
    inp.oninput = function () { e.name = inp.value; };
    d.appendChild(inp);
    var rm = document.createElement("button");
    rm.textContent = "remove"; rm.style.cssText = "color:#c00;background:none;border:none;cursor:pointer;font-size:11px;margin-top:4px;";
    rm.onclick = function () { removeFromPlan(id); };
    d.appendChild(rm);
    box2.appendChild(d);
  });
  document.getElementById("pm-save").disabled = plan.size === 0;
}

document.addEventListener("click", function (e) {
  if (!active || panel.contains(e.target)) return;
  e.preventDefault(); e.stopPropagation();
  (async function () {
    if (!catalog) catalog = await fetch(WIZARD + "/catalog.pcs").then(function (r) { return r.json(); });
    var src = fiberSource(e.target);
    var body = document.getElementById("pm-body");
    if (!src) {
      body.innerHTML = "<b>Can't resolve this element.</b><br>No React dev source info on this build (likely SWC/Next.js or React 19). This mode needs the classic Babel dev transform, or the stamp loader wired into your bundler config — see @precedence/cli's README.";
      return;
    }
    var el = findElement(catalog, src.fileName, src.lineNumber);
    if (!el) {
      body.innerHTML = "<b>No catalog entry at</b> " + src.fileName + ":" + src.lineNumber + "<br>(not a tracked handler, or outside the scanned dirs)";
      return;
    }
    renderBody(el);
  })();
}, true);

document.getElementById("pm-save").addEventListener("click", function () {
  var events = [];
  plan.forEach(function (e, id) {
    events.push({ name: e.name, properties: Array.from(e.properties), anchors: [{ id: id, fingerprint: e.fingerprint }] });
  });
  fetch(WIZARD + "/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: events }) })
    .then(function () { panel.innerHTML = "<div style='padding:20px'>Saved — back to the terminal.</div>"; });
});

toggle();
})();`;

function bookmarklet(origin: string): string {
  const src = `${origin}/overlay.js`;
  const loader = `(function(){var s=document.createElement("script");s.src=${JSON.stringify(src)};document.body.appendChild(s);})()`;
  return `javascript:${encodeURIComponent(loader)}`;
}

export interface PickServer {
  url: string;
  bookmarklet: string;
  /** resolves with the plan once the overlay POSTs it; the server closes itself first */
  plan: Promise<{ events: unknown[] }>;
  close: () => void;
}

/** The server on its own — no console output — so it's directly testable.
 *  Resolves once the socket is actually listening, so `url` is real, not guessed. */
export function startPickServer(catalog: Catalog): Promise<PickServer> {
  return new Promise((resolveServer) => {
    let server!: http.Server;
    const plan = new Promise<{ events: unknown[] }>((resolvePlan) => {
      server = http.createServer((req, res) => {
        cors(res);
        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
        } else if (req.method === "GET" && req.url === "/overlay.js") {
          res.writeHead(200, { "content-type": "application/javascript" });
          res.end(OVERLAY(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
        } else if (req.method === "GET" && req.url === "/catalog.pcs") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(catalog));
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
        const url = `http://127.0.0.1:${port}`;
        resolveServer({ url, bookmarklet: bookmarklet(url), plan, close: () => server.close() });
      });
    });
  });
}

export async function runPicker(catalog: Catalog): Promise<{ events: unknown[] }> {
  const server = await startPickServer(catalog);
  console.log(`\n  picker ready — drag this to your bookmarks bar (or paste into the address bar while on your running app):\n`);
  console.log(`    ${server.bookmarklet}\n`);
  console.log(`  Then: open your dev server in the browser, click the bookmarklet, Alt+Shift+P, click an element.`);
  return server.plan;
}
