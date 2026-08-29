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
