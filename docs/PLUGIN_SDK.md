# NekoWite Plugin SDK

This document is the **stable public contract** for third-party NekoWite plugins. It
covers the public API surface, the lifecycle, the permission/capability model, how a
plugin is loaded, and how the API is versioned.

A runnable reference plugin lives at [`examples/plugins/hello`](../examples/plugins/hello).
Read it alongside this document.

---

## 1. Where the public surface lives

The plugin SDK is the curated barrel `packages/plugin-host/src/index.ts`. It re-exports
**only** the stable names below; plugin authors and the app host must import from the
package root (`@nekowite/plugin-host`), **never** a deep path (`@nekowite/plugin-host/src/loader`).

The surface is frozen by a snapshot test (`packages/plugin-host/src/api-surface.test.ts`)
that fails if any stable export is removed. Types-only exports are part of the contract
too (they are erased at runtime, but still carry the API).

### Runtime exports

| Export | Source | Purpose |
| --- | --- | --- |
| `definePlugin(def)` | types | Wrap a plugin definition; returns it unchanged (type helper). |
| `createPluginError(code, opts)` / `PluginError` | types | Structured, categorized plugin errors with a recovery hint. |
| `joinPath(...parts)` | loader | Environment-agnostic POSIX-style path join. |
| `loadPlugin(meta, dynamicImport)` | loader | Import a single plugin by its manifest. |
| `loadPluginsFromDir(vaultPath, fs)` | loader | Scan a vault plugin directory and load each valid plugin. |
| `computePluginDigest(...parts)` | loader | Deterministic FNV-1a 32-bit fingerprint of plugin bytes (change-detection ONLY, not authentication). |
| `verifyPluginIntegrity(id, digest, store)` | loader | Compare a fresh digest to the last-approved one. |
| `verifyPluginSignature(sig, payload, key)` | loader | Verify a plugin's HMAC-SHA256 signature against a trusted publisher key. |
| `createPluginSignature(payload, key)` | loader | Produce an HMAC-SHA256 signature (publisher-side / test helper). |
| `buildPluginSignaturePayload(id, version, main, code, permissions?)` | loader | Canonical code+manifest payload a publisher signs. |
| `publisherIdOf(pluginId)` | loader | Derive the publisher id (`@scope/name` → `@scope`) for the trusted-source allowlist. |
| `encodePluginKeyMaterial(key)` | loader | Encode a trusted key (hex or UTF-8) into raw HMAC bytes. |
| `activatePlugin(result, options?)` | runtime | Register a plugin's components/commands/toolbar + lifecycle hooks, time-boxed. |
| `deactivatePlugin(id)` | runtime | Unregister everything a plugin registered. |
| `markPluginUnstable(id, reason?)` | runtime | Deactivate a plugin that entered an unstable state and record the failure. |
| `getUnstablePluginIds()` / `isPluginUnstable(id)` | runtime | Read whether a plugin was disabled for instability. |
| `setLifecycleHookTimeout(ms)` / `getLifecycleHookTimeout()` | lifecycle | Configure (or read) the async-hook timeout budget. |
| `setActiveEditor` / `getActiveEditor` | lifecycle | Point (or read) the active editor for the plugin context. |
| `registerLifecycleHook(id, event, fn, ctx)` | lifecycle | Register a single lifecycle hook (rarely needed directly). |
| `hasLifecycleListeners(event)` | lifecycle | Whether any plugin listens for an event. |
| `onLifecycleError(cb)` | lifecycle | Subscribe to structured hook failures. |
| `emitLifecycle(event, ...args)` | lifecycle | Fire a lifecycle event to all hooks (used by the app). |
| `DANGEROUS_PERMISSIONS` | permissions | `['ai','fs','network']` — capabilities gated behind consent. |
| `hasDangerousPermissions(decl)` | permissions | Whether a declaration needs consent. |
| `collectPluginPermissions(...sources)` | permissions | Merge declared permissions, de-duplicated, source order. |
| `hasPermission(decl, perm)` | permissions | Whether a permission is declared. |
| `getNonIsolatedPermissions(...sources)` | permissions | Declared capabilities the host does not truly isolate. |
| `assertPermission(decl, perm, opts)` | permissions | Throw a structured `PLUGIN_PERMISSION_DENIED` if the permission is absent. |
| `version` | index | Host API version string (see § 5). |

