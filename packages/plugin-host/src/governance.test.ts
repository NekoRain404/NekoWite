import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearAuditLog,
  flushAuditLogToFile,
  getAuditLog,
  getLastAuditEvent,
  getLastKnownGoodVersion,
  getPluginAuditEvents,
  getPluginVersionRange,
  getRecordedPluginVersion,
  getRevokedPlugins,
  isPluginRevoked,
  isVersionAllowed,
  loadAuditLogFromFile,
  loadGovernance,
  markBadVersion,
  onPluginEvent,
  parseSemver,
  recordPluginEvent,
  recordPluginVersion,
  resetGovernanceForTests,
  revokePlugin,
  rollbackPoint,
  sanitizeAuditDetail,
  serializeAuditLog,
  serializeGovernance,
  setAuditLogFileSink,
  setPluginVersionRange,
  unrevokePlugin,
  versionSatisfies,
} from './governance'

beforeEach(() => {
  resetGovernanceForTests()
})

describe('audit log', () => {
  it('records structured, non-secret events and delivers them to subscribers', () => {
    const seen: string[] = []
    const off = onPluginEvent((e) => seen.push(e.event))
    const rec = recordPluginEvent('@scope/q', 'load', 'loaded', { version: '1.0.0' })
    expect(rec.pluginId).toBe('@scope/q')
    expect(rec.event).toBe('load')
    expect(rec.version).toBe('1.0.0')
    expect(seen).toEqual(['load'])
    off()
  })

  it('is a bounded ring', () => {
    resetGovernanceForTests()
    for (let i = 0; i < 600; i++) recordPluginEvent('p', 'load')
    expect(getAuditLog().length).toBeLessThanOrEqual(500)
  })

  it('exposes per-plugin and last-event reads', () => {
    recordPluginEvent('a', 'activate')
    recordPluginEvent('b', 'deactivate')
    recordPluginEvent('a', 'crash')
    expect(getPluginAuditEvents('a').map((e) => e.event)).toEqual(['activate', 'crash'])
    expect(getLastAuditEvent()?.pluginId).toBe('a')
    expect(getLastAuditEvent()?.event).toBe('crash')
  })

  it('never records token/key material in detail (defensive redaction)', () => {
    const secret = 'sk-live-abcdefghijklmnopqrstuvwxyz'
    const sig = 'a'.repeat(64)
    const rec = recordPluginEvent('p', 'crash', `failed with key=${secret} sig=${sig} Bearer ${'x'.repeat(32)}`)
    expect(rec.detail).not.toContain('abcdefghijklmnopqrstuvwxyz')
    expect(rec.detail).not.toContain(sig)
    expect(rec.detail).toContain('[redacted]')
  })

  it('sanitizeAuditDetail redacts the known secret shapes', () => {
    const out = sanitizeAuditDetail(
      'api_key="sk-abc1234567890" token=1234567890abcdef1234567890abcdef1234 auth=Bearer deadbeef',
    )
    expect(out).not.toMatch(/sk-[A-Za-z0-9]{8,}/)
    expect(out).toContain('[redacted]')
    // A digest (8 hex) is deliberately NOT redacted — digests are not secrets.
    expect(sanitizeAuditDetail('digest=deadbeef')).toBe('digest=deadbeef')
  })

  it('isolates a throwing subscriber', () => {
    const bad = onPluginEvent(() => {
      throw new Error('boom')
    })
    const good = vi.fn()
    onPluginEvent(good)
    expect(() => recordPluginEvent('p', 'load')).not.toThrow()
    expect(good).toHaveBeenCalled()
    bad()
  })

  it('persists to a file sink and reloads idempotently', async () => {
    const writes: string[] = []
    const store = new Map<string, string>()
    setAuditLogFileSink({
      path: '/vault/.nekowite/audit.log',
      read: async (p) => store.get(p) ?? '',
      write: async (p, c) => {
        store.set(p, c)
        writes.push(c)
      },
    })
    recordPluginEvent('a', 'activate')
    await flushAuditLogToFile()
    expect(writes).toHaveLength(1)
    const persisted = JSON.parse(store.get('/vault/.nekowite/audit.log') ?? '[]')
    expect(persisted).toHaveLength(1)
    expect(persisted[0].event).toBe('activate')

    // A fresh host that loads the same file restores the event exactly once.
    resetGovernanceForTests()
    setAuditLogFileSink({
      path: '/vault/.nekowite/audit.log',
      read: async (p) => store.get(p) ?? '',
      write: async () => {},
    })
    await loadAuditLogFromFile()
    expect(getAuditLog()).toHaveLength(1)
    expect(getAuditLog()[0].event).toBe('activate')
  })

  it('skips loading silently when the sink reports the log file does not exist', async () => {
    const read = vi.fn(async () => { throw new Error('should not read') })
    setAuditLogFileSink({
      path: '/vault/.nekowite/audit.log',
      exists: async () => false,
      read,
      write: async () => {},
    })
    await expect(loadAuditLogFromFile()).resolves.toBe(false)
    expect(read).not.toHaveBeenCalled()
  })

  it('clearAuditLog empties the ring', () => {
    recordPluginEvent('a', 'load')
    clearAuditLog()
    expect(getAuditLog()).toHaveLength(0)
  })
})

