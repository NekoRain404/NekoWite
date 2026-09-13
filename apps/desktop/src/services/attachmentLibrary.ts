/**
 * Compatibility shim, ONE stage only (§10.1.5).
 *
 * The library merged into `features/attachments/services/attachment-library.ts`
 * — one module owns "the attachment library" again, rather than this file and
 * the feature's — and its callers go through the feature's public entry
 * (`features/attachments/index.ts`). This file keeps the old
 * `services/attachmentLibrary` path resolving for one stage so an import this
 * change did not reach cannot break, and is deleted with the rest of the
 * compatibility layer once nothing imports it.
 */
export * from '../features/attachments'
