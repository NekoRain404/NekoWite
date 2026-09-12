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

function inputEl(): HTMLInputElement {
  return input()
}

/** Build a keydown whose `isComposing` flag is actually observable: happy-dom's
 *  KeyboardEvent constructor silently drops the `isComposing` init option, so a
 *  real IME event is simulated by stamping the (read-only) property. */
function imeKey(init: KeyboardEventInit): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  Object.defineProperty(ev, 'isComposing', { value: init.isComposing ?? true, configurable: true })
  return ev
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

  it('does not confirm on Enter while an IME candidate list is open', () => {
    // Pinyin/Japanese input uses Enter to accept the highlighted candidate.
    // Treating that Enter as "confirm" renamed the file to the raw pinyin
    // string that was still being composed. Cancelable + a defaultPrevented
    // assertion also proves the handler returned before doing any work.
    const confirm = vi.fn()
    mount({ initial: 'fengjing.png' }, { onConfirm: confirm })
    const input = inputEl()
    input.value = 'fengjing'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    const ev = imeKey({ key: 'Enter' })
    input.dispatchEvent(ev)
    expect(confirm).not.toHaveBeenCalled()
    expect(ev.defaultPrevented).toBe(false)
  })

  it('does not cancel on Escape while an IME candidate list is open', () => {
    // Escape dismisses the IME candidate list; the dialog used to treat it as
    // "cancel" and threw the typed name away mid-composition.
    const cancel = vi.fn()
    mount({ initial: 'pic.png' }, { onCancel: cancel })
    const ev = imeKey({ key: 'Escape', keyCode: 229 })
    inputEl().dispatchEvent(ev)
    expect(cancel).not.toHaveBeenCalled()
    expect(ev.defaultPrevented).toBe(false)
  })

  it('does not cancel on Escape reported as key="Process"', () => {
    const cancel = vi.fn()
    mount({ initial: 'pic.png' }, { onCancel: cancel })
    const ev = new KeyboardEvent('keydown', { key: 'Process', bubbles: true, cancelable: true })
    inputEl().dispatchEvent(ev)
    expect(cancel).not.toHaveBeenCalled()
    expect(ev.defaultPrevented).toBe(false)
  })
})
