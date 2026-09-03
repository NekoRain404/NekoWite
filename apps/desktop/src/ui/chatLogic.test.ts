import { describe, expect, it } from 'vitest'
import { buildChatPrompt, fileToDataURL, nextImageId, pickImageMime } from './chatLogic'

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
})
