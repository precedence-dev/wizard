/**
 * Thin fetch wrapper for @precedence-dev/server's v1 API — see
 * ../../server/README.md for the full surface. One API key, resolved by
 * config.ts, sent as `Authorization: Bearer`.
 */
import type { ServerClient } from "./config";

export type { ServerClient };

const TIMEOUT_MS = 15_000;

async function req<T>(client: ServerClient, path: string, init: RequestInit = {}): Promise<T> {
  const url = new URL(path, client.server.replace(/\/$/, "") + "/").href;
  const r = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      authorization: `Bearer ${client.apiKey}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`${init.method ?? "GET"} ${path} -> ${r.status}${body ? `: ${body}` : ""}`);
  }
  return r.status === 204 ? (undefined as T) : ((await r.json()) as T);
}

export function pushCatalog(client: ServerClient, body: { commit?: string; blob: unknown }): Promise<{ id: string }> {
  return req(client, "v1/catalogs", { method: "POST", body: JSON.stringify(body) });
}

export function createSession(
  client: ServerClient,
  body: { catalog: unknown; existingPlan?: unknown },
): Promise<{ sid: string; expiresAt: string }> {
  return req(client, "v1/sessions", { method: "POST", body: JSON.stringify(body) });
}

export function sessionStatus(client: ServerClient, sid: string): Promise<{ state: string; plan?: unknown }> {
  return req(client, `v1/sessions/${encodeURIComponent(sid)}`);
}

export function pullPlan(client: ServerClient, env = "default"): Promise<unknown> {
  return req(client, `v1/plan?env=${encodeURIComponent(env)}`);
}
