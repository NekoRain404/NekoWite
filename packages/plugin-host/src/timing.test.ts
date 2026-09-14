import { describe, expect, it } from 'vitest'
import { withTimeout } from './timing'
import { PluginError } from './types'

/** An AbortSignal-shaped stub that counts its listeners. The real one gives no
 *  way to ask how many are attached, and the leak this pins is exactly a
 *  registration nobody can reach to remove. */
function countingSignal(): { signal: AbortSignal; attached: () => number } {
  const listeners = new Set<() => void>()
  return {
    signal: {
      aborted: false,
      addEventListener: (_type: string, cb: () => void) => {
        listeners.add(cb)
      },
      removeEventListener: (_type: string, cb: () => void) => {
        listeners.delete(cb)
      },
    } as unknown as AbortSignal,
    attached: () => listeners.size,
  }
}

describe('withTimeout', () => {
  it('detaches the abort listener when the timer wins', async () => {
    // The plugin's promise is left pending forever after a timeout, so the paths
    // that remove the listener (settle/abort) never run. The caller's one signal
    // is reused across every hook of a vault scan, so the listeners accumulate.
    const counted = countingSignal()
    const never = new Promise<void>(() => {})
    await expect(withTimeout(never, 5, { signal: counted.signal })).rejects.toBeInstanceOf(PluginError)
    expect(counted.attached()).toBe(0)
  })

  it('still detaches when the promise settles first', async () => {
    const counted = countingSignal()
    await expect(withTimeout(Promise.resolve('ok'), 50, { signal: counted.signal })).resolves.toBe('ok')
    expect(counted.attached()).toBe(0)
  })

  it('rejects with PLUGIN_ABORTED when the signal fires first', async () => {
    const controller = new AbortController()
    const never = new Promise<void>(() => {})
    const pending = withTimeout(never, 1000, { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'PLUGIN_ABORTED' })
  })
})
