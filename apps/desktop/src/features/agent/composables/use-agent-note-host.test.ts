/**
 * The editor pane's end of the edit-apply rule.
 *
 * `agent-edit-apply.ts` names its host as belonging to "whoever holds the editor pane and can mount
 * the conflict surface", and until now nobody did. These tests are about the three things that
 * implementation has to get right — the two readers it supplies from the editor, and the one
 * question it puts on screen — and about the one failure a host of this shape can have that no
 * screenshot would show: a question nobody can answer, leaving the apply suspended forever with the
 * user's paragraph in limbo.
 *
 * The service is not stubbed. Every case below runs the real `applyAgentEdit`, so what is pinned
 * here is the behaviour of the join, not the behaviour of a fake on either side of it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App as VueApp } from 'vue'
import { createPinia } from 'pinia'
import type { AgentIdentity } from '../../../platform/gateways/agent-contracts'
import type { AgentLiveNote, LiveNoteLookup } from '../services/agent-context-snapshot'
import { captureEditBaselines, type AgentEditProposal, type AgentEditWriteOutcome } from '../services/agent-edit-apply'
import { useAgentNoteHost, type AgentNoteHost } from './use-agent-note-host'

const IDENTITY: AgentIdentity = {
  agentId: 'opencode',
  profileId: 'default',
  runtimeEpoch: 'epoch-1',
  vaultId: '/vault',
  sessionId: 'session-1',
}

const PATH = '/vault/notes/a.md'
const AT_SEND = '# A\n\nas it was when the question went out'
const AGENT_TEXT = '# A\n\nthe version the agent produced'

function note(text = AT_SEND): AgentLiveNote {
  return {
    vaultId: '/vault',
    path: PATH,
    revision: 'page-1:tab-1:0',
    buffer: { state: 'clean', text },
  }
}

/** The editor, as the two things a host is allowed to know about it: a lookup and a write. */
interface Editor {
  held: LiveNoteLookup
  writes: { path: string; text: string }[]
  writeResult: AgentEditWriteOutcome
}

function editorHolding(lookup: LiveNoteLookup = { kind: 'held', note: note() }): Editor {
  return { held: lookup, writes: [], writeResult: { status: 'saved' } }
}

let mounted: VueApp[] = []

/** A component whose whole body is the composable, so the host's own lifecycle is the mounting
 *  component's — which is what the unmount case below is about. */
function mountHost(editor: Editor, identity: AgentIdentity | null = IDENTITY): AgentNoteHost {
  let api: AgentNoteHost | null = null
  const app = createApp(
    defineComponent({
      setup() {
        api = useAgentNoteHost({
          lookup: () => editor.held,
          identity: () => identity,
          write: async (path, text) => {
            editor.writes.push({ path, text })
            return editor.writeResult
          },
        })
        return () => h('div')
      },
    }),
  )
  const host = document.createElement('div')
  document.body.appendChild(host)
  // The composable reads the tab and session stores for its two defaults. Every case here injects
  // both, but the stores are still constructed — which is the point: an injected test must not be
  // able to pass by virtue of the real ones being absent.
  app.use(createPinia())
  app.mount(host)
  mounted.push(app)
  return api!
}

function proposalOf(text = AGENT_TEXT, baselineNote: AgentLiveNote = note()): AgentEditProposal {
  return {
    baseline: captureEditBaselines([baselineNote], IDENTITY).baselines[0]!,
    text,
  }
}

