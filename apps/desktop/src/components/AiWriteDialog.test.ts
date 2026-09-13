import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import AiWriteDialog from './AiWriteDialog.vue'

let mounted: VueApp[] = []

function mount(responses: Array<[boolean, boolean]>): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const pending = {
    request: {
      kind: 'insert',
      summary: 'Insert a paragraph about cats',
      target: '/vault/a.md',
    },
    resolve: vi.fn(),
  }
  const app = createApp(AiWriteDialog, {
    pending,
    onRespond: (approved: boolean, remember: boolean) => responses.push([approved, remember]),
  } as never)
  app.mount(host)
  mounted.push(app)
  return host
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
  document.body.innerHTML = ''
})

describe('AiWriteDialog approval safety', () => {
  it('opens with focus on the dialog itself, not on "Allow once"', async () => {
    // The prompt is a permission gate. Landing focus on "Allow once" meant one
    // Enter press (often the tail of what the user was typing when the dialog
    // appeared) approved a write they never read. The container takes focus, so
    // every answer is an explicit move.
    const host = mount([])
    await nextTick()
    await flush()

    const dialog = host.querySelector<HTMLElement>('.ai-write-dialog')!
    expect(document.activeElement).toBe(dialog)
    const allowOnce = host.querySelector<HTMLButtonElement>('.ai-write-dialog .btn-primary')!
    expect(allowOnce).toBeTruthy()
    expect(document.activeElement).not.toBe(allowOnce)
  })

  it('treats Escape as a denial', async () => {
    const responses: Array<[boolean, boolean]> = []
    const host = mount(responses)
    await nextTick()
    host.querySelector<HTMLElement>('.ai-write-dialog')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(responses).toEqual([[false, false]])
  })
})
