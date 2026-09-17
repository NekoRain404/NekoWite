/**
 * The `@` menu: what the composer is naming, which of the workspace's notes that keeps, and what a
 * key means while it is open.
 *
 * A sibling of `use-agent-commands.ts` rather than a branch of it, and the difference between the
 * two is the whole of why: the `/` list is the *engine's*, arriving as a frame and replaced whole
 * by the next one, while this list is the *workspace's* — it is the app's own file index, it
 * belongs to the vault rather than to a session, and no engine has an opinion about it. One
 * composable holding both would have to answer "whose list is this" at every line.
 *
 * **The trigger is a word, not a prefix.** `/` is a command only when it starts the whole message
 * (`use-agent-commands.ts` states why), but a mention is something a reader writes *inside* a
 * sentence — "compare @a.md with @b.md" — so what opens this menu is the unfinished word at the
 * end of the text, and only that one. Anything after a space, or a second `@` in the same word,
 * closes it.
 *
 * **What is listed is what the vault index holds**: the notes, not every file. The index is the
 * app's own answer to "what is in this vault" (it is what the file tree and the note list are built
 * from), and a second walk here would be a second answer to the same question — with its own idea
 * of which directories to skip. A file the index does not carry is still reachable by pressing the
 * `+`, which lists directories one at a time.
 */

import { computed, ref, watch } from 'vue'
import { isComposingKey } from '../../../services/key-guard'
import { stripVaultPrefix } from '../../../services/paths'
import { vaultFileIndex } from '../../../services/vault-files'
import { isPathWithinVault } from '../../attachments'

/** How many rows the menu will draw. The list is filtered by what the reader is typing, so this is
 *  a bound on the *unfiltered* case — an empty `@` at the start of a message in a large vault. A
 *  menu is not a file browser: past this many rows the reader should be typing, and the sentence
 *  under the list says so rather than the list silently ending. */
export const MENTION_LIMIT = 50

/**
 * What the menu draws — one value, because "shows no rows" has four different reasons and a menu
 * that drew them alike would be asserting the wrong one.
 */
export type AgentMentionView =
  | 'closed'
  | 'reading'
  | 'rows'
  | 'no-match'
  | 'empty'
  /** The vault could not be walked. Said rather than left as an empty list, which is what a
   *  failure and a vault with no notes in it would otherwise both look like. */
  | 'unreadable'

/** What a keydown meant here; the three arms are `use-agent-commands.ts`'s, for its reasons. */
export type AgentMentionKeyResult = 'pass' | 'composing' | 'handled'

/**
 * The unfinished `@word` at the end of a message, or null when there is not one.
 *
 * Pure, and exported, because two callers need the same answer: the menu, and the component that
 * has to take the word back out of the message when a row is settled on. A second copy of the rule
 * is how the word that opened the menu and the word that is removed come to disagree.
 *
 * The two refusals are what make this a *mention* menu rather than a character search: a word that
 * has been finished (`@a.md ` — a space after it) is the reader having moved on, and a `@` that
 * does not start a word (an e-mail address, a decorator) is not a mention at all.
 */
export function mentionQuery(text: string): string | null {
  const at = text.lastIndexOf('@')
  if (at === -1) return null
  if (at > 0 && !/\s/.test(text[at - 1]!)) return null
  const tail = text.slice(at + 1)
  // Whitespace ends the word; a second `@` means the reader is typing at-signs, not a path.
  if (/[\s@]/.test(tail)) return null
  return tail
}

/**
 * The message with the unfinished `@word` taken out of the end of it.
 *
 * What a settled mention leaves behind: the word was the reader naming a file, and the file is now
 * a chip rather than text — so the half-typed name goes. Everything before the `@` is copied across
 * untouched, and the separator space before it goes too: it was the word's own, and leaving it
 * would put a stray space where a name used to be.
 */
export function textWithoutMention(text: string): string {
  if (mentionQuery(text) === null) return text
  const at = text.lastIndexOf('@')
  const before = text.slice(0, at)
  return /\s$/.test(before) ? before.slice(0, -1) : before
}

export interface UseAgentComposerMentionsOptions {
  /** The workspace whose notes are listed, or null before a session is on screen. */
  vault: () => string | null
  /** The composer's text, exactly as the reader has it. */
  text: () => string
  /** The unfinished `@word` was settled on: this vault-relative path is what the reader named. */
  select: (path: string) => void
}

