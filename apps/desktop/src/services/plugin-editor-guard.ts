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
 * This wrapper is the app-side answer. Reading passes straight through
 * (`save`, `getView`, `rejectSuggestion`, `hasSuggestion`, subscriptions),
 * because reading the document is what a formatting helper legitimately needs;
 * the WRITES go through the same store the AI's own writes use. So:
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
 *
 * Three writes are SYNCHRONOUS in the editor handle and cannot await a
 * question: `open` replaces the whole buffer and returns nothing, and
 * `acceptSuggestion` returns the inserted text (`string | null`) rather than a
 * promise. Those proceed only when the decision is ALREADY 'allow' — policy
 * "直接写入", or a session grant for that kind — because the alternative is
 * writing without the consent the policy promised. Under "每次询问" the plugin
 * is told to use `insertMarkdownAtCursor`, which can prompt; `setSuggestion(null)`
 * is always allowed, since clearing a suggestion writes nothing.
 */

import type { NekoEditor } from '@nekowite/editor-core'
import { useAiPermissionStore } from '../stores/ai-permission'
import { decideAiWrite, type AiWriteKind } from './ai-permissions'
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
  /** The decision for a write that cannot be asked about, using the same pure
   *  table as the prompting path. Under "每次询问" this is 'ask', which is not
   *  an approval — only 'allow' lets a synchronous write through. */
  const syncAllowed = (kind: AiWriteKind): boolean =>
    decideAiWrite(useAiPermissionStore().state, { kind, summary: '' }) === 'allow'

  const refuseSync = (kind: AiWriteKind): never => {
    notifyError(t('plugin.syncWriteDenied', { name: opts.pluginName }))
    throw new Error(
      `plugin ${opts.pluginName} must not perform a synchronous "${kind}" write without a standing permission`,
    )
  }

  return {
    // Whole-document replacement: it destroys more than a selection, so it is
    // asked about separately and granted separately.
    open: async (content): Promise<void> => {
      const approved = await useAiPermissionStore().ask({
        kind: 'replace-document',
        summary: t('plugin.openSummary', { name: opts.pluginName }),
        target: 'document',
      })
      if (!approved) {
        notifyError(t('plugin.writeDenied', { name: opts.pluginName }))
        throw new Error(`plugin ${opts.pluginName} was not allowed to replace the document`)
      }
      await editor.open(content)
    },
    save: () => editor.save(),
    getView: () => editor.getView(),
    onContentChange: (cb) => editor.onContentChange(cb),
    setSuggestion: (text) => {
      // Clearing is not a write, and a plugin must always be able to take its
      // own staged suggestion back.
      if (text === null) {
        editor.setSuggestion(null)
        return
      }
      if (!syncAllowed('insert')) {
        editor.setSuggestion(null)
        refuseSync('insert')
      }
      editor.setSuggestion(text)
    },
    acceptSuggestion: () => {
      if (!syncAllowed('insert')) refuseSync('insert')
      return editor.acceptSuggestion()
    },
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
