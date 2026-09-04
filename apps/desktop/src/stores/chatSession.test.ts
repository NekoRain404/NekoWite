import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  CHAT_SESSIONS_KEY,
  createSession,
  titleFromText,
  useChatSessionStore,
} from './chatSession'

function sessionStore() {
  const s = useChatSessionStore()
  return s
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

  it('clearMessages empties the session', () => {
    const store = sessionStore()
    store.appendMessage({ role: 'user', content: '内容' })
    store.clearMessages()
    expect(store.sessions[0].messages).toEqual([])
    expect(store.sessions[0].title).toBe('')
  })
})