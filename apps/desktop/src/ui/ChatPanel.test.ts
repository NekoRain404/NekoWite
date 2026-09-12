import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import ChatPanel from './ChatPanel.vue'
import { onNotify } from '../services/errors'
import { formatAttachmentBytes, MAX_ATTACHMENT_BYTES } from '../services/attachments'
import { t } from '../i18n'

// The panel only needs the stream entry points here; the real module would
// reach for gateways and an editor session this test does not exercise.
vi.mock('../services/ai', () => ({
  startChatCompletion: vi.fn(),
  aiService: { cancelStream: vi.fn() },
}))

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** A File whose `size` is faked so the 10 MiB cap can be probed cheaply. */
function fileOfSize(name: string, size: number, type = 'image/png'): File {
  const file = new File(['x'], name, { type })
  Object.defineProperty(file, 'size', { value: size, configurable: true })
  return file
}

let pinia: Pinia
let mounted: VueApp[] = []
let notifications: string[] = []
let off: (() => void) | null = null

function mountPanel(): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(ChatPanel)
  app.use(pinia)
  app.mount(host)
  mounted.push(app)
  return host
}

function pickFiles(host: HTMLElement, files: File[]): void {
  const input = host.querySelector<HTMLInputElement>('.chat-file-input')
  expect(input).toBeTruthy()
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  input!.dispatchEvent(new Event('change'))
}

function typePrompt(host: HTMLElement, text: string): HTMLTextAreaElement {
  const textarea = host.querySelector<HTMLTextAreaElement>('.chat-textarea')
  expect(textarea).toBeTruthy()
  textarea!.value = text
  textarea!.dispatchEvent(new Event('input'))
  return textarea!
}

function sendButton(host: HTMLElement): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>('.chat-send')!
}

describe('ChatPanel image attachments', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    notifications = []
    mounted = []
    document.body.innerHTML = ''
    // The context toggle defaults to on; turning it off keeps `send()` from
    // stopping at the "open a document first" guard in this document-less
    // harness before it reaches the image encode this suite is about.
    localStorage.setItem('nekowite.chat.attachContext', '0')
    off = onNotify((msg) => notifications.push(msg))
  })

  afterEach(() => {
    off?.()
    off = null
    mounted.forEach((app) => app.unmount())
    mounted = []
    document.body.innerHTML = ''
  })

  it('adds a normal image and enables Send', async () => {
    const host = mountPanel()
    pickFiles(host, [fileOfSize('pic.png', 1024)])
    await flush()

    expect(host.querySelectorAll('.chat-attach')).toHaveLength(1)
    expect(sendButton(host).disabled).toBe(false)
    expect(notifications).toEqual([])
  })

  it('refuses an image over the limit as soon as it is added, naming the limit', async () => {
    const host = mountPanel()
    pickFiles(host, [fileOfSize('huge.png', MAX_ATTACHMENT_BYTES + 1)])
    await flush()

    // The thumbnail never appears, so Send cannot enable with an image the
    // send path would refuse anyway.
    expect(host.querySelectorAll('.chat-attach')).toHaveLength(0)
    expect(sendButton(host).disabled).toBe(true)
    expect(notifications).toEqual([
      t('chat.imageTooLarge', { max: formatAttachmentBytes(MAX_ATTACHMENT_BYTES) }),
    ])
    expect(notifications[0]).toContain('10 MB')
  })

  it('surfaces a failed send instead of looking alive while doing nothing', async () => {
    const host = mountPanel()
    const file = fileOfSize('pic.png', 1024)
    // Simulate a blob the webview cannot read: the encode rejects inside
    // `send()`, which used to leave the click silently without effect.
    Object.defineProperty(file, 'arrayBuffer', {
      value: () => Promise.reject(new Error('unreadable blob')),
    })
    pickFiles(host, [file])
    const textarea = typePrompt(host, 'hello')
    await flush()

    const send = sendButton(host)
    expect(send.disabled).toBe(false)
    send.click()
    await flush()

    // The rejection is reported...
    expect(notifications).toContain(t('chat.sendFailed'))
    // ...the message is not half-committed, and the draft plus attachment
    // survive so the user can remove the image and retry.
    expect(host.querySelectorAll('.chat-row')).toHaveLength(0)
    expect(textarea.value).toBe('hello')
    expect(host.querySelectorAll('.chat-attach')).toHaveLength(1)
  })
})
