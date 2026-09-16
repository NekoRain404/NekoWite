/**
 * The conflict surface: two documents, one decision, and no way to make it by accident.
 *
 * What is held down here is what a passing screenshot would not tell you — that the two texts are
 * each labelled as their own, that the row says which versions are being compared, that both
 * answers reach the caller with the path they were about, and that a section with nothing to
 * decide does not exist. The texts themselves are asserted with their exact contents, because
 * the one thing this component must never do is render an abridged version of either side.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, reactive, type App as VueApp } from 'vue'
import AgentEditConflictView from './AgentEditConflictView.vue'
import type { AgentEditConflictLabels } from './AgentEditConflictView.vue'
import type { AgentEditConflict as Conflict } from '../services/agent-edit-apply'

const LABELS: AgentEditConflictLabels = {
  title: 'This note changed while the agent was working',
  moved: 'was edited after the request went out',
  agentText: 'What the agent produced',
  noteText: 'What the note holds now',
  apply: 'Use the agent’s version',
  discard: 'Keep my version',
  kept: 'Your text is kept when you apply, and handed to the caller.',
}

function conflict(overrides: Partial<Conflict> = {}): Conflict {
  return {
    status: 'conflict',
    path: 'notes/a.md',
    agentText: '# A\n\nrewritten by the agent',
    noteText: '# A\n\nwhat I typed while it thought',
    baselineRevision: 'r1',
    currentRevision: 'r7',
    ...overrides,
  }
}

type ConflictProps = {
  conflicts: readonly Conflict[]
  labels: AgentEditConflictLabels
  onApply?: (path: string) => void
  onDiscard?: (path: string) => void
}

interface Harness {
  host: HTMLElement
  props: ConflictProps
  applied: string[]
  discarded: string[]
  set: (patch: Partial<ConflictProps>) => Promise<void>
}

let mounted: VueApp[] = []

function mount(initial: Partial<ConflictProps> = {}): Harness {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const applied: string[] = []
  const discarded: string[] = []
  const props = reactive<ConflictProps>({
    conflicts: [conflict()],
    labels: LABELS,
    ...initial,
    onApply: (path: string) => applied.push(path),
    onDiscard: (path: string) => discarded.push(path),
  })
  const app = createApp(
    defineComponent({
      setup() {
        // Spread inside the render function: that read is what subscribes the render effect to
        // the reactive object, so `set` below re-renders the section.
        return () => h(AgentEditConflictView, { ...props })
      },
    }),
  )
  app.mount(host)
  mounted.push(app)
  return {
    host,
    props,
    applied,
    discarded,
    set: async (patch) => {
      Object.assign(props, patch)
      await nextTick()
    },
  }
}

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
  document.body.innerHTML = ''
})

const section = (host: HTMLElement): HTMLElement | null => host.querySelector('[data-agent-edit-conflict]')
const rows = (host: HTMLElement): HTMLElement[] =>
  Array.from(host.querySelectorAll<HTMLElement>('[data-agent-edit-conflict] li[data-path]'))
const textOf = (host: HTMLElement, path: string, role: string): string =>
  host.querySelector<HTMLElement>(`[data-path="${path}"] [data-role="${role}"]`)?.textContent ?? ''
const action = (host: HTMLElement, path: string, name: string): HTMLButtonElement =>
  host.querySelector<HTMLButtonElement>(`[data-path="${path}"] [data-action="${name}"]`)!
const click = (el: Element): void => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

describe('AgentEditConflictView — the two texts', () => {
  it('shows the agent’s version and the note’s, whole and each under its own label', () => {
    const { host } = mount()

    // Both are on screen in full: a reader deciding whether to overwrite their own paragraph
    // cannot be shown a summary of it.
    expect(textOf(host, 'notes/a.md', 'agent')).toBe('# A\n\nrewritten by the agent')
    expect(textOf(host, 'notes/a.md', 'note')).toBe('# A\n\nwhat I typed while it thought')

    // And each block names whose text it is, so the two cannot be read as one document.
    const captions = Array.from(host.querySelectorAll('.agent-conflict-caption')).map((el) =>
      el.textContent?.trim(),
    )
    expect(captions).toEqual([LABELS.agentText, LABELS.noteText])
  })

  it('names the versions the two texts belong to', () => {
    const { host } = mount()

    // The row carries the revision the request was made against and the one the note is at
    // now, so the caller can bind an answer to the conflict it was shown.
    const row = rows(host)[0]
    expect(row.getAttribute('data-baseline-revision')).toBe('r1')
    expect(row.getAttribute('data-current-revision')).toBe('r7')
    expect(row.querySelector('.agent-conflict-path')?.textContent).toBe('notes/a.md')
  })

  it('has no section at all when there is nothing to decide', async () => {
    const { host, set } = mount({ conflicts: [] })
    expect(section(host)).toBeNull()

    await set({ conflicts: [conflict()] })
    expect(section(host)).not.toBeNull()

    await set({ conflicts: [] })
    expect(section(host)).toBeNull()
  })
})

describe('AgentEditConflictView — the answers', () => {
  it('reports the user’s choice with the path it was made about, and writes nothing itself', () => {
    const { host, applied, discarded } = mount()

    click(action(host, 'notes/a.md', 'discard'))
    click(action(host, 'notes/a.md', 'apply'))

    expect(discarded).toEqual(['notes/a.md'])
    expect(applied).toEqual(['notes/a.md'])
    // Nothing on screen changed: this component does not know whether the write happened, and
    // a row that removed itself would be claiming it did.
    expect(rows(host)).toHaveLength(1)
  })

  it('keeps one row per note, so a second conflict is decided on its own', () => {
    const { host, applied } = mount({
      conflicts: [conflict(), conflict({ path: 'notes/b.md', agentText: 'B', noteText: 'b' })],
    })

    expect(rows(host).map((row) => row.getAttribute('data-path'))).toEqual(['notes/a.md', 'notes/b.md'])
    click(action(host, 'notes/b.md', 'apply'))
    expect(applied).toEqual(['notes/b.md'])
  })
})
