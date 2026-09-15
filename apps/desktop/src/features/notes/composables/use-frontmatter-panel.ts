/**
 * The frontmatter property panel: what the active note's block currently says,
 * what the user has edited, and the writes that put the two back together.
 *
 * The editable model is `services/frontmatter-panel.ts` — parse and serialize
 * as one contract. This composable is the part that needs a tab and a store to
 * work on, which is why it is a composable rather than a service, and why the
 * panel SFC is left with its markup and its event wiring.
 *
 * Every write goes through `flushEdits` first. The panel edits one block of a
 * document a pane may be holding unpublished keystrokes for, and a
 * whole-document read-modify-write against the stale text would drop them — and
 * then mirror the stale version back into the pane it just ignored. Both panes
 * have to be flushed, not just CodeMirror: the rendered pane publishes through a
 * trailing debounce and is the one the user types into by default.
 *
 * Two watchers keep the fields in step with the document, and they look at
 * different things on purpose: `content` follows the text (an edit made in a
 * pane, a restore), `id` follows the tab (two notes can have identical text,
 * and switching between them must re-read rather than trust the parse).
 */

import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import { useTabsStore } from '../../../stores/tabs'
import { useDocumentListStore } from '../../../stores/document-list'
import { flushEdits } from '../../../services/editor-ownership'
import { baseName } from '../../../services/paths'
import { isComposingKey } from '../../../services/key-guard'
import { normalizeTag, normalizeTags } from '../../../services/tags'
import {
  emptyFrontmatterFields,
  parseFrontmatterForPanel,
  replaceFrontmatter,
  serializeFrontmatter,
  type FrontmatterFields,
} from '../services/frontmatter-panel'
import { splitFrontmatterRaw } from '../services/frontmatter-scan'
import { fileNameTitle } from '../services/note-summary'

export interface FrontmatterPanelModel {
  /** Whether there is a document to show properties for at all. */
  hasDoc: ComputedRef<boolean>
  /** The fields the panel edits; bound with `v-model` on each input. */
  form: Ref<FrontmatterFields>
  /** Whether the active note has a frontmatter block at all. */
  hasFront: Ref<boolean>
  /** The tag input's in-progress text. */
  tagInput: Ref<string>
  /** Every tag used in the vault, for the input's datalist. */
  suggestions: ComputedRef<string[]>
  /** The keys the panel does not understand, for its read-only list. */
  otherEntries: ComputedRef<Array<[string, string]>>
  /** True when the fields differ from the block in the document. */
  isDirty: ComputedRef<boolean>
  /** The writes are async: each one publishes the pane the user is typing in
   *  before it transforms the document (see `writeContent`), and a caller that
   *  needs the document to hold the result must await the returned promise. */
  addProperties: () => Promise<void>
  commit: () => Promise<void>
  addTagRaw: (raw: string) => Promise<void>
  removeTag: (tag: string) => Promise<void>
  onTagKeydown: (e: KeyboardEvent) => void
  onTitleKeydown: (e: KeyboardEvent) => void
}

