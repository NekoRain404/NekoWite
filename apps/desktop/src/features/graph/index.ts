/**
 * The graph feature's public API.
 *
 * Nothing outside this feature imports one of its files by path (§13.11): a
 * caller goes through this entry point, so the internal layout
 * (components / composables / services) can change without touching a call
 * site, and two features cannot reach into each other's internals.
 *
 * Only the panel is exported. Its composables and services - the graph, the
 * filters, the canvas and the drawing maths - have a single consumer, the panel
 * itself, so they stay internal until something else genuinely needs them
 * (§13.11: shared code needs two real callers).
 */

export { default as GraphPanel } from './components/GraphPanel.vue'
