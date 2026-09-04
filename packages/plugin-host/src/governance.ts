import { createPluginError, type PluginErrorCode } from './types'
import { encodePluginKeyMaterial } from './loader'

/* ------------------------------------------------------------------------- *
 * Plugin governance: audit log, version policy / rollback, & revocation.
 *
 * These are the *policy* functions that sit on top of the loader/trust/integrity
 * gates. They are environment-agnostic (no `localStorage`, no `node:fs`, no Tauri
 * IPC): all persistent state is held in memory and exposed via a deliberate
 * serialize/load surface so an embedding host (the desktop app) can persist it to
 * its own store (localStorage) and/or to a file through its file service. This is
 * the same injection pattern the loader uses for `PluginFsAdapter` /
 * `PluginDigestStore`.
 *
 * Honest scope (documented in docs/SECURITY.md + docs/PLUGIN_SDK.md):
 *   - The audit log is a structured, NON-SECRET trail. It records *what happened*
 *     to a plugin (load/activate/deactivate/timeout/crash/revoke/...), never the
 *     bytes of a key or token. `recordPluginEvent` sanitizes `detail` defensively;
 *     callers are additionally required never to pass secrets.
 *   - Version policy / rollback is BEST-EFFORT, NOT isolation. Because the host
 *     can only run code in-window (no sandbox), it will NEVER auto-run a rolled
 *     back version: a `rollbackPoint` result carries `requiresReapproval: true`
 *     and the embedder must subject it to the same digest + trust gate as any
 *     other plugin before it runs. We surface the last-known-good version so the
 *     user can make an informed decision; we do not pretend to sandbox old code.
 *   - Revocation is enforced at load, BEFORE any import.
 * ------------------------------------------------------------------------- */

/* ----------------------------- audit log ------------------------------ */

/** The auditable plugin lifecycle / governance events. The consumer-facing set in
 *  the task (load/activate/deactivate/timeout/signature-invalid/crash) is a
 *  subset; the union is kept a superset so every governance refusal is logged. */
export type PluginAuditEventType =
  | 'load'
  | 'activate'
  | 'deactivate'
  | 'timeout'
  | 'crash'
  | 'cancel'
  | 'signature-invalid'
  | 'revoked'
  | 'version-refused'
  | 'verify-failed'
  | 'permission-denied'
  | 'unstable'
  | 'quota-exceeded'
  | 'reset-unstable'
  | 'import-refused'

/** Human-readable label for each audit event, for a surface/UI. */
export const PLUGIN_AUDIT_EVENT_LABELS: Record<PluginAuditEventType, string> = {
  load: 'loaded',
  activate: 'activated',
  deactivate: 'deactivated',
  timeout: 'timed out',
  crash: 'crashed',
  cancel: 'cancelled',
  'signature-invalid': 'signature invalid',
  revoked: 'revoked',
  'version-refused': 'version refused',
  'verify-failed': 'verification failed',
  'permission-denied': 'permission denied',
  unstable: 'unstable',
  'quota-exceeded': 'quota exceeded',
  'reset-unstable': 'reset (re-approved)',
  'import-refused': 'import refused',
}

/** A single, structured, non-secret audit record. */
export interface PluginAuditEvent {
  /** Monotonic sequence number, unique within a session. */
  seq: number
  epoch: number
  pluginId: string
  event: PluginAuditEventType
  /** Optional, SANITIZED human-readable detail (redacted for secrets). */
  detail?: string
  /** The plugin version at the time of the event, if known. */
  version?: string
}

const MAX_AUDIT_EVENTS = 500

let auditSeq = 0
const auditRing: PluginAuditEvent[] = []

type PluginAuditListener = (e: PluginAuditEvent) => void
const auditListeners = new Set<PluginAuditListener>()

