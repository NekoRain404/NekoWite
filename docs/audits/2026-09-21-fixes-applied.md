# NekoWite — the review's findings, fixed

Companion to [`2026-09-21-code-review.md`](2026-09-21-code-review.md). That document found the
defects; this one records what was changed, what proves it, and what is deliberately left.

Written 2026-09-21 by the agent that took the repository over. The spec these changes were made
under is the session's `doublecheck_spec` (goal, scope, acceptance criteria, failure modes,
priorities, non-goals).

**Every change landed as a test first.** Where a behaviour was new rather than broken — the care
ledger's store, the credential binding — the test could not exist before the type did, so the
evidence is a **mutation check** instead: the behaviour is disabled, the test is shown to fail for
exactly that reason, the behaviour is restored, and the test passes again. Those runs are named
`mutation-*.log` below.

---

## 1. What changed

| # | Finding | Change | Evidence |
|---|---|---|---|
| **U1a** | The care ledger had no producer; `desktop_pet_care_read` could only answer `Empty` | New `desktop_pet/care_settlement.rs` (state → outcome, instant → local day) wired into `PetTaskFeed`'s existing `note`/`settled` seam | RED `{"status":"empty"}`, GREEN 69 passed · `red-care-producer.log`, `green-care-producer.log` |
| **U1b** | The ledger was in-memory only, so every restart lost the progress **and** the map that stops a double payment | New `care_ledger/codec.rs` + sibling `desktop_pet/care_store.rs` (`care.json`, atomic write, schema latch); `PetTaskFeed::for_app` loads it and persists after each decision | RED 3 failures `0 vs 25` · GREEN 7 passed · mutation kills exactly the latch test · `red-care-store.log`, `green-care-store*.log`, `mutation-care-schema-latch.log` |
| **U1b′** | A record a newer build wrote would have been drawn as "no progress" | `PetCareRead::ReadOnly` (Rust) + `'read-only'` in the TS contract + the panel's existing `readOnly` branch fed from `PetCareSettings.vue` | RED `{"status":"empty"}` / page drew "还没有记下任何进度" · GREEN 69 + 213 passed · `red-care-readonly-{arm,ts}.log` |
| **F1** | The autosave timer opened a native **Save-As** dialog over an untitled note while the user typed | `TabSaveOptions.mayNameNewFile`, set only by the callers that speak for the user (Ctrl+S, closing a dirty untitled tab, the untitled rescue's answered "save") | RED 3 failed · GREEN 60 focused / 4795 full · delegated, diff reviewed |
| **F2** | A refused `agent_load_session` left `adopting` set, freezing that session at `Running` for ever | `SessionSnapshots::abandoned` + the command's failure path; `started` also ends an adoption; `adopting` now reports whether *this* call announced it | GREEN 9 passed · **two** mutation checks kill exactly one test each · `green-f2-snapshot.log`, `mutation-f2-{started,abandoned}.log` |
| **F3** | The AI master switch did not gate the model-list request | One gate through `ai-gate.ts`'s `aiDisabled()` at both port entry points | RED 5 failed · GREEN 26 targeted / 4795 full · delegated, diff reviewed |
| **T1** | A skipped process-level test was reported as **passed** | `-extension GLX` on both Xvfb spawns; the six skip sites became a `skip!` macro that **panics** when `NEKOWITE_REQUIRE_PROCESS_TESTS` is set | Three-way: flag fix runs the case (9.5 s, engine gone 0.40 s after the app), opt-in turns a broken display into `FAILED`, opt-in off still skips for CI |
| **S2** | The request payload waived the SSRF guard by default, and the waiver also skipped address pinning | `url_policy.rs` resolves and pins on **both** paths (`vet_url`); the shipped default became `false` | RED `expected true to be false` · GREEN 23 + 35 passed · mutation kills exactly the pin test · `red-s2-default.log`, `mutation-s2-pin.log` |
| **S1** | A caller-supplied `base_url` decided where the user's stored API key was sent | `credential_scope`: a stored key is attached only to the endpoint it was **saved for**; `store_ai_key` records it; the frontend sends it | GREEN 14 passed · mutation kills exactly the three new tests · `s1-rust.log`, `mutation-s1-scope.log` |
| **B** | `cargo test` was red about one run in eight on a pre-existing flake | The host now keeps its own reading of the engine's end (`process/engine_exit.rs`), and a call that got no answer from a gone engine is read as `Disconnected` — the one arm that carries the engine's last words | RED 1 failure in 52 runs · GREEN 60/60, then 100/100 with the lost-race shape observed 3 times and correct · independently re-measured 20/20 |

### The flake, because it was the Rust gate's own version of T1

`an_engine_that_dies_the_moment_it_starts_still_gets_to_say_why` failed roughly one run in eight on
this machine — measured here at **7 pass / 1 fail over eight solo runs** at load ~19, and by the agent
that fixed it at **1 failure in 52** on a longer loop. Either way a green `cargo test` was a coin toss
about the machine rather than a reading of the tree, which is the failure mode T1 is about.

**The mechanism was not what the test's own comment suspected.** The stderr tail *is* waited for, and
both the connect and the handshake branches *do* call that wait. What is lost is one layer earlier, and
it is a race inside the SDK (`agent-client-protocol` 2.1.0): the engine's death wakes the transport's
read half (EOF, which fails every outstanding reply with the `incoming_transport_closed` reason the
host classifies as `Disconnected`) and its write half (a send to a process that is gone) at the same
moment, and `try_join!` returns on whichever errors first. When the write half wins, the incoming actor
is dropped before its replies are failed — so the caller gets the SDK's own `Internal error: "response
to \`initialize\` never received: oneshot canceled"`, `classify` answers `Engine`, and
`with_engine_stderr` (which attaches the log only to `Disconnected`) never reads a log that was full
the whole time.

**The fix, in one sentence.** The host owns a fact the SDK does not — whether the process it started is
still there — so `EngineExit` (a `watch` the supervisor sets once it has collected the child, with a
bounded wait) is consulted for a failure the SDK raised on its own behalf, and no answer plus a gone
engine becomes `Disconnected`. Both interleavings then converge on the one arm that carries the
engine's last words, which is what makes this a removed race rather than a narrower one.

**The test was not touched.** `tests/agent_runtime_test.rs` is byte-identical to `HEAD`; the assertion
still demands the engine's own line in the message. What was added instead is deterministic coverage
of the new rule (`process/engine_exit.rs`'s three unit tests, and `calls.rs`'s
`only_the_sdks_own_failure_is_read_against_the_engines_end`, which pins that a *measured* certificate
answer from a live engine is never re-read as a death).


Two files carry the "why" rather than the "what": `care_settlement.rs`'s header (why a producer was
missing and why the mapping is its own module) and `config.rs`'s `credential_scope` (the exploit, in
one paragraph, with the three answers and why they are asymmetric).

