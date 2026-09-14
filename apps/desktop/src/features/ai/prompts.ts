/**
 * The shelf of writing prompts: the ones the chat composer offers as shortcuts,
 * and the ones the AI section lets the user switch off.
 *
 * **These are this app's prompts, not a generic assistant's.** They are the
 * moves somebody writing a Markdown note actually makes — summarise what is
 * there, pull the tasks out of it, tighten a paragraph, outline what is missing,
 * name it, tag it, keep going. A shelf of "explain / brainstorm / be creative"
 * would be a menu nobody reaches for, because the note itself is the subject and
 * every one of these is a different question to ask *about* it.
 *
 * **Curated, not enumerated.** The user asked for a set to be added; a shelf of
 * thirty is a menu. Ten were considered and eight kept (the two that were not
 * are named in the report — translating, which already exists as a selection
 * command, and prose-to-table, which is rarer than the rest).
 *
 * **Where each string comes from is the i18n decision, and it is split by who
 * reads it.** A `labelKey` is UI copy and follows the interface language, like
 * every other string in the app. An `instructionKey` is the text the *model*
 * reads, and it follows the interface language too — deliberately, and not
 * because it is a UI string. The prompt is a question about a document the user
 * wrote in their own language, and the language of the instruction is the
 * strongest signal the model has for what language to answer in: an English
 * instruction over a Chinese note is an invitation to answer in English, which
 * is the defect, not the localisation. (`services/ai-edit.ts` keeps its
 * selection instructions in English for the same feature from the other side;
 * that inconsistency is recorded in the report rather than resolved here.)
 *
 * **Out of scope, deliberately:** letting the user author their own prompts.
 * The request was to *add* a set — 加入 — and a prompt editor is a different
 * feature with its own storage, validation and UI. This module is the seam it
 * would be built on, which is why the prompts are data rather than markup.
 */

/** One prompt on the shelf, as data — never as a component. */
export interface ChatPrompt {
  /** Stable id: what the settings store persists as switched off. */
  id: string
  /** i18n key for the button the user reads. */
  labelKey: string
  /** i18n key for the instruction the model reads. */
  instructionKey: string
}

/**
 * The shelf, in the order the composer shows it.
 *
 * Ordered by roughly how often a person reaches for them rather than
 * alphabetically: the three that are about *the whole note* come first, then
 * the ones about a passage, then the two that produce something new.
 */
export const CHAT_PROMPTS: readonly ChatPrompt[] = [
  { id: 'summarize', labelKey: 'aiSettings.prompt.summarize.label', instructionKey: 'aiSettings.prompt.summarize.text' },
  { id: 'actionItems', labelKey: 'aiSettings.prompt.actionItems.label', instructionKey: 'aiSettings.prompt.actionItems.text' },
  { id: 'outline', labelKey: 'aiSettings.prompt.outline.label', instructionKey: 'aiSettings.prompt.outline.text' },
  { id: 'tighten', labelKey: 'aiSettings.prompt.tighten.label', instructionKey: 'aiSettings.prompt.tighten.text' },
  { id: 'proofread', labelKey: 'aiSettings.prompt.proofread.label', instructionKey: 'aiSettings.prompt.proofread.text' },
  { id: 'title', labelKey: 'aiSettings.prompt.title.label', instructionKey: 'aiSettings.prompt.title.text' },
  { id: 'tags', labelKey: 'aiSettings.prompt.tags.label', instructionKey: 'aiSettings.prompt.tags.text' },
  { id: 'continue', labelKey: 'aiSettings.prompt.continue.label', instructionKey: 'aiSettings.prompt.continue.text' },
]

/** Every id on the shelf, for the settings list and for validating what is
 *  persisted — a stored id that no longer exists is dropped rather than shown
 *  as a switch that does nothing. */
export const CHAT_PROMPT_IDS: readonly string[] = CHAT_PROMPTS.map((p) => p.id)

/**
 * The prompts to offer, given the ids the user switched off.
 *
 * An unknown id in `disabled` is ignored: the shelf is the authority on what
 * exists, and a stored list from an older build must not be able to hide a
 * prompt that has since been added.
 */
export function enabledPrompts(disabled: readonly string[]): readonly ChatPrompt[] {
  if (disabled.length === 0) return CHAT_PROMPTS
  return CHAT_PROMPTS.filter((prompt) => !disabled.includes(prompt.id))
}