/**
 * Defensive secret redaction for audit `detail`. Never trust a caller not to
 * pass a secret: we redact bearer tokens, provider API-key prefixes, long hex
 * blobs (signatures, shared secrets) and quoted `key`/`token`/`secret` values.
 * A caller who deliberately passes a secret still gets a redacted value.
 */
export function sanitizeAuditDetail(detail?: string): string | undefined {
  if (detail === undefined || detail === null) return undefined
  let out = String(detail)
  // Bearer tokens.
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]')
  // Provider / platform API keys (sk-…, ghp_…, xoxb-…, AIza…, etc.).
  out = out.replace(
    /\b(sk|pk|rk|ghp|gho|github_pat|xox[baprs]?|AIza|AKIA|ASIA)[A-Za-z0-9_-]{8,}\b/gi,
    '$1_[redacted]',
  )
  // Long hex blobs: HMAC signatures (64 hex), shared secrets, digests over 24 hex.
  out = out.replace(/\b[0-9a-fA-F]{24,}\b/g, '[redacted]')
  // Quoted/assigned sensitive field values (api_key, token, secret, password, authorization).
  out = out.replace(
    /(["']?)(api[_-]?key|token|secret|password|authorization|auth)["']?\s*[:=]\s*["'][^"']*["']/gi,
    '$1$2=[redacted]',
  )
  return out
}

/** Record a structured, non-secret audit event. Delivers to every subscriber
 *  (isolated: a throwing subscriber never breaks the others) and appends to the
 *  in-memory ring. Returns the recorded event. */
export function recordPluginEvent(
  pluginId: string,
  event: PluginAuditEventType,
  detail?: string,
  opts?: { version?: string; sanitize?: boolean },
): PluginAuditEvent {
  const sanitize = opts?.sanitize ?? true
  const record: PluginAuditEvent = {
    seq: ++auditSeq,
    epoch: Date.now(),
    pluginId,
    event,
    detail: sanitize ? sanitizeAuditDetail(detail) : (detail ?? undefined),
    ...(opts?.version !== undefined ? { version: opts.version } : {}),
  }
  auditRing.push(record)
  if (auditRing.length > MAX_AUDIT_EVENTS) auditRing.splice(0, auditRing.length - MAX_AUDIT_EVENTS)
  for (const listener of [...auditListeners]) {
    try {
      listener(record)
    } catch {
      // isolation: a subscriber that throws must not break delivery to the rest.
    }
  }
  return record
}

/** Subscribe to audit events. Returns an unsubscribe function. */
export function onPluginEvent(listener: PluginAuditListener): () => void {
  auditListeners.add(listener)
  return () => {
    auditListeners.delete(listener)
  }
}

/** A copy of the in-memory audit ring, newest-last. */
export function getAuditLog(): PluginAuditEvent[] {
  return [...auditRing]
}

/** The audit events recorded for a single plugin id. */
export function getPluginAuditEvents(pluginId: string): PluginAuditEvent[] {
  return auditRing.filter((e) => e.pluginId === pluginId)
}

/** The most recent audit event, or undefined when the log is empty. */
export function getLastAuditEvent(): PluginAuditEvent | undefined {
  return auditRing[auditRing.length - 1]
}

/** Clear the in-memory audit ring (start a fresh log for a new session). */
export function clearAuditLog(): void {
  auditRing.length = 0
}

/* ----------------------- audit log -> file sink ----------------------- */

/** A minimal async file sink so the audit log can be persisted through the app's
 *  file service (fsService) when one is available. The embedder configures it;
 *  without one the audit log stays in memory only (still subscribable + testable).
 *  An optional `exists` lets the loader skip a first-run load silently instead of
 *  warning on a file that is not present yet. */
export interface AuditLogFileSink {
  path: string
  exists?(path: string): Promise<boolean>
  read(path: string): Promise<string>
  write(path: string, content: string): Promise<void>
}

let auditLogSink: AuditLogFileSink | null = null

/** Configure (or clear) the file sink used by flushAuditLogToFile/loadAuditLogFromFile. */
export function setAuditLogFileSink(sink: AuditLogFileSink | null): void {
  auditLogSink = sink
}

/** The currently-configured audit log file sink (or null). */
export function getAuditLogFileSink(): AuditLogFileSink | null {
  return auditLogSink
}

/** Serialize the current audit ring to JSON (for persistence). */
export function serializeAuditLog(): string {
  return JSON.stringify(auditRing)
}

/** Persist the audit ring to the configured sink. Returns true on success; a
 *  missing/no-op sink or a write failure returns false (logged, never thrown). */
export async function flushAuditLogToFile(): Promise<boolean> {
  if (!auditLogSink) return false
  try {
    await auditLogSink.write(auditLogSink.path, serializeAuditLog())
    return true
  } catch (err) {
    console.warn('[NekoWite:governance] failed to persist plugin audit log', err)
    return false
  }
}

/** Load a persisted audit log from the configured sink and merge it into the ring
 *  (deduped by sequence number, so re-loading the same file is idempotent). */
export async function loadAuditLogFromFile(): Promise<boolean> {
  if (!auditLogSink) return false
  // A first-run/later-run log that does not exist yet is a silent skip — do not
  // warn about a file we never wrote.
  if (auditLogSink.exists) {
    let present = false
    try {
      present = await auditLogSink.exists(auditLogSink.path)
    } catch {
      present = false
    }
    if (!present) return false
  }
  try {
    const raw = await auditLogSink.read(auditLogSink.path)
    // Any content that is not a JSON array of events is treated as an EMPTY log:
    // this is how a first run (file absent), a stale/libwebfs path mismatch, or a
    // read that happens to open a Markdown note (e.g. `# Welcome`) is absorbed
    // WITHOUT throwing and WITHOUT ever clobbering the file. We never log a
    // warning for it — failing to LOAD history never blocks recording NEW events.
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return false
    }
    if (!Array.isArray(parsed)) return false
    for (const e of parsed as PluginAuditEvent[]) {
      if (!e || typeof e.seq !== 'number' || typeof e.event !== 'string') continue
      if (auditSeq < e.seq) auditSeq = e.seq
      if (!auditRing.some((cur) => cur.seq === e.seq) && !auditRing.includes(e)) {
        auditRing.push(e)
      }
    }
    if (auditRing.length > MAX_AUDIT_EVENTS) auditRing.splice(0, auditRing.length - MAX_AUDIT_EVENTS)
    return true
  } catch {
    // A read failure (missing file, fs error) is also a silent skip — never a
    // warning, never a throw, and it never blocks recording new events.
    return false
  }
}

