import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  CHAT_SESSIONS_KEY,
  createSession,
  titleFromText,
  useChatSessionStore,
  applyImageCaps,
  IMAGE_EVICTED_NOTICE,
  IMAGE_TOO_LARGE,
  MAX_IMAGE_BASE64_LENGTH,
} from './chatSession'

function sessionStore() {
  const s = useChatSessionStore()
  return s
}

/** A tiny helper to build image Data URLs of a controllable (base64) length. */
function dataUrl(length: number): string {
  return 'data:image/png;base64,' + 'a'.repeat(length)
}

describe('titleFromText', () => {
  it('collapses whitespace and trims', () => {
    expect(titleFromText('  hello   world  ')).toBe('hello world')
  })

  it('returns an empty string for blank input', () => {
    expect(titleFromText('   \n  ')).toBe('')
    expect(titleFromText('')).toBe('')
  })

  it('truncates to max characters with an ellipsis', () => {
    const long = 'a'.repeat(30)
    expect(titleFromText(long)).toBe(`${'a'.repeat(20)}…`)
  })
})

describe('chatSession store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('seeds a default empty session on load', () => {
    const store = sessionStore()
    expect(store.sessions).toHaveLength(1)
    expect(store.sessions[0].messages).toEqual([])
    expect(store.activeId).toBe(store.sessions[0].id)
  })

  it('newSession appends and activates a fresh session', () => {
    const store = sessionStore()
    const first = store.sessions[0].id
    const created = store.newSession()
    expect(store.sessions).toHaveLength(2)
    expect(store.activeId).toBe(created.id)
    expect(store.activeId).not.toBe(first)
  })

  it('switchSession activates an existing session', () => {
    const store = sessionStore()
    const first = store.sessions[0]
    const second = store.newSession()
    store.switchSession(first.id)
    expect(store.activeId).toBe(first.id)
    store.switchSession(second.id)
    expect(store.activeId).toBe(second.id)
  })

  it('switchSession ignores an unknown id', () => {
    const store = sessionStore()
    const before = store.activeId
    store.switchSession('nope')
    expect(store.activeId).toBe(before)
  })

  it('deleteSession removes the session and activates another', () => {
    const store = sessionStore()
    const first = store.sessions[0]
    const second = store.newSession()
    store.deleteSession(second.id)
    expect(store.sessions).toHaveLength(1)
    expect(store.activeId).toBe(first.id)
  })

  it('deleting the last session reseeds a default empty session', () => {
    const store = sessionStore()
    const only = store.sessions[0]
    store.deleteSession(only.id)
    expect(store.sessions).toHaveLength(1)
    expect(store.sessions[0].messages).toEqual([])
    expect(store.sessions[0].id).not.toBe(only.id)
  })

  it('appendMessage derives a title from the first user message', () => {
    const store = sessionStore()
    store.appendMessage({ role: 'user', content: '如何优化这段代码？' })
    store.appendMessage({ role: 'assistant', content: '可以考虑…' })
    const session = store.sessions[0]
    expect(session.messages).toHaveLength(2)
    expect(session.title).toBe('如何优化这段代码？')
  })

  it('appendMessage keeps an explicit title once set', () => {
    const store = sessionStore()
    store.renameSession(store.sessions[0].id, '我的会话')
    store.appendMessage({ role: 'user', content: '新问题' })
    expect(store.sessions[0].title).toBe('我的会话')
  })

  it('updateLast patches only the newest message', () => {
    const store = sessionStore()
    store.appendMessage({ role: 'user', content: 'hi' })
    store.appendMessage({ role: 'assistant', content: '' })
    store.updateLast({ content: 'streamed answer' })
    const messages = store.sessions[0].messages
    expect(messages).toHaveLength(2)
    expect(messages[1].content).toBe('streamed answer')
    expect(messages[0].content).toBe('hi')
  })

  it('persists and reloads the full state round-trip', () => {
    const store = sessionStore()
    store.renameSession(store.sessions[0].id, '设计评审')
    store.appendMessage({ role: 'user', content: '帮我设计主界面' })
    store.appendMessage({ role: 'assistant', content: '方案如下…' })
    store.newSession()

    setActivePinia(createPinia())
    const reloaded = sessionStore()
    expect(reloaded.sessions).toHaveLength(2)
    expect(reloaded.activeId).toBe(store.activeId)
    const first = reloaded.sessions[0]
    expect(first.title).toBe('设计评审')
    expect(first.messages).toEqual([
      { role: 'user', content: '帮我设计主界面' },
      { role: 'assistant', content: '方案如下…' },
    ])
  })

  it('persists the active id across reloads', () => {
    const store = sessionStore()
    store.newSession()
    store.switchSession(store.sessions[0].id)

    setActivePinia(createPinia())
    const reloaded = sessionStore()
    expect(reloaded.activeId).toBe(store.sessions[0].id)
  })

  it('recovers from corrupted stored JSON', () => {
    localStorage.setItem(CHAT_SESSIONS_KEY, '{not valid json')
    const store = sessionStore()
    expect(store.sessions).toHaveLength(1)
    expect(store.sessions[0].messages).toEqual([])
  })

  it('recovers from structurally invalid stored data', () => {
    localStorage.setItem(CHAT_SESSIONS_KEY, JSON.stringify({ v: 1, sessions: 'oops' }))
    const store = sessionStore()
    expect(store.sessions).toHaveLength(1)
  })

  it('drops malformed sessions and prunes invalid messages during sanitize', () => {
    const good = createSession()
    localStorage.setItem(
      CHAT_SESSIONS_KEY,
      JSON.stringify({
        v: 1,
        activeId: good.id,
        sessions: [
          good,
          { id: 5, title: null, messages: [] },
          { id: 'bad-role', title: 'x', messages: [{ role: 'narrator', content: 'y' }] },
          { id: 'mixed', title: 'z', messages: [
            { role: 'user', content: 'keep', images: [{ id: 'i1', name: 'a.png', dataUrl: 'data:image/png;base64,xx' }, { id: 7 }] },
            { role: 'system', content: 'drop' },
          ] },
        ],
      }),
    )
    const store = sessionStore()
    expect(store.sessions.map((s) => s.id)).toEqual([good.id, 'bad-role', 'mixed'])
    const mixed = store.sessions.find((s) => s.id === 'mixed')!
    expect(mixed.messages).toEqual([
      { role: 'user', content: 'keep', images: [{ id: 'i1', name: 'a.png', dataUrl: 'data:image/png;base64,xx' }] },
    ])
    expect(store.activeId).toBe(good.id)
  })

  it('setMessages derives the title and persists', () => {
    const store = sessionStore()
    store.setMessages([{ role: 'user', content: '改写这段摘要' }])
    expect(store.sessions[0].title).toBe('改写这段摘要')
    expect(JSON.parse(localStorage.getItem(CHAT_SESSIONS_KEY)!).sessions[0].title).toBe('改写这段摘要')
  })

  it('keeps an interrupted answer through persist and reload', () => {
    const store = sessionStore()
    store.setMessages([
      { role: 'user', content: '问题' },
      { role: 'assistant', content: '答了一半', interrupted: true },
    ])
    expect(JSON.parse(localStorage.getItem(CHAT_SESSIONS_KEY)!).sessions[0].messages[1]).toEqual({
      role: 'assistant',
      content: '答了一半',
      interrupted: true,
    })

    setActivePinia(createPinia())
    const reloaded = sessionStore()
    expect(reloaded.sessions[0].messages[1].interrupted).toBe(true)
    // The marker belongs to one message only: the question is not interrupted.
    expect(reloaded.sessions[0].messages[0].interrupted).toBeUndefined()
  })

  it('only trusts an exact boolean interrupted flag from storage', () => {
    localStorage.setItem(
      CHAT_SESSIONS_KEY,
      JSON.stringify({
        v: 1,
        activeId: 'edited',
        sessions: [
          {
            id: 'edited',
            title: '手改过的存储',
            created: 1,
            updated: 2,
            messages: [
              { role: 'assistant', content: 'a', interrupted: 'yes' },
              { role: 'assistant', content: 'b', interrupted: true },
            ],
          },
        ],
      }),
    )
    const store = sessionStore()
    expect(store.sessions[0].messages[0].interrupted).toBeUndefined()
    expect(store.sessions[0].messages[1].interrupted).toBe(true)
  })

  it('loads sessions written before the interrupted marker existed', () => {
    localStorage.setItem(
      CHAT_SESSIONS_KEY,
      JSON.stringify({
        v: 1,
        activeId: 'legacy',
        sessions: [
          {
            id: 'legacy',
            title: '旧会话',
            created: 1,
            updated: 2,
            messages: [
              { role: 'user', content: '旧问题' },
              { role: 'assistant', content: '旧回答' },
            ],
          },
        ],
      }),
    )
    const store = sessionStore()
    expect(store.activeSession!.messages).toEqual([
      { role: 'user', content: '旧问题' },
      { role: 'assistant', content: '旧回答' },
    ])
  })

  it('clearMessages empties the session', () => {
    const store = sessionStore()
    store.appendMessage({ role: 'user', content: '内容' })
    store.clearMessages()
    expect(store.sessions[0].messages).toEqual([])
    expect(store.sessions[0].title).toBe('')
  })
})

