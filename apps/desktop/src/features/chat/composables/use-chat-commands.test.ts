/**
 * Which conversation a send belongs to.
 *
 * `send()` awaits a whole-document flush and an attachment encode before it
 * writes anything, and neither of those awaits is instant. `switchToSession`
 * replaces the panel's working copy (and the store's active session) while they
 * are running, so the write has to be re-checked against the conversation the
 * question was written for.
 *
 * The composing halves are the real ones - `useChatSession` and the real store -
 * because parking the composer under the conversation it belongs to is what
 * keeps the question from being lost, and that is theirs to get right.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, computed, nextTick, ref, type App as VueApp, type Ref } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { useChatCommands, type ChatCommandsModel } from './use-chat-commands'
import { useChatSession, type ChatSessionModel } from './use-chat-session'
import { useChatSessionStore } from '../../../stores/chat-session'
import { onNotify } from '../../../services/errors'
import { t } from '../../../i18n'
import { startChatCompletion, type ChatStreamHandlers } from '../../ai'
import { encodeAttachments } from './use-chat-attachments'
import type { ChatAttachment } from '../types'

// The send path only reaches the stream entry point here; the real module would
// pull in gateways and an editor session this harness does not exercise.
vi.mock('../../ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../ai')>()),
  startChatCompletion: vi.fn(),
  aiService: { cancelStream: vi.fn() },
}))

// Encoding is a wait of its own on the send path (a blob read per image), and
// it is the window a second press can slip through. Mocked so a test can hold
// it open; the real `fileToDataURL` is a `FileReader` and the encoding itself
// is not what these tests are about.
vi.mock('./use-chat-attachments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./use-chat-attachments')>()),
  encodeAttachments: vi.fn(),
}))

interface Harness {
  commands: ChatCommandsModel
  session: ChatSessionModel
  prompt: Ref<string>
  attachments: Ref<ChatAttachment[]>
  /** Resolve the Nth `buildActiveContext()` the send path is waiting on.
   *  `omitted` is what the budget left out, so a test can drive the notice the
   *  user gets when their note was longer than the context they allowed. */
  releaseContext: (index: number, context: string, omitted?: number) => void
  /** Resolve EVERY context build still pending, so a test that does not know
   *  how many sends are waiting (that is the thing under test) still lets each
   *  of them finish. */
  releasePendingContexts: (context: string) => void
  /** How many context builds have been asked for: the second one is the
   *  duplicate send, arriving before anything has been decided to send. */
  contextBuilds: () => number
}

let pinia: Pinia
let mounted: VueApp[] = []
let notifications: string[] = []
let offNotify: (() => void) | null = null

/** `ChatPanel`'s wiring, minus the template: the same `useChatSession` +
 *  `useChatCommands` pair over the same shared refs. */
function mountHarness(): Harness {
  const prompt = ref('')
  const attachments = ref<ChatAttachment[]>([])
  const contexts: Array<(value: { text: string; omitted: number }) => void> = []
  let contextBuilds = 0
  let created: { commands: ChatCommandsModel; session: ChatSessionModel } | null = null

  const app = createApp({
    setup() {
      const session = useChatSession({
        prompt,
        attachments,
        releaseUrls: () => undefined,
      })
      const commands = useChatCommands({
        prompt,
        attachments,
        messages: session.messages,
        syncSession: session.syncSession,
        clearAttachments: () => {
          attachments.value = []
        },
        forgetDraft: session.forgetDraft,
        attachContext: ref(true),
        hasActiveTab: computed(() => true),
        buildActiveContext: () =>
          new Promise<{ text: string; omitted: number }>((resolve) => {
            contextBuilds += 1
            contexts.push(resolve)
          }),
        scrollToBottom: () => undefined,
      })
      created = { commands, session }
      return () => null
    },
  })
  app.use(pinia)
  app.mount(document.createElement('div'))
  mounted.push(app)

  return {
    get commands() {
      return created!.commands
    },
    get session() {
      return created!.session
    },
    prompt,
    attachments,
    releaseContext: (index, context, omitted = 0) => contexts[index]!({ text: context, omitted }),
    releasePendingContexts: (context) => {
      while (contexts.length) contexts.shift()!({ text: context, omitted: 0 })
    },
    contextBuilds: () => contextBuilds,
  } as Harness
}

