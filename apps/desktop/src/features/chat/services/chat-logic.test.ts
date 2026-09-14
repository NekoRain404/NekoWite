import { describe, expect, it } from 'vitest'
import {
  buildChatPrompt,
  buildContextBlock,
  contextOmission,
  fileToDataURL,
  nextImageId,
  pickImageMime,
} from './chat-logic'

describe('chatLogic', () => {
  it('jsons the current user turn as the last line', () => {
    const prompt = buildChatPrompt([
      { role: 'user', content: '前文' },
      { role: 'assistant', content: '回复' },
      { role: 'user', content: '继续' },
    ])
    expect(prompt.endsWith('用户：继续')).toBe(true)
    expect(prompt).toContain('助手：回复')
    expect(prompt).toContain('用户：前文')
  })

  it('keeps order of recent turns (backwards walk)', () => {
    const prompt = buildChatPrompt([
      { role: 'user', content: '一' },
      { role: 'assistant', content: '二' },
      { role: 'user', content: '三' },
    ])
    const lines = prompt.split('\n\n')
    expect(lines[0]).toBe('用户：一')
    expect(lines[1]).toBe('助手：二')
    expect(lines[2]).toBe('用户：三')
  })

  it('caps the transcript at maxChars, dropping older turns', () => {
    const prompt = buildChatPrompt(
      [
        { role: 'user', content: 'a'.repeat(50) },
        { role: 'user', content: 'b'.repeat(50) },
        { role: 'user', content: 'c'.repeat(50) },
      ],
      150,
    )
    expect(prompt).toContain('用户：ccc')
    expect(prompt).not.toContain('aaa')
  })

  /** Turns that survived the cap, counted by their labels. */
  const turnsKept = (prompt: string): number => (prompt.match(/用户：|助手：/g) ?? []).length

  const history = (turns: number, perTurn: number) =>
    Array.from({ length: turns }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: '字'.repeat(perTurn),
    }))

  it('carries a whole conversation of short turns', () => {
    // The cap is 6 000 characters; 200 turns of 20 characters are well inside
    // it, so the older half of a long chat is not lost the way the character
    // count alone suggests (see the table on TRANSCRIPT_CHARS).
    expect(turnsKept(buildChatPrompt(history(200, 20)))).toBe(200)
  })

  it('carries one turn once a turn is thousands of characters', () => {
    // 3 000-character turns (a long answer at a high max-output setting) fill
    // the budget by themselves: the model sees its own last reply and nothing
    // before it.
    const prompt = buildChatPrompt(history(10, 3000))
    expect(turnsKept(prompt)).toBe(1)
    expect(prompt.endsWith('字'.repeat(3000))).toBe(true)
  })

  it('trims trailing whitespace of each turn', () => {
    const prompt = buildChatPrompt([{ role: 'user', content: '  你好  \n' }])
    expect(prompt).toBe('用户：  你好')
  })

  it('resolves mime from the declared type', () => {
    expect(pickImageMime({ type: 'image/webp', name: 'x.png' })).toBe('image/webp')
  })

  it('falls back to the extension mime when type is empty', () => {
    expect(pickImageMime({ type: '', name: 'photo.JPG' })).toBe('image/jpeg')
  })

  it('defaults to png when neither type nor extension resolves', () => {
    expect(pickImageMime({ type: '', name: 'blob' })).toBe('image/png')
  })

  it('converts a blob to a data URL with its mime', async () => {
    const blob = new File(['abc'], 'a.png', { type: 'image/png' })
    const url = await fileToDataURL(blob)
    expect(url).toMatch(/^data:image\/png;base64,YWJj$/)
  })

  it('produces unique attachment ids', () => {
    expect(nextImageId()).not.toBe(nextImageId())
  })

  describe('buildContextBlock', () => {
    it('reports what the budget left out, by the same rule that cut it', () => {
      // The count the user is told has to describe the block that was actually
      // sent, so it comes from the same body-selection rule — a note keeps both
      // ends, a selection keeps its head, and the two must not disagree about
      // how much went.
      const note = 'x'.repeat(500)
      expect(contextOmission({ noteContent: note, maxChars: 100 })).toBe(400)
      expect(contextOmission({ noteContent: note, maxChars: 500 })).toBe(0)
      expect(contextOmission({ noteContent: note, maxChars: 5000 })).toBe(0)
      // A selection wins over the body, exactly as it does in the block.
      expect(
        contextOmission({ noteContent: note, selection: 'ab', maxChars: 1 }),
      ).toBe(1)
      // And nothing to send is nothing left out.
      expect(contextOmission({ noteContent: '   ', maxChars: 1 })).toBe(0)
      expect(contextOmission({})).toBe(0)
    })

    it('emits a titled header with the note body', () => {
      const block = buildContextBlock({ noteTitle: '图论', noteContent: '# 图论\n\n内容' })
      expect(block).toBe('【当前文档：图论】\n# 图论\n\n内容')
    })

    it('prefers an active selection over the body', () => {
      const block = buildContextBlock({
        noteTitle: '图论',
        noteContent: '# 图论\n\n长正文',
        selection: '选中的句子',
      })
      expect(block).toBe('【当前文档：图论】\n【选中文本】\n选中的句子')
      expect(block).not.toContain('长正文')
    })

    it('keeps the opening AND the ending of an oversized body', () => {
      // The omission used to be invisible: the model saw the first 100
      // characters of a 300-character note and answered as if it had read the
      // whole thing, with nothing in the UI to suggest otherwise. Only-the-head
      // was wrong for a second reason: the person writing the END of a long
      // note - the usual case, you ask about what you are writing - was the one
      // whose text never reached the model.
      const head = 'H'.repeat(150)
      const middle = 'M'.repeat(150)
      const tail = 'T'.repeat(150)
      const block = buildContextBlock({ noteTitle: 'T', noteContent: head + middle + tail, maxChars: 100 })
      const parts = block.split('\n')
      // Header, the note's opening, the omission notice, then its ending.
      expect(parts[0]).toContain('T')
      expect(parts[1]).toBe('H'.repeat(50))
      expect(parts[2]).toContain('350')
      expect(parts[3]).toBe('T'.repeat(50))
      // The middle is what was sacrificed, and the budget is respected.
      expect(block).not.toContain('M')
      expect(parts[1].length + parts[3].length).toBe(100)
    })

    it('truncates a long SELECTION from its start, not from both ends', () => {
      // A selection is what the user pointed at, so its beginning is the point;
      // splitting it would drop the part they chose to show.
      const block = buildContextBlock({
        noteTitle: 'T',
        selection: 'S'.repeat(300),
        noteContent: 'B'.repeat(300),
        maxChars: 100,
      })
      const parts = block.split('\n')
      expect(parts[0]).toContain('T')
      expect(parts[2].endsWith('...')).toBe(true)
      expect(parts[2].length).toBe(100)
      expect(parts.slice(3).join('\n')).toContain('200')
    })

    it('returns empty strings when nothing usable is present', () => {
      expect(buildContextBlock({})).toBe('')
      expect(buildContextBlock({ noteContent: '   ' })).toBe('')
    })

    it('omits the header when title is missing', () => {
      expect(buildContextBlock({ noteContent: '正文' })).toBe('正文')
    })
  })

  describe('buildChatPrompt with context', () => {
    it('prepends a context block before the transcript', () => {
      const prompt = buildChatPrompt([{ role: 'user', content: '继续' }], {
        context: '【当前文档：图论】\n正文',
      })
      expect(prompt.startsWith('以下是当前文档的上下文，供你参考：\n【当前文档：图论】\n正文\n\n---\n\n用户：继续')).toBe(true)
    })

    it('falls back to the legacy numeric signature naturally', () => {
      const prompt = buildChatPrompt([{ role: 'user', content: '继续' }], 6000)
      expect(prompt).toBe('用户：继续')
    })

    it('omits the context preamble when context is empty', () => {
      const prompt = buildChatPrompt([{ role: 'user', content: '继续' }], { context: '' })
      expect(prompt).toBe('用户：继续')
    })
  })
})
