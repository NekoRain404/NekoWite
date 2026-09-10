import { editorSessionManager } from '../features/editor/sessionManager'
import { getTextSelection, replaceTextSelection } from './editorTextSelection'
import type { TextSelection } from './editorTextSelection'
import { notifyError } from './errors'
import { startChatCompletion } from './ai'
import type { ChatStream } from './ai'
import type { AIConfig } from '../stores/settings'
import { useSettingsStore } from '../stores/settings'
import { getLocale, t } from '../i18n'

/** The edit operations offered by the AI selection commands. */
export type EditAction = 'rewrite' | 'polish' | 'translate'

/** Structural view contract (a ProseMirror `EditorView` satisfies it). */
export interface EditView {
  state: {
    selection: { from: number; to: number; empty: boolean }
    doc: {
      textBetween(from: number, to: number, blockSeparator: string, leafText: string): string
    }
    tr: {
      insertText(text: string, from?: number, to?: number): unknown
    }
  }
  dispatch(tr: unknown): void
  focus(): void
}

export interface AiEditDeps {
  getView(): EditView | null
  /** The current text selection in whichever pane owns the document. */
  readSelection(): TextSelection | null
  /** Replace that selection; false when it can no longer be applied. */
  applySelection(text: string): boolean
  getConfig(): AIConfig
  notifyError(msg: string): void
  start: typeof startChatCompletion
  translate(key: string, params?: Record<string, unknown>): string
}

/** Real wiring; tests inject a fake through `rewriteSelection`'s `deps`. */
export const aiEditDeps: AiEditDeps = {
  getView: () => editorSessionManager.getView() as EditView | null,
  readSelection: getTextSelection,
  applySelection: replaceTextSelection,
  getConfig: () => useSettingsStore().config(),
  notifyError,
  start: startChatCompletion,
  translate: (key, params) => t(key, params),
}

const ACTION_INSTRUCTIONS: Record<EditAction, string> = {
  rewrite:
    'Rewrite the following selected text in your own words. Keep the meaning, tone and any markup intact. Output only the rewritten text, with no quotation marks around it and no preamble or explanation.',
  polish:
    'Polish the following selected text: improve grammar, clarity and rhythm while keeping the meaning, tone and any markup intact. Output only the polished text, with no preamble or explanation.',
  translate:
    'Translate the following selected text. Output only the translation, with no preamble or explanation.',
}

const TARGET_OF_LOCALE: Record<string, string> = {
  zh: 'Simplified Chinese',
  en: 'English',
}

function targetOfLocale(locale: ReturnType<typeof getLocale>): string {
  return TARGET_OF_LOCALE[locale] ?? 'English'
}

/** Build the model prompt for an edit action over a text selection. */
export function buildEditPrompt(
  action: EditAction,
  selection: string,
  targetLang?: string,
): string {
  let instruction = ACTION_INSTRUCTIONS[action]
  if (action === 'translate' && targetLang) {
    instruction = `Translate the following selected text into ${targetLang}. Output only the translation, with no preamble or explanation.`
  }
  return `${instruction}

${selection}`
}

/**
 * Replace the current selection with an AI rewrite/polish/translation.
 * Notifies (no-op friendly) when there is no view or no non-empty selection.
 */
export async function rewriteSelection(
  action: EditAction,
  deps: Partial<AiEditDeps> = {},
): Promise<ChatStream> {
  const d: AiEditDeps = { ...aiEditDeps, ...deps }
  // `deps.getView` is the injectable seam tests use; the selection itself comes
  // from the mode-aware accessor below.
  const view = d.getView()
  if (!view) {
    d.notifyError(d.translate('chat.editorNotReady'))
    return { cancel: () => undefined }
  }
  // Read and apply through the mode-aware accessors: a rewrite started in
  // source mode must act on the Markdown, not on the hidden rendered model,
  // where the result would be silently discarded when the model is re-opened
  // from the tab.
  const selection = d.readSelection()
  if (!selection || selection.text.trim() === '') {
    d.notifyError(d.translate('ai.noSelection'))
    return { cancel: () => undefined }
  }
  const target =
    action === 'translate' ? targetOfLocale(getLocale()) : undefined
  const prompt = buildEditPrompt(action, selection.text, target)
  return d.start(d.getConfig(), prompt, [], {
    onChunk: () => undefined,
    onDone: (full) => {
      if (!d.applySelection(full)) d.notifyError(d.translate('ai.noSelection'))
    },
    onError: (msg) => d.notifyError(msg),
  })
}