/** Two conversations, each with one turn, and A active. */
function seedSessions(): { store: ReturnType<typeof useChatSessionStore>; aId: string; bId: string } {
  const store = useChatSessionStore()
  const aId = store.activeId!
  store.setMessages([{ role: 'user', content: 'A: earlier turn' }])
  const bId = store.newSession().id
  store.setMessages([{ role: 'user', content: 'B: something else entirely' }])
  store.switchSession(aId)
  return { store, aId, bId }
}

function attachment(id: string, name: string): ChatAttachment {
  return { id, name, file: new File(['x'], name), url: `blob:${id}` }
}

function messagesOf(id: string): string[] {
  const session = useChatSessionStore().sessions.find((s) => s.id === id)
  return (session?.messages ?? []).map((m) => m.content)
}

beforeEach(() => {
  localStorage.clear()
  pinia = createPinia()
  setActivePinia(pinia)
  mounted = []
  notifications = []
  vi.clearAllMocks()
  vi.mocked(startChatCompletion).mockImplementation(
    (_c, _p, _i, handlers: ChatStreamHandlers) => {
      handlers.onDone('ok')
      return Promise.resolve({ cancel: vi.fn() } as never)
    },
  )
  vi.mocked(encodeAttachments).mockImplementation(async (list) =>
    list.map((a) => ({ id: a.id, name: a.name, dataUrl: `data:${a.name}` })),
  )
  offNotify = onNotify((msg) => notifications.push(msg))
})

afterEach(() => {
  offNotify?.()
  offNotify = null
  mounted.forEach((app) => app.unmount())
  mounted = []
})

describe('sending while the conversation changes', () => {
  it('files nothing into the conversation the user switched to', async () => {
    const { aId, bId } = seedSessions()
    const h = mountHarness()
    await nextTick()

    // B has a draft of its own, parked by a switch away from it.
    h.session.switchToSession(bId)
    h.prompt.value = 'B: parked draft'
    h.session.switchToSession(aId)
    expect(h.prompt.value).toBe('')

    h.prompt.value = 'what is this about?'
    const sending = h.commands.send()
    // The rail's session bar is live during the flush the send is waiting on.
    h.session.switchToSession(bId)
    h.releaseContext(0, 'the note as it stands')
    await sending

    // The question, its placeholder and the request were all for A. B's
    // transcript must not gain them, and B's own parked draft must not be the
    // one that gets thrown away.
    expect(messagesOf(bId)).toEqual(['B: something else entirely'])
    expect(startChatCompletion).not.toHaveBeenCalled()

    h.session.switchToSession(bId)
    expect(h.prompt.value).toBe('B: parked draft')

    // ...and nothing is lost: the question stayed with the conversation it was
    // written for, editable, waiting to be sent again.
    h.session.switchToSession(aId)
    expect(h.prompt.value).toBe('what is this about?')
    expect(notifications).toContain(t('chat.sessionMoved'))
  })

  it('still sends when the user comes back to the conversation they left', async () => {
    const { aId, bId } = seedSessions()
    const h = mountHarness()
    await nextTick()

    h.prompt.value = 'still mine'
    const sending = h.commands.send()
    h.session.switchToSession(bId)
    h.session.switchToSession(aId)
    h.releaseContext(0, 'the note as it stands')
    await sending

    expect(startChatCompletion).toHaveBeenCalledTimes(1)
    expect(messagesOf(aId)).toEqual(['A: earlier turn', 'still mine', 'ok'])
    expect(messagesOf(bId)).toEqual(['B: something else entirely'])
  })

  it('sends normally when nothing moved', async () => {
    const { aId } = seedSessions()
    const h = mountHarness()
    await nextTick()

    h.prompt.value = 'unchanged'
    const sending = h.commands.send()
    h.releaseContext(0, 'the note as it stands')
    await sending

    expect(messagesOf(aId)).toEqual(['A: earlier turn', 'unchanged', 'ok'])
    expect(notifications).toEqual([])
    // The composer is cleared only once the question is really on its way.
    expect(h.prompt.value).toBe('')
  })

  it('tells the user when the note did not fit the context they allowed', async () => {
    // The model has been told since the day the notice went into the block;
    // the person who wrote the note never was, because that notice rides
    // inside the context. This is the one place the count reaches them, and it
    // is the send it belongs to rather than a settings screen they would have
    // to go and read.
    seedSessions()
    const h = mountHarness()
    await nextTick()

    h.prompt.value = 'summarise this'
    const sending = h.commands.send()
    h.releaseContext(0, 'the note as it stands', 4200)
    await sending

    expect(notifications).toEqual([t('aiSettings.contextTruncatedNotice', { omitted: 4200 })])
  })

  it('says nothing when the whole note fitted', async () => {
    seedSessions()
    const h = mountHarness()
    await nextTick()

    h.prompt.value = 'summarise this'
    const sending = h.commands.send()
    h.releaseContext(0, 'the note as it stands', 0)
    await sending

    expect(notifications).toEqual([])
  })
})