/* ------------------------ integrity envelope (MAC) --------------------- */

/** A MAC-framed envelope for a JSON payload: `payload` is the exact serialized
 *  string the MAC covers, `mac` is a hex HMAC-SHA256 over it keyed by a
 *  per-install secret.
 *
 *  Honest scope (documented in docs/SECURITY.md + docs/PLUGIN_SDK.md): this is
 *  TAMPER-DETECTION, not a secure root. The same secret that protects the payload
 *  is stored alongside it (or derived per-install and persisted in a sibling file),
 *  so a party with full file access can recompute the MAC. It detects casual
 *  corruption / stale reads and a localStorage-only attacker who cannot read the
 *  key, but is NOT a hardware root of trust. On a MAC failure the caller MUST
 *  treat the contained trust as reset/trust-nothing (never silently trust). */
export interface MacEnvelope {
  /** The exact serialized payload string the MAC covers. */
  payload: string
  /** Hex HMAC-SHA256 of `payload`. */
  mac: string
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

async function importMacKey(secret: string): Promise<CryptoKey> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle
  if (!subtle) {
    throw createPluginError('PLUGIN_SIGNATURE_INVALID', {
      pluginId: '',
      message: 'Web Crypto is unavailable in this environment; cannot protect governance state.',
      recovery: 'Run the plugin host in an environment with Web Crypto.',
    })
  }
  const keyBytes = encodePluginKeyMaterial(secret)
  return subtle.importKey('raw', keyBytes as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

/** Produce a MAC-framed envelope: a hex HMAC-SHA256 over `payload`, keyed by
 *  `secret`. Environment-agnostic (Web Crypto), so it is testable in a browser
 *  webview and in Node. */
export async function createMacEnvelope(payload: string, secret: string): Promise<MacEnvelope> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle
  if (!subtle) throw new Error('Web Crypto is unavailable; cannot protect governance state.')
  const key = await importMacKey(secret)
  const data = new TextEncoder().encode(payload)
  const sig = new Uint8Array(await subtle.sign('HMAC', key, data as BufferSource))
  return { payload, mac: bytesToHex(sig) }
}

/** Verify a MAC-framed envelope. Returns false (never throws) on any structural
 *  or MAC mismatch, so a tampered or corrupt payload is detected and refused. */
export async function verifyMacEnvelope(envelope: unknown, secret: string): Promise<boolean> {
  if (!envelope || typeof envelope !== 'object') return false
  const e = envelope as Partial<MacEnvelope>
  if (typeof e.payload !== 'string' || typeof e.mac !== 'string' || e.mac.length !== 64) return false
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle
  if (!subtle) return false
  try {
    const key = await importMacKey(secret)
    const data = new TextEncoder().encode(e.payload)
    const sig = hexToBytes(e.mac)
    return await subtle.verify('HMAC', key, sig as BufferSource, data as BufferSource)
  } catch {
    return false
  }
}

/** Generate a fresh 32-byte per-install secret, hex-encoded. Used to key the
 *  governance MAC envelope when no OS keychain is available. */
export function generateMacSecret(): string {
  const bytes = new Uint8Array(32)
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  return bytesToHex(bytes)
}

/* ------------------------------ semver -------------------------------- */

export interface SemVer {
  major: number
  minor: number
  patch: number
}

/** Parse a `major.minor.patch` version (an optional leading `v` is accepted).
 *  Pre-release/build metadata after `-`/`+` is ignored for comparison. Returns
 *  null for anything that is not a well-formed `d.d.d` version. */
export function parseSemver(version: string): SemVer | null {
  const m = String(version).trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/i)
  if (!m) return null
  return { major: parseInt(m[1], 10), minor: parseInt(m[2], 10), patch: parseInt(m[3], 10) }
}

