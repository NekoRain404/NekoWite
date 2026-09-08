# NekoWite Security Posture — M1 invariant audit

What NekoWite's security model **actually enforces** today (each item is verified by
an automated test or a Rust integration test), and what it **does not**. Read this
before assuming a capability is protected.

## Enforced

### 1. Plugin execution is gated behind change-detection + consent

Vault plugins are **not executed** until two gates pass, both in phase 2 (the frontend
never imports a module in phase 1):

1. **Consent** — the loader asks the user before activating any plugin declaring
   dangerous capabilities (`fs`/`network`/`ai`). A denial skips the plugin's import
   entirely, so its code is never executed.
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
fires exactly once per session.)*

### 3. IPC is bound to the vault the user actually opened

Path-confined Rust commands (`read_file`, `write_file`, `stat_file`, `list_dir`,
`search_notes`, history/trash/attachment commands, `rename_entry`, `watch_folder`, …)
call `require_opened_vault` and reject any `vault_root` that was **not registered this
session**. The only way to authorize a root is `register_vault` (or a fresh native
folder pick, which auto-registers). Every vault-open path in the app — native folder
dialog, `localStorage` restore, and the settings panel (typed or browsed) — routes
through `applyVault` → `register_vault`, so a root is never served before the user
opened it. *(Verified: `VaultRegistry` + `app: vault_auth_test.rs` covers unregistered
reject, registered-authorize, symlink canonicalization, and relative-path reject.)*

### 4. The API key never leaves the vault as plaintext

`load_ai_key` returns only a fixed mask (`'••••••••'`) when a key is configured, and
`null` otherwise. The real key is read **only inside Rust**
(`load_ai_key_internal`) for AI requests. The frontend treats the mask strictly as a
presence indicator — `settings.ts` feeds an empty value into live state so `config()`
never sends the mask as a real key — and `store_ai_key` refuses to store the mask as if
it were a key. The key crosses IPC once, when the user saves a new key, and is never
read back. *(Verified: `settings.test.ts` mask-as-presence tests assert the live state
becomes `''` and `config().api_key` is `undefined` for both the mask and `null`.)*

### 5. Vault key protection uses Argon2id

When a master password is set, the Stronghold key is derived from the password with
**Argon2id** (OWASP parameters: 19 MiB, t=2, p=1) over a fresh per-vault salt. Only a
one-way verifier and the salt are persisted; the derived key is never written. A
password-protected vault must be unlocked (`unlock_vault`) before use.

### 6. Plugin governance (audit log, version policy/rollback, revocation, resource quota)

Beyond the trust/integrity gates, the host enforces a governance layer
(`packages/plugin-host/src/governance.ts` + the quota/unstable logic in `runtime.ts`):

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
  next automatic activation and only runs again after an explicit
  `resetUnstablePlugin(pluginId)` (user-mediated re-approval, which also grants a fresh
  budget). *(Verified: `runtime.test.ts` — quota quarantine, in-flight cap, reset.)*

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
- **Signed plugin provenance.** No publisher signature / trust anchor. The digest is
  change detection only (see the caveat above). The HMAC signature is a shared-secret
  MAC, not public-key authentication.
- **Automatic rollback.** `rollbackPoint` surfaces the last-known-good version and
  requires the same digest/trust gate before running. The host never executes old code
  automatically, because there is no isolated context to run it in.
- **Per-capability grants.** Consent is all-or-nothing per plugin today; a future
  per-capability grant is enforced at `assertPermission` (point-of-use guard).
- **Master password is not a full app lock.** It gates the Stronghold vault, not the
  OS/user session.