/**
 * A question is not on its way until the context is built and the images are
 * encoded, and both of those await. Until then the composer is live: a second
 * Enter, a second click and a second click on a button the browser has not yet
 * repainted all reach `send()` — and the guard at the top of it only knew about
 * `streaming`, which is not set until after those awaits. Two questions then
 * left the app for one press, and each carried its own request.
 *
 * The counts are asserted in LAYERS on purpose. `startChatCompletion` is called
 * once per request the renderer starts, which is not the same claim as "one
 * provider call was billed" — that one cannot be observed from here, so it is
 * not what this asserts.
 */
describe('two sends for one press', () => {
  it('starts one request and files one question when Enter fires twice', async () => {
    const { aId } = seedSessions()
    const h = mountHarness()
    await nextTick()

    h.prompt.value = 'what is this about?'
    const first = h.commands.send()
    // The second keystroke, while the first is still building context. It is
    // synchronous with the first: nothing has been awaited yet.
    const second = h.commands.send()
    h.releasePendingContexts('the note as it stands')
    await Promise.all([first, second])

    // Layer 3: the request the renderer started.
    expect(startChatCompletion).toHaveBeenCalledTimes(1)
    // Layer 1: the panel's working copy - one question, one answer.
    expect(h.session.messages.value.map((m) => [m.role, m.content])).toEqual([
      ['user', 'A: earlier turn'],
      ['user', 'what is this about?'],
      ['assistant', 'ok'],
    ])
    // Layer 2: what the conversation persists.
    expect(messagesOf(aId)).toEqual(['A: earlier turn', 'what is this about?', 'ok'])
    // ...and the context was built once for the one question that went out.
    expect(h.contextBuilds()).toBe(1)
  })

  it('starts one request when a second send arrives while the images encode', async () => {
    const { aId } = seedSessions()
    const h = mountHarness()
    await nextTick()
    h.attachments.value = [attachment('img-1', 'a.png')]

    // Hold the encode open, so the second press lands in THAT window rather
    // than the context one - the lock has to be taken before both.
    let releaseEncode: () => void = () => undefined
    const encoding = new Promise<void>((resolve) => {
      releaseEncode = resolve
    })
    const encode = vi.mocked(encodeAttachments)
    encode.mockImplementationOnce(async (list) => {
      await encoding
      return list.map((a) => ({ id: a.id, name: a.name, dataUrl: `data:${a.name}` }))
    })

    h.prompt.value = 'with a picture'
    const first = h.commands.send()
    h.releaseContext(0, 'the note as it stands', 0)
    await vi.waitFor(() => expect(encode).toHaveBeenCalledTimes(1))
    const second = h.commands.send()
    releaseEncode()
    // Pre-fix the duplicate had a preparation of its own, waiting on a context
    // build of its own; releasing whatever is pending is what lets the run
    // reach the assertions instead of timing out on it.
    h.releasePendingContexts('')
    await Promise.all([first, second])

    expect(startChatCompletion).toHaveBeenCalledTimes(1)
    expect(messagesOf(aId)).toEqual(['A: earlier turn', 'with a picture', 'ok'])
  })

  it('releases the lock when a preparation fails, so the retry goes out', async () => {
    // The one thing a lock like this must not do is wedge the composer. A
    // failed encode leaves the draft and its images in place (that is the point
    // of failing here), and the very next send has to be able to use them.
    const { aId } = seedSessions()
    const h = mountHarness()
    await nextTick()

    h.attachments.value = [attachment('img-1', 'a.png')]
    const encode = vi.mocked(encodeAttachments)
    encode.mockRejectedValueOnce(new Error('unreadable'))
    h.prompt.value = 'the first attempt'
    const failed = h.commands.send()
    h.releaseContext(0, 'the note as it stands', 0)
    await failed
    expect(startChatCompletion).not.toHaveBeenCalled()
    expect(notifications).toContain(t('chat.sendFailed'))

    // Same composer, same images, second press: this is a fresh send.
    h.prompt.value = 'the second attempt'
    const retry = h.commands.send()
    h.releaseContext(1, 'the note as it stands', 0)
    await retry
    expect(startChatCompletion).toHaveBeenCalledTimes(1)
    expect(messagesOf(aId)).toEqual(['A: earlier turn', 'the second attempt', 'ok'])
  })

  it('releases the lock when the conversation moves under a preparing send', async () => {
    const { aId, bId } = seedSessions()
    const h = mountHarness()
    await nextTick()

    h.prompt.value = 'for A only'
    const sending = h.commands.send()
    // The switch that refuses the send (see the tests above), and then a
    // question in B: the panel must not be left unable to send at all.
    h.session.switchToSession(bId)
    h.releaseContext(0, 'the note as it stands')
    await sending
    expect(startChatCompletion).not.toHaveBeenCalled()

    h.prompt.value = 'for B'
    const second = h.commands.send()
    h.releaseContext(1, 'the note as it stands')
    await second

    expect(startChatCompletion).toHaveBeenCalledTimes(1)
    expect(messagesOf(bId)).toEqual(['B: something else entirely', 'for B', 'ok'])
    h.session.switchToSession(aId)
    expect(h.prompt.value).toBe('for A only')
  })

  it('sends nothing when the user stops a send that has not gone out yet', async () => {
    const { aId } = seedSessions()
    const h = mountHarness()
    await nextTick()

    h.prompt.value = 'stopped before it left'
    const sending = h.commands.send()
    h.commands.stop()
    h.releaseContext(0, 'the note as it stands')
    await sending

    expect(startChatCompletion).not.toHaveBeenCalled()
    expect(messagesOf(aId)).toEqual(['A: earlier turn'])
    // Nothing was taken from the composer, and the panel is usable again: a
    // stop is not a loss, it is a question still waiting to be sent.
    expect(h.prompt.value).toBe('stopped before it left')
    expect(h.commands.canSend.value).toBe(true)
  })

  it('sends nothing when the panel is closed while it prepares', async () => {
    const { aId } = seedSessions()
    const h = mountHarness()
    await nextTick()

    h.prompt.value = 'never sent'
    const sending = h.commands.send()
    h.commands.dispose()
    h.releaseContext(0, 'the note as it stands')
    await sending

    expect(startChatCompletion).not.toHaveBeenCalled()
    expect(messagesOf(aId)).toEqual(['A: earlier turn'])
  })
})

