/**
 * The ball's drag, against the window controls rather than a real window.
 *
 * Two claims, and the second is the one that keeps the orb's tooltip honest: `startDrag` asks the
 * window that owns the gesture to drag itself, and `snap` is *absent* rather than present and
 * inert — the port's own rule (`pet-ball-input.ts`: "a desktop that cannot do one of them does not
 * implement it, which is a stronger statement than a method that returns nothing").
 *
 * `platform/window.ts` is the only module in this app that touches the Tauri window API, so what
 * this suite substitutes is the same narrow control surface the product passes — not a smaller
 * shape written to make the test easy.
 */
import { describe, expect, it } from 'vitest'
import type { WindowControls } from '../../../platform/window'
import { createBallPlatform } from './pet-ball-platform'

/** The window controls, with the calls this file may make recorded and the rest refused. */
function controls(): WindowControls & { calls: string[] } {
  const calls: string[] = []
  const refuse = (name: string) => async (): Promise<never> => {
    throw new Error(`the ball's drag reached ${name}`)
  }
  return {
    calls,
    isMaximized: () => Promise.resolve(false),
    minimize: refuse('minimize'),
    toggleMaximize: refuse('toggleMaximize'),
    close: refuse('close'),
    destroy: refuse('destroy'),
    startDragging: () => {
      calls.push('startDragging')
      return Promise.resolve()
    },
    onResized: refuse('onResized'),
  }
}

describe('the ball’s platform is the drag and nothing else', () => {
  it('asks the window to start dragging, once per call', async () => {
    const window = controls()
    const platform = createBallPlatform(window)

    await platform.startDrag?.()
    await platform.startDrag?.()

    // One call per gesture: the compositor owns the pointer from here, so a drag costs one IPC
    // call and a resolve rather than a position update per event (§7.3).
    expect(window.calls).toEqual(['startDragging', 'startDragging'])
  })

  it('has no snap, which is a state the orb states rather than a method that does nothing', () => {
    const platform = createBallPlatform(controls())
    expect(platform.snap).toBeUndefined()
  })

  it('resolves only when the operating-system drag is over', async () => {
    // The orb's `endDrag` waits on this promise before it clears the dragging state, so a platform
    // that resolved early would leave the orb looking idle mid-drag and a snap (when there is one)
    // running while the compositor still holds the window.
    const deferred: { finish?: () => void } = {}
    const pending = new Promise<void>((resolve) => {
      deferred.finish = resolve
    })
    const window = controls()
    window.startDragging = () => pending
    const platform = createBallPlatform(window)

    let resolved = false
    const drag = platform.startDrag?.().then(() => {
      resolved = true
    })
    await Promise.resolve()
    expect(resolved).toBe(false)

    deferred.finish?.()
    await drag
    expect(resolved).toBe(true)
  })
})
