# @precedence/wizard

One command from a bare repo to instrumented code:

```
npx @precedence/wizard
```

Checks preconditions, does the work, shows exactly what changed, and leaves
a manual fallback wherever automation can't run. Nothing here reads your
source into an LLM — the analysis (`@precedence/cli`) and the edits
(`@precedence/instrument`) are both fully deterministic. "Wizard" describes
the UX, not the mechanism.

## What it does

1. **Preconditions** — inside a git repo, clean working tree (refuses
   otherwise, same rule `@precedence/instrument`'s `--apply` enforces, so a
   run always lands in its own reviewable commit), detects the framework.
2. **Scan** — runs the real analyzer against your detected source dirs,
   writes `.precedence/catalog.pcs`.
3. **Wire the picker into your app** — a one-time step; see below.
4. **Pick outcomes** — opens your dev server with the picker already armed;
   `--ci` skips this and scaffolds a draft `plan.json` instead.
5. **Instrument** — applies `.precedence/plan.json` via `@precedence/instrument`,
   prints exactly which files changed.

## The picker

The picker (`<PrecedenceDevtools />`, from `@precedence/sdk`) is a real
component imported into your own app — not a script injected across a page
boundary. `src/wire.ts` inserts it into `app/layout.tsx` the first time you
run the wizard: a real, deterministic AST edit (via the TypeScript compiler
API), applied only when the file matches the exact `<body>{children}</body>`
shape it can insert into safely. Anything else — Pages Router, Vite, CRA, or
a `layout.tsx` that doesn't match — gets the same snippet printed for a
one-time manual paste instead; this never guesses.

Once wired, `src/pick.ts` opens your dev server with `?precedence=pick`
appended, which the component checks for on mount and opens itself,
click-picking already armed (Alt+Shift+P also opens it manually at any
time). It resolves a click via React's dev-mode fiber (`_debugSource` — file
+ line) to a catalog entry — the honest limit there (not present on every
build, e.g. Next.js's default SWC compiler or React 19) is documented in
`@precedence/sdk`'s own README, since that's where the resolution logic
actually lives now.

This wizard's own job, mechanically: run the scan, wire the component in
once, publish `catalog.pcs` to `public/` so the component can fetch it
same-origin, then run a tiny local HTTP server (`src/pick.ts`) whose only
job is to receive the finished plan the component POSTs back, before handing
off to `@precedence/instrument`.

`--ci` (no browser to run the picker in) scaffolds a draft `plan.json`
instead — every anchor in it real, copied off actual outcome branches — for
hand-editing before running again. See `src/plan.ts`.

## Two honest gaps, not hidden

- **No account/registry backend yet.** The real flow is meant to be:
  authenticate, then fetch `@precedence/cli` from a gated registry so the
  scan still runs entirely on your machine. That backend doesn't exist yet,
  so this repo depends on `@precedence/cli` as a local `file:` sibling
  instead (same temporary stand-in `@precedence/instrument` uses for the
  same reason — see that package's README).
- **`@precedence/sdk` isn't published anywhere yet.** Wiring adds it to
  your `package.json` as a real dependency, but `npm install` won't resolve
  it until it's actually published somewhere.

Both are marked in `src/cli.ts` at the point they'll be replaced; neither
changes the shape of the commands around them.

## Structure

```
src/
├── cli.ts     orchestration: preconditions -> scan -> wire -> pick -> instrument
├── git.ts      clean-tree / branch checks
├── detect.ts   framework + source-dir detection, file collection
├── scan.ts     wraps @precedence/cli's buildCatalog; publishes catalog.pcs for the picker
├── wire.ts     inserts <PrecedenceDevtools /> into app/layout.tsx, a real AST edit
├── pick.ts     opens the dev server with ?precedence=pick, receives the finished plan
├── plan.ts     reads plan.json, or scaffolds a draft (--ci) from the catalog
└── apply.ts    wraps @precedence/instrument's instrument()
```
