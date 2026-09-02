# Optimization Report: Lazy-load mathlive in editor-core

## Status

Done. All acceptance criteria met.

## Strategy chosen

Replaced the top-level static `import * as MathLiveNS from 'mathlive'` (which pulled the ~790KB
mathlive module into the editor bundle eagerly) with an internal cached dynamic `import('mathlive')`.

- Type-only import (`import type * as MathLiveNS from 'mathlive'`) keeps TS type info
  (`MathfieldElement`, `convertLatexToMarkup`) without any runtime module load.
- Module-level cache:
  - `let mathlivePromise: Promise<MathLiveModule | null> | null` — the in-flight/fulfilled promise.
  - `let mathliveModule: MathLiveModule | null` — the resolved module, so sync callers can detect
    "already loaded" without `await`.
- `loadMathLive()` is idempotent: first call starts `import('mathlive')`, caches the promise, and on
  resolution stores the module synchronously. On failure it resets both caches to `null` so a later
  call can retry, and it never produces an unhandled rejection.

### Sync APIs preserved (signatures unchanged)

- `renderLatexMarkup(latex): string`
- `createMathEditor(el, opts): MathEditorHandle`
- `MathEditorHandle` interface untouched.

### Degrade / upgrade mechanism (chosen tradeoff)

Source precedence in `getMathLive()`:
1. `globalThis.MathLive` (if present — preserves the existing script-tag escape hatch AND keeps the
   old tests' semantics where stubbing an empty global deliberately overrides the module).
2. The already-loaded `mathliveModule` (dynamic import only).
3. `null` → callers take the fallback path.

Fallback + upgrade:
- **First call** before the module resolves: `renderLatexMarkup` returns escaped text;
  `createMathEditor` returns a `contenteditable` handle. Both fire-and-forget `warmMathLive()` so the
  load starts immediately.
- **Subsequent calls** after the module resolves: real `convertLatexToMarkup` /
  `MathfieldElement` are used (checked via the sync `mathliveModule` cache).

### Preload integration

Exported `warmMathLive(): Promise<void>` and wired it into mount points (bodies only; exported
signatures untouched):
- `views.ts`: `makeMathNodeView` calls `warmMathLive()` when the first math node is mounted.
- `dialog.ts`: `openMathDialog` calls `warmMathLive()` on dialog open.

### Why this tradeoff

- The stated constraint **only** forbids changing the sync APIs and export signatures; everything else
  (including the described `warmMathLive` wiring) is in scope.
- With preload at node-view mount, documents containing math start loading mathlive immediately; the
  decompressed-but-not-yet-resolved first frame renders escaped/contenteditable, then upgrades on the
  next render/`openMathDialog` call. Pages without any math never pay the ~790KB cost.
- No auto re-render subscription was added: a node that rendered the escaped fallback stays that way
  until its next render/update triggers `renderLatexMarkup` again (per the task's recommended model).

## Test changes

`vi.mock('mathlive', ...)` still intercepts dynamic `import('mathlive')` in Vitest, so the mock
approach works. One test needed adjustment because the module is now async:

- `atoms.test.ts` "uses MathfieldElement and fires onChange on input": made `async` and added
  `await warmMathLive()` so the mocked module is cached before the sync call, exercising the real
  MathfieldElement path (not the contenteditable fallback).

The "degrade" tests are unchanged: stubbing `globalThis.MathLive = {}` deliberately wins over the
loaded module (source precedence #1), so the contenteditable/escape paths still pass deterministically.

## Verification

- `pnpm --filter @nekowite/editor-core typecheck` — clean.
- `pnpm --filter @nekowite/editor-core lint` — clean (only a pre-existing eslintrc deprecation warning).
- `pnpm --filter @nekowite/editor-core test` — **16 files / 80 tests passed**.
- `pnpm -r test` — no regression:
  - packages/editor-core: 16 files / 80 tests
  - packages/plugin-host: 4 files / 20 tests
  - apps/desktop: 19 files / 96 tests

## Concerns / follow-ups

1. **First-frame degradation**: if `warmMathLive()` cannot complete before the first math node
   renders (cold start on a large doc), that node shows escaped latex until its next render. A
   follow-up could add a one-time re-render in `views.ts` when the load promise resolves, but that
   was out of scope to keep the change minimal and match the task's stated model.
2. **Cache-vs-singleflight**: the promise cache neuters duplicate imports (React-StrictMode-style
   double-invocation is a non-issue for Vite/Prod), and load failures auto-retry on the next call.
3. **MathLive global priority**: if an app defines `globalThis.MathLive` with only a partial API,
   it still shadows the loaded module (unchanged legacy behavior; deliberate).
4. `apps/desktop/src/main.ts` still imports `mathlive/static.css` eagerly (CSS only, ~small) — no JS
   bundle regression from that. Left untouched as out of scope.

## Commit

hash: see `git log -1 --format=%H`