export function useFrontmatterPanel(): FrontmatterPanelModel {
  const tabs = useTabsStore()
  const documentList = useDocumentListStore()

  const tab = computed(() => tabs.activeTab)
  const hasDoc = computed(() => tab.value !== null)

  const form = ref<FrontmatterFields>(emptyFrontmatterFields())
  const hasFront = ref(false)
  const tagInput = ref('')

  const suggestions = computed(() => documentList.tagCounts.map((c) => c.tag))
  const otherEntries = computed(() => Object.entries(form.value.other))

  const isDirty = computed(() => {
    const content = tab.value?.content ?? ''
    const { front } = splitFrontmatterRaw(content)
    return serializeFrontmatter(form.value) !== front
  })

  function syncFromContent(content: string): void {
    const { front } = splitFrontmatterRaw(content)
    hasFront.value = front !== ''
    form.value = parseFrontmatterForPanel(front)
  }

  watch(
    () => tab.value?.content,
    (content) => {
      if (content === undefined) return
      syncFromContent(content)
    },
    { immediate: true },
  )

  watch(
    () => tab.value?.id,
    () => {
      if (tab.value) syncFromContent(tab.value.content)
    },
  )

  async function writeContent(fields: FrontmatterFields): Promise<void> {
    // Read BEFORE the flush below, which awaits: the edit belongs to the document
    // the panel is showing, and a tab switch landing mid-flush must not move the
    // write onto the note the user went to.
    const active = tab.value
    if (!active) return
    // Whole-document read-modify-write: publish the pane the user is typing in
    // first so the edit applies to the live text (and neither pane is then
    // mirrored back to a version a debounce window out of date).
    //
    // `flushEdits()` and not the synchronous `flushSourceEdits()` this used to
    // call: that one covers only the CodeMirror pane, which in rendered mode —
    // where the panel is normally edited — is not mounted at all, so anything
    // typed into the rendered pane was dropped by the rewrite that followed.
    await flushEdits()
    const { content, changed } = replaceFrontmatter(active.content, fields)
    if (!changed) return
    active.content = content
    tabs.markDirty(active.id)
    tabs.scheduleAutosave(active.id)
    syncFromContent(content)
  }

  async function commit(): Promise<void> {
    // The fields are read HERE, before the write's flush await: the content
    // watcher re-syncs `form` when the flush publishes the live text, and a
    // re-read after it would replace the user's edit with the document's own
    // frontmatter — the edit they are committing.
    const fields: FrontmatterFields = { ...form.value, tags: normalizeTags(form.value.tags) }
    await writeContent(fields)
  }

  async function addProperties(): Promise<void> {
    const active = tab.value
    if (!active) return
    const name = active.path ? baseName(active.path) : ''
    const h1 = /^#\s+(.+?)\s*#*\s*$/m.exec(active.content)
    const title = fileNameTitle(name) || h1?.[1]?.trim() || ''
    const next: FrontmatterFields = { title, tags: [], date: '', created: '', updated: '', other: {}, rawSegments: [] }
    await writeContent(next)
  }

  async function addTagRaw(raw: string): Promise<void> {
    const pieces = raw.split(',').map(normalizeTag).filter(Boolean)
    tagInput.value = ''
    if (pieces.length === 0) return
    const next = normalizeTags([...form.value.tags, ...pieces])
    await commitTags(next)
  }

  async function commitTags(next: string[]): Promise<void> {
    // The rest of the form is captured here, before `writeContent` awaits its
    // flush, for the reason `commit` gives.
    await writeContent({ ...form.value, tags: next })
  }

  async function removeTag(tag: string): Promise<void> {
    await commitTags(normalizeTags(form.value.tags.filter((x) => x !== tag)))
  }

  function onTagKeydown(e: KeyboardEvent): void {
    // Enter accepts the IME candidate, and Backspace edits the composing text —
    // none of those may be read as "add this tag" / "delete the previous tag".
    if (isComposingKey(e)) return
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      // A DOM handler cannot be awaited; the write lands on its own, and the
      // input's value is cleared synchronously inside `addTagRaw`.
      void addTagRaw(tagInput.value)
      return
    }
    if (e.key === 'Backspace' && tagInput.value === '') {
      const next = form.value.tags.slice(0, -1)
      if (next.length !== form.value.tags.length) void commitTags(next)
    }
  }

  function onTitleKeydown(e: KeyboardEvent): void {
    // Enter commits the title. While an IME candidate list is open it belongs to
    // the IME instead, or the half-finished pinyin string is written to the file.
    if (isComposingKey(e)) return
    if (e.key === 'Enter') {
      e.preventDefault()
      ;(e.target as HTMLInputElement).blur()
      void commit()
    }
  }

  return {
    hasDoc,
    form,
    hasFront,
    tagInput,
    suggestions,
    otherEntries,
    isDirty,
    addProperties,
    commit,
    addTagRaw,
    removeTag,
    onTagKeydown,
    onTitleKeydown,
  }
}
