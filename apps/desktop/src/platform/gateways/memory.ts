/**
 * In-memory gateway adapters — compatibility surface.
 *
 * A zero-backend implementation of the gateway ports so core application
 * services can be unit-tested (or run the browser demo) without a Tauri
 * bridge. It mirrors the Rust `encode_rel_path` keying and adds **controllable
 * failure + event simulation** so tests can exercise:
 *
 *  - *errors*: an injected `fail` map makes a named FS command reject.
 *  - *timeout*: an injected `delayMs` postpones every FS call (drive with fake
 *    timers to model a slow backend or a timed-out operation).
 *  - *cancellation*: `onFsChange` returns an unsubscribe; an emitted `fs-change`
 *    after cancelling is not delivered. The shared `events` port also drives the
 *    AI lifecycle stream so a stream can be cancelled mid-flight.
 *  - *fs-change events*: `events.emit('fs-change', { path, kind })` fans out to
 *    every current `onFsChange` subscriber.
 *
 * Every adapter is a pure closure over its own state — creating two gateways
 * yields two independent stores, so tests never leak state across instances.
 *
 * The implementation is one module per contract, so a reader can take in a
 * single port without holding the other four in their head:
 *
 *  - `memoryFs.ts`          the vault: notes, trash, history, listing
 *  - `memoryAttachments.ts` the fs gateway's attachment area
 *  - `memoryDialogs.ts`     DialogPort
 *  - `memoryAi.ts`          AiPort
 *  - `memoryKeys.ts`        KeyPort
 *  - `memoryFaults.ts`      the delay/fail policy the adapters share
 *  - `memoryPickedFiles.ts` the demo's picked-file registry (module-scope state)
 *
 * The names below are listed explicitly rather than `export *`ing the modules:
 * this file is imported by path across the suite, so what it offers is a
 * contract. A name dropped here is a failing typecheck rather than a silent
 * absence, and a helper that only the new modules share cannot leak into the
 * surface by accident.
 */

export { createMemoryFsGateway, memoryFsGateway } from './memory-fs'
export type { MemoryFsOptions } from './memory-fs'

/** Queue / drop the files the demo's image picker hands back. */
export { seedMemoryPickedFiles, resetMemoryPickedFiles } from './memory-picked-files'

export { createMemoryAiGateway, memoryAiGateway } from './memory-ai'
export type { MemoryAiOptions } from './memory-ai'

export { memoryKeyPort } from './memory-keys'

/** A dialog-port view over a (combined) memory FS gateway. */
export { createMemoryDialogPort } from './memory-dialogs'

/** Re-export so createGateways and tests can address the same event bus. */
export { createMemoryEventAdapter } from '../events/memory-event-adapter'