function compareSemver(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  return a.patch - b.patch
}

function satisfiesToken(version: string, token: string): boolean {
  if (token === '*' || token === 'x' || token === 'X') return true
  const v = parseSemver(version)
  if (!v) return false
  // Wildcard ranges like "1.x", "1.2.*".
  if (/(^|[.])x$/i.test(token) || token.includes('*')) {
    const parts = token.replace(/[v ^~]/g, '').split('.')
    if (parts[0] && parts[0] !== '*' && parts[0] !== 'x' && Number(parts[0]) !== v.major) return false
    if (parts[1] && parts[1] !== '*' && parts[1] !== 'x' && Number(parts[1]) !== v.minor) return false
    if (parts[2] && parts[2] !== '*' && parts[2] !== 'x' && Number(parts[2]) !== v.patch) return false
    return true
  }
  // Caret range: >= base and < (major+1).0.0.
  if (token.startsWith('^')) {
    const base = parseSemver(token.slice(1))
    if (!base) return false
    const upper: SemVer = { major: base.major + 1, minor: 0, patch: 0 }
    return compareSemver(v, base) >= 0 && compareSemver(v, upper) < 0
  }
  // Tilde range: >= base and < major.(minor+1).0.
  if (token.startsWith('~')) {
    const base = parseSemver(token.slice(1))
    if (!base) return false
    const upper: SemVer = { major: base.major, minor: base.minor + 1, patch: 0 }
    return compareSemver(v, base) >= 0 && compareSemver(v, upper) < 0
  }
  let op = '='
  let rest = token
  const m = token.match(/^(>=|<=|>|<|=)?\s*(.+)$/)
  if (m && m[1]) {
    op = m[1]
    rest = m[2]
  }
  const target = parseSemver(rest)
  if (!target) return false
  const cmp = compareSemver(v, target)
  if (op === '>=') return cmp >= 0
  if (op === '<=') return cmp <= 0
  if (op === '>') return cmp > 0
  if (op === '<') return cmp < 0
  return cmp === 0
}

