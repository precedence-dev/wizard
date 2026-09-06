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

Real, but it's the **"file-scoped pick one"** fallback `@precedence/cli`'s own
README already documents as one of the picker's three resolution modes — not
click-on-the-page DOM picking. That mode needs either the stamp loader wired
into your bundler config or React's dev-mode fiber, and this wizard doesn't
touch either yet, so this is a searchable tree over the real catalog instead:
every file, component, action and branch, real anchor ids and candidate
properties, name what you want and hit "Save & continue". See `src/pick.ts` —
a tiny local HTTP server (no framework, no external requests, nothing served
but this one page) that the CLI awaits before continuing to instrument.

`--ci` (no browser to run a picker in) scaffolds the same kind of draft a
human would produce by hand instead — every anchor in it is real, copied off
actual outcome branches — and asks you to hand-edit it before running again.
See `src/plan.ts`.

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
├── pick.ts       the picker: a local HTTP server + a searchable-tree page
├── plan.ts      reads plan.json, or scaffolds a draft (--ci) from the catalog
└── apply.ts     wraps @precedence/instrument's instrument()
```