/** Let every microtask an apply might be waiting on run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('the question the host puts on screen', () => {
  it('publishes the conflict and answers the apply with the choice the user made', async () => {
    const editor = editorHolding({ kind: 'held', note: note('# A\n\nwhat I typed while it thought') })
    const host = mountHost(editor)

    const running = host.apply(proposalOf())
    await nextTick()

    // The note moved since the send, so the apply is a question — and the question is on screen
    // with both texts, before anything is written.
    expect(host.conflict.value).not.toBeNull()
    expect(host.conflict.value?.agentText).toBe(AGENT_TEXT)
    expect(host.conflict.value?.noteText).toBe('# A\n\nwhat I typed while it thought')
    expect(editor.writes).toEqual([])

    host.answer('apply')
    expect(await running).toEqual({
      status: 'applied',
      path: PATH,
      // The user's own typing, handed back: an "apply anyway" that dropped it would be the silent
      // overwrite one step later.
      displaced: { path: PATH, revision: 'page-1:tab-1:0', text: '# A\n\nwhat I typed while it thought' },
    })
    expect(editor.writes).toEqual([{ path: PATH, text: AGENT_TEXT }])
    // The question is gone as well as answered: a surface still asking about a decision that has
    // been taken would offer a second one.
    expect(host.conflict.value).toBeNull()
  })

  it('writes nothing when the user keeps their own version', async () => {
    const editor = editorHolding({ kind: 'held', note: note('# A\n\nwhat I typed while it thought') })
    const host = mountHost(editor)

    const running = host.apply(proposalOf())
    await nextTick()
    host.answer('discard')

    expect(await running).toEqual({ status: 'discarded', path: PATH })
    expect(editor.writes).toEqual([])
  })

  it('never answers itself: the apply waits until a person chooses', async () => {
    const editor = editorHolding({ kind: 'held', note: note('# A\n\nwhat I typed while it thought') })
    const host = mountHost(editor)

    let settled: string | null = null
    void host.apply(proposalOf()).then((outcome) => {
      settled = outcome.status
    })

    await settle()
    // No default, no timeout, no "assume the safe answer": a question answered on the user's
    // behalf is a decision they did not take, and the only reason this call can end by itself is
    // that the pane went away.
    expect(settled).toBeNull()
    expect(host.conflict.value).not.toBeNull()
  })

  it('settles a question the pane can no longer ask as a discard, so nothing hangs', async () => {
    const editor = editorHolding({ kind: 'held', note: note('# A\n\nwhat I typed while it thought') })
    const host = mountHost(editor)

    const running = host.apply(proposalOf())
    await nextTick()
    mounted.forEach((app) => app.unmount())
    mounted = []

    // The surface that owns the only control which could answer is gone. `discard` rather than a
    // hanging promise: nothing was written, which is the state the note is really in.
    expect(await running).toEqual({ status: 'discarded', path: PATH })
    expect(editor.writes).toEqual([])
  })
})

describe('the two readers the host supplies from the editor', () => {
  it('writes without asking when the note is where the request left it', async () => {
    const editor = editorHolding()
    const host = mountHost(editor)

    expect(await host.apply(proposalOf())).toEqual({ status: 'applied', path: PATH, displaced: null })
    expect(editor.writes).toEqual([{ path: PATH, text: AGENT_TEXT }])
  })

  it('refuses rather than writing into a note no tab holds', async () => {
    const editor = editorHolding({ kind: 'not-held' })
    const host = mountHost(editor)

    expect(await host.apply(proposalOf())).toEqual({
      status: 'refused',
      refusal: { reason: 'note-not-open', path: PATH },
    })
    expect(editor.writes).toEqual([])
  })

  it('refuses a proposal made under a session this window is no longer on', async () => {
    const editor = editorHolding()
    const host = mountHost(editor, { ...IDENTITY, runtimeEpoch: 'epoch-2' })

    expect(await host.apply(proposalOf())).toEqual({
      status: 'refused',
      refusal: { reason: 'identity-changed', field: 'runtimeEpoch' },
    })
    expect(editor.writes).toEqual([])
  })

  it('asks nobody when there is no session to apply under', async () => {
    const editor = editorHolding()
    const host = mountHost(editor, null)

    // No session means no identity to check the proposal against, and an apply that invented one
    // would be writing under a session that does not exist. `sessionId` is the field named because
    // it is the whole of what is missing: there is no session on screen for this proposal to be
    // applied under.
    expect(await host.apply(proposalOf())).toEqual({
      status: 'refused',
      refusal: { reason: 'identity-changed', field: 'sessionId' },
    })
    expect(editor.writes).toEqual([])
    expect(host.conflict.value).toBeNull()
  })
})
