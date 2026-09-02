# NekoWite Optimization Report — exportToPdf timer cleanup + RefSidebar computed

Branch: `opt/export-refs`
Date: 2026-09-02

## Item 1 — `apps/desktop/src/services/export.ts` `exportToPdf` timer cleanup

### Timing decision

`window.print()` in the target desktop webviews (WebView2 / WKWebView / WebKitGTK) is
**blocking**: the call does not return until the user closes the print dialog. The design
preserves the "cleanup runs after the print flow finished" semantics by removing the
iframe *after* `print()` returns.

Sequence per invocation:

1. Create hidden iframe, set `srcdoc`, append to `body`.
2. Start a 60s fallback `setTimeout` (held in `cleanupTimer`) — unchanged hard bound from
   the old code, so no regression; it only ever fires if `onload` never does (e.g. srcdoc
   load failure) and guarantees a hidden iframe can never be leaked longer than a minute.
3. On `onload`: focus, then `try { contentWindow?.print() } catch {} finally { cleanup() }`.
   - Because `print()` blocks, the `finally` runs exactly once the dialog has been
     closed/cancelled → immediate `iframe.remove()` plus `clearTimeout(cleanupTimer)`.
   - `catch {}` swallows print errors (old code swallowed too) but keeps them flowing to
     `finally`, so every path — success, throw, timer-only — funnels into the single
     `cleanup()` function. No orphaned timer, no double-remove: the first call clears the
     timer id; a later stray call is a no-op since the element is already detached.

Alternative considered: `onafterprint`-event-driven removal, which also covers a
hypothetical non-blocking `print()`. Rejected as unnecessary for the actual WebView
targets where `print()` blocks, and it would complicate the code; the 60s fallback
already covers the async-return case harmlessly. Documented here per request.

### Tests

Added a `describe('exportToPdf')` block to `apps/desktop/src/services/export.test.ts`
using a mocked `document.createElement` / `body.appendChild` fake iframe plus fake
timers. Three cases:

- successful `print()` → exactly one `remove()`, and advancing 60s+ does **not** remove
  again (timer cancelled);
- `print()` throws → exactly one `remove()`, timer cancelled;
- `onload` never fires → iframe still attached at 59,999ms, removed at exactly 60,000ms.

Note: real `iframe.contentWindow.print()` is not exercised (happy-dom has no working
print); correctness of the real end-to-end print flow is unchanged from before and
verified manually — dialog opens, preview shows the render, iframe is torn down right
after the dialog closes.

## Item 2 — `apps/desktop/src/ui/RefSidebar.vue` double search evaluation

Replaced the duplicated template evaluation
(`v-for="r in store.search(query)"` / `v-if="store.search(query).length === 0"`)
with a single `computed`:

```ts
const results = computed(() => store.search(query.value))
```

Template now uses `v-for="r in results"` and `v-if="results.length === 0"`. The computed
recomputes whenever `query` changes (the only reactive input to `store.search`), so
search behavior is identical while `store.search` runs once per change instead of twice
per render.

### Tests

No existing RefSidebar test file existed and `@vue/test-utils` is not a dependency, so
per the brief a logic test was added to `apps/desktop/src/stores/refs.test.ts` that
mirrors the component's exact pattern: a `query` ref feeding `computed(() => store.search(query.value))`,
asserting results update on query change (2 results → filtered → empty → back to 2).

## Verification

- `pnpm --filter @nekowite/desktop test`: 19 files / 100 tests passed (baseline was 96;
  +3 exportToPdf, +1 computed search).
- `pnpm --filter @nekowite/desktop typecheck`: green (`vue-tsc -b`, no errors).
- `pnpm --filter @nekowite/desktop lint`: clean (only pre-existing ESLintRC deprecation
  warning).
- `pnpm -r test`: no regression — editor-core 80/80, plugin-host 20/20, desktop 100/100.

## Commit

Full hash: `fb03905`

## Concerns

- None blocking. Two notes:
  - The 60s fallback bound is retained from the old code; if a user ever leaves the
    print dialog open >60s the iframe is torn down mid-dialog (same as before). If UX
    wants to be kinder, this bound could be raised, but that is a product decision out
    of scope here.
  - `print()` throw path is exercised only via the here `finally`-based mock; real
    print-dialog behavior rests on the WebView blocking semantics described above.