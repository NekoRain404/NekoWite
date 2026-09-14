import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, type App as VueApp } from 'vue'

import ConflictDialog from './ConflictDialog.vue'
import { setLocale, t } from '../i18n'

let mounted: VueApp[] = []

interface Handlers {
  onClose: () => void
  onReloadDisk: () => void
}

function mountDialog(tabId: string, handlers: Handlers): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(ConflictDialog, {
    tabId,
    path: '/vault/a.md',
    ...handlers,
  } as never)
  app.mount(host)
  mounted.push(app)
  return host
}

function handlers(): Handlers & { close: ReturnType<typeof vi.fn>; reloadDisk: ReturnType<typeof vi.fn> } {
  const close = vi.fn()
  const reloadDisk = vi.fn()
  return { close, reloadDisk, onClose: close, onReloadDisk: reloadDisk }
}

// "Use disk" is the destructive answer and carries the danger styling; the
// affirmative that keeps the user's edits owns the primary/confirm slot.
function reloadBtn(): HTMLButtonElement {
  return document.body.querySelector<HTMLButtonElement>('.conflict-dialog .btn-danger')!
}
function keepLocalBtn(): HTMLButtonElement {
  return document.body.querySelector<HTMLButtonElement>('.conflict-dialog .btn-primary')!
}
function dialogEl(): HTMLElement {
  return document.body.querySelector<HTMLElement>('.conflict-dialog')!
}

describe('ConflictDialog', () => {
  afterEach(() => {
    mounted.forEach((app) => app.unmount())
    mounted = []
    document.body.innerHTML = ''
  })

  it('is a labelled, modal dialog', () => {
    mountDialog('tab-1', handlers())
    const dialog = document.body.querySelector<HTMLElement>('.conflict-dialog')!
    expect(dialog.getAttribute('role')).toBe('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-labelledby')).toBe('conflict-title')
    expect(document.body.querySelector('#conflict-title')).toBeTruthy()
  })

  it('opens with focus on the dialog itself, not on a destructive button', async () => {
    // This used to focus the first focusable control, which is "Use disk
    // (discard local)": the prompt appeared with focus already sitting on the
    // action that throws the user's unsaved edits away, so a stray Enter (or a
    // keypress meant for the editor the dialog interrupted) discarded them.
    // Focus now lands on the dialog container, so every choice -- including the
    // safe ones -- is an explicit, deliberate move. The container is focused
    // rather than "Later" on purpose: focusing a button makes Enter trigger
    // that button, and the safe default should be *no* answer at all.
    mountDialog('tab-1', handlers())
    await new Promise((r) => setTimeout(r, 0))
    expect(document.activeElement).toBe(dialogEl())
    expect(document.activeElement).not.toBe(reloadBtn())
    expect(document.activeElement).not.toBe(keepLocalBtn())
  })

  it('keeps the confirm slot for the safe answer, not the destructive one', () => {
    // The shared convention (see .dialog-actions in styles/surfaces.css) puts
    // the affirmative in the rightmost slot — the one muscle memory reaches for
    // — so the action that discards the user's unsaved edits is not allowed to
    // live there. It sits leftmost, styled as danger, and the confirm slot
    // holds "Keep local".
    mountDialog('tab-1', handlers())
    const row = [...document.body.querySelectorAll<HTMLButtonElement>('.conflict-dialog .dialog-actions .btn')]
    expect(row.map((b) => b.classList.contains('btn-primary'))).toEqual([false, false, true])
    expect(row[0].classList.contains('btn-danger')).toBe(true)
    expect(row[row.length - 1]).toBe(keepLocalBtn())
  })

  it('reads as one sentence with no empty {path} hole', () => {
    // The message used to interpolate `{path}` with an empty string while the
    // real path was rendered in its own span, so English read
    // "Disk content of  changed" — a hole and a double space. The sentence is
    // now split into prefix + path + suffix, and neither half may depend on
    // interpolation or carry stray whitespace.
    for (const locale of ['en', 'zh'] as const) {
      setLocale(locale)
      try {
        const prefix = t('conflict.bodyPrefix')
        const suffix = t('conflict.bodySuffix')
        expect(prefix).not.toContain('{')
        expect(suffix).not.toContain('{')
        expect(prefix).not.toMatch(/\s$/)
        expect(suffix).not.toMatch(/^\s/)
      } finally {
        setLocale('zh')
      }
    }
  })

  it('renders the path between the two halves as one readable sentence', () => {
    const path = '/vault/a.md'
    setLocale('en')
    try {
      mountDialog('tab-1', handlers())
      const text = document.body.querySelector('.conflict-body')!.textContent!.replace(/\s+/g, ' ').trim()
      expect(text).toBe(`${t('conflict.bodyPrefix')} ${path} ${t('conflict.bodySuffix')}`)
      expect(text).not.toMatch(/\s{2}/)
    } finally {
      setLocale('zh')
    }
  })

  it('asks the caller for the disk reload instead of performing it', () => {
    // §10.2: the prompt displays and forwards events. Reloading the tab is a
    // store command, so it belongs to the caller — and this answer must NOT
    // close the prompt itself, because the caller closes it once the reload it
    // asked for has finished.
    const h = handlers()
    mountDialog('tab-1', h)

    reloadBtn().click()

    expect(h.reloadDisk).toHaveBeenCalledTimes(1)
    expect(h.close).not.toHaveBeenCalled()
  })

  it('keepLocal closes without asking for a reload', () => {
    const h = handlers()
    mountDialog('tab-1', h)

    keepLocalBtn().click()

    expect(h.close).toHaveBeenCalledTimes(1)
    expect(h.reloadDisk).not.toHaveBeenCalled()
  })

  it('closes on Escape without asking for a reload', () => {
    const h = handlers()
    mountDialog('tab-1', h)
    const overlay = document.body.querySelector('.dialog-overlay') as HTMLElement
    overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(h.close).toHaveBeenCalled()
    expect(h.reloadDisk).not.toHaveBeenCalled()
  })
})
