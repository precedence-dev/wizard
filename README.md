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
3. **Pick outcomes** — see below, this step is a stand-in today.
4. **Instrument** — applies `.precedence/plan.json` via `@precedence/instrument`,
   prints exactly which files changed.

## Two honest gaps, not hidden

- **No picker yet.** The picker UI (click an element, see its branch tree,
  choose what to track) doesn't exist as real code in any repo yet. Instead
  of faking that, this wizard scaffolds a draft `plan.json` from the real
  catalog — every anchor id and fingerprint in it is real, copied off actual
  outcome branches — and asks you to hand-edit it (rename events, trim the
  ones you don't want) before running again. See `src/plan.ts`.
- **No account/registry backend yet.** The real flow is meant to be:
  authenticate, then fetch `@precedence/cli` from a gated registry so the
  scan still runs entirely on your machine. That backend doesn't exist yet,
  so this repo depends on `@precedence/cli` as a local `file:` sibling
  instead (same temporary stand-in `@precedence/instrument` uses for the
  same reason — see that package's README).

Both stand-ins are marked in `src/cli.ts` at the point they'll be replaced;
neither changes the shape of the commands around them.

## Structure

```
src/
├── cli.ts      orchestration: preconditions -> scan -> plan -> instrument
├── git.ts       clean-tree / branch checks
├── detect.ts    framework + source-dir detection, file collection
├── scan.ts      wraps @precedence/cli's buildCatalog
├── plan.ts      reads plan.json, or scaffolds a draft from the catalog
└── apply.ts     wraps @precedence/instrument's instrument()
```
