# @precedence/wizard

The one-command path into Precedence: scan a project, pick the outcomes worth
tracking in a browser, review the diff, apply it. It never modifies your app on
its own — the scan runs the real analyzer in-process, picking happens in
[`@precedence/viewer`](https://github.com/precedence-dev/sdk/tree/main/packages/viewer),
applying is [`@precedence/instrument`](https://github.com/precedence-dev/instrument).
Nothing reads your source into an LLM; every step is deterministic. No VCS
required.

## The flow

```sh
# one time: install @precedence/sdk and call installPrecedence({ track }) at your
# app root, and wire @precedence/cli/stamp-loader into your bundler for dev
# (the wizard prints the snippet). Then:

npx @precedence/wizard --track "track from @/lib/analytics" --apply
```

1. **Scan** — writes `.precedence/catalog.pcs`.
2. **Pick** — opens your **running app** at `?precedence=pick`. `@precedence/sdk`
   loads the picker overlay; you hover and click real elements, name the outcomes
   to track, then **send to wizard**. The plan comes straight back.
3. **Preview** — the exact source diff is printed.
4. **Apply** — with `--apply`, it writes; run interactively, it asks first. The
   instrumentation is a diff you review and commit on its own.

The wizard guesses your dev URL from `package.json` (`--app <url>` to override).
Drop `--apply` to stop after the preview. The plan is saved to
`.precedence/plan.json` — keep it in the repo, it's the source of truth for the
events. A plan already present skips straight to preview. `--no-serve` falls back
to the static picker (browse a tree, export a file by hand).

## Why a browser step

Deciding *what* is a meaningful event is product knowledge. The picker lets
growth/marketing select, name, and **define** events off a catalog of real code
paths — no codebase access, no ticket. Engineering's part is bounded: the one
`--track` import, the preview diff, the commit. The exported `plan.json` (names,
definitions, properties, source anchors) is what both sides review and what stays
in the repo as the answer to "what does this event mean".

## Options

| flag | meaning |
| --- | --- |
| `--track <spec>` | e.g. `"track from @/lib/analytics"` — required for direct mode |
| `--emit direct` \| `runtime` | `direct` bakes `track(...)` calls in; `runtime` emits `globalThis.__pm?.(…)` + needs [`@precedence/sdk`](https://github.com/precedence-dev/sdk) at the app root |
| `--runtime <file>` | direct mode: write the delegated-link listener here on `--apply` |
| `--apply` | write source after the preview |
| `-y`, `--yes` | skip the "apply?" confirmation |
| `--app <url>` | your running dev server (default: guessed from `package.json`) |
| `--types` | resolve declared types (slower; enables interprocedural outcomes) |
| `--ci` | non-interactive: scaffold a draft `plan.json` instead of the pick step |
| `--no-serve` | bake a static picker to `.precedence/viewer.html` and export a file by hand |
| `--no-open` | don't launch a browser |

## One honest gap

**No account/registry backend yet.** The intended flow is: authenticate, then
fetch `@precedence/cli` from a gated registry so the scan still runs entirely on
your machine. Until that exists, this repo depends on `@precedence/cli` (and
`@precedence/instrument`, `@precedence/viewer`) as local `file:` siblings — the
same stand-in `@precedence/instrument` uses; see that package's README. Marked
in `src/cli.ts` at the point it'll be replaced.

## Structure

```
src/
├── cli.ts     orchestration: scan → pick → preview → apply
├── detect.ts  framework + source-dir detection, file collection
├── scan.ts    wraps @precedence/cli's buildCatalog; writes .precedence/catalog.pcs
├── pick.ts    serves @precedence/viewer, opens your app at ?precedence=pick, writes the plan sent back
├── plan.ts    reads plan.json, or scaffolds a draft (--ci) from the catalog
└── apply.ts   wraps @precedence/instrument's instrument() — preview() and apply()
```
