/**
 * The pet's real entry, end to end: a character chosen in the settings appears, and a finished
 * task reminds — both driven through the window the app actually opens.
 *
 * Everything below the assertions is the product: `mountDesktopPet` is the entry,
 * `createDesktopPetConnection` is the composition, `createTauriPetConnection` is the adapter, and
 * the only thing substituted is the transport — `@tauri-apps/api`'s `invoke`/`listen`, which is
 * where the backend begins. That substitution is deliberate and it is the strongest one available
 * here: a component test would assert that a prop draws, and what these cases are about is whether
 * the *page* ever receives that prop — which is the failure the audit found (an entry that passed
 * a gateway and nothing else) and the one no unit test could see.
 *
 * The two acceptance clauses, and the failure paths each of them has:
 *
 *  1. **A character chosen in the settings pages appears in the pet window.** The host answers
 *     `unset` on a fresh install, then the main window writes `character.characterId`, the host
 *     publishes the applied write on `pet-settings-changed`, and the window re-reads and draws the
 *     sheet. No character chosen, a character whose resources are gone, and a host that cannot
 *     answer the read are each their own state.
 *  2. **A task that reaches a terminal state produces a reminder, deduplicated, and clicking it
 *     returns to the right session.** The task arrives on `pet-task`, one row is drawn per run,
 *     the same run pushed twice is still one row, a click sends D1's `PetTaskKey` and nothing else
 *     to `desktop_pet_open_task` — and a task that arrives while the pet is hidden is there when it
 *     is shown again.
 *
 * `desktop_pet_tasks` failing is a case of its own: that is the break the audit reproduced, and
 * what makes it worth a test is that the *window* has to say so rather than look quiet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  PetAppearance,
  PetFeatureState,
  PetTaskKey,
  PetTaskProjection,
} from '../platform/gateways/pet-contracts'
import type { LoadableImage } from '../features/desktop-pet/rendering/sprite-sheet'
import type { SheetPixelReader } from '../features/desktop-pet/rendering/sprite-slicer'

// Every case here loads the window's whole module graph again (`vi.resetModules`) and mounts the
// real components, so the file is heavier than a unit suite: under a full parallel run the first
// case passed 1.3s on its own and timed out at the 5s default. The budget is raised here rather
// than the work reduced — the graph load *is* what these cases are about.
vi.setConfig({ testTimeout: 20_000 })

const invoke = vi.hoisted(() => vi.fn())
const listen = vi.hoisted(() => vi.fn())
/** The adapter converts a path the host granted; `${'asset://'}` is the URL the window then loads. */
const convertFileSrc = vi.hoisted(() =>
  vi.fn((path: string) => `asset://localhost/${encodeURIComponent(path)}`),
)

vi.mock('@tauri-apps/api/core', () => ({ invoke, convertFileSrc }))
vi.mock('@tauri-apps/api/event', () => ({ listen }))

/** The channels the window registered on, so a case can push a frame the way the host would. */
const channels = new Map<string, Set<(event: { payload: unknown }) => void>>()

function emit(channel: string, payload: unknown): void {
  for (const handler of channels.get(channel) ?? []) handler({ payload })
}

/** What the fake backend holds. Everything a case changes about the host lives here. */
interface Host {
  enabled: boolean
  visible: boolean
  appearance: PetAppearance
  tasks: PetTaskProjection[]
  /** The sentence `desktop_pet_tasks` rejects with, or null when it answers. */
  tasksRefusal: string | null
  openedTasks: PetTaskKey[]
}

function host(overrides: Partial<Host> = {}): Host {
  return {
    enabled: true,
    visible: true,
    appearance: { status: 'unset' },
    tasks: [],
    tasksRefusal: null,
    openedTasks: [],
    ...overrides,
  }
}

const CAT: PetTaskKey = {
  agentId: 'opencode',
  profileId: 'default',
  runtimeEpoch: 'epoch-1',
  vaultId: 'vault-a',
  sessionId: 'ses-1',
  runId: 'run-0',
}

function task(state: PetTaskProjection['state'], key: PetTaskKey = CAT): PetTaskProjection {
  return { key, state, permissionRequestId: null, updatedAt: Date.now() }
}

/** The commands this window may call, answered from `Host` — and nothing else is allowed. */
function serve(state: Host): void {
  invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    switch (command) {
      case 'desktop_pet_state':
        return { enabled: state.enabled, visible: state.enabled && state.visible }
      case 'desktop_pet_tasks':
        if (state.tasksRefusal !== null) throw new Error(state.tasksRefusal)
        return state.tasks
      case 'desktop_pet_appearance':
        return state.appearance
      case 'desktop_pet_open_task':
        state.openedTasks.push((args as { task: PetTaskKey }).task)
        return null
      default:
        throw new Error(`the pet window called ${command}, which this window has no business in`)
    }
  })
}

