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
 * so the two are not the same unit — and the ratio between them is the whole
 * question. **Measured** (2026-09-15, against the gateway this checkout is
 * configured for, `https://tokenflux.dev/v1`, model `deepseek-flash`, using the
 * provider's own `prompt_tokens`): the app's maximal request — a
 * 200 000-character Chinese note wrapped the way `buildContextBlock` wraps one
 * — came to **102 757 tokens**, i.e. **0.51 tokens per character**, and the
 * ratio held as the note grew: 300 000 chars → 154 108 tokens, 600 000 →
 * 308 162, and a rejected 2 000 000-character request whose message reported
 * 1 027 056 tokens. So at the ratio this tokenizer produces, this
 * ceiling is about **103 000 tokens** — roughly a tenth of that model's window
 * (1 048 576 tokens, from the provider's own rejection) and about half of the
 * 200 000-token window the 200K above is named for.
 *
 * That is one tokenizer's answer, and the app cannot see the user's. A
 * vocabulary hostile to Chinese reaches 1.5 tokens per character, which puts
 * this ceiling at 300 000 tokens — over a 200 000-token window, with nothing
 * left for the system prompt, the conversation or the answer. Both ends of that
 * range are real, which is why {@link DEFAULT_CONTEXT_CHARS} is not this number.
 */
export const CONTEXT_CHARS_MAX = 200000

/**
 * What the app picks when the user has not chosen.
 *
 * **Half the ceiling. The halving survives the measurement; the sentence that
 * used to justify it does not, so it is restated here.** It read: "200 000
 * characters is 200 000–300 000 tokens against a 200 000-token window, so the
 * request overflows on exactly the long Chinese note this setting exists for."
 * Measured (see {@link CONTEXT_CHARS_MAX}), that is the pessimistic end only:
 * at 0.51 tokens per character the ceiling is ~103 000 tokens and fits a
 * 200 000-token window with room to spare.
 *
 * What the default has to survive is the other end, because the app cannot see
 * the user's tokenizer: at 1.5 tokens per character the ceiling is 300 000
 * tokens and does not fit, while **this** number is 150 000 — inside a
 * 200 000-token window, with 50 000 left for everything else in the request.
 * The rest of it is bounded and small: the transcript is capped separately at
 * 6 000 characters by `buildChatPrompt`, the answer at the max-output setting,
 * the system prompt by whatever the user wrote. At the measured ratio this
 * number is 51 000 tokens, a quarter of the window it is named for; and it is
 * 16x the old 6 000-character default, which is the difference between the
 * model reading a section and reading the whole note.
 *
 * So the ceiling is theirs and the default is deliberately cautious — but for a
 * reason narrower than the old one: the two failure modes are not equally bad.
 * A default that is too large costs a rejected request on the case the feature
 * exists for (the user is told why and told to lower this number, see
 * `CONTEXT_OVERFLOW_HINT`); one that is too small sends most of the note and
 * says what it left out, on the same toast that names this setting
 * (`contextTruncatedNotice`). A user who knows their model and their script can
 * raise it to 200 000; nothing stops them.
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
