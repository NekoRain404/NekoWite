/**
 * The pet's assembly point (§10.1), and the one thing it must not do.
 *
 * Two claims, and the second is the reason the first is written as a branch rather than as a
 * default: the composition returns the real adapter in a Tauri window, and it returns *nothing*
 * anywhere else. The alternative — falling back to D1's in-memory double, the way
 * `agent-composition.ts` falls back to the ACP double — would give every window a pet whose tasks
 * came from a fixture, and a fixture-backed window is indistinguishable from a working one. §7.1's
 * isolation clause exists because that failure is invisible.
 *
 * The third suite is the menu routing: three actions, two of which are host calls and one of which
 * is the window's own surface. That distinction is the whole reason `actOnPetMenu` returns an
 * outcome instead of `void`.
 *
 * The second suite is the drag, and it covers **both** of the pet's windows: the ball has had the
 * platform since the permission landed, and the character window asks for the same one now that
 * its sprite is a drag handle (`DesktopPetRoot.vue`). What is asserted here is the composition's
 * half — that a window with a host is handed a real `startDrag` and a window without one is handed
 * nothing — because whether the *page* calls it is the component's own evidence, in
 * `DesktopPetRoot.drag.test.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { PetFeatureState, PetGateway, PetTaskProjection } from '../platform/gateways/pet-contracts'
import type { PetHostConnection } from '../platform/gateways/tauri-pet'

/** A window that is not the app's, or one that is — the flag the composition branches on. */
function setHost(present: boolean): void {
  const scope = window as { __TAURI_INTERNALS__?: unknown }
  if (present) scope.__TAURI_INTERNALS__ = {}
  else delete scope.__TAURI_INTERNALS__
}

/** A fresh module per test, because the composition caches its connection per window. */
async function composition(): Promise<typeof import('./desktop-pet-composition')> {
  const { vi } = await import('vitest')
  vi.resetModules()
  return import('./desktop-pet-composition')
}

afterEach(() => setHost(false))

describe('the pet runs on the host or on nothing', () => {
  it('builds the real adapter inside a Tauri window', async () => {
    setHost(true)
    const { createDesktopPetConnection, resolveDesktopPetDependencies } = await composition()

    const connection = createDesktopPetConnection()

    expect(connection).not.toBeNull()
    // One connection per window, not one per call: a settings section remounting must not build a
    // second host connection, and the adapter is the object the section is handed.
    expect(createDesktopPetConnection()).toBe(connection)
    // The dependencies carry the connection itself — one object, which the root hands to its
    // lifecycle as a `PetGateway` and to its own wiring as the wider surface. A `{ gateway }` here
    // would be a second field for the same value, and the entry would have to pass it twice. The
    // second field is the desktop's drag, asserted by name below so this stays an exact shape: a
    // third key added here would fail this line, which is the review the dependency object wants.
    const dependencies = resolveDesktopPetDependencies()
    expect(dependencies).toEqual({ connection, platform: expect.anything() })
    expect(typeof dependencies?.platform?.startDrag).toBe('function')
  })

  it('answers nothing at all where there is no host', async () => {
    setHost(false)
    const { createDesktopPetConnection, resolveDesktopPetDependencies } = await composition()

    // Not `createMemoryPetGateway()`: this is the assertion that keeps a browser build and a test
    // runner from being handed a pet that looks alive. The window states the absence instead.
    expect(createDesktopPetConnection()).toBeNull()
    expect(resolveDesktopPetDependencies()).toBeUndefined()
  })
})

describe('the drag, and where it comes from', () => {
  it('hands the ball window a platform, built on the app’s own window controls', async () => {
    setHost(true)
    const { resolveDesktopPetBallDependencies } = await composition()

    const dependencies = resolveDesktopPetBallDependencies()

    // §7.2's 「不伪装已支持」 read the other way: an object that exists is one whose method *does*
    // something, and this one calls `startDragging` on the window that asked. The orb reads that
    // presence to choose between 「Drag to move」 and 「This desktop cannot move it」.
    expect(typeof dependencies?.platform?.startDrag).toBe('function')
    // And no `snap`: the port says absent is "this desktop cannot do it", and the permission that
    // would let it park the ball is not one this build holds (see the capability file's note).
    expect(dependencies?.platform?.snap).toBeUndefined()
  })

  it('hands the ball window nothing where there is no host', async () => {
    setHost(false)
    const { resolveDesktopPetBallDependencies } = await composition()

    // Not a platform whose methods resolve and move nothing: a browser page has no window to drag,
    // and the orb says so rather than looking movable.
    expect(resolveDesktopPetBallDependencies()).toBeUndefined()
  })

  it('hands the character window the same drag the ball gets, and nothing more', async () => {
    setHost(true)
    const { resolveDesktopPetDependencies, resolveDesktopPetBallDependencies } =
      await composition()

    const character = resolveDesktopPetDependencies()?.platform
    const ball = resolveDesktopPetBallDependencies()?.platform

    // One adapter, two windows: `createBallPlatform` reads the window the page runs in, which is
    // the same question whichever of the pet's pages is asking. What the character window gains
    // with it is the drag on the sprite — `DesktopPetRoot.vue` mounts the same
    // `createBallGesture` the orb does — and the evidence that it is mounted is in that
    // component's own suite, not here.
    expect(typeof character?.startDrag).toBe('function')
    expect(character?.snap).toBe(ball?.snap)
    // The whole point of the two resolvers handing over the same shape: nothing here grew a
    // position, a geometry or a monitor read on the way to a drag that the compositor owns.
    expect(Object.keys(character ?? {})).toEqual(['startDrag'])
  })

  it('hands the character window nothing where there is no host', async () => {
    setHost(false)
    const { resolveDesktopPetDependencies } = await composition()

    // The same absence read from the other resolver: no platform means the sprite is not a drag
    // handle, so it has no `grab` cursor and no 「Drag to move」 — and, because `dragHandle` is one
    // of the terms the input region is computed from, the window keeps the pass-through it had.
    expect(resolveDesktopPetDependencies()).toBeUndefined()
  })
})