describe('image storage caps', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('rejects a single image over the per-image cap and marks the message', () => {
    const session = createSession()
    session.messages = [
      { role: 'user', content: 'pic', images: [{ id: 'big', name: 'big.png', dataUrl: dataUrl(600) }] },
    ]
    applyImageCaps([session], { maxPerImage: 500, maxPerSession: 10000, maxTotal: 10000 })
    const msg = session.messages[0]
    expect(msg.images).toBeUndefined()
    expect(msg.imageNotice).toBe(IMAGE_TOO_LARGE)
  })

  it('appendMessage refuses a genuinely oversized image (real cap) and marks it', () => {
    const store = sessionStore()
    store.appendMessage({
      role: 'user',
      content: 'pic',
      images: [{ id: 'big', name: 'big.png', dataUrl: dataUrl(MAX_IMAGE_BASE64_LENGTH + 1) }],
    })
    const msg = store.sessions[0].messages[0]
    expect(msg.images).toBeUndefined()
    expect(msg.imageNotice).toBe(IMAGE_TOO_LARGE)
  })

  it('a session over its image budget evicts the oldest images first', () => {
    const session = createSession()
    session.messages = [
      { role: 'user', content: 'old', images: [{ id: 'o1', name: 'o.png', dataUrl: dataUrl(300) }] },
      { role: 'user', content: 'new', images: [{ id: 'n1', name: 'n.png', dataUrl: dataUrl(300) }] },
    ]
    applyImageCaps([session], { maxPerImage: 1000, maxPerSession: 500, maxTotal: 10000 })
    expect(session.messages[0].images).toBeUndefined()
    expect(session.messages[0].imageNotice).toBe(IMAGE_EVICTED_NOTICE)
    expect(session.messages[1].images).toHaveLength(1)
    expect(session.messages[1].images![0].id).toBe('n1')
  })

  it('the total cap evicts images from the least-recently-updated session first', () => {
    const old = createSession()
    old.updated = 100
    const fresh = createSession()
    fresh.updated = 200
    old.messages = [
      { role: 'user', content: 'a', images: [{ id: '1', name: 'a.png', dataUrl: dataUrl(300) }] },
    ]
    fresh.messages = [
      { role: 'user', content: 'b', images: [{ id: '2', name: 'b.png', dataUrl: dataUrl(300) }] },
    ]
    applyImageCaps([old, fresh], { maxPerImage: 1000, maxPerSession: 1000, maxTotal: 500 })
    expect(old.messages[0].images).toBeUndefined()
    expect(old.messages[0].imageNotice).toBe(IMAGE_EVICTED_NOTICE)
    expect(fresh.messages[0].images).toHaveLength(1)
    expect(fresh.messages[0].images![0].id).toBe('2')
  })

  it('handles a localStorage read failure without throwing', () => {
    const spy = vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('storage unavailable')
    })
    setActivePinia(createPinia())
    const store = sessionStore()
    expect(store.sessions).toHaveLength(1)
    spy.mockRestore()
  })

  it('handles a localStorage write failure without throwing', () => {
    const spy = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    setActivePinia(createPinia())
    const store = sessionStore()
    expect(store.sessions).toHaveLength(1)
    expect(() => store.persist()).not.toThrow()
    spy.mockRestore()
  })
})
