import {
  activatePlugin,
  assertPermission,
  buildPluginSignaturePayload,
  clearAuditLog,
  collectPluginPermissions,
  computePluginDigest,
  createMacEnvelope,
  createPluginError,
  DEFAULT_PLUGIN_ACTIVATION_TIMEOUT_MS,
  deactivatePlugin,
  flushAuditLogToFile,
  generateMacSecret,
  getAuditLog,
  getGovernancePluginIds,
  getLastKnownGoodVersion,
  getNonIsolatedPermissions,
  getPluginAuditEvents,
  getPluginVersionRange,
  getRecordedPluginVersion,
  getRevokedPlugins,
  getUnstablePluginIds,
  governanceRefusal,
  hasDangerousPermissions,
  isPluginRevoked,
  isPluginUnstable,
  isVersionAllowed,
  loadAuditLogFromFile,
  loadGovernance,
  loadPlugin,
  markBadVersion,
  onLifecycleError,
  onPluginEvent,
  publisherIdOf,
  recordPluginEvent,
  recordPluginVersion,
  resetGovernanceForTests,
  resetUnstablePlugin,
  revokePlugin,
  rollbackPoint,
  serializeGovernance,
  setAuditLogFileSink,
  setPluginVersionRange,
  unrevokePlugin,
  verifyMacEnvelope,
  verifyPluginIntegrity,
  verifyPluginSignature,
} from '@nekowite/plugin-host'
import type {
  AuditLogFileSink,
  DynamicImport,
  LoadResult,
  PluginAuditEvent,
  PluginDefinition,
  PluginDigestStore,
  PluginError,
  PluginErrorCode,
  PluginFsAdapter,
  PluginFsEntry,
  PluginMeta,
  PluginPermission,
  PluginVersionRange,
  RecordedPluginVersion,
  PluginRevocation,
} from '@nekowite/plugin-host'
import { joinPath } from '@nekowite/plugin-host'
import { fsService } from '../platform/gateways/fs'
import { persistence } from './persistence'
import { describePluginError, notifyError } from './errors'
import { t } from '../i18n'

interface VaultPluginPackage {
  name?: string
  version?: string
  main?: string
  permissions?: PluginPermission[]
  /** Optional HMAC-SHA256 signature (hex) from a trusted publisher. */
  signature?: string
}

function joinVault(...parts: string[]): string {
  return parts.join('/').replace(/\/+/g, '/')
}

