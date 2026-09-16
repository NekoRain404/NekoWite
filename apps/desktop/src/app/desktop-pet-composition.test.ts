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
    expect(resolveDesktopPetDependencies()).toEqual({ gateway: connection })
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
