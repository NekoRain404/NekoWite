# Linux Audit Fixes

Scope: repair the confirmed audit findings without redesigning features or changing
dependencies, lockfiles, themes, Windows sources, or existing specifications.
Only the primary agent may update this plan. No commits are requested.

## Tasks and Acceptance

| Task | Owned files (under apps/desktop) | Acceptance and verification | Rollback risk |
| --- | --- | --- | --- |
| Per-session turns and rail generations | src/platform/gateways/tauri-agent*, src/app/agent-rail* | Overlapping prompts settle independently; stale resume cannot reverse a vault switch; acquired sessions remain resumable. Run gateway and rail Vitest suites. | Session cancellation and runtime teardown |
| Pending listener cancellation | src/platform/gateways/tauri-agent/{turns.ts,turn-registration.test.ts} | Closing, stopping or timing out settles a prompt before listener registration returns; late registration cannot send an expired prompt. Run deferred-registration regressions. | Listener ownership and asynchronous cleanup |
| File identity and save serialization | src/services/external-doc-sync*, src/stores/tab-file-operations*, src/stores/tab-save* | Rename/close/vault switch invalidate obsolete reads; only confirmed missing files detach; overlapping saves never write concurrently. Run focused store/service suites. | File association, autosave and move ordering |
| Pet event boundary | src-tauri/src/commands/agent.rs and scoped event module; IPC tests | Raw agent events target main only; projected pet task events continue. Test IPC event routing. | Event delivery |
| Pet navigation delivery | src-tauri/src/commands/desktop_pet*, main_window.rs, lib.rs; src/platform/pet-*-request* | Requests survive main-window recreation and are consumed only by main. Test queue, subscription and IPC access boundaries. | Startup, navigation and capability policy |
| Pet character binding | src-tauri/src/desktop_pet/{feature_switch,window_host}.rs and scoped modules; IPC tests | Selecting B after A and then editing General creates no duplicate automatic pet; explicit multiple instances remain supported. | Window identity and feature switches |
| Native harness reliability | e2e/webkit probe, instrument, measure and verifier modules | Isolated probes validate only requested subjects; pending wheel input is settled; screenshot coordinates match raster size; JSON output is complete. Node regressions and native WebKitGTK probes. | Measurement reliability, not application behavior |

## Execution and Review

1. Reproduce each defect before implementation, using deterministic deferred IO or
   native engine measurements. Do not turn failing assertions into skips.
2. Delegate independent file scopes; subagents cannot edit documentation or reset
   the worktree. Primary reviews all diffs and independently verifies results.
3. Keep new business modules below 500 lines. Existing oversized Rust command/host
   modules may receive narrowly scoped delegations; their full decomposition is a
   separate task, not an unrelated rewrite hidden in these fixes.
4. Run focused tests, then root typecheck, lint, tests and build. Run Rust tests and
   relevant Chromium/native WebKit checks. Report skipped external integration and
   packaging checks explicitly; a web build is not package-install verification.

## Fixes and Review

The primary agent reviewed the delegated changes and independently ran integration
verification. Nine confirmed product issues are addressed:

1. Concurrent AI sessions no longer share one pending-turn slot.
2. Stale session adoption cannot overwrite a newer vault selection.
3. Superseded UI requests retain successfully acquired backend sessions for reuse.
4. External reads and reloads revalidate file identity after IO; non-missing read
   failures no longer detach existing files.
5. Three or more overlapping saves acquire exclusive ownership after every wait.
6. Raw agent frames target the main window, not pet windows. IPC event tests cover
   the boundary while the separate projected pet task feed remains available.
7. Pet navigation persists until the main renderer subscribes and consumes it;
   both capabilities and the actual caller window restrict consumption to main.
8. Settings retarget the managed pet instance without creating a duplicate or
   replacing an explicitly opened additional instance after the managed one closes.
9. Prompt cancellation/timeout also works while event registration is pending.

Native test repairs cover selected-probe validation, pending wheel input, CSS to
raster coordinate scaling, real permission-card setup and complete JSON flushing.
Chromium fixtures now return empty pending-navigation queues; console errors remain
test failures. The settings scroll fixture waits for layout settlement before
assigning its test offset, without weakening the scroll-reset assertions.

Existing oversized Rust modules are scoped exceptions for this change:
`commands/agent.rs` (592 lines), `commands/desktop_pet.rs` (796) and
`desktop_pet/window_host.rs` (1024). New business modules remain below 500 lines;
large-scale decomposition of these existing modules is deferred.