function isTauriRuntime(): boolean {
  return (
    typeof window !== 'undefined' &&
    Boolean((window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
  )
}

/**
 * Whether the current environment permits executing a vault plugin loaded from a
 * blob URL (`import('blob:...')`) under the active CSP.
 *
 * The production Tauri webview enforces a strict CSP (`script-src 'self'
 * 'wasm-unsafe-eval'` — no `blob:`, no `'unsafe-eval'`/`'unsafe-inline'`), so a
 * dynamic `import('blob:...')` of a plugin is silently blocked there. Until the
 * plugin system is moved behind real isolation (a dedicated process/WebView with
 * its own CSP), we DETECT that environment and skip the in-window import rather
 * than failing every plugin load with a CSP error.
 *
 * The signal is the presence of the Tauri runtime: the strict, `blob:`-denying
 * CSP is only injected into the real Tauri webview. In a plain browser (the
 * Demo, or the unit-test DOM) there is no Tauri runtime, so blob module imports
 * are not known to be blocked and this returns true — keeping the
 * permission/integrity code paths reachable and exercised outside the packaged
 * app. Plugin LOADING therefore remains gated until isolation exists; revisit
 * this helper (not the CSP) when the plugin host moves into a sandbox.
 */
export function isPluginImportAllowedByCsp(): boolean {
  return !isTauriRuntime()
}

// Once per session, surface a single user-visible notice that vault plugins are
// disabled by the security policy — never a silent no-op, and never a repeated
// CSP error per plugin.
let cspBlockedNotified = false

function signalPluginLoadingDisabledByCsp(): void {
  if (cspBlockedNotified) return
  cspBlockedNotified = true
  recordPluginEvent('*', 'import-refused', 'CSP blocks in-window plugin loading (no process/WebView isolation)')
  notifyError(t('plugin.loadingDisabled'))
}

/* ------------------------------------------------------------------------- *
 * Plugin governance (audit log + version policy/rollback + revocation).
 *
 * The policy functions live in @nekowite/plugin-host/governance; this module
 * (a) persists the SECURITY-relevant governance/trust state (revocations,
 * recorded versions, version ranges, bad versions, trusted key, trusted sources,
 * plugin digests) to a vault-relative, MAC-protected file via fsService — NOT to
 * localStorage, which a WebView profile / localStorage attacker could rewrite,
 * (b) persists the (non-secret) audit log to a vault-relative file through
 * fsService when available, and (c) routes audit events so governance decisions
 * are never silent. All of these are additive to the existing trust/integrity/
 * consent gates. localStorage is retained only as a NON-authoritative notice flag.
 * ------------------------------------------------------------------------- */

// The trust/governance records (trust key, trusted sources, plugin digests,
// revocations, version policy) are SECURITY-relevant and so are persisted in an
// integrity-checked (keyed-HMAC) vault file — NEVER as authoritative data in
// localStorage, which a WebView profile / localStorage attacker could rewrite.
// localStorage remains only a NON-authoritative fast cache for non-security UI
// state (e.g. "saw this notice"). See docs/SECURITY.md + docs/PLUGIN_SDK.md.

/** Vault-relative path of the MAC-protected governance/trust state file. */
export const PLUGIN_GOVERNANCE_FILE = '.nekowite/plugin-governance.json'
/** Vault-relative path of the per-install HMAC secret that keys that file. */
export const PLUGIN_GOVERNANCE_MACKEY_FILE = '.nekowite/plugin-governance.mackey'
/** Vault-relative path of the (non-secret) audit log file. */
export const PLUGIN_AUDIT_LOG_FILE = '.nekowite/vault-plugin-audit.log'
/** Non-authoritative localStorage flag: "surfaced the tamper notice this session." */
const PLUGIN_TAMPER_NOTICE_KEY = 'nekowite.pluginGovernanceTamperNotice'

let auditRouterOff: (() => void) | null = null

// The vault the governance file is currently scoped to (set on every load so a
// save always targets the right vault, and so a stale sink from a previous vault
// can never write into this one).
let currentVault: string | null = null
const GOVERNANCE_SAVE_DEBOUNCE_MS = 250
let governanceSaveTimer: ReturnType<typeof setTimeout> | null = null
// Session cache of the per-install MAC secret per vault, so a save within the
// same session reuses the key that loaded the file (idempotent MAC).
const macSecretCache = new Map<string, string>()

/** Best-effort audit-log file persistence via the app's fs service. Returns the
 *  sink, or null when a writable file service is unavailable (so an environment
 *  without a real fs keeps the in-memory ring + subscription only). */
function setupAuditFilePersistence(vault: string): AuditLogFileSink | null {
  const write = (fsService as { write?: unknown }).write
  const read = (fsService as { read?: unknown }).read
  if (typeof write !== 'function' || typeof read !== 'function') return null
  // Deterministic, vault-relative, and intentionally hidden under `.nekowite/` so
  // the audit log is never surfaced in the file tree and never collides with a
  // user note/doc path (no `*.md`/`*.mdx`). `read`/`write`/`exists` all use the
  // SAME vault-relative argument convention, so what we write is what we read.
  const rel = PLUGIN_AUDIT_LOG_FILE
  const sink: AuditLogFileSink = {
    path: joinVault(vault, rel),
    exists: async () => {
      const stat = (fsService as { stat?: (v: string, p: string) => Promise<unknown> }).stat
      if (typeof stat !== 'function') return false
      try {
        await stat(vault, rel)
        return true
      } catch {
        return false
      }
    },
    read: () => (fsService as { read: (v: string, p: string) => Promise<string> }).read(vault, rel),
    // The audit sink writes its own file and has nothing to do with note
    // history, so the warning channel (which exists for a failed history
    // snapshot) is dropped here — with the cast saying so, rather than an
    // incompatible signature pretending the two are the same call.
    write: (_p, content) =>
      (
        fsService as { write: (v: string, p: string, c: string) => Promise<unknown> }
      )
        .write(vault, rel, content)
        .then(() => undefined),
  }
  setAuditLogFileSink(sink)
  void loadAuditLogFromFile()
  return sink
}

/** The deterministic vault-relative audit-log path (absolute per `vault`). The
 *  file never collides with a note/doc path because it lives under `.nekowite/`
 *  and its basename does not end in `.md`/`.mdx`. */
export function getVaultPluginAuditLogPath(vault: string): string {
  return joinVault(vault, PLUGIN_AUDIT_LOG_FILE)
}

/** Dispose any configured audit-log file sink. Called on vault switch so a stale
 *  sink from a previous vault can never write (or read) into the next vault. */
function disposeAuditLogFileSink(): void {
  setAuditLogFileSink(null)
}

/** Route audit events so a governance decision is observable (logged, and
 *  surfaced via the error channel for the user-facing refusals). Subscription is
 *  kept separate from the per-refusal notifyError so it never double-notifies at
 *  the exact refusal sites; this is the status/UI channel (exported via
 *  `onPluginEvent`). */
function setupAuditRouter(): void {
  if (auditRouterOff) return
  auditRouterOff = onPluginEvent((ev) => {
    if (ev.pluginId === '*') return
    console.info(`[NekoWite:audit] plugin "${ev.pluginId}" ${ev.event}${ev.detail ? ` — ${ev.detail}` : ''}`)
  })
}

/** A snapshot of the governance state, for a settings/status surface. */
export function getPluginGovernance(): {
  audit: PluginAuditEvent[]
  revoked: PluginRevocation[]
  versions: Record<string, RecordedPluginVersion>
  ranges: Record<string, PluginVersionRange>
  unstable: string[]
  lastKnownGood: Record<string, string>
} {
  const versions: Record<string, RecordedPluginVersion> = {}
  const ranges: Record<string, PluginVersionRange> = {}
  const lastKnownGood: Record<string, string> = {}
  for (const id of getGovernancePluginIds()) {
    const rec = getRecordedPluginVersion(id)
    if (rec) versions[id] = rec
    const range = getPluginVersionRange(id)
    if (range) ranges[id] = range
    const good = getLastKnownGoodVersion(id)
    if (good) lastKnownGood[id] = good
  }
  return {
    audit: getAuditLog(),
    revoked: getRevokedPlugins(),
    versions,
    ranges,
    unstable: getUnstablePluginIds(),
    lastKnownGood,
  }
}

/** The audit events recorded for a plugin id, newest-last. */
export function getVaultPluginAuditEvents(pluginId: string): PluginAuditEvent[] {
  return getPluginAuditEvents(pluginId)
}

/** Public governance wrappers (wired for a settings/status surface + tests). */

/**
 * Clear a plugin's unstable flag (user-mediated re-approval) so it can run again,
 * with a fresh session resource budget. `loadVaultPlugins` performs this for every
 * plugin it finds in a vault, because that is the only reachable path: the host
 * quarantines a plugin that crashed, timed out or exhausted its budget by tearing
 * it out of its active map, and `deactivatePlugin` only clears the flag for
 * plugins still in that map — so a quarantine used to survive every vault switch
 * and the "re-approve it (reset), then reload the vault" refusal could never be
 * carried out. Nothing becomes trusted by this: the reload still runs every gate
 * (revocation, version policy, consent, trust, integrity) before the plugin is
 * imported again.
 */
export function resetUnstableVaultPlugin(pluginId: string): void {
  resetUnstablePlugin(pluginId)
}

/** True when a vault plugin is currently quarantined as unstable. */
export function isVaultPluginUnstable(pluginId: string): boolean {
  return isPluginUnstable(pluginId)
}

/** Revoke a plugin id (all versions) or a specific version/range. Persisted to the
 *  MAC-protected governance file (best-effort, async). */
export function revokeVaultPlugin(pluginId: string, version = 'all', reason?: string): void {
  revokePlugin(pluginId, version, reason)
  scheduleGovernanceSave()
}

/** Remove a revocation. Persisted to the MAC-protected governance file. */
export function unrevokeVaultPlugin(pluginId: string, version = 'all'): void {
  unrevokePlugin(pluginId, version)
  scheduleGovernanceSave()
}

/** Configure the supported version range for a plugin. Persisted to the file. */
export function setVaultPluginVersionRange(pluginId: string, range: PluginVersionRange): void {
  setPluginVersionRange(pluginId, range)
  scheduleGovernanceSave()
}

/** The configured version range for a plugin, if any. */
export function getVaultPluginVersionRange(pluginId: string): PluginVersionRange | undefined {
  return getPluginVersionRange(pluginId)
}

/** Mark a plugin version as known-bad (refused on next load). Persisted. */
export function markVaultPluginVersionBad(pluginId: string, version: string): boolean {
  const disallowed = markBadVersion(pluginId, version)
  scheduleGovernanceSave()
  return disallowed
}

/** The recorded version + digest for a plugin (the host's last load). */
export function getVaultPluginRecordedVersion(pluginId: string): RecordedPluginVersion | undefined {
  return getRecordedPluginVersion(pluginId)
}

/** The last-known-good version a plugin can be rolled back to (BEST-EFFORT; not
 *  auto-run — a rolled-back version must still pass the digest/trust gate). */
export function getVaultPluginRollbackPoint(pluginId: string): { version: string; digest?: string; requiresReapproval: true } | null {
  return rollbackPoint(pluginId)
}

/** Whether a specific plugin version is revoked (the refusal reason is included). */
export function isVaultPluginRevoked(pluginId: string, version: string): boolean {
  return isPluginRevoked(pluginId, version).revoked
}

// Every vault plugin id this module has activated. Switching vaults must
// fully deactivate the previous vault's plugins before loading the next one;
// otherwise a plugin from vault A keeps its components/commands/lifecycle hooks
// registered in vault B (and because re-activating the same id is a silent
// no-op, going back to A would never re-register the reloaded definition).
const activeVaultPluginIds: string[] = []

/** Composite storage key for every record scoped to a (vault, plugin id) pair:
 *  vault + plugin id, NUL-separated so a vault path and an id that both contain
 *  "/" can never collide. Two different vaults therefore never share a record for
 *  the same plugin id — a trust/permission decision made in one vault can never
 *  authorise the same-id plugin of another. */
function vaultScopedKey(vault: string | null, id: string): string {
  // NUL separator: a vault path and a plugin id can both contain "/", so a plain
  // concatenation (or "/" join) could collide across vaults.
  return `${vault ?? ''}\u0000${id}`
}

// Per-session permission verdicts, keyed by vault + plugin id (NOT by id alone:
// approving a dangerous plugin in vault A must never silently authorise a
// different plugin that happens to share the id in vault B). The verdict is
// remembered for the session so a plugin is not re-prompted on every vault
// switch — including a DENIAL, which is the safe verdict: re-asking for a plugin
// the user already refused each time they switch vaults is nagging, and the
// refusal message now names the recovery that actually works (a restart starts a
// fresh session; reloading a vault cannot clear a session verdict).
const permissionDecisions = new Map<string, boolean>()

type PermissionDecider = (
  meta: PluginMeta,
  permissions: PluginPermission[],
) => Promise<boolean>

let permissionDecider: PermissionDecider | null = null

/** A pending permission question for the host to render. `resolve(true)` grants
 *  dangerous capabilities; `resolve(false)` skips the plugin's activation. */
export interface PluginPermissionRequest {
  meta: PluginMeta
  permissions: PluginPermission[]
  resolve: (allowed: boolean) => void
}

/** Install the callback used to confirm dangerous capabilities before a plugin
 *  is activated. Pass `null` to fall back to the safe default (deny). */
export function setPluginPermissionDecider(fn: PermissionDecider | null): void {
  permissionDecider = fn
}

/** Permissions declared by a plugin's manifest (package.json `permissions`). */
export function getPluginPermissions(meta: PluginMeta): PluginPermission[] {
  return meta.permissions ?? []
}

/** The plugin ids currently activated from the vault. */
export function getActiveVaultPluginIds(): string[] {
  return [...activeVaultPluginIds]
}

/**
 * Ask the user to grant a plugin's declared dangerous capabilities, caching the
 * verdict for the session under (vault, plugin id, capabilities).
 *
 * The verdict is keyed by the CAPABILITY SET as well as the plugin, because a
 * plugin declares permissions in two places: its manifest, and its code — and
 * the code's declarations are only visible after the module is imported. Keying
 * by (vault, id) alone meant a plugin the user approved for `fs` could later add
 * `ai` (or `network`) inside its own code and be activated without any further
 * prompt, while the "trusted but unsandboxed" notice cheerfully listed the new
 * capability among those "already approved". Approving `fs` is not approving
 * `network`; a new capability is a new question.
 *
 * Callers inside a vault scan pass the vault explicitly so the verdict is scoped
 * to it; a call with no vault (a test, or a caller outside a scan) is cached
 * under the empty vault and never merged with a real vault's slot.
 */
export async function askPluginPermission(
  meta: PluginMeta,
  definition: PluginDefinition,
  vault: string | null = currentVault,
): Promise<boolean> {
  // Merge manifest- and definition-declared permissions. Pure UI plugins declare
  // nothing and always pass; anything reaching the user is a dangerous one.
  const declared = collectPluginPermissions(meta, definition)
  if (!hasDangerousPermissions({ permissions: declared })) return true
  const key = `${vaultScopedKey(vault, meta.id)}::${[...declared].sort().join(',')}`
  const cached = permissionDecisions.get(key)
  if (typeof cached === 'boolean') return cached
  // Safe default: without an installed decider, deny risky plugins.
  const decision = permissionDecider ? await permissionDecider(meta, declared) : false
  permissionDecisions.set(key, decision)
  return decision
}

/* ------------------------------------------------------------------------- *
 * Task #24 — plugin change detection. We fingerprint the exact bytes the host
 * will execute — the package.json manifest text plus the loaded code — and
 * compare it to the last value the user approved. This is change detection, NOT
 * cryptographic authentication: the 32-bit FNV-1a digest is not signed and must
 * never be presented as proof of provenance. A mismatch simply means the plugin
 * was modified since approval and we refuse to silently run it, surfacing a
 * structured PLUGIN_VERIFY_FAILED with a re-approve/deny path instead.
 * ------------------------------------------------------------------------- */

interface DigestEntry {
  v: string
  d: string
}
type DigestMap = Record<string, DigestEntry>

// Authoritative, in-memory digest baseline. This is loaded from (and saved to)
// the MAC-protected governance file; it is NEVER read from localStorage as an
// authoritative value (a WebView profile / localStorage attacker must not be able
// to rewrite an approval baseline). localStorage is no longer used for digests.
const memoryDigestMap = new Map<string, DigestEntry>()

function readDigestMap(): DigestMap {
  return Object.fromEntries(memoryDigestMap)
}

function writeDigestMap(map: DigestMap): void {
  memoryDigestMap.clear()
  for (const [key, value] of Object.entries(map)) memoryDigestMap.set(key, value)
  scheduleGovernanceSave()
}

/** Test-only: seed a recorded baseline digest for a (vault, id) pair. Mirrors the
 *  authoritative in-memory store so tests can drive the integrity gate without
 *  going through the MAC file. */
export function setPluginRecordedDigestForTest(
  vault: string,
  id: string,
  version: string,
  digest: string,
): void {
  memoryDigestMap.set(vaultScopedKey(vault, id), { v: version, d: digest })
}

/** Test-only: read the recorded baseline digest for a (vault, id) pair. */
export function getPluginRecordedDigestForTest(vault: string, id: string): string | undefined {
  return memoryDigestMap.get(vaultScopedKey(vault, id))?.d
}

/** The last-approved digest for a (vault, plugin id) pair, if any. */
function getRecordedDigest(vault: string, id: string): string | undefined {
  return readDigestMap()[vaultScopedKey(vault, id)]?.d
}

/** Record (or re-approve) a plugin's digest as the new expected baseline. */
function setRecordedDigest(vault: string, id: string, version: string, digest: string): void {
  const map = readDigestMap()
  map[vaultScopedKey(vault, id)] = { v: version, d: digest }
  writeDigestMap(map)
}

// Adapter so plugin-host's validate helper can read the persisted value, scoped
// to the vault currently being loaded (closing over `vault`).
function makeVaultIntegrityStore(vault: string): PluginDigestStore {
  return {
    get: (id) => getRecordedDigest(vault, id),
    set: () => {
      /* recording happens through setRecordedDigest (needs the version too) */
    },
  }
}

type IntegrityDecider = (
  meta: PluginMeta,
  expectedDigest: string,
  actualDigest: string,
) => Promise<boolean>

let integrityDecider: IntegrityDecider | null = null

/** A pending re-approval question for the host to render. `resolve(true)`
 *  re-approves the plugin (recording its new fingerprint as the baseline);
 *  `resolve(false)` refuses to run the modified plugin. */
export interface PluginIntegrityRequest {
  meta: PluginMeta
  expectedDigest: string
  actualDigest: string
  resolve: (reapprove: boolean) => void
}

/** Install the callback that decides whether to re-approve a plugin whose code
 *  changed since it was last approved. `true` re-approves (records the new
 *  fingerprint); `false` refuses to run it. Default (no decider) = deny. */
export function setPluginIntegrityDecider(fn: IntegrityDecider | null): void {
  integrityDecider = fn
}

/** Ask the user whether to re-approve a modified plugin. */
async function askReapproveIntegrity(
  meta: PluginMeta,
  expectedDigest: string,
  actualDigest: string,
): Promise<boolean> {
  if (!integrityDecider) return false
  return integrityDecider(meta, expectedDigest, actualDigest)
}

/* ------------------------------------------------------------------------- *
 * Trust / trusted-source policy (definite plugin-security requirement).
 *
 * A plugin may carry an HMAC-SHA256 `signature` (hex) over its normalized
 * code+manifest payload, produced by a publisher who holds the same trusted
 * secret the user configures. That is a shared-secret MAC (integrity-of-source),
 * NOT public-key authentication — the same secret signs and verifies.
 *
 * Policy (applied as a gate BEFORE any import):
 *   - signature present + verifies against the trusted key  → trusted.
 *   - signature present + FAILS verification (or no key configured) → REFUSE
 *     with PLUGIN_SIGNATURE_INVALID, never import.
 *   - no signature → unsigned:
 *       * the plugin id / publisher id is on the trusted-source allowlist →
 *         trusted;
 *       * otherwise, under `permit-unsigned-with-notice` the plugin is ALLOWED
 *         but explicitly flagged as unsigned/untrusted-source (a console notice,
 *         not a silent grant — and never a security claim);
 *       * under `require-trust` the plugin MUST be explicitly trusted (via the
 *         allowlist or a trust decider); the safe default (no decider) is DENY
 *         with PLUGIN_UNSIGNED_UNTRUSTED.
 * The 32-bit FNV-1a digest remains change-detection only; the signature is the
 * trust anchor. Neither is process isolation.
 * ------------------------------------------------------------------------- */

/** How unsigned plugins are treated when they are not on the allowlist. */
export type PluginTrustPolicy = 'permit-unsigned-with-notice' | 'require-trust'

let pluginTrustPolicy: PluginTrustPolicy = 'permit-unsigned-with-notice'
// Authoritative in-memory trust configuration. Loaded from (and saved to) the
// MAC-protected governance file; NEVER read as an authoritative value from
// localStorage (a WebView profile / localStorage attacker must not be able to
// rewrite trust). `pluginTrustPolicy` is a session policy, not persisted.
let memoryTrustedKey = ''
const memoryTrustedSources = new Set<string>()

/** The configured trust policy. Default permits unsigned plugins with a logged
 *  "unsigned, untrusted-source" notice (so nothing is silently trusted as a
 *  security claim); `setPluginTrustPolicy('require-trust')` denies them unless
 *  explicitly trusted. */
export function getPluginTrustPolicy(): PluginTrustPolicy {
  return pluginTrustPolicy
}

/** Set the trust policy for unsigned plugins (session-only; not persisted). */
export function setPluginTrustPolicy(policy: PluginTrustPolicy): void {
  pluginTrustPolicy = policy
}

/** The trusted publisher key material (a hex or UTF-8 secret), or '' if none. */
export function getPluginTrustedKey(): string {
  return memoryTrustedKey
}

/** Configure the trusted publisher key used to verify plugin signatures. Only
 *  plugins signed by a holder of this secret are treated as cryptographically
 *  trusted; a present-but-unverifiable signature is refused. Persisted to the
 *  MAC-protected governance file (best-effort, async). */
export function setPluginTrustedKey(keyMaterial: string): void {
  memoryTrustedKey = keyMaterial
  scheduleGovernanceSave()
}

/** The ids the user has explicitly trusted (publisher ids and/or full plugin ids). */
export function getPluginTrustedSourceIds(): string[] {
  return [...memoryTrustedSources]
}

/** True when a plugin's id OR its publisher id is in the trusted-source allowlist. */
export function isPluginTrustedSource(pluginId: string): boolean {
  const ids = getPluginTrustedSourceIds()
  return ids.includes(pluginId) || ids.includes(publisherIdOf(pluginId))
}

/** Add or remove an id on the trusted-source allowlist. Persisted to the
 *  MAC-protected governance file (best-effort, async). */
export function setPluginTrustedSource(pluginId: string, trusted: boolean): void {
  const ids = new Set(getPluginTrustedSourceIds())
  if (trusted) ids.add(pluginId)
  else ids.delete(pluginId)
  memoryTrustedSources.clear()
  for (const id of ids) memoryTrustedSources.add(id)
  scheduleGovernanceSave()
}

/* ------------------------------------------------------------------------- *
 * Governance trust-state file (MAC-protected) — P1.8.
 *
 * The SECURITY-relevant records (trusted key, trusted sources, plugin digests,
 * governance revocations/versions/ranges) are persisted in a single vault-relative
 * JSON file, wrapped in a keyed-HMAC envelope so tampering is DETECTED. On a MAC
 * failure the contained trust is refused (reset / trust-nothing) and a notice is
 * surfaced — we never silently load attacker-controlled values.
 *
 * Honest scope (documented in docs/SECURITY.md + docs/PLUGIN_SDK.md):
 *   - The HMAC key is a per-install secret persisted in a sibling file (there is
 *     no OS keychain exposed to the frontend). An attacker who can read BOTH the
 *     file and its key can recompute the MAC, so this is TAMPER-DETECTION, not a
 *     secure hardware root. It stops a localStorage-only attacker from rewriting
 *     trust, and it detects casual corruption / stale reads.
 *   - localStorage is retained ONLY as a non-authoritative "saw this notice" flag,
 *     never for trust/revocation/digest data.
 * ------------------------------------------------------------------------- */

/** The serialized security-relevant records written into the MAC envelope. */
interface GovernanceFilePayload {
  governance: string
  trustedKey: string
  trustedSources: string[]
  digests: DigestMap
}

/** Reset the in-memory trust records (never trust a tampered file). */
function resetTrustRecordsForTamper(): void {
  memoryTrustedKey = ''
  memoryTrustedSources.clear()
  memoryDigestMap.clear()
}

/** Surface a single user-visible + console notice that the governance state failed
 *  its integrity check and was reset. Uses a localStorage flag purely as a
 *  NON-authoritative "seen this session" guard. */
function signalGovernanceTamperNotice(): void {
  // The "saw this notice" guard is a NON-authoritative UI flag routed through
  // the persistence port (localStorage in the webview/tauri, memory in tests);
  // it is never a security decision.
  if (persistence.get(PLUGIN_TAMPER_NOTICE_KEY)) return
  persistence.set(PLUGIN_TAMPER_NOTICE_KEY, '1')
  console.warn(
    '[NekoWite] plugin governance state failed integrity (HMAC) verification; refusing the trust it contains and resetting it.',
  )
  notifyError(
    'Plugin trust/governance state failed its integrity check and was reset. No trust from that file was accepted.',
  )
}

/** Load (or generate) the per-install HMAC secret for a vault, cached per session.
 *  Best-effort: if no key file exists we generate a fresh 32-byte secret and try
 *  to persist it; if that fails the secret still keys MACs for this session. */
async function loadGovernanceMacSecret(vault: string): Promise<string> {
  const cached = macSecretCache.get(vault)
  if (cached) return cached
  try {
    const raw = await fsService.read(vault, PLUGIN_GOVERNANCE_MACKEY_FILE)
    if (typeof raw === 'string' && /^[0-9a-f]{64}$/i.test(raw)) {
      macSecretCache.set(vault, raw)
      return raw
    }
  } catch {
    /* no key file yet — generate a fresh one below */
  }
  const secret = generateMacSecret()
  macSecretCache.set(vault, secret)
  const write = (fsService as { write?: unknown }).write
  if (typeof write === 'function') {
    try {
      await (write as (v: string, p: string, c: string) => Promise<void>)(vault, PLUGIN_GOVERNANCE_MACKEY_FILE, secret)
    } catch {
      /* best-effort: without a writable key store, MAC protection is session-only */
    }
  }
  return secret
}

/** Collect the current security-relevant records into a payload string. */
function buildGovernancePayload(): GovernanceFilePayload {
  return {
    governance: serializeGovernance(),
    trustedKey: memoryTrustedKey,
    trustedSources: [...memoryTrustedSources],
    digests: readDigestMap(),
  }
}

/** Debounced, async persistence of the governance state to the MAC file. Fire-and-
 *  forget; a missing/incomplete fs is a silent no-op (state still lives in memory
 *  for the session). */
function scheduleGovernanceSave(): void {
  if (!currentVault) return
  if (governanceSaveTimer) clearTimeout(governanceSaveTimer)
  governanceSaveTimer = setTimeout(() => {
    governanceSaveTimer = null
    void writeGovernanceFile()
  }, GOVERNANCE_SAVE_DEBOUNCE_MS)
}

/** Write the MAC-protected governance file for the current vault. */
async function writeGovernanceFile(): Promise<void> {
  if (!currentVault) return
  try {
    const secret = await loadGovernanceMacSecret(currentVault)
    const payloadStr = JSON.stringify(buildGovernancePayload())
    const envelope = await createMacEnvelope(payloadStr, secret)
    await fsService.write(currentVault, PLUGIN_GOVERNANCE_FILE, JSON.stringify(envelope))
  } catch {
    /* best-effort persistence; never break a mutation because the file write failed */
  }
}

/**
 * Load the MAC-protected governance file for a vault into the authoritative
 * in-memory trust records. Assumes `currentVault` is already set.
 *
 *  - File absent                 -> first run; keep any in-memory (session) state.
 *  - Content not a MAC envelope  -> not a governance file (a stale/mismatched read,
 *                                   e.g. a note or a libwebfs path mismatch); keep
 *                                   in-memory state, never clobber the file.
 *  - MAC verify FAILS            -> TAMPERED: reset trust-nothing + surface a notice
 *                                   (never silently trust the file's contents).
 *  - MAC verify PASSES           -> apply the file's records authoritatively.
 */
async function loadGovernanceFile(vault: string): Promise<void> {
  currentVault = vault
  let raw: string
  try {
    raw = await fsService.read(vault, PLUGIN_GOVERNANCE_FILE)
  } catch {
    return // first run: no governance file yet
  }
  let framed: unknown
  try {
    framed = JSON.parse(raw)
  } catch {
    return // not JSON — treat as uninitialized / stale read; keep in-memory state
  }
  if (!framed || typeof (framed as { payload?: unknown }).payload !== 'string' || typeof (framed as { mac?: unknown }).mac !== 'string') {
    return // not a MAC envelope; not a governance file we wrote — never clobber it
  }
  const secret = await loadGovernanceMacSecret(vault)
  const ok = await verifyMacEnvelope(framed, secret)
  if (!ok) {
    resetTrustRecordsForTamper()
    signalGovernanceTamperNotice()
    return
  }
  try {
    const payload = JSON.parse((framed as { payload: string }).payload) as GovernanceFilePayload
    memoryTrustedKey = typeof payload.trustedKey === 'string' ? payload.trustedKey : ''
    memoryTrustedSources.clear()
    for (const id of Array.isArray(payload.trustedSources) ? payload.trustedSources : []) memoryTrustedSources.add(id)
    memoryDigestMap.clear()
    for (const [k, v] of Object.entries(payload.digests ?? {})) memoryDigestMap.set(k, v)
    if (typeof payload.governance === 'string') loadGovernance(payload.governance)
  } catch {
    resetTrustRecordsForTamper()
    signalGovernanceTamperNotice()
  }
}

type TrustDecider = (req: PluginTrustRequest) => Promise<boolean>

/** A pending trust question for the host to render. `resolve(true)` trusts the
 *  plugin (recording it on the allowlist); `resolve(false)` refuses it. Only
 *  reachable for unsigned plugins under the `require-trust` policy (or an
 *  explicit unsigned-opt-in); a plugin with a FAILING signature is always refused
 *  and never offered for trust. */
export interface PluginTrustRequest {
  meta: PluginMeta
  signature?: string
  reason: 'unsigned' | 'unverifiable-key'
  resolve: (trust: boolean) => void
}

let trustDecider: TrustDecider | null = null

/** Install the callback that decides whether to trust an unsigned plugin. */
export function setPluginTrustDecider(fn: TrustDecider | null): void {
  trustDecider = fn
}

/** Ask the user whether to trust an unsigned plugin. */
async function askPluginTrust(meta: PluginMeta, signature: string | undefined, reason: 'unsigned' | 'unverifiable-key'): Promise<boolean> {
  if (!trustDecider) return false
  return trustDecider({ meta, signature, reason, resolve: () => {} })
}

// Track unsigned plugins we already flagged so the console notice is not
// repeated per reload.
const unsignedNotified = new Set<string>()

/** A decision from the trust gate: allow (optionally with a notice) or a
 *  structured refusal. */
type TrustDecision =
  | { action: 'allow'; notice?: string }
  | { action: 'deny'; error: PluginError }

async function decidePluginTrust(
  meta: PluginMeta,
  signature: string | undefined,
  signaturePayload: string | undefined,
): Promise<TrustDecision> {
  if (signature && signaturePayload) {
    const trustedKey = getPluginTrustedKey()
    if (!trustedKey) {
      // A present signature we cannot verify against any key: an unverifiable
      // publisher claim. Refuse (never silently trust an unverified signature).
      return {
        action: 'deny',
        error: createPluginError('PLUGIN_SIGNATURE_INVALID', {
          pluginId: meta.id,
          message: `Plugin "${meta.name}" declares a signature but no trusted publisher key is configured; refusing to run it.`,
          recovery: 'Configure a trusted publisher key, or reinstall the plugin.',
        }),
      }
    }
    let ok = false
    try {
      ok = await verifyPluginSignature(signature, signaturePayload, trustedKey)
    } catch (e) {
      console.error(`[NekoWite] signature verification threw plugin="${meta.id}"`, e)
      ok = false
    }
    if (ok) return { action: 'allow' }
    return {
      action: 'deny',
      error: createPluginError('PLUGIN_SIGNATURE_INVALID', {
        pluginId: meta.id,
        message: `Plugin "${meta.name}"'s signature failed verification against the trusted publisher key; refusing to run it.`,
        recovery: 'Only run plugins from a source you trust, or reinstall the plugin.',
      }),
    }
  }

  // Unsigned: explicit trust or allow-with-notice.
  if (isPluginTrustedSource(meta.id)) return { action: 'allow' }
  if (pluginTrustPolicy === 'require-trust') {
    if (await askPluginTrust(meta, undefined, 'unsigned')) {
      setPluginTrustedSource(meta.id, true)
      return { action: 'allow' }
    }
    return {
      action: 'deny',
      error: createPluginError('PLUGIN_UNSIGNED_UNTRUSTED', {
        pluginId: meta.id,
        message: `Plugin "${meta.name}" is unsigned and not from a trusted source; refusing to run it.`,
        recovery: 'Trust it explicitly only if you trust its source, or add its publisher to the trusted sources.',
      }),
    }
  }
  // Default: allow but never silently trusted — flagged as unsigned/untrusted.
  if (!unsignedNotified.has(meta.id)) {
    unsignedNotified.add(meta.id)
    console.warn(
      `[NekoWite] plugin "${meta.id}" is unsigned and from an unverified source (allowed under the current policy; NOT cryptographically trusted).`,
    )
  }
  return { action: 'allow' }
}

/* ------------------------------------------------------------------------- *
 * Unsandboxed-capability signal (task #23/#28). Plugins run in the main window
 * (no webview/worker sandbox), so a declaration of fs/network/ai is consent-gated
 * but NOT capability-isolated. We surface a clear, observable notice that the
 * plugin is "trusted-but-unsandboxed" rather than pretending to sandbox it.
 * ------------------------------------------------------------------------- */

const unsandboxedVaultPlugins = new Map<string, PluginPermission[]>()
const unsandboxedNotified = new Set<string>()

/** The ids of active vault plugins that declare non-isolated capabilities. */
export function getActiveUnsandboxedPluginIds(): string[] {
  return [...unsandboxedVaultPlugins.keys()]
}

/** The declared non-isolated capabilities for a plugin (fs/network/ai). */
export function getUnsandboxedPermissions(id: string): PluginPermission[] {
  return unsandboxedVaultPlugins.get(id) ?? []
}

/** Record a plugin as trusted-but-unsandboxed and, once per session, surface a
 *  user-visible notice so a declared capability is never silently "confirmed". */
function signalUnsandboxedCapabilities(meta: PluginMeta, permission: PluginPermission[]): void {
  if (permission.length === 0) return
  unsandboxedVaultPlugins.set(meta.id, permission)
  if (unsandboxedNotified.has(meta.id)) return
  unsandboxedNotified.add(meta.id)
  const listing = permission.join(', ')
  const verb = permission.length === 1 ? 'capability is' : 'capabilities are'
  console.warn(
    `[NekoWite] plugin "${meta.id}" is trusted-but-unsandboxed; it declared ${listing} which run in the main window (no capability isolation).`,
  )
  notifyError(
    describePluginError(
      createPluginError('PLUGIN_UNSANDBOXED', {
        pluginId: meta.id,
        message: `Plugin "${meta.name}" runs unsandboxed in the main window; its ${listing} ${verb} NOT isolated.`,
        recovery: 'Only approve plugins from a source you trust.',
      }),
    ),
  )
}

/** Deactivate every vault plugin loaded so far and forget their ids. */
export function deactivateVaultPlugins(): void {
  for (const id of activeVaultPluginIds) deactivatePlugin(id)
  activeVaultPluginIds.length = 0
  unsandboxedVaultPlugins.clear()
  unsandboxedNotified.clear()
}

/**
 * The file-access boundary between the vault plugin loader and the app's fs
 * service. Constructed from the app's existing vault file service (Tauri Rust
 * commands in the desktop, the in-memory demo gateway in a browser), and injected
 * into the loader so the adapter boundary that plugin-host defines is exercised
 * in production as well as in tests. `readFile`/`readdir` take loader-style
 * POSIX paths rooted at the vault root; they are translated to vault-relative
 * paths for the underlying `fsService`.
 */
function makeVaultPluginFsAdapter(vault: string): PluginFsAdapter {
  const vaultRoot = vault.replace(/\/+$/, '')
  function toRelative(absPath: string): string {
    if (absPath === vaultRoot) return ''
    if (vaultRoot !== '' && absPath.startsWith(vaultRoot + '/')) {
      return absPath.slice(vaultRoot.length + 1)
    }
    return absPath.replace(/^\/+/, '')
  }
  return {
    readFile: (path) => fsService.read(vault, toRelative(path)),
    readdir: async (dir) => {
      const entries = await fsService.list(vault, toRelative(dir))
      return entries.map((e): PluginFsEntry => ({ name: e.name, isDirectory: () => e.is_dir }))
    },
    stat: async (path) => {
      // The Rust stat command returns size/mtime (no is_directory flag); the
      // loader only needs stat as a fallback when a readdir entry omits
      // isDirectory(), which our readdir always provides, so this is best-effort.
      await fsService.stat(vault, toRelative(path))
      return { isDirectory: () => false }
    },
  }
}

/**
 * Evaluate a plugin's source string as an ES module via a blob URL. This is the
 * ONLY place plugin code is (potentially) executed, and the loader calls it only
 * AFTER the integrity and consent gates pass — so a tampered/unapproved plugin's
 * top-level side effects can never run. In the Tauri app the webview has no Node
 * fs access; bare imports inside the plugin (e.g. `import { defineComponent }
 * from 'vue'`) will NOT resolve from a blob URL — which is one visible
 * consequence of plugins running in the main window context without a real
 * sandbox. The "vite-ignore" annotation keeps Vite from statically analyzing the
 * runtime blob specifier.
 */
async function importSource(source: string): Promise<{ default?: PluginDefinition }> {
  if (!isTauriRuntime()) return Promise.reject(new Error('browser-demo: plugin execution disabled'))
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
  try {
    return (await import(/* @vite-ignore */ url)) as { default?: PluginDefinition }
  } finally {
    URL.revokeObjectURL(url)
  }
}

// The per-plugin work (read manifest → read code) is independent across plugins
// and the bulk of the scan, so it runs concurrently with a bounded parallelism
// that keeps the allocator/IO sane. Integrity/consent gating and the import stay
// sequential and deterministic.
const MAX_PARALLEL_PLUGIN_LOADS = 4

/** Run `tasks` (index-aligned) with at most `limit` concurrent promises, while
 *  preserving the original task order in the returned array. */
async function runBounded<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) {
      const i = next++
      results[i] = await tasks[i]()
    }
  })
  await Promise.all(workers)
  return results
}

