/**
 * The editor subject of the settings store: how often the document is written
 * back to disk, and how many versions the undo history keeps.
 *
 * The editor's *appearance* — body size, line height, focus mode, the split's
 * behaviour — is the appearance store's (`stores/appearance.ts`); this slice is
 * the two settings the editor section of the settings page owns that are not
 * about how the page looks.
 *
 * `createEditorSettings()` is invoked by the store in `stores/settings.ts`,
 * which is the public API; import this module only to reach a type.
 */

import { ref, watch } from 'vue'
import { persistence } from '../services/persistence'
import { readNumber } from './settings-persist'

export type AutosaveInterval = 'off' | 5000 | 15000 | 30000 | 60000

const LS_AUTOSAVE = 'nekowite.settings.autosaveInterval'
const LS_MAXHISTORY = 'nekowite.settings.maxHistory'

/** A closed ladder rather than any number: the value is stored as the literal
 *  the control offers, and a stored number the control no longer lists would
 *  leave the setting showing one thing and doing another. */
function readAutosaveInterval(fallback: AutosaveInterval): AutosaveInterval {
  const v = persistence.get(LS_AUTOSAVE)
  if (v === 'off') return 'off'
  const n = Number(v)
  return n === 5000 || n === 15000 || n === 30000 || n === 60000
    ? (n as AutosaveInterval)
    : fallback
}

export function createEditorSettings() {
  const autosaveInterval = ref<AutosaveInterval>(readAutosaveInterval(15000))
  const maxHistory = ref<number>(readNumber(LS_MAXHISTORY, 10))

  watch(autosaveInterval, (v) => persistence.set(LS_AUTOSAVE, String(v)))
  watch(maxHistory, (v) => persistence.set(LS_MAXHISTORY, String(v)))

  return { autosaveInterval, maxHistory }
}
