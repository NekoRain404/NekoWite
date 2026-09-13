import { t } from '../i18n'
import { baseName, dirName, stripVaultPrefix } from '../services/paths'

/**
 * Display helpers for the shell titlebar. Keep path slicing out of the
 * component so the shell shell never walks file paths itself.
 */

/** The tab's basename, or the placeholder title when it has no path. */
export function activeTabTitle(tab: { path: string | null } | null): string {
  if (!tab) return t('app.defaultTitle')
  const path = tab.path
  // `baseName`, not `split('/')`: on Windows the path has backslashes and the
  // split returned the whole absolute path as the tab's title.
  return path ? baseName(path) : t('tabs.untitled')
}

/** The tab's directory path relative to the vault ('' when at the vault root). */
export function activeTabSubtitle(tab: { path: string | null } | null, vault: string | null): string {
  if (!tab) return ''
  if (!tab.path || !vault) return tab.path ?? ''
  const dir = dirName(tab.path)
  // Both sides may be spelled with either separator; `stripVaultPrefix`
  // normalizes for the comparison and always answers with `/`.
  return stripVaultPrefix(dir, vault).replace(/\/+$/, '')
}
