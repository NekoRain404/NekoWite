# NekoWite Security Posture — M1 invariant audit

What NekoWite's security model **actually enforces** today, and what it **does not**.
Read this before assuming a capability is protected.

> **How to read the "Verified" notes (2026-09-22).** An automated test that asserts a
> rule proves the rule's implementation, not that the code path runs in the shipped app.
> The distinction matters for exactly one subsystem here, and it is the one this audit
> was written about: **the vault-plugin gates in §1 and the governance layer in §6 are
> implemented and unit-tested, and unreachable in the packaged application**, because
> §2's CSP makes the loader refuse the import before any of them is reached
> (`vault-plugin-load.ts:142-146` returns above every gate). Sections that are
> unreachable in production say so; the rest are enforced by code that runs.

## Enforced

### 1. Plugin execution is gated behind change-detection + consent

> **Reachability first (2026-09-22):** in the shipped Tauri build none of the gates in
> this section is reached. The loader checks the CSP rule before them and returns
> (`vault-plugin-load.ts:142-146`), and the tests that cover the gates stub the import
> boundary (`plugins.test.ts` passes `loadPlugin`; `plugins-declared-permissions.test.ts`
> passes `importSource`). So this section describes the plugin host's contract as
> implemented and tested, and §2 is what actually protects the packaged app today.

Vault plugins are **not executed** until two gates pass, both in phase 2 (the frontend
never imports a module in phase 1):

1. **Consent** — the loader asks the user before activating any plugin declaring
   dangerous capabilities (`fs`/`network`/`ai`). A denial skips the plugin's import
   entirely, so its code is never executed. The permission dialog **is wired into the
   production shell** (`App.vue:129` → `app-dialogs.ts:75` → `permissions.ts:90`), not
   only into tests. The *trust* decider is the one with no production caller
   (`trust-policy.ts:79`: no decider means DENY), which is the safe direction.
2. **Integrity / change detection** — the exact bytes the host would execute (the
   manifest text plus the loaded code) are fingerprinted in phase 1 *with no import*,
   then compared to the last-approved fingerprint. A mismatch prompts a re-approve /
   deny dialog; denial means the module is **never imported**, so its top-level side
   effects can never run. Re-approval records the new fingerprint as the new baseline.

The only place vault-plugin code is (potentially) executed is the blob-URL dynamic
import `import('blob:...')`, reached only after both gates and only via
`loadPlugin(meta, importer)`.

> ⚠️ **This is change DETECTION, not cryptographic authenticity.** The digest is a
> deterministic FNV-1a 32-bit hash. It is **not signed** and must never be presented
> as proof of provenance. It catches "this plugin changed since you approved it"; it
> does **not** prove "this plugin comes from a trusted publisher."

Built-in plugins (`callout`/`status`/`floatbox`) are first-party code bundled into the
app and activated at startup from static imports — they are not vault plugins and are
not subject to the vault-plugin gates.

### 2. Plugin loading is disabled under the strict production CSP

The production Tauri webview enforces a strict CSP
(`script-src 'self' 'wasm-unsafe-eval'` — no `blob:`, no `'unsafe-eval'`,
no `'unsafe-inline'` in `script-src`), which blocks the in-window `import('blob:...')`
that plugin loading relies on. Rather than failing every load with a CSP error, the
loader detects the Tauri runtime (`isPluginImportAllowedByCsp = !isTauriRuntime()`) and
refuses to attempt the in-window import, surfacing **one** user-visible notice per
session that vault plugins are disabled until the plugin host is moved behind real
isolation. No CSP is lowered to accommodate plugin loading. *(Verified: the CSP-gate
test asserts the whole scan is skipped, no fs read / no import happens, and the notice
fires exactly once per session; and on 2026-09-22 the CSP's own refusal was **measured on
WebKitGTK** — the engine the app embeds — by `apps/desktop/e2e/webkit/probe-csp-blob.mjs`.
The three readings: an inline script under this policy did not run (`inline-did-not-run`, so
the policy in the experiment is enforced and the rest is attributable to it); the blob module
import was refused with a CSP violation naming the directive and the URI
(`violations=script-src-elem<-blob`); and the identical page with **no** policy imported the
same blob successfully (`blob=allowed:blob-ran`) — which is what makes this the CSP's doing
rather than MiniBrowser's. Until that run the sentence above rested on a Chromium test, and
Chromium is not WebKitGTK.)*

### 3. IPC is bound to the vault the user actually opened

Path-confined Rust commands (`read_file`, `write_file`, `stat_file`, `list_dir`,
history/trash/attachment commands, `rename_entry`, `watch_folder`, …) call
`require_opened_vault` and reject any `vault_root` that was not vouched for. It is
vouched for in exactly two ways, and the second is deliberate:

1. the user picked the folder in the native dialog **this session** (`approve_pick`
   records it in `chosen`);
