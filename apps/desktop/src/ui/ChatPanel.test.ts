import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import ChatPanel from './ChatPanel.vue'
import { onNotify } from '../services/errors'
import { formatAttachmentBytes, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE } from '../services/attachments'
import { t } from '../i18n'
import { aiService, startChatCompletion, type ChatStreamHandlers } from '../services/ai'
import { CHAT_SESSIONS_KEY, useChatSessionStore } from '../stores/chatSession'
import { useTabsStore } from '../stores/tabs'

// The panel only needs the stream entry points here; the real module would
// reach for gateways and an editor session this test does not exercise.
const readMock = vi.hoisted(() => vi.fn())

// `openTab` reads through the fs gateway. Only `read` is reachable from this
// harness; the note it returns is empty on purpose (see the empty-note case).
vi.mock('../platform/gateways/fs', () => ({
  fsService: { read: readMock },
}))

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

describe('ChatPanel composer drafts', () => {
  /** Drive the panel the way a user does - its own header buttons and the
   *  session selector - so the code under test is the code that runs. */
  function clickTool(host: HTMLElement, label: string): void {
    const btn = [...host.querySelectorAll<HTMLButtonElement>('.chat-tool')].find(
      (b) => b.getAttribute('title') === label,
    )
    expect(btn, `no tool button titled "${label}"`).toBeTruthy()
    btn!.click()
  }

  function selectSession(host: HTMLElement, id: string): void {
    const select = host.querySelector<HTMLSelectElement>('.chat-session-select')!
    select.value = id
    select.dispatchEvent(new Event('change'))
  }

  it('keeps a half-written question with the session it was written for', async () => {
    // Switching to another conversation to check something used to wipe the
    // composer: the question you were mid-way through - and the images you had
    // attached - were simply gone.
    const host = mountPanel()
    await flush()
    const store = useChatSessionStore()
    const first = store.activeId!
    typePrompt(host, 'draft one')
    pickFiles(host, [fileOfSize('pic.png', 512)])
    await flush()

    clickTool(host, t('chat.newSession'))
    await flush()
    expect(host.querySelector<HTMLTextAreaElement>('.chat-textarea')!.value).toBe('')
    expect(host.querySelectorAll('.chat-attach')).toHaveLength(0)

    selectSession(host, first)
    await flush()
    expect(host.querySelector<HTMLTextAreaElement>('.chat-textarea')!.value).toBe('draft one')
    expect(host.querySelectorAll('.chat-attach')).toHaveLength(1)
  })

  it('drops the draft with the session it belonged to', async () => {
    // Restoring a dead session's question into a different conversation would
    // attach a prompt to the wrong history.
    const host = mountPanel()
    await flush()
    const store = useChatSessionStore()
    const first = store.activeId!
    clickTool(host, t('chat.newSession'))
    await flush()
    const second = store.activeId!
    typePrompt(host, 'doomed draft')
    await flush()

    clickTool(host, t('chat.deleteSession'))
    await flush()
    expect(store.sessions.some((x) => x.id === second)).toBe(false)
    expect(host.querySelector<HTMLTextAreaElement>('.chat-textarea')!.value).toBe('')
    // ...and it does not come back with the session we return to.
    selectSession(host, first)
    await flush()
    expect(host.querySelector<HTMLTextAreaElement>('.chat-textarea')!.value).toBe('')
  })

  it('forgets the draft once it has been sent', async () => {
    const host = mountPanel()
    await flush()
    const store = useChatSessionStore()
    const first = store.activeId!
    typePrompt(host, 'sent already')
    await flush()
    sendButton(host).click()
    await flush()

    clickTool(host, t('chat.newSession'))
    await flush()
    selectSession(host, first)
    await flush()
    expect(host.querySelector<HTMLTextAreaElement>('.chat-textarea')!.value).toBe('')
  })
})

