# @precedence-dev/wizard

The one-command path into Precedence: scan a project, pick the outcomes worth
tracking in a browser, review the diff, apply it. Every project change — the
package install, the `next.config` wrap, the source edits — is shown and
confirmed first (`-y` to skip the prompts). The scan runs the real analyzer
in-process, picking happens in
[`@precedence-dev/viewer`](https://github.com/precedence-dev/sdk/tree/main/packages/viewer),
applying is [`@precedence-dev/instrument`](https://github.com/precedence-dev/instrument).
Nothing reads your source into an LLM; every step is deterministic. No VCS
required.

## The flow

```sh
npx @precedence-dev/wizard          # scan → pick → preview
npx @precedence-dev/wizard --apply  # …and write it
```

1. **Scan** — writes `.precedence/catalog.pcs`. Source dirs are auto-detected
   (`src` / `app` / `pages` / `components`, else the repo root); `--dir <path>`
   (repeatable) overrides that for monorepos.
2. **Set up** (Next, first run only, no `layout.tsx` edit):
   - installs `@precedence-dev/sdk` (+ `-D @precedence-dev/cli`) if they're
     missing — detects npm / pnpm / yarn / bun, asks first (`-y` to skip)
   - writes `instrumentation-client.ts` (Next auto-loads it; it calls
     `precedencePicker()`)
   - wraps `next.config` with `withPrecedence(...)` in place when the export is an
     unambiguous `export default nextConfig`; otherwise prints the one-line change
   - restart your dev server, then it waits for it to come up
3. **Pick** — opens your running app at `?precedence=pick`; a right-side drawer
   appears. Hover and click real elements; for each outcome you check, name it,
   add a one-line meaning, and tick the properties to send. **Pause** lets you
   click through the app normally. Anything already in `.precedence/plan.json`
   shows up marked `● in plan` and is carried through — the picker merges, it
   doesn't replace. **Send to wizard** when done. If a plan already exists the
   wizard asks whether to open the picker or use it as-is.
4. **Preview** — the exact source diff is printed: one
   `precedence.track("event", { psc_id, …props })` per branch + an
   `import { precedence } from "@precedence-dev/sdk"`.
5. **Apply** — with `--apply`, it writes; run interactively, it asks first. Then
   call `installPrecedence({ endpoint: "<your collector>" })` once at your app
   root (`@precedence-dev/sdk`) — omit `endpoint` to `console.debug` in dev.

The wizard guesses your dev URL from `package.json` (`--app <url>` to override).
No `--track` needed — the calls target `precedence.track` from
`@precedence-dev/sdk`; pass `--track "myFn from @/lib/analytics"` only to bake
into your own function. Drop `--apply` to stop after the preview.
`.precedence/plan.json` is the source of truth for the events — keep it in the
repo; a plan already present skips straight to preview. The picker runs as an
overlay in your live app, so your dev server has to be up (`--ci` skips it and
scaffolds a draft `plan.json` to hand-edit instead).

## Why a browser step

Deciding *what* is a meaningful event is product knowledge. The picker overlays
your running app so growth/marketing can click the real thing, then name and
**define** the event — no codebase access, no ticket. Engineering's part is
bounded: the preview diff and the commit. The exported `plan.json` (names,
definitions, properties, source anchors) is what both sides review and what
stays in the repo as the answer to "what does this event mean".

## Options

| flag | meaning |
| --- | --- |
| `--dir <path>` | source dir to scan, repeatable (default: auto-detect, else repo root) |
| `--track <spec>` | override the call target (default `precedence.track from @precedence-dev/sdk`); e.g. `"myFn from @/lib/analytics"` to bake into your own function |
| `--delegated <file>` | write the synthetic-anchor listener here on `--apply` (links / bare buttons); import it once at your app root |
| `--apply` | write source after the preview |
| `-y`, `--yes` | skip the install + "apply?" confirmations |
| `--app <url>` | your running dev server (default: guessed from `package.json`) |
| `--types` | resolve declared types (slower; enables interprocedural outcomes) |
| `--ci` | non-interactive: scaffold a draft `plan.json` instead of the pick step |
| `--no-open` | don't launch a browser |

## Packages

This depends on `@precedence-dev/cli`, `@precedence-dev/instrument`, and
`@precedence-dev/viewer` as normal semver deps, so `npx @precedence-dev/wizard` just
works. All five packages are FSL-1.1-ALv2 (each release converts to Apache-2.0
two years after it ships).

## Structure

```
src/
├── cli.ts     orchestration: scan → pick → preview → apply
├── detect.ts  framework + source-dir detection, file collection
├── scan.ts    wraps @precedence-dev/cli's buildCatalog; writes .precedence/catalog.pcs
├── wire.ts    first-run Next setup: instrumentation-client.ts + the withPrecedence hint + waitForServer
├── pick.ts    serves @precedence-dev/viewer, opens your app at ?precedence=pick, writes the plan sent back
├── plan.ts    reads plan.json, or scaffolds a draft (--ci) from the catalog
└── apply.ts   wraps @precedence-dev/instrument's instrument() — preview() and apply()
```