/** True when `version` satisfies `range`. Supports: exact, `all`, `||`,
 *  whitespace/comma-separated comparator sets (`>=1.0.0 <2.0.0`), caret (`^1.0.0`),
 *  tilde (`~1.2.0`) and x-ranges (`1.x`, `1.2.*`). */
export function versionSatisfies(version: string, range: string): boolean {
  const r = String(range).trim()
  if (r === 'all' || r === '*') return true
  if (String(version).trim() === r) return true
  if (r.includes('||')) return r.split('||').some((part) => versionSatisfies(version, part.trim()))
  const tokens = r.split(/[,\s]+/).filter(Boolean)
  if (tokens.length === 0) return false
  return tokens.every((tok) => satisfiesToken(version, tok))
}

/* --------------------------- version policy --------------------------- */

/** An inclusive-or-open lower/upper bound for a plugin's supported versions.
 *  `min`/`max` are `major.minor.patch` (or a comparator like `>=1.2.0`). */
export interface PluginVersionRange {
  min?: string
  max?: string
}

export interface RecordedPluginVersion {
  version: string
  digest?: string
  timestamp: number
}

/** Where the persisted governance state lives (in-memory by default; the
 *  embedder may back it with localStorage / a file via serialize/load). */
interface GovernanceState {
  /** pluginId -> version -> { digest, timestamp } for every recorded version. */
  recordedPlugins: Record<string, Record<string, RecordedPluginVersion>>
  /** pluginId -> the order versions were recorded (used for last-known-good). */
  recordedOrder: Record<string, string[]>
  badVersions: Record<string, string[]>
  versionRanges: Record<string, PluginVersionRange>
  revocations: PluginRevocation[]
}

const state: GovernanceState = {
  recordedPlugins: {},
  recordedOrder: {},
  badVersions: {},
  versionRanges: {},
  revocations: [],
}

/** Record the version + digest the host is about to load for a plugin. Because a
 *  successful load implies it passed the gates, this contributes to the
 *  last-known-good baseline (unless that version is later marked bad). */
export function recordPluginVersion(pluginId: string, version: string, digest?: string): void {
  const byVersion = state.recordedPlugins[pluginId] ?? {}
  byVersion[version] = { version, digest, timestamp: Date.now() }
  state.recordedPlugins[pluginId] = byVersion
  const order = state.recordedOrder[pluginId] ?? []
  if (!order.includes(version)) order.push(version)
  state.recordedOrder[pluginId] = order
}

/** The most recently recorded version (+ digest) for a plugin, if any. */
export function getRecordedPluginVersion(pluginId: string): RecordedPluginVersion | undefined {
  const order = state.recordedOrder[pluginId] ?? []
  const latest = order[order.length - 1]
  if (!latest) return undefined
  return state.recordedPlugins[pluginId]?.[latest]
}

/** Mark a plugin version as bad (e.g. known-broken or withdrawn). A bad version
 *  is never a rollback target and is refused on load. Returns true when the
 *  version becomes disallowed. */
export function markBadVersion(pluginId: string, version: string): boolean {
  const list = state.badVersions[pluginId] ?? []
  if (!list.includes(version)) list.push(version)
  state.badVersions[pluginId] = list
  return isVersionAllowed(pluginId, version) === false
}