The barrelled **types** include `PluginDefinition`, `PluginPermission`, `PluginMeta`,
`PluginContext`, `PluginErrorCode`, `PluginErrorOptions`, `LoadResult`, `LoadedPlugin`,
`PluginFsAdapter`, `PluginDigestStore`, `PluginIntegrityVerdict`, `PluginTrustKey`,
`PluginTrustVerdict`, `ActivatePluginOptions`, `ActivationResult`, `LifecycleEvent`,
`LifecycleEventArgMap`, and `LifecycleErrorEvent`.

### editor-core re-exports used by plugins

A plugin that wants to touch the document uses the editor object it receives in hooks
(or reads it with `getActiveEditor()`). The editor is a `NekoEditor` from
`@nekowite/editor-core` — import **types and helpers from the root**, never a deep path.

---

## 2. Plugin manifest and loading

A plugin lives in a subdirectory of `<vault>/plugins/<name>/` containing a
`package.json`:

```json
{
  "name": "hello",
  "version": "1.0.0",
  "main": "index.js",
  "type": "module"
}
```

The loader reads `name`, `version`, `main`, `permissions`, and an optional `signature`.
`signature` is a hex HMAC-SHA256 value produced by a publisher who holds the same trusted
secret the user configures; it is verified against that trusted key before the plugin is
imported (see § 4). `main` is resolved relative to the plugin directory and loaded with a
dynamic `import(main)`.

Loading runs in two phases:

1. **Phase 1 (no code execution)** — the loader scans the directory, reads `package.json`,
   and fingerprints the exact bytes it would execute (manifest text + loaded code) with
   `computePluginDigest`. Nothing is imported yet.
2. **Phase 2 (gated)** — the host checks, in order, (a) **trust/source authenticity**
   (`verifyPluginSignature` against the trusted key, or the trusted-source allowlist), (b)
   **integrity** (digest vs. the last approved value) and, for plugins declaring dangerous
   capabilities, (c) **consent**. Only after all three gates does the plugin get imported
   (`loadPlugin`) and activated (`activatePlugin`). A plugin whose signature FAILS is never
   imported; an unsigned plugin under the strict policy is refused unless explicitly
   trusted.

> ⚠️ **CSP:** vault plugins are loaded through in-window `import('blob:...')`. The
> **production CSP** is strict (`script-src 'self' 'wasm-unsafe-eval'` — no `blob:`,
> no `'unsafe-eval'`) and therefore **blocks blob-import plugins**. The host detects the
> Tauri runtime and refuses to attempt the import, surfacing **one** per-session notice
> that vault plugins are disabled until the plugin host is moved behind real isolation.
> Built-in plugins (bundled first-party code) are unaffected. So today: **vault plugins
> are effectively disabled in a production Tauri build**; they load in a plain-browser
> demo build.

---

## 3. Writing a plugin

A plugin's default export is a `PluginDefinition` constructed with `definePlugin`:

```js
import { definePlugin } from '@nekowite/plugin-host'

export default definePlugin({
  name: 'my-plugin',
  permissions: ['clipboard'],
  toolbar: [{ id: 'my-plugin.cmd', label: 'Do it', run: () => {} }],
  onLoad(ctx) {
    // ctx: { id, name, insertComponent, editor? }
    return () => { /* optional unload cleanup, run once on deactivate */ }
  },
  onEditorReady(ctx, editor) {
    // editor is a NekoEditor from @nekowite/editor-core
  },
})
```

### Registration batch

`PluginDefinition` extends `RegistrationBatch`:

- `components: Record<string, Component>` — Vue components the host registers so the
  plugin can insert them (via `ctx.insertComponent(name)`).
- `commands: EditorCommand[]` — `{ id, run: () => void }` commands.
- `toolbar: ToolbarItem[]` — `{ id, label, run: () => void }` toolbar items.

Keep these **decoupled from Tauri IPC**; a registerable item is pure UI/command wiring.

### Lifecycle hooks

| Hook | Args (after `ctx`) | Notes |
| --- | --- | --- |
| `onLoad(ctx)` | — | Runs once at activation; return a cleanup to run at deactivate. |
| `onUnload(ctx)` | — | Runs once at deactivate. |
| `onEditorReady(ctx, editor)` | editor | The editor is live. |
| `onDocChange(ctx, e)` | `{ doc }` | Document content changed. |
| `onSave(ctx, editor, content)` | `content` | Returning a string **rewrites** the content written to disk. |
| `onSaved(ctx, editor, content)` | — | Fired after a successful write. |
| `onOpenDocument(ctx, tab)` | tab | A document tab opened. |
| `onCloseTab(ctx, tab)` | tab | A tab closed. |
| `onViewModeChange(ctx, mode)` | mode | Source/rendered/split changed. |

