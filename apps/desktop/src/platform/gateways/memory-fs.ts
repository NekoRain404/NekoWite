/**
 * The in-memory filesystem gateway — the composition root.
 *
 * A zero-backend implementation of the fs port (plus the dialog methods it
 * carries as the combined {@link FsGateway}) so core application services can
 * be unit-tested — or run the browser demo — without a Tauri bridge. It mirrors
 * the Rust `encode_rel_path` keying.
 *
 * The vault's state is declared here and the areas that operate on it are
 * composed in, one module per concern, so a reader can take in a single one
 * without holding the others in their head:
 *
 *  - `memory-file-ops.ts`    reading, writing, stating, the listing, mkdir
 *  - `memory-trash.ts`       deleting, listing, restoring, emptying
 *  - `memory-history.ts`     the snapshots a write keeps of what it replaced
 *  - `memory-attachments.ts` the attachment bytes and their media URLs
 *  - `memory-dialogs.ts`     the (simulated) native dialogs
 *
 * `renameEntry` is the one operation no area owns: a rename has to carry every
 * per-path structure the vault keeps, so it stays where all of them are in
 * scope. The fault/delay simulation is applied to the assembled gateway by
 * `withBehavior` below (the policy itself is `memoryFaults.ts`).
 *
 * The gateway is a pure closure over its own state — creating two gateways
 * yields two independent stores, so tests never leak state across instances.
 * The one piece of state with a wider lifetime is the demo pick registry
 * (`memory-picked-files.ts`), which is deliberately module-scope.
 */

import type { EventPort, FsChangeEvent, FsGateway } from './contracts'
import { createMemoryEventAdapter } from '../events/memory-event-adapter'
import { memoryDialogPort } from './memory-dialogs'
import { createAttachmentArea } from './memory-attachments'
import { simulateCall, type MemoryFault } from './memory-faults'
import { createFileOpsArea } from './memory-file-ops'
import { createTrashArea, type TrashItem } from './memory-trash'
import { createHistoryArea, type Snapshot } from './memory-history'

const DEFAULT_SEED: Record<string, string> = {
  'welcome.md':
    '# Welcome to NekoWite (demo)\n\nThis is the in-browser demo vault.',
}

/** Tuning knobs for the memory FS adapter's controllable-failure simulation. */
export interface MemoryFsOptions {
  /** Fail every call to the named method (e.g. `read`, `write`, `stat`). The
   * value is a static error or a factory that builds a fresh error each call. */
  fail?: Record<string, Error | (() => Error)>
  /** Artificial latency (ms) before every FS call settles, simulating a slow
   * backend or a timed-out operation. */
  delayMs?: number
  /** Shared event bus. When supplied, `onFsChange` subscribes to it and a test
   * can simulate `fs-change` events by emitting on the same port. */
  events?: EventPort
}

/** Wrap a built gateway so every method honors `fail`/`delayMs` first, keeping
 * the base implementation itself free of failure-injection concerns. */
function withBehavior(base: FsGateway, opts: MemoryFsOptions): FsGateway {
  if (!opts.fail && !opts.delayMs) return base
  const out = { ...base } as FsGateway
  for (const key of Object.keys(base) as (keyof FsGateway)[]) {
    const fn = base[key] as (...a: unknown[]) => unknown
    const fault: MemoryFault = { fail: opts.fail?.[key], delayMs: opts.delayMs }
    ;(out as Record<keyof FsGateway, (...a: unknown[]) => unknown>)[key] = (...a) =>
      simulateCall(fault, () => fn(...a))
  }
  return out
}

export function createMemoryFsGateway(
  seed: Record<string, string> = DEFAULT_SEED,
  opts: MemoryFsOptions = {},
): FsGateway {
  const files = new Map(Object.entries(seed))
  const attachments = new Map<string, string>()
  const virtualDirs = new Set<string>()
  const history = new Map<string, Snapshot[]>()
  const trash = new Map<string, TrashItem>()
  const modified = new Map<string, number>()
  // The shared event bus drives simulated fs-change events. When the caller
  // hands one in (as createGateways does) `onFsChange` shares it with the rest
  // of the runtime; otherwise a private bus is created.
  const events = opts.events ?? createMemoryEventAdapter()

  // `snapshot` is the history area's write-side entry point, not a port member:
  // the file area takes it directly and it is kept off the gateway below, so a
  // caller cannot mistake it for a command and `withBehavior` cannot wrap it as
  // one.
  const { snapshot, ...historyOps } = createHistoryArea({ files, history })

  const base: FsGateway = {
    // The note key space and the listing derived from it, the trash a delete
    // parks in, and the history a write snapshots into — three areas over the
    // same maps.
    ...createFileOpsArea({ files, virtualDirs, modified, snapshot }),
    ...createTrashArea({ files, trash }),
    ...historyOps,
    // The dialog members the combined gateway carries: simulated native
    // dialogs (see memory-dialogs.ts).
    ...memoryDialogPort,
    // Simulated fs-change subscription: emit on the shared event bus to fire it.
    onFsChange: (cb) => events.on<FsChangeEvent>('fs-change', cb),
    // Attachment bytes: same vault, one area (see memory-attachments.ts).
    ...createAttachmentArea({ files, attachments, modified }),
    // A rename moves the whole of a path, so it is the one operation written
    // where every map is in scope: the key itself, the virtual directory, the
    // attachment bytes, the history snapshots and the write time are all keyed
    // by the path that changed, and a move that carried only some of them would
    // leave the vault describing a file that is no longer there.
    renameEntry: async (_vault, from, to) => {
      const fromClean = from.replace(/^\/+|\/+$/g, '')
      const toClean = to.replace(/^\/+|\/+$/g, '')
      if (toClean === '' || toClean.split('/').some((seg) => seg === '.' || seg === '..')) {
        throw new Error(`Invalid target path: ${to}`)
      }
      const isDirMove = (key: string): boolean =>
        key === fromClean || key.startsWith(`${fromClean}/`)
      const moved: Array<[string, string]> = []
      for (const key of files.keys()) {
        if (isDirMove(key)) {
          const next = toClean + key.slice(fromClean.length)
          if (files.has(next)) {
            throw new Error(`Target already exists: ${next}`)
          }
          moved.push([key, next])
        }
      }
      if (moved.length === 0) {
        throw new Error(`Not found in demo vault: ${from}`)
      }
      for (const dir of [...virtualDirs]) {
        if (isDirMove(dir)) {
          virtualDirs.delete(dir)
          virtualDirs.add(toClean + dir.slice(fromClean.length))
        }
      }
      for (const [key, next] of moved) {
        files.set(next, files.get(key) ?? '')
        if (attachments.has(key)) {
          attachments.set(next, attachments.get(key) ?? '')
          attachments.delete(key)
        }
        files.delete(key)
      }
      for (const [key, next] of moved) {
        const snaps = history.get(key)
        if (snaps) {
          history.set(next, snaps)
          history.delete(key)
        }
        const mtime = modified.get(key)
        if (mtime !== undefined) {
          modified.set(next, mtime)
          modified.delete(key)
        }
      }
      return toClean
    },
  }

  return withBehavior(base, opts)
}

export const memoryFsGateway = createMemoryFsGateway()
