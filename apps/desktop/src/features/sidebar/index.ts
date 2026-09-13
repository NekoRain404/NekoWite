/**
 * The sidebar feature's public API.
 *
 * Nothing outside this feature imports one of its files by path (§13.11): a
 * caller goes through this entry point, so the internal layout (components /
 * composables) can change without touching a call site, and two features cannot
 * reach into each other's internals.
 *
 * Only the panel is exported. Its sections and composables — the navigation,
 * the tags, the references, the trash and the template picker — have a single
 * consumer, the panel itself, so they stay internal until something else
 * genuinely needs them (§13.11: shared code needs two real callers).
 */

export { default as AppSidebar } from './components/AppSidebar.vue'