Hook failures are **isolated**: one plugin's throw never blocks the others. The failure is
surfaced through `onLifecycleError` as a structured `PluginError` (code
`PLUGIN_HOOK_ERROR`) with an actionable recovery hint, so the user sees "disable the
plugin / check its logs" rather than a silently swallowed error.

`onSave` is the only chained hook: once a hook returns a string, that string becomes the
`content` for the following hooks (a non-string return passes the value through). Use it
for transforms (e.g. annotate every save) — but be aware it changes what reaches disk.

---

## 4. Permission / capability model

A plugin declares the capabilities it needs with `permissions: PluginPermission[]`.

```ts
type PluginPermission = 'ai' | 'fs' | 'network' | 'clipboard'
```

**Dangerous permissions** (require user consent before activation):
`ai`, `fs`, `network`. See `DANGEROUS_PERMISSIONS`.

**What a plugin can effectively do:**

- Register components, commands, and toolbar items (host-gated).
- Observe the editor and document via lifecycle hooks.
- Read the active editor via `getActiveEditor()` and call methods on it.
- Declare capabilities; the host surfaces dangerous ones for consent.

**What a plugin cannot do:**

- Reach `window.__TAURI_INTERNALS__`/`invoke` directly without declaring (and being
  granted) the relevant dangerous permission — and even then the **guard is consent
  gating + a point-of-use `assertPermission`, not a true sandbox**. The host documents
  this honestly in [`docs/SECURITY.md`](SECURITY.md): plugins run **in the main window
  context** (no webview/worker isolation), so `fs`/`network`/`ai` are gated by user
  consent, **not** capability isolation.
- Read the raw API key: the key gateway returns only a mask.
- Choose the vault root: vault roots are registered/bound by Rust.
- Escape the host's change-detection: a modified plugin fails `verifyPluginIntegrity`.
- Escape the host's trust gate: a plugin whose signature fails verification is refused,
  and an unsigned plugin under the strict policy is not silently trusted.

> ⚠️ **Honest security posture.** The 32-bit FNV-1a digest gives you **change-detection,
> not cryptographic authenticity** — it is unkeyed, so it detects "this changed since you
> approved it" but does **not** prove provenance. The **trust anchor is the signature**
> (see § 4.1): a plugin whose signature verifies is the only one the host treats as
> cryptographically trusted. And because there is no real isolation, a malicious plugin
> with a granted permission can still act in the main window — treat activation as
> trusting the code.

### Point-of-use checking

Within a plugin, call `assertPermission(decl, 'fs', { detail: 'read a file' })` right
before an action that needs a capability. If it is not granted, it throws a structured
`PLUGIN_PERMISSION_DENIED` (with an ask + recovery hint) instead of silently proceeding.
This is **not** IPC sandboxing — it makes a missing permission loud and actionable.

### 4.1 Trust model (signature verification OR trusted-source policy)

A plugin's manifest may declare a `signature`: a hex **HMAC-SHA256** value over the
canonical code+manifest payload (`buildPluginSignaturePayload`). The host verifies it
against a **trusted publisher key** the user configures (`setPluginTrustedKey`). The
policy applied before any import is:

| Signature / source | Result |
| --- | --- |
| signature present **and** verifies against the trusted key | **trusted** — imported |
| signature present **but fails** verification (or no key configured) | **REFUSED** — `PLUGIN_SIGNATURE_INVALID`, never imported |
| no signature, on the trusted-source allowlist (`publisherIdOf`, full id) | **trusted** — imported |
| no signature, `require-trust` policy, explicitly trusted (allowlist / decider) | imported |
| no signature, `require-trust` policy, not trusted | **REFUSED** — `PLUGIN_UNSIGNED_UNTRUSTED` |
| no signature, `permit-unsigned-with-notice` (default) | imported, but flagged as **unsigned / untrusted-source** (never claimed as trusted) |

