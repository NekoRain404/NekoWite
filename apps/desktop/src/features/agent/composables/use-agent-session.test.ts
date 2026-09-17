/**
 * The notes a request is about when the caller names none.
 *
 * `stores/agent-session.ts`'s `send` captures a version of each note a request names, and
 * `agent-edit-apply.ts` refuses to write without one — so a send that named nothing would leave
 * every later apply refusing, and the protection this feature exists for would be a mechanism
 * nothing could reach. Nothing in the app supplied the targets, which is why the default lives
 * here: the document at risk is the one the editor has in front, and that is the one a reader
 * means when they ask the agent to do something to "this note".
 *
 * The function is tested rather than the composable because the composable's other half needs a
 * live session and a gateway; what is load-bearing here is which note is chosen, and that is a
 * question a lookup can answer on its own.
 */
import { describe, expect, it } from 'vitest'
import type { AgentLiveNote, LiveNoteLookup } from '../services/agent-context-snapshot'
import { openNoteTargets } from './use-agent-session'

const PATH = '/vault/notes/a.md'

function note(overrides: Partial<AgentLiveNote> = {}): AgentLiveNote {
  return {
    vaultId: '/vault',
    path: PATH,
    revision: 'page-1:tab-1:0',
    buffer: { state: 'clean', text: '# A' },
    ...overrides,
  }
}

/** The editor, as this function is allowed to know it: one tab in front, and one lookup. */
function editor(active: string | null, lookup: (path: string) => LiveNoteLookup) {
  return { activeTab: active === null ? null : { path: active }, lookUpLiveNote: lookup }
}

describe('the note a request that names none is about', () => {
  it('is the note the editor has in front', () => {
    const held = note()
    expect(openNoteTargets(editor(PATH, () => ({ kind: 'held', note: held })))).toEqual([held])
  })

  it('is nothing when no note is open', () => {
    expect(openNoteTargets(editor(null, () => ({ kind: 'not-held' })))).toEqual([])
  })

  it('is nothing for a tab that cannot say what it holds yet', () => {
    // `cannot-answer` is a note still on its first read, and its tab wears the note's path while
    // holding a placeholder. Capturing a version of the placeholder would be a baseline for a
    // document the user is not looking at.
    expect(
      openNoteTargets(editor(PATH, () => ({ kind: 'cannot-answer', reason: 'still reading' }))),
    ).toEqual([])
  })

  it('is nothing for a path no tab holds', () => {
    expect(openNoteTargets(editor(PATH, () => ({ kind: 'not-held' })))).toEqual([])
  })

  it('asks the lookup by the path the active tab names, never for "whatever is open"', () => {
    const asked: string[] = []
    openNoteTargets(
      editor(PATH, (path) => {
        asked.push(path)
        return { kind: 'not-held' }
      }),
    )

    expect(asked).toEqual([PATH])
  })
})
