import type { AppGateways } from './contracts'
import { tauriAiGateway, tauriFsGateway, tauriKeyGateway } from './tauri'
import { memoryAiGateway, memoryFsGateway, memoryKeyGateway } from './memory'

let cached: AppGateways | null = null

export function getGateways(): AppGateways {
  if (!cached) {
    const tauri =
      typeof window !== 'undefined' && Boolean((window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
    cached = tauri
      ? { fs: tauriFsGateway, ai: tauriAiGateway, keys: tauriKeyGateway }
      : { fs: memoryFsGateway, ai: memoryAiGateway, keys: memoryKeyGateway }
  }
  return cached
}
