import { afterEach, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import RemoteImportDialog from './RemoteImportDialog.vue'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))
const flush = async () => { await Promise.resolve(); await nextTick(); await Promise.resolve(); await nextTick() }

function mount(run: (vault: string, spec: unknown) => Promise<string>) {
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(RemoteImportDialog, { vault: '/notes', client: {
    import: run, connect: run, disconnect: vi.fn(), connections: vi.fn().mockResolvedValue([]),
  } })
  app.mount(host)
  cleanups.push(() => { app.unmount(); host.remove() })
  return host
}

function fill(host: HTMLElement, field: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(`[data-test="remote-${field}"]`)!
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

it('sends explicit SSH import fields and keeps failures visible', async () => {
  const run = vi.fn().mockRejectedValueOnce(new Error('SSH unavailable'))
  const host = mount(run)
  fill(host, 'user', 'writer')
  fill(host, 'host', 'example.org')
  fill(host, 'path', '/home/writer/notes')
  fill(host, 'folder', 'remote-notes')
  await nextTick()
  host.querySelector<HTMLButtonElement>('[data-test="remote-mode-import"]')!.click()
  await nextTick()
  host.querySelector<HTMLButtonElement>('[data-test="remote-import"]')!.click()
  await flush()
  expect(run).toHaveBeenCalledWith('/notes', {
    user: 'writer', host: 'example.org', port: 22, remotePath: '/home/writer/notes', folder: 'remote-notes',
  })
  expect(host.textContent).toContain('SSH unavailable')
})

it('connects live over SSH by default and shows a failed connection', async () => {
  const run = vi.fn().mockRejectedValueOnce(new Error('install sshfs'))
  const host = mount(run)
  fill(host, 'user', 'writer')
  fill(host, 'host', 'example.org')
  fill(host, 'path', '/home/writer/notes')
  fill(host, 'folder', 'remote-notes')
  await nextTick()
  host.querySelector<HTMLButtonElement>('[data-test="remote-connect"]')!.click()
  await flush()
  expect(run).toHaveBeenCalledWith('/notes', {
    user: 'writer', host: 'example.org', port: 22, remotePath: '/home/writer/notes', folder: 'remote-notes',
  })
  expect(host.textContent).toContain('install sshfs')
})

it('offers password authentication and clears the secret after a failed attempt', async () => {
  const run = vi.fn().mockRejectedValueOnce(new Error('authentication failed'))
  const host = mount(run)
  expect(host.querySelector('select')).toBeNull()
  const trigger = host.querySelector<HTMLButtonElement>('[data-test="remote-auth"]')!
  trigger.click()
  await nextTick()
  expect(document.querySelector('[role="listbox"]')).not.toBeNull()
  document.querySelector<HTMLButtonElement>('[role="option"][data-value="password"]')!.click()
  await nextTick()
  fill(host, 'user', 'writer')
  fill(host, 'host', 'example.org')
  fill(host, 'path', '/notes')
  fill(host, 'folder', 'remote-notes')
  fill(host, 'password', 'test secret')
  await nextTick()
  host.querySelector<HTMLButtonElement>('[data-test="remote-connect"]')!.click()
  await flush()
  expect(run).toHaveBeenCalledWith('/notes', expect.objectContaining({
    auth: { mode: 'password', password: 'test secret' },
  }))
  expect(host.querySelector<HTMLInputElement>('[data-test="remote-password"]')!.value).toBe('')
})
