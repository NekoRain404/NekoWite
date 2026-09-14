import { describe, expect, it } from 'vitest'
import { MAX_IMAGES_PER_MESSAGE, MAX_IMAGE_BASE64_LENGTH, IMAGE_TOO_LARGE } from './chat-image-budget'
import { CHAT_SESSIONS_KEY, loadSessions, toStoredMessage } from './chat-session-storage'

/** A tiny helper to build image Data URLs of a controllable (base64) length. */
function dataUrl(length: number): string {
  return 'data:image/png;base64,' + 'a'.repeat(length)
}

function store(raw: unknown): void {
  localStorage.setItem(CHAT_SESSIONS_KEY, typeof raw === 'string' ? raw : JSON.stringify(raw))
}

describe('loadSessions', () => {
  it('seeds one empty active session when nothing is stored', () => {
    const { sessions, activeId } = loadSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].messages).toEqual([])
    expect(activeId).toBe(sessions[0].id)
  })

  it('re-asserts the image budget over data written before the caps existed', () => {
    // The memory-safety rule of the read path: a session written by an older
    // build (or by hand) can hold an image the current cap refuses, and it has
    // to be pruned on load rather than carried into memory and the next write.
    store({
      v: 1,
      activeId: 'legacy',
      sessions: [
        {
          id: 'legacy',
          title: '旧会话',
          created: 1,
          updated: 2,
          messages: [
            {
              role: 'user',
              content: 'pic',
              images: [{ id: 'big', name: 'big.png', dataUrl: dataUrl(MAX_IMAGE_BASE64_LENGTH + 1) }],
            },
          ],
        },
      ],
    })
    const { sessions, activeId } = loadSessions()
    expect(activeId).toBe('legacy')
    expect(sessions[0].messages[0].images).toBeUndefined()
    expect(sessions[0].messages[0].imageNotice).toBe(IMAGE_TOO_LARGE)
  })

  it('clamps a legacy message to the per-message image count', () => {
    const images = Array.from({ length: MAX_IMAGES_PER_MESSAGE + 1 }, (_, i) => ({
      id: `i${i}`,
      name: `${i}.png`,
      dataUrl: dataUrl(8),
    }))
    store({
      v: 1,
      activeId: 'many',
      sessions: [
        {
          id: 'many',
          title: 'x',
          created: 1,
          updated: 2,
          messages: [{ role: 'user', content: 'pics', images }],
        },
      ],
    })
    const { sessions } = loadSessions()
    expect(sessions[0].messages[0].images).toHaveLength(MAX_IMAGES_PER_MESSAGE)
  })

  it('drops an activeId that names no stored session', () => {
    store({
      v: 1,
      activeId: 'gone',
      sessions: [{ id: 'kept', title: 'x', created: 1, updated: 2, messages: [] }],
    })
    const { sessions, activeId } = loadSessions()
    expect(sessions.map((s) => s.id)).toEqual(['kept'])
    expect(activeId).toBeNull()
  })

  it('starts from a fresh session when the stored JSON is corrupt', () => {
    store('{not valid json')
    const { sessions, activeId } = loadSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].messages).toEqual([])
    expect(activeId).toBe(sessions[0].id)
  })
})

describe('toStoredMessage', () => {
  it('keeps every field that has to survive a relaunch', () => {
    const image = { id: 'i1', name: 'cat.png', dataUrl: dataUrl(8) }
    expect(
      toStoredMessage({
        role: 'assistant',
        content: 'half',
        images: [image],
        imageNotice: IMAGE_TOO_LARGE,
        interrupted: true,
        usageTotal: 12,
      }),
    ).toEqual({
      role: 'assistant',
      content: 'half',
      images: [image],
      imageNotice: IMAGE_TOO_LARGE,
      interrupted: true,
      usageTotal: 12,
    })
  })

  it('writes no keys for the fields that are unset', () => {
    // The panel's transient `streaming` flag and the optional markers must not
    // reach storage: what is written is also what the reader validates.
    expect(toStoredMessage({ role: 'user', content: 'hi' })).toEqual({ role: 'user', content: 'hi' })
  })
})