export function useAgentComposerMentions(options: UseAgentComposerMentionsOptions) {
  const notes = ref<readonly string[] | null>(null)
  const failed = ref(false)
  const activeIndex = ref(0)
  /** Set by Escape, cleared by the next keystroke: the menu is closed until the reader types
   *  again, rather than reopening on the same word the moment anything re-renders. */
  const dismiss = ref(false)

  const query = computed<string | null>(() => mentionQuery(options.text()))

  /** The notes this message may name, vault-relative and in the index's own order. */
  const candidates = computed<readonly string[]>(() => {
    const vault = options.vault()
    const listed = notes.value
    if (vault === null || listed === null) return []
    const relative: string[] = []
    for (const path of listed) {
      // The index holds the entries as the backend spells them — absolute, under the vault root.
      // A path outside it is dropped rather than shown: a row that named a file the engine cannot
      // resolve is a row that would put an absolute path from elsewhere into the message.
      if (!isPathWithinVault(path, vault)) continue
      const stripped = stripVaultPrefix(path, vault)
      if (stripped === '') continue
      relative.push(stripped)
    }
    return relative
  })

  const matches = computed<readonly string[]>(() => {
    const typed = query.value
    if (typed === null) return []
    const needle = typed.toLowerCase()
    // Filtered, not scored: the index's order is the workspace's own (a stable sort of the vault's
    // paths), and re-ranking by where the match sits would be this menu expressing a preference
    // nobody asked it for.
    return candidates.value
      .filter((path) => path.toLowerCase().includes(needle))
      .slice(0, MENTION_LIMIT)
  })

  const view = computed<AgentMentionView>(() => {
    if (query.value === null) return 'closed'
    if (failed.value) return 'unreadable'
    if (notes.value === null) return 'reading'
    if (candidates.value.length === 0) return 'empty'
    return matches.value.length > 0 ? 'rows' : 'no-match'
  })

  const activePath = computed<string | null>(() => matches.value[activeIndex.value] ?? null)

  function move(delta: number): void {
    const count = matches.value.length
    if (count === 0) return
    activeIndex.value = (activeIndex.value + delta + count) % count
  }

  function setActive(index: number): void {
    activeIndex.value = index
  }

  // The highlight follows the list it points into, for the reason `use-agent-commands.ts` gives:
  // a keystroke that drops rows would otherwise leave it on a row that is gone.
  watch([query, matches], () => {
    activeIndex.value = 0
  })

  /**
   * Read the vault's notes, once per vault.
   *
   * Kicked off by the menu opening rather than on mount: a reader who never types `@` never pays
   * for the walk, and the index caches the answer for the ones who do.
   */
  async function load(vault: string): Promise<void> {
    failed.value = false
    notes.value = null
    try {
      const listed = await vaultFileIndex.get(vault)
      // The answer belongs to the vault that asked. A vault switch between the ask and the answer
      // would otherwise list one workspace's notes under another's menu.
      if (vault !== options.vault()) return
      notes.value = listed
    } catch {
      if (vault !== options.vault()) return
      failed.value = true
    }
  }

  // `immediate`, because the question is not "did the word change" but "is there a word now": a
  // composer that mounts holding a half-written mention — a draft the reader came back to — has a
  // word from the first frame, and a watcher without this would leave its menu saying it was
  // reading a folder it never asked for.
  watch(
    query,
    (value) => {
      if (value === null) return
      const vault = options.vault()
      if (vault === null) return
      if (notes.value !== null || failed.value) return
      void load(vault)
    },
    { immediate: true },
  )

  /** What a keydown means here. See {@link AgentMentionKeyResult}. */
  function onKeydown(event: KeyboardEvent): AgentMentionKeyResult {
    if (isComposingKey(event)) return 'composing'
    if (view.value === 'closed') return 'pass'

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      move(1)
      return 'handled'
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      move(-1)
      return 'handled'
    }
    if (event.key === 'Escape') {
      // Closes the menu without touching the text: the reader keeps the half-typed word, and the
      // next keystroke is theirs. Nothing here deletes what they wrote.
      event.preventDefault()
      dismiss.value = true
      return 'handled'
    }
    if (event.key === 'Enter') {
      const path = activePath.value
      // Nothing highlighted means nothing to name — a list still being read, or a word no note
      // matches. Enter is then the composer's, and the message goes to the engine as written.
      if (path === null) return 'pass'
      event.preventDefault()
      options.select(path)
      return 'handled'
    }
    return 'pass'
  }

  watch(query, () => {
    dismiss.value = false
  })

  return {
    view: computed<AgentMentionView>(() => (dismiss.value ? 'closed' : view.value)),
    query,
    matches,
    activeIndex,
    activePath,
    move,
    setActive,
    onKeydown,
    /** Close the menu where it stands, keeping the text: what Escape and Tab both mean. */
    close(): void {
      dismiss.value = true
    },
    /** Whether the list was cut short by {@link MENTION_LIMIT}: said under the rows rather than
     *  leaving a list that merely stops. */
    truncated: computed(() => matches.value.length >= MENTION_LIMIT),
    /** For a caller that wants the walk to have happened before the reader types. */
    load,
  }
}

export type UseAgentComposerMentions = ReturnType<typeof useAgentComposerMentions>
