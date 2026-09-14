/* ------------------------------------------------------------------------- *
 * The plugin audit log: what gets recorded, and the record shape.
 *
 * Honest scope (documented in docs/SECURITY.md + docs/PLUGIN_SDK.md):
 *   - The audit log is a structured, NON-SECRET trail. It records *what happened*
 *     to a plugin (load/activate/deactivate/timeout/crash/revoke/...), never the
 *     bytes of a key or token. `recordPluginEvent` sanitizes `detail` defensively;
 *     callers are additionally required never to pass secrets.
 *
 * The ring is in memory and exposed through a deliberate serialize/load surface
 * (the file sink below) so an embedding host — the desktop app — can persist it
 * to its own store. It is deliberately NOT part of the governance trust-state
 * snapshot (`governance-state.ts`): the log is not secret and does not affect a
 * load decision, so a missing or unreadable log must never block one.
 * ------------------------------------------------------------------------- */

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

/** Drop every piece of audit state this module holds — the ring, the sequence
 *  counter and the configured sink. It is the audit half of
 *  `resetGovernanceForTests`, which cannot reach the module-private counter and
 *  sink from outside; the sequence restarts at 0 because the session it numbered
 *  is gone. */
export function resetAuditLog(): void {
  auditRing.length = 0
  auditSeq = 0
  auditLogSink = null
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
