# NekoWite — handover

Written 2026-09-21, at commit `e326a8b`, for the team that takes this repository over. It assumes
you have never seen the project. Development has stopped; what follows is documentation only.

Nothing here is a summary. Every claim that can be checked is stated with the file or the command
that shows it, so that you can check it again in six months when it may no longer be true.

**Read §1 first — there is work already pushed that you should pull before you build anything.**

---

## 1. Start here: your first hour

### 1.1 Pull first, do not rebuild

Ten commits of application work were made and pushed to `origin/main` on 2026-09-21
(`9393e0b` through `e326a8b`), followed by two commits that add this document and the audit it is
built on (`a5d50c7`, `82ef853`). So twelve, and the tip should be `82ef853`:

```bash
git fetch origin
git log --oneline -12 origin/main     # 9393e0b .. 82ef853, all dated 2026-09-21
git rev-parse HEAD origin/main        # both should print 82ef853b6e383a2266e68c3813be3a6bcd83debd
```

If `HEAD` is not that commit, you are reading a checkout that predates this document — the file
would not be here at all if it did, so this is a check on your remote, not on the file.

CI (`.github/workflows/ci.yml`) runs on every push. Its `check` job and `rust` job are the two
things that decide whether that commit is sound.

**What to expect from the tip, stated as a prediction rather than an observation** — CI itself has
not been watched: the `rust` job should **fail**, because `cargo test --locked` is its first step and
that is the red case in §9.1; and the `check` job should pass, because every one of its steps was run
by hand on this tree and is recorded with its result in §4.5. That failure was known and written down
before the push rather than discovered by it — it is the first item in the work list (§9.1, §9.1a),
and §9.1a is the reason it matters more than one test.

**Do not re-package.** `release/` already holds a complete, verified set of artefacts built from this
source tree (§4.4), and rebuilding without a reason is how you end up with a bundle that does not
match the source you are reading.

### 1.2 Prerequisites

- Node.js 22, pnpm 11. The root `package.json` pins `packageManager: pnpm@11.1.1`, and
  `.github/workflows/ci.yml` deliberately does **not** pass a version to `pnpm/action-setup` — the
  action reads that field, and giving both makes it refuse to run.
- Rust stable, with `rustfmt` and `clippy` components (`dtolnay/rust-toolchain@stable` in CI).
- Tauri v2 Linux system dependencies: `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`,
  `libayatana-appindicator3-dev`, `librsvg2-dev`, `patchelf`. The exact `apt-get` line is in
  `.github/workflows/ci.yml`.
- For packaging and for the process-level tests: `xvfb`, `dbus-run-session`, `xdotool`, `rpm` (a
  real one — `scripts/package-linux.sh` refuses to run unless `rpm --version` prints
  `RPM version N`), `appimagetool`/`linuxdeploy` (downloaded and cached by the packager), `patchelf`.

### 1.3 The five-minute orientation

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm test && pnpm perf   # ~2 minutes together
pnpm dev                                                # browser preview on :1420
pnpm tauri dev                                          # the real app, real WebKitGTK
```

`pnpm dev` renders in a browser. That is enough for layout work and **not** enough for anything
touching the filesystem, the clipboard, the agent engine, the pet's windows or the CSP. The product
engine is WebKitGTK (via Tauri); a reading taken in Chromium is not a reading of this product.

### 1.4 What to read, in order

1. `README.md` — what the product is, in Chinese, aimed at users.
2. `docs/dev.md` — the conventions document. Section 5 is layout, 6 is the comment style, 7 is the
   gate list. It is long and partly aspirational; §10 below says which parts to distrust.
3. `apps/desktop/src-tauri/src/lib.rs` lines 1–26 — the Rust layering, stated in the crate root's
   own header. This is the shortest accurate description of the backend that exists.
4. `docs/architecture/desktop-pet-port-ledger.md` and `docs/architecture/zed-port-ledger.md` — what
   was ported from where, and what was deliberately not ported. They were written as ledgers, so they
   record decisions and their reasons rather than intentions, and most of their detail holds up
   (the per-file sha256 pins, the ported constants, the shape of each port). **They are not
   uniformly current, though** — each has specific stale rows, listed in `docs/DOC-AUDIT.md` §5.
   Read them as a well-kept record that is a few weeks behind the code, not as a specification.
5. This file, §5 (conventions), §6 (traps), §7 (instruments), §9 (what is not done).

---

## 2. What this is

A local-first desktop knowledge base. You write in a WYSIWYG Markdown/MDX editor and the file on
disk stays plain Markdown with YAML frontmatter — readable by Git and by other editors. External
edits hot-reload. Tables, math, citations and MDX components live in the same document. It exports
HTML and PDF.

On top of that editor there are two subsystems that are much larger than the README suggests, and
both of them ship:

- **An agent panel** that drives the `opencode` CLI over ACP (Agent Client Protocol) as a child
  process. This is roughly a third of the Rust tree (`apps/desktop/src-tauri/src/agent_runtime/`)
  and twenty of the ninety-odd Rust test targets.
- **A desktop pet** — a second and third window (`desktop-pet.html`, `desktop-pet-ball.html`) with
  its own settings, its own capability file and its own Rust module
  (`apps/desktop/src-tauri/src/desktop_pet/`, plus `main_window.rs`).

Both ship in `release/`. Neither is mentioned anywhere in `README.md`, `docs/USER-GUIDE.md` or
`CHANGELOG.md` — see §10.5. If you are the team taking this on, that gap is the first thing worth
fixing, because it is the difference between a product you can market and one you cannot.

**Scope: Linux only.** The maintainer's instruction is explicit. WebKitGTK 4.1 is the engine that
counts. There is a `scripts/package-win.sh` and a `PNPM package:win` script that exist and are not
maintained; treat anything Windows-shaped as frozen, not as a supported target.

**Architecture, in one line each:**

- `apps/desktop` — Vue 3 + TypeScript UI and the Tauri shell.
- `packages/editor-core` — Markdown/MDX parsing, editing and serialisation, built on Milkdown
  (ProseMirror). It has no dependency on Tauri or on the desktop app.
- `packages/plugin-host` — plugin loading, permission checks and lifecycle. Same isolation rule.
- `apps/desktop/src-tauri` — the Rust backend: filesystem, vaults, recovery, keys, AI providers,
  the agent runtime, the pet's windows.

---

## 3. How the repository is laid out

### 3.1 The three Vite entries, and why there are three

`apps/desktop/vite.config.ts` names three HTML inputs under `rollupOptions.input`. The reason is
isolation, and it is worth understanding because it constrains how you add a window.

| Entry HTML | Module graph | Why it is separate |
|---|---|---|
| `index.html` | `src/main.ts` | The editor, the index, the agent panel, the search graph. |
| `desktop-pet.html` | `src/app/desktop-pet-entry.ts` | The pet's character window. Loads **the pet and nothing else** — it never parses the editor, the index or the agent panel. |
| `desktop-pet-ball.html` | `src/app/desktop-pet-ball-entry.ts` | The pet's floating-ball window, a second light entry beside the character's. |

Two things make this load-bearing:

- The dev server would serve these files anyway — Vite serves the project root statically — but a
  **build** only emits the HTML files named in `input`. A window whose page is missing from the
  bundle loads a blank frame, and it only does so in the packaged app. If you add a window, you must
  add it here.
- Tauri's capabilities are matched by window label. The pet's windows are minted with a `pet-` label
  prefix, which is what makes `capabilities/desktop-pet.json` (a handful of commands) govern them
  rather than the main window's sixty-odd. See `apps/desktop/src-tauri/capabilities/`.

The comment above `rollupOptions` still says "Two pages" and then lists three. The code is right;
the sentence is stale.

### 3.2 The frontend directories

Under `apps/desktop/src/`:

| Directory | What belongs there |
|---|---|
| `app/` | Composition root. `AppShell.vue` (root layout), bootstrapping, lifecycle, window state, opening a file, switching vaults, the dialogs that are not a feature. It wires; it does not implement. |
| `features/` | Vertical slices, one per capability: `editor/`, `vault/`, `search/`, `graph/`, `attachments/`, `plugins/`, `settings/`, `agent/`, `desktop-pet/`. A feature owns its own components, services and models and does not reach into another feature's internals. |
| `platform/` | Tauri and system adapters: `gateways/` (the Tauri implementation and its in-memory twin), `events/` (listen/emit), `runtime/`. This is the only layer allowed to know Tauri exists. |
| `services/` | Testable business logic. No Vue, no reactive state, no DOM. |
| `stores/` | Pinia stores: reactive state and public actions, nothing else. Multi-step I/O belongs in a service. |
| `ui/` | Reusable components. Per `AGENTS.md:35`, a UI component orchestrates props, events and rendering — it does **not** contain filesystem transactions, path policy or provider logic. |
| `view/` | Eight files. The document panes (`RenderedPane.vue` and its neighbours). |

The allowed dependency direction is `UI → composable/store → service → gateway → platform`, stated
in `docs/dev.md` §5.3. The forbidden directions are the ones that have actually been broken and
fixed: `platform` importing UI, `editor-core` importing desktop, `plugin-host` calling a Rust
command directly.

`shared/` and `test/` are named in `docs/dev.md` §5.5 as targets and **do not exist**; the
equivalent code lives in `services/`, `ui/` and in `*.test.ts` files next to their subjects (§5.1).

### 3.3 The two packages

Both are consumed through a single barrel export (`"exports": { ".": "./src/index.ts" }`) and are
built as part of the workspace, not published.

- `packages/editor-core` — 73 test files, 959 tests. Owns the Markdown/MDX parser, serialiser,
  table operations, math, wiki links, and the MDX round-trip guarantees.
- `packages/plugin-host` — 10 test files, 132 tests. Owns plugin discovery, signature/trust checks,
  the permission model and the lifecycle. **A plugin loaded here never runs in a release build** —
  see `docs/PLUGIN_ISOLATION.md`. The loader is complete and correct; the sandbox it would need is
  not. Do not "fix" that by enabling the loader; the reason it is off is stated in that document and
  in the settings UI itself.

### 3.4 The Rust layering

`apps/desktop/src-tauri/src/lib.rs` lines 1–26 is the authoritative statement, and it points at
`docs/dev.md` §5.5. The modules:

```
agent_runtime/   the engine process, the ACP connection, the sessions, the permission table.
                 Knows nothing about Tauri; the commands are the only way in from a window.
