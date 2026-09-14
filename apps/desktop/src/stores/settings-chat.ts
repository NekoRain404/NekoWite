/**
 * The chat's content policy: how much of the active note the chat may attach,
 * and which writing prompts it offers.
 *
 * These are edited on the AI settings page but they are not part of the AI
 * *connection* — nothing in `settings-ai.ts`'s `config()` reads either, and the
 * only consumers of the effect are the chat feature's turn builder
 * (`use-chat-context`) and its composer (`use-ai-prompt-settings`). Keeping
 * them in a file of their own is what stops "the context budget" and "the
 * prompt shelf" — the two settings that landed together and found the same
 * 369-line file — from becoming the next round's reason to add a third.
 *
 * `createChatSettings()` is invoked by the store in `stores/settings.ts`, which
 * is the public API; import this module only to reach a constant.
 */

import { ref, watch } from 'vue'
import { persistence } from '../services/persistence'
import { readNumber, readStringList } from './settings-persist'

const LS_CONTEXT_CHARS = 'nekowite.ai.contextChars'
const LS_DISABLED_PROMPTS = 'nekowite.ai.disabledPrompts'

/**
 * The ceiling the settings UI enforces on the note-context budget, in
 * characters. The user's number: their model takes a 200K context and they
 * asked for the app to allow the whole of it.
 *
 * It is a **character** budget, and a context window is measured in **tokens**,
 * so the two are not the same unit and the gap between them is the whole reason
 * {@link DEFAULT_CONTEXT_CHARS} is not this number. For CJK, roughly one token
 * per character; for Latin, roughly a quarter. At this ceiling a Chinese note
 * is therefore on the order of 200 000 tokens — the entire window, with nothing
 * left for the system prompt, the conversation or the answer — while the same
 * count of English is nearer 50 000, a quarter of it.
 */
export const CONTEXT_CHARS_MAX = 200000

/**
 * What the app picks when the user has not chosen.
 *
 * **Half the ceiling, and the halving is the point.** At the pessimistic end of
 * what a tokenizer does to Chinese (modern BPE tokenizers land anywhere between
 * 1.0 and 1.5 tokens per character depending on the vocabulary), 200 000
 * characters is 200 000–300 000 tokens against a 200 000-token window: the
 * request overflows and the provider rejects it, on exactly the long Chinese
 * note this setting exists to stop cutting off. 100 000 characters is
 * 100 000–150 000 tokens, which leaves 50 000–100 000 for everything else in
 * the request — and the rest of it is bounded and small: the transcript is
 * capped separately at 6 000 characters by `buildChatPrompt`, the answer at the
 * max-output setting, the system prompt by whatever the user wrote.
 *
 * So the ceiling is theirs and the default is deliberately cautious: a number
 * that overflows on the case the feature is *for* is worse than a number that
 * is 16x the old one and still fits. A user who knows their model and their
 * script can raise it to 200 000; nothing stops them.
 *
 * (The old default was 6 000, against a 32 000 ceiling. The note is truncated
 * to this on the way out — see `buildContextBlock` — so this is the difference
 * between the model reading a section and reading the whole note.)
 */
export const DEFAULT_CONTEXT_CHARS = 100000

/** The bounds the settings UI enforces on {@link DEFAULT_CONTEXT_CHARS}. */
export const CONTEXT_CHARS_MIN = 1000

export function createChatSettings() {
  // How much of the active note the chat rail may send as context, in
  // characters. It used to be a hardcoded 2000 with no way to change it, which
  // made the feature useless for the long documents people actually write:
  // the model saw the first two pages of a fifty-page note and answered
  // confidently about the wrong part of it. The WINDOW is split between the
  // note's opening and its ending (see buildContextBlock), so this is the whole
  // budget, not one half of it.
  const contextChars = ref<number>(readNumber(LS_CONTEXT_CHARS, DEFAULT_CONTEXT_CHARS))
  // Which writing prompts the user switched off (see `features/ai/prompts`).
  // Stored as the off-list, not the on-list: a prompt added later is then on by
  // default for everybody instead of hidden from every install that has ever
  // opened this page.
  const disabledPrompts = ref<string[]>(readStringList(LS_DISABLED_PROMPTS))

  watch(contextChars, (v) => persistence.set(LS_CONTEXT_CHARS, String(v)))
  watch(disabledPrompts, (v) => persistence.set(LS_DISABLED_PROMPTS, JSON.stringify(v)), { deep: true })

  return { contextChars, disabledPrompts }
}