## Verification

All completed commands below exited 0 on the integrated working tree:

| Check | Result |
| --- | --- |
| `npx --yes pnpm typecheck` | Passed |
| `npx --yes pnpm lint` | Passed; 462 existing warnings, no errors |
| `npx --yes pnpm test` | 5825 passed: editor-core 959, plugin-host 132, desktop 4734 |
| `npx --yes pnpm build` | Passed; large-bundle warnings remain |
| `npx --yes pnpm perf` | 10 passed |
| `cargo test --locked` in `apps/desktop/src-tauri` | 1309 passed, 0 failed, 5 ignored across 74 suites |
| Native harness Node regressions | 5 passed |
| Native WebKitGTK probes | agent-scroll, focus-ring, split-tail-space and motion-surface passed |
| Chromium settings scroll, repeated three times | 12 passed |
| Chromium console-clean after fixture alignment | 5 passed |
| `npx --yes pnpm --filter @nekowite/desktop e2e` | 293 passed |
| `git diff --check` | Passed |

The scoped fixes and verification are complete. No AppImage/deb/rpm install or paid-model end-to-end
validation was performed. Environment-gated external-engine Rust tests can return
early; their passing status is not evidence of live provider integration. No
dependencies, lockfiles, Windows sources or pre-existing specifications were changed.
Generated Tauri ACL schemas reflect the two new main-only consume commands.

## Follow-up Pass

The user requested another comprehensive repair pass. Preserve the existing diff.

- [x] Main: reproduce and fix failed/pending/stopped channel subscriptions in
  `src/platform/gateways/tauri-agent/channel.ts`, with a new
  `channel-lifecycle.test.ts` beside it. Acceptance: failed registration can retry,
  shutdown prevents stale snapshot delivery, stale cleanup cannot release a new
  listener. Risk: shared listener reference ownership. Verify focused agent tests.
- [x] File-sync subagent: reproduce and fix overlapping watcher result order in
  `src/services/external-doc-sync.ts` and `external-doc-sync-races.test.ts` only.
  Acceptance: a newer observation supersedes old success/missing responses without
  invalidating other documents. Risk: folder/resync fanout ordering. Verify both
  external-doc-sync test suites; primary reviews and reruns them independently.
- [x] Main: inspect Linux packaging scripts for additional reproducible defects;
  do not install packages or overwrite release artifacts during diagnosis.
- [x] Main: reproduce overlapping reloads in `src/stores/tab-file-operations.test.ts`
  before changing `src/stores/tab-file-operations.ts`. Acceptance: newer reads win
  even when their bytes match existing content, in both automatic and explicit
  reloads. Risk: discarding obsolete reads; per-tab ownership isolates documents.
  Both regression cases failed before the fix and passed afterwards.
- [x] Main: rerun typecheck, lint, full tests and build after integration. Record
  new results separately from the preceding verification, including limitations.

### Follow-up Verification

- Targeted channel, watcher-race and reload tests: 43 passed, exit 0.
- `npx --yes pnpm typecheck`: exit 0.
- `npx --yes pnpm lint`: exit 0; 462 existing warnings, no errors.
- `npx --yes pnpm test`: exit 0; 5835 passed (959 editor-core, 132 plugin-host,
  4744 desktop), including 10 additional regression cases since the first pass.
- `npx --yes pnpm build`: exit 0; large-bundle warnings remain.
- Linux packaging script syntax checks: exit 0. No release artifacts were
  overwritten or installed. Syntax checks do not establish artifact completeness,
  version freshness or recoverability of release staging.
- Changed business modules in this follow-up: channel 272 lines, external sync
  287 lines, tab file operations 254 lines.
- Chromium full run: 292 passed, 1 failed, exit 1. The model-popup geometry test
  sampled a 3.627px gap during animation after its fixed 400ms wait, against the
  expected 4px. `e2e/popup-host-scope.spec.ts` now retries the unchanged geometry
  assertions for up to 5 seconds; no resize injection or relaxed tolerance.
  The failed case then passed three repetitions, exit 0. The entire Chromium
  suite was not rerun after this test-only adjustment.

This pass changes TypeScript only. Rust and native WebKitGTK results above belong
to the preceding pass, not a new native execution. Live provider integration and
AppImage/deb/rpm installation remain unverified.
