import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  MAX_AI_AUDIT_EVENTS,
  clearAiAuditLog,
  getAiAuditLog,
  loadAiAuditLog,
  onAiAudit,
  recordAiAudit,
  serializeAiAuditLog,
  summarizeAiAudit,
} from './aiAudit'
import { useAiPermissionStore } from '../stores/aiPermission'
import { persistence } from './persistence'

const LS_AUDIT = 'nekowite.ai.audit'

beforeEach(() => {
  clearAiAuditLog()
  persistence.set(LS_AUDIT, '')
  setActivePinia(createPinia())
})

describe('recordAiAudit', () => {
  it('stamps a monotonic sequence and a timestamp', () => {
    const first = recordAiAudit({ source: 'ghost', outcome: 'blocked' })
    const second = recordAiAudit({ source: 'chat', outcome: 'allowed' })
    expect(second.seq).toBeGreaterThan(first.seq)
    expect(first.at).toBeGreaterThan(1_600_000_000_000)
    expect(getAiAuditLog()).toHaveLength(2)
  })

  it('redacts anything that looks like a key', () => {
    // The log is mirrored to storage and shown on screen, so a caller that
    // passes a secret by accident must not be able to plant it there.
    recordAiAudit({
      source: 'plugin',
      outcome: 'asked',
      detail: 'plugin demo used Bearer sk-abcdefghijklmnopqrstuvwxyz012345',
    })
    const [entry] = getAiAuditLog()
    expect(entry!.detail).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345')
    expect(entry!.detail).toContain('[redacted]')
  })

  it('keeps the ring bounded, dropping the oldest entries', () => {
    for (let i = 0; i < MAX_AI_AUDIT_EVENTS + 20; i += 1) {
      recordAiAudit({ source: 'chat', outcome: 'allowed' })
    }
    const log = getAiAuditLog()
    expect(log).toHaveLength(MAX_AI_AUDIT_EVENTS)
    expect(log[log.length - 1]!.seq).toBe(MAX_AI_AUDIT_EVENTS + 20)
  })

  it('isolates a throwing subscriber', () => {
    const seen: number[] = []
    onAiAudit(() => {
      throw new Error('subscriber exploded')
    })
    const off = onAiAudit((e) => seen.push(e.seq))
    expect(() => recordAiAudit({ source: 'chat', outcome: 'asked' })).not.toThrow()
    expect(seen).toHaveLength(1)
    off()
  })

  it('counts outcomes for the summary line', () => {
    recordAiAudit({ source: 'chat', outcome: 'allowed' })
    recordAiAudit({ source: 'plugin', outcome: 'blocked' })
    recordAiAudit({ source: 'ghost', outcome: 'blocked' })
    expect(summarizeAiAudit()).toMatchObject({ allowed: 1, blocked: 2, denied: 0 })
  })
})

describe('loadAiAuditLog', () => {
  it('survives junk instead of failing startup', () => {
    expect(loadAiAuditLog('{not json')).toBe(0)
    expect(loadAiAuditLog('[1,2,3]')).toBe(0)
    expect(loadAiAuditLog(JSON.stringify({ events: 'nope' }))).toBe(0)
    expect(getAiAuditLog()).toEqual([])
  })

  it('de-duplicates by seq and continues numbering past the restored entries', () => {
    const blob = JSON.stringify({
      version: 1,
      events: [
        { seq: 7, at: 1000, source: 'chat', outcome: 'allowed' },
        { seq: 7, at: 1000, source: 'chat', outcome: 'allowed' },
        { seq: 3, at: 900, source: 'ghost', outcome: 'blocked' },
      ],
    })
    expect(loadAiAuditLog(blob)).toBe(2)
    expect(getAiAuditLog().map((e) => e.seq)).toEqual([3, 7])
    // New events must not reuse a restored seq, or a reload would silently
    // collapse two different events into one.
    expect(recordAiAudit({ source: 'chat', outcome: 'asked' }).seq).toBe(8)
  })

  it('round-trips through its own serializer', () => {
    recordAiAudit({ source: 'edit', outcome: 'denied', kind: 'replace-selection', detail: 'refused' })
    const blob = serializeAiAuditLog()
    clearAiAuditLog()
    expect(getAiAuditLog()).toEqual([])
    loadAiAuditLog(blob)
    expect(getAiAuditLog()).toHaveLength(1)
    expect(getAiAuditLog()[0]).toMatchObject({ source: 'edit', outcome: 'denied', kind: 'replace-selection' })
  })
})

describe('the permission store records what it decides', () => {
  it('records a standing-allow as allowed, and mirrors it to storage', async () => {
    const store = useAiPermissionStore()
    store.setPolicy('auto')
    await expect(store.ask({ kind: 'insert', summary: 'x', source: 'chat' })).resolves.toBe(true)
    expect(store.auditLog.at(-1)).toMatchObject({ source: 'chat', outcome: 'allowed' })
    expect(persistence.get(LS_AUDIT)).toContain('allowed')
  })

  it('records a refusal with the reason, so the two refusals stay distinguishable', async () => {
    const store = useAiPermissionStore()
    store.setPolicy('readonly')
    await expect(store.ask({ kind: 'insert', summary: 'x', source: 'edit' })).resolves.toBe(false)
    expect(store.auditLog.at(-1)).toMatchObject({ outcome: 'blocked' })
    expect(store.auditLog.at(-1)!.detail).toContain('permission')

    store.setPolicy('auto')
    store.setEnabled(false)
    await expect(store.ask({ kind: 'insert', summary: 'x' })).resolves.toBe(false)
    expect(store.auditLog.at(-1)!.detail).toContain('switched off')
  })

  it('records the question, the grant and the answer in order', async () => {
    const store = useAiPermissionStore()
    store.setPolicy('ask')
    const pending = store.ask({ kind: 'replace-selection', summary: 'polish', source: 'dialog' })
    await Promise.resolve()
    expect(store.auditLog.at(-1)).toMatchObject({ outcome: 'asked' })
    store.respond(true, true)
    await pending
    expect(store.auditLog.map((e) => e.outcome)).toEqual(['asked', 'granted', 'allowed'])
  })

  it('records the auto-denial of a second concurrent question', async () => {
    const store = useAiPermissionStore()
    store.setPolicy('ask')
    const first = store.ask({ kind: 'insert', summary: 'first', source: 'chat' })
    await Promise.resolve()
    const second = store.ask({ kind: 'insert', summary: 'second', source: 'plugin' })
    await expect(second).resolves.toBe(false)
    expect(store.auditLog.at(-1)).toMatchObject({ source: 'plugin', outcome: 'denied' })
    store.respond(false)
    await first
  })

  it('clears on request and stops mirroring the old entries', async () => {
    const store = useAiPermissionStore()
    store.setPolicy('auto')
    await store.ask({ kind: 'insert', summary: 'x', source: 'chat' })
    expect(store.auditLog.length).toBeGreaterThan(0)
    store.forgetAudit()
    expect(store.auditLog).toEqual([])
    expect(persistence.get(LS_AUDIT)).not.toContain('allowed')
  })

  it('reports the summary counts the settings panel shows', async () => {
    const store = useAiPermissionStore()
    store.setPolicy('auto')
    await store.ask({ kind: 'insert', summary: 'x', source: 'chat' })
    store.setEnabled(false)
    await store.ask({ kind: 'insert', summary: 'x', source: 'ghost' })
    expect(store.auditSummary.allowed).toBe(1)
    expect(store.auditSummary.blocked).toBe(1)
  })
})