desktop_pet/     the pet's windows and what this machine can do with them. Same shape as above.
commands/        the #[tauri::command] IPC surface. Thin args/DTO/error mapping only.
main_window/     what "the main window" is — the label, the one builder call that builds any
                 declared window, and the raise that builds it again after the user closed it.
instance_guard/  whether the single-instance D-Bus name actually armed (Linux-only).
domain/          path-confinement policy, vault rules, crash recovery.
storage/         file, trash, index and key stores.
providers/       AI providers (client, Gemini, OpenAI-compatible).
state/           managed app state: VaultRegistry, watcher, AI, keys.
errors.rs        shared user-facing error helpers.
lib.rs           assembles app state, builds the main window, registers commands. Nothing else.
```

Two subsystems above the list are **not** in `docs/dev.md` §5.5's Rust tree — that section
predates them. When the doc and `lib.rs` disagree, `lib.rs` is right.

The rule that matters most here, learned repeatedly: a module's rules are Tauri-free, and the
`#[tauri::command]` functions are the *only* thing that reaches them from a window. That is what
makes `agent_runtime` and `desktop_pet` testable without a display, and it is why the process-level
tests in §7 can drive them at all.

---

## 4. Working on it: the commands

### 4.1 Everyday

```bash
pnpm typecheck          # vue-tsc -b + tsc in both packages
pnpm lint               # ESLint, all three projects
pnpm test               # vitest, all three projects
pnpm perf               # the performance harness — SEE 4.2, this is the surprise
pnpm build              # vue-tsc -b && vite build for the desktop frontend
pnpm dev                # browser preview
pnpm tauri dev          # the real desktop app
```

Rust, **from inside `apps/desktop/src-tauri`**:

```bash
cargo test --locked
cargo fmt --all --check
cargo clippy --all-targets --locked
cargo build --locked
```

From the repository root the same work is spelled
`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`, but `cargo fmt --all --check` is
**not** equivalent across directories — run it from inside `apps/desktop/src-tauri` as CI does.

### 4.2 The four commands that surprise people

**1. `pnpm perf` is a separate vitest project that `pnpm test` never reaches.**
`apps/desktop/vitest.perf.config.ts` is its own config with `include: ['perf/**/*.test.ts']`, so the
slow benchmarks stay out of the fast suite. It sat broken for two stages because nothing ran it. CI
runs it (`pnpm perf` in `.github/workflows/ci.yml`), and it asserts the budgets recorded in
`docs/PERF.md`, so it is a gate. If you run only `pnpm test`, you are not running the gate.

**2. Use `pnpm --filter @nekowite/desktop e2e`, not bare `pnpm test:e2e`.**
The root `test:e2e` script is `pnpm --filter @nekowite/desktop exec playwright test`, which bypasses
`apps/desktop/scripts/run-e2e.mjs`. The wrapper is what reserves a free port for the run; without
it, Playwright falls back to the app's own port **1420** (`playwright.config.ts`'s
`NEKOWITE_E2E_PORT ?? 1420`). That port is also what `pnpm tauri dev` pins via
`vite.config.ts`'s `server.port` + `strictPort`. The failure mode is not a refusal: it is one of the
two killing the other, and it has happened. `playwright.config.ts`'s `reuseExistingServer: false` is
deliberate — reusing whatever answers on the port means a run can be served by a *different*
checkout's app and then report green (or red) about code your tree does not contain.

CI still uses the root `pnpm test:e2e`, which is fine there because nothing else is on the machine.

**3. `cargo build --release` is not `tauri build`.** See §6.1. This is the trap that has cost the
most time in this repository.

