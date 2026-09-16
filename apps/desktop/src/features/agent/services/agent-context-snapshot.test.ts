/**
 * The context snapshot's tests.
 *
 * The case that matters drives the failure this module exists for: the user sends, then switches tab
 * and vault while the prompt is in flight, and the run still has to read the note they attached. It
 * is written with its own negative control — the same dispatcher, handed a getter over the editor
 * instead of the committed value, returns the note the user switched *to* — because a freeze
 * assertion on a harness that cannot change would pass whatever the module did. The control is what
 * shows the assertion has teeth, and it is also the plainest statement of what this module would
 * have done before the fix.
 *
 * The rest are §7.1's clauses that are not about time: a dirty buffer labelled as one rather than
 * passed off as the file, an attachment withdrawn before send, and an attachment the model cannot
 * take refused where the user offered it and again at the freeze point — never dropped quietly,
 * which would leave the list on screen claiming the model saw something it never got.
 */

import { describe, expect, it } from 'vitest'
import type { AgentIdentity } from '../../../platform/gateways/agent-contracts'
import {
  attachFile,
  attachNote,
  attachSelection,
  commitContext,
  createContextDraft,
  withdrawItem,
  type AgentContextDraft,
  type AgentContextEdit,
  type AgentContextItem,
  type AgentContextSnapshot,
  type AgentLiveAttachment,
  type AgentLiveNote,
  type AgentModelCapabilities,
} from './agent-context-snapshot'

const VAULT_A = '/home/user/vault-a'
const VAULT_B = '/home/user/vault-b'

function identity(vaultId: string): AgentIdentity {
  return {
    agentId: 'opencode',
    profileId: 'default',
    runtimeEpoch: 'epoch-1',
    vaultId,
    sessionId: 'session-1',
  }
}

/** A model that takes pictures and text, and one that takes neither: the two ends of the capability
 *  list a commit has to judge an attachment against. */
const TAKES_IMAGES: AgentModelCapabilities = { acceptedAttachmentKinds: ['image', 'text'] }
const TAKES_NOTHING: AgentModelCapabilities = { acceptedAttachmentKinds: [] }

/** The committed snapshot, or a failure carrying the refusal's reason: every test below is about the
 *  committed case, and a refusal there should fail with what was refused rather than with a
 *  TypeError from reading `.snapshot` off the other arm. */
function commitOrThrow(draft: AgentContextDraft, capabilities: AgentModelCapabilities): AgentContextSnapshot {
  const result = commitContext(draft, capabilities)
  if (result.status !== 'committed') throw new Error(`commit refused: ${result.refusal.reason} (${result.itemId})`)
  return result.snapshot
}

/** The draft after an attach that was expected to be applied. */
function applyOrThrow(edit: AgentContextEdit): AgentContextDraft {
  if (edit.status !== 'applied') throw new Error(`attach refused: ${edit.refusal.reason}`)
  return edit.draft
}

interface LiveNoteFields {
  vaultId: string
  path: string
  revision: string
  text: string
}

function liveNote(fields: LiveNoteFields): AgentLiveNote {
  return {
    vaultId: fields.vaultId,
    path: fields.path,
    revision: fields.revision,
    buffer: { state: 'clean', text: fields.text },
  }
}

/**
 * A stand-in for the live editor a capture reads from: what is open right now, a way to switch to
 * another note, and a count of how many times anything asked it. The count is what makes "taken at
 * send time" falsifiable — a snapshot that re-read the editor has to touch this, and the assertion
 * after the smoke clears is that nothing did.
 */
function liveEditor(first: LiveNoteFields) {
  let current = first
  let reads = 0
  return {
    /** The live note as a capture reads it. Counted: this is the read the freeze has to prevent. */
    note(): AgentLiveNote {
      reads += 1
      return liveNote(current)
    },
    /**
     * The same state without counting, for the negative control below: that control has to read the
     * editor too — a getter is the whole point of it — and if it went through `note()` the count
     * would be measuring the control instead of the snapshot it is there to contrast with.
     */
    peek(): AgentLiveNote {
      return liveNote(current)
    },
    switchTo(next: LiveNoteFields): void {
      current = next
    },
    reads(): number {
      return reads
    },
  }
}

/** What a real dispatch does: await the runtime, and only then read the context it was handed. A
 *  context that resolved "the current note" would resolve it *here*, after the switch. */
async function dispatchAfterSwitch(
  context: Pick<AgentContextSnapshot, 'items'>,
): Promise<readonly AgentContextItem[]> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  return context.items
}

