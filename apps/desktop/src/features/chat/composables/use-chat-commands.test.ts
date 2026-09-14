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
import type { ChatAttachment } from '../types'

// The send path only reaches the stream entry point here; the real module would
// pull in gateways and an editor session this harness does not exercise.
vi.mock('../../ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../ai')>()),
  startChatCompletion: vi.fn(),
  aiService: { cancelStream: vi.fn() },
}))

interface Harness {
  commands: ChatCommandsModel
  session: ChatSessionModel
  prompt: Ref<string>
  attachments: Ref<ChatAttachment[]>
  /** Resolve the Nth `buildActiveContext()` the send path is waiting on. */
  releaseContext: (index: number, context: string) => void
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
  const contexts: Array<(value: string) => void> = []
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
          new Promise<string>((resolve) => {
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
    releaseContext: (index, context) => contexts[index]!(context),
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
})
