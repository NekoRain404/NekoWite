/**
 * The AI provider the plugin host hands to plugins that declared `ai`.
 *
 * `permissions: ['ai']` was a promise the app did not keep: the host had no AI
 * surface, so a plugin that asked for it got nothing, and the only way to reach
 * a model from plugin code was to go around the app. This adapter is the other
 * half - the host exposes `ctx.ai.complete`, and the app decides what a
 * completion IS: the user's configured endpoint and key, the user's token
 * budget, and (through the guarded editor handle, see `pluginEditorGuard`) the
 * write policy for anything the plugin then puts into the document.
 *
 * It deliberately offers ONE call and no configuration surface: a plugin can
 * shape a prompt, but it cannot change the endpoint, read the key, or spend
 * budget the user did not set for the app.
 */

import { startChatCompletion } from './ai'
import { useSettingsStore } from '../stores/settings'
import { useAiPermissionStore } from '../stores/ai-permission'
import { recordAiAudit } from './ai-audit'
import { t } from '../i18n'

/** How long one plugin completion may take before it is abandoned. The chat
 *  rail streams for as long as the user waits and gives them a Stop button; a
 *  plugin call runs with no visible cancel, so it gets a ceiling. */
const PLUGIN_AI_TIMEOUT_MS = 60_000

/**
 * Run one completion for `pluginId`. Rejects with a readable message on any
 * failure (including the timeout and an empty answer), because the plugin's own
 * error handling and the host's isolation both turn a rejection into something
 * the user sees - and an empty answer written into the document would DELETE
 * text, which must never look like a success.
 */
export function completeForPlugin(pluginId: string, prompt: string): Promise<string> {
  const text = prompt.trim()
  if (!text) return Promise.reject(new Error(t('plugin.aiEmptyPrompt')))

  // A plugin spending the user's key is the least visible AI call in the app
  // (no panel, no Stop button), so every one of them is recorded - including
  // the refusals, which the master switch answers here.
  const permissions = useAiPermissionStore()
  if (!permissions.enabled) {
    recordAiAudit({
      source: 'plugin',
      outcome: 'blocked',
      detail: pluginId,
      reason: 'AI features are switched off',
    })
    return Promise.reject(new Error(t('plugin.aiDisabled')))
  }
  recordAiAudit({ source: 'plugin', outcome: 'asked', detail: pluginId })

  const config = useSettingsStore().config()
  return new Promise<string>((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(
      () => finish(() => reject(new Error(t('plugin.aiTimedOut')))),
      PLUGIN_AI_TIMEOUT_MS,
    )

    void startChatCompletion(config, text, [], {
      onChunk: () => undefined,
      onDone: (full) =>
        finish(() =>
          full.trim()
            ? resolve(full)
            : reject(new Error(t('plugin.aiEmpty', { name: pluginId }))),
        ),
      onError: (msg) => finish(() => reject(new Error(msg))),
    }).catch((e) => finish(() => reject(e instanceof Error ? e : new Error(String(e)))))
  })
}
