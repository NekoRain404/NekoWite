/**
 * The editor handle the plugin host hands to plugins, with the app's write
 * policy applied to it.
 *
 * A plugin that declares NO permissions could still rewrite the document: the
 * host gives it the real `NekoEditor` (`PluginContext.editor`), whose
 * `insertMarkdownAtCursor` writes straight into the model. That made the AI
 * write policy - and the permission dialog's promise - false in the one place
 * it matters most: a plugin nobody vetted for document access.
 *
 * This wrapper is the app-side answer. The read-only surface (open, save,
 * getView, the suggestion API, subscriptions) passes straight through, because
 * reading the document is what a formatting helper legitimately needs; the
 * WRITE goes through `useAiPermissionStore().ask()`, exactly like the AI's own
 * insert. So:
 *
 *   - policy "禁止 AI 写入文档" (readonly) refuses the plugin's write too;
 *   - the default "每次询问" asks the user, naming the plugin as the source, and
 *     the insert happens only after they say yes;
 *   - "直接写入" (auto) lets it through, unchanged.
 *
 * A refusal is REPORTED rather than silent: a plugin whose write was blocked
 * must not look like a plugin whose button did nothing. The wrapper throws, so
 * the plugin's own error handling sees a real failure, and the host's callback
 * isolation turns that into a user-visible notice (see `reportPluginCallbackError`).
 */

import type { NekoEditor } from '@nekowite/editor-core'
import { useAiPermissionStore } from '../stores/aiPermission'
import { notifyError } from './errors'
import { t } from '../i18n'

export interface PluginEditorGuardOptions {
  /** Display name of the plugin, for the approval prompt and the refusal. */
  pluginName: string
}

export function guardEditorForPlugins(
  editor: NekoEditor,
  opts: PluginEditorGuardOptions,
): NekoEditor {
  return {
    open: (content) => editor.open(content),
    save: () => editor.save(),
    getView: () => editor.getView(),
    onContentChange: (cb) => editor.onContentChange(cb),
    setSuggestion: (text) => editor.setSuggestion(text),
    acceptSuggestion: () => editor.acceptSuggestion(),
    rejectSuggestion: () => editor.rejectSuggestion(),
    hasSuggestion: () => editor.hasSuggestion(),
    onSuggestionChange: (cb) => editor.onSuggestionChange(cb),
    destroy: () => editor.destroy(),
    insertMarkdownAtCursor: async (md: string): Promise<void> => {
      const approved = await useAiPermissionStore().ask({
        kind: 'insert',
        summary: t('plugin.writeSummary', { name: opts.pluginName }),
        target: 'cursor',
      })
      if (!approved) {
        notifyError(t('plugin.writeDenied', { name: opts.pluginName }))
        throw new Error(`plugin ${opts.pluginName} was not allowed to write to the document`)
      }
      await editor.insertMarkdownAtCursor(md)
    },
  }
}
