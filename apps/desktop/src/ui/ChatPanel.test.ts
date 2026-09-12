import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import ChatPanel from './ChatPanel.vue'
import { onNotify } from '../services/errors'
import { formatAttachmentBytes, MAX_ATTACHMENT_BYTES } from '../services/attachments'
import { t } from '../i18n'
import { aiService, startChatCompletion, type ChatStreamHandlers } from '../services/ai'
import { CHAT_SESSIONS_KEY, useChatSessionStore } from '../stores/chatSession'

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
let mounted: Array<{ app: VueApp; host: HTMLElement }> = []
let notifications: string[] = []
let off: (() => void) | null = null

function mountPanel(): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(ChatPanel)
  app.use(pinia)
  app.mount(host)
  mounted.push({ app, host })
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

/** Unmount one panel on its own — what closing the info rail does (`v-if` in
 * AppShell), as opposed to tearing down every mounted app at the end. */
function unmountPanel(host: HTMLElement): void {
  const index = mounted.findIndex((entry) => entry.host === host)
  expect(index).toBeGreaterThanOrEqual(0)
  mounted[index].app.unmount()
  mounted.splice(index, 1)
}

/** Arm the mocked stream entry point: capture the handlers the panel passed in
 * and hand back the per-stream cancel it is expected to invoke on teardown. */
function startStream(): { cancel: ReturnType<typeof vi.fn>; handlers: () => ChatStreamHandlers } {
  const cancel = vi.fn()
  const calls: ChatStreamHandlers[] = []
  vi.mocked(startChatCompletion).mockImplementation((_config, _prompt, _images, handlers) => {
    calls.push(handlers)
    return Promise.resolve({ cancel })
  })
  return { cancel, handlers: () => calls[0] }
}

// Shared by both suites below: every test needs a fresh pinia (and therefore a
// fresh chat-session store), a fresh host and a clean notification list.
beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  notifications = []
  mounted = []
  // Call history must not leak between tests: the unmount suite asserts
  // "cancel ran exactly once" on the stream it started itself.
  vi.clearAllMocks()
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
  mounted.forEach(({ app }) => app.unmount())
  mounted = []
  document.body.innerHTML = ''
})

