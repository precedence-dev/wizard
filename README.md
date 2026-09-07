# @precedence/wizard

The one-command path into Precedence: scan a project, pick the outcomes worth
tracking in a browser, review the generated diff, apply it. It never modifies
your app on its own — the scan runs the real analyzer in-process, picking
happens in the standalone [`@precedence/viewer`](https://github.com/precedence-dev/sdk/tree/main/packages/viewer),
applying is [`@precedence/instrument`](https://github.com/precedence-dev/instrument).
Nothing reads your source into an LLM; every step is deterministic. No VCS
required — it reads and writes plain files, and `--apply` is a separate step
from the preview, so committing first is your call, not a precondition.

## The flow

```sh
# 1. scan → .precedence/catalog.pcs, and open the browser picker
npx @precedence/wizard

#    ...in the picker: growth/marketing select outcomes, name them, write what
#    each one means, choose properties, then export → .precedence/plan.json.
#    Keep that plan in the repo — it is the source of truth for the events.

# 2. preview the exact source diff the plan produces (writes nothing)
npx @precedence/wizard --track "track from @/lib/analytics"

# 3. apply it — the instrumentation is now a diff you can review and commit
npx @precedence/wizard --track "track from @/lib/analytics" --apply
```

`--ci` replaces step 1's browser with a scaffolded draft `plan.json` (every
anchor real, off the catalog) to hand-edit.

## Why a browser step

Deciding *what* is a meaningful event is product knowledge. The picker lets
growth/marketing select, name, and **define** events off a catalog of real code
paths — no codebase access, no ticket. Engineering's part is bounded: the one
`--track` import, the preview diff, the commit. The exported `plan.json` (names,
definitions, properties, source anchors) is what both sides review and what stays
in the repo as the answer to "what does this event mean".

## What it does

1. **Scan** — runs the real analyzer against the detected source dirs, writes
   `.precedence/catalog.pcs` (plus a `.precedence/.gitignore` for it, a courtesy
   for git users; `plan.json` stays tracked).
2. **Pick** — in `@precedence/viewer`, launched automatically (`--no-open` to
   skip). Export the plan to `.precedence/plan.json`.
3. **Preview** — `--track <spec>` (required for direct mode) prints the source
   diff and any drift warnings / skipped anchors. Nothing is written.
4. **Apply** — `--apply` writes the reviewed diff into your source. It's a
   separate invocation from the preview, so you've already seen exactly what
   lands. Review it and commit it on its own.

| flag | meaning |
| --- | --- |
| `--track <spec>` | e.g. `"track from @/lib/analytics"` — required before direct instrumentation |
| `--emit direct` \| `runtime` | `direct` bakes `track(...)` calls in; `runtime` emits `globalThis.__pm?.(…)` + needs [`@precedence/sdk`](https://github.com/precedence-dev/sdk) at the app root |
| `--runtime <file>` | direct mode: write the delegated-link listener here on `--apply` |
| `--apply` | write source (after you've reviewed the preview) |
| `--types` | resolve declared types (slower; enables interprocedural outcomes) |
| `--ci` | non-interactive: scaffold a draft `plan.json` instead of the pick step |
| `--no-open` | scan but don't launch the browser |

## One honest gap

**No account/registry backend yet.** The intended flow is: authenticate, then
fetch `@precedence/cli` from a gated registry so the scan still runs entirely on
your machine. Until that exists, this repo depends on `@precedence/cli` (and
`@precedence/instrument`, `@precedence/viewer`) as local `file:` siblings — the
same stand-in `@precedence/instrument` uses; see that package's README. Marked
in `src/cli.ts` at the point it'll be replaced; it doesn't change the shape of
the commands.

## Structure

```
src/
├── cli.ts     orchestration: scan → (pick, by you) → preview → apply
├── detect.ts  framework + source-dir detection, file collection
├── scan.ts    wraps @precedence/cli's buildCatalog; writes .precedence/catalog.pcs
├── plan.ts    reads plan.json, or scaffolds a draft (--ci) from the catalog
└── apply.ts   wraps @precedence/instrument's instrument() — preview() and apply()
```