let lifecycleErrorOff: (() => void) | null = null

/** Route plugin lifecycle hook errors (a throwing hook, still isolated by the
 *  host) into the app error channel so a failure is observable and actionable. */
function ensureLifecycleErrorRouter(): void {
  if (lifecycleErrorOff) return
  lifecycleErrorOff = onLifecycleError((ev) => {
    console.error(`[NekoWite] plugin lifecycle hook failed plugin="${ev.pluginId}" event="${ev.event}"`, ev.error)
    notifyError(describePluginError(ev.error))
  })
}

/** Turn a raw dynamic-import failure string into a structured plugin error code
 *  so the loader can distinguish a code/parse problem from a generic load
 *  failure (missing entry file, unresolved module, etc.). */
function classifyLoadError(error: string): PluginErrorCode {
  if (/syntax|parse|unexpected|SyntaxError|Unexpected/i.test(error)) return 'PLUGIN_CODE_PARSE_FAILED'
  if (/cannot find module|module not found|no such file|failed to fetch|not found|does not provide an export|404/i.test(error)) {
    return 'PLUGIN_NOT_FOUND'
  }
  return 'PLUGIN_LOAD_FAILED'
}

/** Build a structured plugin error for a load-stage failure, keyed off the
 *  classified code so the recovery hint matches the problem. */
