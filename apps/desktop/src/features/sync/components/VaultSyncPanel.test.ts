import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import VaultSyncPanel from './VaultSyncPanel.vue'
import type { GitReadout, VaultGitClient } from '../services/vault-git-client'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))
const ready: GitReadout = { initialized: true, branch: 'main', origin: 'ssh://git.example/notes.git', changes: '?? note.md' }
const flush = async () => { await Promise.resolve(); await nextTick(); await Promise.resolve(); await nextTick() }

function mount(client: VaultGitClient) {
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(VaultSyncPanel, { vault: '/notes', client })
  app.mount(host)
  cleanups.push(() => { app.unmount(); host.remove() })
  return host
}

describe('vault Git sync', () => {
  it('shows status and runs an explicit commit', async () => {
    const run = vi.fn(async (_root: string, action: unknown) => {
      if ((action as { kind: string }).kind === 'commit') return { ...ready, changes: '' }
      return ready
    })
    const host = mount({ run })
    await flush()
    expect(host.textContent).toContain('note.md')
    const message = host.querySelector<HTMLInputElement>('[data-test="git-message"]')!
    message.value = 'Saved note'
    message.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    host.querySelector<HTMLButtonElement>('[data-test="git-commit"]')!.click()
    await flush()
    expect(run).toHaveBeenCalledWith('/notes', { kind: 'commit', message: 'Saved note' })
    expect(host.textContent).not.toContain('?? note.md')
  })

  it('keeps an operation error visible for retry', async () => {
    const run = vi.fn().mockResolvedValueOnce({ ...ready, changes: '' }).mockRejectedValueOnce(new Error('permission denied'))
    const host = mount({ run })
    await flush()
    host.querySelector<HTMLButtonElement>('[data-test="git-pull"]')!.click()
    await flush()
    expect(host.textContent).toContain('permission denied')
  })
})