**4. The e2e suite has a 30-second per-test timeout** (`playwright.config.ts`'s `timeout: 30000`)
and it is genuinely load-sensitive. On a loaded machine specs time out and pass when re-run alone.
See §6.6.

### 4.3 Packaging

```bash
pnpm package:linux        # bash scripts/package-linux.sh
```

One command, seven numbered steps, and it is deliberate that it is one command: **all bundles are
built in a single invocation.** Splitting it produces artefacts from the same source tree at
different moments, which is exactly the mismatch you cannot see in a file listing. The script takes
an exclusive `flock` on `target/package-linux/build.lock` and refuses to run twice concurrently.

It does, in order: (1) verify the pinned engine artefact, (2) run the desktop tests, (3) typecheck +
lint, (4) build the executable and all three bundles, (5) stage the exact current-build artefacts
into `release/`, (6) verify the staged engine byte-for-byte against the verified input, (7) verify
that every bundle carries the third-party notices. Publication uses a rollback trap: if any rename
fails, the previous generation is restored from `release/superseded/build.XXXXXX`.

It does **not** run the Rust tests, clippy or fmt. Run those yourself first (§4.1).

### 4.4 What is in `release/`

Five files, and they are two different kinds of thing:

| File | What it is |
|---|---|
| `nekowite_1.0.0_x64` | The portable Linux executable. An ELF x86-64 binary. **Not self-contained** — see below. |
| `opencode` | The agent engine, a second ELF x86-64 binary (~184 MB). Ships beside the portable executable and inside all three bundles. |
| `nekowite_1.0.0_amd64.deb` | Debian/Ubuntu package. Self-contained: carries `usr/bin/opencode`. |
| `nekowite-1.0.0-1.x86_64.rpm` | Fedora/RHEL package. Self-contained, same engine inside. |
| `nekowite_1.0.0_amd64.AppImage` | AppImage. Self-contained, same engine inside. |
| `superseded/` | Previous generations, moved aside by the packager's publication step. Not a distribution artefact. |

**`nekowite_1.0.0_x64` and `opencode` must be copied together, always.** The engine is resolved from
the directory of `current_exe()` — the application does not search `PATH`. A user who copies only the
executable gets an app whose agent panel cannot start, with no explanation beyond the engine being
missing. `scripts/boot-probe.sh` enforces this by refusing to run at all unless
`$(dirname "$BIN")/opencode` exists.

**Architecture is x86_64 only, and that is a delivery decision rather than a gap.** The bundled
engine is `scripts/fetch-opencode-linux.sh`'s single pinned artefact
`opencode-linux-x64@1.18.29`, i.e. `x86_64-unknown-linux-gnu`, dynamically linked against glibc. On
arm64 the AppImage and the deb/rpm will not execute at all; on musl distributions the app starts and
the engine fails. Building from source on another architecture gives you an app of that architecture
and an engine that is still x86_64 — the mismatch only appears when an engine is started. `README.md`
says this at length and it is accurate.

### 4.5 The gate, exactly

CI is `.github/workflows/ci.yml`, two jobs:

```yaml
check:  pnpm install --frozen-lockfile → pnpm typecheck → pnpm lint → pnpm test → pnpm perf
        → pnpm --filter @nekowite/desktop build
        → pnpm --filter @nekowite/desktop check:export-css
        → playwright install --with-deps chromium → pnpm test:e2e
rust:   cargo test --locked → cargo build --locked → cargo clippy --all-targets --locked
        → cargo fmt --all --check        (all with working-directory: apps/desktop/src-tauri)
```

`AGENTS.md:69-74` lists only four of these (`typecheck`, `lint`, `test`, `build`) as "required Linux
verification before release". That list is incomplete — it omits `pnpm perf`, both e2e steps and
every Rust command. CI is the real list.

**Measured on 2026-09-21**, on a machine with load average around 20:

| Command | Result |
|---|---|
| `pnpm typecheck` | exit 0, 10 s |
| `pnpm lint` | exit 0, 20 s — **462 warnings, 0 errors** |
| `pnpm test` | exit 0, 74 s — editor-core 959 tests / 73 files, plugin-host 132 / 10, desktop 4774 / 400 |
| `pnpm perf` | exit 0, 9 s — 10 tests in 2 files |
| `pnpm build` | exit 0, 15 s |
| `pnpm --filter @nekowite/desktop check:export-css` | exit 0 — 60 embedded data: font assets, no external KaTeX font references |
| `cargo fmt --all --check` | exit 0, 1 s |
| `cargo test --locked` | **exit 101** — one failure after 5 of 73 integration targets had run, root-caused; see §9.1 and §9.1a |
| `pnpm --filter @nekowite/desktop e2e` | **exit 0, 3.3 min — 293 passed, 0 failed** |

**`pnpm lint` exits 0 with 462 warnings.** It is a gate that cannot fail on a warning, so
`docs/dev.md` §7.3 item 4 ("no new lint warnings") is a convention you enforce in review, not
something the tooling enforces for you. Do not read a green `pnpm lint` as "no new warnings".

### 4.6 The e2e suite today

The suite is 45 spec files under `apps/desktop/e2e/`, plus a WebKit-specific directory of driver
scripts that the Playwright run does not execute. It is the only thing in the repository that
exercises the app as a page: opening a vault, editing, saving, round-tripping fidelity, the pet's
windows, the agent panel's IPC surface, the CSP.

**Measured 2026-09-21: 293 tests passed, 0 failed, in 3.3 minutes, exit 0** — and that run was made
concurrently with `cargo test` on a machine at load average ~20. So the suite is more robust than its
30-second per-test timeout (`playwright.config.ts`) suggests, and "it failed, the machine must be
loaded" is not a safe first explanation.

That said, the timeout is real, and the way to tell the two apart is to re-run the spec alone:

```bash
pnpm --filter @nekowite/desktop e2e e2e/<spec>.spec.ts
```

A spec that fails alone, twice, is a real failure. A spec that failed only in a full run may be a
scheduling artefact — but say so with a measurement, not as a way of avoiding the finding.

---

## 5. Conventions that are enforced, or that you pay for

### 5.1 Tests live next to the code they test

`Foo.vue` → `Foo.test.ts` in the same directory. `services/thing.ts` → `services/thing.test.ts`.
There is no `__tests__` directory and no central test tree. `docs/dev.md` §5.9 says the same thing.
The consequence is that `find . -name "*.test.ts"` is the index of the test suite, and moving a
module means moving its test.

Fixtures for cross-module use go in `test/fixtures` (named in the doc; in practice they are usually
local to the spec that needs them).

Rust tests are the other way round, because Cargo requires it: unit tests in the module, and
integration tests as separate targets in `apps/desktop/src-tauri/tests/*.rs`. Each target is its own
program. `tests/module_tree_test.rs` is a structural test that asserts every `.rs` file under `src/`
is reachable from `src/lib.rs` or `src/main.rs` — see §7.

### 5.2 The comment style is deliberate, not verbosity

This is the house style and it will look wrong to you for about a week. Comments in this repository
are long, they explain **why**, and they frequently name the failure that the code exists to
prevent, the measurement that established it, and the alternative that was rejected. Module headers
run to thirty lines. Look at `apps/desktop/src-tauri/tests/main_window_close_pet_test.rs` (fifty
lines of header) or `desktop_pet/` for the fully-developed form.

`docs/dev.md` §6 states the rules: explain why rather than what; state security boundaries at the
point of enforcement; record complexity and its trade-off rather than the word "optimised"; put the
upper bound, the user-visible signal, and the invalidation condition next to any truncation, cache or
concurrency limit. What it forbids is comments that restate the next line.

Two consequences worth knowing before you edit:

- **Do not shorten these comments to tidy a diff.** The maintainer's instruction is explicit: "注意
  代码体积" concerns the *code*; "优化注释" means making a comment more accurate, not shorter.
- **A stale comment is treated as a defect here**, not as cosmetic. Several of the findings in §10
  are stale comments rather than stale prose. When you change behaviour, the comment above it is
  part of the change.

### 5.3 Commits go directly to `main`

No feature branches, no pull requests. The maintainer's instruction. Commits are small and
single-purpose, prefixed `feat:` / `fix:` / `refactor:` / `test:` / `docs:` / `perf:` / `tool:`
(`AGENTS.md:81`). Commit subjects in this repository are written as sentences describing what
changed and why, not as labels.

**No attribution lines.** No `Co-Authored-By`, no "Generated with" footer, no mention of the tool or
model that wrote the commit. This overrides any default your tooling applies.

The tree is shared. `git add` only the files you touched — never `git add -A` — and never rewrite
`HEAD` while someone else may be committing.

### 5.4 Every user-visible string is in two languages, and a test enforces it

The interface is Chinese. Messages live in `apps/desktop/src/i18n/` — `zh.ts`, `en.ts` and a
`namespaces/` directory — and `apps/desktop/src/i18n/i18n.test.ts` checks the two dictionaries
against each other **and against the source**, in both directions: a key that is used but not
defined, and a key that is defined but never used, are each a failure.

The rule that constrains how you write code:

- **Keys must be literal strings.** The test walks the source for quoted strings that could be a key
  — `t('…')` arguments, and the literal key tables the app keeps (`COMMAND_KEYS`, `KIND_KEYS`,
  `LABEL_KEYS`) whose values are handed to `t()` later. A key assembled by string concatenation is
  invisible to that walk, so it cannot be checked. The one tolerated form is a **prefix** used as
  `t(\`head${…}\`)`, which the test collects as `prefixes`.
- This is a trap that has already been sprung: a dynamically-built key table was caught by this test,
  and the fix was to spell the keys as literals.

If you add a user-visible string, add it to both dictionaries, and use it literally. `pnpm test` will
tell you if you did not.

### 5.5 The comment and doc boundary for subagents

`AGENTS.md` is the repository-level rule set and it is read-only by the maintainer's instruction.
The rule that constrains how you work: `AGENTS.md:91` forbids subagents from modifying
`AGENTS.md`, `docs/development/DEVELOPMENT-ROADMAP.md`, design specs or implementation plans; and
`AGENTS.md:85` says architecture and migration documentation is updated only through the primary
agent. If you use automated agents on this repository, hold that boundary — it exists because
implementation agents overwrote specifications.

---

## 6. Traps

These are the ones that have actually cost time. Each is real, and each has a file you can read.

### 6.1 `cargo build --release` poisons `target/release/nekowite`

`cargo build --release` overwrites `apps/desktop/src-tauri/target/release/nekowite` with a binary
that expects a dev server at `localhost:1420`. Only `tauri build` produces the real packaged
binary. The process-level tests in `apps/desktop/src-tauri/tests/` pick up whatever is at that path
(see `app_under_test()` in `agent_exit_teardown_test.rs`), so after a plain `cargo build --release`
they fail **for a reason that is not the application**. This has cost the most time of anything in
this list.

If a process-level test fails in a way that looks like the app is broken, rebuild with
`pnpm --filter @nekowite/desktop exec tauri build --no-bundle` (or `pnpm package:linux`) before
believing it.

### 6.2 A single quote inside `bash -c '…'` truncates the command

The login shell is fish; wrap shell work as `bash -c '…'`. An apostrophe inside that string ends it
early. This destroyed two commit messages in one session. **Write the message to a file and use
`git commit -F`.**

### 6.3 `pkill -f <pattern>` matches the shell running it

It matched four times in one session. Do not use it to clean up processes; use a recorded pid, or a
process group (`setsid` + `kill -- -PID`, the way `scripts/boot-probe.sh` does it).

### 6.4 `| head` and `| tail` truncate silently

Two conclusions in one session were drawn from a truncated view and were wrong. If a command's
verdict matters, read the whole output or count it (`grep -c`, `wc -l`), do not eyeball a tail.

### 6.5 The tests must build under the project's own `target/` directory

Do not redirect `CARGO_TARGET_DIR` to `/tmp` (tmpfs) or to a cache directory under `$HOME`. One
cache directory of this kind reached roughly 470 GB. The shared target directory is
`apps/desktop/src-tauri/target`. The cost is that concurrent builds queue on the same lock, which is
preferable to the alternative.

### 6.6 The machine

Load average of 17–40 has been normal — this is a shared workstation, not a dedicated builder. Two
consequences, both observed:

- The e2e suite times out at 30 s per spec (§4.6).
- At least one Rust test is load-sensitive (§9.1).

When a timing-sensitive test fails, measure the load before you change the test.

### 6.7 A "green" reading is not a reading of production

The recurring failure mode in this repository has its own name internally: **built but unreachable**.
A feature with a design, an implementation and a passing test, and no production caller. It has been
found five separate times — a component covered by a spec and mounted by no page
(`AgentCommandMenu.vue`), a function whose only caller was its own test (`retargetSvgInsertion`), a
Rust module declared by nothing (`agent_runtime/recovery.rs`), a stderr log built inside a
`tokio::spawn` argument list so nothing outside the task held it, and a settings default that kept a
finished surface hidden from every user (`AGENT_PANEL_DEFAULT`).

The instruments in §7 exist because of this. **Acceptance in this repository means "reachable from
the real window", not "covered by a test".**

---

## 7. The instruments — and how each has been wrong

This repository has four scripts and two test targets that exist specifically to answer questions a
normal test suite cannot. You should know what each one answers, and you should know that **every
one of them was wrong before it was right.** That history is why they are trusted, and it is also
why a green reading from one of them is a claim to spot-check rather than a fact.

### 7.1 `scripts/check-reachability.py` — is this module reachable from a page?

Walks the real import graph from the three Vite entries, following static imports, side-effect
imports, re-exports, dynamic `import()` and `new Worker(new URL(...))`, through relative and `/src/`
specifiers. Spec files are never followed *from*: a test that imports a module does not make that
module reachable.

Answers: *does a page ever load this module?*

Output today: 739 of 1223 source files walked; the unreachable list is 505 files, and that number is
mostly specs, `vitest.config.ts` files and testkits — i.e. mostly expected. The finding it exists for
is a non-spec module in that list.

Controls print first and must all read `True`. **If a control reads `False` the run is blind, not
clean** — say so rather than reporting the orphan list.

How it has lied: it once resolved no bare specifier at all and reported all of `packages/` dead; and
it once counted a test's import as an import, reporting `AgentCommandMenu.vue` as reachable when the
only thing importing it was its own spec.

### 7.2 `scripts/check-dead-exports.py` — is this exported function called by anything?

The question one level below reachability. A module can be imported by a page and still export a
function that only its own spec calls. It reports only exports that are named **nowhere else,
including their own file** — an export used three lines below its declaration is the ordinary
"exported so the spec can reach it" idiom and is not reported. Types and interfaces are excluded
(a type is a contract; `import type` leaves no runtime caller to find).

Answers: *does this function have a user?*

Output today: **86 of 1326 exported functions**; a further 122 are called inside their own file and
suppressed.

How it has lied: the first version asked the wrong question and reported **846** hits, almost all of
them the ordinary idiom. Reading that list as noise is what let the real cases sit inside it. Its
positive control also went red when `retargetSvgInsertion` gained a caller — which is the control
working.

### 7.3 `scripts/check-channels.py` — does anything on the page listen to what Rust emits?

Every event channel the Rust side emits must have a listener on a page that receives it. Nothing
fails when it does not: the emit returns `Ok(())`, the send succeeds, and the feature is silent.

Answers: *is this backend-to-frontend channel wired?*

Output today: 21 channels emitted by Rust, **0 unwired**; and 1 of 8 listened channels has no Rust
emitter (`tauri-event-adapter.ts` — a generic name, checked by hand and not a defect).

The check is deliberately coarse: a channel counts as wired if its name string appears anywhere in a
frontend file, which over-counts. Over-counting is the right error direction, because the finding it
looks for is a whole channel nobody named. A hit is verified by hand before being reported broken.

How it has lied: it first reported "0 of 0 listened channels", because the pattern required a
`…CHANNEL`-shaped constant name where the app passes constants like `OPEN_FILE_EVENT`; and it once
read `MAIN_WINDOW` — a window *label*, i.e. an address — as a channel.

### 7.4 `scripts/boot-probe.sh` — does the packaged artefact survive startup?

Starts the packaged binary under `xvfb-run` inside a `dbus-run-session`, with `XDG_*` pointed at a
scratch tree so the probe cannot touch your real configuration, a private session bus so it cannot
activate a running instance, and a `setsid` process group so cleanup can kill exactly its own
processes. `PASS` means the process was still alive at the deadline.

Answers: *does this binary get past startup without dying?* It says so itself: "a process-survival
probe, not proof that the window rendered or editing works."

```bash
bash scripts/boot-probe.sh                  # uses release/nekowite_<version>_x64
BIN=/path/to/binary BUDGET=60 bash scripts/boot-probe.sh
```

It refuses to run if the engine is not beside the binary. It is a **manual instrument** — nothing in
CI or in `scripts/package-linux.sh` calls it; its only caller is `scripts/boot-probe.test.sh`, which
tests the probe itself.

**It passes today** (measured 2026-09-21, `BUDGET=20`): `PASS: process stayed alive until the
deadline; rendering is not verified`. That is also the one positive check the packaged portable pair
has — `release/nekowite_1.0.0_x64` and `release/opencode` together, from `release/`, not from the
build tree.

How it has lied: it first left an instance behind, and the next run measured *that* instance instead
of the app. Hence the private bus and the process group.

### 7.5 The two process-level tests

`apps/desktop/src-tauri/tests/agent_exit_teardown_test.rs` and
`apps/desktop/src-tauri/tests/main_window_close_pet_test.rs` drive the **real packaged binary** on a
private X server: a real vault, a real engine started by clicking the app's own rail toggle, a real
quit through the app's own close button, and the pids read off the process table afterwards.

They are written to `app_under_test()` — the packaged binary of this tree, not a `cargo build`
artefact (§6.1) — and they skip rather than fail when this tree has no packaged build.

Their headers are the best documentation of the agent and pet lifecycles in the repository. Read
`main_window_close_pet_test.rs` before touching `main_window.rs`.

Two things their headers establish that are easy to get wrong: `xdotool windowclose` is
`X_DestroyWindow` and kills the app through GDK's X error handler rather than through the event loop;
and `windowquit` sends `_NET_CLOSE_WINDOW` to the root window, which does nothing under Xvfb. The
tests click the app's own close button because that is the gesture a user makes and the only one that
reaches `RunEvent::Exit`.

What they do **not** cover, stated by the tests themselves: no window manager, no model, no
credentials, and — on the teardown test — the engine is started and its session opened but nothing is
ever asked of it. A run in flight, and the tool subprocesses the group kill exists for, are states
neither test puts the engine in.

Both tests were measured **both ways** — with the change under test and with a build of the same tree
minus that change, driven by the `NEKOWITE_EXIT_APP` environment variable. That is what makes them
readings rather than rituals, and it is the standard to hold new ones to.

### 7.6 `apps/desktop/src-tauri/tests/module_tree_test.rs`

Every `.rs` file under `src/` must be reachable from `src/lib.rs` or `src/main.rs` by replaying
rustc's own `mod name;` resolution. It exists because `src/agent_runtime/recovery.rs` — 317 lines,
13 green tests — sat in the tree declared by nothing: `cargo build` and `cargo test` both passed
without it, because a test target's `#[path]` include kept it compiling. It was in no library and in
no binary, and its tests were green about code the application did not contain.

There is deliberately no list of files or modules inside it to fall out of date. A `#[path]` include
in a *test target* is not a declaration; only declarations written under `src/` are followed.

**This test is why "CI is green" means something about module drift.** If you add a module and
nothing is red, check that you actually declared it.

---

## 8. What this round changed, and which decisions will surprise you

The ten commits of 2026-09-21 are in `git log`. What follows is not a changelog — it is the part a
team inheriting this repository would otherwise have to rediscover, in the order the surprises are
likely to hit.

### 8.1 The agent panel is on by default, and it was off before 2026-09-19

`AGENT_PANEL_DEFAULT` in `apps/desktop/src/stores/settings-agent.ts:87` is `true`. It was `false`.

The maintainer's report was 「AI 界面没有 / 命令提示」 — the `/` command menu existed, was mounted by
the panel, and was covered end to end by `e2e/agent-command-menu.spec.ts`, but the rail drew
`ChatPanel` for anyone who had never touched a switch, and the chat panel has no `/` menu at all.

**What will surprise you:** an installation that never touched the switch has no stored value, so it
follows the new default and the interface changes under the user. An installation that *did* toggle
it keeps its stored choice — the stored value records a choice, and silence is not one. The rollback
is one click, it persists, and it is the `@use-chat` event in `AppShell.vue`.

### 8.2 A dead engine used to wedge its own claim

`registry.claim()` inserts an epoch *before* the process exists; `release()` is reached only through
`AgentInstance::Drop`; and the supervisor waited only for a stop signal. So an engine that exited on
its own was never reaped and nothing noticed. The user-visible symptom was
`an engine for opencode is already running in this vault (epoch-…)` **with no engine running**, and
no way out of it from the interface. This is the bug the maintainer actually hit. Fixed in `384b511`
by collecting a self-exited child and by letting go of an instance whose engine is gone, checked at
`start_session`.

**What will surprise you:** the fix is not in the stop path. If you touch session lifecycle, read
`agent_runtime/`'s registry and supervisor together.

### 8.3 `App::run` exits through `std::process::exit`, so destructors never run

Tauri's `App::run` ends with `std::process::exit` (`tauri-2.11.5/src/app.rs:1346`), which does not
run destructors. The managed `AgentRuntimeState` was therefore never dropped on the quit path, and
`AgentInstance::Drop` never ran.

**What will surprise you:** the first claim made about this — "it leaks an engine" — was **wrong**,
and the test that was written to demonstrate it disproved it instead. The engine exits by itself when
its stdin closes, so it was gone either way (measured: 1.00–1.60 s with the fix, 0.80–1.00 s
without; the distributions overlap). What the missing destructor actually cost was the registration
and the reaping — which is §8.2. The test was kept, and rewritten to say what it does measure.
If you inherit one habit from this repository, inherit this one: when a measurement contradicts the
reason you wrote the code, rewrite the claim, not the measurement.

### 8.4 Closing the main window now takes the pet — and the process — with it

When the pet is on, its windows keep the wry runtime's window map non-empty, so closing the main
window left the process alive with nothing on screen: still holding the single-instance D-Bus name,
still running the engine and the watchers. That was the maintainer's report
(「我发现软件退出的时候桌宠没有退出，要一起退出的」), fixed in `e326a8b`.

**What will surprise you:** the state the previous paragraph describes is still reachable on purpose.
`main_window.rs` exists because the main window is *destroyed* when the user closes it and the process
may not end with it — a second launch has to raise a window that is not there, by building it again
from `tauri.conf.json`'s own entry. That is `main_window::raise`. It is load-bearing for the
single-instance plugin and for the pet's settings shortcut.

### 8.5 `docs/dev.md:636`'s e2e command does not run

`docs/dev.md` §7.1 tells you to run `pnpm --filter desktop test:e2e`. The workspace package is
`@nekowite/desktop` and its script is `e2e`. Run as written:

```
[ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT] None of the selected packages has a "test:e2e" script
```

The command in §4.2 is the one that works. This is corrected in `docs/dev.md` (see §10.1) — it is
listed here because you will meet it in the doc's gate list before you read §4.

### 8.6 The packager no longer depends on a file the bundler stopped writing

`scripts/package-linux.sh` used to require `target/release/opencode`. On 2026-09-21 that file
stopped appearing while the bundler was still producing three correct bundles, each carrying
`usr/bin/opencode`. The step was measuring the wrong thing. The engine is now staged from
`binaries/opencode-x86_64-unknown-linux-gnu` — the pinned artefact step `[1/7]` already verifies —
and the comparison against `target/release/opencode` still runs when that file exists. Fixed in
`273a8fa`.

**What will surprise you — and it bites the test suite, not the package.** The fix removed the side
effect that used to leave a copy of the engine at `target/release/opencode`, which is the directory
the process-level tests launch the app from. Nothing asserts that the engine is there, so the tests
did not go red at the moment the guarantee was lost; one of them (see §9.1) has been quietly timing
out ever since. This class of failure is invisible to unit tests and shows up either at packaging
time or as a 60-second timeout in a suite nobody re-ran. The comment in the script explains the
staging decision at length; read it before changing the step, and check what else depended on the
file you are no longer writing.

### 8.7 Wiring a function that had no caller exposed a specification violation

`retargetSvgInsertion` had no production caller. Wiring it up exposed that `docs/dev.md` §7.3 item 5
requires re-confirming an insertion after the reader switches notes — and that before the fix,
switching notes and confirming put the image **into the new note** while telling the reader it went
into the first. Fixed in `116fa61`. The refusal belongs to the surface, because only the surface
knows which note the proposal was made for.

**What will surprise you:** this is the "built but unreachable" pattern (§6.7) caught in the act, and
it was caught by `scripts/check-dead-exports.py`. The pattern is systematic here, not incidental.

---

## 9. What is not done

Read this section as a work list with owners missing. **Do not present any of it as finished.** Each
item states what it is, why it is in that state, and what a first step looks like.

### 9.1 `cargo test` is red today: one test, and the cause is a missing file in the build directory

**What it is.** `a_graceful_quit_takes_the_engine_with_it` in
`apps/desktop/src-tauri/tests/agent_exit_teardown_test.rs` fails. The failure is a timeout:

```
t+1.2s: the main window is up (1280x820 at 160,90); 2 window(s) in all
t+2.0s: the vault is open and registered; the pet is off, so the main window is the last one
timed out waiting for the engine to start
```

**This was investigated on 2026-09-21 and the cause is established.** It is a test-environment
failure, not a defect in the application.

- The test fails **when run alone**, twice, at load average 28 and again lower. It is not a load
  artefact, and it is not the previously-known load-sensitive test
  (`an_engine_that_dies_the_moment_it_starts_still_gets_to_say_why`, which passed in the same full
  run).
- `app_under_test()` drives `apps/desktop/src-tauri/target/release/nekowite`. The app resolves the
  engine from the directory of the running executable (`state/app_state.rs`'s `executable_dir()` →
  `program_to_launch` → `binary_registry::bundled_program`) and **never searches `PATH`**.
- **`target/release/opencode` does not exist**, so the start is refused and no engine ever appears.
- **Controlled test:** copying `apps/desktop/src-tauri/binaries/opencode-x86_64-unknown-linux-gnu`
  to `target/release/opencode` turned the test green immediately — engine up at t+3.2 s, app gone at
  t+4.9 s, engine gone 0.00 s after the app, 7.93 s total, exit 0. Removing the copy makes it fail
  again. Three failures without the file, one pass with it.

**Why it is in that state.** Commit `273a8fa` (the same day) correctly changed
`scripts/package-linux.sh` to stage the engine from the verified input
(`binary_registry`'s `binaries/opencode-<triple>`) rather than from `target/release/opencode`, because
`tauri build` had stopped writing that file while still producing three correct bundles. That fix was
right for the produced artefacts. What it also did — silently — was take away the side effect that
used to leave an engine beside the binary this test drives. No test asserted that the engine was
there, so nothing turned red at the moment the guarantee was lost.

**Also worth knowing:** `target/release/nekowite` right now *is* the real packaged binary
(same 36,891,600 bytes and same timestamp as `release/nekowite_1.0.0_x64`), so this is **not** the
`cargo build --release` trap of §6.1. It is a genuinely packaged app that cannot find its engine.

**The fix is a decision, and either answer is defensible:**

1. Make the test stage the engine itself — the test already writes its own scratch `XDG_*` tree and
   its own vault record, so placing the engine it depends on is in keeping with how it is written.
   This makes the suite self-contained.
2. Make the build step leave the engine beside the binary again — for example have
   `scripts/package-linux.sh` restore `target/release/opencode` after staging, since it is the same
   verified bytes it already compares against.

Option 1 is the smaller change and does not put 184 MB back into the build directory on every
package run. Whichever you choose, **add the assertion that was missing**: something that fails when
a test that needs an engine has no engine to find, rather than timing out for 60 seconds.

**First step:** re-run it yourself to see the current state, then apply one of the two.

```bash
cd apps/desktop/src-tauri
cargo test --locked --test agent_exit_teardown_test -- --nocapture
```

### 9.1a The consequence is larger than one test: `cargo test` runs five targets out of seventy-three

This is the part that matters more than the failure itself.

Cargo runs integration targets in alphabetical order and **stops at the first one that fails**.
`agent_exit_teardown_test` sorts fifth. So the `cargo test --locked` run of 2026-09-21 executed five
of the **73** integration targets in `apps/desktop/src-tauri/tests/` and then aborted:

```
agent_cancel_live_test      ok
agent_capabilities_test     ok
agent_change_recovery_test  ok
agent_event_contract_test   ok
agent_exit_teardown_test    FAILED   <- the whole run stops here
```

Everything after it in the alphabet did not run at all — `command_authorisation_test`,
`main_window_close_pet_test`, `fs_test`, `vault_auth_test`, `write_atomicity_test`, and roughly
sixty-five others. The "217 passed" line in that output is the **library unit tests**, not the
integration suite.

**So the honest statement of the Rust gate today is: five targets pass, one fails, and sixty-eight
have not been executed.** Nothing in the repository's documentation says this, and a green
`cargo test` badge after the fix in §9.1 will be taken to mean the suite passed.

Related: only two targets in the whole directory reference a packaged binary or an engine —
`agent_exit_teardown_test.rs` and `main_window_close_pet_test.rs` — and only the first starts an
engine. So the missing-engine problem is specific to that file; the sixty-eight unrun targets are
unaffected by it and are unrun purely because of the ordering.

**First step:** after fixing §9.1, run the suite with `--no-fail-fast` so one failure cannot hide the
rest:

```bash
cd apps/desktop/src-tauri
cargo test --locked --no-fail-fast
```

### 9.2 86 exported functions nothing calls

**What it is.** `python3 scripts/check-dead-exports.py` reports 86 of 1326. Most are the legitimate
"exported so the spec can reach it" idiom — an export whose only reader is its own test is not
automatically wrong.

**Three are confirmed superseded and were deliberately left in place:**

- `packages/editor-core`'s `buildLinkGraph` and `findBrokenLinks` in `link-graph.ts` — the live
  `buildLinkGraphDetailed` contains both.
- `apps/desktop/src/platform/.../tauri-pet.ts`'s `createTauriPetGateway` — a one-line alias.

**Why they are still there.** Removing them cascades: `extractLinks` and `resolveLinkPath` have
module-internal readers that must be checked first. This was judged too large for the session that
found them, not impossible.

**One reported item is a false positive.** `createMemoryPetGateway` is called by five e2e specs; the
script does not follow into `e2e/`.

**First step:** take the two `link-graph.ts` exports, check their module-internal readers, and remove
them with the reader change in the same commit. Re-run the instrument afterwards — its control will
tell you whether it still works.

### 9.3 `desktop_pet/task_feed.rs` is 608 lines, over the documented 600-line backlog threshold

**What it is.** `apps/desktop/src-tauri/src/desktop_pet/task_feed.rs` exceeds the line at which
`docs/dev.md:286` says a file "should by default enter the split backlog".

**Why it is like that.** It was judged **not** to split. `docs/dev.md:288` states the actual
criterion: the number of *reasons to change*, not the line count. Those 608 lines are one indivisible
rule.

**First step:** none, unless you need to change that rule — in which case read the two `docs/dev.md`
lines above first, because they are the argument for leaving it alone.

### 9.4 `main_window::raise`'s rebuild path has no test, and seven comments point at a deleted file

**What it is.** Commit `e326a8b` deleted `apps/desktop/src-tauri/tests/main_window_relaunch_test.rs`
along with the state it measured. The rebuild path inside `main_window::raise` — building the main
window again from `tauri.conf.json` after it was destroyed — now survives for the window of time
between a window's destruction and the process leaving, and nothing drives it.

**The stale references are a real defect.** Seven doc-comments still name the deleted file:

```
apps/desktop/src-tauri/tests/main_window_close_pet_test.rs:60, :65
apps/desktop/src-tauri/tests/main_window_test.rs:13
apps/desktop/src-tauri/tests/agent_exit_teardown_test.rs:30, :36, :131, :675
```

`main_window_test.rs:13` is the most misleading of the seven: it tells the reader that the real
two-process handoff "is `main_window_relaunch_test.rs`, which drives two real processes and skips
when this tree has no packaged build to drive". That file does not exist.

**First step:** decide which you want. Either restore a two-process test for the raise handoff
(`main_window_close_pet_test.rs` is the template, and its header names exactly what the old test
asserted), or edit the seven comments to say the path is untested. Do not leave them as they are —
this is the same shape as the defects the instruments in §7 were written to catch.

### 9.5 The 24-hour unread-reminder bound is a product decision, not a bug

`UNREAD_MAX_AGE_MS` in the pet's reminder code bounds how old an unread reminder may be and still be
shown. The maintainer's own ledger loses rows to it. The application now says so accurately, which
was the fix. **It is listed here so you do not file it as a defect.** If the product should keep
older reminders, that is a product change with a user-visible consequence.

### 9.6 The desktop pet and the agent panel are undocumented as product features

See §10.5 for the evidence. Neither appears in `README.md`, `docs/USER-GUIDE.md` or `CHANGELOG.md`,
and both ship in every bundle. **First step:** decide whether they are features. If they are, they
need a user-guide section and a changelog entry; if they are experiments, they should not be in the
release artefacts. Right now the repository does neither, and the ambiguity will outlive everyone who
remembers why.

### 9.7 Known but unverified, stated as such

- **WebKitGTK version.** The product engine is WebKitGTK 4.1. The instrumented runs that drive the
  real app use `xvfb-run` with `GDK_BACKEND=x11`, because window geometry does not take effect under
  KWin. One measurement caveat is recorded internally and has not been re-checked: a driver binary
  used in some runs was compiled against WebKit 6.0 rather than 4.1, so a "measured in WebKit" pixel
  reading from that route may be a 6.0 reading. **Treat pixel-level WebKit claims from before
  2026-09-21 as unverified.**
- **Interactive workflows under a window manager.** Every automated reading of the app runs under
  Xvfb with no compositor. Window-manager behaviour — focus, close, tiling, the pet's always-on-top —
  is verified by hand at best.
- **Distribution compatibility.** `scripts/package-linux.sh` says so itself: it "does not verify
  distribution compatibility or interactive workflows". The bundles are checked for content and
  notices, not installed and launched on a clean distribution.

### 9.8 Everything the repository's own audits list as open

`docs/audits/2026-09-15-linux-audit.md` and `docs/audits/2026-09-16-opencode-acp-p0.md` each carry a
"still open" section. **Do not treat those rows as a work list without re-checking them.** Their
rows go stale within a day — one was falsified five times in a single day — and a stale row
frequently hides a live defect pointing the other way. Verify a row against the code as an
assertion before you act on it.

---

## 10. Documents: what to trust, and what is wrong

The documentation tree is large and uneven. Some of it is old and correct; some of it is confidently
wrong. **Where a document and the code disagree, the code wins**, and the disagreement itself is
worth a sentence in whatever you write next.

**If you read only two parts of this section, read §10.9 and §10.10.** They are not filing errors.
One is a privacy promise the application does not keep, and the other is a security document that
describes a gate which never runs. Both are user-visible claims that a team will repeat in good
faith unless someone tells them not to.

### 10.1 The file-size budget — four numbers, and only one of them is in force

This is the longest-standing doc/code disagreement in the repository. **The rule actually in force is
600 lines for business source files and 800 for tests.** Nothing enforces it: no lint rule, no
script, no CI step checks a line count. It is a written convention enforced in review.

Where the other numbers live, exactly. This is the complete census — every place in the repository
that states a line budget:

| Location | What it says |
|---|---|
| `AGENTS.md:32` | "Keep business source files under **500** lines. At **300** lines, plan a split; at **400** lines, split in the current change; at **500** lines, stop adding code." |
| `AGENTS.md:33` | "Tests may be larger, but split them by behavior domain when they exceed **800** lines." |
| `docs/development/DEVELOPMENT-ROADMAP.md:612` | §13's own heading: 「**500 行上限**下的解耦方案」. |
| `docs/development/DEVELOPMENT-ROADMAP.md:614` | §13.1 「行数预算」. |
| `docs/development/DEVELOPMENT-ROADMAP.md:616` | Business files **500**, target **300–400**; tests **800**. Same text as `AGENTS.md:32-33`. |
| `docs/development/DEVELOPMENT-ROADMAP.md:621-624` | The tiering spelled out as four bullets: 300 plan, 400 split in this commit, 500 stop, 800 tests. |
| `docs/development/DEVELOPMENT-ROADMAP.md:787, :789` | §13.12 「500 行例外规则」 — generated code, protocol mappings, static data and single-algorithm parsers may exceed **500**; business components, stores, commands, services and providers may not. |
| `docs/superpowers/plans/2026-09-16-desktop-pet-port.md:20` | 「业务文件 **300** 行规划拆分、**400** 行执行拆分、**500** 行停止追加；测试超过 **800** 行按行为域拆分」. |
| `docs/superpowers/plans/2026-09-16-desktop-pet-port.md:445` | 「业务文件遵守 **300/400/500** 行规则」. |
| `docs/superpowers/plans/2026-09-16-opencode-acp-integration.md:553` | 「单个业务文件 **300** 行规划拆分、**400** 行在当前改动拆分、**500** 行不再追加；测试超过 **800** 行」. |
| `docs/superpowers/plans/2026-09-16-opencode-acp-integration.md:623` | 「业务文件 **300** 行规划拆分、**400** 行执行拆分、**500** 行停止追加」. |
| `docs/dev.md:286` | 「文件超过 **400** 行且没有明显的单一领域边界；超过 **600** 行应默认进入拆分 backlog」. |
| `docs/dev.md:288` | The criterion that actually governs: the number of *reasons to change*, not the line count. A 500-line file containing one pure domain algorithm may stay; a 200-line file spanning UI, platform and security should not. |
| `docs/dev.md:469` | A completion metric: 「超过 **600** 行的业务文件 … 每个都有拆分 issue 或明确保留理由」. |
| `docs/dev.md:505` | 「一个文件只提供一个主要公共概念；超过约 **300** 行应解释原因或拆分」. |

**Nothing enforces any of these.** There is no `max-lines` rule in `eslint.config.js`, no line-count
check in `scripts/`, and no CI step that counts lines. It is a written convention, applied in review.
The check that follows from that: **a file over the budget will never turn anything red**, so a green
gate tells you nothing about it.

`README.md` and `CONTRIBUTING.md` state no line budget at all, so a reader who only reads those is
not misled.

**Why this matters to you:** `AGENTS.md` and everything under `docs/development/` are read-only by
the maintainer's instruction, so this disagreement cannot be fixed by editing them. You will meet
`AGENTS.md:32` in your first hour and it will tell you a file of 550 lines is over budget. It is not.
The number in force is 600, and `docs/dev.md:286` is the line that states it.

The reason the budget moved — 300/400/500 → 600 — is recorded here rather than in those files
because those files cannot be edited: the maintainer relaxed the business-file ceiling to 600 on
2026-09-17 and left the test ceiling at 800.

### 10.2 `docs/dev.md` instructions that do not run

- **`docs/dev.md:636`** — `pnpm --filter desktop test:e2e`. The package is `@nekowite/desktop` and
  the script is `e2e`; as written this fails with
  `[ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT]`. Corrected in the file, with the reason in the commit.
- **`docs/dev.md` §7.1's gate list omits `pnpm perf` and every Rust command.** It lists
  `typecheck`, `lint`, `test`, `build`, `cargo test`, and the e2e command. `pnpm perf` is a separate
  vitest project that `pnpm test` never reaches, and CI runs it. `.github/workflows/ci.yml` is the
  complete gate; §4.5 reproduces it.
- **`docs/dev.md` §5.5's Rust tree predates two subsystems.** It lists `commands/`, `domain/`,
  `storage/`, `providers/`, `errors.rs`, `state.rs` — and not `agent_runtime/`, `desktop_pet/`,
  `main_window.rs`, `instance_guard.rs` or `open_file.rs`. `lib.rs`'s header is current and points
  at this section, so the pointer leads to something incomplete.
- **`docs/dev.md` §5.5's frontend tree lists `shared/` and `test/`**, which do not exist.

### 10.3 `docs/RELEASING.md` is a Windows document, and the project is Linux-only

The file is titled 「发布流程（1.0，Windows）」 and §3's packaging commands are
`bash scripts/package-win.sh`, which is not the maintained path.

Two specific statements are wrong for this repository:

- **`docs/RELEASING.md:81`** — "macOS / Linux 构建: …仓库没有对应的 CI 与打包脚本" (there is no CI or
  packaging script for Linux). **There is**: `scripts/package-linux.sh`, invoked by
  `pnpm package:linux`, producing the deb, rpm, AppImage and portable binary that are in `release/`
  right now. §4.3 and §4.4 describe it.
- **`docs/RELEASING.md:15`** — says the version shown in the interface is hardcoded `v0.1.0` in
  `apps/desktop/src/ui/StatusBar.vue`. **It is not.** `StatusBar.vue` reads it from the build via
  `apps/desktop/src/platform/app-version.ts`, and its own comment records why ("a hardcoded string is
  a second source of truth, and this one still claimed v0.1.0 on a 1.0.0 build"). Corrected in the
  file, with the reason in the commit.

§2's gate list is also Windows-shaped (`cargo test --locked && cargo clippy … && cargo build
--locked` for Windows), and §7's "待决事项" includes "code-signing certificate" as a release
blocker, which is a Windows concern.

### 10.4 `docs/test-plan.md` is stale in two places

- **`docs/test-plan.md:4`** claims the lint gate is `pnpm -r lint`(0/0) — zero errors, zero warnings.
  Today it is **0 errors and 462 warnings**. Either the number was aspirational when written or the
  warnings accumulated; either way the parenthetical is not true and a green lint run does not mean
  what this line says it means.
- **`docs/test-plan.md:23`** points at 「docs/debug.md §4」. `docs/debug.md` has no headings at all —
  it is a 457-line prompt for a QA agent, written in indented prose. The cross-reference cannot be
  followed.

The file's coverage table is a useful starting inventory of what is tested where, and its "已知重点
复查" list is still a reasonable reading list. The status column is **empty for every row**, which is
itself the honest reading: nobody has filled it in.

### 10.5 The desktop pet and the agent panel are absent from every user-facing document

Verified by search across `README.md`, `docs/USER-GUIDE.md` and `CHANGELOG.md`: zero matches for
「桌宠」or `desktop-pet`; `CHANGELOG.md` has zero matches for `opencode`, `ACP` or `agent`.

Meanwhile the repository contains `docs/architecture/desktop-pet-port-ledger.md` (202 lines), an
`apps/desktop/src-tauri/src/desktop_pet/` module, twenty e2e specs, two Vite entries and a Tauri
capability file for it.

**`CHANGELOG.md` as a whole stops before both subsystems.** Its most recent commit is
`docs: stop the changelog announcing an API that no longer exists`, dated 2026-09-14, and its top
section is `## [Unreleased]`. Everything from 2026-09-16 onward — the ACP/agent work and the pet —
is unrecorded. If your team relies on the changelog to know what changed, it will not tell you about
the last three weeks.

### 10.6 Documents that are old and right

For balance, these were checked and hold up:

- `docs/PLUGIN_ISOLATION.md` — the account of why release builds do not load vault plugins matches
  the CSP configuration and the loader's gating.
- `docs/architecture/desktop-pet-port-ledger.md` and `docs/architecture/zed-port-ledger.md` — written
  as ledgers of decisions and their reasons, and worth reading before touching the pet or the agent
  runtime. Two caveats, both checked: each has stale rows (`docs/DOC-AUDIT.md` §5), and
  `docs/architecture/agent-dependencies.md` is the weakest of the three — its dependency table
  records an approved change that was never made.
- `README.md`'s architecture and packaging sections, including the x86_64-only paragraph in §「打包成
  单个可执行文件」, which is unusually precise about a delivery limitation.
- `apps/desktop/src-tauri/src/lib.rs` lines 1–26, and the module headers under
  `apps/desktop/src-tauri/src/agent_runtime/` and `src/desktop_pet/`. These are current.
- The header comments of the two process-level tests and of `module_tree_test.rs`. They state both
  what they prove and what they do not.

### 10.7 One stale comment in the build config

`apps/desktop/vite.config.ts`, above `rollupOptions`, says "Two pages, because §7.1 gives the pet a
window that is not a second application" and then lists **three** inputs. The three entries are
correct; the count is not.

### 10.9 `docs/PRIVACY.md` promises the app does not connect anywhere, and it does

**`docs/PRIVACY.md:68`** says 「除你自己配置的 AI 请求外，应用不会主动连接任何服务器」 — apart from the
AI requests you configured, the application does not connect to any server.

That is not true today. There are at least two endpoints the application reaches on its own, and
neither is the user's AI provider:

- **The pet's online character library.** `apps/desktop/src-tauri/src/desktop_pet/resources/remote.rs:53-54`
  sets `LIBRARY_ENDPOINT = Some("https://pets.thenightwatcher.online/manifest.json")`, and the browse
  surface fetches it on mount with no cache:
  `apps/desktop/src/features/desktop-pet-settings/components/PetCatalogueBrowser.vue:132` is
  `onMounted(() => void read())`.
- **The ACP agent registry.** `apps/desktop/src-tauri/src/commands/agent_catalogue.rs:44` sets
  `REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json"`. The
  comment above it is careful and correct — this is the schema's own published host, 30-second bound,
  and nothing about engine registration depends on the call succeeding. It is still an unprompted
  request to a third party.

Two further omissions from the same document:

- **`docs/PRIVACY.md:12` and `:7`** enumerate "the four AI actions" that produce network traffic and
  do not mention the agent engine at all. Starting an ACP session runs an external `opencode` process
  that has its own network access; that is the largest outbound capability in the product and the
  privacy document is silent about it.
- **`docs/PRIVACY.md:25` and `:58`** say that with the AI kill switch off, no AI request is sent —
  "not discarded, simply never sent". Review the model-list refresh path before repeating that:
  `features/settings/composables/use-ai-settings.ts`'s `refreshModels` reaches
  `stores/settings-ai.ts`'s `listModels` and then the `ai_complete`-adjacent command, and the other AI
  paths (`features/ai/services/ai-gate.ts`) are the ones that consult `isAiEnabled`
  (`services/ai-permissions.ts:82`). The switch is enforced on the paths that go through the gate;
  the refresh path does not visibly go through it. **This is a code question worth settling, not only
  a documentation one** — if it holds, the switch does not cover a request that carries the user's
  real API key.

`docs/PRIVACY.md:46` also says there is no interface for setting a master password. There is:
`features/settings/components/VaultKeySettings.vue`, mounted from `AiSettings.vue`, and that
component's own header comment names this line of the document as the thing it made obsolete.

**A separate, smaller thing in the same area:** `docs/PRIVACY.md:32` lists pasted or dropped images
under `attachments/`. They do not go there — `services/rename-asset.ts`'s `assetsDirForNote()` writes
a note-specific `<notename>_assets/` directory (or `.tmp/` while the note is unsaved), and
`attachment-library.ts` lists only the `ATTACHMENTS_DIR`. In this case the **code is right and the
document is wrong**, and the stale claim is repeated in the application's own copy:
`i18n/namespaces/attachments.ts` still tells the user the same thing.

### 10.10 `docs/SECURITY.md` describes a plugin gate that cannot run in any environment

`docs/SECURITY.md:9-25` is a table of guarantees headed "Enforced", and its preamble says each item
is verified by an automated test. The first group of items describes the plugin consent, integrity
and trust sequence.

**That sequence does not execute in a shipped build, and it does not execute in the browser demo
either.** The two guards are mutually exclusive:

- `apps/desktop/src/features/plugins/services/vault-plugin-load.ts:142` returns early when
  `isPluginImportAllowedByCsp()` is false. In the real Tauri webview the CSP is strict precisely
  because plugin loading is not isolated, so this is the production path — and the comment there says
  so, and says the gate is the deliberate reason the code below stays dormant.
- `apps/desktop/src/features/plugins/services/discovery.ts:133` is the first line of `importSource`:
  `if (!isTauriRuntime()) return Promise.reject(new Error('browser-demo: plugin execution
  disabled'))`.

So outside Tauri the import is refused, and inside Tauri the scan is skipped before it is reached.
`docs/PLUGIN_SDK.md:363`, which states that vault plugins "load in a plain-browser demo build", is
therefore wrong, and its §6 walkthrough (「在浏览器 demo 里本地加载示例插件」) cannot be performed.
The in-tree example plugin `examples/plugins/hello` is itself fine.

Because the gates are skipped, several other statements in the same document do not hold:

- **`docs/SECURITY.md:14-16`** — "the loader asks the user before activating any plugin declaring
  dangerous capabilities". There is no such dialog. `setPluginPermissionDecider` and
  `setPluginTrustDecider` are called only from tests; with no decider the default is **refuse**
  (`features/plugins/services/permissions.ts:89-90`).
- **`docs/SECURITY.md:55-56`** — a fresh native folder pick "auto-registers". It does not:
  `commands/fs.rs` only records the pick, and its own comment says registration deliberately does not
  happen there.
- **`docs/SECURITY.md:139`** — "Signed plugin provenance: no publisher signature / trust anchor"
  contradicts the next sentence and the code, which has an HMAC signature and calls it the trust
  anchor. The accurate statement is "no *asymmetric* publisher signature".
- **`docs/SECURITY.md:68-69`** — the API key crosses IPC "once". The window-to-Rust direction carries
  the plaintext key on every request; only the Rust-to-window direction returns a mask.

**And the document never mentions the agent engine at all** — which is the one place where this
repository has measured that a declared capability does not do what the declaration suggests.
`agent_runtime/fs_capability.rs` says it in its own words: the capability "is an opportunity the
engine may take, not a gate every write must pass", and `tests/agent_fs_write_refusal_test.rs`
records three runs on 2026-09-17 in which refusing the `fs` capability did **not** stop the engine
writing. `docs/SECURITY.md` opens by telling the reader to read it before assuming a capability is
protected, and omits the strongest evidence in the repository that one is not.

**Do not fix the document by enabling the loader.** The isolation is absent on purpose and the
settings UI already tells the user so (see §3.3 and `docs/PLUGIN_ISOLATION.md`). The fix is to make
the document say what is true: the gate is built, tested and dormant, and the reason it is dormant is
the reason the feature is off.

### 10.11 Other documents with stale paths and claims

Checked against the code on 2026-09-21; each is a reader pointed at something that is not there.

- **`docs/RECOVERY.md`** — `services/gateways/memory.test.ts` is at `platform/gateways/`;
  `stores/tabs.test.ts` does not exist (the cases live in `tab-recovery.test.ts`, `tab-save.test.ts`,
  `tab-persistence.test.ts`); `app/recoveryClosedLoop.ts` is `app/recovery-closed-loop.ts` (the
  repository's own naming rule is kebab-case, `AGENTS.md:45`); the symbol `relocatePendingAssets` does
  not exist (it is `relocate`); `ui/AppSidebar.vue` is at `features/sidebar/components/` and is not a
  test. Its §on window close describes `beforeunload` as the mechanism, but the real path is Tauri's
  `close-requested` in `app/app-lifecycle.ts`, which **can** await an async save — `beforeunload` is
  only a browser-demo fallback. A reader would conclude that closing the window cannot save.
- **`docs/A11Y.md`** — six camelCase paths that do not exist (`useFocusTrap.ts`,
  `useEditorFocus.ts`, `editorSearchOverlay.ts` and others; the files are kebab-case). More
  importantly, its account of `ConflictDialog`'s initial focus is **backwards**: the document and its
  quoted test describe focus moving to the first control, while `ConflictDialog.vue` deliberately
  focuses the dialog itself, and the test's title says why — the first focusable control is the
  destructive "use disk" action. The document describes the behaviour that was removed. Its
  `announce` wiring table also misses five live call sites.
- **`docs/PLUGIN_ISOLATION.md`** — presents the A/B/C sandbox routes as an open decision
  (「状态：未实现」). Route A has been chosen and shipped; `docs/USER-GUIDE.md`, `README.md` and the
  settings strings all describe it as the current behaviour. The document should say "A chosen, C is
  the 1.1 blueprint". Its file reference for the execution gate (`services/plugins.ts`) is now a
  17-line compatibility barrel; the implementation is under `features/plugins/services/`.
- **`docs/PERF.md`** — the budgets and their assertion in `perf/perf.bench.test.ts` were checked one
  by one and **match**. Two things are stale: `:228-229` offers skipping `pnpm perf` as an option
  "when CI is slow", and CI runs it unconditionally and calls it a gate; and `:234-236`'s regression
  counts (259 / 49 / 776) are from 2026-09-15 — the suite is now 73 / 10 / 400 files.
- **`docs/development-log.md`** — a historical log, and stale in ways that mislead if read as
  current: it names the branch `master` and `codex/`-prefixed feature branches (only `main` exists),
  a commit identity that is not the one in use, a `.npmrc` that does not exist, and Windows `.exe`
  artefacts. It also contradicts itself — `:562` and `:579` give different build artefact names. Treat
  it as an archive, not as a guide.
- **`docs/debug.md`** — a 457-line prompt for a QA agent, written in indented prose with no headings.
  It recommends Chrome DevTools and CDP for WebView verification and never mentions WebKitGTK, which
  is the engine that ships; the instruments that do exist (`apps/desktop/e2e/webkit/`,
  `scripts/boot-probe.sh`) are not named in it. `docs/test-plan.md`'s citation of 「docs/debug.md §4」
  cannot be followed, because there are no sections to cite.

### 10.12 A separate document audit

A fuller audit — every document in the tree, checked against the code, with the evidence for each
disagreement and a list of what could not be verified — is in `docs/DOC-AUDIT.md`.

---

## 11. Where to make your first change

Ordered by value to a team taking this over, not by difficulty.

1. **Pull, run the gate, and fix §9.1.** You cannot plan on a red `cargo test`. The cause is known
   and the fix is small; what matters is that you add the assertion that was missing, so the next
   time the engine goes missing from the build directory the suite says so instead of timing out.
2. **Decide what you are going to do about §10.9 and §10.10.** A privacy document that overstates
   what the app does, and a security document that describes a gate as working when it is dormant,
   are the two findings most likely to be repeated in good faith by someone who has not read the
   code. Settle whether the model-list refresh is really outside the AI kill switch; if it is, that
   is a defect, not a documentation problem.
3. **Decide what the pet and the agent panel are.** §9.6. This is a product question and it gates
   whether you document them or remove them from the bundles.
3. **Fix the seven stale references to `main_window_relaunch_test.rs`.** §9.4. Small, unambiguous,
   and it is the repository's characteristic defect.
4. **Bring `CHANGELOG.md` up to date** — or, if you are not going to maintain it, delete it. A
   changelog that stops three weeks before the handover is worse than none, because it reads as
   complete. §10.5.
5. **Read the two port ledgers** (`docs/architecture/desktop-pet-port-ledger.md`,
   `zed-port-ledger.md`). They are the fastest way to understand why the code is shaped this way, and
   they were written to be read by someone who was not there.
6. **Exercise the instruments in §7 yourself** before you trust them, starting with
   `scripts/check-reachability.py`. Every one of them has been wrong; running one and reading the
   output is how you find out whether it is currently right.

---

## Appendix: the commands, in one block

```bash
# everyday
pnpm install
pnpm typecheck
pnpm lint                       # exits 0 with warnings; see §4.5
pnpm test                       # 3 workspace projects: editor-core, plugin-host, desktop
pnpm perf                       # SEPARATE vitest project — pnpm test never reaches it
pnpm build

# the app
pnpm dev                        # browser preview, :1420
pnpm tauri dev                  # the real desktop app

# end to end (NOT bare `pnpm test:e2e` — see §4.2)
pnpm --filter @nekowite/desktop e2e
pnpm --filter @nekowite/desktop e2e e2e/<spec>.spec.ts     # one spec, alone

# rust — from inside apps/desktop/src-tauri
cd apps/desktop/src-tauri
cargo test --locked
cargo fmt --all --check
cargo clippy --all-targets --locked
cargo build --locked
cd -

# packaging (one invocation, all bundles — see §4.3)
pnpm package:linux

# instruments (manual — nothing in CI runs these)
python3 scripts/check-reachability.py
python3 scripts/check-dead-exports.py
python3 scripts/check-channels.py
bash scripts/boot-probe.sh
```
