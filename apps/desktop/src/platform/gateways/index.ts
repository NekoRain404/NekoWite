/**
 * Gateway composition.
 *
 * `createGateways(deps)` builds an {@link AppGateways} from the port adapters,
 * wiring the fs, dialog, event, AI and key ports together. It is a pure factory
 * — it holds no global cache. The single shared/cached instance is owned by the
 * runtime layer (`platform/runtime`), which the app bootstrap initializes so it
 * can be injected into app services.
 */

import { createMemoryEventAdapter } from '../events/memoryEventAdapter'
import { createTauriEventAdapter } from '../events/tauriEventAdapter'
import type {
  AppGateways,
  FsChangeEvent,
  FsGateway,
} from './contracts'
import { tauriAiPort, tauriDialogPort, tauriFsPort, tauriKeyPort } from './tauri'
import {
  createMemoryAiGateway,
  createMemoryDialogPort,
  createMemoryFsGateway,
  memoryKeyPort,
  type MemoryFsOptions,
} from './memory'

export interface GatewayDeps {
  /** Force a specific environment. Defaults to autodetection from the presence
   * of `window.__TAURI_INTERNALS__`. */
  environment?: 'tauri' | 'browser'
  /** Memory-adapter tuning, used when the environment is `'browser'`. */
  memory?: MemoryFsOptions
}

function detectEnvironment(): 'tauri' | 'browser' {
  const hasTauri =
    typeof window !== 'undefined' &&
    Boolean((window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
  return hasTauri ? 'tauri' : 'browser'
}

function tauriCombinedFs(events: ReturnType<typeof createTauriEventAdapter>): FsGateway {
  return {
    ...tauriFsPort,
    ...tauriDialogPort,
    onFsChange: (cb) => events.on<FsChangeEvent>('fs-change', cb),
  }
}

export function createGateways(deps: GatewayDeps = {}): AppGateways {
  const environment = deps.environment ?? detectEnvironment()

  if (environment === 'tauri') {
    const events = createTauriEventAdapter()
    return {
      fs: tauriCombinedFs(events),
      dialogs: tauriDialogPort,
      events,
      ai: tauriAiPort,
      keys: tauriKeyPort,
    }
  }

  const events = createMemoryEventAdapter()
  const fs = createMemoryFsGateway(undefined, { ...deps.memory, events })
  return {
    fs,
    dialogs: createMemoryDialogPort(fs),
    events,
    ai: createMemoryAiGateway(),
    keys: memoryKeyPort,
  }
}

export type { AppGateways, FsGateway }
