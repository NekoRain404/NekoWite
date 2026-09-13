/**
 * The sidebar feature's public API.
 *
 * Nothing outside this feature imports one of its files by path (§13.11): a
 * caller goes through this entry point, so the internal layout (components /
 * composables) can change without touching a call site.
 *
 * The panel has not moved in yet — it still lives at `ui/AppSidebar.vue` and
 * takes its logic from here — so the composables are exported for that one
 * caller, for one stage. The moment the panel joins them under `components/`
 * they become internal and only the panel is exported.
 */

export { useSidebarNavigation } from './composables/useSidebarNavigation'
export { useSidebarReferences } from './composables/useSidebarReferences'
export { useSidebarTags } from './composables/useSidebarTags'
export { useSidebarTemplates } from './composables/useSidebarTemplates'
export { useSidebarTheme } from './composables/useSidebarTheme'
export { useSidebarTrash } from './composables/useSidebarTrash'
