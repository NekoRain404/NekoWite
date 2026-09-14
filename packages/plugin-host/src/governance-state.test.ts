import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as governance from './governance'
import {
  getGovernancePluginIds,
  loadGovernance,
  resetGovernanceForTests,
  serializeGovernance,
} from './governance-state'
import { isPluginRevoked } from './revocation'
import { getRecordedPluginVersion, isVersionAllowed, recordPluginVersion } from './version-policy'
import { flushAuditLogToFile, getAuditLog, getLastAuditEvent, recordPluginEvent, setAuditLogFileSink } from './audit-log'

// The state/serialize boundary is its own unit now: what a snapshot restores,
// what it merges, and what it must never lose. A restored revocation decides
// whether a plugin runs, so these are load-gate tests, not storage plumbing.

beforeEach(() => {
  resetGovernanceForTests()
})

describe('governance snapshot round trip', () => {
  it('restores a revocation written by another host — the gate still refuses after a load', () => {
    // A revoked-id-only snapshot: the entry carries the decision, nothing else.
    loadGovernance(
      JSON.stringify({
        revocations: [{ pluginId: '@scope/evil', version: 'all', reason: 'malware', revokedAt: 1 }],
      }),
    )
    const verdict = isPluginRevoked('@scope/evil', '1.0.0')
    expect(verdict.revoked).toBe(true)
    expect(verdict.reason).toBe('malware')
    // The id is enumerable from the revocation alone (no version record exists).
    expect(getGovernancePluginIds()).toContain('@scope/evil')
  })

  it('restores a version range and a bad version, which between them refuse a load', () => {
    loadGovernance(
      JSON.stringify({
        versionRanges: { '@scope/q': { min: '1.0.0', max: '2.0.0' } },
        badVersions: { '@scope/q': ['1.5.0'] },
      }),
    )
    expect(isVersionAllowed('@scope/q', '3.0.0')).toBe(false)
    expect(isVersionAllowed('@scope/q', '2.0.0')).toBe(true)
    expect(isVersionAllowed('@scope/q', '1.5.0')).toBe(false)
  })

  it('round-trips recorded versions and digests through serialize/load', () => {
    recordPluginVersion('@scope/q', '1.0.0', 'd1')
    loadGovernance(serializeGovernance())
    expect(getRecordedPluginVersion('@scope/q')).toMatchObject({ version: '1.0.0', digest: 'd1' })
  })

  it('merges a snapshot into live state instead of replacing it', () => {
    recordPluginVersion('@scope/live', '1.0.0', 'live')
    loadGovernance(JSON.stringify({ recordedOrder: { '@scope/other': ['9.9.9'] } }))
    expect(getRecordedPluginVersion('@scope/live')?.version).toBe('1.0.0')
    expect(getGovernancePluginIds()).toEqual(expect.arrayContaining(['@scope/live', '@scope/other']))
  })

  it('merges per version rather than dropping the versions it already held', () => {
    loadGovernance(JSON.stringify({ recordedPlugins: { '@scope/q': { '1.0.0': { version: '1.0.0', timestamp: 1 } } } }))
    loadGovernance(JSON.stringify({ recordedPlugins: { '@scope/q': { '2.0.0': { version: '2.0.0', timestamp: 2 } } } }))
    const restored = JSON.parse(serializeGovernance()) as {
      recordedPlugins: Record<string, Record<string, { digest?: string }>>
    }
    // Both versions are still on record: the second load added to the first
    // rather than replacing the plugin's entry. (Enumeration follows
    // `recordedOrder`, which a snapshot written by this module always carries.)
    expect(Object.keys(restored.recordedPlugins['@scope/q']).sort()).toEqual(['1.0.0', '2.0.0'])
  })

  it('absorbs malformed input without throwing and without wiping live state', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    recordPluginVersion('@scope/q', '1.0.0', 'd1')
    expect(() => loadGovernance('not json at all')).not.toThrow()
    expect(getRecordedPluginVersion('@scope/q')?.version).toBe('1.0.0')
    warn.mockRestore()
  })

  it('unions every record kind into the enumerable plugin ids', () => {
    recordPluginVersion('@scope/recorded', '1.0.0')
    loadGovernance(
      JSON.stringify({
        badVersions: { '@scope/bad': ['1.0.0'] },
        versionRanges: { '@scope/ranged': { min: '1.0.0' } },
        revocations: [{ pluginId: '@scope/revoked', version: 'all', revokedAt: 1 }],
      }),
    )
    expect(getGovernancePluginIds().sort()).toEqual(
      ['@scope/bad', '@scope/ranged', '@scope/recorded', '@scope/revoked'].sort(),
    )
  })
})

