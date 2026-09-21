# Data Safety and Live Agent Implementation Plan

> **For agentic workers:** Use executing-plans and test-driven-development task by task. Only the primary agent may update this document.

**Goal:** Repair confirmed data-loss paths, then establish real Agent evidence rather than treating skipped integrations as success.

**Architecture:** Keep filesystem policy in existing services and stores. Revalidate document identity across asynchronous work; failed observations never authorize destructive actions. Preserve the current dirty worktree, Linux scope and dependency versions.

**Tech Stack:** Vue, Pinia, TypeScript, Vitest, Rust, Tauri, OpenCode ACP.

## 1. Save Read Failures

Files: `apps/desktop/src/stores/tab-write-preconditions.ts`, `tab-save-external-change.test.ts`.

- [x] Change the existing unreadable-file expectation to preserve the missing file and dirty buffer. Add permission/IO failures, retained conflicts, and failed reads across vault switches.
- [x] Run `npx --yes pnpm --filter @nekowite/desktop test src/stores/tab-save-external-change.test.ts`; observe assertions failing because writes occur.
- [x] On read failure refuse, preserve conflict evidence, notify only while vault/path still match. Revalidate path after successful reads as well.
- [x] Rerun this suite and related save suites. Acceptance: no write on unknown disk state; explicit Save-As remains functional.

Rollback risk: callers formerly relying on silent recreation of deleted files now receive a failed save. This is intentional; existing external-change recovery detaches missing paths for Save-As.

## 2. Delete Ownership

Files: `apps/desktop/src/stores/tab-file-operations.ts`, `tabs.ts`, and a focused `tab-delete-races.test.ts`.

- [x] Reproduce new edits, replacement tabs, rename and vault changes while deletion waits.
- [x] Capture original tab identity and edit revision. Remove only unchanged original tabs; preserve newer work as unsaved detached buffers after confirmed deletion.
- [x] Run focused delete and lifecycle tests; audit pending-save/delete ordering separately before declaring data safety complete. Follow-up identified task 5.

Rollback risk: preserved buffers must not autosave into the deleted path. In-flight writes need separate coordination, not just a UI identity check.

## 3. Asset Probe Errors

Files: `apps/desktop/src/services/note-delete.ts`, its tests, and the three stat-backed existence adapters in tab operations, note-delete composable and file-tree composable.

- [x] Make permission/IO probe failures produce a partial result in a failing test.
- [x] Distinguish confirmed absence from unknown state in adapters; never classify permission errors by a filename substring.
- [x] Keep note deletion failure fatal and attachment failures visible; test all deletion entry points.

Rollback risk: ordinary notes without assets must not produce false warnings.

## 4. Real Agent Gates

Files to inspect: `scripts/verify-acp-live.sh`, `apps/desktop/src-tauri/tests/agent_session_lifecycle_test.rs`, `agent_session_replay_live_test.rs`, `agent_live_test.rs`, and ACP development specifications.

- [x] Verify bundled engine availability and run isolated, no-provider lifecycle tests against it. Require actual execution and reject SKIP as evidence.
- [x] Inspect paid-provider prerequisites and runner artifact handling before invoking provider tests. Do not expose credentials or overwrite prior logs.
- [ ] Verify production-runtime prompt, cancellation, replay and note-edit paths with a real provider when prerequisites permit. Report missing evidence explicitly.

Rollback risk: live tests consume provider resources and create engine profiles; isolate profiles inside repository-owned test output.

## 5. Storage Commit Preconditions

The follow-up audit confirmed that frontend preflight alone cannot prevent a save
already crossing IPC from recreating a deleted or renamed path.

Backend scope: `src-tauri/src/storage/{save_store,trash_store}.rs`,
`src-tauri/src/commands/fs.rs`, `src-tauri/tests/save_precondition_ipc_test.rs`.
Frontend scope: filesystem contracts, Tauri/memory gateways, save preconditions
and save orchestration, with their focused tests.

- [x] Add optional `expected_content` to the write IPC. Ordinary editor saves
  supply the exact preflight bytes (including explicitly acknowledged external
  bytes). A missing or changed target must reject before snapshot/publication.
- [x] Preserve existing storage write API for explicit creation/Save-As callers;
  add a guarded entry point and check expected bytes under the write lock.
- [x] Make delete acquire the same lock before resolving/moving its target.
- [x] Test real IPC: stale save after delete, file rename, parent rename or newer
  write is rejected; matching bytes succeed; omission retains explicit creation.
