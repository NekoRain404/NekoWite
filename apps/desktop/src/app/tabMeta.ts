import { t } from '../i18n'

/**
 * Display helpers for the shell titlebar. Keep path slicing out of the
 * component so the shell shell never walks file paths itself.
 */

/** The tab's basename, or the placeholder title when it has no path. */
export function activeTabTitle(tab: { path: string | null } | null): string {
  if (!tab) return t('app.defaultTitle')
  const path = tab.path
  return path ? path.split('/').pop() ?? path : t('tabs.untitled')
}

/** The tab's directory path relative to the vault ('' when at the vault root). */
export function activeTabSubtitle(tab: { path: string | null } | null, vault: string | null): string {
  if (!tab) return ''
  if (!tab.path || !vault) return tab.path ?? ''
  const dir = tab.path.slice(0, Math.max(0, tab.path.lastIndexOf('/')))
  const v = vault.replace(/\/+$/, '')
  return dir.startsWith(v) ? dir.slice(v.length + 1) : dir
}
