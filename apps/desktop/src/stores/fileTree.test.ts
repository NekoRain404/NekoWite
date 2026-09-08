import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useFileTreeStore } from './fileTree'

describe('useFileTreeStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('tracks the vault truncation flag and attachment badge', () => {
    const store = useFileTreeStore()
    expect(store.vaultTruncated).toBe(false)
    expect(store.attachmentCount).toBe(0)
    store.setVaultTruncated(true)
    store.setAttachmentCount(7)
    expect(store.vaultTruncated).toBe(true)
    expect(store.attachmentCount).toBe(7)
  })

  it('resetForVault clears listing state on a vault switch', () => {
    const store = useFileTreeStore()
    store.setVaultTruncated(true)
    store.setAttachmentCount(4)
    store.resetForVault()
    expect(store.vaultTruncated).toBe(false)
    expect(store.attachmentCount).toBe(0)
  })
})