/** A sheet that loads, and pixels for it, so the sprite has something real to slice. */
const loaded: string[] = []

const createImage = (): LoadableImage => {
  const image: LoadableImage = {
    naturalWidth: 64,
    naturalHeight: 72,
    crossOrigin: null,
    src: '',
    onload: null,
    onerror: null,
  }
  Object.defineProperty(image, 'src', {
    set(value: string) {
      loaded.push(value)
      queueMicrotask(() => image.onload?.(new Event('load')))
    },
    get: () => '',
  })
  return image
}

/** Opaque pixels everywhere, so no frame is dropped for being empty (§7.2's 全透明图 case). */
const readPixels: SheetPixelReader = (_img, width, height) => ({
  width,
  height,
  data: new Uint8ClampedArray(width * height * 4).fill(255),
})

let mounted: { dispose(): void } | null = null

async function mountWindow(state: Host): Promise<void> {
  serve(state)
  ;(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
  // A fresh module graph per case: the composition caches one connection per window, and a test
  // that reused it would be reusing a window.
  vi.resetModules()
  const composition = await import('./desktop-pet-composition')
  const entry = await import('./desktop-pet-entry')
  const connection = composition.createDesktopPetConnection()
  expect(connection, 'the composition builds the real adapter in a Tauri window').not.toBeNull()

  document.body.innerHTML = `<div id="${entry.DESKTOP_PET_ROOT_ID}"></div>`
  mounted = entry.mountDesktopPet(document.getElementById(entry.DESKTOP_PET_ROOT_ID) as Element, {
    connection: connection as NonNullable<typeof connection>,
    sprite: { createImage, readPixels },
  })
  await flush()
}

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  for (let i = 0; i < times; i += 1) await Promise.resolve()
}

function notice(): string | null {
  return document.querySelector('.pet-root__notice')?.textContent?.trim() ?? null
}

beforeEach(() => {
  channels.clear()
  loaded.length = 0
  invoke.mockReset()
  convertFileSrc.mockClear()
  listen.mockImplementation(
    async (channel: string, handler: (event: { payload: unknown }) => void) => {
      const set = channels.get(channel) ?? new Set()
      set.add(handler)
      channels.set(channel, set)
      return () => set.delete(handler)
    },
  )
})

afterEach(() => {
  mounted?.dispose()
  mounted = null
  document.body.innerHTML = ''
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
})

describe('a character chosen in the settings pages appears in the pet window', () => {
  it('draws the sheet the host hands it once the character domain is written', async () => {
    const state = host()
    await mountWindow(state)

    // A fresh install: the window says so, and draws nothing.
    expect(notice()).toBe('No character is selected.')
    expect(document.querySelector('.pet-sprite')).toBeNull()

    // The main window writes the character and the host publishes the applied write — the same
    // frame `desktop_pet_update_settings` emits. Nothing here polls: one event, one read.
    state.appearance = {
      status: 'ready',
      characterId: 'kitty',
      name: 'Kitty',
      sheetPath: '/data/desktop-pet/characters/kitty/sheet.png',
      sheet: { columns: 8, rows: 9 },
      size: 160,
      bindings: {},
      idleClips: [],
      idleMode: 'random',
      idleIntervalMs: 5_000,
    }
    emit('pet-settings-changed', { domain: 'character', revision: 2 })
    await flush()

    expect(notice()).toBeNull()
    expect(document.querySelector('.pet-sprite')).not.toBeNull()
    // The path the host granted became an `asset://` URL, and the sprite loaded *that*: the one
    // chain that makes "chosen in the settings" and "drawn in the window" the same event.
    expect(loaded.some((url) => url.startsWith('asset://localhost/'))).toBe(true)
    expect(loaded.some((url) => url.includes('kitty'))).toBe(true)
  })

  it('states a character whose resources the library cannot produce', async () => {
    const state = host({
      appearance: {
        status: 'missing',
        characterId: 'kitty',
        detail: 'its spritesheet is not where the manifest says it is',
      },
    })
    await mountWindow(state)

    expect(notice()).toContain('kitty')
    expect(notice()).toContain('its spritesheet is not where the manifest says it is')
    expect(document.querySelector('.pet-sprite')).toBeNull()
  })

  it('states a host that could not answer the read, and not "nothing is chosen"', async () => {
    const state = host()
    await mountWindow(state)
    // The read starts failing *after* the window is up, which is the case a poll would hide.
    invoke.mockImplementation(async (command: string) => {
      if (command === 'desktop_pet_appearance') throw new Error('the settings store is unreadable')
      return null
    })
    emit('pet-settings-changed', { domain: 'character', revision: 3 })
    await flush()

    expect(notice()).toContain('the settings store is unreadable')
    expect(notice()).not.toBe('No character is selected.')
  })

  it('states an answer that is not an appearance, rather than reading it for a status', async () => {
    // The browser build's shape: a stub that has no case for `desktop_pet_appearance` resolves it
    // with `undefined`, and the window used to read that for a `status` while rendering. This is
    // the same defect that reached the settings side through the capability report — found there
    // by an e2e walk, and reachable here by the pet window's own browser harness.
    const state = host()
    await mountWindow(state)
    invoke.mockImplementation(async (command: string) => {
      if (command === 'desktop_pet_appearance') return undefined
      if (command === 'desktop_pet_state') return { enabled: true, visible: true }
      if (command === 'desktop_pet_tasks') return []
      return undefined
    })
    emit('pet-settings-changed', { domain: 'character', revision: 4 })
    await flush()

    expect(notice()).toContain('is not a character to draw')
    expect(document.querySelector('.pet-sprite')).toBeNull()
  })

  it('ignores a write to a domain it does not draw from', async () => {
    const state = host()
    await mountWindow(state)

    emit('pet-settings-changed', { domain: 'care', revision: 2 })
    await flush()

    // No re-read, so the notice is the one the first read produced — a window that asked again on
    // every write would be the poll this channel exists to avoid.
    expect(notice()).toBe('No character is selected.')
  })
})

