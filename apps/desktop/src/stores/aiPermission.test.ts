import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAiPermissionStore } from './aiPermission'
import { persistence } from '../services/persistence'

const LS_ENABLED = 'nekowite.ai.enabled'
const LS_POLICY = 'nekowite.ai.writePolicy'

beforeEach(() => {
  persistence.set(LS_ENABLED, '1')
  persistence.set(LS_POLICY, 'ask')
  setActivePinia(createPinia())
})

describe('the AI master switch', () => {
  it('is on unless it was switched off', () => {
    expect(useAiPermissionStore().enabled).toBe(true)
  })

  it('persists the choice, so a relaunch keeps it', () => {
    const store = useAiPermissionStore()
    store.setEnabled(false)
    expect(persistence.get(LS_ENABLED)).toBe('0')

    // A fresh store reads what the previous run wrote (same window, new pinia).
    setActivePinia(createPinia())
    expect(useAiPermissionStore().enabled).toBe(false)

    useAiPermissionStore().setEnabled(true)
    setActivePinia(createPinia())
    expect(useAiPermissionStore().enabled).toBe(true)
  })

  it('reads a stored value it does not recognise as on', () => {
    // Only the exact "off" marker switches AI off: a value written by some
    // other build (or a corrupted one) must not silently disable the feature.
    persistence.set(LS_ENABLED, 'maybe')
    setActivePinia(createPinia())
    expect(useAiPermissionStore().enabled).toBe(true)

    persistence.set(LS_ENABLED, '')
    setActivePinia(createPinia())
    expect(useAiPermissionStore().enabled).toBe(true)
  })

  it('refuses every write while it is off, without losing the policy', async () => {
    const store = useAiPermissionStore()
    store.setPolicy('auto')
    store.setEnabled(false)

    await expect(store.ask({ kind: 'insert', summary: 'insert' })).resolves.toBe(false)
    await expect(store.ask({ kind: 'replace-document', summary: 'rewrite' })).resolves.toBe(false)
    // No question was put on screen: an off switch is not a prompt.
    expect(store.pending).toBeNull()
    // The policy the user configured survives, so switching AI back on
    // restores exactly what they had.
    expect(store.policy).toBe('auto')

    store.setEnabled(true)
    await expect(store.ask({ kind: 'insert', summary: 'insert' })).resolves.toBe(true)
  })
})
