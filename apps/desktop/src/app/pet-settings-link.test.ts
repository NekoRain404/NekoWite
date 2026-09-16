/**
 * The receiving half of §5.1's 设置定位, without a window or a dialog.
 *
 * The three rules in the module's own header are the three things that can be wrong here, and each
 * is a bug the obvious version has: a listener that lives as long as the dialog (and so never hears
 * the request it exists for), a request that is never consumed (and so moves the settings gear for
 * the rest of the session), a registration that is never released. The platform adapter is mocked
 * rather than the Tauri API: `onPetSettingsRequest` has its own suite, and this one is about what
 * the shell's policy does with an answer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App as VueApp, type Ref } from 'vue'
import { attachPetSettingsLink } from './pet-settings-link'
import { PET_SETTINGS_SECTION } from '../platform/gateways/pet-contracts'
import type { SettingsOpenTarget } from '../features/settings'

const platform = vi.hoisted(() => ({ onPetSettingsRequest: vi.fn() }))
vi.mock('../platform/pet-settings-request', () => ({
  onPetSettingsRequest: platform.onPetSettingsRequest,
}))

let mounted: VueApp[] = []
/** The ref the last mount handed out — the same object the shell binds to the dialog. */
const handed: { target: Ref<SettingsOpenTarget | null> | null } = { target: null }

/** What that ref holds, or `null` where nothing has been attached yet. */
function target(): SettingsOpenTarget | null {
  return handed.target ? handed.target.value : null
}

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
  platform.onPetSettingsRequest.mockReset()
})

function mount(inputs: { open: () => boolean; onOpen: () => void }): void {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({
    setup() {
      // The same ref the shell binds to the dialog, kept so a test can read what the link decided.
      handed.target = attachPetSettingsLink(inputs).target
      return () => null
    },
  })
  app.mount(host)
  mounted.push(app)
}

/**
 * One registration, held open until the test resolves it.
 *
 * `listen` resolves after an await, so the interesting states are "registered", "not yet
 * registered" and "the window went away before it resolved" — and a mock that resolves
 * immediately makes the third one unreachable.
 */
function registration(): {
  release: ReturnType<typeof vi.fn>
  settle: () => Promise<void>
  deliver: (page: string) => void
} {
  const release = vi.fn()
  let deliver: (page: string) => void = () => {
    throw new Error('nothing was delivered: the registration did not resolve')
  }
  let finish = (): void => {}
  platform.onPetSettingsRequest.mockImplementation(
    (cb: (page: string) => void) =>
      new Promise<() => void>((done) => {
        deliver = cb
        finish = () => done(release)
      }),
  )
  return {
    release,
    deliver: (page) => deliver(page),
    settle: async () => {
      finish()
      await nextTick()
    },
  }
}

function unmountAll(): void {
  mounted.forEach((app) => app.unmount())
  mounted = []
}

describe('the pet’s settings link', () => {
  it('turns a request into the pet’s section and asks for the dialog', async () => {
    const host = registration()
    const onOpen = vi.fn()
    mount({ open: () => false, onOpen })
    await nextTick()
    await host.settle()

    expect(platform.onPetSettingsRequest).toHaveBeenCalledTimes(1)
    expect(target()).toBeNull()

    host.deliver('care')
    await nextTick()
    // The payload is a page; the section is named here, by D1's constant, and nowhere else.
    expect(target()).toEqual({ section: PET_SETTINGS_SECTION, page: 'care' })
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('releases the listener when the window goes away', async () => {
    const host = registration()
    mount({ open: () => false, onOpen: vi.fn() })
    await nextTick()
    await host.settle()

    unmountAll()

    expect(host.release).toHaveBeenCalledTimes(1)
  })

  it('releases a registration that was still in flight when the window went away', async () => {
    const host = registration()
    mount({ open: () => false, onOpen: vi.fn() })
    await nextTick()

    // Unmounted before `listen` resolved: the release arrives afterwards, and nobody is left to
    // hold it — which is the whole reason the flag exists.
    unmountAll()
    await host.settle()

    expect(host.release).toHaveBeenCalledTimes(1)
  })

  it('forgets the request once the dialog it opened is gone', async () => {
    const host = registration()
    const open = ref(false)
    mount({
      open: () => open.value,
      onOpen: () => {
        open.value = true
      },
    })
    await nextTick()
    await host.settle()

    host.deliver('care')
    await nextTick()
    expect(open.value).toBe(true)
    expect(target()).toEqual({ section: PET_SETTINGS_SECTION, page: 'care' })

    // Closed by the user. The next mount is the gear's, and it opens where it always opened.
    open.value = false
    await nextTick()
    expect(target()).toBeNull()

    // And a second right-click is answered the same way as the first.
    host.deliver('bubble')
    await nextTick()
    expect(target()).toEqual({ section: PET_SETTINGS_SECTION, page: 'bubble' })
  })
})