> ⚠️ **What the signature is (and is not).** This is a **shared-secret MAC**, i.e.
> **integrity-of-source**, proven by a holder of the same secret. It is **NOT
> public-key (asymmetric) authentication** — the same secret signs and verifies, so it
> authenticates to a shared secret, not to a published public key. (A real Ed25519
> scheme would avoid the shared-secret property but adds a crypto dependency the repo
> deliberately avoids.) It is also **not process isolation**: a signed plugin still runs
> in the main window and a granted permission can reach Tauri IPC / the file system.
> Keep the trusted key secret; anyone who holds it can sign.
>
> The default policy (`permit-unsigned-with-notice`) is a deliberate product choice for
> the current demo/browser loader: it is **not** silent — the plugin is logged as
> unsigned/untrusted and the strict policy is the guardrail. For real third-party
> distribution, set `setPluginTrustPolicy('require-trust')` so unsigned plugins are
> refused until explicitly trusted.

### 4.2 Timeout, cancel & crash isolation

A bad plugin must never hang or take down the host. The host therefore:

- **Per-activation timeout**: `activatePlugin` awaits the plugin's async `onLoad` under a
  budget (`DEFAULT_PLUGIN_ACTIVATION_TIMEOUT_MS`, 5s). A plugin that exceeds it is
  cancelled with `PLUGIN_HOOK_TIMEOUT`, its registrations are rolled back, and it is
  marked **unstable** (`markPluginUnstable`) — the host keeps running.
- **Cancel**: an `AbortSignal` can be threaded through `activatePlugin(..., { signal })`.
  Aborting stops waiting for a running activation (`PLUGIN_ABORTED`); a pre-aborted signal
  is refused before any work.
- **Crash isolation**: a plugin whose `onLoad` throws/rejects is rolled back and marked
  unstable (its components/commands/toolbar/hooks are released). An async lifecycle hook
  that exceeds `DEFAULT_PLUGIN_HOOK_TIMEOUT_MS` is surfaced as `PLUGIN_HOOK_TIMEOUT` and
  the plugin is deactivated; a hook that rejects is surfaced as `PLUGIN_HOOK_ERROR`,
  still isolated. A throwing hook never blocks other hooks.

> ⚠️ **Honest limits.** This is **not process/worker isolation.** A **synchronous** hook
> that spins the event loop cannot be pre-empted — only an **async** (thenable) hook or
> async `onLoad` can be time-boxed. There is no memory/global/CPU boundary; a truly
> malicious plugin that freezes the loop still freezes the window. Process isolation is
> the explicit future work, and until then the strict CSP (below) refuses vault plugins in
> a production Tauri build.

### 4.3 CSP note (re-stated)

Vault plugins load through in-window `import('blob:...')`. The production Tauri CSP is
strict (`script-src 'self' 'wasm-unsafe-eval'` — no `blob:`, no `'unsafe-eval'`) and
therefore **blocks blob-import plugins**. The host detects the Tauri runtime and refuses
to attempt the import, surfacing **one** per-session notice that vault plugins are
disabled until the plugin host is moved behind real isolation. Built-in plugins
(bundled first-party code) are unaffected. So today: **vault plugins are effectively
disabled in a production Tauri build**; they load in a plain-browser demo build.

---

## 5. API versioning

The public surface is versioned by the `version` export in `packages/plugin-host`:

- `@nekowite/plugin-host` `version` is `0.1.0` (see `index.ts`). It is independent of the
  app's own version.
- **Backward compatibility:** until 1.0, the SDK may change; the snapshot test
  (`api-surface.test.ts`) freezes the current surface so any removal is a deliberate,
  reviewed, versioned change. At 1.0 the surface below is the commitment:
  - Adding a **new** export is always additive and never breaking.
  - **Removing or renaming** an export is a breaking change and MUST fail the snapshot
    test, bump the host version, and be called out in the changelog + this document.
  - **Semantics** of hooks/args are part of the contract: changing `(ctx, editor)` to
    `(editor)` is breaking even if the export name stays.

Plugins should declare a peer range on `@nekowite/plugin-host` (e.g. `^0.1.0`) and the
host refuses a plugin whose declared range excludes the running version. That contract is
enforced by the host's loader at activation.

---

## 6. Loading an example locally (demo build)

In a plain-browser demo build (`pnpm --filter @nekowite/desktop dev`, no Tauri, so the CSP
does not block blob imports):

1. Drop `examples/plugins/hello` (renamed, e.g. as `hello` with its `package.json`) into
   `<vault>/plugins/hello/`.
2. Open the vault. The host scans `plugins/`, fingerprints, and activates the plugin.
3. The "Insert greeting" toolbar item appears; clicking it calls
   `getActiveEditor().insertMarkdownAtCursor(...)`.

In a production Tauri build the plugin will not load (blob imports are CSP-blocked) — see
§ 2. That is intentional until the host is moved behind real isolation.