function loadFailure(meta: PluginMeta, error: string): PluginError {
  const code = classifyLoadError(error)
  const message =
    code === 'PLUGIN_CODE_PARSE_FAILED'
      ? `Plugin "${meta.name}" could not be parsed/imported: ${error}`
      : code === 'PLUGIN_NOT_FOUND'
        ? `Plugin "${meta.name}" could not be found (its entry file may be missing): ${error}`
        : t('plugin.loadFailed', { id: meta.id, error })
  const recovery =
    code === 'PLUGIN_CODE_PARSE_FAILED'
      ? 'Update the plugin to a compatible version.'
      : code === 'PLUGIN_NOT_FOUND'
        ? 'Reinstall the plugin, or check that its entry file exists.'
        : 'Reinstall the plugin or check its entry file.'
  return createPluginError(code, { pluginId: meta.id, message, recovery })
}

/** A single plugin's async-preloaded stage (manifest + code read + digest),
 *  result-shaped so each failure bucket is separately diagnosable. `skip` marks
 *  a directory that is not actually a plugin (no manifest), dropped silently.
 *  `source` carries the exact bytes that will be executed; `loadResult` is
 *  populated only after the gated import. */
interface PreloadedPlugin {
  dirName: string
  meta?: PluginMeta
  loadResult?: LoadResult
  error?: PluginError
  digest?: string
  source?: string
  /** The plugin's manifest-declared HMAC signature, if any. */
  signature?: string
  /** The canonical payload the signature is verified over (code+manifest). */
  signaturePayload?: string
  skip?: boolean
}

