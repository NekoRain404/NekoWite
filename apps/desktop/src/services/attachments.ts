/**
 * Compatibility shim, ONE stage only (§10.1.5).
 *
 * The attachment pipeline moved to `features/attachments/services/` — the path
 * grammar to `attachment-paths.ts`, the intake limits to `attachment-import.ts`
 * and the media reads to `attachment-library.ts` — and its callers go through
 * the feature's public entry (`features/attachments/index.ts`). This file keeps
 * the old `services/attachments` path resolving for one stage so an import this
 * change did not reach cannot break, and is deleted with the rest of the
 * compatibility layer once nothing imports it.
 */
export * from '../features/attachments'