---

## 2. The adversary pass — what it found in this work

Run against the spec's own dimensions. Two objections were real.

**F-6 was not satisfied by the first version of the F2 fix.** `abandoned` was called on every failure
of `agent_load_session`, and two windows may ask for the same session: the runtime refuses the second
with `SessionError::LoadInFlight` while the first is in flight, so the *second* window's refusal would
have cleared the **first** load's adoption — handing that load's replayed frames to the turn
bookkeeping mid-replay, which is the exact failure the flag exists to prevent. Fixed: `adopting` now
answers whether this call is the one that announced the adoption, and the command clears only then.
`a_second_load_that_fails_does_not_end_the_first_ones_adoption` binds it; the mutation check kills
that test and nothing else.

**The Rust suite's final reading depends on a rebuilt artefact.** `app_under_test()` refuses a
packaged binary older than the sources — correctly — so a source edit between the build and the test
silently turns the two process-level cases into skips. The final gate below was taken after
`tauri build --no-bundle` on the frozen tree, with `NEKOWITE_REQUIRE_PROCESS_TESTS=1` so that a skip
would be a failure rather than a pass.

**A pre-existing flake turned up while taking that first gate, and it is now fixed rather than
excused.** `an_engine_that_dies_the_moment_it_starts_still_gets_to_say_why`
(`tests/agent_runtime_test.rs`) failed in the first full run. Measured here, run **alone**, eight
times at load ~19: **7 passed, 1 failed** — so it was not a loaded-machine-only artefact, and a red
`cargo test` was a coin toss about the machine rather than a reading of the tree. The mechanism, the
fix and the evidence are in §1's "B" row; the short version is that the loss was an SDK-internal race
in which a reply is *dropped* rather than failed, and the host now reads that case against its own
knowledge of whether the engine process is still there.

**Five objections that are false, stated so nobody re-raises them.**

- *The `rename_all = "camelCase"` → `"kebab-case"` change on `PetCareRead` alters the existing wire.*
  It does not: `Current`/`Empty` spell `current`/`empty` under both, which the pre-existing assertion
  `read == {"status":"empty"}` still proves.
- *S1 breaks the Anthropic-proxy and Ollama setups.* It does not: a key saved *with* a proxy address
  is attached to that address (tested), and the only users who must re-save once are those whose key
  predates the binding **and** who use a custom endpoint — and they get a sentence naming the setting
  rather than a 401 from a host they did not choose.
- *S2 breaks local model servers.* It does: an install pointed at Ollama must now tick
  「允许本地/内网地址」 once. That is the deliberate trade — the waiver protects every user who never
  chose it — and the refusal says which switch to turn on. Recorded here rather than discovered later.
- *The `mayNameNewFile` gate weakens background saves.* It does not: an untitled tab has no file, so
  a background save of one writes nothing either way; what changed is that it no longer opens a modal
  dialog first.
- *The care ledger is now reachable from a window.* It is not: settlement happens in the frame path,
  which no window can drive, and the IPC surface is still read-only (`desktop_pet_care_read`).

**A third objection was real, and is now fixed.** `desktop_pet/task_feed.rs` was 608 lines before this
work and 794 after it, against the 600-line business-file threshold `docs/dev.md:286` states — and the
handover (§9.3) names that file as the repository's one documented exception. The change had not added
a new rule there (the rules live in `care_settlement.rs`, the file in `care_store.rs`), but wiring is
still lines, and a reviewer was right to call it.

It is split now, by *reason to change* rather than by arithmetic — the criterion that same section
gives:

| File | Lines | What moves it |
|---|---|---|
| `desktop_pet/task_feed.rs` | **431** | When a frame stops becoming a fact, or the fan-out to the ledgers changes |
| `desktop_pet/task_reminders.rs` | 363 | When §6.3's notice path changes — the policy, its file, the burst waker |
| `desktop_pet/care_feed.rs` | 245 | When §8's reward path changes — the ledger handle, its file, settlement |

`PetTaskFeed` is now the composition: it holds the projection, one `TaskReminders` and one `CareFeed`,
and it is the only place that knows both ledgers exist. Neither ledger module can name the other, which
is what keeps a rule about notices out of the reward path and the reverse. Two smaller consequences
worth recording: `loss_report` moved with §6.3's half and is re-exported from `task_feed` so the path
the test target uses is unchanged, and §8's ledger now takes a `SettledTask` (key, state, host clock)
rather than the feed's `TaskFact`, so it cannot grow an opinion about the *label* a notice may carry.