/** Read a plugin's manifest and its code SOURCE (without executing it — no
 *  import), fingerprinting the exact bytes the host would run so the integrity
 *  gate can refuse a modified plugin BEFORE any module code executes. */
async function preloadVaultPlugin(
  adapter: PluginFsAdapter,
  vault: string,
  dirName: string,
): Promise<PreloadedPlugin> {
  // 1. Read the manifest. A directory with no package.json is not a plugin
  //    (e.g. an arbitrary subfolder of plugins/), so it is skipped silently —
  //    a *malformed* manifest, by contrast, is a real failure below.
  let raw: string
  try {
    raw = await adapter.readFile(joinPath(vault, 'plugins', dirName, 'package.json'))
  } catch {
    return { dirName, skip: true }
  }

  // 2. Parse the manifest, distinguishing "invalid JSON" from "missing fields".
  let pkg: VaultPluginPackage
  try {
    pkg = JSON.parse(raw) as VaultPluginPackage
  } catch {
    return {
      dirName,
      error: createPluginError('PLUGIN_MANIFEST_INVALID', {
        pluginId: dirName,
        message: `Plugin "${dirName}" has an invalid manifest (package.json is not valid JSON).`,
        recovery: 'Fix or reinstall the plugin manifest.',
      }),
    }
  }
  if (!pkg.name || !pkg.version || !pkg.main) {
    return {
      dirName,
      error: createPluginError('PLUGIN_MANIFEST_INVALID', {
        pluginId: dirName,
        message: `Plugin "${dirName}" manifest is missing required fields (name, version, main).`,
        recovery: 'Fix the package.json manifest.',
      }),
    }
  }

  const meta: PluginMeta = {
    id: pkg.name,
    name: pkg.name,
    version: pkg.version,
    main: joinVault('plugins', dirName, pkg.main),
    permissions: pkg.permissions,
    signature: pkg.signature,
  }

  // 3. Read the plugin's code source string. Reading the file is safe; only
  //    importing/executing is gated, and that happens later (after the
  //    trust + integrity + consent gates). The digest is computed from these
  //    exact bytes; the signature payload is the canonical code+manifest form
  //    a publisher signs and the host verifies against the trusted key.
  let source: string
  try {
    source = await adapter.readFile(joinPath(vault, meta.main))
  } catch (e) {
    return { dirName, meta, error: loadFailure(meta, e instanceof Error ? e.message : String(e)) }
  }

  const digest = computePluginDigest(raw, source)
  const signaturePayload = buildPluginSignaturePayload(meta.id, meta.version, pkg.main, source, meta.permissions)
  return { dirName, meta, digest, source, signature: pkg.signature, signaturePayload }
}