describe('what a menu item does', () => {
  /** The connection's gateway half is all `actOnPetMenu` is allowed to reach. */
  class RecordingGateway implements PetGateway {
    readonly calls: string[] = []

    async feature(): Promise<PetFeatureState> {
      return { enabled: true, visible: true }
    }

    async setVisible(visible: boolean): Promise<PetFeatureState> {
      this.calls.push(`setVisible:${visible}`)
      return { enabled: true, visible }
    }

    async capabilities() {
      return []
    }

    async care(): Promise<never> {
      throw new Error('a menu item does not read the care ledger')
    }

    async tasks(): Promise<PetTaskProjection[]> {
      return []
    }

    async subscribe(): Promise<() => void> {
      return () => {}
    }

    async subscribeFeature(): Promise<() => void> {
      return () => {}
    }

    // One of the four calls `PetGateway` gained when the window's own surface landed. A menu item
    // reaches none of them — §4's three actions are `openSettings`, `setVisible` and the list this
    // window draws — so a call here is a wiring mistake rather than a state to model.
    async appearance(): Promise<never> {
      throw new Error('a menu item does not read the appearance')
    }

    async library(): Promise<never> {
      throw new Error('a menu item does not read the character library')
    }

    async importCharacter(): Promise<never> {
      throw new Error('a menu item does not import characters')
    }

    async catalogue(): Promise<never> {
      throw new Error('a menu item does not read the character catalogue')
    }

    async adoptCharacter(): Promise<never> {
      throw new Error('a menu item does not download a character')
    }

    async openTask(): Promise<never> {
      throw new Error('a menu item does not route a task')
    }

    async readSettings(): Promise<never> {
      throw new Error('a menu item does not read settings')
    }

    async updateSettings(): Promise<never> {
      throw new Error('a menu item does not write settings')
    }

    async openSettings(page: string): Promise<void> {
      this.calls.push(`openSettings:${page}`)
    }
  }

  function connectionOf(gateway: RecordingGateway): PetHostConnection {
    // The five lifecycle operations are not reachable from a menu item; a connection that had them
    // is deliberately not what this suite hands over — the point is that `actOnPetMenu` asks for
    // the narrow interface.
    return gateway as unknown as PetHostConnection
  }

  it('raises the main window on the page the menu named', async () => {
    const { actOnDesktopPetMenu } = await composition()
    const gateway = new RecordingGateway()

    const outcome = await actOnDesktopPetMenu(connectionOf(gateway), {
      id: 'settings',
      page: 'character',
    })

    // §5.1: the page travels with the action, so the composition never guesses which page was
    // meant, and the host raises the main window itself rather than this window finding one.
    expect(outcome).toBe('host')
    expect(gateway.calls).toEqual(['openSettings:character'])
  })

  it('hides rather than disables, and keeps the host as the authority', async () => {
    const { actOnDesktopPetMenu } = await composition()
    const gateway = new RecordingGateway()

    const outcome = await actOnDesktopPetMenu(connectionOf(gateway), { id: 'hide' })

    // §7.1: hiding stops the drawing and keeps the reminder. The window does not decide it is
    // hidden — the host answers with the state it ended up in, and the lifecycle believes that.
    expect(outcome).toBe('host')
    expect(gateway.calls).toEqual(['setVisible:false'])
  })

  it('leaves the window’s own surface to the window', async () => {
    const { actOnDesktopPetMenu } = await composition()
    const gateway = new RecordingGateway()

    const outcome = await actOnDesktopPetMenu(connectionOf(gateway), { id: 'tasks' })

    // The task list is drawn by this window, so there is no call to make and the answer says so.
    // A `void` return would make this case indistinguishable from the two above having quietly
    // done nothing.
    expect(outcome).toBe('window')
    expect(gateway.calls).toEqual([])
  })
})