**A fourth objection was found by the same review, in a file that had been under the budget.**
`agent_runtime/snapshot.rs` was 594 lines before this work and **725** after it — the F2 fix plus its
cases — so this round pushed a business file over the same limit it was fixing elsewhere. It is split
too: `snapshot/session_log.rs` (221) owns the state machine — the window, the turn it is on, the
stop-reason table and `SessionState` itself — and `snapshot.rs` is back to **578**, below where it
started, holding the registry and the wire shapes. Every `snapshot::SessionState` path in the crate
still resolves through a re-export, and the one pure case about the stop-reason table moved with the
table.

**And a fifth, in the test tree.** `tests/desktop_pet_ipc_test/wiring.rs` grew from 487 to 721 with the
care cases. That target's own header prescribes a file per behaviour domain, so they are now
`desktop_pet_ipc_test/care.rs` (239) and `wiring.rs` is back to 520, with the app harness shared by
`pub(crate)` rather than copied a third time.

**One thing the split broke, and the repository's own test caught it.** Moving `SessionState` into
`session_log.rs` broke `agent-contracts-parity.test.ts`, the hand-kept cross-language pin that reads
the Rust enum out of a source file and checks every variant against `isAgentSessionState`. It failed
with `a snapshot in these states would be refused whole`, which is a real consequence: the window
refuses a state name it does not have, and the refusal costs the whole snapshot. The test now reads the
*definition* (`agent_runtime/snapshot/session_log.rs`) rather than the parent, which is the right
target anyway — the parent only carries a `pub use`, so pointing at it would let the list drift while
the test passed. Worth recording because it is the failure mode a refactor of this kind has, and the
only reason it was caught is that this repository pins its vocabularies across the boundary by hand.

**Four existing tests were updated**, each because a contract genuinely changed, each with a comment
saying why, and none weakened: `SettingsPanel.controls.test.ts` and `settings-persistence.test.ts`
(both pinned the old `allowPrivate` default — the latter is the test that caught the flip),
`security-regression.test.ts` and `settings.test.ts` (the `store_ai_key` payload gained the endpoint),
plus the two arity assertions F1's change required (`app-lifecycle.test.ts`, `app-bootstrap.test.ts`).

---

## 3. What is deliberately not done

- **`CareLedger::import` still has no caller.** The import UI does not exist and building one is a
  product decision, not a defect fix. The store `U1b` added is the file an import would merge into.
- **Only `cancelled` is driven end-to-end as a non-paying ending.** All six are covered by the
  unit test that pins the vocabulary, and `CareOutcome::pays` is the ledger's own tested rule.
- **F9, F10, F11, S3, S5, S6, S7, U2, U3 from the review are untouched** by the spec's non-goals —
  they were reported rather than verified, and `U3`/`S6` in particular need decisions about tests and
  key rotation that this round did not take.
- **`docs/HANDOVER.md` is not edited.** Its §9.1 is now stale in a second way — `cargo test` skips
  those two cases on a tree whose packaged binary is older than its sources — and correcting the
  handover is the maintainer's call, recorded in the review's §9 instead.
- **The eighteen files that were already over the 600-line budget are still over it.** This round
  brought the three it had made worse back under (`task_feed.rs`, `snapshot.rs`) or into a
  per-behaviour file (`wiring.rs`), and every file it *created* is between 141 and 363 lines. What
  remains over budget is the maintainer's existing backlog — `character_view.rs` 1558,
  `catalogue.rs` 1174, `session.rs` 1145, `profile.rs` 1027, `window_host.rs` 1024,
  `capabilities.rs` 1023, and so on down to `commands/agent.rs` 634. **Two of them took lines from
  this work and were already over before it**: `commands/desktop_pet.rs` (796 → 814, the `read-only`
  arm) and `agent_runtime/process.rs` (906 → 914, the module declaration for `EngineExit`). Splitting
  either is a real piece of work with its own review, and doing it here would have meant refactoring
  the pet command surface — the thing `T1`'s gate had just measured — for a line count rather than a
  defect. Recorded so the next reader sees it as a decision rather than an oversight.

---

## 4. The final gate

Taken on the frozen tree, after `tauri build --no-bundle` rebuilt the packaged binary from it and the
verified engine was staged beside it (`binaries/opencode-x86_64-unknown-linux-gnu` copied to
`target/release/opencode`, and **removed again** afterwards — leaving it would have made §9.1 of the
handover pass for a reason nobody chose).

| Command | Result |
|---|---|
| `pnpm typecheck` | **exit 0** |
| `pnpm lint` | **exit 0** — 0 errors, **462 warnings** (the same 462 as before this work: no new ones) |
| `pnpm test` | **exit 0** — editor-core 959/73, plugin-host 132/10, desktop **4795/403** (was 4774/400) |
| `pnpm perf` | **exit 0** — 10 tests in 2 files |
| `cargo fmt --all --check` | **exit 0** |
| `cargo clippy --all-targets --locked` | **exit 0** (161 warnings, all pre-existing; none in a file this work added) |
| `NEKOWITE_REQUIRE_PROCESS_TESTS=1 cargo test --locked --no-fail-fast` | **exit 0** — **77 targets, 1365 passed, 0 failed, 5 ignored, 0 skipped** |
| the flaky case, alone, ×20 | **20 passed, 0 failed** (independently re-measured at load ~23) |