describe('a task that reaches a terminal state produces a reminder', () => {
  it('draws one row per run, and the same run again is still one row', async () => {
    const state = host()
    await mountWindow(state)

    state.tasks = [task('working')]
    emit('pet-task', state.tasks)
    await flush()
    expect(document.querySelectorAll('.pet-task__row')).toHaveLength(1)

    // The ending: the reminder itself.
    state.tasks = [task('turn-finished')]
    emit('pet-task', state.tasks)
    await flush()
    const rows = document.querySelectorAll<HTMLElement>('.pet-task__row')
    expect(rows).toHaveLength(1)
    expect(rows[0].dataset.state).toBe('turn-finished')

    // A frame the projection refused to apply is a list that did not move — delivered again, and
    // still one row: §6.3's 重放去重 seen from the display's side.
    emit('pet-task', state.tasks)
    await flush()
    expect(document.querySelectorAll('.pet-task__row')).toHaveLength(1)
  })

  it('sends the clicked task\'s key, and nothing else, to the host', async () => {
    const state = host()
    await mountWindow(state)
    state.tasks = [task('turn-finished')]
    emit('pet-task', state.tasks)
    await flush()

    const row = document.querySelector<HTMLButtonElement>('.pet-task__row')
    expect(row).not.toBeNull()
    row?.click()
    await flush()

    expect(state.openedTasks).toEqual([CAT])
    const [sent] = state.openedTasks
    expect(Object.keys(sent).sort()).toEqual([
      'agentId',
      'profileId',
      'runId',
      'runtimeEpoch',
      'sessionId',
      'vaultId',
    ])
  })

  it('keeps a reminder that arrived while the pet was hidden', async () => {
    const state = host({ visible: false })
    await mountWindow(state)
    // Hidden is not off: the window is up, drawing nothing, and still subscribed.
    expect(document.querySelector('.pet-task__row')).toBeNull()

    state.tasks = [task('turn-finished')]
    emit('pet-task', state.tasks)
    await flush()
    expect(document.querySelector('.pet-task__row')).toBeNull()

    // Shown again — the settings switch, from the other window.
    emit('pet-feature', { enabled: true, visible: true } as PetFeatureState)
    await flush()

    const rows = document.querySelectorAll<HTMLElement>('.pet-task__row')
    expect(rows).toHaveLength(1)
    expect(rows[0].dataset.state).toBe('turn-finished')
  })

  it('says the host could not answer, instead of looking like a pet with no work', async () => {
    // The audit's second break, in the window: `desktop_pet_tasks` had no backend, so the first
    // read rejected. What the window does about it is the whole difference between a stated
    // failure and a subscription that has quietly released itself.
    const state = host({ tasksRefusal: 'command desktop_pet_tasks not found' })
    await mountWindow(state)

    expect(notice()).toContain('command desktop_pet_tasks not found')
  })
})
