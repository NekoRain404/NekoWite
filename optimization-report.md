# Optimization Report: FloatBox rAF batching

Branch: `opt/floatbox-rAF` (worktree `.worktrees/opt-floatbox`)

## Problem

Every `pointermove` during a FloatBox drag/resize/rotate called `applyDelta(...)`
→ `updateFloatProps(...)` → `view.dispatch(setNodeMarkup(...))`. The mdx node-view
(`packages/editor-core/src/mdx/node.ts`) responds to any attrs change with
`app.unmount()` + `createApp().mount()` — a full Vue tree rebuild per move event,
causing visible drag jank.

## rAF scheduler design

Added a module-level frame scheduler in `apps/desktop/src/plugins/floatbox.ts`:

```ts
let pendingFrame: number | null = null
let pendingDelta: { dx: number; dy: number } | null = null
```

- `onWindowPointerMove` (floatbox.ts:141) only computes the *cumulative* `dx/dy`
  from the pointerdown origin, stores them into `pendingDelta`, and schedules a
  single `requestAnimationFrame(flushPendingDelta)` **iff** `pendingFrame` is null.
- `flushPendingDelta` (floatbox.ts:133) reads the latest `pendingDelta`, clears it,
  computes the geometry via the unchanged pure functions (`applyDrag/applyResize/
  applyRotate`), and dispatches exactly one ProseMirror transaction.
- `onWindowPointerUp` (floatbox.ts:155) cancels a still-pending frame and calls
  `flushPendingDelta()` synchronously so the final delta is never lost.

Because only the latest pending delta is kept and a new frame is only scheduled when
none is in flight, N pointermoves in a frame collapse into 1 dispatch.

## Cumulative vs incremental delta — choice and rationale

Chose **cumulative** (delta measured from pointerdown, base fixed at pointerdown):

- `dx = e.clientX - session.startX`; `base` is frozen in the session at pointerdown.
- When intermediate frames are dropped (the whole point of rAF batching), each flush
  still applies the *absolute* position from the pointerdown base — no accumulated
  drift, final position is always exact.
- An incremental scheme would compound rounding/error and could land on the wrong
  final position if a frame is skipped.

All three modes (drag / resize / rotate) share the same scheduler and the same
cumulative semantics; rotate recomputes the pointer angle from `startX + dx, startY + dy`.

## Pure functions & node view

- `applyDrag / applyResize / applyRotate / normalizeProps / updateFloatProps`
  signatures and geometry logic untouched (`apps/desktop/src/services/floatProps.ts`).
- `mdxNodeView` (node.ts) untouched — optimization point is dispatch frequency, not
  the node-view structure.

## Test adjustments

`apps/desktop/src/plugins/floatbox.test.ts`:

- Drag interaction tests that asserted an immediate synchronous dispatch were made
  async and now `await nextFrame()` (`requestAnimationFrame` round-trip) before
  asserting, matching the new rAF semantics.
- Added a test **`coalesces rapid pointermoves into a single dispatch per frame`**
  (3 pointermoves → exactly 1 dispatch with the final cumulative x/y).
- Added a test **`flushes the last pending delta synchronously on pointerup`**
  (move then pointerup before any frame → 1 synchronous dispatch).
- All assertion strengths preserved; geometry pure-function tests unchanged.

## Verification

- `pnpm --filter @nekowite/desktop test` — 19 files / 98 tests passed (incl. floatbox 16)
- `pnpm --filter @nekowite/desktop typecheck` (vue-tsc -b) — clean
- `pnpm --filter @nekowite/desktop lint` — clean
- `pnpm -r test` — editor-core 80 / plugin-host 20 / desktop 98, all green

## Commit

- `commit hash`: `c0793c1` (perf(desktop): batch FloatBox drag pointer moves via requestAnimationFrame)

## Concerns

- `requestAnimationFrame` under the happy-dom test env returns an object handle
  (not `number`); the code treats the handle opaquely (only null-check + pass to
  `cancelAnimationFrame`), so it is environment-agnostic.
- If the FloatBox component unmounts mid-drag, the module-level `session` may still
  hold a stale view until the next `pointerup`; behavior is unchanged from before.
- Real-world jank reduction depends on the node-view `update()` still re-rendering on
  each dispatch (unchanged) — batching reduces *frequency*, not per-dispatch cost.