/** Every value reachable from a snapshot, to show that none of them is code: a getter or a method
 *  hiding anywhere in it would be something that could still resolve after the commit. */
function containsFunction(value: unknown): boolean {
  if (typeof value === 'function') return true
  if (Array.isArray(value)) return value.some((entry) => containsFunction(entry))
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return Object.keys(record).some((key) => containsFunction(record[key]))
}

describe('committing a context', () => {
  it('does not move a committed snapshot when the tab and vault switch while the prompt is in flight', async () => {
    const editor = liveEditor({ vaultId: VAULT_A, path: 'a/one.md', revision: 'r1', text: 'one' })
    // The object the capture is handed is kept, because an editor does not only hand out different
    // values when the user switches — it edits the very object it handed over, and a snapshot that
    // held a reference to that object would move with it.
    const offered = editor.note()
    const draft = applyOrThrow(attachNote(createContextDraft(identity(VAULT_A)), offered, 'buffer'))
    const snapshot = commitOrThrow(draft, TAKES_IMAGES)
    const readsAtSend = editor.reads()

    // Two dispatches of the same shape leave at once. One carries the committed value; the other is
    // the shape this module refuses to be — the same fields, read from the editor at the moment the
    // prompt is assembled. Then the user moves: another tab, then another vault.
    const mine = dispatchAfterSwitch(snapshot)
    const leaky = dispatchAfterSwitch({
      get items(): readonly AgentContextItem[] {
        const now = editor.peek()
        return [
          {
            kind: 'note',
            id: `note:${now.path}`,
            vaultId: now.vaultId,
            path: now.path,
            revision: now.revision,
            dirty: false,
            content: { source: 'buffer', text: now.buffer.text },
          },
        ]
      },
    })
    editor.switchTo({ vaultId: VAULT_A, path: 'a/two.md', revision: 'r2', text: 'two' })
    editor.switchTo({ vaultId: VAULT_B, path: 'b/three.md', revision: 'r3', text: 'three' })
    // And the object it handed over at capture time is edited in place, the way a store edits its own.
    offered.path = 'b/three.md'
    offered.revision = 'r3'
    offered.buffer.text = 'three'

    expect((await mine)[0]).toMatchObject({
      path: 'a/one.md',
      revision: 'r1',
      content: { source: 'buffer', text: 'one' },
    })
    // The control: same dispatcher, same switch, and this is the note the user never attached.
    expect((await leaky)[0]).toMatchObject({ path: 'b/three.md', content: { text: 'three' } })
    // Nothing reached back into the editor to build what was sent.
    expect(editor.reads()).toBe(readsAtSend)
  })

  it('commits plain frozen data: no function and no live object anywhere in it', () => {
    const editor = liveEditor({ vaultId: VAULT_A, path: 'a/one.md', revision: 'r1', text: 'one' })
    const draft = applyOrThrow(attachNote(createContextDraft(identity(VAULT_A)), editor.note(), 'buffer'))
    const draftWithFile = applyOrThrow(
      attachFile(draft, { path: 'a/img.png', name: 'img.png', mediaType: 'image/png', sizeBytes: 2048 }, TAKES_IMAGES),
    )
    const snapshot = commitOrThrow(draftWithFile, TAKES_IMAGES)

    expect(Object.keys(snapshot)).toEqual(['identity', 'items'])
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot)
    expect(containsFunction(snapshot)).toBe(false)
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.items)).toBe(true)
    expect(Object.isFrozen(snapshot.items[0])).toBe(true)
  })

  it('sends only the fields it knows, so a draft that arrived with extra baggage loses it', () => {
    // A draft that was stored and read back — or built by a later version of this type — is still a
    // draft, and the freeze point has to be safe against one. The stray field and the getter stand
    // for whatever such a value might carry.
    const stored = {
      identity: identity(VAULT_A),
      items: [
        {
          kind: 'note',
          id: 'note:a/one.md',
          vaultId: VAULT_A,
          path: 'a/one.md',
          revision: 'r1',
          dirty: false,
          content: { source: 'buffer', text: 'one' },
          unseen: 'a key file nobody attached',
          get leaked(): string {
            return 'still live'
          },
        },
      ],
    } as unknown as AgentContextDraft

    const snapshot = commitOrThrow(stored, TAKES_IMAGES)

    expect(Object.keys(snapshot.items[0])).toEqual([
      'kind',
      'id',
      'vaultId',
      'path',
      'revision',
      'dirty',
      'content',
    ])
    expect(containsFunction(snapshot)).toBe(false)
  })

  it('names every item by where it came from, and starts a draft with nothing in it', () => {
    const draft = createContextDraft(identity(VAULT_A))
    expect(draft.items).toEqual([])

    const withNote = applyOrThrow(
      attachNote(
        draft,
        { vaultId: VAULT_A, path: 'a/one.md', revision: 'r1', buffer: { state: 'clean', text: 'one' } },
        'buffer',
      ),
    )
    const withSelection = applyOrThrow(
      attachSelection(withNote, {
        vaultId: VAULT_A,
        path: 'a/one.md',
        revision: 'r1',
        from: 4,
        to: 9,
        text: 'words',
        dirty: false,
      }),
    )
    const withFile = applyOrThrow(
      attachFile(
        withSelection,
        { path: 'a/diagram.svg', name: 'diagram.svg', mediaType: 'image/svg+xml', sizeBytes: 512 },
        TAKES_IMAGES,
      ),
    )
    const snapshot = commitOrThrow(withFile, TAKES_IMAGES)

    expect(snapshot.items.map((item) => item.id)).toEqual([
      'note:a/one.md',
      'selection:a/one.md',
      'attachment:a/diagram.svg',
    ])
    expect(snapshot.items[1]).toMatchObject({ kind: 'selection', from: 4, to: 9, revision: 'r1' })
    expect(snapshot.items[2]).toMatchObject({ kind: 'attachment', mediaType: 'image/svg+xml', attachmentKind: 'image' })
  })

  it('replaces the row when the same note is captured again, rather than sending two revisions', () => {
    const editor = liveEditor({ vaultId: VAULT_A, path: 'a/one.md', revision: 'r1', text: 'one' })
    const first = applyOrThrow(attachNote(createContextDraft(identity(VAULT_A)), editor.note(), 'buffer'))
    editor.switchTo({ vaultId: VAULT_A, path: 'a/one.md', revision: 'r2', text: 'one, edited' })

    const second = applyOrThrow(attachNote(first, editor.note(), 'buffer'))

    expect(second.items).toHaveLength(1)
    expect(second.items[0]).toMatchObject({ revision: 'r2', content: { text: 'one, edited' } })
  })
})

