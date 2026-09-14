/**
 * Compatibility surface; the implementation moved to the modules beside it
 * (see the compatibility-surface rule in the programme's governance §13.11).
 *
 * `vault-index.ts` is the coordinator itself — it composes the note-list index
 * (`vault-note-index.ts`), the fs watch (`vault-fs-watch.ts`) and the
 * attachment badge (`vault-attachment-badge.ts`). This path stays so no
 * consumer (the vault session store, the app wiring, this feature's tests) has
 * to be edited, and it re-exports exactly what it exported before: the split
 * must not widen the feature's public surface.
 */
export * from './vault-index'