describe('semver', () => {
  it('parseSemver parses d.d.d and ignores pre-release metadata', () => {
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 })
    expect(parseSemver('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 })
    expect(parseSemver('1.2.3-alpha.1')).toEqual({ major: 1, minor: 2, patch: 3 })
    expect(parseSemver('not-a-version')).toBeNull()
  })

  it('versionSatisfies handles exact, all, ranges, caret, tilde and x-ranges', () => {
    expect(versionSatisfies('1.2.3', '1.2.3')).toBe(true)
    expect(versionSatisfies('1.2.3', 'all')).toBe(true)
    expect(versionSatisfies('1.2.3', '>=1.0.0 <2.0.0')).toBe(true)
    expect(versionSatisfies('2.1.0', '>=1.0.0 <2.0.0')).toBe(false)
    expect(versionSatisfies('1.4.2', '^1.0.0')).toBe(true)
    expect(versionSatisfies('2.0.0', '^1.0.0')).toBe(false)
    expect(versionSatisfies('1.2.9', '~1.2.0')).toBe(true)
    expect(versionSatisfies('1.3.0', '~1.2.0')).toBe(false)
    expect(versionSatisfies('1.5.0', '1.x')).toBe(true)
    expect(versionSatisfies('2.0.0', '1.x')).toBe(false)
    expect(versionSatisfies('1.2.3', '1.0.0 || 1.2.x')).toBe(true)
  })
})

describe('version policy & rollback', () => {
  it('records version+digest and treats it as last-known-good on first load', () => {
    recordPluginVersion('@scope/q', '1.0.0', 'deadbeef')
    expect(getRecordedPluginVersion('@scope/q')).toMatchObject({ version: '1.0.0', digest: 'deadbeef' })
    expect(getLastKnownGoodVersion('@scope/q')).toBe('1.0.0')
    expect(isVersionAllowed('@scope/q', '1.0.0')).toBe(true)
  })

  it('refuses a version marked bad', () => {
    recordPluginVersion('@scope/q', '1.0.0', 'd1')
    expect(markBadVersion('@scope/q', '1.0.0')).toBe(true) // the version becomes disallowed
    expect(isVersionAllowed('@scope/q', '1.0.0')).toBe(false)
    // Marking the only good version bad clears the rollback baseline.
    expect(getLastKnownGoodVersion('@scope/q')).toBeUndefined()
  })

  it('refuses a version outside the configured supported range', () => {
    setPluginVersionRange('@scope/q', { min: '1.0.0', max: '2.0.0' })
    expect(isVersionAllowed('@scope/q', '1.5.0')).toBe(true)
    expect(isVersionAllowed('@scope/q', '0.9.0')).toBe(false)
    expect(isVersionAllowed('@scope/q', '2.1.0')).toBe(false)
    expect(getPluginVersionRange('@scope/q')).toEqual({ min: '1.0.0', max: '2.0.0' })
  })

  it('rollbackPoint surfaces the last-known-good version and requires re-approval', () => {
    recordPluginVersion('@scope/q', '2.0.0', 'd2')
    recordPluginVersion('@scope/q', '2.1.0', 'd3')
    markBadVersion('@scope/q', '2.1.0')
    const point = rollbackPoint('@scope/q')
    expect(point).not.toBeNull()
    expect(point?.version).toBe('2.0.0')
    expect(point?.digest).toBe('d2')
    // Honesty: rollback never auto-runs — it always requires the digest/trust gate.
    expect(point?.requiresReapproval).toBe(true)
  })

  it('rollbackPoint returns null when no good baseline exists', () => {
    recordPluginVersion('@scope/q', '1.0.0', 'd1')
    markBadVersion('@scope/q', '1.0.0')
    expect(rollbackPoint('@scope/q')).toBeNull()
  })
})

describe('revocation list', () => {
  it('revokes a plugin id (all versions) and refuses at load', () => {
    revokePlugin('@scope/evil', 'all', 'malware')
    expect(isPluginRevoked('@scope/evil', '1.0.0').revoked).toBe(true)
    expect(isPluginRevoked('@scope/evil', '1.0.0').reason).toBe('malware')
    expect(isPluginRevoked('@scope/evil', '9.9.9').revoked).toBe(true)
    expect(isPluginRevoked('@scope/ok', '1.0.0').revoked).toBe(false)
  })

  it('revokes a specific version or a version range', () => {
    revokePlugin('@scope/q', '1.2.3', 'broken build')
    expect(isPluginRevoked('@scope/q', '1.2.3').revoked).toBe(true)
    expect(isPluginRevoked('@scope/q', '1.2.4').revoked).toBe(false)

    revokePlugin('@scope/r', '<2.0.0', 'withdrawn')
    expect(isPluginRevoked('@scope/r', '1.9.9').revoked).toBe(true)
    expect(isPluginRevoked('@scope/r', '2.0.0').revoked).toBe(false)
  })

  it('unrevokes a plugin', () => {
    revokePlugin('@scope/evil')
    expect(isPluginRevoked('@scope/evil', '1.0.0').revoked).toBe(true)
    unrevokePlugin('@scope/evil')
    expect(isPluginRevoked('@scope/evil', '1.0.0').revoked).toBe(false)
    expect(getRevokedPlugins()).toEqual([])
  })
})

describe('serialization', () => {
  it('serializes and restores governance state', () => {
    recordPluginVersion('@scope/q', '1.0.0', 'd1')
    revokePlugin('@scope/evil', 'all', 'malware')
    const json = serializeGovernance()
    resetGovernanceForTests()
    loadGovernance(json)
    expect(getRecordedPluginVersion('@scope/q')).toMatchObject({ version: '1.0.0', digest: 'd1' })
    expect(isPluginRevoked('@scope/evil', '1.0.0').revoked).toBe(true)
  })

  it('serializeAuditLog round-trips the ring', () => {
    recordPluginEvent('a', 'activate')
    const json = serializeAuditLog()
    resetGovernanceForTests()
    // Rebuild the ring from the serialized form.
    const events = JSON.parse(json) as Array<{ seq: number; pluginId: string; event: string }>
    for (const e of events) recordPluginEvent(e.pluginId, e.event as never)
    expect(getAuditLog().map((e) => e.event)).toEqual(['activate'])
  })
})