describe('a dirty buffer is a labelled snapshot, not the file', () => {
  const dirtyNote: AgentLiveNote = {
    vaultId: VAULT_A,
    path: 'a/one.md',
    revision: 'r1',
    buffer: { state: 'dirty', text: 'unsaved words', diskText: 'saved words' },
  }

  it('says which text was attached, and that the other one differed', () => {
    const asBuffer = applyOrThrow(attachNote(createContextDraft(identity(VAULT_A)), dirtyNote, 'buffer'))
    expect(asBuffer.items[0]).toMatchObject({ dirty: true, content: { source: 'buffer', text: 'unsaved words' } })

    // The same dirty note attached as the file: the choice is the user's, and the item still says the
    // buffer held edits, because that is the fact a later disk edit has to be weighed against.
    const asDisk = applyOrThrow(attachNote(createContextDraft(identity(VAULT_A)), dirtyNote, 'disk'))
    expect(asDisk.items[0]).toMatchObject({ dirty: true, content: { source: 'disk', text: 'saved words' } })
  })

  it('refuses to label the buffer as the file when nobody read the file', () => {
    const unread: AgentLiveNote = {
      vaultId: VAULT_A,
      path: 'a/one.md',
      revision: 'r1',
      buffer: { state: 'dirty', text: 'unsaved words', diskText: null },
    }
    const refused = attachNote(createContextDraft(identity(VAULT_A)), unread, 'disk')

    expect(refused).toEqual({ status: 'refused', refusal: { reason: 'disk-text-unavailable', path: 'a/one.md' } })
    expect(applyOrThrow(attachNote(createContextDraft(identity(VAULT_A)), unread, 'buffer')).items).toHaveLength(1)
  })

  it('takes the buffer as the file when the buffer is clean, and says so', () => {
    const clean: AgentLiveNote = {
      vaultId: VAULT_A,
      path: 'a/one.md',
      revision: 'r1',
      buffer: { state: 'clean', text: 'one' },
    }
    const applied = applyOrThrow(attachNote(createContextDraft(identity(VAULT_A)), clean, 'disk'))

    expect(applied.items[0]).toMatchObject({ dirty: false, content: { source: 'disk', text: 'one' } })
  })
})

