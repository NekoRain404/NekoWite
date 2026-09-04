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

## Not yet implemented (honest caps)

- **True process / webview / worker isolation.** Vault plugins run in the main window
  (shared JS context). There is no sandbox separating a plugin's JS or its capability
  access from the app. `assertPermission` is a consent gate, **not** a capability
  boundary; a plugin declaring `fs`/`network`/`ai` runs "trusted-but-unsandboxed".
- **Signed plugin provenance.** No publisher signature / trust anchor. The digest is
  change detection only (see the caveat above).
- **Per-capability grants.** Consent is all-or-nothing per plugin today; a future
  per-capability grant is enforced at `assertPermission` (point-of-use guard).
- **Master password is not a full app lock.** It gates the Stronghold vault, not the
  OS/user session.