/** Reset in-memory state (active ids, permission verdicts, deciders, unsandboxed
 *  registry, trust config, integrity baselines, governance). Test-only. */
export function resetVaultPluginStateForTests(): void {
  deactivateVaultPlugins()
  permissionDecisions.clear()
  permissionDecider = null
  integrityDecider = null
  trustDecider = null
  pluginTrustPolicy = 'permit-unsigned-with-notice'
  memoryTrustedKey = ''
  memoryTrustedSources.clear()
  unsignedNotified.clear()
  memoryDigestMap.clear()
  cspBlockedNotified = false
  currentVault = null
  macSecretCache.clear()
  if (governanceSaveTimer) {
    clearTimeout(governanceSaveTimer)
    governanceSaveTimer = null
  }
  resetGovernanceForTests()
  if (auditRouterOff) {
    auditRouterOff()
    auditRouterOff = null
  }
}

/**
 * Scan `vault/plugins/<id>/` for user plugins and activate each one.
 *
 * Reading goes through the injected `PluginFsAdapter` (built from the app's vault
 * file service, so the boundary plugin-host defines is real in production), while
 * `loadPlugin`/`activatePlugin` keep the plugin-host contract. Every
 * previously-activated vault plugin is deactivated first so switching vaults
 * never leaks a plugin's components/commands/lifecycle hooks into the next
 * vault. Best-effort: a missing plugins dir is not an error; per-plugin failures
 * are surfaced through the app's error toast.
 *
 * Loading is staged to keep startup time from growing linearly with plugin count,
 * AND so no plugin code is executed before it is verified:
 *  1. Per-plugin independent work (read manifest → read code → fingerprint) runs
 *     concurrently with bounded parallelism. NO module is imported here; each
 *     plugin's source string is only read and digested.
 *  2. Permission confirmation (manifest-declared capabilities) stays sequential
 *     (it drives a user dialog), followed by the integrity gate. A plugin that
 *     fails either gate is NEVER imported.
 *  3. Only after consent + integrity pass does the loader import (execute) the
 *     plugin source — the last action before activation. This is the security
 *     boundary: a tampered or unapproved plugin's top-level side effects never
 *     run, even if it would later be "not activated."
 *  4. Post-import, a plugin that declares additional capabilities in its code is
 *     consent-checked again (best-effort, since top-level already ran), a
 *     point-of-use permission guard runs, and non-isolated declarations surface
 *     a "trusted-but-unsandboxed" notice.
 *  5. Activation of the consented plugins runs concurrently, but recorded in a
 *     deterministic order (sorted by plugin id) so the UI/registration order is
 *     stable across reloads.
 */
