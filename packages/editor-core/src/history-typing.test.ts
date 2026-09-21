import { describe, expect, it } from 'vitest'
import { undo, undoDepth } from '@milkdown/prose/history'

import { createEditor } from './editor'

/**
 * How far one Ctrl+Z reaches: a burst of typing is ONE step, and two bursts
 * apart in time are two.
 *
 * The original test plan asked for 「单撤销」 and nothing asserted it — the
 * per-gesture undo cases live in `table/ops.test.ts`, `image/attrs.test.ts` and
 * the keymaps, and each of those is a single discrete transaction. The question
 * these cases answer is the one a writer actually asks: after typing a word, does
 * undo take back the word or the last letter?
 *
 * It is the history plugin's grouping that decides, and the grouping is a
 * property of *time*, not of this repository's code: adjacent typing joins the
 * open group, and a new group starts after the plugin's `newGroupDelay`. So the
 * second case has to let real time pass — a fake clock would not change the
 * plugin's own reading of it — and the delay below is deliberately longer than
 * the 500 ms default rather than exactly it, so a machine under load does not
 * turn a passing case into a flake.
 */
describe('undo granularity: a burst is one step', () => {
  const open = async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el)
    await editor.open('# Note\n\n')
    return { el, editor, view: editor.getView() }
  }

  it('ten keystrokes come back in one undo, and leave nothing on the stack', async () => {
    const { el, editor, view } = await open()
    try {
      const opened = await editor.save()
      for (const character of 'abcdefghij') {
        view.dispatch(view.state.tr.insertText(character))
      }
      expect(await editor.save()).not.toBe(opened)
      // One group, so one entry: this is the assertion that says "the word, not
      // the letter". Without grouping it would read ten.
      expect(undoDepth(view.state)).toBe(1)

      const apply = (tr: Parameters<typeof view.dispatch>[0]) => view.dispatch(tr)
      expect(undo(view.state, apply)).toBe(true)
      expect(await editor.save()).toBe(opened)
      expect(undoDepth(view.state)).toBe(0)
    } finally {
      editor.destroy()
      el.remove()
    }
  })

  it('typing separated by more than the grouping delay is two steps', async () => {
    const { el, editor, view } = await open()
    try {
      const opened = await editor.save()
      view.dispatch(view.state.tr.insertText('first'))
      const afterFirst = await editor.save()

      // Longer than the history plugin's 500 ms `newGroupDelay` on purpose.
      await new Promise((resolve) => setTimeout(resolve, 700))

      view.dispatch(view.state.tr.insertText('second'))
      expect(await editor.save()).not.toBe(afterFirst)
      expect(undoDepth(view.state)).toBe(2)

      const apply = (tr: Parameters<typeof view.dispatch>[0]) => view.dispatch(tr)
      expect(undo(view.state, apply)).toBe(true)
      // The second burst only: the first is still on the stack, which is what
      // makes the boundary observable rather than assumed.
      expect(await editor.save()).toBe(afterFirst)
      expect(undoDepth(view.state)).toBe(1)
      expect(undo(view.state, apply)).toBe(true)
      expect(await editor.save()).toBe(opened)
    } finally {
      editor.destroy()
      el.remove()
    }
  })

  it('a multi-line insertion is one step, however much text it carries', async () => {
    const { el, editor, view } = await open()
    try {
      const opened = await editor.save()
      view.dispatch(view.state.tr.insertText('one\ntwo\nthree\nfour\n'))
      expect(undoDepth(view.state)).toBe(1)

      const apply = (tr: Parameters<typeof view.dispatch>[0]) => view.dispatch(tr)
      expect(undo(view.state, apply)).toBe(true)
      expect(await editor.save()).toBe(opened)
    } finally {
      editor.destroy()
      el.remove()
    }
  })
})
