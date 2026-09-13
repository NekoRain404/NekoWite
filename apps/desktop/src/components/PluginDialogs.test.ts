import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import PermissionDialog from './PermissionDialog.vue'
import PluginIntegrityDialog from './PluginIntegrityDialog.vue'
import type { PluginMeta } from '@nekowite/plugin-host'

let mounted: VueApp[] = []

const meta = { id: 'demo', name: 'Demo plugin', version: '1.0.0' } as unknown as PluginMeta
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function mountComponent(component: unknown, props: Record<string, unknown>, emits: Record<string, unknown>): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(component as never, { ...props, ...emits } as never)
  app.mount(host)
  mounted.push(app)
  return host
}

async function settle(): Promise<void> {
  await nextTick()
  await flush()
  await nextTick()
}

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
  document.body.innerHTML = ''
})

describe('PermissionDialog as a modal', () => {
  it('is a labelled modal dialog and takes focus itself on open', async () => {
    // These two prompts were the only dialogs in the app without a role, a
    // modal flag, a focus trap or an Escape route: a keyboard user could not
    // answer them and Tab walked straight out into the blocked UI behind.
    const host = mountComponent(
      PermissionDialog,
      { meta, permissions: ['fs', 'network'] },
      { onAllow: vi.fn(), onDeny: vi.fn() },
    )
    await settle()

    const dialog = host.querySelector<HTMLElement>('.plugin-dialog')!
    expect(dialog.getAttribute('role')).toBe('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy()
    expect(document.body.querySelector(`#${dialog.getAttribute('aria-labelledby')}`)).toBeTruthy()
    expect(dialog.contains(document.activeElement)).toBe(true)
  })

  it('treats Escape as a denial', async () => {
    const deny = vi.fn()
    mountComponent(PermissionDialog, { meta, permissions: ['fs'] }, { onAllow: vi.fn(), onDeny: deny })
    await settle()

    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(deny).toHaveBeenCalledTimes(1)
  })
})

describe('PluginIntegrityDialog as a modal', () => {
  it('is a labelled modal dialog and takes focus itself on open', async () => {
    const host = mountComponent(
      PluginIntegrityDialog,
      { meta, expectedDigest: 'aaa', actualDigest: 'bbb' },
      { onAllow: vi.fn(), onDeny: vi.fn() },
    )
    await settle()

    const dialog = host.querySelector<HTMLElement>('.plugin-dialog')!
    expect(dialog.getAttribute('role')).toBe('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy()
    expect(dialog.contains(document.activeElement)).toBe(true)
  })

  it('treats Escape as a denial', async () => {
    const deny = vi.fn()
    mountComponent(
      PluginIntegrityDialog,
      { meta, expectedDigest: 'aaa', actualDigest: 'bbb' },
      { onAllow: vi.fn(), onDeny: deny },
    )
    await settle()

    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(deny).toHaveBeenCalledTimes(1)
  })
})
