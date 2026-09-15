/**
 * The commands the chat panel offers: send a question, stop the answer,
 * interrupt it when the panel goes away, clear the conversation, insert an
 * answer into the document and copy it.
 *
 * This is the `command` half of the feature (§13.4) - the state is
 * `useChatSession`, the pure prompt assembly is `services/chatLogic`. Each
 * command is handed what it acts on (the composer's draft, the working copy of
 * the conversation, the note context) rather than reaching for a mounted panel,
 * so the request path can be driven without one.
 *
 * A send's own lifecycle - the states it moves through, the lock a second press
 * meets, and which send an outcome belongs to - is `useChatSend`, composed here
 * and passed straight through: the panel asks for one model and does not care
 * which module inside the feature answers. What is left here is the composer's
 * chrome (the two AI settings it displays, the prompt shortcuts) and the two
 * commands that act on an answer already in hand.
 */

import { computed, type ComputedRef } from 'vue'
import { CHAT_PROMPTS, enabledPrompts } from '../../ai'
import type { ChatPrompt } from '../../ai'
import { notifyError } from '../../../services/errors'
import { insertMarkdownAtCursor } from '../../../services/editor-insert'
import { useSettingsStore, type ReasoningEffort } from '../../../stores/settings'
import { useTabsStore } from '../../../stores/tabs'
import { useAiPermissionStore } from '../../../stores/ai-permission'
import { t } from '../../../i18n'
import type { ChatMessage } from '../services/chat-logic'
import { useChatSend, type ChatSendModel, type ChatSendOptions } from './use-chat-send'

/** id to prompt, for the composer's emit. Built once from the shelf, so an id
 *  that is not on it resolves to nothing rather than to a missing translation. */
const CHAT_PROMPTS_BY_ID = new Map(CHAT_PROMPTS.map((p) => [p.id, p]))

/** What the panel hands its commands. The send lifecycle declares this shape
 *  (it is what a send needs) and this module adds nothing to it. */
export type UseChatCommandsOptions = ChatSendOptions

export interface ChatCommandsModel extends ChatSendModel {
  /** The model label shown under the composer. */
  modelName: ComputedRef<string>
  /** The thinking depth the composer shows, and its write. */
  effort: ComputedRef<ReasoningEffort>
  setEffort(value: string): void
  /** The writing-prompt shortcuts the composer offers, in shelf order and
   *  without the ones switched off in Settings to AI. */
  promptShortcuts: ComputedRef<readonly ChatPrompt[]>
  /** Put a shortcut's text into the composer. It is a STARTING POINT and not a
   *  send: the question a shortcut opens with is rarely the whole question, and
   *  firing a request on the click would take the decision away from the person
   *  about to add "about the third section". */
  usePrompt(id: string): void
  insertIntoDocument(msg: ChatMessage): Promise<void>
  copyMessage(msg: ChatMessage): Promise<void>
}

export function useChatCommands(options: UseChatCommandsOptions): ChatCommandsModel {
  const settings = useSettingsStore()
  const tabs = useTabsStore()
  const send = useChatSend(options)

  const modelName = computed(() => settings.model)
  const effort = computed(() => settings.reasoningEffort)

  /** The thinking-depth select writes straight through to the setting it shows:
   *  its options come from `EFFORT_OPTIONS`, so a value that arrives here is one
   *  of those. */
  function setEffort(value: string): void {
    settings.reasoningEffort = value as ReasoningEffort
  }

  async function insertIntoDocument(msg: ChatMessage): Promise<void> {
    // Permission first: an insert the user declines must not touch the editor at
    // all (and must not half-apply before the question is answered).
    const approved = await useAiPermissionStore().ask({
      kind: 'insert',
      summary: t('aiperm.action.insert'),
      target: msg.content.trim().slice(0, 120),
    })
    if (!approved) {
      notifyError(t('aiperm.denied'))
      return
    }
    if (!tabs.activeTab) return
    try {
      // Mode-aware: in source mode the message has to land in the CodeMirror
      // text rather than in the hidden rendered model.
      const inserted = await insertMarkdownAtCursor(`\n\n${msg.content}\n\n`)
      if (inserted === false) notifyError(t('chat.editorNotReady'))
    } catch {
      notifyError(t('chat.insertFailed'))
    }
  }

  async function copyMessage(msg: ChatMessage): Promise<void> {
    try {
      await navigator.clipboard.writeText(msg.content)
    } catch {
      notifyError(t('chat.copyFailed'))
    }
  }

  /**
   * The shelf minus what the user switched off. The store keeps the OFF-list,
   * so the polarity is applied here and in `use-ai-prompt-settings` and nowhere
   * else — a second place to invert it is a second place to get it wrong.
   */
  const promptShortcuts = computed<readonly ChatPrompt[]>(() =>
    enabledPrompts(settings.disabledPrompts),
  )

  function usePrompt(id: string): void {
    const prompt = CHAT_PROMPTS_BY_ID.get(id)
    if (!prompt) return
    options.prompt.value = t(prompt.instructionKey)
  }

  return {
    ...send,
    modelName,
    effort,
    setEffort,
    promptShortcuts,
    usePrompt,
    insertIntoDocument,
    copyMessage,
  }
}
