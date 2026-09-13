# Split Scroll Smoothing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make source/rendered split mode smooth and interruptible while preserving responsive user scrolling and fixing long-document positioning.

**Architecture:** Move split synchronization into a frame-based coordinator in `EditorPane`, with one pending target per destination and a short easing loop. Use heading/line anchors in both directions and ratio fallback for documents without usable anchors. Keep existing pane public APIs and disable animation for reduced-motion and discrete jumps.

**Tech Stack:** Vue 3, TypeScript, Pinia, CodeMirror, Milkdown DOM, Vitest, requestAnimationFrame.

---

### Task 1: Add pure anchor mapping helpers

**Files:**
- Modify: `apps/desktop/src/services/scrollSyncAnchors.ts`
- Test: `apps/desktop/src/services/scrollSyncAnchors.test.ts`

- [ ] **Step 1: Write failing tests** for selecting the nearest heading at or before a rendered scroll position, converting a heading index to its source line, and clamping line/ratio inputs at document boundaries.
- [ ] **Step 2: Run** `apps/desktop/node_modules/.bin/vitest run src/services/scrollSyncAnchors.test.ts` from `apps/desktop`; verify the new tests fail because the reverse-mapping helpers do not exist.
- [ ] **Step 3: Implement** small pure helpers that accept heading top offsets, viewport scrollTop, and parsed outline items; return `null` for empty/mismatched inputs and never access DOM globals.
- [ ] **Step 4: Re-run** the focused test and confirm all cases pass.
- [ ] **Step 5: Commit** with `git add apps/desktop/src/services/scrollSyncAnchors.ts apps/desktop/src/services/scrollSyncAnchors.test.ts && git commit --no-gpg-sign -m "test: cover split scroll anchor mapping"`.

### Task 2: Add interruptible animation coordinator

**Files:**
- Create: `apps/desktop/src/services/splitScrollCoordinator.ts`
- Test: `apps/desktop/src/services/splitScrollCoordinator.test.ts`

- [ ] **Step 1: Write failing tests** using injected clock/frame callbacks and numeric scroll adapters. Cover coalescing multiple targets into one frame, easing toward the latest target, immediate cancellation, and reduced-motion immediate assignment.
- [ ] **Step 2: Run** `apps/desktop/node_modules/.bin/vitest run src/services/splitScrollCoordinator.test.ts`; verify the tests fail because the coordinator is absent.
- [ ] **Step 3: Implement** a framework-independent coordinator with `schedule(target, animated)`, `cancel()`, and `dispose()`. Keep one frame handle, clamp target values, use an ease-out interpolation over 80–120ms, and cancel the frame when the destination is within subpixel tolerance.
- [ ] **Step 4: Re-run** the focused test and confirm no frame accumulation or stale target behavior remains.
- [ ] **Step 5: Commit** with `git add apps/desktop/src/services/splitScrollCoordinator.ts apps/desktop/src/services/splitScrollCoordinator.test.ts && git commit --no-gpg-sign -m "feat: add interruptible split scroll coordinator"`.

### Task 3: Integrate coordinator and bidirectional anchors

**Files:**
- Modify: `apps/desktop/src/ui/EditorPane.vue`
- Modify: `apps/desktop/src/view/SourcePane.vue`
- Modify: `apps/desktop/src/view/RenderedPane.vue`
- Modify: `apps/desktop/src/features/editor/controller/editorScrollSync.ts`

- [ ] **Step 1: Add failing integration tests** in `apps/desktop/src/ui/EditorPane.scrollSync.test.ts` for long unequal-height panes reaching scrollTop 0 from the bottom, reverse heading-based mapping, and no feedback oscillation during rapid events.
- [ ] **Step 2: Run** `apps/desktop/node_modules/.bin/vitest run src/ui/EditorPane.scrollSync.test.ts`; verify the new scenarios fail or expose the current ratio-only behavior.
- [ ] **Step 3: Implement** one coordinator owned by `EditorPane`; route source and rendered user scroll events into it through the existing exposed pane methods. Add a rendered-pane method that reports the nearest visible heading/source line. Use heading mapping in both directions, ratio fallback otherwise, and pass an explicit `animated` flag that is false for mode changes, divider resize completion, outline jumps, top/bottom edges, and reduced motion.
- [ ] **Step 4: Remove Pinia watcher feedback as the primary transport** while retaining store values for persisted/current scroll state. Ensure programmatic writes carry a source token so their scroll events cannot become new user-originated sync requests.
- [ ] **Step 5: Re-run the integration tests and confirm rapid input remains responsive and long documents can move from bottom to top.
- [ ] **Step 6: Commit** with `git add apps/desktop/src/ui/EditorPane.vue apps/desktop/src/view/SourcePane.vue apps/desktop/src/view/RenderedPane.vue apps/desktop/src/features/editor/controller/editorScrollSync.ts apps/desktop/src/ui/EditorPane.scrollSync.test.ts && git commit --no-gpg-sign -m "fix: smooth and anchor split pane scrolling"`.

### Task 4: Verify accessibility and regressions

**Files:**
- Modify: `apps/desktop/src/ui/EditorPane.scrollSync.test.ts` (only if additional assertions are needed)

- [ ] **Step 1: Add a test** that mocks `matchMedia('(prefers-reduced-motion: reduce)')` and asserts counterpart scrolling is immediate.
- [ ] **Step 2: Run focused tests** for coordinator, anchors, editor scroll sync, SourcePane, RenderedPane, and EditorPane.
- [ ] **Step 3: Run package verification:** desktop Vitest, editor-core Vitest, plugin-host Vitest, Vue/TypeScript checks, ESLint, and Vite production build.
- [ ] **Step 4: Run `git diff --check` and inspect the final diff for unrelated changes.
- [ ] **Step 5: Commit any test-only adjustment** with `git add apps/desktop/src/ui/EditorPane.scrollSync.test.ts && git commit --no-gpg-sign -m "test: cover reduced motion split scrolling"`; if no test-only adjustment was needed, leave the tree unchanged.
