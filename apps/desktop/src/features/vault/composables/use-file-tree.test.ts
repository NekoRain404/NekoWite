import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, ref, type App as VueApp, type Ref } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import type { FileEntry } from '../../../platform/gateways/fs'

/**
 * The fs gateway is modelled on the TAURI adapter here on purpose: every
 * `onFsChange` call installs its own registration with its own backend id, so
 * two subscriptions are two live listeners and releasing one leaves the other.
 * The memory adapter folds a duplicate `on` into the first by callback
 * identity, which is exactly why this class of leak was invisible to the suite.
 */
const h = vi.hoisted(() => {
  const listings: { promise: Promise<FileEntry[]>; resolve: (e: FileEntry[]) => void }[] = []
  const live = new Set<number>()
  const state = { nextId: 0, listMock: vi.fn(), onFsChangeMock: vi.fn() }
  return { listings, live, state }
})

vi.mock('../../../platform/gateways/fs', () => ({
  fsService: {
    list: h.state.listMock,
    onFsChange: h.state.onFsChangeMock,
    read: vi.fn(),
    write: vi.fn(),
    watch: vi.fn(),
    deleteFile: vi.fn(),
    stat: vi.fn(),
    createDir: vi.fn(),
    listHistory: vi.fn(),
    readHistory: vi.fn(),
    onFsChangeLegacy: vi.fn(),
  },
}))

import { useFileTree } from './use-file-tree'

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

const liveListeners = (): number => h.live.size

/** A listing whose settlement the test controls, handed to the next `list`. */
function pendingListing(): Promise<FileEntry[]> {
  let resolve: (entries: FileEntry[]) => void = () => {}
  const promise = new Promise<FileEntry[]>((r) => {
    resolve = r
  })
  h.listings.push({ promise, resolve })
  return promise
}

let pinia: Pinia
let mounted: VueApp[] = []
// `Ref<string>`, not `ReturnType<typeof ref<string>>`: the instantiation
// expression picks `ref`'s no-argument overload, so `ReturnType` resolved to
// `Ref<string | undefined>` while every assignment below is `ref('/vault-a')`.
let vault: Ref<string>

function mountTree(): void {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(
    defineComponent({
      setup() {
        useFileTree({ vault: () => vault.value })
        return () => null
      },
    }),
  )
  app.use(pinia)
  app.mount(host)
  mounted.push(app)
}

describe('useFileTree fs-change subscription', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    vault = ref('/vault-a')
    h.listings.length = 0
    h.live.clear()
    h.state.nextId = 0
    h.state.listMock.mockReset()
    h.state.onFsChangeMock.mockReset()
    h.state.listMock.mockImplementation(() => pendingListing())
    h.state.onFsChangeMock.mockImplementation(() => {
      const id = ++h.state.nextId
      h.live.add(id)
      return Promise.resolve(() => {
        h.live.delete(id)
      })
    })
    document.body.innerHTML = ''
    mounted = []
  })

  afterEach(() => {
    mounted.forEach((app) => app.unmount())
    mounted = []
    document.body.innerHTML = ''
  })

  /** `listMock` answers with the listing the test pushed for that call. */
  function resolveListing(index: number, entries: FileEntry[] = []): void {
    const slot = h.listings[index]
    expect(slot, `no pending listing #${index}`).toBeTruthy()
    slot.resolve(entries)
  }

  it('holds one live listener for the open vault after an overtaken switch', async () => {
    mountTree()
    await flush()
    resolveListing(0)
    await flush()
    expect(liveListeners()).toBe(1)

    // A → B, then B → C while B's listing is still in flight: B's continuation
    // is no longer the current vault's, so the listener it just registered must
    // be released by that continuation (nothing else can reach it).
    vault.value = '/vault-b'
    await flush()
    vault.value = '/vault-c'
    await flush()

    resolveListing(1)
    await flush()
    resolveListing(2)
    await flush()

    expect(liveListeners()).toBe(1)
  })

  it('releases the listener an unmount overtook', async () => {
    mountTree()
    await flush()

    // Leaving the Folders view during the first listing: `unlisten` is still
    // empty when the component unmounts, so the registration that lands
    // afterwards has to release itself.
    mounted[0].unmount()
    mounted = []

    resolveListing(0)
    await flush()

    expect(liveListeners()).toBe(0)
  })

  it('releases the previous vault’s listener before taking the new one', async () => {
    mountTree()
    await flush()
    resolveListing(0)
    await flush()
    expect(liveListeners()).toBe(1)

    vault.value = '/vault-b'
    await flush()
    resolveListing(1)
    await flush()

    expect(liveListeners()).toBe(1)
    expect(h.state.onFsChangeMock).toHaveBeenCalledTimes(2)
  })
})
