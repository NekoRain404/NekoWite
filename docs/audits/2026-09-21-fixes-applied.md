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

### Fixes that came after the freeze — the review's own leftovers

The gate above was taken on the tree this work produced. The maintainer then asked for the
optimisation to continue and for every change to be committed, so the review's remaining verified
findings were worked through one at a time, each with its own commit and its own evidence. Nine are
fixed; the rest are accounted for in §3.

| # | Finding | Change | Evidence |
|---|---|---|---|
| **F7** | `AgentIpcState::install`/`clear` swallowed a poisoned lock while five readers refused loudly | Both writers go through one `locked()` accessor and answer the same sentence; `agent_start` takes the engine down again rather than leaving one nothing can address; `stop_running_engine` runs *every* step on a poisoned slot and answers the refusal at the end | `ipc_state/tests.rs` poisons the mutex the only way one can be poisoned (a caught panic with the guard held) and pins three properties · **mutation check**: the old soft `clear` kills exactly the writer case (1 failed / 2 passed) · 16 lib tests (13 before), IPC targets 13 / 12 / 99 |
| **F6** | `set_visible` returned at the first refusal, leaving the rest of the pet unasked and the flag unchanged | Ask every window, keep the first refusal, ask the ball, answer afterwards — the shape `set_always_on_top`/`set_character_size` already use; the flag moves only when all agreed, so the retry stays available | A case plants the refusal on the **first** window and asserts all three calls happened in order, the refusal names the hide, `is_visible()` stays `true`, and the same call succeeds once the compositor stops refusing · **mutation check**: the old early return records `[("pet-1", false)]` against the expected three · target 70 passed |
| **F8** | The palette's file-watch subscription had no rejection path (its sibling guarded the same call) | `Promise.resolve(...)` with both arms, the unlisten stored as a function, and a `disposed` guard so a late subscription is released rather than stored | `use-palette-entries.test.ts` mounts the composable through a real component · **mutation check**: the old unguarded body makes vitest report an `Unhandled Rejection` and go red · palette 20 passed, typecheck 0, lint 0 errors |
| **F5** | A comment in `lib.rs` claimed the pet is not on screen until a settings page asks, and the defaults do the opposite | The comment now states what happens, names the two defaults that decide it (`ball`, `characterWindow`), and leaves the product question to §9.6 | Verified against the code: the two `Kind::Bool(true)` defaults, `restore`'s `apply` call, and `apply`'s `open_selected`/`ensure_ball` |
| **S3** | Proxy credentials were copied into a sentence returned to the window | `proxy_line` formats the value through `without_userinfo`, which replaces the authority's userinfo with `***` and keeps scheme, host, port and path | A five-shape unit test · **mutation check**: the verbatim form prints `http://user:pass@proxy.internal:8080` and fails it |
| **S5** | `agent_credentials_write` accepted any environment-variable name, injected **last**, so a credential beat the isolation roots | `credentials::reserved_name` refuses the names that decide *what code runs* (`LD_*`, `DYLD_*`, `NODE_*`) or *where the engine reads* (`HOME`, `XDG_*`, `OPENCODE_*`, `PWD`, `TMPDIR`, `SHELL`, `ENV`, `IFS`, `PATH`), each with a reason the user is shown; and a credential can no longer outrank a root the host set | Two new cases (the effective environment for `HOME`/`XDG_CONFIG_HOME`/`OPENCODE_CONFIG_DIR`, and seven refused names with their reasons) · **two mutation checks**, one per half |
| **S7** | The credentials file's mode was reported as `600` and inherited from whatever the file already had | `config_edit` gained `write_replacing_private` — the same atomic write with `DOCUMENT_MODE` regardless of what was there — and the credentials document is its one caller; the engine's own configuration keeps the preserving behaviour | A case plants a `0644` file and asserts the write leaves `0600` and really wrote · **mutation check**: the preserving writer fails it with `the page says 600 and the file is 644` |
| **F4** | A pet window destroyed from outside (Alt+F4, a session manager, a compositor) left a label whose window was gone, wedging every later operation | `PetWindowHost::forget(label)` drops the instance and marks the ball's record closed; `lib.rs`'s `Destroyed` arm grew the `else` branch that calls it for a pet label | A case drives the wedge first (a call failing at the stale label), then the forget, then that every operation works again and the cap slot is free · **mutation check**: a `forget` that drops nothing fails it |
| **F10** | `hasActiveTab` meant "the note has text", so an open empty note could not be exported | The gate is `tab !== null && tab.loading !== true`: the flag that means "the first read has not landed" is what refuses, and an empty note is exportable as an empty document | The case that pinned the old behaviour now walks both states in order · `vitest run src/features/settings` 138 passed |

