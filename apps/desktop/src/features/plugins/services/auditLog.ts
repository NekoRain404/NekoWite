/* ------------------------------------------------------------------------- *
 * The embedder half of the plugin audit log, and the app's plugin event/error
 * channels.
 *
 * The audit RING (the events, their labels, the secret redaction, the
 * subscription, the serialize/load surface) belongs to
 * `@nekowite/plugin-host/governance`, which deliberately defines
 * `AuditLogFileSink` as an injection point and leaves configuring it to the
 * host. What is owned here is exactly that: pointing the ring at a vault-relative
 * file through the app's fs service, and routing what the host reports —
 * governance decisions and plugin failures — so none of it is silent.
 *
 * The audit log is a structured, NON-SECRET trail — unlike the MAC-protected
 * governance/trust file (see ./governanceFile), it holds no key material and is
 * not integrity-checked. The two deliberately live in different files.
 * ------------------------------------------------------------------------- */

import {
  getPluginAuditEvents,
  loadAuditLogFromFile,
  onLifecycleError,
  onPluginEvent,
  setAuditLogFileSink,
  setPluginAiProvider,
} from '@nekowite/plugin-host'
import type { AuditLogFileSink, PluginAuditEvent } from '@nekowite/plugin-host'
import { fsService } from '../../../platform/gateways/fs'
import { completeForPlugin } from '../../../services/pluginAi'
import { describePluginError, notifyError } from '../../../services/errors'
import { joinVault } from './discovery'

/** Vault-relative path of the (non-secret) audit log file. */
export const PLUGIN_AUDIT_LOG_FILE = '.nekowite/vault-plugin-audit.log'

let auditRouterOff: (() => void) | null = null

/** Best-effort audit-log file persistence via the app's fs service. Returns the
 *  sink, or null when a writable file service is unavailable (so an environment
 *  without a real fs keeps the in-memory ring + subscription only). */
export function setupVaultAuditLogFile(vault: string): AuditLogFileSink | null {
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
export function disposeVaultAuditLogFile(): void {
  setAuditLogFileSink(null)
}

/** Route audit events so a governance decision is observable (logged, and
 *  surfaced via the error channel for the user-facing refusals). Subscription is
 *  kept separate from the per-refusal notifyError so it never double-notifies at
 *  the exact refusal sites; this is the status/UI channel (exported via
 *  `onPluginEvent`). */
export function setupAuditRouter(): void {
  if (auditRouterOff) return
  auditRouterOff = onPluginEvent((ev) => {
    if (ev.pluginId === '*') return
    console.info(`[NekoWite:audit] plugin "${ev.pluginId}" ${ev.event}${ev.detail ? ` — ${ev.detail}` : ''}`)
  })
}

/** The audit events recorded for a plugin id, newest-last. */
export function getVaultPluginAuditEvents(pluginId: string): PluginAuditEvent[] {
  return getPluginAuditEvents(pluginId)
}

let lifecycleErrorOff: (() => void) | null = null

/**
 * Route plugin failures into the app error channel so they are observable and
 * actionable. The host isolates both a throwing lifecycle hook and a throwing
 * toolbar button / command (see `activatePlugin`), and both report through this
 * one channel - so every plugin failure reaches the user with the plugin's name
 * on it instead of an unhandled exception in a click handler.
 */
export function ensureLifecycleErrorRouter(): void {
  if (lifecycleErrorOff) return
  // The `ai` capability the permission list advertises, backed by the app's own
  // AI service (see services/pluginAi). Installed once per app, not per plugin.
  setPluginAiProvider((id, prompt) => completeForPlugin(id, prompt))
  lifecycleErrorOff = onLifecycleError((ev) => {
    console.error(`[NekoWite] plugin failed plugin="${ev.pluginId}" origin="${ev.event}"`, ev.error)
    notifyError(describePluginError(ev.error))
  })
}

/** Detach the event and lifecycle-error routers (test-only). */
export function resetAuditRouterForTests(): void {
  if (auditRouterOff) {
    auditRouterOff()
    auditRouterOff = null
  }
  if (lifecycleErrorOff) {
    lifecycleErrorOff()
    lifecycleErrorOff = null
  }
}
