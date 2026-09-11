/**
 * Server + API key resolution — PostHog-style, one key per project, no OAuth
 * device-code flow (see ../../docs/byoc.md's "Config resolution" for the
 * fuller design this is a slice of). Picking outcomes always requires a
 * configured server now; there is no fully-local/offline picker anymore.
 *
 * Resolution order (first hit wins):
 *   1. --server / --api-key flags
 *   2. PRECEDENCE_SERVER / PRECEDENCE_API_KEY env (CI)
 *   3. .precedence/config.json — { server }, committed, per-repo
 *   4. ~/.precedence/auth.json — per-user, git-ignored, keys keyed by server origin
 *   5. default server (Precedence Cloud), no key found
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const DEFAULT_SERVER = "https://api.precedence.dev";

export interface ServerClient {
  server: string;
  apiKey: string;
}

interface ProjectConfig {
  server?: string;
}
type AuthFile = Record<string, string>; // server origin -> api key

function projectConfigPath(cwd: string): string {
  return path.join(cwd, ".precedence", "config.json");
}
/** `PRECEDENCE_HOME` overrides where `auth.json` lives — an isolated home for
 *  tests / sandboxes, so they never read or clobber a real user's saved keys. */
function authPath(): string {
  return path.join(process.env.PRECEDENCE_HOME || os.homedir(), ".precedence", "auth.json");
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJson(file: string, data: unknown, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", mode ? { mode } : undefined);
}

export function readProjectConfig(cwd: string): ProjectConfig {
  return readJson<ProjectConfig>(projectConfigPath(cwd)) ?? {};
}

export function writeProjectConfig(cwd: string, cfg: ProjectConfig): void {
  writeJson(projectConfigPath(cwd), cfg);
}

export function serverOrigin(server: string): string {
  try {
    return new URL(server).origin;
  } catch {
    return server;
  }
}

/** git-ignored, per-user — never in the repo, never in CI env dumps by accident. */
export function saveApiKey(server: string, apiKey: string): void {
  const auth = readJson<AuthFile>(authPath()) ?? {};
  auth[serverOrigin(server)] = apiKey;
  writeJson(authPath(), auth, 0o600);
}

export interface ResolvedConfig {
  server: string;
  apiKey: string | undefined;
  /** true when `server` came from a flag/env/config, not the bare default —
   *  used to decide whether to persist it to .precedence/config.json */
  serverExplicit: boolean;
}

export function resolveConfig(cwd: string, flags: { server?: string; apiKey?: string }): ResolvedConfig {
  const projectServer = readProjectConfig(cwd).server;
  const server = flags.server || process.env.PRECEDENCE_SERVER || projectServer || DEFAULT_SERVER;
  const auth = readJson<AuthFile>(authPath()) ?? {};
  const apiKey = flags.apiKey || process.env.PRECEDENCE_API_KEY || auth[serverOrigin(server)];
  return { server, apiKey, serverExplicit: Boolean(flags.server || process.env.PRECEDENCE_SERVER || projectServer) };
}