/**
 * The panel's half of the same question `ai-chat` answers for the registry:
 * an outcome belongs to the send that produced it.
 *
 * The service keeps the live request's listeners alive through an abandoned
 * request's failure, and it still reports that failure to the caller that asked
 * for it - it has no way to know whether that caller still cares, and other
 * callers of `startChatCompletion` may be waiting on the callback. Whether a
 * replaced request may still act on the PANEL is a question only the panel can
 * answer, and this is the panel answering it.
 */
describe('an outcome that arrives after the panel moved on', () => {
  it('does not end the request that replaced it', async () => {
    const { aId } = seedSessions()
    const h = mountHarness()
    await nextTick()

    const requests: ChatStreamHandlers[] = []
    vi.mocked(startChatCompletion).mockImplementation((_c, _p, _i, handlers) => {
      requests.push(handlers)
      return Promise.resolve({ cancel: vi.fn() } as never)
    })

    h.prompt.value = 'first question'
    const first = h.commands.send()
    h.releaseContext(0, 'the note as it stands')
    await first
    expect(requests).toHaveLength(1)

    // The user clears the conversation and asks something else while the first
    // request is still open.
    h.commands.clearAll()
    h.prompt.value = 'second question'
    const second = h.commands.send()
    h.releaseContext(1, 'the note as it stands')
    await second
    expect(requests).toHaveLength(2)

    // The replaced request fails late. (It still says so - that toast is about
    // a request the user really did make - but the panel is not its to touch.)
    h.prompt.value = 'typing the next one'
    requests[0].onError('boom')
    await nextTick()

    // The live request is still live: the composer is still locked, and the
    // placeholder is still an answer on its way.
    expect(h.commands.canSend.value).toBe(false)
    expect(h.session.messages.value.at(-1)).toMatchObject({ role: 'assistant', streaming: true })
    // ...and the late failure did not write itself into the transcript.
    expect(messagesOf(aId)).toEqual(['second question'])
  })
})