export async function loadVaultPlugins(vault: string): Promise<void> {
  deactivateVaultPlugins()
  // On every vault load, dispose the previous vault's audit-log sink and clear the
  // audit ring: a stale sink (closure over a prior vault) must never write into
  // this vault, and events must not leak across a vault switch. A fresh log is
  // then reloaded from THIS vault's file below.
  disposeAuditLogFileSink()
  clearAuditLog()
  ensureLifecycleErrorRouter()
  // Attach the audit router and best-effort wire the audit log to a vault-relative
  // file via the fs service (when available). This runs before the CSP gate so
  // governance decisions are always observed.
  setupAuditRouter()
  setupAuditFilePersistence(vault)

  const adapter = makeVaultPluginFsAdapter(vault)
  let entries: PluginFsEntry[]
  try {
    entries = await adapter.readdir(joinPath(vault, 'plugins'))
  } catch {
    return
  }
  const pluginDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  // A vault with no `plugins/` directory has nothing that could be disabled, so
  // there is nothing to report and nothing to gate: staying quiet here is the
  // absence of a requested feature, not a silent failure. Telling every user on
  // every launch that plugins are blocked — in a vault they never put a plugin
  // in — turns a security implementation detail into permanent, alarming noise
  // (and used to write a plugin audit record into every vault on open).
  if (pluginDirs.length === 0) return

  // CSP gate: the production Tauri webview's strict CSP blocks the in-window
  // `import('blob:...')` that plugin loading relies on. Rather than attempting
  // (and failing) the import for every plugin, skip the scan entirely and surface
  // one notice. The permission/integrity/manifest code below stays intact so it
  // becomes live the moment plugin loading moves behind real isolation. The gate
  // only triggers in the real Tauri webview — not in the unit-test DOM or the
  // browser Demo, where the existing integrity/permission scenarios still run.
  // Listing the directory first is deliberate: it reads no plugin code and every
  // vault open already lists directories, but it is what lets us tell "the user
  // has plugins that cannot load" from "the user has no plugins at all".
  if (!isPluginImportAllowedByCsp()) {
    signalPluginLoadingDisabledByCsp()
    void flushAuditLogToFile()
    return
  }

  // Governance/trust state (revocations, versions, ranges, trusted key, trusted
  // sources, digests) is persisted in a MAC-protected vault file. Load it now that
  // we're scoping to this vault — after the CSP gate so a CSP-blocked build does
  // not touch the file system. On a MAC failure this refuses the contained trust.
  await loadGovernanceFile(vault)

  // Phase 1 — parallel, independent per-plugin work (manifest + code + digest).
  // No import happens here; execution is deferred until after the gates below.
  const preloaded = await runBounded(
    pluginDirs.map((name) => () => preloadVaultPlugin(adapter, vault, name)),
    MAX_PARALLEL_PLUGIN_LOADS,
  )
  // Deterministic registration order for the UI, independent of IO timing.
  preloaded.sort((a, b) => (a.meta?.id ?? a.dirName).localeCompare(b.meta?.id ?? b.dirName))

  // Re-approval for the host's quarantine ("crash-restart-on-unstable"). The host
  // refuses to activate a plugin marked unstable until it is explicitly reset, and
  // deactivating cannot do it: markPluginUnstable already removed the plugin from
  // the host's active map, so `deactivatePlugin` (and therefore
  // `deactivateVaultPlugins`) returns early and the flag used to survive a vault
  // switch forever. Loading a vault IS the re-approval the refusal message asks
  // for — a deliberate user action (open/switch a library, or reload on the
  // message's advice) — and it only drops the stability quarantine: the plugin is
  // imported and activated again only if it passes every gate below (revocation,
  // version policy, consent, trust, integrity).
  for (const p of preloaded) {
    if (p.meta) resetUnstableVaultPlugin(p.meta.id)
  }

  // Phase 2 — sequential permission confirmation (user dialog) + integrity
  // verification, THEN the gated import. Collect the consented plugins for
  // concurrent activation.
  const integrityStore = makeVaultIntegrityStore(vault)
  const consented: PreloadedPlugin[] = []
  for (const p of preloaded) {
    // A directory without a manifest is not a plugin; drop it quietly.
    if (p.skip) continue
    if (p.error) {
      notifyError(describePluginError(p.error))
      continue
    }
    const meta = p.meta
    const source = p.source
    if (!meta || !source) continue

    // GATE 0 — revocation, BEFORE any execution. A revoked plugin (id or version
    // /range) is refused here with the recorded reason, so its module is never
    // imported. Non-silent: audited + surfaced via the error channel.
    const rev = isPluginRevoked(meta.id, meta.version)
    if (rev.revoked) {
      recordPluginEvent(meta.id, 'revoked', rev.reason ?? 'revoked', { version: meta.version, sanitize: true })
      const refused = governanceRefusal(
        meta.id,
        'revoked',
        `Plugin "${meta.name}" has been revoked${rev.reason ? `: ${rev.reason}` : ''} and will not be loaded.`,
        'Remove or update the plugin, or unrevoke it if you trust the new version.',
      )
      notifyError(describePluginError(refused))
      continue
    }

    // GATE 0.5 — version policy. A version outside the configured supported range,
    // or one recorded as bad, is refused before any execution. A rollback point
    // (last-known-good) is surfaced so the user can make an informed decision.
    if (!isVersionAllowed(meta.id, meta.version)) {
      recordPluginEvent(meta.id, 'version-refused', `version ${meta.version} is not allowed`, { version: meta.version })
      const point = rollbackPoint(meta.id)
      const refused = governanceRefusal(
        meta.id,
        'version-refused',
        `Plugin "${meta.name}" version ${meta.version} is outside the supported range or is a known-bad version.`,
        point
          ? `Roll back to ${point.version} (BEST-EFFORT: it still must pass the digest/trust gate) or update the plugin.`
          : 'Update the plugin to a supported version, or remove it.',
      )
      notifyError(describePluginError(refused))
      continue
    }

    // GATE 1 — permission consent BEFORE any execution. Only capabilities
    // declared in the manifest are known pre-import; those are the trust
    // contract. A denial here means the module is never imported.
    const preManifest = { permissions: meta.permissions } as PluginDefinition
    if (!(await askPluginPermission(meta, preManifest, vault))) {
      const declared = collectPluginPermissions(meta, preManifest)
      recordPluginEvent(meta.id, 'permission-denied', `declared permissions: ${declared.join(', ') || 'none'}`, { version: meta.version })
      notifyError(
        describePluginError(
          createPluginError('PLUGIN_PERMISSION_DENIED', {
            pluginId: meta.id,
            message:
              declared.length > 0
                ? `Plugin "${meta.name}" requires permission(s): ${declared.join(', ')} but consent was not granted.`
                : t('plugin.permissionSkipped', { name: meta.name }),
            // A denial is cached for the session (see permissionDecisions), so
            // reloading the vault cannot re-ask — only a restart starts a session
            // where the plugin is asked about again.
            recovery: 'Restart NekoWrite to be asked again (a denial is remembered for this session), or remove the plugin.',
          }),
        ),
      )
      continue
    }

    // GATE 1.5 — trust / source authenticity BEFORE any execution. An invalid
    // signature is refused outright (never imported); an unsigned plugin is
    // never silently trusted — it is flagged as unsigned/untrusted-source, or,
    // under the strict policy, must be explicitly trusted (allowlist/decider).
    const trust = await decidePluginTrust(meta, p.signature, p.signaturePayload)
    if (trust.action === 'deny') {
      if (trust.error.code === 'PLUGIN_SIGNATURE_INVALID') {
        recordPluginEvent(meta.id, 'signature-invalid', trust.error.message, { version: meta.version, sanitize: true })
      } else if (trust.error.code === 'PLUGIN_UNSIGNED_UNTRUSTED') {
        recordPluginEvent(meta.id, 'import-refused', 'unsigned and not from a trusted source', { version: meta.version })
      }
      notifyError(describePluginError(trust.error))
      continue
    }

    // GATE 2 — integrity BEFORE any execution. Refuse to silently run a plugin
    // whose code/manifest changed since it was approved. First approval records
    // the baseline; a mismatch is surfaced (re-approve/deny) instead of auto-run.
    let baseline: { id: string; version: string; digest: string } | null = null
    const digest = p.digest
    if (digest) {
      const verdict = verifyPluginIntegrity(meta.id, digest, integrityStore)
      if (verdict === 'mismatch') {
        const expected = getRecordedDigest(vault, meta.id)
        const reapprove = await askReapproveIntegrity(meta, expected ?? '', digest)
        if (!reapprove) {
          recordPluginEvent(meta.id, 'verify-failed', 'code/manifest changed since approval; refused', { version: meta.version })
          notifyError(
            describePluginError(
              createPluginError('PLUGIN_VERIFY_FAILED', {
                pluginId: meta.id,
                message: `Plugin "${meta.name}"'s code or manifest changed since you approved it; refusing to run it.`,
                recovery: 'Re-approve it only if you trust the new version, or reinstall the plugin.',
              }),
            ),
          )
          continue
        }
        // Re-approved: adopt the new fingerprint as the baseline after import succeeds.
        baseline = { id: meta.id, version: meta.version, digest }
      } else if (verdict === 'missing') {
        // First approval in this store: record the baseline fingerprint after import succeeds.
        baseline = { id: meta.id, version: meta.version, digest }
      }
    }

    // GATE 3 — the import (LAST action before activation). Only reached after
    // consent + integrity pass, so a tampered/unapproved plugin's top-level
    // module code never executes.
    const importer: DynamicImport = () => importSource(source)
    let loadResult: LoadResult
    try {
      loadResult = await loadPlugin(meta, importer)
    } catch (e) {
      // loadPlugin normally swallows load errors into an ok:false result, but a
      // dynamic-import rejection can still escape — classify it the same way
      // instead of bubbling and aborting the whole scan.
      notifyError(describePluginError(loadFailure(meta, e instanceof Error ? e.message : String(e))))
      continue
    }
    if (!loadResult.ok) {
      notifyError(describePluginError(loadFailure(meta, loadResult.error)))
      continue
    }
    const definition = loadResult.definition

    // The gated import ran (plugin code executed). Record the loaded version +
    // digest and the load audit event so the governance policy can reason about
    // future loads (version range, rollback, revocation).
    recordPluginVersion(meta.id, meta.version, digest)
    recordPluginEvent(meta.id, 'load', 'loaded', { version: meta.version })
    scheduleGovernanceSave()
    void flushAuditLogToFile()

    // Post-import defensive consent: a plugin may declare capabilities in its
    // code that were not in the manifest. Re-verify the merged set so a
    // code-level declaration is still consent-gated. (Top-level has run by now,
    // but we refuse to register/activate the plugin and surface the denial.)
    if (!(await askPluginPermission(meta, definition, vault))) {
      const declared = collectPluginPermissions(meta, definition)
      recordPluginEvent(meta.id, 'permission-denied', `declared permissions: ${declared.join(', ') || 'none'}`, { version: meta.version })
      notifyError(
        describePluginError(
          createPluginError('PLUGIN_PERMISSION_DENIED', {
            pluginId: meta.id,
            message:
              declared.length > 0
                ? `Plugin "${meta.name}" requires permission(s): ${declared.join(', ')} but consent was not granted.`
                : t('plugin.permissionSkipped', { name: meta.name }),
            // A denial is cached for the session (see permissionDecisions), so
            // reloading the vault cannot re-ask — only a restart starts a session
            // where the plugin is asked about again.
            recovery: 'Restart NekoWrite to be asked again (a denial is remembered for this session), or remove the plugin.',
          }),
        ),
      )
      continue
    }

    // Point-of-use guard: re-verify every declared permission is present before
    // activation; a missing capability rejects loudly instead of silently
    // proceeding. Today consent is all-or-nothing, so the granted set equals the
    // declared set — this is where a future per-capability grant is enforced.
    const granted = collectPluginPermissions(meta, definition)
    for (const permission of granted) {
      assertPermission({ permissions: granted }, permission, {
        pluginId: meta.id,
        detail: 'activate its declared capabilities',
      })
    }

    // Adopt the (re-)approved fingerprint as the new baseline now that we have
    // committed to running this plugin.
    if (baseline) setRecordedDigest(vault, baseline.id, baseline.version, baseline.digest)

    // A declared capability is not capability-isolated while the plugin runs in
    // the main window; once we have decided to run it, make that explicit rather
    // than pretending to sandbox it.
    const nonIsolated = getNonIsolatedPermissions(meta, definition)
    signalUnsandboxedCapabilities(meta, nonIsolated)
    p.loadResult = loadResult
    consented.push(p)
  }

  // Phase 3 — parallel activation of the consented plugins, results recorded in
  // deterministic (consented) order. An activation rejection is captured into an
  // ok:false result so one failing plugin cannot abort the rest. Each activation
  // is time-boxed (async init that exceeds the budget is cancelled and the plugin
  // marked unstable), and a single AbortController lets the host cancel a running
  // activation (e.g. when the user switches vaults). A timeout/cancel leaves the
  // plugin deactivated and the host continues.
  const activationController = new AbortController()
  const activated = await runBounded(
    consented.map((p) => async () => {
      const loadResult = p.loadResult as LoadResult
      const res = await activatePlugin(loadResult, {
        signal: activationController.signal,
        timeoutMs: DEFAULT_PLUGIN_ACTIVATION_TIMEOUT_MS,
      }).catch((e) => ({
        ok: false as const,
        id: loadResult.id,
        error: e instanceof Error ? e.message : String(e),
        code: undefined as PluginErrorCode | undefined,
      }))
      return { meta: p.meta as PluginMeta, res }
    }),
    MAX_PARALLEL_PLUGIN_LOADS,
  )
  for (const { meta, res } of activated) {
    if (!res.ok) {
      // A structured timeout/cancel is routed to a distinct message; anything
      // else is a generic activation failure. In all cases the plugin was
      // already rolled back/marked unstable by the host, so the host continues.
      const code = res.code
      const error =
        code === 'PLUGIN_HOOK_TIMEOUT'
          ? createPluginError('PLUGIN_HOOK_TIMEOUT', {
              pluginId: res.id,
              message: `Plugin "${meta.name}" exceeded its activation time budget and was cancelled.`,
              recovery: 'Disable the plugin or check its logs.',
            })
          : code === 'PLUGIN_ABORTED'
            ? createPluginError('PLUGIN_ABORTED', {
                pluginId: res.id,
                message: `Plugin "${meta.name}" activation was cancelled.`,
                recovery: 'Retry activation, or disable the plugin.',
              })
            : code === 'PLUGIN_UNSTABLE'
              ? createPluginError('PLUGIN_UNSTABLE', {
                  pluginId: res.id,
                  message: `Plugin "${meta.name}" is in an unstable state and requires re-approval before it can run again.`,
                  recovery: 'Re-approve it by reloading the vault: a reload resets the quarantine and retries it.',
                })
              : code === 'PLUGIN_QUOTA_EXCEEDED'
                ? createPluginError('PLUGIN_QUOTA_EXCEEDED', {
                    pluginId: res.id,
                    message: `Plugin "${meta.name}" exceeded its session resource quota and was deactivated; re-approve it to run again.`,
                    recovery: 'Re-approve it by reloading the vault to grant a fresh session budget.',
                  })
                : createPluginError('PLUGIN_ACTIVATE_FAILED', {
                    pluginId: res.id,
                    message: `Plugin "${meta.name}" failed to activate: ${res.error ?? ''}`,
                    recovery: 'Disable and re-enable the plugin, or reinstall it.',
                  })
      notifyError(describePluginError(error))
      console.warn(`[NekoWite] vault plugin failed to activate: ${res.id}`, error)
      continue
    }
    activeVaultPluginIds.push(res.id)
    console.info(`[NekoWite] vault plugin activated: ${res.id}`)
  }
  // Flush the audit log to its file (best-effort) so the activate/deactivate/
  // crash decisions recorded during this scan reach the persisted file, reflecting
  // the full load + activation cycle rather than only the initial loads.
  void flushAuditLogToFile()
}
