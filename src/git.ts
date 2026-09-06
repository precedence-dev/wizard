/**
 * Preconditions, same rule @precedence/instrument's --apply already enforces:
 * refuse a dirty tree so the wizard's edits always land in their own,
 * reviewable, revertable commit.
 */
import { execFileSync } from "node:child_process";

function run(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

export function isGitRepo(cwd: string): boolean {
  return run(["rev-parse", "--is-inside-work-tree"], cwd)?.trim() === "true";
}

export function isClean(cwd: string): boolean {
  const out = run(["status", "--porcelain"], cwd);
  return out !== null && out.trim() === "";
}

export function currentBranch(cwd: string): string | undefined {
  return run(["rev-parse", "--abbrev-ref", "HEAD"], cwd)?.trim() || undefined;
}
