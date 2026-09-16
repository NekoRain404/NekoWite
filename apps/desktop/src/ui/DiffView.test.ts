import { afterEach, describe, expect, it } from 'vitest'
import { createApp, type App as VueApp } from 'vue'
import DiffView from './DiffView.vue'
import { diffStats, lineDiff, DIFF_MAX_LINES } from '../services/diff'
import { t } from '../i18n'

const mounted: VueApp[] = []

function mountDiff(props: { current: string; history: string; historyTime?: string }): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(DiffView, props)
  app.mount(host)
  mounted.push(app)
  return host
}

/** A note of `count` lines, with the final line replaced by `last` when given. */
function note(count: number, last?: string): string {
  const lines = Array.from({ length: count }, (_, i) => `line-${i}`)
  if (last !== undefined) lines[count - 1] = last
  return lines.join('\n')
}

describe('DiffView', () => {
  it('emits restore', () => {
    const host = mountDiff({ current: 'a', history: 'b' })
    let restored = false
    host.querySelector<HTMLButtonElement>('.btn-diff-restore')?.addEventListener('click', () => {
      restored = true
    })
    host.querySelector<HTMLButtonElement>('.btn-diff-restore')?.click()
    expect(restored).toBe(true)
  })

  it('emits close', () => {
    const host = mountDiff({ current: 'a', history: 'b' })
    let closed = false
    host.querySelector<HTMLButtonElement>('.diff-close')?.addEventListener('click', () => {
      closed = true
    })
    host.querySelector<HTMLButtonElement>('.diff-close')?.click()
    expect(closed).toBe(true)
  })
})

// The identity claim is about the whole note. `lineDiff` caps its rows at
// DIFF_MAX_LINES, so on a longer note the rows can be empty while the documents
// differ — and "no differences" plus a disabled Restore is then said about data
// that has changed. The panel must not read identity off the rows.
describe('DiffView identity on notes longer than the row cap', () => {
  afterEach(() => {
    mounted.forEach((app) => app.unmount())
    mounted.length = 0
    document.body.innerHTML = ''
  })

  it('does not call two versions identical when they differ only past the cap', () => {
    const current = note(DIFF_MAX_LINES + 1, 'the old closing line')
    const history = note(DIFF_MAX_LINES + 1, 'the new closing line')

    // The pre-fix input to `identical`: the rows stop at the cap, so the pair
    // below produced added === 0 && removed === 0, and `identical` was derived
    // from exactly that.
    expect(diffStats(lineDiff(current, history))).toEqual({
      added: 0,
      removed: 0,
      unchanged: DIFF_MAX_LINES,
    })

    const host = mountDiff({ current, history })
    // Quoted this way on purpose: the failure prints the sentence the panel used
    // to show here — "This version matches the current content, no differences"
    // — about a version that differs from the current one.
    expect(host.querySelector('.diff-identical')?.textContent).toBeUndefined()
    expect(host.querySelector<HTMLButtonElement>('.btn-diff-restore')?.disabled).toBe(false)
    expect(host.querySelector('.diff-partial')?.textContent).toContain(String(DIFF_MAX_LINES))
  })

  it('says the comparison was partial when a longer note differs inside the cap', () => {
    const shared = Array.from({ length: DIFF_MAX_LINES + 500 }, (_, i) => `line-${i}`)
    const current = shared.join('\n')
    const history = [...shared.slice(0, 4), 'changed', ...shared.slice(5)].join('\n')

    const host = mountDiff({ current, history })
    expect(host.querySelector('.diff-identical')).toBeNull()
    expect(host.querySelector<HTMLButtonElement>('.btn-diff-restore')?.disabled).toBe(false)
    // The rows stay the bounded ones, and the panel says they are a prefix.
    expect(host.querySelectorAll('.diff-line').length).toBeGreaterThan(0)
    const hint = host.querySelector('.diff-partial')
    expect(hint).not.toBeNull()
    expect(hint?.textContent).toContain(String(DIFF_MAX_LINES))
  })

  it('still calls a genuinely identical pair identical', () => {
    const text = note(30)
    const host = mountDiff({ current: text, history: text })
    expect(host.querySelector('.diff-identical')?.textContent).toContain(t('diff.identical'))
    expect(host.querySelector<HTMLButtonElement>('.btn-diff-restore')?.disabled).toBe(true)
    expect(host.querySelector('.diff-partial')).toBeNull()
  })

  it('calls an identical pair past the cap identical without a partial hint', () => {
    // Identity was decided over the whole text, so this answer is not partial:
    // a truncated row set that came out empty is not a hedge on it.
    const text = note(DIFF_MAX_LINES + 1)
    const host = mountDiff({ current: text, history: text })
    expect(host.querySelector('.diff-identical')).not.toBeNull()
    expect(host.querySelector<HTMLButtonElement>('.btn-diff-restore')?.disabled).toBe(true)
    expect(host.querySelector('.diff-partial')).toBeNull()
  })

  it('sees a difference on the last line the cap covers', () => {
    // The case that works today, so the fix cannot be "compare less".
    const host = mountDiff({
      current: note(DIFF_MAX_LINES, 'the old closing line'),
      history: note(DIFF_MAX_LINES, 'the new closing line'),
    })
    expect(host.querySelector('.diff-identical')).toBeNull()
    expect(host.querySelector<HTMLButtonElement>('.btn-diff-restore')?.disabled).toBe(false)
    expect(host.querySelector('.diff-partial')).toBeNull()
  })

  it('renders an ordinary short pair as it did before', () => {
    const host = mountDiff({ current: 'a\nb\nc', history: 'a\nB\nc' })
    expect(host.querySelector('.diff-identical')).toBeNull()
    expect(host.querySelectorAll('.diff-line')).toHaveLength(4)
    expect(host.querySelector('.diff-partial')).toBeNull()
  })
})