describe('the context list', () => {
  const image: AgentLiveAttachment = {
    path: 'a/img.png',
    name: 'img.png',
    mediaType: 'image/png',
    sizeBytes: 2048,
  }

  function draftWithNoteAndImage(): AgentContextDraft {
    const withNote = applyOrThrow(
      attachNote(
        createContextDraft(identity(VAULT_A)),
        { vaultId: VAULT_A, path: 'a/one.md', revision: 'r1', buffer: { state: 'clean', text: 'one' } },
        'buffer',
      ),
    )
    return applyOrThrow(attachFile(withNote, image, TAKES_IMAGES))
  }

  it('withdraws an item from what will be sent, and never from what was already sent', () => {
    const draft = draftWithNoteAndImage()
    const inFlight = commitOrThrow(draft, TAKES_IMAGES)

    const withdrawn = withdrawItem(draft, 'attachment:a/img.png')
    expect(withdrawn.items.map((item) => item.kind)).toEqual(['note'])
    // The next commit carries what the list shows now...
    expect(commitOrThrow(withdrawn, TAKES_IMAGES).items.map((item) => item.kind)).toEqual(['note'])
    // ...and the run already in flight still carries what the user sent.
    expect(inFlight.items.map((item) => item.kind)).toEqual(['note', 'attachment'])
    expect(withdrawItem(withdrawn, 'attachment:a/img.png')).toBe(withdrawn)
  })

  it('refuses a file the model cannot take, and leaves it out of the list rather than in it', () => {
    const draft = createContextDraft(identity(VAULT_A))
    const refused = attachFile(draft, { ...image, path: 'a/doc.pdf', mediaType: 'application/pdf' }, TAKES_IMAGES)

    expect(refused).toEqual({
      status: 'refused',
      refusal: {
        reason: 'unsupported-attachment',
        path: 'a/doc.pdf',
        mediaType: 'application/pdf',
        attachmentKind: 'pdf',
      },
    })
    expect(draft.items).toEqual([])
  })

  it('matches a capability on the normalized media type, which is the one the item then states', () => {
    const draft = createContextDraft(identity(VAULT_A))
    const applied = applyOrThrow(
      attachFile(
        draft,
        { path: 'a/notes.txt', name: 'notes.txt', mediaType: 'Text/Plain; charset=utf-8', sizeBytes: 10 },
        TAKES_IMAGES,
      ),
    )

    expect(applied.items[0]).toMatchObject({ mediaType: 'text/plain', attachmentKind: 'text' })
  })

  it('refuses at the freeze point a file the model stopped taking while the user was composing', () => {
    const draft = draftWithNoteAndImage()

    const result = commitContext(draft, TAKES_NOTHING)

    expect(result).toMatchObject({
      status: 'refused',
      itemId: 'attachment:a/img.png',
      refusal: { reason: 'unsupported-attachment', attachmentKind: 'image' },
    })
  })

  it('carries a selection with its range, and refuses one that carries nothing', () => {
    const draft = createContextDraft(identity(VAULT_A))
    const applied = applyOrThrow(
      attachSelection(draft, {
        vaultId: VAULT_A,
        path: 'a/one.md',
        revision: 'r1',
        from: 4,
        to: 9,
        text: 'words',
        dirty: true,
      }),
    )
    const refused = attachSelection(draft, {
      vaultId: VAULT_A,
      path: 'a/one.md',
      revision: 'r1',
      from: 3,
      to: 3,
      text: '',
      dirty: false,
    })

    expect(applied.items[0]).toMatchObject({ from: 4, to: 9, text: 'words', dirty: true })
    expect(refused).toEqual({ status: 'refused', refusal: { reason: 'empty-selection', path: 'a/one.md' } })
  })

  it('refuses a note from another vault, at the offer and again for a draft that arrived holding one', () => {
    const otherVault: AgentLiveNote = {
      vaultId: VAULT_B,
      path: 'b/three.md',
      revision: 'r3',
      buffer: { state: 'clean', text: 'three' },
    }
    const offered = attachNote(createContextDraft(identity(VAULT_A)), otherVault, 'buffer')

    expect(offered).toEqual({
      status: 'refused',
      refusal: { reason: 'vault-mismatch', path: 'b/three.md', itemVaultId: VAULT_B, contextVaultId: VAULT_A },
    })

    const stored = {
      identity: identity(VAULT_A),
      items: [
        {
          kind: 'note',
          id: 'note:b/three.md',
          vaultId: VAULT_B,
          path: 'b/three.md',
          revision: 'r3',
          dirty: false,
          content: { source: 'buffer', text: 'three' },
        },
      ],
    } as unknown as AgentContextDraft

    expect(commitContext(stored, TAKES_IMAGES)).toMatchObject({
      status: 'refused',
      itemId: 'note:b/three.md',
      refusal: { reason: 'vault-mismatch' },
    })
  })
})
