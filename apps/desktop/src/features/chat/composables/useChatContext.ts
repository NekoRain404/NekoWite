/**
 * What a question carries from the document it was asked about: the persisted
 * "attach the current note" toggle and the context block built from the active
 * tab.
 *
 * Building it reads the tabs store, the settings store and the editor session,
 * so it lives here rather than in the panel (§10.2). The pure assembly of the
 * block itself is `buildContextBlock` in `services/chatLogic`.
 */

import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { useSettingsStore } from '../../../stores/settings'
import { useTabsStore } from '../../../stores/tabs'
import { editorSessionManager } from '../../editor/sessionManager'
import { flushEdits } from '../../../services/editorOwnership'
import { buildContextBlock } from '../services/chatLogic'

export interface ChatContextModel {
  /** Persisted toggle for whether to send the active note / selection as context. */
  attachContext: Ref<boolean>
  toggleAttachContext(): void
  /** Whether a document is open at all. An empty note is NOT a missing one:
   *  the send path tells them apart (see `useChatCommands.send`). */
  hasActiveTab: ComputedRef<boolean>
  /** The context block for the active tab: title (frontmatter → filename),
   *  selection in priority over body. Empty string when nothing is usable. */
  buildActiveContext(): Promise<string>
}

const ATTACH_KEY = 'nekowite.chat.attachContext'

function loadAttachDefault(): boolean {
  try {
    const raw = localStorage.getItem(ATTACH_KEY)
    if (raw === '0') return false
  } catch {
    /* ignore corrupted storage */
  }
  return true
}

/** YAML `title:` from the leading frontmatter block, if any (minimal scan). */
function frontmatterTitle(md: string): string {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md)
  if (!block) return ''
  const m = /^title:\s*["']?([^"'\n]+)["']?/m.exec(block[1])
  return m ? m[1].trim() : ''
}

function noteTitleFromPath(path: string | null): string {
  if (!path) return ''
  const base = path.split(/[\\/]/).pop() ?? ''
  return base.replace(/\.[^.]+$/, '').trim()
}

function activeSelection(): string {
  const view = editorSessionManager.getView()
  if (!view) return ''
  const { state } = view
  const sel = state.selection
  if (!sel || sel.empty) return ''
  try {
    return state.doc.textBetween(sel.from, sel.to, '\n', ' ').trim()
  } catch {
    return ''
  }
}

export function useChatContext(): ChatContextModel {
  const settings = useSettingsStore()
  const tabs = useTabsStore()

  const attachContext = ref(loadAttachDefault())

  function toggleAttachContext(): void {
    attachContext.value = !attachContext.value
    try {
      localStorage.setItem(ATTACH_KEY, attachContext.value ? '1' : '0')
    } catch {
      /* ignore quota / private mode */
    }
  }

  const hasActiveTab = computed(() => tabs.activeTab !== null)

  async function buildActiveContext(): Promise<string> {
    const tab = tabs.activeTab
    if (!tab) return ''
    // The note is sent to the model as context; flush so it is the live text
    // rather than whatever a pane had published a debounce window ago.
    await flushEdits()
    const title = frontmatterTitle(tab.content) || noteTitleFromPath(tab.path)
    return buildContextBlock({
      noteTitle: title,
      selection: activeSelection(),
      noteContent: tab.content,
      // The user's budget, not a hardcoded one: on a long note the difference
      // between 2000 and 6000 characters is the difference between the model
      // seeing the note's title page and seeing the section being worked on.
      maxChars: settings.contextChars,
    })
  }

  return { attachContext, toggleAttachContext, hasActiveTab, buildActiveContext }
}