2. or it is the root the backend itself remembers as the last vault
   (`vault_confinement.rs:84-85`: `recalled` is accepted, and
   `vault_auth_test.rs` names that behaviour intentional).

Two details this section used to get wrong: a folder pick **registers nothing**
(`commands/fs/dialogs.rs:36` records the pick, and its own comment says registration
deliberately does not happen there — `approve_pick` writes `chosen`, not `opened`), and
the settings panel's path field is **read-only** on purpose (`GeneralSettings.vue:64`),
so "typed" was never one of the vault-open routes. Every vault-open path in the app —
native folder dialog, `localStorage` restore, settings panel — routes through
`applyVault` → `register_vault`, so a root is never served before the user opened it.
*(Verified: `VaultRegistry` + `app: vault_auth_test.rs` covers unregistered reject,
registered-authorize, the remembered-root acceptance, symlink canonicalization, and
relative-path reject.)*

### 4. The API key never leaves the vault as plaintext

`load_ai_key` returns only a fixed mask (`'••••••••'`) when a key is configured, and
`null` otherwise. The real key is read **only inside Rust**
(`load_ai_key_internal`) for AI requests. The frontend treats the mask strictly as a
presence indicator — `settings.ts` feeds an empty value into live state so `config()`
never sends the mask as a real key — and `store_ai_key` refuses to store the mask as if
it were a key. *(Verified: `settings.test.ts` mask-as-presence tests assert the live state
becomes `''` and `config().api_key` is `undefined` for both the mask and `null`.)*

> **One direction, not both (2026-09-22).** "The key crosses IPC once" is true for
> Rust→window, which is the direction the mask describes. It is **not** true for
> window→Rust: while the key field is non-empty, `config()` attaches the **plaintext**
> key to every request it builds (`stores/settings-ai.ts:252`), which is how a request
> reaches the provider at all. So the key is read back out of the window's own state on
> each request — never from Rust, and never displayed — but the sentence above would
> read as "one crossing per save", and that is not what happens.

### 5. Vault key protection uses Argon2id

When a master password is set, the Stronghold key is derived from the password with
**Argon2id** (OWASP parameters: 19 MiB, t=2, p=1) over a fresh per-vault salt. Only a
one-way verifier and the salt are persisted; the derived key is never written. A
password-protected vault must be unlocked (`unlock_vault`) before use.

### 6. Plugin governance (audit log, version policy/rollback, revocation, resource quota)

Beyond the trust/integrity gates, the host enforces a governance layer
(`packages/plugin-host/src/` — the `governance-*.ts` modules plus `audit-log.ts`,
`version-policy.ts`, `revocation.ts` and `mac-envelope.ts`, re-exported by `index.ts`,
plus the quota/unstable logic in `runtime.ts`):

> **Scope (2026-09-22):** these modules are implemented and unit-tested, and in the
> packaged app they are **not reached** — every gate below sits after the CSP return in
> §2, so the only governance machinery that actually runs in production is the
> once-per-session "plugins are disabled" notice and the audit-file setup that happens
> *before* that return (`vault-plugin-load.ts:107-114`, `:143-144`). Treat this section
> as the host's contract, ready for the day the host moves behind isolation — not as
> protection you have today.

- **Audit log** — every load/activate/deactivate/timeout/crash/revoke/signature-invalid
  decision is recorded to a structured, **non-secret** in-memory ring
  (`recordPluginEvent`), delivered to subscriber(s) via `onPluginEvent`, and
  **best-effort persisted to a vault-relative file** through the fs service when a
  writable file service is present. `detail` is defensively redacted (bearer tokens,
  provider API keys, ≥24-hex blobs, quoted key/token/secret values), so a secret is
  never written even if a caller mistakenly passes one. *(Verified: `governance.test.ts`
  — redaction, ring bound, subscriber isolation, file round-trip.)*
- **Revocation list** — a persisted list of revoked plugin ids+versions/ranges.
  A revoked plugin is refused **at load, before any import**, with the recorded
  reason. *(Verified: `security-regression.test.ts` — revoked plugin never reaches the
  import boundary; `governance.test.ts` — exact/range/'all' matching.)*
- **Trust/revocation/version/digest state is persisted in an integrity-checked
  file, NOT localStorage.** The trusted publisher key, trusted-source allowlist,
  plugin digests, revocations, and version policy are written to a single
  vault-relative JSON file (`.nekowite/plugin-governance.json`) wrapped in a
  **keyed HMAC-SHA256** envelope. On load the MAC is verified; a **failure
  refuses the contained trust** (reset / trust-nothing) and surfaces a notice —
  we never silently load attacker-controlled values. `localStorage` is retained only
  as a NON-authoritative "saw this notice" flag, never for trust data. *(Verified:
  `governance.test.ts` — MAC create/verify + tamper detection; `plugins.test.ts` — a
  tampered governance file refuses the trust it contains; `storage` is file-backed.)*
  > ⚠️ **Residual (honest):** there is **no OS keychain** exposed to the frontend, so
  > the HMAC key is a **per-install secret** persisted in a sibling file
  > (`.nekowite/plugin-governance.mackey`). This is **MAC-detection, not a secure
  > hardware root**: an attacker who can read BOTH the file and its key can recompute
  > the MAC. It stops a localStorage-only attacker and detects corruption/stale reads;
  > it is not proof against a party with full vault file access.
