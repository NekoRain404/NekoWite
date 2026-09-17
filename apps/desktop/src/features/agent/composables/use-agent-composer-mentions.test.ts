/**
 * The `@` menu: what opens it, what it lists, and what a key does.
 *
 * The trigger is the half of this that is easy to get wrong and the half worth the most tests: a
 * mention is a word the reader is *inside* a sentence, so `@` in an address, a finished word and a
 * second at-sign all have to leave the menu shut — and a menu that opened on any of them would be
 * putting a file list over a message for a keystroke that did not ask for one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref, type EffectScope } from 'vue'
import { mentionQuery, textWithoutMention, useAgentComposerMentions } from './use-agent-composer-mentions'

const getMock = vi.hoisted(() => vi.fn())

vi.mock('../../../services/vault-files', () => ({
  vaultFileIndex: { get: getMock },
}))

const VAULT = '/home/user/vault'

/** The composable reads the vault through the app's own index; the tests below drive it with a
 *  scope so a watcher left running by one case cannot reach into the next. */
function mount(text: string, select = vi.fn()): {
  api: ReturnType<typeof useAgentComposerMentions>
  text: ReturnType<typeof ref<string>>
  select: ReturnType<typeof vi.fn>
  scope: EffectScope
} {
  const held = ref(text)
  const scope = effectScope()
  const api = scope.run(() =>
    useAgentComposerMentions({ vault: () => VAULT, text: () => held.value, select }),
  )!
  return { api, text: held, select, scope }
}

/** The paths the index answers with, spelled the way the backend spells them: absolute. */
function notes(...paths: string[]): void {
  getMock.mockResolvedValue(paths.map((path) => `${VAULT}/${path}`))
}

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await nextTick()
}

beforeEach(() => {
  getMock.mockReset()
  // A default of one note, so a case that is not about the empty state has something to list.
  notes('a.md')
})

describe('the unfinished word', () => {
  it('is what follows the at-sign, and nothing else opens the menu', () => {
    expect(mentionQuery('@')).toBe('')
    expect(mentionQuery('compare @a')).toBe('a')
    expect(mentionQuery('compare @notes/a.md')).toBe('notes/a.md')
    // Finished: a space after the word is the reader having moved on.
    expect(mentionQuery('@a.md ')).toBeNull()
    // Not a word of its own: an address, a decorator, a tag.
    expect(mentionQuery('mail me at a@b')).toBeNull()
    // Two at-signs in one word is somebody typing at-signs, not naming a path.
    expect(mentionQuery('@@a')).toBeNull()
    expect(mentionQuery('no at-sign here')).toBeNull()
  })

  it('takes the word — and its separator — out of the message when it settles', () => {
    // The file is a chip now, so the half-written name goes. The space before it went with it: it
    // was the word's own separator, and leaving it would put a stray space where a name used to be.
    expect(textWithoutMention('compare @wel')).toBe('compare')
    expect(textWithoutMention('@wel')).toBe('')
    // A word that never opened the menu is not one this may take out of the message: a finished
    // word, and an at-sign that is not starting one, both come back unchanged.
    expect(textWithoutMention('@wel ')).toBe('@wel ')
    expect(textWithoutMention('compare@wel')).toBe('compare@wel')
  })
})

describe('the list', () => {
  it('is closed until a word starts, and opens on the word', async () => {
    const { api, text } = mount('')
    expect(api.view.value).toBe('closed')

    text.value = '@'
    await settle()
    expect(api.view.value).toBe('rows')
    // The index is walked once the menu is actually opened, not on mount: a reader who never types
    // an at-sign never pays for the walk.
    expect(getMock).toHaveBeenCalledWith(VAULT)
  })

  it('lists the workspace’s notes, vault-relative, and filters them', async () => {
    notes('notes/a.md', 'notes/b.md', 'welcome.md')
    const { api, text } = mount('@')
    await settle()
    expect(api.matches.value).toEqual(['notes/a.md', 'notes/b.md', 'welcome.md'])

    text.value = '@b'
    await settle()
    expect(api.matches.value).toEqual(['notes/b.md'])
  })

  it('drops a path the workspace does not contain rather than naming it', async () => {
    // A row that named a file outside the vault would put an absolute path from elsewhere into the
    // message, which is the one thing a reference may never do.
    getMock.mockResolvedValue([`${VAULT}/a.md`, '/somewhere/else/b.md', VAULT])
    const { api } = mount('@')
    await settle()
    expect(api.matches.value).toEqual(['a.md'])
  })

  it('says which nothing it is showing', async () => {
    // Four states, four sentences: a word that matches none, a workspace with no notes, a list
    // still being read, and an index that could not be walked. A menu that drew them alike would
    // be asserting the wrong one.
    notes('a.md')
    const { api } = mount('@zzz')
    await settle()
    expect(api.view.value).toBe('no-match')

    notes()
    const empty = mount('@')
    await settle()
    expect(empty.api.view.value).toBe('empty')

    getMock.mockRejectedValue(new Error('unreadable'))
    const broken = mount('@')
    await settle()
    expect(broken.api.view.value).toBe('unreadable')
  })
})

describe('the keys', () => {
  function key(name: string): KeyboardEvent {
    return new KeyboardEvent('keydown', { key: name, cancelable: true })
  }

  it('passes everything through while it is closed', () => {
    const { api } = mount('nothing here')
    expect(api.onKeydown(key('ArrowDown'))).toBe('pass')
    expect(api.onKeydown(key('Enter'))).toBe('pass')
  })

  it('walks the rows and settles on one', async () => {
    notes('a.md', 'b.md')
    const { api, select } = mount('@')
    await settle()
    expect(api.activePath.value).toBe('a.md')

    api.onKeydown(key('ArrowDown'))
    expect(api.activePath.value).toBe('b.md')
    // Wraps, as the app's other menus do.
    api.onKeydown(key('ArrowDown'))
    expect(api.activePath.value).toBe('a.md')

    expect(api.onKeydown(key('Enter'))).toBe('handled')
    expect(select).toHaveBeenCalledWith('a.md')
  })

  it('hands Enter back when there is nothing to settle on', async () => {
    // An empty or failed list, or a word no note matches. Enter is then the composer's, and the
    // message goes to the engine as written rather than being swallowed by a menu with no answer.
    notes()
    const { api } = mount('@zzz')
    await settle()
    expect(api.onKeydown(key('Enter'))).toBe('pass')
  })

  it('closes on Escape without touching the message', async () => {
    const { api, text } = mount('@')
    await settle()
    expect(api.view.value).toBe('rows')

    expect(api.onKeydown(key('Escape'))).toBe('handled')
    expect(api.view.value).toBe('closed')
    // The half-typed word stays: Escape puts the menu away, it does not delete what was written.
    expect(text.value).toBe('@')

    // And typing again brings it back, because that is a new word.
    text.value = '@a'
    await settle()
    expect(api.view.value).toBe('rows')
  })
})