// The split's hard constraint: `governance.ts` is a compatibility surface, so
// every value it exported before must still resolve from it. Most of these are
// absent from api-surface.test.ts's curated list, so nothing else would catch a
// name dropped while the implementation moved.
const VALUE_EXPORTS_AT_HEAD = [
  'PLUGIN_AUDIT_EVENT_LABELS',
  'sanitizeAuditDetail',
  'recordPluginEvent',
  'onPluginEvent',
  'getAuditLog',
  'getPluginAuditEvents',
  'getLastAuditEvent',
  'clearAuditLog',
  'setAuditLogFileSink',
  'getAuditLogFileSink',
  'serializeAuditLog',
  'flushAuditLogToFile',
  'loadAuditLogFromFile',
  'createMacEnvelope',
  'verifyMacEnvelope',
  'generateMacSecret',
  'parseSemver',
  'versionSatisfies',
  'recordPluginVersion',
  'getRecordedPluginVersion',
  'markBadVersion',
  'getBadPluginVersions',
  'setPluginVersionRange',
  'getPluginVersionRange',
  'isVersionAllowed',
  'getLastKnownGoodVersion',
  'rollbackPoint',
  'revokePlugin',
  'unrevokePlugin',
  'getRevokedPlugins',
  'getGovernancePluginIds',
  'isPluginRevoked',
  'serializeGovernance',
  'loadGovernance',
  'resetGovernanceForTests',
  'governanceRefusal',
] as const

describe('compatibility surface', () => {
  it('still exports every value name the pre-split module exported', () => {
    for (const name of VALUE_EXPORTS_AT_HEAD) {
      expect(governance, `governance.ts must still export "${name}"`).toHaveProperty(name)
    }
  })

  it('does not leak the mutable store through the barrel', () => {
    // The singleton is reachable from the modules that write it, never from the
    // SDK surface: an embedder goes through serialize/load.
    expect(governance).not.toHaveProperty('state')
  })
})

describe('session reset', () => {
  it('clears both halves — the audit ring and the version/revocation records', () => {
    recordPluginEvent('@scope/q', 'load')
    recordPluginVersion('@scope/q', '1.0.0', 'd1')
    resetGovernanceForTests()
    expect(getAuditLog()).toHaveLength(0)
    expect(getLastAuditEvent()).toBeUndefined()
    expect(getGovernancePluginIds()).toEqual([])
    expect(isVersionAllowed('@scope/q', '1.0.0')).toBe(true)
  })

  it('restarts the audit sequence, so a fresh session numbers from 1 again', () => {
    recordPluginEvent('@scope/q', 'load')
    recordPluginEvent('@scope/q', 'activate')
    resetGovernanceForTests()
    expect(recordPluginEvent('@scope/q', 'load').seq).toBe(1)
  })

  it('drops the configured audit sink, so a flush after a reset is a no-op', async () => {
    const write = vi.fn(async () => {})
    setAuditLogFileSink({ path: '/vault/.nekowite/audit.log', read: async () => '[]', write })
    await expect(flushAuditLogToFile()).resolves.toBe(true)
    resetGovernanceForTests()
    await expect(flushAuditLogToFile()).resolves.toBe(false)
    expect(write).toHaveBeenCalledTimes(1)
  })
})