- **Version policy + rollback** — the host records the version+digest at load, refuses
  a version that is a recorded bad version or outside a configured min/max range, and
  exposes `rollbackPoint(pluginId)` = the last-known-good version+digest. **Rollback
  is BEST-EFFORT and never auto-runs**: a rolled-back version still must pass the same
  digest + trust gate before execution (documented in `PLUGIN_SDK.md` § governance).
  *(Verified: `governance.test.ts`; `security-regression.test.ts` version-range refusal.)*
- **Resource quota + unstable reset (P0.1, honest scope)** — a per-plugin per-session
  wall-clock budget and a max-concurrent-activation cap. A plugin exceeding the quota is
  **marked unstable and quarantined** (crash-restart-on-unstable): it is refused on the
  next automatic activation. *(Verified: `runtime.test.ts` — quota quarantine, in-flight
  cap, reset.)*
  > ⚠️ **Corrected 2026-09-22:** "only runs again after an explicit
  > `resetUnstablePlugin(pluginId)`" was false. `vault-plugin-load.ts:174-176` calls
  > `resetUnstablePlugin` **unconditionally** for every preloaded plugin with a manifest,
  > on every vault load — and that call sits after the consent/trust/integrity gates, so
  > re-opening or switching a vault clears the quarantine. The code's own comment says
  > why ("loading a vault IS the re-approval the refusal message asks for"), which
  > contradicts the host's stated contract in `packages/plugin-host/src/runtime.ts:114`
  > ("a plugin never auto-restarts after being marked unstable"). One of the two is
  > wrong; today the caller wins. Do not read the quarantine as surviving a vault switch.

> ⚠️ **This is NOT OS-process/Worker isolation.** The quota bounds wall-clock and
> concurrency; it does not bound a plugin's **memory, globals, or synchronous CPU**. A
> plugin that spins the event loop synchronously cannot be pre-empted. The per-hook /
> per-activation timeout + AbortSignal cancel remain the primary pre-emption mechanism.

## Not yet implemented (honest caps)

- **True process / webview / worker isolation.** Vault plugins run in the main window
  (shared JS context). There is no sandbox separating a plugin's JS or its capability
  access from the app. `assertPermission` is a consent gate, **not** a capability
  boundary; a plugin declaring `fs`/`network`/`ai` runs "trusted-but-unsandboxed".
  The resource quota is a *bound*, not a sandbox (see § 6 caveat).
- **Asymmetric publisher provenance.** There is **no public-key** publisher signature and
  no trust anchor of that kind. What exists is the change-detection digest and the
  **HMAC-SHA256** envelope above — a shared-secret MAC, which
  `trust-policy.ts:22-23` itself calls "the trust anchor" in the sense that the signature
  is what is checked, not the digest. It proves the file was written by an installation
  that holds the per-install key; it cannot prove who published a plugin, and it is not
  public-key authentication. (This paragraph previously read "No publisher signature /
  trust anchor", contradicting the sentence after it.)
- **The agent engine, which this document did not mention at all until 2026-09-22.** The
  bundled `opencode` engine is a separate process that works inside the vault the user
  opened, and it has its own network access to whatever provider it is configured with.
  Two consequences a reader of a security document needs:
  - **Refusing it a capability does not stop it writing.**
    `agent_runtime/fs_capability.rs:27-28` says it outright — the capability "is an
    opportunity the engine may take, not a gate every write must pass" — and
    `tests/agent_fs_write_refusal_test.rs:38-40` records the measurement: after the host
    refused the write, the engine wrote the file itself.
  - **The engine is outside the app's AI controls.** The AI master switch and the
    write-permission tiers govern the app's own AI paths; the engine's provider
    connections and its own file writes are not those paths. See `docs/PRIVACY.md` for
    which requests leave the machine and which carry credentials.
- **Automatic rollback.** `rollbackPoint` surfaces the last-known-good version and
  requires the same digest/trust gate before running. The host never executes old code
  automatically, because there is no isolated context to run it in.
- **Per-capability grants.** Consent is all-or-nothing per plugin today; a future
  per-capability grant is enforced at `assertPermission` (point-of-use guard).
- **Master password is not a full app lock.** It gates the Stronghold vault, not the
  OS/user session.