- [x] Test save completion after detach/replace/vault switch never marks unrelated
  or untitled content clean. Revalidate ownership before commit and bookkeeping.
- [x] Run backend tests and integrated frontend verification. This lock coordinates
  app operations only; do not claim it prevents uncooperative external processes
  from changing a file during the final OS-level publish window.

Rollback risk: protocol propagation must be complete; omitted guards preserve
explicit-creation semantics and therefore cannot protect ordinary saves.

### Verification Notes

- Tasks 1-3: regression failures observed first; focused deletion/asset verification
  passed 103 tests. Frontend full verification before task 5 passed 5853 tests,
  typecheck, lint (462 existing warnings, no errors), and build.
- Task 5 frontend: 10 failing regression assertions before implementation;
  35 focused tests passed afterward. Updated 4-argument mock expectations to
  assert the exact fifth-argument baseline; 49 existing save/lifecycle tests pass.
- Primary independently reran `agent_session_lifecycle_test`: 5 real engine
  tests passed, 0 ignored, no SKIP (43.77 seconds), and the isolated empty replay
  test passed (28.42 seconds, no SKIP). Subsequent user-authorized provider
  testing passed real prompt, cancellation plus another turn, and history replay.
- Final task 5 frontend verification: root typecheck, lint and build exit 0.
  Full `pnpm test` rerun passed 5864 tests (959 editor + 132 plugin + 4773 desktop).
  The first concurrent run had two editor timeouts; the isolated rerun passed
  without changing implementation or timeouts. Lint remains 462 warnings/0 errors.
- Primary reran Rust `save_precondition_ipc_test` (11 passed), `--lib storage::`
  (14 passed), and `fs_test`, `recovery_test`, `rename_metadata_test`, `trash_test`,
  `failed_save_test`, `write_atomicity_test`, `atomic_write_test` (106 passed,
  3 pre-existing ignored Stronghold recovery tests). Ignored tests are not evidence.
- `scripts/verify-acp-live.sh` removes a fixed output directory; do not run it
  unchanged over existing evidence. Provider testing needs a unique output root.
- Existing `commands/fs.rs` already exceeds the line budget (706 lines before
  this task). Exception: only the optional write argument and forwarding call
  change here; splitting all command registration is separate work. At 300+
  lines, `tab-save.ts` should next split its transaction preparation from commit
  bookkeeping; `tabs.ts` and `use-file-tree.ts` retain existing feature boundaries.
  `trash_store.rs` is 331 lines including its lock regression; extract trash-entry
  serialization as a cohesive slice before additional storage behavior is added.
- Limits: byte comparison cannot detect delete/recreate with identical bytes;
  the shared process lock cannot serialize independent external applications.
- Independent spec review passed (11 frontend tests rerun); subsequent quality
  review found no critical/important introduced defect (18 focused tests rerun).
  Follow-up coverage: use a real editor flush hook to publish debounced input
  during deletion, complementing the existing revision/state race tests.

### Beta Follow-up: 2026-09-20

- Real provider permission test FAILED: the first approved write succeeded, but
  `permission_grants` returned no persistent row. Do not count this gate as passed.
- Root cause verified from bundled 1.18.29 artifact: ACP `HP.process` calls
  `sdk.permission.reply`; legacy `Permission.reply` appends to an in-memory
  `approved` array. `/api/permission/saved` instead reads the separate V2 store.
  The no-provider V2 evaluation/revoke test passes, but does not prove ACP revoke.
  Prior comments equating these paths are incorrect. No engine upgrade or
  synthetic persistent permission is authorized by this diagnosis.
- Correct the bilingual consent and settings text so an empty persistent list
  does not imply absence of active grants. Keep the failed live regression visible;
  temporary grant revocation remains unimplemented, not fixed by changing copy.
- Release artifacts predate current fixes. Rebuild all three Linux formats only
  after current-source gates; validate payloads and isolated UI basic workflows.
- Startup probe must isolate profiles, propagate failures and kill only its own
  process group. Scope: `scripts/boot-probe.sh` plus regression harness. Acceptance:
  missing/crashed artifact fails, timed survival is labelled survival only, no
  real user profile access. Rollback risk: old false-positive startup checks fail.
- Packaging must use repository-local scratch/cache and verify every exact output
  belongs to this build. Existing GLIBC_2.39 requirement needs an explicit Linux
  baseline; do not claim older distribution support without testing.
- Remaining release gates: fresh root typecheck/lint/tests/build, relevant Rust
  IPC coverage, real note edit path, isolated create/edit/save/reopen UI smoke,
  fresh AppImage/deb/rpm payload verification. No release completion claim yet.
