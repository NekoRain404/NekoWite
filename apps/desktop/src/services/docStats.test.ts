import { describe, expect, it } from 'vitest'
import { computeDocStats } from './docStats'

describe('computeDocStats', () => {
  it('returns all-zero stats for empty content', () => {
    expect(computeDocStats('')).toEqual({
      words: 0,
      chars: 0,
      paragraphs: 0,
      images: 0,
      citations: 0,
      tasks: 0,
      taskDone: 0,
      taskTotal: 0,
      readMinutes: 0,
    })
  })

  it('counts CJK + latin words, characters and paragraphs', () => {
    const text = 'Hello world 你好 世界\n\nSecond paragraph'
    const s = computeDocStats(text)
    expect(s.words).toBe(8)
    expect(s.chars).toBe(text.length)
    expect(s.paragraphs).toBe(2)
  })

  it('splits paragraphs on blank lines (including multiple blanks)', () => {
    expect(computeDocStats('a\n\nb\n\n\nc').paragraphs).toBe(3)
  })

  it('counts images, citations and task list items', () => {
    const s = computeDocStats('![a](x.png)\n\nSee [@key].\n\n- [ ] todo\n- [x] done\n')
    expect(s.images).toBe(1)
    expect(s.citations).toBe(1)
    expect(s.tasks).toBe(2)
    expect(s.taskTotal).toBe(2)
    expect(s.taskDone).toBe(1)
  })

  it('ignores images, citations and tasks inside fenced code blocks', () => {
    const s = computeDocStats(
      '```\n![a](x.png)\n[@key]\n- [x] done\n```\n\n![b](y.png)\n\n- [ ] real\n',
    )
    expect(s.images).toBe(1)
    expect(s.citations).toBe(0)
    expect(s.tasks).toBe(1)
    expect(s.taskTotal).toBe(1)
    expect(s.taskDone).toBe(0)
  })

  it('computes readMinutes as ceiling of words / 300', () => {
    expect(computeDocStats('word '.repeat(600)).readMinutes).toBe(2)
    expect(computeDocStats('word').readMinutes).toBe(1)
    expect(computeDocStats('').readMinutes).toBe(0)
  })
})
