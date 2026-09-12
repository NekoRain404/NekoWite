import { describe, expect, it } from 'vitest'
import { buildChatPrompt, buildContextBlock, fileToDataURL, nextImageId, pickImageMime } from './chatLogic'

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

    it('truncates an oversized body at maxChars', () => {
      // The omission used to be invisible: the model saw the first 100
      // characters of a 300-character note and answered as if it had read the
      // whole thing, with nothing in the UI to suggest otherwise.
      const block = buildContextBlock({ noteTitle: 'T', noteContent: 'a'.repeat(300), maxChars: 100 })
      const parts = block.split('\n')
      expect(parts[1].endsWith('...')).toBe(true)
      expect(parts[1].length).toBe(100)
      expect(parts.slice(2).join('\n')).toContain('200')
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
