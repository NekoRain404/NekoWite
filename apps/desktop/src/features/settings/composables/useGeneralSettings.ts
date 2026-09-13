import { computed, type ComputedRef } from 'vue'
import { getLocale, setLocale, t } from '../../../i18n'
import type { Locale } from '../../../i18n'
import { fsService } from '../../../platform/gateways/fs'
import { notifyError } from '../../../services/errors'
import { useVaultSessionStore } from '../../../stores/vaultSession'

export interface GeneralSettingsModel {
  /** The open vault, for display only (see `browseVault`). */
  vaultPath: ComputedRef<string>
  locale: ComputedRef<Locale>
  browseVault: () => Promise<string | null>
  onLocaleChange: (e: Event) => void
}

/**
 * State and commands for the General section: the vault the app has open, the
 * language, and nothing else.
 *
 * The store reads live here rather than in the section component (§10.2), so
 * the component only renders what this returns.
 */
export function useGeneralSettings(): GeneralSettingsModel {
  const vaultSession = useVaultSessionStore()
  const vaultPath = computed(() => (vaultSession.vault ?? '').trim())
  const locale = computed(() => getLocale())

  function onLocaleChange(e: Event): void {
    const v = (e.target as HTMLSelectElement).value
    setLocale(v === 'en' ? 'en' : 'zh')
  }

  /**
   * Open the native folder picker and hand the chosen folder to the runtime,
   * which owns the switch (flush → register → commit).
   *
   * This is the ONLY way the vault changes from this panel. The backend refuses
   * any root the user did not choose in the native dialog this session (or the
   * one it recorded last time), so a typed path could only ever end in a
   * refusal — the field above shows the vault that is actually open instead of
   * collecting one. Persisting the path is likewise the runtime's job: it writes
   * it once `register_vault` has committed, so a refused path is never stored
   * for the next launch to retry.
   *
   * Returns the picked path, or null when the user cancelled or the dialog
   * failed — the caller decides what a pick means, this decides what a failure
   * says.
   */
  async function browseVault(): Promise<string | null> {
    try {
      const picked = await fsService.openFolderDialog()
      return picked || null
    } catch (e) {
      notifyError(t('settings.general.vaultBrowseFailed', { msg: e instanceof Error ? e.message : String(e) }))
      return null
    }
  }

  return { vaultPath, locale, browseVault, onLocaleChange }
}
