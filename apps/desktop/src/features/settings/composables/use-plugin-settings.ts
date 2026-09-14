import { computed, onMounted, ref, type ComputedRef, type Ref } from 'vue'
import { isPluginImportAllowedByCsp, listVaultPlugins, setVaultPluginDisabled } from '../../../services/plugins'
import type { VaultPluginSummary } from '../../../services/plugins'
import { useVaultSessionStore } from '../../../stores/vault-session'

export interface PluginSettingsModel {
  /** Whether THIS build can run plugin code at all. */
  runnable: boolean
  loading: Ref<boolean>
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
      return
    }
    loading.value = true
    try {
      rows.value = await listVaultPlugins(vault)
    } catch {
      rows.value = []
    } finally {
      loading.value = false
    }
  }

  /** Flip one plugin and re-read, so the row describes the app's actual state
   *  rather than what the click assumed it would be. */
  async function togglePlugin(row: VaultPluginSummary, enabled: boolean): Promise<void> {
    setVaultPluginDisabled(row.id, !enabled, { vault: vaultPath.value })
    await refreshPluginRows()
  }

  onMounted(() => {
    void refreshPluginRows()
  })

  return { runnable, loading, vaultPath, rows, togglePlugin, refreshPluginRows }
}