describe('ChatPanel image attachments', () => {
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

describe('ChatPanel unmount during a stream', () => {
  it('cancels the running request and persists the answer so far', async () => {
    const host = mountPanel()
    const stream = startStream()
    typePrompt(host, '解释一下这段代码')
    await flush()
    const send = sendButton(host)
    expect(send.disabled).toBe(false)
    send.click()
    await flush()

    stream.handlers().onChunk('第一段讲的是')
    await flush()
    expect(host.querySelectorAll('.chat-row')).toHaveLength(2)

    // Closing the rail destroys the panel while the request is still open.
    unmountPanel(host)

    // The per-stream cancel callback ran, and the app-level registry — the one
    // that owns the backend request id — was told to cancel as well.
    expect(stream.cancel).toHaveBeenCalledTimes(1)
    expect(vi.mocked(aiService.cancelStream)).toHaveBeenCalledTimes(1)

    const messages = useChatSessionStore().activeSession!.messages
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ role: 'user', content: '解释一下这段代码' })
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      content: '第一段讲的是',
      interrupted: true,
    })
    // Persisted, not merely in memory: a reload or a session switch must find it.
    const stored = JSON.parse(localStorage.getItem(CHAT_SESSIONS_KEY)!)
    expect(stored.sessions[0].messages[1]).toMatchObject({
      content: '第一段讲的是',
      interrupted: true,
    })
  })

  it('shows the partial answer marked as interrupted when the rail is reopened', async () => {
    const host = mountPanel()
    const stream = startStream()
    typePrompt(host, '继续写')
    await flush()
    const send = sendButton(host)
    expect(send.disabled).toBe(false)
    send.click()
    await flush()
    stream.handlers().onChunk('写到一半')
    await flush()
    unmountPanel(host)

    const reopened = mountPanel()
    await flush()

    expect(reopened.querySelectorAll('.chat-row')).toHaveLength(2)
    expect(reopened.textContent).toContain('写到一半')
    const badge = reopened.querySelector('.chat-interrupted')
    expect(badge).toBeTruthy()
    expect(badge?.textContent).toBe(t('chat.interrupted'))
    expect(badge?.getAttribute('title')).toBe(t('chat.interruptedHint'))
  })

  it('leaves a completed answer unmarked and lets unmount do nothing', async () => {
    const host = mountPanel()
    const stream = startStream()
    typePrompt(host, '问一句')
    await flush()
    const send = sendButton(host)
    expect(send.disabled).toBe(false)
    send.click()
    await flush()
    stream.handlers().onDone('完整回答')
    await flush()

    const store = useChatSessionStore()
    expect(store.activeSession!.messages[1]).toMatchObject({ content: '完整回答' })
    expect(store.activeSession!.messages[1].interrupted).toBeUndefined()

    unmountPanel(host)
    expect(stream.cancel).not.toHaveBeenCalled()
    expect(vi.mocked(aiService.cancelStream)).not.toHaveBeenCalled()
    expect(store.activeSession!.messages[1].interrupted).toBeUndefined()

    const reopened = mountPanel()
    await flush()
    expect(reopened.querySelector('.chat-interrupted')).toBeNull()
    expect(reopened.textContent).toContain('完整回答')
  })

  it('does not cancel twice when the user stopped the stream before closing', async () => {
    const host = mountPanel()
    const stream = startStream()
    typePrompt(host, '停止测试')
    await flush()
    const send = sendButton(host)
    expect(send.disabled).toBe(false)
    send.click()
    await flush()
    stream.handlers().onChunk('半截')
    await flush()

    const stop = host.querySelector<HTMLButtonElement>('.chat-stop')
    expect(stop).toBeTruthy()
    stop!.click()
    await flush()
    expect(stream.cancel).toHaveBeenCalledTimes(1)

    unmountPanel(host)
    expect(stream.cancel).toHaveBeenCalledTimes(1)
    expect(vi.mocked(aiService.cancelStream)).toHaveBeenCalledTimes(1)
    // A deliberate stop is not an interruption: its answer is not flagged.
    expect(useChatSessionStore().activeSession!.messages[1].interrupted).toBeUndefined()
  })

  it('still cancels through the registry before the stream handle exists', async () => {
    const host = mountPanel()
    const cancel = vi.fn()
    let release!: (stream: { cancel(): void }) => void
    vi.mocked(startChatCompletion).mockImplementation(
      () =>
        new Promise<{ cancel(): void }>((resolve) => {
          release = resolve
        }),
    )
    typePrompt(host, '竞态')
    await flush()
    const send = sendButton(host)
    expect(send.disabled).toBe(false)
    send.click()
    await flush()

    // The start promise has not settled, so the panel still has no handle.
    unmountPanel(host)
    expect(vi.mocked(aiService.cancelStream)).toHaveBeenCalledTimes(1)

    // A handle that arrives late must not be adopted by the dead panel.
    release({ cancel })
    await flush()
    expect(cancel).not.toHaveBeenCalled()
  })

  it('does not start a request when the panel unmounts mid-encode', async () => {
    const host = mountPanel()
    let finishEncode: (() => void) | null = null
    const file = fileOfSize('pic.png', 1024)
    Object.defineProperty(file, 'arrayBuffer', {
      value: () =>
        new Promise<ArrayBuffer>((resolve) => {
          finishEncode = () => resolve(new ArrayBuffer(4))
        }),
    })
    pickFiles(host, [file])
    typePrompt(host, '慢编码')
    await flush()
    const send = sendButton(host)
    expect(send.disabled).toBe(false)
    send.click()
    await flush()
    unmountPanel(host)

    finishEncode!()
    await flush()
    expect(vi.mocked(startChatCompletion)).not.toHaveBeenCalled()
  })
})
