import { t } from '../i18n'

export type ConflictDecision = 'reload' | 'keep' | 'ask' | 'none'

export function decideConflict(input: { dirty: boolean; hasDiskChange: boolean }): ConflictDecision {
  if (!input.hasDiskChange) return 'none'
  if (!input.dirty) return 'reload'
  return 'ask'
}

const listeners = new Set<(msg: string) => void>()

export function notifyError(message: string): void {
  listeners.forEach((l) => l(message))
}

export function onNotify(cb: (msg: string) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export interface RecoveryPrompt {
  message: string
  onRestore: () => void
  onDismiss: () => void
}

const recoveryListeners = new Set<(p: RecoveryPrompt) => void>()

export function notifyRecovery(p: RecoveryPrompt): void {
  recoveryListeners.forEach((l) => l(p))
}

export function onRecovery(cb: (p: RecoveryPrompt) => void): () => void {
  recoveryListeners.add(cb)
  return () => recoveryListeners.delete(cb)
}

// Normalize export failures for display. The Tauri write command rejects
// with the raw Rust error string, e.g. "path escapes vault" when the save
// dialog returned a path outside the vault; map that to a user-facing hint.
export function describeExportError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  if (msg.includes('path escapes vault')) return t('error.exportOutsideVault')
  return t('error.exportFailed', { msg })
}
