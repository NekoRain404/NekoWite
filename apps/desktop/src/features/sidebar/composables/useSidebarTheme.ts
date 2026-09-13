/**
 * The theme switch in the sidebar footer: which theme is in effect, and the
 * command that flips it (§13.4).
 *
 * The store read (appearance) lives here rather than in the component: §10.2
 * keeps a feature component off the stores. The effective theme is what the
 * button acts on, so the system preference is re-read on every change to it —
 * the appearance store bumps `systemRevision` when the OS scheme moves.
 */

import { computed } from 'vue'
import { useAppearanceStore } from '../../../stores/appearance'

export function useSidebarTheme() {
  const appearance = useAppearanceStore()

  const theme = computed<'light' | 'dark'>(() => {
    void appearance.systemRevision
    return appearance.effectiveTheme()
  })

  function toggleTheme(): void {
    appearance.setTheme(theme.value === 'dark' ? 'light' : 'dark')
  }

  return { theme, toggleTheme }
}
