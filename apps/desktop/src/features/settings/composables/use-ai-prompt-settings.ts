import { computed } from 'vue'
import { CHAT_PROMPTS, type ChatPrompt } from '../../ai'
import { useSettingsStore } from '../../../stores/settings'

export interface AiPromptSettingsModel {
  /** The whole shelf, in the order the composer offers it. The settings page
   *  lists every prompt — including the ones switched off, which is the point
   *  of a switch — while the composer asks `enabledPrompts` for the rest. */
  prompts: readonly ChatPrompt[]
  isOn: (id: string) => boolean
  setOn: (id: string, on: boolean) => void
}

/**
 * Which writing prompts the chat offers, and the switches for them.
 *
 * The store keeps the ids that are switched **off**, so this is the only place
 * that has to know the polarity: everything above it asks whether a prompt is
 * on. Reading it the other way round in the component is how the two would
 * drift — a switch labelled "show" bound to a stored "hidden" list is off by
 * one inversion away from doing the opposite of what it says.
 *
 * The shelf itself lives in `features/ai/prompts`, which is the feature's
 * public API (§13.11) — this composable is the view onto it for the settings
 * page, not a second copy of it.
 */
export function useAiPromptSettings(): AiPromptSettingsModel {
  const settings = useSettingsStore()

  const off = computed(() => new Set(settings.disabledPrompts))

  return {
    prompts: CHAT_PROMPTS,
    isOn: (id: string) => !off.value.has(id),
    setOn: (id: string, on: boolean) => {
      const next = new Set(off.value)
      if (on) next.delete(id)
      else next.add(id)
      settings.disabledPrompts = [...next]
    },
  }
}
