import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, type App as VueApp } from 'vue'

import RenameDialog from './RenameDialog.vue'

let mounted: VueApp[] = []

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
  document.body.innerHTML = ''
})

function mount(props: { initial: string }, emits: Record<string, unknown>): void {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(RenameDialog, { ...props, ...emits } as never)
  app.mount(host)
  mounted.push(app)
}

function input(): HTMLInputElement {
  return document.body.querySelector<HTMLInputElement>('.rename-dialog .input')!
}

describe('RenameDialog', () => {
  it('prefills the suggested name and confirms it', async () => {
    const confirm = vi.fn()
    mount({ initial: 'paste-20260903-070509.png' }, { onConfirm: confirm })
    expect(input().value).toBe('paste-20260903-070509.png')
    ;(document.body.querySelector('.rename-dialog .btn-primary') as HTMLElement).click()
    await Promise.resolve()
    expect(confirm).toHaveBeenCalledWith('paste-20260903-070509.png')
  })

  it('rejects traversal and blocks confirm with an inline error', async () => {
    const confirm = vi.fn()
    mount({ initial: '' }, { onConfirm: confirm })
    input().value = '../evil.png'
    input().dispatchEvent(new Event('input'))
    await Promise.resolve()
    expect(document.body.querySelector('.rename-dialog .rename-error')).toBeTruthy()
    const confirmBtn = document.body.querySelector<HTMLButtonElement>('.rename-dialog .btn-primary')
    expect(confirmBtn?.disabled).toBe(true)
    confirmBtn?.click()
    expect(confirm).not.toHaveBeenCalled()
  })

  it('emits cancel on Escape', () => {
    const cancel = vi.fn()
    mount({ initial: 'pic.png' }, { onCancel: cancel })
    const overlay = document.body.querySelector('.dialog-overlay') as HTMLElement
    overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(cancel).toHaveBeenCalled()
  })
})
