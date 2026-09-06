# @precedence/wizard

One command from a bare repo to instrumented code:

```
npx @precedence/wizard
```

Same shape as `@sentry/wizard` and `@posthog/wizard`: check preconditions,
authenticate, do the work, show exactly what changed, and leave a manual
fallback wherever automation can't run. Unlike PostHog's wizard, nothing here
reads your source into an LLM — the analysis (`@precedence/cli`) and the edits
(`@precedence/instrument`) are both fully deterministic, same as Sentry's.
"Wizard" describes the UX, not the mechanism.

## What it does

1. **Preconditions** — inside a git repo, clean working tree (refuses
   otherwise, same rule `@precedence/instrument`'s `--apply` enforces, so a
   run always lands in its own reviewable commit), detects the framework.
2. **Scan** — runs the real analyzer against your detected source dirs,
   writes `.precedence/catalog.pcs`.
3. **Pick outcomes** — opens a local picker in your browser (see below);
   `--ci` skips the browser and scaffolds a draft `plan.json` instead.
4. **Instrument** — applies `.precedence/plan.json` via `@precedence/instrument`,
   prints exactly which files changed.

## The picker

Real click-on-the-page DOM picking, against your actual running app — not a
page rendered for you. The wizard opens a small install page
(`http://127.0.0.1:51820/install`, a fixed port so it survives across wizard
runs — drag the button to your bookmarks bar once) and copies the bookmarklet
to your clipboard too. Click it on your running app: hover highlights
elements, click resolves the DOM node to a catalog entry via React's dev-mode
fiber (`_debugSource` — file + line, set by the classic Babel/React dev
transform), and shows that element's actions and branches to pick from. This
is the **fiber** rung of the same resolution order `@precedence/cli`'s own
README documents (stamp loader -> fiber -> a file-scoped fallback) — no
bundler config edited, no stamp loader required.

(A plain link pasted into the address bar doesn't work for `javascript:` URIs
— Chrome/Firefox strip that scheme on paste as an anti-phishing measure —
which is why this is a real draggable link on a page, not text to copy.)

The honest limit: `_debugSource` isn't present on every build — notably not
Next.js's default SWC compiler or React 19. The overlay says so plainly on a
failed resolution rather than guessing, and points at the stamp loader (wired
into your bundler config) as the fix, which this wizard doesn't automate yet.

`--ci` (no browser to run a picker in) scaffolds a draft `plan.json` instead —
every anchor in it real, copied off actual outcome branches — for hand-editing
before running again. See `src/plan.ts`.

Mechanically: `src/pick.ts` starts a tiny local, CORS-enabled HTTP server (no
framework) that serves the overlay script and the catalog, and the CLI awaits
its `POST /plan` before continuing to instrument. The resolution algorithm
itself (`fiberSource`, `findElement`) is real, typed, unit-tested TypeScript —
embedded into the browser script via `.toString()`, so the tested code and the
shipped code are provably the same text, not a hand-kept-in-sync copy.

## One honest gap, not hidden

**No account/registry backend yet.** The real flow is meant to be:
authenticate, then fetch `@precedence/cli` from a gated registry so the scan
still runs entirely on your machine. That backend doesn't exist yet, so this
repo depends on `@precedence/cli` as a local `file:` sibling instead (same
temporary stand-in `@precedence/instrument` uses for the same reason — see
that package's README). Marked in `src/cli.ts` at the point it'll be
replaced; it doesn't change the shape of the commands around it.

## Structure

```
src/
├── cli.ts      orchestration: preconditions -> scan -> pick -> instrument
├── git.ts       clean-tree / branch checks
├── detect.ts    framework + source-dir detection, file collection
├── scan.ts      wraps @precedence/cli's buildCatalog
├── pick.ts       the picker: bookmarklet, overlay, fiber-based resolution, local server
├── plan.ts      reads plan.json, or scaffolds a draft (--ci) from the catalog
└── apply.ts     wraps @precedence/instrument's instrument()
```