/** The versions recorded as bad for a plugin. */
export function getBadPluginVersions(pluginId: string): string[] {
  return [...(state.badVersions[pluginId] ?? [])]
}

/** Configure the min/max supported version range for a plugin. A version outside
 *  this range is refused on load. */
export function setPluginVersionRange(pluginId: string, range: PluginVersionRange): void {
  state.versionRanges[pluginId] = range
}

/** The configured supported-version range for a plugin, if any. */
export function getPluginVersionRange(pluginId: string): PluginVersionRange | undefined {
  return state.versionRanges[pluginId]
}

function withinRange(version: string, range: PluginVersionRange): boolean {
  if (!range.min && !range.max) return true
  const minOk = !range.min || versionSatisfies(version, range.min.startsWith('>') || range.min.startsWith('<') ? range.min : `>=${range.min}`)
  const maxOk = !range.max || versionSatisfies(version, range.max.startsWith('<') || range.max.startsWith('>') ? range.max : `<=${range.max}`)
  return minOk && maxOk
}

/** True when a plugin version may be loaded: it is not a recorded bad version and
 *  it falls within the configured supported range (if any). */
export function isVersionAllowed(pluginId: string, version: string): boolean {
  const bad = state.badVersions[pluginId] ?? []
  if (bad.includes(version)) return false
  const range = state.versionRanges[pluginId]
  if (range && !withinRange(version, range)) return false
  return true
}

/** The last-known-good version for a plugin (the most recent recorded version
 *  that was not later marked bad), or undefined. */
export function getLastKnownGoodVersion(pluginId: string): string | undefined {
  const order = state.recordedOrder[pluginId] ?? []
  const bad = new Set(state.badVersions[pluginId] ?? [])
  for (let i = order.length - 1; i >= 0; i--) {
    if (!bad.has(order[i])) return order[i]
  }
  return undefined
}

/**
 * The rollback point for an unstable plugin: the last-known-good version + its
 * recorded digest, if any. `rollbackPoint` NEVER auto-runs: a host that uses it
 * must first subject the rolled-back version to the same digest + trust gate as
 * any other plugin (see `PLUGIN_SDK.md` § rollback honesty). Returns null when
 * there is no recorded good baseline to fall back to.
 */
export function rollbackPoint(
  pluginId: string,
): { version: string; digest?: string; requiresReapproval: true } | null {
  const version = getLastKnownGoodVersion(pluginId)
  if (!version) return null
  const digest = state.recordedPlugins[pluginId]?.[version]?.digest
  return { version, digest, requiresReapproval: true }
}

/* ----------------------------- revocation ----------------------------- */

/** A revoked plugin id (and optionally a specific version or semver range). */
export interface PluginRevocation {
  pluginId: string
  /** 'all' (default), an exact version, or a semver range (e.g. '<2.0.0'). */
  version: string
  reason?: string
  revokedAt: number
}

/** Revoke a plugin id (all versions) or a specific version/range. A revoked
 *  plugin is refused at load, BEFORE any import, with a clear reason. */
export function revokePlugin(pluginId: string, version: string = 'all', reason?: string): void {
  const existing = state.revocations.find((r) => r.pluginId === pluginId && r.version === version)
  if (existing) {
    existing.reason = reason ?? existing.reason
    existing.revokedAt = Date.now()
    return
  }
  state.revocations.push({ pluginId, version, reason, revokedAt: Date.now() })
}

/** Remove a revocation (defaults to the 'all' entry for a plugin id). */
export function unrevokePlugin(pluginId: string, version: string = 'all'): void {
  state.revocations = state.revocations.filter((r) => !(r.pluginId === pluginId && r.version === version))
}

/** A copy of the current revocation list. */
export function getRevokedPlugins(): PluginRevocation[] {
  return state.revocations.map((r) => ({ ...r }))
}

/** The union of every plugin id referenced by any governance record (recorded
 *  version, bad version, version range, or revocation). Used by an embedder to
 *  enumerate the governance state for a surface. */