describe('ChatPanel attachment and answer honesty', () => {
  it('caps the number of images one message may carry', async () => {
    // Each attachment is base64-encoded into the SAME request, so a user who
    // adds images one at a time could otherwise send an arbitrarily large body
    // (and blow up both processes on the way).
    const host = mountPanel()
    const many = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 2 }, (_, i) =>
      fileOfSize(`pic-${i}.png`, 512),
    )
    pickFiles(host, many)
    await flush()

    expect(host.querySelectorAll('.chat-attach')).toHaveLength(MAX_ATTACHMENTS_PER_MESSAGE)
    expect(notifications).toEqual([
      t('chat.tooManyImages', { max: MAX_ATTACHMENTS_PER_MESSAGE }),
    ])
    // The refusal is not a failure: what was accepted still sends.
    typePrompt(host, 'look at these')
    await flush()
    expect(sendButton(host).disabled).toBe(false)
  })

  it('keeps a storage notice on the message it belongs to', async () => {
    // The store explains why an image is missing ("too large", "removed by the
    // storage limit"). The panel used to drop the notice on the floor, so the
    // attachment simply vanished with no explanation.
    const host = mountPanel()
    const store = useChatSessionStore()
    store.setMessages([
      { role: 'user', content: 'see this', imageNotice: 'image too large' },
    ])
    const host2 = mountPanel()
    await flush()
    const texts = [...document.body.querySelectorAll('.chat-image-notice')].map(
      (n) => n.textContent?.trim(),
    )
    expect(texts).toContain('image too large')
    unmountPanel(host)
    unmountPanel(host2)
  })

  it('marks a half-streamed answer as interrupted when the request fails', async () => {
    // Half a paragraph presented as the finished reply is how a user quotes a
    // sentence the model never completed.
    const host = mountPanel()
    let fail: ((msg: string) => void) | null = null
    vi.mocked(startChatCompletion).mockImplementation((_c, _p, _i, handlers) => {
      handlers.onChunk('The answer so far')
      fail = handlers.onError
      return Promise.resolve({ cancel: vi.fn() } as never)
    })
    typePrompt(host, 'question')
    await flush()
    sendButton(host).click()
    await flush()

    fail!('connection lost')
    await flush()

    expect(notifications.some((n) => n.includes('connection lost'))).toBe(true)
    expect(useChatSessionStore().activeSession?.messages.at(-1)?.interrupted).toBe(true)
  })

  it('leaves a complete answer unmarked when nothing failed', async () => {
    const host = mountPanel()
    vi.mocked(startChatCompletion).mockImplementation((_c, _p, _i, handlers) => {
      handlers.onChunk('done')
      handlers.onDone('done')
      return Promise.resolve({ cancel: vi.fn() } as never)
    })
    typePrompt(host, 'question')
    await flush()
    sendButton(host).click()
    await flush()

    expect(useChatSessionStore().activeSession?.messages.at(-1)?.interrupted).toBeUndefined()
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

describe('attaching the current note', () => {
  it('sends the message when the note is empty, saying it carries no context', async () => {
    // An empty note is not a MISSING document. Refusing to send blocked the
    // very scenario the feature exists for - help me outline the note I just
    // created - with a message claiming no document was open while one plainly
    // was.
    localStorage.setItem('nekowite.chat.attachContext', '1')
    readMock.mockResolvedValue('')
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab('/vault/empty.md')
    expect(tabs.activeTab?.content).toBe('')
    const host = mountPanel()
    await flush()

    typePrompt(host, 'help me outline this')
    await flush()
    expect(sendButton(host).disabled).toBe(false)
    sendButton(host).click()
    await flush()

    expect(vi.mocked(startChatCompletion)).toHaveBeenCalled()
    // The user is told the note carried nothing - the message is not silently
    // sent as if the note were attached, and the send is not blocked either.
    expect(notifications).toEqual([t('chat.emptyDocSent')])
    unmountPanel(host)
  })

  it('still refuses when no document is open at all', async () => {
    // The complement of the case above: nothing open is a real error, and it
    // must not be softened into a context-less send.
    localStorage.setItem('nekowite.chat.attachContext', '1')
    readMock.mockResolvedValue('')
    const host = mountPanel()
    await flush()

    typePrompt(host, 'hello')
    await flush()
    sendButton(host).click()
    await flush()

    expect(vi.mocked(startChatCompletion)).not.toHaveBeenCalled()
    expect(notifications).toEqual([t('chat.emptyDocHint')])
    unmountPanel(host)
  })
})
