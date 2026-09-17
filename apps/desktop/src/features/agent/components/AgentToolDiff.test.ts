/**
 * What a proposed edit draws, and — the half that matters more — what it refuses to draw.
 *
 * The three refusals are the tests, because each one is a way this surface could lie about what
 * the engine proposed:
 *
 *  - a call that reported no `diff` block gets no diff view at all, rather than an empty frame
 *    that reads as "nothing to see" about a call that proposed nothing;
 *  - a block whose two texts are the same is drawn as a sentence, not as an empty row set;
 *  - a block whose original text the engine did not state is drawn with that said out loud,
 *    because the schema's gloss ("a new file") is not the same statement as the absence the wire
 *    actually carries.
 *
 * The mount is a real one (`createApp` over the component) and the assertions are over the
 * rendered DOM, so what is checked is what a reader would get.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import AgentToolDiff from './AgentToolDiff.vue'
import type { AgentToolContent } from '../../../platform/gateways/agent-contracts'
import { getLocale, setLocale, t } from '../../../i18n'

let mounted: VueApp[] = []

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
  document.body.innerHTML = ''
})

function mount(content: readonly AgentToolContent[]): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(AgentToolDiff, { content })
  mounted.push(app)
  app.mount(host)
  return host
}

const EDIT: AgentToolContent = {
  type: 'diff',
  path: 'notes/a.md',
  oldText: 'one\ntwo\nthree\n',
  newText: 'one\nTWO\nthree\n',
}

describe('the diff a call proposed', () => {
  it('draws nothing at all when the call reported no diff block', () => {
    // FAILS IF: an empty frame is drawn for every tool call — the `read`, the shell command, the
    // search. §5.3's "draw what the session reports" cuts both ways, and a diff card with nothing
    // in it is a statement about the engine that the engine did not make.
    expect(mount([]).querySelector('[data-agent-diff]')).toBeNull()
    expect(mount([{ type: 'unrecognised' }]).querySelector('.agent-diff-block')).toBeNull()
  })

  it('draws the changed line, both sides of it, and the path the engine named', () => {
    const host = mount([EDIT])
    const block = host.querySelector('.agent-diff-block')
    expect(block).not.toBeNull()
    expect(block?.getAttribute('data-path')).toBe('notes/a.md')
    expect(block?.getAttribute('data-identical')).toBe('false')

    const rows = [...host.querySelectorAll('.agent-diff-line')]
    expect(rows.map((row) => row.getAttribute('data-type'))).toEqual(['same', 'del', 'add', 'same'])
    const text = rows.map((row) => row.querySelector('.agent-diff-text')?.textContent?.trim())
    expect(text).toEqual(['one', 'two', 'TWO', 'three'])
    // The stat is this app's arithmetic over the block's own two texts, and it is on the block's
    // header where the reader sees it before opening anything.
    expect(host.querySelector('.agent-diff-added')?.textContent?.trim()).toBe('+1')
    expect(host.querySelector('.agent-diff-removed')?.textContent?.trim()).toBe('−1')
  })

  it('says the two sides are the same rather than showing no rows', () => {
    // FAILS IF: an identical pair renders as an empty list. The engine measured in this tree
    // sends exactly that shape — `agent_permission_ipc_test.rs`'s fixture frame is `HELLO` to
    // `HELLO` — and "this proposal changes nothing in this file" is a fact the reader has to be
    // told, in words, in a surface they are deciding on.
    const host = mount([{ type: 'diff', path: 'a.md', oldText: 'HELLO', newText: 'HELLO' }])
    expect(host.querySelector('[data-agent-diff-identical]')).not.toBeNull()
    expect(host.querySelector('.agent-diff-rows')).toBeNull()
    // And no `+0 −0` beside it: a count of nothing is not a fact, and over this pair it would be
    // a second, quieter way of saying what the sentence already says.
    expect(host.querySelector('.agent-diff-stat')).toBeNull()
  })

  it('names an absent original text as an absence rather than claiming a new file', () => {
    // The schema glosses `oldText: None` as "a new file", and the same field deserializes
    // default-on-error — so an original this host could not read arrives identically. The
    // sentence therefore says what was received. FAILS IF: the render fills the gap with a
    // conclusion the wire does not support.
    const host = mount([{ type: 'diff', path: 'a.md', oldText: null, newText: 'one\ntwo\n' }])
    const note = host.querySelector('[data-agent-diff-no-original]')
    expect(note).not.toBeNull()
    expect(note?.textContent).toBe(t('agent.panel.timeline.tool.diff.noOriginal'))
    expect(host.querySelectorAll('.agent-diff-line[data-type="add"]').length).toBe(2)

    // The words themselves, in the one locale where the distinction can be read off the text:
    // the sentence names the absence and the schema's gloss ("a new file") is nowhere in it.
    const previous = getLocale()
    setLocale('en')
    try {
      const english = mount([
        { type: 'diff', path: 'a.md', oldText: null, newText: 'one\ntwo\n' },
      ]).querySelector('[data-agent-diff-no-original]')
      expect(english?.textContent).toContain('no original text')
      expect(english?.textContent).not.toContain('new file')
    } finally {
      setLocale(previous)
    }
  })

  it('folds a long unchanged run, counts it on the fold’s face, and shows the lines when opened', async () => {
    const head = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`)
    const host = mount([
      {
        type: 'diff',
        path: 'a.md',
        oldText: [...head, 'old'].join('\n'),
        newText: [...head, 'new'].join('\n'),
      },
    ])
    const fold = host.querySelector<HTMLButtonElement>('.agent-diff-fold')
    expect(fold).not.toBeNull()
    // The count is on the control, not implied by it: a reader is never asked to take "some
    // lines" on trust. 30 unchanged lines, less the two kept each side of the change.
    expect(fold?.textContent).toContain('26')
    // Two kept either side of the fold, plus the removed and the added line.
    expect(host.querySelectorAll('.agent-diff-line').length).toBe(6)

    fold?.click()
    await nextTick()
    expect(host.querySelector('.agent-diff-fold')).toBeNull()
    // The fold said 26 and stood in for 26: opening it drops the one row and adds exactly that
    // many lines.
    expect(host.querySelectorAll('.agent-diff-line').length).toBe(6 + 26)
  })

  it('shows no stat over a change the row cap put out of reach, and says so instead', () => {
    // The shape of a change late in a long file. The rows hold no changed line — they cannot, the
    // comparison stopped before it — so the block must not read `+0 −0`, which is what a reader
    // would take as "this call changes nothing" while the engine is asking to change the file.
    const head = Array.from({ length: 2_100 }, (_, i) => `line ${i + 1}`)
    const host = mount([
      {
        type: 'diff',
        path: 'a.md',
        oldText: head.join('\n'),
        newText: [...head.slice(0, 2_050), 'changed', ...head.slice(2_051)].join('\n'),
      },
    ])
    expect(host.querySelector('.agent-diff-stat')).toBeNull()
    const note = host.querySelector('[data-agent-diff-beyond]')
    expect(note).not.toBeNull()
    expect(note?.textContent).toBe(t('agent.panel.timeline.tool.diff.beyond', { n: 2000 }))
    expect(host.querySelector('[data-agent-diff-partial]')).toBeNull()
  })

  it('says when a block arrived that this version does not draw', () => {
    // The wire's other two arms. A call whose only content was one of those must not look exactly
    // like a call that produced nothing — this is the one line that keeps the two apart.
    const host = mount([{ type: 'unrecognised' }])
    expect(host.querySelector('[data-agent-diff-undrawn]')).not.toBeNull()
    const both = mount([{ type: 'unrecognised' }, EDIT])
    expect(both.querySelector('[data-agent-diff-undrawn]')).not.toBeNull()
    expect(both.querySelector('.agent-diff-block')).not.toBeNull()
  })

  it('draws a block with no path without inventing one', () => {
    // The engine measured here builds `path` as `z(filePath) ?? ""`, so a blank is a value it
    // states. A heading this app wrote for it would be naming the file the engine did not.
    const host = mount([{ type: 'diff', path: '', oldText: 'a', newText: 'b' }])
    expect(host.querySelector('.agent-diff-block')).not.toBeNull()
    expect(host.querySelector('.agent-diff-path')).toBeNull()
    expect(host.querySelector('.agent-diff-icon')).not.toBeNull()
  })
})