export function getGovernancePluginIds(): string[] {
  const ids = new Set<string>([
    ...Object.keys(state.recordedOrder),
    ...Object.keys(state.badVersions),
    ...Object.keys(state.versionRanges),
    ...state.revocations.map((r) => r.pluginId),
  ])
  return [...ids]
}

/** Whether a specific plugin version is revoked. Returns a structured result so
 *  the host can surface the recorded reason, never silently. */
export function isPluginRevoked(
  pluginId: string,
  version: string,
): { revoked: boolean; reason?: string; matching?: PluginRevocation } {
  const matching = state.revocations.find((r) => r.pluginId === pluginId && versionSatisfies(version, r.version))
  if (!matching) return { revoked: false }
  return { revoked: true, reason: matching.reason, matching }
}

/* -------------------- serialization (embedder store) ------------------- */

/** Serialize the governance state (versions, last-good, bad versions, ranges,
 *  revocations) to JSON so an embedder can persist it (localStorage / file). */
export function serializeGovernance(): string {
  return JSON.stringify(state)
}

/** Load a previously-serialized governance snapshot. Entries are merged; a
 *  revoked-id-only entry is preserved atomically. */
export function loadGovernance(json: string): void {
  try {
    const parsed = JSON.parse(json) as Partial<GovernanceState>
    if (parsed.recordedPlugins && typeof parsed.recordedPlugins === 'object') {
      for (const [id, byVersion] of Object.entries(parsed.recordedPlugins)) {
        state.recordedPlugins[id] = { ...(state.recordedPlugins[id] ?? {}), ...byVersion }
      }
    }
    if (parsed.recordedOrder && typeof parsed.recordedOrder === 'object') {
      for (const [id, order] of Object.entries(parsed.recordedOrder)) state.recordedOrder[id] = [...order]
    }
    if (parsed.badVersions && typeof parsed.badVersions === 'object') {
      for (const [id, list] of Object.entries(parsed.badVersions)) state.badVersions[id] = [...list]
    }
    if (parsed.versionRanges && typeof parsed.versionRanges === 'object') Object.assign(state.versionRanges, parsed.versionRanges)
    if (Array.isArray(parsed.revocations)) state.revocations = parsed.revocations.map((r) => ({ ...r }))
  } catch (err) {
    console.warn('[NekoWite:governance] failed to restore governance snapshot', err)
  }
}

/** Reset ALL in-memory governance state (audit ring + versions + revocations) to
 *  a clean baseline. Mainly for tests, and for the embedder to start a fresh
 *  governance session. */
export function resetGovernanceForTests(): void {
  clearAuditLog()
  auditSeq = 0
  auditLogSink = null
  state.recordedPlugins = {}
  state.recordedOrder = {}
  state.badVersions = {}
  state.versionRanges = {}
  state.revocations = []
}

/** A structured refusal for a governance gate (revoked / version-based). The
 *  embedder routes this to a user-facing message with a clear reason. */
export function governanceRefusal(
  pluginId: string,
  kind: 'revoked' | 'version-refused' | 'quota-exceeded',
  detail?: string,
  recovery?: string,
): Error {
  const code: PluginErrorCode =
    kind === 'revoked'
      ? 'PLUGIN_REVOKED'
      : kind === 'version-refused'
        ? 'PLUGIN_VERSION_REFUSED'
        : 'PLUGIN_QUOTA_EXCEEDED'
  const message =
    detail ??
    (kind === 'revoked'
      ? 'This plugin has been revoked and is no longer permitted to run.'
      : kind === 'version-refused'
        ? 'This plugin version is outside the supported version range.'
        : 'This plugin exceeded its session resource quota and must be re-approved.')
  return createPluginError(code, {
    pluginId,
    message,
    recovery: recovery ?? 'Contact the publisher, or reinstall a supported version.',
  })
}