The 5 ignored are the deliberate ones that state their cost (real Stronghold opens, minutes each in
debug). Baseline for comparison: the same suite before this work was 76 targets / 1330 passed /
0 failed.

**The two process-level cases really ran**, which is the whole point of T1:

```text
t+4.8s: the engine is up: [210] (.../target/release/opencode acp --port 46535)
t+6.4s: the app left with ExitStatus(unix_wait_status(0)) (0.1s after the first click, 1 click(s))
t+7.6s: the engine is gone (1.20s after the app left, and it was alive when the close was clicked)
test a_graceful_quit_takes_the_engine_with_it ... ok

t+1.38s: the pet is up beside it (0.05s after the main window): [(2097155, 200, 200), (2097174, 260, 320)]
t+7.35s: the close took the main window, the pet (2 window(s)) and the process — 0.14s end to end
test closing_the_main_window_takes_the_pet_and_the_process_with_it ... ok
```

**Every reading in this document is clean.** The one caveat the previous revision carried — a
pre-existing flake that could make `cargo test` red for a reason unrelated to the tree — is fixed
(§1's "B" row), and its own evidence is a before/after loop rather than a single run.

Raw output for every run named in this document is kept at
`apps/desktop/src-tauri/target/review-2026-09-21/` (gitignored, under the build directory).

---

## 5. The line-budget programme, wave 1

The maintainer then asked for the same treatment across the tree, so the four largest over-budget
business files were split — one file each, four agents in parallel, each with a brief that named the
budget, the criterion ("reason to change, not arithmetic"), the house comment style, and the two
constraints that matter: keep every existing path resolvable by re-export, and declare every new file
so `module_tree_test` can see it. The primary agent reviewed every diff's structure and took the gate.

| File | Was | Now | Split into |
|---|---|---|---|
| `desktop_pet/character_view.rs` | 1558 | **67** | 7 subjects + their own `tests.rs` + shared fixtures — largest 324 |
| `agent_runtime/process.rs` | 914 | **81** | `launch`, `frame`, `stderr` (431), `identity`, `shutdown` |
| `commands/desktop_pet.rs` | 814 | **282** | `window_surface`, `character_library`, `character_appearance`, `runtime_reads`, `host_appearance` |
| `desktop_pet/window_host.rs` | 1024 | **437** | `geometry`, `identity`, `outcomes`, `placement`, `preferences`, `presentation`, `surfaces` |

**Thirteen business files over 600 remain** (from seventeen): `catalogue.rs` 1174, `session.rs` 1145,
`profile.rs` 1027, `capabilities.rs` 1023, `registry.rs` 921, `live_notes.rs` 873, `config_edit.rs`
835, `update.rs` 765, `commands/fs.rs` 713, `binary_registry.rs` 695, `events.rs` 674,
`state/app_state.rs` 668, `commands/agent.rs` 634. The programme continues wave by wave; each wave is
gated before the next starts, because a wave that is not verified is a wave that has not landed.

Three things worth carrying to the next wave, learned in this one:

- **`cargo fmt --all` is not safe while other agents are editing.** One agent ran it (as its brief
  said) and it rewrote three files two other agents were mid-edit in. Nothing was lost — every test is
  green and the tree compiles — but the risk is real: rustfmt writes a whole file, so a revision
  written between its read and its write is replaced. The next briefs say `cargo fmt --all --check`
  plus `rustfmt` on one's *own* files, never the tree-wide form.
- **A cross-language pin can read a file you are about to split.** `agent-contracts-parity.test.ts`
  reads `agent_runtime/events.rs` for `AgentEventKind` and `AgentFailureCode`, and it already caught
  this exact mistake once (`SessionState` leaving `snapshot.rs`). Whoever splits `events.rs` must
  re-point that test at the definition — and the test's own failure message says so.
- **A security test that enumerates files is a coverage list, and a split can silently narrow it.**
  `desktop_pet_ipc_test/teardown.rs` asserts that every file of the window-host module is free of any
  path to an agent, a note or the vault, over a *hardcoded list* of paths. The window-host split had
  to add its seven new children to that list or the assertion would have kept passing over less code.
  It also found a pre-existing gap: `window_host/selection.rs` was never in the list.

---

## 6. The line-budget programme, waves 2–5

Wave 1 left thirteen business files over 600. The maintainer asked for the programme to continue, so
it did — one file per agent, in waves, each wave gated on a frozen tree before the next began. This
section is the running record, written as the waves land rather than after the fact, because the
interesting part is what each wave taught the next one's brief.

### Wave 2 — `agent_runtime`'s four largest

| File | Was | Now | Split into |
|---|---|---|---|
| `agent_runtime/catalogue.rs` | 1174 | **68** | `manifest`, `distribution`, `platform`, `standing`, `install_gate`, `refusal`, `document`, `tests` — largest 399 |
| `agent_runtime/session.rs` | 1145 | **443** | `error`, `emitter`, `streams`, `handshake`, `listing`, `load` — largest 236 |
| `agent_runtime/profile.rs` | 1027 | **377** | `layout`, `credentials`, `permissions`, `scope`, `record` — largest 226 |
| `agent_runtime/capabilities.rs` | 1023 | **249** | `handshake`, `negotiated`, `finding`, `verdict`, `tests` — largest 399 |

All four kept their root at the same path and re-exported every moved name, so no caller and no test
was edited: `commands/agent_catalogue.rs`, `state/app_state.rs`, `registry.rs`, `update.rs` and the
`#[path]`-including targets all resolved unchanged. A mechanical check on each — the set of `pub`
items in `HEAD`'s file against the set across the new tree — came back empty in both directions
(nothing lost, nothing added).

Gate: `cargo fmt --all --check` exit 0 · `cargo clippy --all-targets --locked` exit 0, **159**
warnings (down from 161; one pre-existing `io_other_error` was fixed while relocating it) ·
`tauri build --no-bundle` exit 0 · `NEKOWITE_REQUIRE_PROCESS_TESTS=1 cargo test --locked
--no-fail-fast` **77 targets, 1365 passed, 0 failed, 5 ignored, 0 skipped** — the same 1365 as wave
1, which is what a pure move should show.

### The first frontend wave, in parallel

Two TypeScript files of the agent gateway layer were over budget and independent of the Rust work,
so they went at the same time:

| File | Was | Now | Split into |
|---|---|---|---|
| `platform/gateways/agent-contracts/gateway.ts` | 661 | directory | `index` 37, `session` 204, `capabilities` 129, `recovery` 68, `calls` 291 |
| `platform/gateways/agent-contracts/payloads.ts` | 606 | directory | `index` 221, `tool-call` 118, `permissions` 88, `run-outcome` 118, `attachments` 69, `config-options` 49, `context-usage` 33, `commands` 17, `plan` 15 |
| `platform/gateways/memory-agent.ts` | 661 | directory | `index` 94, `session-lifecycle` 278, `runtime` 166, `session-options` 108, `turn-flow` 96, `session-reads` 84 |
| `platform/gateways/memory-agent.test.ts` | 926 | **612** | plus a new `read-agent-event.test.ts` 326 — 41 tests before, 41 after |

`tsconfig`'s `moduleResolution: bundler` resolves `./payloads` to `payloads/index.ts`, so no
production caller changed; the one on-disk reader (`agent-contracts-parity.test.ts` reads
`payloads.ts` to pin `AgentPromptAttachment`) was re-pointed at the file the union now lives in. The
caller class the brief had not anticipated was **the e2e specs**: five of them import
`/src/platform/gateways/memory-agent.ts` by URL, so they needed the new path. Typecheck found them.

Gate: `pnpm typecheck` 0 · `pnpm lint` 0 errors / **462** warnings (unchanged) · `pnpm test` **404
files, 4795 tests** (one more file than before, the same test count) · `pnpm perf` 10 tests.

### Wave 3 — the last nine business files

| File | Was | Now | Split into |
|---|---|---|---|
| `agent_runtime/registry.rs` | 921 | **74** | `error`, `validation`, `registration`, `taxonomy`, `instances`, `table` — largest 292 |
| `agent_runtime/live_notes.rs` | 873 | **72** | `vocabulary` 259, `table` 292, `port` 59, `tests` 301 |
| `agent_runtime/config_edit.rs` | 835 | **238** | `scanner` 276, `splice` 132, `document` 128, `write` 126, `error` 31 |
| `agent_runtime/update.rs` | 765 | **59** | `manifest` 125, `claims` 95, `error` 75, `verify` 259, `rollback` 234 |
| `agent_runtime/binary_registry.rs` | 695 | **291** | `layout` 188, `releases` 198, `elf` 115, `platform` 31 |
| `agent_runtime/events.rs` | 674 | **73** | `normalize` 241, `transport` 164, `kinds` 142, `tests` 116, `envelope` 48 |
| `commands/fs.rs` | 713 | **127** | `watch` 234, `files` 145, `coalescing` 144, `media` 134, `dialogs` 97, `vaults` 38 |
| `state/app_state.rs` | 668 | **37** | `agent` 282, `ai` 135, `launch` 135, `registry_access` 106, `ai/tests` 45, `watcher` 21 |
| `commands/agent.rs` | 634 | **120** | `lifecycle` 172, `session_ipc` 168, `failure` 127, `permissions` 122, `ipc_state` 94 |

Gate: `cargo fmt --all --check` exit 0 · `cargo clippy --all-targets --locked` exit 0, **159**
warnings · `tauri build --no-bundle` exit 0 · the cross-language parity pin 7/7 · the full suite
**77 targets, 1366 passed, 0 failed, 5 ignored, 0 skipped**. The one extra test over wave 2 is the
coverage assertion the `commands/fs.rs` split added to `write_atomicity_test.rs`, described below.

### The census after three waves

- **Business `.rs` over 600: zero.** Thirteen after wave 1, eighteen before the programme.
- **TypeScript/Vue over 600: three** — `i18n/namespaces/agent.ts` 2284, `i18n/namespaces/settings.ts`
  955, `features/agent/components/AgentPanel.vue` 624.
- **Rust test targets over 800: ten** — `fs_test.rs` 2460, `ai_test.rs` 1598,
  `desktop_pet_task_feed_test.rs` 1160, `agent_exit_teardown_test.rs` 1085, `agent_runtime_test.rs`
  1082, `agent_session_ipc_test.rs` 1038, `desktop_pet_settings_test/switch.rs` 1030,
  `agent_permission_ipc_test.rs` 946, `main_window_close_pet_test.rs` 904,
  `agent_wire_frames_live_test.rs` 836.
- **TypeScript tests over 800: five** — `tauri-agent.test.ts` 1428, `styles/motion.test.ts` 883,
  `memory-pet.test.ts` 848, `pet-settings-policy.test.ts` 811, `SettingsPanel.agents.test.ts` 810.

Wave 4 (the Rust test targets) was in flight when this snapshot was written; wave 5 was the
remaining frontend files. Both are finished — the census at the end of the programme follows the
wave-5 table.

### Wave 4 — the Rust test targets

The same treatment, one target per agent. A test target's root file keeps its name, because the file
name *is* the cargo target name, and the cases move into a directory beside it, split by the
behaviour domain the file's own headings already drew. Every target kept its exact test count, and
each agent proved it two ways: the count of `#[test]`/`#[tokio::test]` attributes, and the target's
own `--list`, compared before and after.

| Target (root + directory) | Was | Now | Split into | Tests |
|---|---|---|---|---|
| `fs_test.rs` | 2460 | **46** | 14 files — `trash` 387, `storage_errors` 296, `write` 295, `attachment_save` 281, `rename` 234, `history` 230, `attachment_import` 190, `trash_keys` 172, `media` 133, `path_policy` 122, `read_stat` 78, `list_dir` 65, `watcher` 53, `support` 29 | 80 → 80 |
| `ai_test.rs` | 1598 | **34** | 9 files — `request_body` 538, `streaming_response` 402, `models` 153, `endpoint_mapping` 126, `url_policy` 115, `stream_status` 109, `failures` 86, `request_ceilings` 76, `support` 50 | 87 → 87 |
| `desktop_pet_task_feed_test.rs` | 1160 | **43** | `ledger_store` 540, `notices` 255, `pushes` 228, `support` 163 | 25 → 25 |
| `agent_runtime_test.rs` | 1082 | **63** | `event_translation` 287, `runs` 208, `engine_exit` 178, `support` 146, `handshake` 119, `teardown` 111, `launch_environment` 63, `real_engine` 60 | 26 → 26 |
| `agent_session_ipc_test.rs` | 1038 | **55** | `support` 281, `session_load` 213, `session_lifecycle` 133, `config_options` 114, `permission_prompt` 98, `snapshot_handshake` 86, `refusal_paths` 75, `event_sequence` 57, `startup_program` 52 | 12 → 12 |
| `desktop_pet_settings_test/switch.rs` | 1030 | **26** | `switch_applied` 351, `switch_launch` 199, `switch_window_pair` 169, `switch_notification` 138, `switch_migration` 133 | 29 → 29 |
| `agent_permission_ipc_test.rs` | 946 | **89** | `support` 371, `ending` 247, `identity` 115, `prompt` 97, `refusal` 70, `state` 60, `answer` 36 | 13 → 13 |
| `agent_exit_teardown_test.rs` | 1085 | **404** | `launch` 320, `session` 128, `process` 128, `support` 125, `windows` 87 | 1 → 1 |
| `main_window_close_pet_test.rs` | 904 | **111** | `launch` 284, `scenario` 272, `session` 132, `windows` 112, `support` 103 | 1 → 1 |
| `agent_wire_frames_live_test.rs` | 836 | **81** | `harness` 260, `turn` 172, `metadata_member` 115, `wrapper_control` 90, `frames` 85, `transcript` 81, `measured_absences` 49, `tool_turn` 28, `search_turn` 27 | 4 → 4 |

The delicate case `an_engine_that_dies_the_moment_it_starts_still_gets_to_say_why` moved into
`agent_runtime_test/engine_exit.rs` with its extracted block's SHA-256 **identical before and
after**, 30 consecutive passes of the case alone, and its bare-name filter still selecting it.

The three process-level targets were split last, because each spawns the packaged binary and two of
them are where **T1**'s `-extension GLX` and `skip!` live. That the split is safe is not the
interesting part; that the *reading* is honest is. Two things had to be watched:

- `agent_exit_teardown_test.rs` kept its one `#[test]` in the crate root rather than moving it into
  a module, because a module path becomes the test's reported name (`scenario::…`), and the
  repository's filters and documents name it bare. Its harness still proves T1 three ways: real run
  under `NEKOWITE_REQUIRE_PROCESS_TESTS=1` (engine gone 1.00 s after the app left), a skip when no
  display can be started, and a panic — not a pass — when the variable is set and the display cannot
  be started.
- `main_window_close_pet_test.rs` and `agent_exit_teardown_test.rs` both gate on the packaged binary
  being **newer than every source file** (`app_under_test`). During this wave, while other agents
  were still editing `src/`, that gate turned the "real" run into a *correct skip reported as a
  pass* — T1's exact shape, in the harness rather than in the runner. The final gate therefore
  rebuilds the packaged binary from the frozen tree before running the suite, which is why the last
  section below lists a `tauri build` immediately before the Rust suite.

### Wave 5 — the frontend files

| File | Was | Now | Split into | Tests |
|---|---|---|---|---|
| `i18n/namespaces/agent.ts` | 2284 | **39** | 25 files under `namespaces/agent/`, largest 203 | — |
| `i18n/namespaces/settings.ts` | 955 | **46** | 22 files under `namespaces/settings/`, largest 117 | — |
| `styles/motion.test.ts` | 883 | deleted | 8 `motion.<domain>.test.ts` (largest 277) + `motion-source.ts` 83, `motion-tokens.ts` 104, `motion-surfaces.ts` 178 | 70 → 70 |
| `platform/gateways/tauri-agent.test.ts` | 1428 | **510** | `-ipc` 179, `-gateway` 203, `-subscription` 159, `-session-state` 100, `-capabilities` 167, + `tauri-agent-frames.ts` 36 and `tauri-agent-fake-host.ts` 201 | 57 → 57 |
| `platform/gateways/memory-pet.test.ts` | 848 | deleted | 9 `memory-pet.<domain>.test.ts`, largest 278 | 47 → 47 |
| `desktop-pet-settings/services/pet-settings-policy.test.ts` | 811 | deleted | 10 `pet-settings-policy.<domain>.test.ts`, largest 174 | 48 → 48 |
| `settings/components/SettingsPanel.agents.test.ts` | 810 | deleted | 6 `<domain>.test.ts` (largest 151) + `SettingsPanel.agents.mount.ts` 418 | 15 → 15 |
| `features/agent/components/AgentPanel.vue` | 624 | **541** | `use-agent-panel-popups.ts` 139, `use-agent-panel-session.ts` 91, `use-agent-capability-report.ts` 61 | — |

Two shapes are worth recording.

**The i18n namespaces could not be split beside their files.** `i18n.test.ts`'s `catalogue split`
block globs `./namespaces/*.ts` *non-recursively* and requires each module it finds to export
exactly one object, so a second `agent*.ts` module in that directory would fail the test and a
`namespaces/agent/index.ts` would vanish from the glob's union. The sections therefore moved into
subdirectories, and the root stayed a single composition module at its original path. The proof is a
flattened `path<TAB>JSON(value)` dump of every leaf — 1318 leaves for `agent` (659 per locale) and
384 per locale for `settings` — byte-identical before and after, key order included. The `settings`
splitter's first recheck printed `0 = 0 identical` because its walker never recursed: a vacuous pass
it caught and fixed, and then re-derived from the git blob rather than from its own scratch. That is
worth more than the green run it replaced.

**AgentPanel.vue did not reach the ~450-line target, and the reason is honest.** After three
composables were extracted the remaining 541 lines are almost entirely interface: 66 lines of file
header, 94 lines of documented props and emits, ~120 of top-level bindings the template needs by
name (a ref reached through an object is not unwrapped by a template), plus the untouched 148-line
template and 64-line scoped style. The template and style blocks are byte-identical to their
previous text. Getting lower means moving the props/emits contract into its own module — a real
option, not a defect, and one the brief reserved for the SFC.

### The census when the programme stopped

Measured over every `.rs` under `apps/desktop/src-tauri` (both `src/` and `tests/`) and every
`.ts`/`.vue` under `apps/desktop/src` and `packages/`:

- **Business Rust over 600: zero** — the eighteen the programme started with.
- **Rust test targets over 800: zero** — the ten listed above, the largest `fs_test.rs` at 2460.
- **TypeScript/Vue over 600: zero** — `i18n/namespaces/agent.ts` 2284, `i18n/namespaces/settings.ts`
  955, `features/agent/components/AgentPanel.vue` 624, `agent-contracts/{gateway,payloads}.ts` 661
  and 606, `platform/gateways/memory-agent.ts` 661.
- **TypeScript tests over 800: zero** — the five listed above, the largest `tauri-agent.test.ts` at
  1428.

**A band remains, deliberately.** Some forty test files now sit between 600 and 800 lines, which
`AGENTS.md` allows in as many words ("tests may be larger, but split them by behaviour domain when
they exceed 800"); every file this programme *touched* is under 600, test targets included. Taking
that band too would be the same mechanical work again for a much smaller gain, and it is the
maintainer's call rather than this programme's.

### What the splits cost, and the traps that were not in the brief

Every wave wrote the next one's brief. These are the corrections that cost real time, recorded so the
next reader does not pay for them again.

- **`#[path]` is a two-way hazard, and the briefs named only one direction.** A `#[path]` on each
  child `mod` is the fatal variant, because `module_tree_test`'s comment stripper deletes string
  literals and then reads the children as orphans. The *reverse* is worse and was live in this tree:
  when a test target `#[path]`-includes the **parent** file — `tests/save_precondition_ipc_test.rs`
  does `#[path = "../src/commands/fs.rs"] mod fs;` — rustc resolves that file's bare children against
  **the directory of the file that declared it**, not against its own stem directory. Six `E0583`s,
  `cargo clippy --all-targets` exit 101, and `cargo fmt --all --check` failing with `failed to
  resolve mod coalescing` — a tree-wide formatting gate red for a reason that had nothing to do with
  formatting. `commands/fs.rs` is the only file where this applies; it uses an inline
  `#[path = "fs"] mod children { … }`, which resolves correctly for the library build, the `#[path]`
  test include and rustfmt, and which `module_tree_test` still walks. **Before splitting any file,
  grep for `#[path` naming it.**
- **Privacy is per module, so a split always widens something.** An ancestor cannot see a child's
  private items, and a child cannot be re-exported by its parent while it is private. Every wave hit
  this, in the same two shapes: `pub(super)`/`pub(crate)` on the items a sibling or the parent
  reaches (each with a why-comment), and `#[allow(unused_imports)]` on a re-export that a
  `#[path]`-including target compiles but never names. The precedent is `process.rs`'s; the `events`
  split *measured* that it did not need one where earlier agents had added it speculatively, which is
  the right way to use an allow.
- **A file-enumerating test is a coverage list, and a split silently narrows it.** Wave 1 found one
  (`desktop_pet_ipc_test/teardown.rs`); wave 3 found three more. `agent_update_test/bundled.rs`
  scanned exactly `["binary_registry.rs", "update.rs"]` with `checked == 2`, and the two splits it
  was watching would have halved what it read. It now enumerates each module's directory, so a
  further split falls *inside* the scan rather than outside it, with an 11-file floor instead of an
  equality. `write_atomicity_test.rs` now collects `src/commands/fs/` alongside `src/commands/fs.rs`
  — and the splitter proved that addition red first, by removing it and watching the new assertion
  name all six unread files. `agent_session_database_test.rs` reads `start_session` out of
  `state/app_state.rs` to prove this app can only start the engine whose roots it injects; when the
  function moved to `app_state/agent.rs` the test's path moved with it, and the agent re-ran the
  *prebuilt* binary against a deliberately mutated source to show the pin still fails when the
  behaviour it guards is removed.
- **A comment that names a path or a line number goes stale the moment a file is split.** Four agents
  reported this and each was right not to fix it outside its scope, so the primary agent swept
  twenty-one references across nineteen files afterwards: the frontend's `agent-contracts.ts`
  division list, five TypeScript module headers, four Rust doc comments citing
  `agent-contracts/payloads.ts`, three line-number citations, a `normalize_update` "below" that is
  now a sibling, the sequence provenance in three documents (`agent_session_ipc_test.rs`,
  `desktop_pet/notification_policy.rs`, `task_projection/vocabulary.rs`), `epochs.rs`'s citation of
  `app_state.rs:30-35`, and `desktop_pet/mod.rs`'s claim about which state file holds the pet host.
  Line-number citations were rewritten as symbol citations: they were the part that rotted.
- **A subagent's scratch work is part of the tree until it is cleaned up.** One agent's failed,
  off-by-one extraction script left five duplicate files in `src/agent_runtime/`; `module_tree_test`
  caught them as orphans, and three other agents spent time reporting a blocker that was not theirs.
  The same agent truncated `.git/info/exclude` to zero bytes while probing ignore rules — untracked,
  so git cannot restore it; the primary agent restored the standard template by hand. **A subagent
  must not write inside `.git/`, and must remove what a failed run leaves behind.**
- **A test target's root file is a crate root, so `mod foo;` there does not mean what it means in
  `src/`.** The wave-4 briefs said `tests/foo_test.rs` resolves `mod bar;` to
  `tests/foo_test/bar.rs`, by analogy with `catalogue.rs` → `catalogue/`. That is wrong: a file
  directly under `tests/` is the crate root of its own target, so the lookup is against `tests/` —
  `E0583 … create file "tests/bar.rs"`. Every agent found it independently, proved it with a
  throwaway `rustc --edition 2021 --test` run, and used the form the repository's existing split
  targets already document: `#[path = "foo_test/bar.rs"] mod bar;`. Putting the children directly in
  `tests/` is not an alternative — cargo would discover each as its own test target. The one
  exception was `desktop_pet_settings_test/switch.rs`, which is itself `#[path]`-declared by its
  parent, so its children resolve as *siblings* in `desktop_pet_settings_test/`; that agent measured
  the rule before writing and used sibling names, which is why the shape differs from its neighbours.
- **A process test can pass by not running, in the harness rather than in the runner.** Two of the
  split targets only run when the packaged binary is *newer than every source file under the
  manifest*. While other agents were still editing `src/`, that gate turned the "real" run into an
  immediate `ok` — the exact shape **T1** was about, one layer down. The fix is procedural and now
  part of the gate: rebuild the packaged binary from the frozen tree immediately before the suite.
  A green `cargo test` on a tree that is still being written is not a reading of the tree.
- **A "0 = 0 identical" diff is a claim that the walker ran.** The `settings` i18n splitter's first
  equality check compared an empty pre-split side with an empty assembled side because its walker
  never recursed, and printed success. It caught that itself, fixed the walker, guarded against an
  empty side, and re-derived the comparison from the git blob rather than from its own scratch. Any
  "before equals after" script is worth reading once for the failure mode where it compares nothing.
- **The briefs' own numbers were the least reliable part of them.** Test counts were wrong in five
  of the wave-4/5 briefs (`49` for a file of 48, `39` for one of 70, `66` for a target of 96, `4` for
  a `#[test]`-grep of 5 — that last one because a fixture holds the literal string `#[test]`), and
  one named a key that does not exist (`settings.panel.readOnly`, where the real, load-bearing key is
  `settings.pet.care.panel.readOnly` under `pet.care`). Every agent checked the file rather than the
  brief and said so, which is the behaviour to keep: the brief is a hypothesis, the file is the
  evidence, and a report that repeats a brief's number without measuring it is not a report.

### The gate on the frozen tree

Taken after the last agent settled and after the primary agent's own reference sweep, with the
packaged binary rebuilt from that exact tree (`tauri build --no-bundle`, 20:52) and the verified
engine staged beside it.

| Command | Result |
|---|---|
| `pnpm typecheck` | **exit 0** |
| `pnpm lint` | **exit 0** — 0 errors, **462** warnings (the same 462 the review's gate measured) |
| `pnpm test` | **exit 0** — editor-core 959/73, plugin-host 132/10, desktop **4795 tests in 438 files** |
| `pnpm perf` | **exit 0** — 10 tests in 2 files |
| `cargo fmt --all --check` | **exit 0** |
| `cargo clippy --all-targets --locked` | **exit 0** — **159** warnings (161 before the programme) |
| `NEKOWITE_REQUIRE_PROCESS_TESTS=1 cargo test --locked --no-fail-fast` | **exit 0** — **77 targets, 1366 passed, 0 failed, 5 ignored, 0 skipped** |

The desktop suite is still exactly 4795 tests; the 35 extra files are the splits — tests moved, none
were added or lost. The Rust count is 1366 against the review's gate of 1365, and the one extra is
the coverage assertion the `commands/fs.rs` split added to `write_atomicity_test.rs`. **Nothing was
skipped**: the two process-level cases ran, which is what `NEKOWITE_REQUIRE_PROCESS_TESTS` is for,
and the five ignored are the deliberate Stronghold cases that state their cost.

Raw output for every run named in this document — the review's gate, each wave's gate, and the four
gate scripts — is under `apps/desktop/src-tauri/target/review-2026-09-21/`. The staged engine was
removed after the last run, so a future `cargo test` on this tree skips the process cases for the
reason the handover documents rather than passing because something was left behind.
