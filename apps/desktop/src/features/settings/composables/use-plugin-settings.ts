import { computed, onMounted, ref, type ComputedRef, type Ref } from 'vue'
import { isPluginImportAllowedByCsp, readVaultPlugins, setVaultPluginDisabled } from '../../../features/plugins'
import type { DisabledPluginsRead, VaultPluginSummary } from '../../../features/plugins'
import { useVaultSessionStore } from '../../../stores/vault-session'
import { notifyError } from '../../../services/errors'
import { t } from '../../../i18n'

export interface PluginSettingsModel {
  /** Whether THIS build can run plugin code at all. */
  runnable: boolean
  loading: Ref<boolean>
  /** Set when the last read of the plugins folder FAILED. */
  loadFailed: Ref<boolean>
  /** What the vault's stored switch state could be established as on the last
   *  read. The rows' `disabled` flags come out of the in-memory record, so this
   *  is the fact that says whether those flags are the vault's or the app's. */
  switches: Ref<DisabledPluginsRead>
  vaultPath: ComputedRef<string>
  rows: Ref<VaultPluginSummary[]>
  togglePlugin: (row: VaultPluginSummary, enabled: boolean) => Promise<void>
  refreshPluginRows: () => Promise<void>
}

/**
 * The Plugins section's state and its one command: which plugins the open vault
 * offers, and whether each is switched on.
 *
 * `refreshPluginRows` runs on mount. The section is only mounted while it is the
 * visible one (the panel switches with `v-if`), so mounting is the same event as
 * the section becoming active — the read happens when the user looks, and never
 * in the background.
 */
export function usePluginSettings(): PluginSettingsModel {
  const vaultSession = useVaultSessionStore()
  const vaultPath = computed(() => (vaultSession.vault ?? '').trim())

  const rows = ref<VaultPluginSummary[]>([])
  /**
   * Set when the last read of the plugins folder FAILED.
   *
   * "This library has no plugins" and "the plugins folder could not be read"
   * must never render the same: the second is what a permission problem looks
   * like, and telling the user nothing is installed sends them looking for a
   * problem they do not have. Same policy as the history panel's `loadFailed`
   * and the trash section's `trashUnreadable`.
   */
  const loadFailed = ref(false)
  /**
   * What the last read established about the vault's switch file.
   *
   * "Nothing is switched off here" and "the file that records it could not be
   * verified" must not render the same either — the rows below are drawn from
   * the in-memory record, and with a tampered or unreadable file that record is
   * this session's belief rather than the vault's contents. `absent` is the
   * honest start: no read has happened yet, and a vault with no file is the same
   * answer.
   */
  const switches = ref<DisabledPluginsRead>('absent')
  /** Whether THIS build can run plugin code at all. The list below reads the
   *  plugins folder either way, so a released build would otherwise show a tidy
   *  list of plugins with working-looking switches and never run one. */
  const runnable = isPluginImportAllowedByCsp()

  const loading = ref(false)

  /** Read the plugins folder for the vault that is open right now. Only
   *  manifests are read - nothing is imported - so opening the panel can never
   *  run plugin code. */
  async function refreshPluginRows(): Promise<void> {
    const vault = vaultPath.value
    if (!vault) {
      rows.value = []
      loadFailed.value = false
      switches.value = 'absent'
      return
    }
    loading.value = true
    try {
      const listing = await readVaultPlugins(vault)
      rows.value = listing.rows
      switches.value = listing.switches
      loadFailed.value = false
    } catch (e) {
      // The list is unknown, not empty. The toast carries the backend reason
      // (which folder, what the OS said); the flag is what the section renders
      // instead of "no plugins in this library".
      notifyError(t('settings.plugins.readFailed', { msg: e instanceof Error ? e.message : String(e) }))
      rows.value = []
      loadFailed.value = true
      // `switches` is deliberately left where it was: the failure state owns the
      // section (it renders the failure note instead of any row), so a value
      // nothing draws must not be invented here.
    } finally {
      loading.value = false
    }
  }

  /** Flip one plugin and re-read, so the row describes the app's actual state
   *  rather than what the click assumed it would be.
   *
   *  The call answers with two separate facts, and each gets its own sentence: a
   *  switch that snapped back (the gates refused the plugin, or the file would
   *  not take the decision) and a decision that only lives in this session need
   *  different things from the user. Neither is left to the row, which cannot
   *  see either one. */
  async function togglePlugin(row: VaultPluginSummary, enabled: boolean): Promise<void> {
    const outcome = await setVaultPluginDisabled(row.id, !enabled, { vault: vaultPath.value })
    if (outcome.refused) {
      notifyError(t('settings.plugins.toggleRefused', { msg: outcome.refused }))
      // The record did not move, so the row is about to describe the same state
      // as before the click — and a switch the user just moved is NOT rewritten
      // by the renderer when its bound value never changed: it would keep the
      // tick. Dropping the stale list makes the re-read build the row again.
      rows.value = []
    }
    if (outcome.saved === 'tampered') {
      notifyError(t('settings.plugins.toggleTampered'))
    } else if (outcome.saved === 'failed') {
      notifyError(t('settings.plugins.toggleNotSaved'))
    }
    await refreshPluginRows()
  }

  onMounted(() => {
    void refreshPluginRows()
  })

  return { runnable, loading, loadFailed, switches, vaultPath, rows, togglePlugin, refreshPluginRows }
}