- This follow-up passed root typecheck, lint (462 warnings, no errors), all 5864
  frontend tests and build. Logs: `test-results/beta-2026-09-20/`. Consent/settings
  focused tests passed 37; bilingual consent assertions additionally passed 30.
- Primary reviewed and reran startup harness: 42 assertions pass. A 10-second
  isolated launch of the OLD portable artifact survived; this verifies the probe,
  not current-source release readiness. Portal logs expose an overlong Unix socket
  path in the nested runtime directory; shorten it before desktop smoke acceptance.

- Startup socket regression now passes: runtime shortened to `target/b.XXXXXX/r`;
  all 45 harness assertions pass. An 8-second OLD portable probe survives without
  the previous overlong-socket message; current binary still needs validation.
- Save browser smoke now closes the active tab before reopening and requires the
  frontmatter control instead of silently skipping it. All 8 strict cases pass.
  These use mocked Tauri storage, not native disk persistence evidence.
- Primary reviewed packaging changes and independently reran its 44 assertions
  successfully. Exact artifacts are staged before publication, old release files
  remain recoverable, and a real RPM executable is selected. Native package build
  completed with exit 0; all three formats passed engine and notices checks.
- Fresh native executable (2026-09-20 07:46 UTC) passed real Tauri WebDriver
  create/edit/Ctrl+S/disk-read/tab-reopen/application-restart checks, exit 0.
  Screenshot independently inspected. Evidence: `test-results/native-beta-smoke/run-r3U2ot/`.
  Reusable runner: `apps/desktop/e2e/native-beta-smoke.mjs`; syntax and ESLint pass.
  Packaging rerun also passed all 4773 desktop unit tests, typecheck and lint.
- Published portable binary independently passed the full native smoke again:
  `test-results/native-beta-smoke/run-nKOXkJ/`, exit 0. Short-profile runner no
  longer reports overlong sockets. Native startup survival probe also passed.
- Fresh candidates: `release/nekowite_1.0.0_amd64.AppImage`,
  `release/nekowite_1.0.0_amd64.deb`, `release/nekowite-1.0.0-1.x86_64.rpm`.
  Prior files remain in `release/superseded/build.Gxa38B`. These are local Beta
  candidates, not a claim of clean-machine installation or older-Linux support.
  ACP temporary-grant revocation and the notices' recorded distribution
  obligations remain explicit follow-ups; packaging success does not resolve them.

- Additional basic-use browser gate passed: 58 tests in 4.7 minutes, exit 0.
  Coverage: IME composition, lifecycle, source fidelity/no-op save, split scroll,
  image/table editing, search/graph and create/rename/delete/trash restore.
  Log: `test-results/beta-2026-09-20/basic-regression.log`. These tests mock IPC.
- Extracted deb and rpm binaries plus the AppImage's normal `AppRun` launcher
  each passed native create/edit/save/reopen/restart checks, exit 0. Primary
  inspected reports: `run-xQBRRR`, `run-gDfmln`, `run-WziO8h` under
  `test-results/native-beta-smoke/`. Package evidence: `test-results/package-beta-6DS5c5/`.
  Direct AppImage internal-ELF launch failed because it bypassed AppRun's WebKit
  environment; retained as diagnostic evidence, not a successful package launch.
  System installation remains unverified. Subsequently the original AppImage
  itself passed the full native workflow with no extraction override (exit 0),
  evidence `test-results/native-beta-smoke/run-40CiC1/`.
  Beta handoff and explicit limitations: `docs/development/LINUX-BETA-VALIDATION.md`.

- AI/pet browser regression: 70 passed, 1 failed due to the old unsafe empty-grant
  copy assertion. Updated only `e2e/agent-settings.spec.ts` to require both the
  saved-rule statement and explicit temporary-grant caveat. Focused rerun passed
  (1 test, exit 0), ESLint and diff checks passed. Full first-run evidence remains
  `test-results/beta-2026-09-20/agent-pet-regression.log`; focused evidence is
  `agent-permission-copy-green.log`. This does not fix engine-side grant revocation.

## Integrated Verification

- [x] Run root typecheck, lint, tests and build; preserve failures as evidence and repair relevant regressions.
- [x] Run relevant Rust/IPC checks for backend changes and real engine checks for integration claims.
- [x] Review diff and status; no commit or dependency update is requested. Keep the full goal active until data safety and real Agent requirements are verified.
