import { afterEach, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import RemoteImportDialog from './RemoteImportDialog.vue'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))
const flush = async () => { await Promise.resolve(); await nextTick(); await Promise.resolve(); await nextTick() }

function mount(run: (vault: string, spec: unknown) => Promise<string>) {
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(RemoteImportDialog, { vault: '/notes', client: { import: run } })
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
  host.querySelector<HTMLButtonElement>('[data-test="remote-import"]')!.click()
  await flush()
  expect(run).toHaveBeenCalledWith('/notes', {
    user: 'writer', host: 'example.org', port: 22, remotePath: '/home/writer/notes', folder: 'remote-notes',
  })
  expect(host.textContent).toContain('SSH unavailable')
})
