/**
 * The picker: opens the developer's own dev server with `?precedence=pick`
 * appended, which the already-installed `<PrecedenceDevtools />` component
 * (see @precedence/sdk) checks for on mount and opens itself, click-picking
 * already armed — no bookmarklet, no overlay injected across a page
 * boundary, no postMessage/window-opener handshake: since this is a local
 * CLI (not a hosted dashboard needing to reach a separate tab), a query
 * param the component checks for itself is enough.
 *
 * Every pick/rename/remove POSTs the current full plan immediately — this
 * server overwrites `.precedence/plan.json` on disk on every one of those,
 * not just once at the end. That's the actual persistence layer (a browser
 * reload, tab close, or crash mid-picking loses nothing, since the file was
 * already current); a GET rehydrates the panel with whatever's already
 * picked, so navigating around the app to find more elements doesn't reset
 * it either. There's no "Save & continue" click to wait on: the terminal
 * (Enter) is the "I'm done" signal, since the file is always already
 * correct by the time you press it.
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { execFile } from "node:child_process";
import { readPlan, writePlan } from "./plan";

/** Fixed so `<PrecedenceDevtools />`'s default planEndpoint always finds it. */
const DEFAULT_PORT = 51820;

function openBrowser(url: string): void {
  // Windows' "start" is a cmd.exe builtin, not a real executable — invoke it
  // through cmd.exe directly (no shell:true) so args are never re-parsed by a shell.
  const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]]
    : ["xdg-open", [url]];
  try { execFile(cmd, args); } catch { /* best-effort only */ }
}

const cors = (res: http.ServerResponse) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
};

export interface PickServer {
  url: string;
  close: () => void;
}

/** The server on its own — no console output, no stdin wait — so it's directly
 *  testable. Resolves once the socket is actually listening. Every POST /plan
 *  overwrites cwd's .precedence/plan.json immediately; GET /plan reads it back
 *  (or {events:[]} if nothing's been picked yet). */
export function startPickServer(cwd: string, port = DEFAULT_PORT): Promise<PickServer> {
  return new Promise((resolveServer) => {
    const server = http.createServer((req, res) => {
      cors(res);
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
      } else if (req.method === "GET" && req.url === "/plan") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(readPlan(cwd) || { events: [] }));
      } else if (req.method === "POST" && req.url === "/plan") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          try {
            writePlan(cwd, JSON.parse(body));
            res.writeHead(200, { "content-type": "application/json" });
            res.end("{}");
          } catch {
            res.writeHead(400);
            res.end();
          }
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    // A fixed default port means <PrecedenceDevtools />'s default planEndpoint
    // always finds it with no configuration on either side. Falls back to a
    // random free port if something else is using it.
    server.once("error", () => server.listen(0, "127.0.0.1"));
    server.listen(port, "127.0.0.1");
    server.once("listening", () => {
      const { port: p } = server.address() as AddressInfo;
      resolveServer({ url: `http://127.0.0.1:${p}`, close: () => server.close() });
    });
  });
}

function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", () => resolve());
    process.stdin.resume();
  });
}

export async function runPicker(cwd: string, devUrl: string): Promise<void> {
  const server = await startPickServer(cwd);
  const target = `${devUrl}${devUrl.includes("?") ? "&" : "?"}precedence=pick`;
  console.log(`\n  opening ${target}`);
  console.log(`  click an element, choose outcomes — every pick saves immediately to .precedence/plan.json`);
  console.log(`  (Alt+Shift+P if it doesn't open automatically)`);
  if (server.url !== `http://127.0.0.1:${DEFAULT_PORT}`) {
    console.log(`  note: port ${DEFAULT_PORT} was busy, using ${server.url} instead — pass planEndpoint="${server.url}/plan" to <PrecedenceDevtools /> for this run`);
  }
  openBrowser(target);
  console.log(`\n  press Enter here when you're done picking...`);
  await waitForEnter();
  server.close();
}
