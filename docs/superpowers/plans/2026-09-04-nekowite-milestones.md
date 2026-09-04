# NekoWite Feature Roadmap — Execution Plan (Phase 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement each milestone node. Each node is an independent subsystem → its own plan → one or more subagents, verified before the next.

**Goal:** Overnight, close the highest-priority gaps in `docs/dev.md` (M1–M6) so the app moves toward a professional MDX document editor, in a strict order: security → MDX fidelity → image/table → full-text index → performance → product maturity.

**Architecture:** Each milestone is a node. Node N is verified (typecheck/lint/tests/build/E2E green) before Node N+1 starts, so subagents never work on a broken base. Verify with `pnpm -r typecheck && pnpm -r lint && pnpm -r test && pnpm exec playwright test`.

**Spec:** `docs/dev.md` (sections 8, 4.2, 5, 6, 7, 9, 13).

## Global Constraints
- Behavior-preserving; never silently break Markdown/MDX source.
- editor-core must not depend on desktop APIs; file/key/system policies live in the Rust layer + gateway contracts.
- Long tasks are async, cancellable, and recoverable.
- Every feature: happy path + failure + cancel paths, a unit/E2E test, no a11y regressions, errors are clear + recoverable.
- Must pass `pnpm -r typecheck`, `pnpm -r lint` (0/0), `pnpm -r test`, `cd apps/desktop && pnpm exec playwright test` (4/4), and (for Rust) `cargo test`.

---

### Node 1 — M1 Security correctness (verify + close gaps)
Most of M1 is already landed (plugin gating, vault_root binding, Argon2id, CSP, key masking). Sub-agent verifies the remaining edges and closes them:
- [ ] plugin top-level code never executes before digest+consent (confirm the gated-import invariant with a spy test).
- [ ] plugin cannot read the raw API key (Rust returns only the mask) — confirm no frontend path exposes it.
- [ ] vault_root forgery rejected (Rust binding) + `register_vault` wired on every vault open path.
- [ ] CSP vs plugin-loading model consistent (plugins disabled under strict CSP; notice surfaced).
Acceptance: the above are covered by tests; report the security posture honestly (what is change-detection vs true isolation).

### Node 2 — M2 MDX fidelity
- [ ] Round-trip test set per dev.md §4.2 (nested JSX, JSX attr expressions, import/export, tables w/ components, image attrs, math, mixed C/J/E, invalid MDX). Assert semantic structure preserved.
- [ ] Unknown JSX / uneditable nodes render a **source placeholder** rather than being silently deleted; serialization preserves them byte-for-byte.
- [ ] Frontmatter preserved; expressions/imports not reordered for unmodified docs.
Acceptance: round-trip suite green; an unknown-JSX doc opens, shows a placeholder, and round-trips unchanged.

### Node 3 — M3 Image + Table professional editing
- [ ] Image: property panel (alt/title/link/width/align/original size/restore/replace/delete); selected state + clear resize handle; keyboard width adjust; proportional lock; **one undo step per drag** (merge undo history); pre-import size/format check; error placeholder on load failure; alt/a11y.
- [ ] Table: custom rows/cols on insert; add/remove row & column; tab-to-append row; column-width drag; header toggle; cell align; cell copy/cut/paste; multi-cell selection.
Acceptance: each is closed-loop in the rendered editor; tests cover image single-undo + table row/col ops.

### Node 4 — M4 Full-text index + knowledge graph
- [ ] Persistent full-text index (incremental: process only changed files; first build in background; show index + truncation state; rebuild on error). Search across filename/path/title/tags/frontmatter/body/MDX text.
- [ ] Graph: full vault (no fixed 200), incremental node/edge updates, correct relative/absolute/same-name/same-dir link resolution, broken-link + orphan display, layout in a Worker, no recompute on resize/theme, filters (dir/tag/link-type).
Acceptance: 10k-file search indexed once then P95 ≤ 300ms; graph reflects a new note + new link without manual relayout.

### Node 5 — M5 Large-vault performance
- [ ] Remove / make non-silent the hard truncations (vault walk 2048, graph 200, Rust search 512 dirs) — raise or page explicitly.
- [ ] Worker-ize parsing + graph layout; async everything cancellable.
- [ ] Resource-peak guard on image import (stream/avoid full Base64 copy where feasible).
- [ ] Add a lightweight perf harness (startup, open, search, graph) to record before/after numbers.
Acceptance: a recorded benchmark shows no eager main-thread block; numbers captured.

### Node 6 — M6 Product maturity
- [ ] History/crash recovery + conflict resolution + auto-backup basics (or a clear documented path + tests).
- [ ] A11y: keyboard flow + ARIA on image/table controls; focus trap on dialogs (verify existing).
- [ ] Plugin SDK doc + example + API version compatibility notes; stable public surface (curated index).
Acceptance: a11y smoke + a committed example plugin doc; no regressions.

---

## Execution protocol
- One node at a time; verify that node fully green before the next.
- Each node = superpowers:writing-plans (its own detailed plan) → superpowers:subagent-driven-development (subagents implement task-by-task w/ review) → I run the full verification + commit + push+merge.
- Save detailed per-node plans under `docs/superpowers/plans/`.
