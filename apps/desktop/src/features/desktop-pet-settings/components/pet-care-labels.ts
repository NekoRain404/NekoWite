/**
 * The care panel's wording, read from `src/i18n/namespaces/settings.ts`
 * (`settings.pet.care.panel.*`).
 *
 * A file of its own rather than the second half of `PetCareSettings.vue`, for the reason
 * `agent-skills-labels.ts` gives for its own: one catalogue key per line, one line per field — a
 * table that changes when a sentence changes and never when a behaviour does. The page imports one
 * function and hands the result to the panel's `labels` prop, which is the seam D10 left for it
 * (「the wording comes from a `labels` prop over `PET_CARE_PANEL_LABELS` defaults, which is where
 * §10.1's i18n namespace plugs in」).
 *
 * **Every pattern arrives with its `{slots}` intact.** The panel fills them itself
 * (`fillPetLabel`), because a level, a count and a day key are *data*. vue-i18n renders an
 * interpolation it was given no value for as the empty string, so a sentence read with `t()` alone
 * would be hollowed out before the panel ever saw it — the slot names are therefore read out of the
 * message as the catalogue writes it (`tm`, the raw entry) and handed back as their own literal
 * text. That is the same helper, for the same reason, as the skills section's.
 *
 * **Only the fields this page can draw are here, and the type says so.** `absent`, `readOnly`,
 * `preview` and the four import lines are deliberately absent: no control on the care page produces
 * an import, a sample or a record from a newer build, so a translated sentence for one would be a
 * string nobody renders — and the day a surface can, that surface adds its own table here. The
 * panel keeps its English defaults for those fields, which is what a default is for; {@link
 * CarePanelWording} is a `Pick` rather than `Partial` so a field this page *does* draw cannot go
 * missing quietly.
 */
import { i18n, t } from '../../../i18n'
import type { PetCarePanelLabels } from '../../desktop-pet'

/** The panel fields this page draws. Total on purpose: a dropped field is a compile error. */
export type CarePanelWording = Pick<
  PetCarePanelLabels,
  | 'panel'
  | 'level'
  | 'progress'
  | 'hunger'
  | 'streak'
  | 'meals'
  | 'achievements'
  | 'earned'
  | 'locked'
  | 'usage'
  | 'usageUnknown'
  | 'usagePartial'
  | 'day'
  | 'dayToday'
  | 'dayUnknown'
  | 'stages'
  | 'hungerSteps'
>

/**
 * One catalogue sentence with its `{slot}` names left as `{slot}`.
 *
 * The names are taken from the message as the catalogue writes it rather than listed here: a
 * translation that gained a slot the call site did not know about would otherwise render a hole,
 * which is the failure this helper exists to prevent.
 */
function pattern(key: string): string {
  const raw: unknown = i18n.global.tm(key)
  const sentence = typeof raw === 'string' ? raw : t(key)
  const values: Record<string, string> = {}
  for (const match of sentence.matchAll(/\{(\w+)\}/g)) values[match[1]] = match[0]
  return Object.keys(values).length === 0 ? sentence : t(key, values)
}

export function carePanelLabels(): CarePanelWording {
  return {
    panel: t('settings.pet.care.panel.label'),
    level: pattern('settings.pet.care.panel.level'),
    progress: pattern('settings.pet.care.panel.progress'),
    hunger: pattern('settings.pet.care.panel.hunger'),
    streak: pattern('settings.pet.care.panel.streak'),
    meals: pattern('settings.pet.care.panel.meals'),
    achievements: pattern('settings.pet.care.panel.achievements'),
    earned: t('settings.pet.care.panel.earned'),
    locked: t('settings.pet.care.panel.locked'),
    usage: pattern('settings.pet.care.panel.usage'),
    usageUnknown: t('settings.pet.care.panel.usageUnknown'),
    usagePartial: pattern('settings.pet.care.panel.usagePartial'),
    day: pattern('settings.pet.care.panel.day'),
    dayToday: pattern('settings.pet.care.panel.dayToday'),
    dayUnknown: t('settings.pet.care.panel.dayUnknown'),
    // The two vocabularies: one word per `PetCareStage` and one per hunger step. A step added to
    // either list is a missing key here rather than a surface that quietly shows an English word —
    // and `Record` is what makes that true, rather than a sparse object a lookup could miss.
    stages: {
      hatchling: t('settings.pet.care.panel.stages.hatchling'),
      companion: t('settings.pet.care.panel.stages.companion'),
      scout: t('settings.pet.care.panel.stages.scout'),
      hero: t('settings.pet.care.panel.stages.hero'),
      legend: t('settings.pet.care.panel.stages.legend'),
    },
    hungerSteps: {
      full: t('settings.pet.care.panel.hungerSteps.full'),
      satisfied: t('settings.pet.care.panel.hungerSteps.satisfied'),
      peckish: t('settings.pet.care.panel.hungerSteps.peckish'),
      hungry: t('settings.pet.care.panel.hungerSteps.hungry'),
      starving: t('settings.pet.care.panel.hungerSteps.starving'),
    },
  }
}
