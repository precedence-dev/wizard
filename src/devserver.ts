/**
 * Detects the target app's dev server coming (back) up, so a wiring change
 * that needs one (a fresh `next.config` load isn't hot-reloadable — Next.js
 * only reads it at process startup) doesn't require re-typing the wizard
 * command. This polls instead of asking for a keypress specifically because
 * it's checking for a *state* ("is something serving at this URL now"), not
 * a decision only a human can make — Enter stays reserved for that (see
 * pick.ts's waitForEnter, "done picking").
 */
export interface WaitForDevServerOpts {
  intervalMs?: number;
  timeoutMs?: number;
  onTick?: () => void;
}

export async function waitForDevServer(url: string, opts: WaitForDevServerOpts = {}): Promise<boolean> {
  const interval = opts.intervalMs ?? 1000;
  const timeout = opts.timeoutMs ?? 5 * 60 * 1000;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      // any response — even a 404 or 500 — means something is listening;
      // that's all this needs to know, not that the page itself is valid.
      await fetch(url);
      return true;
    } catch {
      // not up yet
    }
    opts.onTick?.();
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}
