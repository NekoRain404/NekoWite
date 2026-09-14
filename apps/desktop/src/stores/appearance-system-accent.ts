/**
 * The system accent read: the one piece of appearance the web layer cannot
 * answer for itself.
 *
 * The OS colour arrives through a port rather than being fetched here, so this
 * module imports no Tauri API and a test can answer - or fail - without a
 * registry. The answer is cached in a ref because `effectiveAccent()` has to
 * stay synchronous (the app shell reads it from a computed): the read is
 * best-effort and asynchronous, and a failure is not an error state, it is the
 * fallback the UI reports through `state`.
 */

import { ref } from 'vue'
import type { Rgb } from './appearance-palette'

/** How far the OS accent read got. `unavailable` is a normal outcome on a
 *  platform without such a colour (or a registry the app may not read), and the
 *  settings panel says so rather than implying the system colour was used. */
export type SystemAccentState = 'unknown' | 'read' | 'unavailable'

/** The platform read (`platform/systemAccent`), injected at construction. */
export interface SystemAccentReadPort {
  (): Promise<Rgb | null>
}

export interface SystemAccentReaderDeps {
  read: SystemAccentReadPort
}

export function createSystemAccentReader(deps: SystemAccentReaderDeps) {
  const { read } = deps
  const accent = ref<Rgb | null>(null)
  const state = ref<SystemAccentState>('unknown')

  /** Read the OS accent colour into `accent` and record how that went. */
  async function refresh(): Promise<void> {
    let rgb: Rgb | null = null
    try {
      rgb = await read()
    } catch {
      // The adapter answers `null` for every failure it knows about, so a throw
      // here is a defect in it - but the call is fire-and-forget, and an
      // unhandled rejection would be worse than the honest 'unavailable'.
      rgb = null
    }
    // Copied field by field: the adapter's answer must not stay live behind the
    // ref, where a later mutation of it would move the accent unnoticed.
    accent.value = rgb ? { r: rgb.r, g: rgb.g, b: rgb.b } : null
    state.value = rgb ? 'read' : 'unavailable'
  }

  return { accent, state, refresh }
}

export type SystemAccentReader = ReturnType<typeof createSystemAccentReader>
