import { describe, expect, it } from 'vitest'
import { countWords, isWordGoalMet, shouldCenterScroll, taskProgress, wordProgress } from './editorBehaviors'

describe('editorBehaviors', () => {
  describe('countWords', () => {
    it('counts CJK characters as individual words', () => {
      expect(countWords('你好世界')).toBe(4)
      expect(countWords('我看了一个电影。')).toBe(8)
    })

    it('counts whitespace-separated latin runs as words', () => {
      expect(countWords('hello world')).toBe(2)
      expect(countWords('one two three')).toBe(3)
    })

    it('mixes CJK and latin correctly', () => {
      expect(countWords('你好 hello 世界')).toBe(5)
      expect(countWords('今天 is a good 天')).toBe(6)
    })

    it('handles empty and punctuation-only text', () => {
      expect(countWords('')).toBe(0)
      expect(countWords('   ')).toBe(0)
      expect(countWords('!!!')).toBe(1)
    })

    it('collapses multiple spaces and ignores stray punctuation runs', () => {
      expect(countWords('a  b   c')).toBe(3)
      expect(countWords('a... b')).toBe(2)
    })
  })

  describe('wordProgress', () => {
    it('is 0 when the goal is off or non-positive', () => {
      expect(wordProgress(10, 0)).toBe(0)
      expect(wordProgress(10, -5)).toBe(0)
    })

    it('returns the clamped ratio between 0 and 1', () => {
      expect(wordProgress(0, 100)).toBe(0)
      expect(wordProgress(50, 100)).toBe(0.5)
      expect(wordProgress(100, 100)).toBe(1)
      expect(wordProgress(200, 100)).toBe(1)
    })

    it('handles non-finite inputs', () => {
      expect(wordProgress(Number.NaN, 100)).toBe(0)
      expect(wordProgress(Infinity, 100)).toBe(1)
      expect(wordProgress(50, Number.NaN)).toBe(0)
    })
  })

  describe('isWordGoalMet', () => {
    it('is false for a disabled goal', () => {
      expect(isWordGoalMet(10, 0)).toBe(false)
    })
    it('is true at or above the goal', () => {
      expect(isWordGoalMet(10, 10)).toBe(true)
      expect(isWordGoalMet(15, 10)).toBe(true)
    })
    it('is false below the goal', () => {
      expect(isWordGoalMet(9, 10)).toBe(false)
    })
  })

  describe('shouldCenterScroll', () => {
    it('recenters when the cursor leaves the middle band', () => {
      expect(shouldCenterScroll(5, 400)).toBe(true)
      expect(shouldCenterScroll(395, 400)).toBe(true)
    })

    it('leaves the scroll alone inside the middle band', () => {
      expect(shouldCenterScroll(100, 400)).toBe(false)
      expect(shouldCenterScroll(300, 400)).toBe(false)
      expect(shouldCenterScroll(200, 400)).toBe(false)
    })

    it('never scrolls for degenerate viewports', () => {
      expect(shouldCenterScroll(100, 0)).toBe(false)
      expect(shouldCenterScroll(NaN, 400)).toBe(false)
      expect(shouldCenterScroll(100, -4)).toBe(false)
    })
  })

  describe('taskProgress', () => {
    it('returns zero for content with no tasks', () => {
      expect(taskProgress('')).toEqual({ done: 0, total: 0 })
      expect(taskProgress('plain text\nwithout tasks')).toEqual({ done: 0, total: 0 })
    })

    it('counts unchecked and checked boxes across the bullet styles', () => {
      const md = '- [ ] todo\n- [x] done\n* [X] done2\n+ [ ] todo2\n'
      expect(taskProgress(md)).toEqual({ done: 2, total: 4 })
    })

    it('supports indented nested task items', () => {
      const md = '- [x] parent\n  - [ ] child\n  - [x] done\n'
      expect(taskProgress(md)).toEqual({ done: 2, total: 3 })
    })

    it('treats the whole active heading as one checkbox when present', () => {
      // A stray `## [x]` heading is NOT a task — only list markers count.
      const md = '## [x] Heading\n- [x] real\n'
      expect(taskProgress(md)).toEqual({ done: 1, total: 1 })
    })

    it('skips task-looking lines inside fenced code blocks', () => {
      const md = '```md\n- [ ] from code\n- [x] also code\n```\n- [ ] real\n'
      expect(taskProgress(md)).toEqual({ done: 0, total: 1 })
    })

    it('handles tilde fences and re-enters counting after closing', () => {
      const md = '~~~\n- [ ] code\n~~~\n- [x] after\n'
      expect(taskProgress(md)).toEqual({ done: 1, total: 1 })
    })

    it('requires a checkbox marker right after the bullet', () => {
      // `- [ ]note` (no space) is not a task; `- [ ]` alone is.
      const md = '- [ ]note\n- [ ] task\n'
      expect(taskProgress(md)).toEqual({ done: 0, total: 1 })
    })
  })
})