One correction is recorded rather than hidden: making `install` return a `Result` left three test
fixtures ignoring it — the same habit the finding was about — and the commit that fixed them says so
and corrects the earlier commit's "warning-neutral" claim. `cargo clippy --all-targets --locked` is
back to the same **100 unique warning lines** as the frozen-tree gate.

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
- **Every finding now has a status, and the ones still open are open on purpose.** The review found
  twenty-six defects; this is the whole accounting, so a reader can tell a decision from an omission:

  | Finding | Status |
  |---|---|
  | F1, F2, F3, F4, F5, F6, F7, F8, F10 | **fixed** — F1–F3 and the first table, F4–F10 in the section above it |
  | S1, S2, S3, S5, S7 | **fixed** — the credential binding, the single guarded URL path, the proxy's userinfo, the credential-name policy, and the credentials file's mode |
  | U1 (U1a, U1b, U1b′) | **fixed** — the care ledger's producer, its file and its read-only arm |
  | T1, B | **fixed** — a skipped process case is not a pass; the engine's own end is read |
  | F4 (a pet window destroyed from outside wedges the host) | **fixed** — see the table above; the half that needs the real window system is the `Destroyed` wiring, and the case pins the contract it calls |
  | F9 (a delegated write drops the no-history warning) | **fixed** — the port's sentence travels on the change it is about (`ChangeRecord::warning`), with the creation case pinning that a missing baseline is not a snapshot failure. What the record still lacks is a reader: the change list is T10's unbuilt surface, recorded in the bullets below |
  | F10 (`hasActiveTab` means "has text") | **fixed** — the gate is `loading` now, so an empty note is exportable and a placeholder is not |
  | F11 (a plugin toggle can report a state the app does not hold) | **fixed** — the toggle answers with what the app holds and what the file said; an enable that cannot be applied goes back to disabled in the record *and* in the file, and a write that did not land is confirmed by reading the file back (the writer is best-effort and cannot be trusted to throw) |
  | S3 (proxy credentials copied into a window payload) | **fixed** — the value's userinfo is `***` in the sentence the window reads |
  | S4 (`import_attachment` reads any image-named path) | **fixed** — the command spends a one-shot grant that only the image dialog can mint (`commands/fs/picked.rs`), so a renderer that names a path it did not pick is refused with a sentence saying how to pick one; four IPC cases drive the real command |
  | S5 (`agent_credentials_write` accepts any environment-variable name) | **fixed** — reserved names with reasons, and the isolation roots filtered against the credentials |
  | S6 (a crash mid password change is unrecoverable) | **open** — needs the recovery decision, and the ignored tests that state their cost are the place it lands |
  | S7 (the credentials file's mode is reported, not enforced) | **fixed** — the credentials document's writer sets `0600`; the engine's own document keeps the user's mode |
  | U2 (two more production-dead exports) | **fixed** — `imageMime` deleted and `featureFor` given the call site it was written for; `check-dead-exports.py` went from 91 of 1372 to 89 of 1371 with neither name in the list |
  | U3 (`main_window::raise`'s rebuild path has no test) | **closed as a false finding, with the gap it hid now covered** — the mock-level drive has existed since `29f58ae` added `main_window.rs` and `tests/main_window_test.rs` together: `a_missing_main_window_is_built_again` and `an_existing_main_window_is_raised_rather_than_replaced` drive both arms under `MockRuntime`, and the first reddens under the rebuild-arm mutant (measured, not read). Both the review and `docs/HANDOVER.md` §9.4 say "nothing drives it", inheriting the claim from a file that was deleted for a real reason but for a *narrower* one: what `e326a8b` killed was the **process-level** drive. What genuinely had no case is `raise`'s refusal when the config declares no window, and that case exists now (`main_window_test.rs:107`), as do seven corrected references to the deleted file |
  | T2 (§9.1a's unrun targets) | **closed by the programme** — every wave ran the whole suite with `NEKOWITE_REQUIRE_PROCESS_TESTS=1`, so no target is unread |
  | T3 (`pnpm test` does not run `pnpm perf`; lint cannot fail on a warning) | **half fixed, half stale** — the renderer's lint now carries a `--max-warnings 462` ceiling, and `pnpm verify` composes the CI sequence into one command; the finding's premise about perf was wrong, and `.github/workflows/ci.yml:22` is the file that disproves it (see §9) |
  | T4 (~50 `never used` warnings that are artefacts of `#[path]`-included targets) | **open** — separating them from real ones is a real improvement and a separate piece of work |
  | D1–D11 (§5's stale comments and counts) | **fixed** — every claim read against its subject, and the sweep found more than §5 named; see the note below |

  **§5 was missing from this table until the D-group was worked, and that was this ledger's omission,
  not the review's.** The review's own summary counts it (`| D1–D11 | Stale comments and counts,
  including the two that hid F3 | doc | low |`) and its §5 lists eleven rows. The twenty-six the table
  above accounted for are the code, security, gate and unreachable findings plus the flake; the true
  total is **thirty-seven**, and all of them are accounted for now.

  What the sweep found is more than §5 named: **ten false numbers across seven files**, not three.
  §5 named `build.rs` (eighty-two against a real eighty-four), `lib.rs` (eight pet commands against
  nine) and the pet count again; the tree also held `window_host/identity.rs`, `window_host.rs` (both
  "eight", and a "sixty-odd"), `command_surface_test.rs`'s own docblock (82 beside its assertion of
  84), `command_authorisation_test.rs`'s case, and `desktop_pet_surface.rs`'s "eight switches" over a
  seven-boolean domain. The rule the fixes used is the one worth keeping: **a number a test asserts is
  stated; a number nothing asserts is described instead of refreshed**, because a fresh count is the
  next thing to go stale.

  Three rows had also *moved*, because the line-budget programme split the files after the review was
  written: D9's paragraph lives in `commands/desktop_pet/window_surface.rs` now and D10's second half
  beside it, while D2, D4 and D5's line numbers point at pre-split text. The review is a record of the
  tree it read, so that staleness is recorded here rather than by rewriting the review.

  The rest of the group was two user-visible defects and three false claims about behaviour. The
  attachments panel told the reader that a pasted image is saved into the vault's `attachments` folder
  *and appears in the panel they were reading* — both halves false, since the file lands in
  `<note>_assets` beside its note and the panel lists `attachments/`, which holds the app's own
  insertions. One vault-switch failure was the only hard-coded English sentence in a localised
  function. `ai-gate` claimed to be "the only place the AI permission state is read" over eight
  production files and ten call sites. `acp_transport::connect` claimed to complete a handshake it
  never sends. `commands/desktop_pet.rs` claimed app commands are "not ACL-gated at all" beside
  `build.rs:172`, which declares the app manifest that gates them. And `ball.rs` claimed a capability
  file "narrows" a window when Tauri unions by label glob and the file's own description calls its
  grant a subset rather than a widening.

  The rows still marked **open** are open because each needs a decision this work is not entitled to
  take alone — a policy, a product answer, or a change to what the gate means. They are named as rows
  rather than counted here on purpose: the count is the part of this file that has already gone stale
  once.
- **A fourth unreachable surface, found while fixing F9 and not one of §4's three.**
  `SessionRuntime::changes` — the change list §7.2's attribution record exists for — is called only
  from tests. No command reads it, so the records a delegated agent write produces never reach a
  window, and the review surface that would show them is T10, which is unbuilt. F9 fixed what the
  record *carries* (the port's own sentence about a history snapshot that could not be kept, which the
  write arm used to drop at the destructuring); what reads it is a feature nobody has designed yet, so
  it is recorded here rather than invented. It is the handover's §6.7 class in its purest form: built,
  tested, documented as a promise, and unread.
- **Clippy is deliberately not ratcheted the way eslint now is.** `cargo clippy --all-targets` runs in
  CI without `-D warnings` and reports 100 unique warning lines, so it cannot fail — the same shape of
  hole T3 found in `pnpm lint`. It is left alone because clippy has no `--max-warnings`, and a count
  compared against a toolchain that moves would fail a contributor's build for something that is not
  their change. A count *reported* on every run is the honest middle, and T4's separation of the
  `#[path]` artefacts from real ones is what would make the number worth reading at all.
- **`docs/HANDOVER.md` is not edited.** Its §9.1 is now stale in a second way — `cargo test` skips
  those two cases on a tree whose packaged binary is older than its sources — and correcting the
  handover is the maintainer's call, recorded in the review's §9 instead.
- **The line-budget backlog this round left behind is gone.** It was eighteen business files over 600
  and ten test targets over 800; the programme in §6 split all of them, and the census at the end of
  that section is zero and zero. `commands/desktop_pet.rs` and `agent_runtime/process.rs` — the two
  that took lines from the review's own fixes — were split in the first wave.

---

## 4. The final gate

> This is the gate the review's own work ended on. The tree did not stop there: §6 records the
> line-budget programme's gates and the gate taken after the post-freeze fixes, whose readings are
> the current ones (77 targets, 1370 passed, 0 skipped).

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

### The gate after the post-freeze fixes, and what the first attempt taught

The four fixes in §1's second table changed the tree, so the gate was taken again. It is recorded
here because the **first attempt failed**, and the failure is the most useful thing in this section:

| Command | Result |
|---|---|
| `pnpm typecheck` · `pnpm lint` | exit 0 · exit 0 — 0 errors, 462 warnings |
| `pnpm test` | exit 0 — **439 files, 4797 tests** (`editor-core` 959/73, `plugin-host` 132/10, `perf` 10/2) |
| `cargo fmt --all --check` · `cargo clippy --all-targets --locked` | exit 0 · exit 0 — 159 warning lines |
| `tauri build --no-bundle` | exit 0 — the packaged binary rebuilt from this tree |
| `NEKOWITE_REQUIRE_PROCESS_TESTS=1 cargo test --locked --no-fail-fast` | exit 0 — **77 targets, 1370 passed, 0 failed, 5 ignored, 0 skipped** |

1370 is 1366 plus the four cases the F6/F7 fixes added. The first attempt at this gate **failed on
`a_graceful_quit_takes_the_engine_with_it`**, with the case's own diagnostic:

```text
t+2.1s: the main window is up (1280x820 at 160,90); 2 window(s) in all
t+4.7s: the vault is open and registered; the pet is off, so the main window is the last one
timed out waiting for the engine to start
no engine appeared after the rail was opened, so this case has nothing to watch. …
```

The cause was this document's own instruction: the engine had been **removed** after the previous
gate, so `target/release/opencode` was absent, the app refused the start, and the case — told by the
variable that this run means to exercise it — failed rather than passing. Everything about that is
the harness working: `T1`'s variable made an unrunnable case loud, and the deadline reported which
half of the start was missing instead of timing out anonymously. What was wrong was the *script*,
which assumed the staging step had been done by hand. It now stages the verified engine from
`binaries/` before the suite and removes it on the way out, including after a failure — so the gate
is reproducible by one command, which is the property the earlier gates only appeared to have.

### The gate after the second round of fixes, and one flake observed once

Five more findings were fixed after that (S3, S5, S7, F4, F10), so the gate was taken again on the
tree they produced:

| Command | Result |
|---|---|
| `pnpm typecheck` · `pnpm lint` · `pnpm perf` | exit 0 · exit 0 — 0 errors, 462 warnings · 10 tests in 2 files |
| `pnpm test` | exit 0 — **439 files, 4797 tests** (editor-core 959/73, plugin-host 132/10) |
| `cargo fmt --all --check` · `cargo clippy --all-targets --locked` | exit 0 · exit 0 — 159 warning lines, unchanged |
| `NEKOWITE_REQUIRE_PROCESS_TESTS=1 cargo test --locked --no-fail-fast` | **77 targets, 1375 passed, 0 failed, 5 ignored, 0 skipped** |
| `pnpm e2e` (the real-browser suite of §7) | **293 passed, exit 0** |

1375 is the 1370 of the previous gate plus the five cases this round added. The e2e suite was run
because two of the five fixes touch what a page can see (the export gate and the pet's window
handling), and it is the only check that would notice.

**One flake, recorded rather than smoothed over.** The first run of that Rust suite failed
`agent_two_instances_test`'s `two_engines_on_one_profile_share_the_database_and_the_session`:

```text
the second engine answered without ever naming the shared session
    engine B: frames 2, stderr: (none)
```

at a load average of ~20, with two engines really running. It was **not** a deterministic effect of
the code under test: the same tree ran that target alone three times (12.1 s, 8.6 s, 10.2 s, all
green) and then passed the whole suite unchanged. So it is a load-sensitive case in the same family
as the two e2e popups in §7 — a real engine on a loaded machine answering a `session/load` late —
and it is written here with its numbers so the next reader who sees it once does not start by
suspecting their own change. If it recurs, the case is the one to harden; one observation is not
enough to justify a deadline change.

---

## 7. The e2e suite, which none of the four gate commands runs

`AGENTS.md`'s four commands are `typecheck`, `lint`, `test` and `build`. The e2e suite — 293 cases
driving the real UI in a real browser — is a fifth thing, and it is not in any of them (`T3` in the
review says the same about `pnpm perf`). It was run for the first time in this session, at the
maintainer's instruction to use real control and debugging rather than only unit-level readings, and
it found things nothing else could.

**What it caught.** Eleven cases red, all from the line-budget programme:

```text
Error: const CHARACTER_WINDOW_SLACK: (f64, f64) = ( is not in window_host.rs
```

`e2e/support/petWindow.ts` reads the character window's rule out of the Rust source rather than
restating it, and the wave-1 split moved `CHARACTER_WINDOW_SLACK` and `CHARACTER_WINDOW_MIN_WIDTH`
into `window_host/geometry.rs`. The unit suite, `pnpm typecheck`, lint and the whole Rust suite all
passed, because every one of them *imports or links* the code — the e2e reader is the only reader
that resolves a **file name**, and a path only a test walks is invisible to a compiler. **`e2e/**` is
the third place a split can break a reader**, after `tests/**/*.rs` and `src/**/*.ts`, and the
programme's own reference sweep had looked in neither of the first two only because it enumerated
extensions rather than readers.

**Two load-sensitive cases, both real flakes.** `combo-popup-width` measured a list `446.18` wide
against a field of `454.28` — a `0.98` scale mid-arrival — and `select-popup-scope` measured a gap of
`3.9495` where the assertion wants `4 ± 0.05`. Both passed when run alone (12/12 and 6/6) and failed
under 16 workers; the first also reported *identical* numbers twice, which is what falsified the
first guess at it (a field still growing). Both now call `support/settled.ts`, which the repository
already had for exactly this: the first fix had addressed the wrong quantity, and the file that says
so was already in the tree.

**A trap worth one line of its own.** The pnpm workaround this environment needs
(`XDG_CACHE_HOME=$PWD/.tmp-review-pnpm/cache`) also moves Playwright's browser directory, so the
first run failed all 293 cases with `Executable doesn't exist at …/ms-playwright/…`. The suite needs
`PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright` alongside it. Nothing about the failure said
"browsers", only that every case had failed in three milliseconds.

**The four runs, in order**, which is also the method: 293 failed (browsers); **281 passed / 12
failed** (the eleven pet cases and one flake); **292 passed / 1 failed** (after re-pointing the
reader; the remaining failure the second flake); **293 passed, exit 0** (after `settled`). The first
and last are the readings that matter — the middle two are what turned a red suite into a diagnosis.

**What this says about the gate.** A green `pnpm test` said nothing about any of it, and the release
checklist in `AGENTS.md` does not run the suite that found it. Adding `pnpm e2e` to the gate is a
maintainer's decision — it needs a browser, a dev server and three minutes — but it belongs in the
same conversation as the review's `T3`, because "green" currently means four commands rather than the
whole tree's evidence.

---

## 8. The Linux bundles, rebuilt from this tree

The maintainer asked for the packaged executable to be kept current. `scripts/package-linux.sh` ran
end to end (all seven steps) and published:

| Artifact | sha256 |
|---|---|
| `release/nekowite_1.0.0_x64` | `7370ba73650cd0afc0da8ff2de96f128869e3d5247f73edb058144a3e2264226` |
| `release/opencode` | `ca6c0e1f42be3120595bf6848937e7586ec862c87fa7aa111e89c7cc6e9a4650` (the pinned digest) |
| `release/nekowite_1.0.0_amd64.deb` | `904f1df35386d307772d3960c525dd83700b1b653977fc454281e717c7c668ea` |
| `release/nekowite-1.0.0-1.x86_64.rpm` | `775d46dd1c6611486dc8dd5fd04541770f12410afc770946d0e3346929b0a851` |
| `release/nekowite_1.0.0_amd64.AppImage` | `736f315c00b8f84487fc85bd3bca8d873881e7637022ad92c5eefea8b6916186` |

**Rebuilt again after this round's fixes.** The table above is the build this run *replaced*, and it
is retained at `release/superseded/build.y9W7u4/` — verified by digest, not by the directory's name:
that file's sha256 is `7370ba73…`, which is the line above. The run published:

| Artifact | sha256 |
|---|---|
| `release/nekowite_1.0.0_x64` | `ec7569ba78422d5528f85dd84dc9d09b924b786ef9a13ee4a10098ef64155f03` |
| `release/opencode` | `ca6c0e1f42be3120595bf6848937e7586ec862c87fa7aa111e89c7cc6e9a4650` (unchanged: it is the pinned input, not a build product) |
| `release/nekowite_1.0.0_amd64.deb` | `0e5839ddd28904d382c795c603903b5ca3cdd7fd726fe5b8ee12b7655d675fd8` |
| `release/nekowite-1.0.0-1.x86_64.rpm` | `7b303062381342922d0781f1b3b92cff051c4dd58c686f927d663bc2f8c4026e` |
| `release/nekowite_1.0.0_amd64.AppImage` | `ab52089fed367b53ba50e2c72e40912c406c854eea4f1726b410288750890dfd` |

This run proves one thing the earlier one could not: the engine *inside the AppImage* was driven in
place. It reports 1.18.29 with `PATH`, `HOME` and every credential absent, completes the ACP handshake
with no credentials, and completes it again inside a network namespace with only loopback. The two
things it still cannot show are the ones the pipeline names itself — a machine with no system
`opencode` (this one has `/usr/bin/opencode`), and the engine's notice file, which
`scripts/fetch-opencode-linux.sh` does not extract yet and which stays a distribution obligation.

The files it replaced are kept at `release/superseded/build.6Pw20m/`, and the pipeline's own closing
lines say what it does *not* claim: distribution compatibility and interactive workflows are not
verified by it, and the citeproc notice obligation recorded in `THIRD-PARTY-NOTICES.txt` remains.

**Two things had to be true first, and one of them was a defect this programme created.**

- The engine verification had to read the pin where the pin now lives (`update/manifest.rs`); it
  exited 1 in silence until that was fixed. That is the commit before this one, and the fourth
  reader class a split can break.
- pnpm needed writable XDG directories. `package-linux.sh` sets `XDG_CACHE_HOME` and `TMPDIR` of its
  own but not `XDG_DATA_HOME`/`XDG_STATE_HOME`, so in an environment where `$HOME` is not writable
  the second step dies with `[ERROR] unable to open database file`. Passing the two through the
  environment is enough; it is recorded here because nothing in the failure says "pnpm's data
  directory", and because the script is otherwise perfectly happy on a normal machine.
- This machine has a system `opencode` on `PATH`, so `verify-opencode-linux.sh` reports the §11.2
  clean-machine case as **not proven here** rather than claiming it.

---

## 9. The round after the programme: the leftovers, and two of the review's own findings that were wrong

The programme's backlog was empty when this round began, so it took the findings §3 still had open —
and then the ones whose *record* was wrong. Nine fixes, and they include the largest defect of the
whole review.

| # | Finding | Change | Evidence |
|---|---|---|---|
| **S4** | `import_attachment` copied any image-named path the renderer named | `commands/fs/picked.rs`: the native picker mints a one-shot, ten-minute, canonicalised grant and the command spends it, so a path the user did not choose is refused *before* the copy | Four IPC cases through the real command · **mutation check** kills exactly the import case · `attachment_grant_ipc_test` 14 passed |
| **U2** | Two production-dead exports (`imageMime`, `featureFor`) | `imageMime` deleted; `featureFor` given the call site it was written for, and its parameter changed to the kind so it could be called at all | `check-dead-exports.py` **91 of 1372 → 89 of 1371**, neither name in the list · mutation makes exactly five composer cases fail |
| **F9** | A delegated write dropped the port's "no history snapshot" warning | `ChangeRecord` carries it in a field of its own; the write arm no longer discards what it destructured | New case drives a port whose write reports a snapshot failure · **mutation check** fails that case alone (`left: None`) |
| **F11** | A plugin toggle could report a state the app did not hold | The toggle resolves to `{ disabled, refused, saved }`; an enable that cannot be applied goes back to disabled in the record **and** the file, and `saved` is a *verified* write because the writer is best-effort by design | New spec red at 9 failed / 1 passed before · 6 specs / 85 tests green · **mutation check** on the DOM half |
| **T3** | "`pnpm test` does not run `pnpm perf`; lint cannot fail on a warning" | `--max-warnings 462` on the renderer, and `pnpm verify` composes the CI sequence into one command | Fails at 461, passes at 462 · perf 2 files / 10 tests green in 9.1 s |
| **S6** | A crash mid passwordless→password change left the vault unopenable | `open_snapshot_from_backups` is the one backup search and `open_vault`'s `Locked` arm asks it; a backup decides the state only by **really opening the live snapshot**, so the lock is not bypassed | RED with the exact locked sentence a user saw · GREEN 5 passed · **mutation check** fails the symptom case while the no-bypass case stays green · the ignored real-snapshot cases pass |
| **T4** | ~50 `never used` warnings that are `#[path]` artefacts, and nothing separating them from real ones | The allow goes on the include site (never in `src/`, where the library build must keep reporting dead code), and only the lint the census showed | `cargo test --no-run \| grep -c "^warning"` **70 → 0** · control: a private unused function in `src/` still warns (0 → 1 → 0, md5 unchanged) |
| **D1–D11** | Stale comments and counts, including the two that hid F3 | Ten false numbers across seven files corrected, plus three claims whose *location* had moved with the splits | Counts a test asserts are stated; counts nothing asserts are described instead · 6 targets / 281 tests green |
| **U3** | "`main_window::raise`'s rebuild path still has no test" | **The finding is false** — see below — and the gap it was hiding is `raise`'s refusal arm, which now has a case | The pre-existing rebuild case reddens under a rebuild-arm mutant |

### Two of the review's findings were wrong, and one of them was inherited twice

- **U3 is false.** `tests/main_window_test.rs` has driven `raise`'s both arms under `MockRuntime`
  since `29f58ae` — the same commit that added `main_window.rs` — and
  `a_missing_main_window_is_built_again` goes red under a mutant that drops `build(app, config)`
  from the rebuild arm. What `e326a8b` deleted was the **process-level** drive, whose premise (a
  destroyed main window the process outlives) the change removed; the review inherited "nothing
  drives it" from `docs/HANDOVER.md` §9.4 and marked it "confirmed, as §9.4 states" — a confirmation
  of the *references*, which were also stale in that section, rather than of the coverage. It is
  worth naming how this survived: §9.4's claim was about a file that had been deleted, and the file
  that disproves it was cited two paragraphs earlier as one of the seven stale references.
- **T3's first half is stale.** `pnpm test` does not run `pnpm perf`, but CI does
  (`.github/workflows/ci.yml:22`, with a comment saying the harness asserts `docs/PERF.md`'s budgets
  and so is a gate), and `docs/dev.md` §7.1 already said so. The real gap was local — a developer's
  four commands were weaker than CI — which is what `pnpm verify` closes. The review marked this
  finding "reported, not re-run" and did not read the CI file.

### What this round found that the review did not

- **§5 was missing from this ledger entirely.** The review's summary counts D1–D11 and its §5 lists
  eleven rows; §3's table accounted for the twenty-five code findings and the flake, and the true
  total is **thirty-seven**. That was this document's omission, and it is why the group is now a row
  of its own rather than a silence.
- **Ten stale numbers, not three.** §5 named `build.rs`'s eighty-two, `lib.rs`'s eight pet commands
  and one more. The sweep found the same defect in `window_host/identity.rs`, `window_host.rs`
  (twice), `command_surface_test.rs`'s own docblock — which claimed 82 beside an assertion of 84 —
  `command_authorisation_test.rs`, and `desktop_pet_surface.rs`'s "eight switches" over a
  seven-boolean domain.
- **A fourth unreachable surface.** `SessionRuntime::changes` — the change list §7.2's attribution
  record exists for — is called only from tests. Nothing registers a command that reads it, so the
  records a delegated write produces never reach a window; F9 fixed what the record *carries*, and
  what reads it is T10's unbuilt surface.
- **T4's noise was hiding eight real findings**, in the test files themselves rather than in `src/`:
  two dead helpers (`agent_fs_capability_test.rs`'s `request`,
  `desktop_pet_ipc_test/support.rs`'s `resizes`), two stray imports, an inert parameter and three
  unread bindings. Fixing them is what took the count to zero; the artefacts alone would have left
  the stream merely shorter.
- **F11's `failed` could not mean "the write threw".** `writeGovernanceFile` wraps its whole body in
  a `try`/`catch` and swallows by design, so `await`ing it is not evidence that anything was written.
  The outcome is a verified write — read the file back through the MAC-verifying reader — which
  catches a silent no-op as well as a throw.
- **The attachment hint was wrong in both halves, and the first correction was wrong too.** The
  panel said a pasted image lands in the vault's `attachments` folder and appears in the list it was
  reading. It does not: it lands in `<note>_assets` beside its note, staging in `.tmp` until the note
  is saved, and the list shows `attachments/`, where the app's *own* insertions go. The first version
  of the correction said a note with no usable path lands in `attachments/` — the backend's empty-dir
  branch does mean that layout, but the intake never sends an empty dir, so the sentence would have
  replaced one false location with another. It was caught by reading `assetsDirForNote` rather than
  the branch.
- **A guard whose error message did not name the file it was reading.** The round gate's first run
  went red on `write_atomicity_test.rs`'s scan — this round's own `commands/fs/picked.rs` had put two
  `#[cfg(test)]` accessors above its trailing test module, so the scan stopped early and the rest of
  the file went unchecked. Finding it meant scanning twelve files by hand, because the assertion said
  only that *a* gated item was not a trailing module; it names the file now, proven by a mutation that
  fails with `commands/fs/picked.rs: …`.

### The gate

Run on the frozen tree with `apps/desktop/src-tauri/target/review-2026-09-21/final-gate.sh`, which now
calls `pnpm verify` (so the composed script is itself gated) and stages the verified engine before the
suite:

| Reading | Result |
|---|---|
| `pnpm verify` | **exit 0** — typecheck; lint 0 errors / 462 warnings (at the ceiling); tests **440 files / 4815 passed**; perf 2 files / 10 passed; renderer build 7.28 s; `check-katex` OK |
| `cargo fmt --all --check` | exit 0 |
| `cargo clippy --all-targets --locked` | exit 0, **97** warning lines — the first time this number has moved: T4's include-site allows also silenced three clippy `dead_code` reports, and the library build still reports what is genuinely dead |
| `tauri build --no-bundle` | exit 0; the staged engine was removed again afterwards, which is the script's own guarantee |
| full suite, `NEKOWITE_REQUIRE_PROCESS_TESTS=1` | **79 targets · 1406 passed · 0 failed · 5 ignored · 0 skip announcements** (the five are the expensive real-snapshot cases, run separately with `--ignored` during S6) |
| `pnpm --filter @nekowite/desktop e2e` | first run **291 passed, 2 failed**; after the copy fix below, **293 passed** on the full suite and 5 passed on the spec that caught it |

**The gate earned its keep twice in one run, and both times on this round's own work.** The first run
was red: `write_atomicity_test`'s write-surface scan had stopped early inside `commands/fs/picked.rs`,
which the S4 commit had added hours earlier — a module that silently halved its own coverage, caught
only because the whole suite ran (the per-file checks during the round all passed). Fixed in
`07db5dc`, and re-run green above.

The e2e suite then found what no unit test could: the attachment hint's copy spelled the folder
`<笔记名>_assets`, and Vue I18n reads an angle-bracketed word in a message as HTML — every render of
that panel logged `[intlify] Detected HTML in … message. Recommend not using HTML messages to avoid
XSS`, which `e2e/console-clean.spec.ts` fails on because every other surface is held to zero console
warnings. The panel is not an XSS risk; a console warning nobody else is allowed to emit is still a
defect, and it was mine, introduced by the round's own D5 fix. The strings lost their decorative
brackets in both languages, a sweep confirmed no other message in the catalogue contains one, and the
spec is green again.

That is the shape worth remembering about a gate: neither failure was reachable from the file that
caused it. The scan's rule was in a test file two directories away, and the console rule was in a
browser spec that only runs when a real page renders.

---

## 10. The round after that: the other half of two defects, and the debt the last one recorded

Three of the previous round's fixes left a half behind, and this round took those halves plus the one
piece of debt that round wrote down about itself.

| # | What was still wrong | Change | Evidence |
|---|---|---|---|
| **F11's panel half** | Reading the vault's switch file had four outcomes and reported none of them: a missing file, a file that is not ours and a failed MAC all left the in-memory set as it was, so the panel drew every switch from that set — "nothing here is switched off" and "the record cannot be verified" rendered the same. The previous round fixed the lie at the moment of the click; this is the same lie on first paint. | `DisabledPluginsRead` (`verified` / `absent` / `tampered` / `unreadable`), `readVaultPlugins` returning it beside the rows, and one sentence per unverified state in the panel — two sentences, because the remedies differ (fix or remove the file / leave it alone, the app writes neither). The composable also moves off the `services/plugins` shim, which is what that shim's own docblock asks its remaining callers to do. | 4 registry cases over the real in-memory fs (verified, absent, tampered, and both unreadable shapes — not an envelope, and a real envelope over bytes that are not a policy), 2 composable, 3 panel · **two mutation checks**, each failing exactly its own cases and nothing else |
| **T4's other half** | Deleting a never-called helper (`FakeSurfaces::resizes`) exposed the hole it belonged to rather than an unused line: no IPC case drove a settings write whose effect is a window that is **already open**. The arithmetic is asserted in `desktop_pet_settings_test`; the road a real write travels was asserted nowhere. | `tests/desktop_pet_ipc_test/settings.rs`: a saved size reaching the window that is up (and not minting one), and a refused resize that keeps the preference and still asks the windows behind the refusing one | 2 cases · target **73 passed** (71 before) · **two mutation checks**: skipping the character resize fails both new cases, and breaking at the first refusal fails exactly the refusal case with `the window after the refusing one was not asked` |
| **The test target at its budget** | `tests/agent_skills_test.rs` stood at 799 lines against the 800-line budget — one line of headroom, and the round that added to it last said the next edit had to split it first. | Target root of 85 lines plus seven modules under `tests/agent_skills_test/`, largest 208; the seam is the file's own six section headings, one module each | 17 cases before and after, `--list` names identical with the new prefix stripped, and **every case body byte-identical** to `git show HEAD:…` · `module_tree_test` and the sibling target green |

**Two things this round did not do, said rather than left implied.** The change list
(`SessionRuntime::changes`) still has no production reader — T10's surface is unbuilt, and building it
is a product decision rather than a defect fix. And clippy is still unratcheted: it has no
`--max-warnings`, and a count compared against a moving toolchain would fail contributors' builds for
something that is not their change.

### The gate

Run on the frozen tree with the same `final-gate.sh`, and green on the first attempt this time — the
previous round's gate needed three fixes before it would pass, all of them for that round's own work.

| Reading | Result |
|---|---|
| `pnpm verify` | **exit 0** — typecheck; lint 0 errors / 462 warnings (at the ceiling); tests **440 files / 4824 passed** (nine more than the previous round); perf 2 files / 10 passed; renderer build 14.39 s; `check-katex` OK |
| `cargo fmt --all --check` | exit 0 |
| `cargo clippy --all-targets --locked` | exit 0, **97** warning lines — unchanged, and the number the previous round was the first to move |
| `tauri build --no-bundle` | exit 0; the staged engine removed again afterwards, which is the script's own guarantee |
| full suite, `NEKOWITE_REQUIRE_PROCESS_TESTS=1` | **79 targets · 1408 passed · 0 failed · 5 ignored · 0 skip announcements** — two more than the previous round, which is exactly the pair of new IPC cases |
| `pnpm --filter @nekowite/desktop e2e` | **293 passed**, no failures on the first run: the new panel sentence renders in a real browser and the console-clean walk over every settings control stays clean |

**The bundles, rebuilt again** because this round carries a user-visible change (the panel sentence):
`scripts/package-linux.sh` ran all seven steps, publishing

| Artifact | sha256 |
|---|---|
| `release/nekowite_1.0.0_x64` | `5c549a8c492e3f7dc507a4e616a3b8dfa7ad99844a4d772eb49a3e42022714e2` |
| `release/opencode` | `ca6c0e1f42be3120595bf6848937e7586ec862c87fa7aa111e89c7cc6e9a4650` (the pinned input, unchanged) |
| `release/nekowite_1.0.0_amd64.deb` | `1721f6e9d8f623cbdb73bfdad10aee36f447569ba39bf2233e66f80851d6c534` |
| `release/nekowite-1.0.0-1.x86_64.rpm` | `ecb52fed7fdd9303d035a285f725a46ee57e489a809db84d760e526eded0cce5` |
| `release/nekowite_1.0.0_amd64.AppImage` | `c0536b4d1c2a3992d8bcb149d19ee4161c16dd51afb3a72a00e53b2b6cff8007` |

The build these replaced is at `release/superseded/build.70ViJZ/`, verified by digest rather than by
name: that file's sha256 is `ec7569ba…`, which is the last line of §8's second table. The AppImage's
sidecar was driven in place again — version, empty environment, no credentials, and an ACP handshake
inside a network namespace with only loopback — and the two things it still cannot show are the ones
the script names itself: a machine with no system `opencode`, and the engine's notice file.

---

## 11. The round after that: the last inch of a chain, and two instruments that said the wrong thing

This round found no new bug in the product. It found the last inch of the previous round's
reachability work unpinned, one plan-shaped record that had been overtaken, and **two tools whose
readings were wrong about the thing they exist to measure** — which is the class T1 opened and the
one this programme keeps finding at the meta level.

| # | What | Change | Evidence |
|---|---|---|---|
| **The review surface's last inch** | `ui/EditorPane.vue` mounts `AgentChangedFiles` — the change review — and **nothing held it there**: the component's own spec mounts the component, the e2e spec mounts the component, and `EditorPane`'s four specs cover the editor, the intake, scroll sync and tail space. Deleting that one element would have removed the surface from the running application with every test green. | `src/ui/EditorPane.agentSurfaces.test.ts`: the real pane, with the session record seeded the way the component's spec seeds it, asserts the surface and its row are on screen — and that it is absent for a pane serving no session, one handed none, and one with no note in front | 4 cases · **mutation check**: removing the element fails exactly the positive case (1 failed / 3 passed) and the file restored byte-identically is green · six neighbouring specs / 51 tests unchanged |
| **A plan that had been overtaken** | `app/agent-composition.ts` still asked for T10's composition step ("Add them as further `connect*` functions on this object"). T11 has had its function for as long as the next bullet in that file has said so; T10 never got one and does not need one — the surface is hosted in the pane and reaches the editor and the vault through the note's own save transaction, which a `connect*` would have had to hand it anyway. | The bullet records where the wiring actually went, with the test that holds it | `pnpm typecheck` and eslint clean; docblock only |
| **Two Xvfb spawns that crashed the display** | `scripts/boot-probe.sh` reported a **boot failure**, and the truth was that the display never came up: plain `Xvfb` here segfaults initialising GLX, so GTK cannot start and the app exits 1. `e2e/native-beta-smoke.mjs` spawned Xvfb the same way. This is finding T1 one layer out — in the tools rather than in the test targets T1 fixed. | `-extension GLX` on both, with the measurement cited where each is passed | **Read both ways**: the probe said `FAIL … (exit=1)` with the GTK panic before, `PASS: process stayed alive until the deadline` after; the native smoke went from the same display failure to **`{"status": "PASS", "applicationRestart": true}`** — a real GTK window typing a marker into a note, saving it, and restarting · `boot-probe.test.sh` 12 readings still pass |
| **A sweep that libelled a wrapper** | `check-channels.py` closed with "listened for, but no Rust side emits it: **1 of 8**", and the entry was `tauri-event-adapter.ts`'s own parameter — `listen<T>(event, cb)` — resolved as a channel named `event`. Nothing was wrong with either side; the heading was. | A listener whose argument is neither a literal nor a known `const` goes to its own section, labelled as what it is | After: **0 of 21** emitted-but-unnamed, **0 of 6** listened-but-unemitted, and two wrappers listed separately (`pet-navigation-listener.ts`'s would have been the second false positive) |

**One correction to §10, because this round read the reachability properly.** §10 said the change list
"still has no production reader — T10's surface is unbuilt". Two things were wrong with that. The
surface is **built and hosted** (the table above is what now holds it), and the Rust table is **read
in production**: `SessionRuntime::change_for` → `FsCapability::change_for` → the `agent_recover_change`
command the frontend calls at `platform/gateways/tauri-agent/ipc.ts:261`. What is test-only is the
*list* accessor `SessionRuntime::changes`, which is how `agent_fs_capability_test` and
`agent_change_recovery_test` read back what a delegated write recorded — a legitimate read path for a
suite that has no IPC command to ask. So the honest statement is narrower: §7.2's record is reached one
row at a time by the recovery command, the whole-list read exists for tests, and nothing is missing.

**No bundles this round**, and the reason is a fact rather than a schedule: the only frontend changes
are a test file and two docblocks, so the executables published in §10 still carry every shipped
behaviour. The e2e suite was not re-run for the same reason — the application's behaviour is
unchanged — and the gate below is the frontend and Rust half.

### The gate

| Reading | Result |
|---|---|
| `pnpm verify` | **exit 0** — typecheck; lint 0 errors / 462 warnings (at the ceiling); tests **441 files / 4828 passed** (one more file and four more tests than the previous round, which is `EditorPane.agentSurfaces.test.ts`); perf 2 files / 10 passed; renderer build 17.89 s; `check-katex` OK |
| `cargo fmt --all --check` | exit 0 |
| `cargo clippy --all-targets --locked` | exit 0, **97** warning lines — unchanged for a third round |
| `tauri build --no-bundle` | exit 0; the staged engine removed again afterwards |
| full suite, `NEKOWITE_REQUIRE_PROCESS_TESTS=1` | **79 targets · 1408 passed · 0 failed · 5 ignored · 0 skip announcements** — the same counts as the previous round, which is what a round that changed no Rust source should produce |
| e2e | not re-run, and the reason is in the section above: no shipped behaviour changed |

---

## 12. The round after that: the gate itself, and the dialect the AI path could not reach

Two findings, and the first is about the instrument every other reading in this document depends on.

**The gate was a tool that said the wrong thing.** It lived in a git-ignored scratch directory
(`src-tauri/target/review-2026-09-21/final-gate.sh`) and it had two properties nobody could see from
its output: a step's failure did not stop the next step, and the script's exit code was the *last*
command's — so a red `cargo test` followed by a successful `rm`/`ls` reported success. It did exactly
that on §9's first gate run: the suite failed, the script exited 0, and only reading the output showed
it. That is the class this programme keeps finding in the repository's tools, in the one place where
it matters most, because everything else is verified **by** this.

`scripts/gate.sh` is that sequence, committed and honest:

- every step runs even after one fails — a summary of all of them is worth more than the first
  failure — and each step's status is recorded;
- the exit code is **1 if any step failed**, with `FAIL: N of M step(s) failed: <names>` on stderr;
- the summary prints the counts a green run is judged by, not just the names: the Rust suite's target
  count and passed/failed totals, `pnpm verify`'s test count, clippy's warning lines;
- `--only <steps>` for a subset, `--with-e2e` for the Playwright suite, logs under
  `target/gate/<step>.log`;
- it stages the verified engine before the Rust suite and removes it afterwards, and it runs that
  suite with `NEKOWITE_REQUIRE_PROCESS_TESTS=1` — so a process-level case that cannot run fails
  instead of skipping (finding T1's rule, now in the gate rather than in one script's memory).

**Proven by breaking it**: with a deliberately misformatted item added to `src/errors.rs`,
`bash scripts/gate.sh --only fmt,clippy` printed `FAIL fmt (exit 1)` **and** `PASS clippy
(exit 0) — 97 warning lines` in the same run — both steps ran — and the script exited **1** with
`FAIL: 1 of 2 step(s) failed: fmt`. The mutation was removed and the file restored byte-identically
(md5 `0a5fea6fc641c26d4808c9925c176027` before and after).

**The live AI run had a branch no run could reach.** `ai_live_test.rs` drives the app's own AI path
against the real gateway, and its one paid turn asked for `deepseek-v4.1-flash` — which never streams
`delta.reasoning_content`. Every run therefore printed `reasoning seen: false`, the counter for
reasoning events could only ever be zero, and `extract_openai_reasoning` had no live witness at all. A
second paid case now asks `deepseek-v4-flash`, which streams its thinking before its answer, and
asserts the two facts separately: reasoning arrived at all (`completion.saw_reasoning()`, the app's own
reader), and **the answer still arrived after it** — the half a partly-working reader fails, since the
two arrive on different fields separated by a long run of thinking frames. `verify-ai-live.sh` requires
both evidence lines independently for exactly that reason, and its cost note now says two turns, with
the measured sizes: the first bills 17 prompt + 2 completion (stable), the reasoning one 89 prompt and
a completion side that moves with how long the model thinks (20 and 31 across runs, of which 17 and 28
were reported as reasoning tokens).

**Read both ways**, which is what makes it coverage rather than a green line: with
`extract_openai_reasoning` mutated to return `None`, the new case fails with its own sentence, the
counter reads `0 byte(s) of thinking`, and `verify-ai-live.sh` itself exits 1 — so the script's marker
discipline is a gate too, not a decoration. The source was restored byte-identically
(md5 `8d081748f7ae2902a46bb0ace5240466`) and the green run after it read `112 byte(s) of thinking in
25 chunk(s), then 4 byte(s) of answer`. The byte counts differ per run by design; the assertions are
about arrival and order, never size.

### The gate

Run for the first time by the committed script — `bash scripts/gate.sh` — and green on all six steps.
The readings below are its summary, which is where the counts a green run is judged by now live:

| Step | Result |
|---|---|
| `verify` | PASS — **5919 tests across 3 package runs** (editor-core 959, plugin-host 132, the renderer 4828), lint at its ceiling, perf's 10, the renderer build and `check:export-css` |
| `fmt` | PASS |
| `clippy` | PASS — 97 warning lines, unchanged for a fourth round |
| `instruments` | PASS — `check-reachability.py`, `check-dead-exports.py`, `check-channels.py`, all three now honest about what they list |
| `build` | PASS — `tauri build --no-bundle`, with the verified engine staged for the suite and removed after |
| `rust` | PASS — **79 targets, 1409 passed, 0 failed** (one more than the previous round: the live reasoning case), no skip announcements |

Two things about that run are worth recording because they are the reason the script exists. The
summary's `verify` line first reported **perf's ten tests** — the last `Tests N passed` line in the
log — which is a reading that looks like the suite's and is not; the line now sums the three package
runs, and the corrected reading is the 5919 above. And `--with-e2e`/`--only` were exercised rather
than assumed: `--only nosuchstep` exits 2 with `FAIL: no step matched`, and `--with-e2e --only e2e`
ran the Playwright suite through the same harness and reported **293 passed** on its summary line —
the count matters there for the same reason it does everywhere else, since a run that collected no
tests exits 0 and prints no such line.

---

## 13. The round after that: two writers that ignored the reader's rule, and instruments CI never ran

**The reader stated the rule in its own type, and two writers broke it.** `governance-file.ts` names
four outcomes and attaches the instruction to one of them: content that is "not a MAC envelope we
wrote" is "Never clobber it". Both writers did:

- `persistDisabledPlugins` refused `tampered` and let `not-ours` fall through — no payload, so it
  built a fresh one and wrote it over whatever sat at `.nekowite/plugin-governance.json`. Flipping one
  plugin switch destroyed a user file that happened to live there; on a mismatched read it wrote a file
  that then verifies as ours, so the state it never read was gone for good.
- `scheduleGovernanceSave` wrote the in-memory records after 250 ms **with no read at all**. It is
  armed by trusting a key, revoking a plugin, moving a version range and the digest map, and
  `loadGovernanceFile` sets `currentVault` *before* it decides the file was tampered — so the two
  states the reader refuses were exactly the two this path would overwrite.

Both obey it now: the switch write answers the new `'unreadable'`, and the debounced write goes
through `writeGovernanceFromMemory`, which reads first and skips on `tampered` or `not-ours` — reading
is what makes the check *current* rather than a statement about load time. `absent` is still written in
both, because a first run is how a vault gets a file at all.

**`'unreadable'` gets its own sentence rather than reusing tampering's**, because the user's remedy
differs: a tampered file is one of ours that someone changed (fix or remove it), a foreign one is
somebody else's and the app leaves it alone. `unwrittenReason` and the new
`settings.plugins.toggleForeignFile` copy say so in both languages, and the panel's read-side notice
already carried the matching state from §11.

The evidence is a **new spec beside the store**, which had no spec of its own at all — including the
debounced writer, which nothing had ever driven. It asserts the **bytes** rather than a return value
("nothing was written" is exactly the claim a summary can make while the file changes underneath it)
and asserts that **no write was even attempted**, since a write that landed and was then compared
byte-for-byte would still have replaced the file's inode, mode and mtime.

**The mutation checks, and one of them nearly lied.** Both are recorded here because the second
attempt is the instructive one:

| Mutation | Reading |
|---|---|
| the switch write's `not-ours` guard removed | exit 1, exactly two cases red: `expected 'saved' to be 'unreadable'` and the registry's toggle case |
| the debounced writer's read removed | exit 1, exactly its two refusal cases red |
| **first attempt** at the first mutation: removed the *reader's* identically-spelled line | **all 23 tests passed** — the mutation was not applied to the code under test, and only the assertion that the guard was really gone caught it |

**Three instruments that CI never ran, and none of which could fail.** They found three
unreachable-code instances for the review; they were run by hand, and a checkout that only saw CI had
no reading of them. They are stdlib Python over the source tree, so the `check` job can run them — but
all three ended in `return 0`, so adding them as they were would have produced a step that can only
fail if the script crashes, and a comment calling that a gate. Two of them now can fail, and the third
is documented as the reading it is:

| Instrument | Verdict |
|---|---|
| `check-reachability.py` | exits **1** on a specifier that resolves to nothing (its other list — 552 unreachable spec files and configs — stays a report) |
| `check-channels.py` | exits **1** on a channel emitted to nobody, or listened for with no emitter; both failures are silent in the running app |
| `check-dead-exports.py` | always exits 0, and its docstring now says why: ~ninety uncalled exports are mostly "exported so the spec can reach it", so failing would make the gate red on a healthy tree (the ratchet is a decision, recorded here, not taken) |

Read both ways: healthy tree, all three exit 0; a planted `import … from './this-does-not-exist-xyz'`
gives `FAIL: 1 specifier(s) resolve to nothing` and exit 1; a planted `listen('planted-channel')` in
the adapter gives exit 1. Both plants were removed byte-identically, and the workflow still parses.

### The gate

| Step | Result |
|---|---|
| `verify` | PASS — **5926 tests across 3 package runs** (seven more than the previous round: the six new writer cases and the registry's foreign-file case), lint at its ceiling, perf's 10, the renderer build, `check:export-css` |
| `fmt` | PASS |
| `clippy` | PASS — 97 warning lines, unchanged |
| `instruments` | PASS — and this is the first round the step could have failed: two of the three now exit non-zero on their findings, which is why the step was re-run on its own after the loop replaced the `&&` chain (the chain would have hidden the other two instruments' sections behind the first failure) |
| `build` | PASS |
| `rust` | PASS — **79 targets, 1409 passed, 0 failed**, no skip announcements; unchanged from the previous round, as a round with no Rust source change should read |

The e2e suite was not re-run: the round's frontend change is a new refusal sentence on a path the
Playwright suite does not drive (toggling a plugin needs a library with plugins, and this build does
not load them), and the panel's rendering is unchanged.

**The bundles, rebuilt again** because this round changes shipped behaviour (a plugin switch can no
longer destroy a file that is not ours, and refusing now has its own sentence):

| Artifact | sha256 |
|---|---|
| `release/nekowite_1.0.0_x64` | `451642216ae580b0b771cbf42c6a04430b92770fd72ac15188bc5e7c7a35594d` |
| `release/opencode` | `ca6c0e1f42be3120595bf6848937e7586ec862c87fa7aa111e89c7cc6e9a4650` (the pinned input, unchanged) |
| `release/nekowite_1.0.0_amd64.deb` | `a7762e11490afbe39e3869d122e8a5a6d6da53a45c77b0edb8d915ac4dd350da` |
| `release/nekowite-1.0.0-1.x86_64.rpm` | `bfd6e479e3c236599e4a7ac202bfa8aff9879a3c516f91569b7000e1694b8a2b` |
| `release/nekowite_1.0.0_amd64.AppImage` | `b9c0a9bafdf16ce0e6ddc5fb016db78927f1ca3a8dae7472e248f2950aa463a1` |

The build these replaced is at `release/superseded/build.l3mgGl/`, verified by digest rather than by
name: that file's sha256 is `5c549a8c…`, the first line of §12's table. The AppImage's sidecar was
driven in place again (version with an empty environment, no credentials, an ACP handshake inside a
network namespace with only loopback), and the two things that run still cannot show are the ones the
script names itself: a machine with no system `opencode`, and the engine's notice file.

---

## 14. The round after that: the user guide, and a row of §13 that lasted one round

**The guide described a layout the application no longer has.** `docs/USER-GUIDE.md` sent the reader
to the right rail for the tabs 「AI / 大纲 / 引用 / 历史 / 属性」, with Stats last. The rail declares
**one** tab (`ui/InfoRail.vue`'s `TABS`), and the other four are modes of the left column now:
`NoteListToolbar.vue`'s `MODES` lists seven — notes, outline, links, references, history, frontmatter,
stats — under a comment that says exactly what happened ("The last four are the panels the right rail
gave up"). Four places plus the overview section were corrected, and the vocabulary was split on
purpose: 「页签」 for the right rail, which really has tabs, and 「模式切换」 for the left column's
toolbar, which the code calls a switch.

**And the attachment location for the third time.** The guide told the reader that a pasted image is
saved into the knowledge base's `attachments/` and appears in the left attachments panel. Both halves
are false for the ordinary case (it lands in `<note>_assets/` beside its note, staging in `.tmp/` until
the note is saved; the panel lists where the app's *own* insertions go) — the panel's copy was fixed in
§11 and `docs/PRIVACY.md` before it, and the guide was the copy nobody had checked. That is worth
noting as a pattern rather than a one-off: **a wrong user-facing sentence usually has siblings**, and
the review's D5 named one of three.

**Two things were checked and deliberately not changed**, and the second is the lesson:

- The guide is written for Windows ("对应 1.0（Windows）", "Microsoft Print to PDF"). Not stale:
  `README.md` says the portable Windows exe is the primary deliverable and Linux builds from source,
  and `docs/RELEASING.md` is titled "发布流程（1.0，Windows）". "Fixing" it would have invented a
  platform story the repository does not have.
- A grep for who sets the four panel modes found **no caller**, which reads as "these panels are
  unreachable". It was a wrong reading: the toolbar drives them through a table of
  `{id, label, icon}` entries, so no call site spells `setMode('references')` and no such grep could
  ever have found one. This is the second time this session that a negative grep was the weakest
  evidence in the room — the first was §13's mutation, which removed the *reader's* identically-spelled
  line, left every test green, and was caught only by an explicit check that the guard was really
  gone. **A grep that finds nothing is a hypothesis about where to look next, never a finding.**
  (A third candidate was checked while writing this paragraph and is *not* an instance: `git ls-files`
  on `binaries/` answering nothing is correct — `.gitignore:88` ignores that directory, which is why
  CI cannot stage the engine from the repository.)

**§13's row about this instrument is overtaken, and that is the round's second fix.** §13 said
`check-dead-exports.py` "always exits 0, and its docstring now says why". One round later the deferred
decision was taken, so the instrument now fails on two things — a control that makes the sweep blind
(which used to print a warning and return 0, the one case that must never read as green, because a
blind sweep reports the empty list that a clean tree also reports), and the count rising above
`CEILING = 89`, the ratchet that makes the next uncalled export a decision. Read three ways: healthy
exit 0 at `89 of 1372`; one planted uncalled export **exit 1** with `FAIL: 90 … above the ceiling of
89`; a planted control that cannot pass **exit 1**. Both plants removed byte-identically. `ci.yml`'s
comment and `scripts/gate.sh`'s said the old thing too and were corrected in the same commit — the
stale sentence had three copies, which is the same pattern as the attachment claim, one layer in.

### The gate

`bash scripts/gate.sh --only instruments` — PASS. The other steps were not re-run, and the reason is a
fact rather than a schedule: this round changes a Markdown document, three scripts and a workflow, and
no source file, so `verify`, `fmt`, `clippy`, `build` and the Rust suite cannot read differently from
§13's run (5926 tests, 79 targets, 1409 passed, clippy 97). No bundles were rebuilt for the same
reason — nothing that ships changed.

---

## 15. The round after that: the audit document this session had not read

**`docs/DOC-AUDIT.md` exists, is 375 lines, and had already found most of what the last two rounds
"discovered".** It audits every `docs/*.md` file against the code at commit `e326a8b` with a
per-claim evidence column ("Read `<file>:<line>`", "Ran", "Unverified"). This session had not opened
it. Two of §14's guide corrections are rows in its §1.6 table, and one of them was fixed in the **wrong
direction**: it says the guide's daily-note claim is wrong, and §14's round checked the claim against
`src/templates/daily.md` — the file the claim names — instead of against the code path the button
takes. The button renders `DEFAULT_DAILY_TEMPLATE` (a title and one bullet); the four sections belong
to the *picker's* 每日日记 template. The daily-note e2e written in this round is what surfaced it.

The lesson is not "read more documents". It is the one this programme keeps relearning from the other
side: **a document that lists the defects is evidence too**, and reading it is cheaper than
rediscovering its contents from the code. §14 is left exactly as written, with this section as the
correction, because the sequence — rediscover, miss, then find the catalogue — is the finding.

**The audit's §6 is a code defect, and it was still open.** `Cargo.toml` declares `libc = "0.2"`
directly, nothing in `src/` calls it, and `agent_runtime/process/shutdown.rs` justified invoking
`kill(1)` rather than `libc::kill` with a premise that is false ("`libc` is not a direct dependency of
this crate and adding one would edit `Cargo.lock`"). The audit offered two options — remove it, or keep
it and use it — and **missed the manifest's reason for the third**: `Cargo.toml:54-60` keeps `libc` for
the pty half of §4.3's native terminal ("the mature PTY crate §4.3 asks for is still an unapproved
dependency; this is the substitutable half of it"), and its claim about the lock file checks out
(`Cargo.lock` holds `libc 0.2.189`, listed by a dozen crates). So the dependency is deliberate and the
*comment* was the defect. It now gives the reason that holds and can be measured — `kill(1)` needs no
`unsafe` block, and `src/` contains **zero** occurrences of `unsafe` — and the measurement became a
rule: `lib.rs` declares `#![deny(unsafe_code)]`, so the pty work `libc` is reserved for has to argue
for itself at the item. Mutation proof: a planted `unsafe { 1 }` fails the build with
`error: usage of an unsafe block` and the file restored byte-identically.

**`docs/PRIVACY.md` had four false claims, and the most consequential is a privacy promise.** 「除你
自己配置的 AI 请求外，应用不会主动连接任何服务器」 is false: the application itself fetches the pet's
character library (`desktop_pet/resources.rs:53`) and the ACP agent registry
(`commands/agent_catalogue.rs:44`), and the bundled `opencode` engine is a separate process whose
provider connections the document never mentioned at all. The master-password interface the document
said did not exist has existed since `VaultKeySettings.vue` — whose own header comment names that line
as what it obsoleted. The Windows-only paths are paired with Linux now, and the system-directory
inventory gained the six directories the code defines (`agent-runtime/`, `downloads/`,
`agent-recovery/`, `agent-profiles/`, `agent-catalogue/`, `desktop-pet/`) plus the WebView's own
user-data directories, which a listing of this machine's real data directory shows and which is where
the settings the same section lists actually live.

**And `clippy` is the last gate step that could not fail — it has a ceiling now.** `cargo clippy` runs
without `-D warnings` in the script and in CI, so it could only fail by crashing. It is held to **110**
warning lines with slack on purpose (clippy's version is not pinned; an exact ceiling would break on a
toolchain bump rather than on a change), proven by moving the ceiling rather than by waiting for
fourteen warnings: at `CLIPPY_CEILING=96` the step fails with `FAIL clippy (exit 1) — 97 warning lines`
and the run exits 1; restored byte-identically it passes. `check-dead-exports.py`'s `CEILING` is the
same shape with no slack, and both files say why they differ.

**Also this round, the first e2e coverage of the daily note** (`e2e/daily-note.spec.ts`, four cases,
398 lines): the path the service computes, the template with its variables interpolated, and a second
press opening the same note and keeping what was typed into it — with three mutations as its evidence,
including one that showed the create-only refusal is a *second* guard behind the existence check.

### What the audit lists that is still open

Left open deliberately, because a fix written from a claim I have not verified against the code is the
failure mode this round is about: §1.1's remaining PRIVACY items (the vault inventory's `plugins/` and
`.tmp/` entries, and the percent-escaped history path at `:37`); §1.6's remaining guide rows
(「索引」 opens a placeholder rather than a panel, the floating toolbar is always present rather than
selection-triggered, the Base URL field renders for all seven providers, the graph's toolbar sits above
the canvas, two settings pages are missing from the list, the save indicator has a fourth state, the
page sizes include A3/A5/Legal, 专注模式 lives on the appearance page, and the bundled plugin is named
`Status`); §1.7's `docs/test-plan.md`, which describes a test surface that no longer exists; and §2,
§3 and §5's tables. They are the next round's work rather than this round's claims.

### The gate

| Step | Result |
|---|---|
| `verify` | PASS — **5926 tests across 3 package runs**, unchanged: the round's new spec is Playwright's, and vitest does not collect it |
| `fmt` | PASS |
| `clippy` | PASS — 97 warning lines, and for the first time **under a ceiling** rather than merely reported |
| `instruments` | PASS |
| `build` | PASS |
| `rust` | PASS — **79 targets, 1409 passed, 0 failed**; the attribute and the comment add no cases, which is what an unchanged count should mean here |
| `e2e` (`--with-e2e`) | PASS — **297 passed**, four more than §13's 293, which is the daily-note spec and nothing else |

No bundles were rebuilt: the round's Rust change is a crate attribute and a comment, so nothing that
runs changed. The packaged artefacts from §13 remain the current ones for the shipped behaviour.















