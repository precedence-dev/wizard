/**
 * The picker: opens the developer's own dev server with `?precedence=pick`
 * appended, which the already-installed `<PrecedenceDevtools />` component
 * (see @precedence/sdk) checks for on mount and opens itself, click-picking
 * already armed — no bookmarklet, no overlay injected across a page
 * boundary, no postMessage/window-opener handshake: since this is a local
 * CLI (not a hosted dashboard needing to reach a separate tab), a query
 * param the component checks for itself is enough.
 *
 * This server's only job now is to receive the finished plan — the catalog
 * fetch and the picking UI both live in the target app itself.
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { execFile } from "node:child_process";

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
  res.setHeader("access-control-allow-methods", "POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
};

export interface PickServer {
  url: string;
  /** resolves with the plan once the panel POSTs it; the server closes itself first */
  plan: Promise<{ events: unknown[] }>;
  close: () => void;
}

/** The server on its own — no console output — so it's directly testable.
 *  Resolves once the socket is actually listening. */
export function startPickServer(port = DEFAULT_PORT): Promise<PickServer> {
  return new Promise((resolveServer) => {
    let server!: http.Server;
    const plan = new Promise<{ events: unknown[] }>((resolvePlan) => {
      server = http.createServer((req, res) => {
        cors(res);
        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
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
      // A fixed default port means <PrecedenceDevtools />'s default
      // planEndpoint always finds it with no configuration on either side.
      // Falls back to a random free port if something else is using it.
      server.once("error", () => server.listen(0, "127.0.0.1"));
      server.listen(port, "127.0.0.1");
      server.once("listening", () => {
        const { port: p } = server.address() as AddressInfo;
        resolveServer({ url: `http://127.0.0.1:${p}`, plan, close: () => server.close() });
      });
    });
  });
}

export async function runPicker(devUrl: string): Promise<{ events: unknown[] }> {
  const server = await startPickServer();
  const target = `${devUrl}${devUrl.includes("?") ? "&" : "?"}precedence=pick`;
  console.log(`\n  opening ${target}`);
  console.log(`  (click an element, choose outcomes, "Save & continue" — Alt+Shift+P if it doesn't open automatically)`);
  if (server.url !== `http://127.0.0.1:${DEFAULT_PORT}`) {
    console.log(`  note: port ${DEFAULT_PORT} was busy, using ${server.url} instead — pass planEndpoint="${server.url}/plan" to <PrecedenceDevtools /> for this run`);
  }
  openBrowser(target);
  return server.plan;
}
