# Documentation audit

2026-09-21, at commit `e326a8b`. Every `docs/*.md` file was read and its claims were checked against
the code. `docs/HANDOVER.md` §10 carries the findings that change what you should do next; this file
is the fuller record, including the ones that are only filing errors.

**How to read the evidence column.** "Read" means a file was opened and the claim checked at the
line named. "Ran" means a command was executed and its output is quoted or summarised. "Unverified"
means exactly that — the claim looked false, but the check needed a measurement that was not made
(a real WebKit run, a packet capture, a full suite run).

**This repository's own rule applies to this document too:** where a document and the code disagree,
code wins, and a document that is old and correct is not a finding. §4 lists what could not be
verified; §7 lists what held up.

---

## 1. Wrong, and it matters

### 1.1 `docs/PRIVACY.md` — blanket no-network claim

| Line | Claim | Reality | Evidence |
|---|---|---|---|
| `:68` | 「除你自己配置的 AI 请求外，应用不会主动连接任何服务器」 | Two endpoints are reached without the user's AI provider: the pet's character library and the ACP registry. | Read `apps/desktop/src-tauri/src/desktop_pet/resources/remote.rs:53-54` (`LIBRARY_ENDPOINT = Some("https://pets.thenightwatcher.online/manifest.json")`) and `apps/desktop/src-tauri/src/commands/agent_catalogue.rs:44` (`REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json"`). The pet's is fetched on mount with no cache: `apps/desktop/src/features/desktop-pet-settings/components/PetCatalogueBrowser.vue:132` is `onMounted(() => void read())`. |
| `:12`, `:7` | "the four AI actions" are the network-producing actions | The ACP agent engine — an external `opencode` process with its own network access — is not mentioned anywhere in the document. | Read; the document does not contain the words `agent`, `opencode` or `ACP`. |
| `:25`, `:58` | With the AI kill switch off, no AI request is sent — "not discarded, simply never sent" | The kill switch is consulted through `features/ai/services/ai-gate.ts` → `services/ai-permissions.ts:82` `isAiEnabled`. The model-list refresh path (`features/settings/composables/use-ai-settings.ts` `refreshModels` → `stores/settings-ai.ts` `listModels` → the gateway's model-listing command) does not visibly pass through it. | Read both paths. **Not proven by execution** — see §4. If it holds, the switch leaves a request that carries the real API key unguarded. |
| `:46` | No interface exists for setting a master password | It exists: `features/settings/components/VaultKeySettings.vue`, mounted from `AiSettings.vue`. That component's header comment names this line of the document as the thing it obsoleted. | Read both files. |
| `:32` | Pasted/dropped images live in `attachments/` | They go to a note-specific `<notename>_assets/` directory, or `.tmp/` while the note is unsaved. `attachment-library.ts` lists only `ATTACHMENTS_DIR`, so they never appear in the attachments panel. | Read `services/rename-asset.ts`'s `assetsDirForNote()`. **Code is right, document is wrong** — and `i18n/namespaces/attachments.ts` repeats the same stale claim to the user. |
| `:37` | History lives at `history/<note path>/…` | The path is one percent-escaped component: `docs/a.md` → `docs%2Fa.md`. | Read `domain/path_encoding.rs`. |
| `:3`, `:44`, `:48`, `:70`, `:76`, `:78` | Windows framing throughout: 「1.0（Windows 桌面版）」, `%APPDATA%`, `%LOCALAPPDATA%`, `nekowite.exe` | On Linux the data directory is `~/.local/share/dev.nekowite.app/`. | Read `storage/key_store.rs` (`app_data_dir()`), and the path exists on this machine. |
| `:68`, `:70` | Directory listing of what is written | Incomplete: also `agent-runtime/`, `agent-profiles/`, `agent-recovery/`, `downloads/`, `agent-catalogue/`, `desktop-pet/`; in the vault also `.tmp/`, `plugins/`, `.nekowite/index/*.tmp`, `<note>_assets/`. | Read. |

### 1.2 `docs/SECURITY.md` — a gate described as enforced that is dormant

| Line | Claim | Reality | Evidence |
|---|---|---|---|
| `:9-25` | A table headed "Enforced", prefaced with "each item is verified by an automated test", beginning with the plugin consent/integrity/trust sequence | That sequence cannot run in either environment. `features/plugins/services/vault-plugin-load.ts:142` returns early when `!isPluginImportAllowedByCsp()` (true in the production Tauri webview), and `features/plugins/services/discovery.ts:133` is `if (!isTauriRuntime()) return Promise.reject(new Error('browser-demo: plugin execution disabled'))`. The two guards are mutually exclusive. | Read both guards. The tests that cover the sequence mock `importSource`/`loadPlugin`. **The gate is deliberate** — see `docs/PLUGIN_ISOLATION.md` and §1.3 — but "Enforced" is the wrong word for it. |
| `:14-16` | "the loader asks the user before activating any plugin declaring dangerous capabilities" | No dialog exists. `setPluginPermissionDecider` and `setPluginTrustDecider` have test-only callers; with no decider the default is refuse (`features/plugins/services/permissions.ts:89-90`). | Read. |
| `:55-56` | A fresh native folder pick "auto-registers" the vault | It does not. `commands/fs.rs` only records the pick, and its own comment says registration deliberately does not happen there; `state/vault_confinement.rs`'s `approve_pick` writes `chosen`, not `opened`. | Read. |
| `:57` | The settings path field is "(typed or browsed)" | The input is `readonly`, with a comment saying it is read-only on purpose. | Read `features/settings/components/GeneralSettings.vue`. |
| `:53-59` | Only vaults "registered this session" are accepted | `vault_confinement.rs`'s `register` also accepts the backend's own remembered `last-vault` record, and `tests/vault_auth_test.rs` calls that deliberate. | Read. |
| `:68-69` | The key crosses IPC "once" | True for Rust→window (a mask is returned). False for window→Rust: the plaintext key is attached on every request when the field is non-empty. | Read `stores/settings-ai.ts` and the gateway. |
| `:120-125` | After a quota trip, a plugin "only runs again after an explicit `resetUnstablePlugin`" | `vault-plugin-load.ts` calls `resetUnstablePlugin` unconditionally for every plugin that preloaded, so opening or switching a vault clears it. | Read. |
| `:139` | "Signed plugin provenance: no publisher signature / trust anchor" | Self-contradicting: the following sentence and the code both have an HMAC signature, and `features/plugins/services/trust-policy.ts` calls the signature the trust anchor. | Read. Should say "no *asymmetric* publisher signature". |
| whole file | No mention of the agent engine | The repository's own measurement is that refusing the `fs` capability does **not** stop the engine writing: `agent_runtime/fs_capability.rs` says the capability "is an opportunity the engine may take, not a gate every write must pass", and `tests/agent_fs_write_refusal_test.rs` records 2026-09-17 runs disproving it 3/3. | Read. This is the single largest omission in the document. |

**What is right in this file**, and was checked: §4's mask mechanics and Argon2id parameters
(`rust-argon2 2.1.0`'s `owasp2()` = 19 MiB / t=2 / p=1), §5/§6's governance file, redaction rules,
HMAC envelope and rollback semantics, and §3's command list — all 69 `#[tauri::command]`
declarations were scanned and no path-confined command was found missing its `require_opened_vault`
guard.

### 1.3 `docs/PLUGIN_SDK.md`

- **`:363`** — vault plugins "load in a plain-browser demo build". False; see §1.2. §6's four-step
  walkthrough (「在浏览器 demo 里本地加载示例插件」) therefore cannot be performed. The bundled
  example `examples/plugins/hello` is itself correct.
- **`:20`** — "the surface is frozen by a snapshot test … that fails if any stable export is
  removed". The snapshot test's `REQUIRED_RUNTIME_EXPORTS` (`packages/plugin-host/src/api-surface.test.ts`)
  lists 42 names; **17 of the 62 named entries in §1's table are absent from it**, including the whole
  signature family, the whole quota family, and `setLifecycleHookTimeout` /
  `getLifecycleHookTimeout`, `serializeGovernance` / `loadGovernance`, `setAuditLogFileSink`,
  `getPluginAuditEvents`. Those exports can be deleted with the snapshot still green.
- **`:382-384`** — "Plugins should declare a **peer range** … the host refuses a plugin whose
  declared range excludes the running version." No peer-range handling exists anywhere in
  `packages/plugin-host` or `features/plugins`; `loader.ts` reads only `name`/`version`/`main`, and
  `semver.ts`'s `versionSatisfies` serves a host-configured min/max range instead. The example
  plugin's own `package.json` has no such field either.

### 1.4 `docs/PLUGIN_ISOLATION.md`

- **`:3`, `:86-89`** — the A/B/C sandbox routes are presented as an undecided choice
  (「状态：未实现」, 「决策所需：1. 选 A、B 还是 C」). **Route A has been chosen and shipped**:
  `discovery.ts`'s runtime guard and `vault-plugin-load.ts`'s CSP guard are its enforcement, and
  `README.md`, `docs/USER-GUIDE.md` and the settings strings all describe it as current behaviour.
  The document should read "A chosen; C is the 1.1 blueprint".
- **`:18`** — points at `packages/plugin-host/src/loader.ts:112` for the `import(/* @vite-ignore */ …)`.
  It is at **line 123**; 112 is a comment.
- **`:13`** — says the execution gate is `apps/desktop/src/services/plugins.ts`. That file is now a
  17-line compatibility barrel; the implementation is in `features/plugins/services/discovery.ts`.

### 1.5 `docs/RELEASING.md` — a Windows document, and the Linux path it omits could produce a broken release

- **The whole file** is titled 「发布流程（1.0，Windows）」 and its commands say "run in Git Bash".
  `AGENTS.md` says the target platform is Linux; CI runs on `ubuntu-latest`.
- **`:39`, `:43-44`, `:55`** — packaging is `bash scripts/package-win.sh`, producing
  `release/nekowite_<version>_x64.exe`; `:55` then asks you to verify a signature on a file that does
  not exist. `release/` holds no `.exe` at all.
- **`:53-56`, `:74`** — a whole section on Windows SmartScreen and Authenticode. The Linux side's real
  gap — the deb/rpm/AppImage are **not GPG-signed** — is not mentioned.
- **The file never mentions `pnpm package:linux`, `scripts/package-linux.sh`, the engine staging step
  or `scripts/verify-opencode-linux.sh`.** A maintainer following this document to produce a Linux
  release would not stage `opencode` beside the portable binary, and the result would be a portable
  executable whose agent panel cannot start. This is the repository's signature failure
  ("dev tree green, package broken") written into its own release checklist.
- **`:19`** — "the same as CI" — omits three gates CI actually runs: `pnpm perf`, `cargo fmt --all
  --check`, and `playwright install --with-deps`.
- **`:15`** — the hardcoded `v0.1.0` claim is obsolete (corrected; see §3).
- **`:79`** — `LICENSE` is described as 「尚未提交」 (not yet committed). `git ls-files LICENSE`
  returns it; it was added by `10d58ed`.
- **`:62`** — "source is authoritative via a git tag (e.g. `v1.0.0`)". `git tag` returns nothing; the
  repository has no tags.
- **`:14`** — folding `## [Unreleased]` into `## [1.0.0]`. `CHANGELOG.md:384` already has
  `## [1.0.0] - 2026-08-29`; following this would collide.
- **`:29`** — the release gate's e2e step is Playwright driving Chromium against a Vite dev server.
  The repository's own `apps/desktop/e2e/webkit/webdriver.mjs` explains that Playwright's `webkit`
  is "a Playwright build, not the GTK port", so the release gate does not drive the engine that ships.

### 1.6 `docs/USER-GUIDE.md` — the interface has moved

| Line | Claim | Reality | Evidence |
|---|---|---|---|
| `:17`, `:105` | The right rail has tabs 外观 / 大纲 / 引用 / 历史 / 属性 plus Stats, and chat is the "AI" tab | The right rail has **one** tab: `AI`. Everything else moved to the second column on the left. | Read `ui/InfoRail.vue` — `RailTab = 'ai'`, `TABS` has one entry, and the comment records that it used to carry six. |
| `:105` | Chat lives in the right "AI" tab | It is not what the rail opens by default. `AGENT_PANEL_DEFAULT = true` and `AppShell.vue` gives the rail body to `AgentRailBody`. | Read `stores/settings-agent.ts:87`, `app/AppShell.vue`. |
| `:54` | Clicking 「索引」 switches the column to an index view | There is no such panel. It falls through to a 「即将支持」 placeholder. | Read `features/notes/components/NoteListPanel.vue`, `NoteListToolbar.vue`. |
| `:58`, `:72`, `:84` | Tabs / citations / history are right-rail tabs | They are in the left column's second pane, under different names: 文档属性 / 引用文献 / 历史版本. | Read `NoteListToolbar.vue`. |
| `:15` | The second column's tabs are 「笔记 / 大纲 / 链接」 | Seven modes, all icon-only buttons with no text labels. | Read `NoteListToolbar.vue`. |
| `:16`, `:32` | The floating toolbar appears when text is selected or the caret is in a paragraph | `WordToolbar` is always present, with no `v-if`/`v-show`. | Read `ui/EditorPane.vue`, `components/WordToolbar.vue`. |
| `:40` | Pasted images are stored in `attachments/` and appear in the left 「附件」 list | Same as §1.1: they go to `<notename>_assets/`. | Read `services/rename-asset.ts`. |
| `:64` | The daily note is created from a built-in template with four sections | The built-in daily template is frontmatter + `# {{date}}` + a single `-`. The four sections belong to a different, choosable template. | Read `services/note-templates.ts`. |
| `:93` | The base URL field is editable only for `local`, `custom`, `deepseek` | The field renders for all seven providers; `showBaseUrl` is `computed(() => true)`. | Read `features/settings/composables/use-ai-settings.ts`. |
| `:60` | The graph legend is bottom-right; two buttons top-right | All three are in a two-row toolbar **above** the canvas. | Read `features/graph/components/GraphToolbar.vue`. |
| `:109-114` | Four settings pages: 外观 / 编辑器 / 常规 / 插件 | There are also 智能体 and 桌面宠物. | Read `SettingsNavigation.vue`, `i18n/namespaces/settings.ts`. |
| `:3`, `:79` | 「对应 1.0（Windows）」; "choose Microsoft Print to PDF" | Export uses `window.print()`, which under WebKitGTK is the GTK print dialog. | Read `services/export.ts`. |

Minor: `:18` (the save indicator has a fourth state, 保存失败), `:73` (bibliography punctuation),
`:79` (page sizes include A3/A5/Legal), `:112` (专注模式 is on the appearance page), `:114` (the
built-in plugin is named `Status`, not 「文档状态」).

### 1.7 `docs/test-plan.md` — 34 lines, and the test surface it describes no longer exists

- **`:10-20`** — the "existing tests" column names things that are not in the tree:
  `coordinator tests` (no match anywhere), `editorPersistence` (the file is
  `features/editor/controller/editor-persistence.ts`), `useImagePasteDrop` (**no match anywhere**;
  the file is `features/editor/composables/use-image-intake.ts`), `vaultIndexCoordinator` (**no match
  anywhere**), `exportRenderers` (the file is `services/export-renderers.test.ts`).
- **`:9-21`** — the status column is empty for all 12 rows, while `:32` asks for COVERED/PARTIAL/GAP.
- **`:3`** — 「AI 相关暂不执行」 is obsolete: 114 `.test.ts`/`.spec.ts` files, 7 `agent-*.spec.ts`,
  and 43 `tests/agent_*.rs`/`ai_*.rs` targets cover that ground, and none of the four vitest configs
  excludes it.
- **`:4`** — the lint figure is false (see §3), the `cargo test` spelling does not work from the
  repository root, and the Playwright invocation bypasses the repository's own entry point and
  competes for port 1420.
- **`:23`** — cites 「docs/debug.md §4」. `docs/debug.md` has no numbered sections.
- **What the document does not mention at all:** the four vitest projects, the Playwright specs, the
  73 Rust integration targets, `pnpm perf`, `check:export-css`, `cargo fmt --all --check`.
- **Test assets nothing runs:** `docs/mdx-demo/__validation/validate.test.ts` is outside every vitest
  project's `include`; the 33 driver scripts under `apps/desktop/e2e/webkit/` are not executed by the
  Playwright run; `scripts/boot-probe.test.sh` and `scripts/package-linux.test.sh` have no CI step.
  `eslint.config.js` still lints a deleted `e2e/webkit/perf.mjs`.

### 1.8 `docs/RECOVERY.md`

- Paths that do not exist: `services/gateways/memory.test.ts` (it is `platform/gateways/`),
  `stores/tabs.test.ts` (the cases live in `tab-recovery.test.ts`, `tab-save.test.ts`,
  `tab-persistence.test.ts`), `app/recoveryClosedLoop.ts` (`app/recovery-closed-loop.ts`),
  `ui/AppSidebar.vue` (`features/sidebar/components/`, and it is not a test).
- Symbols that do not exist: `relocatePendingAssets` (it is `relocate` in `stores/tab-assets.ts`).
- `:69` — says `reloadFromDisk` "closes the dialog". It does not; `ConflictDialog.vue`'s own comment
  says 「Deliberately no close here」.
- `:135` — says flush is followed by `closeAll()`. It is `removeAllTabs()`, with a comment explaining
  why `closeAll` was rejected.
- `:127-131` — describes window close as a `beforeunload` handler that "cannot await an async save".
  That is true of the browser-demo fallback. The real path is Tauri's `close-requested` in
  `app/app-lifecycle.ts`, which **can** await, and which runs the placeholder reconciliation and the
  dirty/untitled rescues. A reader would conclude the app cannot save on close.
- `:16-18` — "every successful save records a snapshot", exempting only new files. There are three
  exemptions: a new file, **empty previous content**, and **unchanged content**
  (`storage/save_store.rs`).
- Right, and worth keeping: the `decideConflict` truth table, the `write`/`deleteFile` signatures,
  `maxHistory` default 10, the 7-day GC threshold, and the orphan-scan behaviour.

### 1.9 `docs/A11Y.md`

- Six camelCase paths that do not exist (`composables/useFocusTrap.ts`, `useEditorFocus.ts`,
  `editorSearchOverlay.ts`, …). The repository's rule is kebab-case for TypeScript files
  (`AGENTS.md:45`).
- **`:54`, `:58`** — describes `ConflictDialog` as moving focus to the first control, and quotes a
  test asserting it. The code does the opposite on purpose: `useFocusTrap(dialogEl, active, {
  initialFocus: false })` plus a manual focus on the dialog, because the first focusable control is
  the destructive "use disk" action. The test's title says so. **The document describes the behaviour
  that was removed.**
- `:59` — quotes a test as asserting that `reloadDisk` adopts the disk content. The test asserts that
  the dialog only emits and performs nothing.
- `:75-78` — the `announce` wiring table's paths are wrong, and it misses five live call sites
  (`stores/refused-save.ts`, `features/sidebar/composables/use-sidebar-trash.ts`,
  `features/graph/composables/use-graph-canvas.ts`, `features/chat/composables/use-chat-send.ts`,
  `features/settings/composables/use-export-settings.ts`).
- `:27` — the image panel's input ids are listed incompletely; `neko-image-height` and
  `neko-image-lock` are missing, and the test checks only the listed five, so it cannot catch that.
- Right: the ImagePanel/TableMenu role/aria/focus assertions were checked and match.

### 1.10 `docs/debug.md` and `docs/development-log.md`

- **`docs/debug.md`** is not a document — it is a 457-line prompt for a QA agent, written as indented
  prose with no headings. It recommends Chrome DevTools and CDP for WebView verification
  (「不可只依赖 Chromium E2E」 in one paragraph, CDP in another) and **never mentions WebKitGTK**, the
  engine that ships. The instruments that do exist — `apps/desktop/e2e/webkit/` and
  `scripts/boot-probe.sh` — are named in none of the twelve documents. Its gate list omits
  `cargo fmt --all --check` and `check:export-css`.
- **`docs/development-log.md`** is a historical log. Read as current it misleads: it names the branch
  `master` and `codex/`-prefixed feature branches (only `main` exists), a commit identity that is not
  the one in use, a `.npmrc` that does not exist, and Windows `.exe` artefacts. It contradicts itself
  between `:562` and `:579` on the build artefact name. `:507` records the AI audit log as
  unimplemented; it was implemented on 2026-09-14.

---

## 2. Stale because the code moved on, and the code is right

These were corrected in place on 2026-09-21, each with its reason in the commit.

- **`docs/dev.md:636`** said `pnpm --filter desktop test:e2e`. The package is `@nekowite/desktop` and
  the script is `e2e`. Run as written it fails: `[ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT]`. Corrected, and
  the section now also names `pnpm perf` and the Rust gates.
- **`docs/RELEASING.md:15`** said the version shown in the interface was hardcoded `v0.1.0` in
  `StatusBar.vue`. It is read from the build via `platform/app-version.ts`. Corrected.
- **`docs/RELEASING.md:81`** said there is no CI or packaging script for Linux. Both exist.
  Corrected, and the missing GPG signing is now named as the real open item.
- **`docs/test-plan.md:4`** claimed the lint gate reports 0/0. It reports 0 errors and 462 warnings
  and exits 0. Corrected, with the e2e entry point and the CI file named.

**Deliberately left alone, and why:** `docs/PRIVACY.md`'s false no-network claim was **not** corrected
in place. Which fix is right depends on a product decision the maintainer has not made — either the
app stops reaching those endpoints, or the document admits it does. Editing the promise to match the
code would foreclose the first option. It is reported here and in `docs/HANDOVER.md` §10.9 instead.

---

## 3. Numbers that are now wrong

- **The file-size budget.** Five numbers are in circulation. The census and the one in force are in
  `docs/HANDOVER.md` §10.1; the short version is **600 for business files, 800 for tests**, nothing
  enforces it, and `AGENTS.md:32` (500), `docs/development/DEVELOPMENT-ROADMAP.md:616` (500/800) and
  the four plan-file lines (300/400/500) are all read-only by instruction and cannot be fixed.
- **`docs/test-plan.md:4`** — lint "0/0". Now 0 errors / 462 warnings.
- **`docs/PERF.md:234-236`** — regression counts 259 / 49 / 776, from 2026-09-15. Today the three
  suites are 73 / 10 / 400 **files** (959 / 132 / 4774 tests). The budgets themselves and their
  assertions in `perf/perf.bench.test.ts` are correct and were checked item by item.
- **`docs/PERF.md:228-229`** — offers skipping `pnpm perf` "when CI is slow". CI runs it
  unconditionally and its own comment calls it a gate.
- **The desktop pet and the agent panel are in no user-facing document.** Zero matches for 「桌宠」 or
  `desktop-pet` in `README.md` and `docs/USER-GUIDE.md`; zero matches for `opencode`, `ACP` or `agent`
  in `CHANGELOG.md`. Meanwhile they have their own Rust modules, twenty e2e specs, two of the three
  Vite entries and a Tauri capability file.
- **`CHANGELOG.md` stops before both of them.** Its most recent commit is 2026-09-14 and its top
  section is `## [Unreleased]`. Everything from 2026-09-16 onward is unrecorded.

---

## 4. Found, but not verified

Listed so that nobody mistakes these for checked facts.

- **The AI kill switch and the model-list refresh** (§1.1). Both paths were read; no request was
  captured. Settling it needs either a traced run or a test that asserts the gateway is not reached
  with the switch off.
- **Whether WebKitGTK 4.1 actually blocks `import('blob:')`.** No WebKit runtime evidence exists in
  the repository; `e2e/security-csp.spec.ts` is a Chromium run with a stubbed `__TAURI_INTERNALS__`.
  This is `docs/SECURITY.md` §2's central assertion, and it is unmeasured.
- **Whether the two network endpoints are actually reached in a packaged build.** Read from the code
  and the mount hook; no packet capture or proxy was used.
- **The PDF export dialog under WebKitGTK**, and whether `asset://` images resolve in print preview.
  No test asserts either.
- **`git tag` being empty** is certain; whether tags are omitted on purpose is not — `README.md` says
  there is no official release channel.
- **The 68 unrun Rust integration targets** (see `docs/HANDOVER.md` §9.1a). They were not executed;
  nothing is claimed about whether they pass.

---

## 5. `docs/architecture/` — three documents, and the third is not reliable

`docs/architecture/` is **read-only** by the maintainer's instruction, so these are reported and not
fixed.

### 5.1 `agent-dependencies.md` — a dependency ledger recording a change that was never made

- **`:18`** — says `tokio-util` was approved with the **`compat`** feature to wrap a bounded adapter
  around the SDK's `Lines`. The manifest says
  `tokio-util = { version = "0.7", default-features = false, features = ["rt"] }` — **no `compat`**.
  A bounded reader does exist, but it is built from `futures_util` and a hand-written
  `BoundedFrameReader`. This is the file's central deliverable, and its headline row is false.
- **`:29`** — says `process.rs` went "from 419 lines to 98". The file was never either number; it is
  **906** lines today, and the history runs 372 → 410 → 481 → 906.
- **`:31`** — says the SDK cleans up with `SIGKILL` only, and that the graceful order "awaits T2
  measurement". The SDK has `SHUTDOWN_GRACE_PERIOD = 1s` and a shutdown-timeout write, and this
  repository implements the same shape.
- **`:37`** — lists `certificate-untrusted` as needing to be added on the TypeScript side. It is
  already there (`platform/gateways/agent-contracts/failure.ts:37`).
- **`:51`** — says the repository has none of `diff` / `dompurify` / `xterm` / `jsonc` / `pty`.
  `dompurify` is present in the lockfile (transitively, via Milkdown), and the same document's `:46`
  concedes that `diff` is too.
- **`:33` and `:40`** — two different sections are both numbered `## 2.`, which makes the document's
  own cross-references ("see §4", "see §5") ambiguous.

### 5.2 `zed-port-ledger.md` — accurate in detail, two rows wrong

- **`:14`** — gives the Zed version as Cargo workspace `version = "0.62"` in `zed-main/Cargo.toml`.
  That file's `[workspace.package]` declares no version at all; `version = "0.62"` is the **`windows`
  crate's** version, under `[workspace.dependencies.windows]`. Zed itself is
  `zed-main/crates/zed/Cargo.toml` `version = "1.21.0"`. This row is the ledger's only version pin,
  so it is the one a reader would quote.
- **`:90`** — §4's registry says it is 「目前为空——尚无任何 Zed 源码进入产品代码」 (currently empty —
  no Zed source has entered product code). Several files say otherwise in their own headers:
  `agent_runtime/capabilities.rs` derives its fields from Zed's `SessionCapabilities` with line
  references, and `fs_capability.rs` cites "Zed's shape" and "exactly as Zed's `max_point` does".

The rest of this ledger holds up well — the sha256 pins, the ported constants and the ported module
shapes were checked.

### 5.3 `desktop-pet-port-ledger.md` — line counts drifted, and one inventory is short

- **`:175`, `:178`, `:179`** — target file sizes for `pet-physics.ts` (300), `pet-motion-types.ts`
  (133) and `pet-motion.ts` (372). Actual: **303 / 143 / 400**. The neighbouring counts in the same
  table are still right. The code moved on; the ledger did not.
- **`:96`** — the inventory of inherited literal keys counts 49 `ap_*` keys plus "four families
  built by name". The 49 is right; the "four" is not, and the list is short — `ap_reactive`,
  `ap_floating_ball` and `ap_msg_src` appear in the reference sources and nowhere in the ledger,
  which describes itself as a first-pass list.

---

## 6. A code defect found while auditing the documents

Not a documentation problem, and worth fixing on its own.

**`apps/desktop/src-tauri/Cargo.toml:60`** declares `libc = "0.2"` as a direct dependency. Nothing in
`apps/desktop/src-tauri/src` uses it — `grep -rn "libc::"` returns exactly one hit, and that hit is a
comment.

That comment is the defect. **`apps/desktop/src-tauri/src/agent_runtime/process.rs:414`** justifies
calling the `kill` binary rather than `libc::kill` with this reason:

> `kill(1)` is invoked rather than `libc::kill` because `libc` is not a direct dependency of this
> crate and adding one would edit `Cargo.lock`.

`libc` **is** a direct dependency. The stated premise is false, so the comment now argues for a
design on a ground that does not hold — and an unused direct dependency means the false premise is
also costing a pinned version in the lockfile. Either remove `libc`, or keep it and use it; leaving
both is the one option that keeps the comment wrong.

---

## 7. Documents that are old and correct

Checked and reliable:

- **`docs/PERF.md`** — except the two counts in §3. The `docs/dev.md` section-number corrections it
  records are accurate, every path it names exists, `MAX_DIRS = 100_000` and
  `LOW_COPY_ENCODE_MIN_BYTES = 1 MiB` are real, and the deleted `search_notes` /
  `save_attachment_file` commands are indeed gone.
- **`README.md`'s architecture and packaging sections**, including the x86_64-only paragraph, which is
  unusually precise about a delivery limitation.
- **`apps/desktop/src-tauri/src/lib.rs` lines 1–26**, and the module headers under
  `src/agent_runtime/` and `src/desktop_pet/`. These are current and authoritative.
- **`docs/architecture/desktop-pet-port-ledger.md` and `docs/architecture/zed-port-ledger.md`** —
  written as ledgers of decisions and their reasons, and most of their detail holds: the sha256 pins,
  the ported constants and the shape of each port were checked. **They are not uniformly current** —
  see §6 for the specific stale rows. `docs/architecture/agent-dependencies.md` is the weakest of the
  three; do not rely on its dependency table.
- **The header comments of the process-level tests** (`tests/agent_exit_teardown_test.rs`,
  `tests/main_window_close_pet_test.rs`) and of `tests/module_tree_test.rs`. They state what they
  prove and what they do not.
- **`docs/PRIVACY.md`'s AI detail** — the 200-character continuation limit, the selection-rewrite
  shape, the note-context limit with head/tail preservation, the default `http://localhost:1234/v1`,
  the key mask, the Argon2id parameters, the audit log's 200-entry cap and its no-body-content rule,
  the three write policies, the CSP's refusal of remote images, and the absence of telemetry, crash
  reporting and update endpoints. All verified.
- **`docs/SECURITY.md` §4 (second half), §5, §6**, and §3's command list. All 69 `#[tauri::command]`
  declarations were scanned for a missing path-confinement guard and none was found.
- **`docs/RECOVERY.md`'s** `decideConflict` truth table and its file-operation signatures.
- **`docs/A11Y.md`'s** ImagePanel and TableMenu static assertions.
- **`docs/PLUGIN_SDK.md` §1's export names, §3's hook signatures, §4.1's trust table and §4.2/§4.3's
  timeout and quota semantics** — except the peer-range claim in §1.3 above.
