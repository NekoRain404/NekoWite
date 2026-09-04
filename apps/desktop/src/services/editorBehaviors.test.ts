import { describe, expect, it } from 'vitest'
import { countWords, isWordGoalMet, shouldCenterScroll, wordProgress } from './editorBehaviors'

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
})
