/**
 * The palette's file-watch subscription: what happens when registering it fails,
 * and what happens when it succeeds (finding F8 in
 * `docs/audits/2026-09-21-code-review.md`).
 *
 * `fsService.onFsChange` is Tauri's `listen`, which rejects when registration
 * fails. The palette stored that promise and called `.then` on it at unmount
 * with no rejection arm, so a failed registration became an unhandled rejection
 * — and, quieter and worse, the palette went on offering files the app no longer
 * had, because a subscription it never had was never missed. Its sibling
 * (`use-note-graph.ts`) guards the same call; these two cases are that guard,
 * held to this composable.
 *
 * Mounted through a real component rather than called bare, because both arms of
 * the defect live in the lifecycle hooks: `onMounted` registers and
 * `onBeforeUnmount` releases. The mounting shape is
 * `use-agent-scroll.test.ts`'s — `createApp` from `vue` itself, because this
 * package mounts components through `createApp` rather than a test-utils helper.
 *
 * The first case is the one that cannot be asserted directly: an unhandled
 * rejection is not a value a test can read, it is a run vitest fails. So the
 * assertion it makes is that the file reaches its end — the same shape the
 * repository uses for the process-level cases, where the mechanism *is* the
 * evidence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, ref, type App as VueApp } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  onFsChange: vi.fn(),
  invalidate: vi.fn(),
}))

vi.mock('../../../platform/gateways/fs', () => ({
  fsService: { onFsChange: mocks.onFsChange },
}))
vi.mock('../../../services/vault-files', () => ({
  vaultFileIndex: { invalidate: mocks.invalidate, get: () => Promise.resolve([]) },
}))

import { usePaletteEntries } from './use-palette-entries'

let mounted: VueApp[] = []

/** The composable, inside a component: both halves of it are lifecycle hooks. */
function mountPalette(isOpen: () => boolean): VueApp {
  const app = createApp(
    defineComponent({
      setup() {
        usePaletteEntries({ query: ref(''), isOpen })
        return () => null
      },
    }),
  )
  app.mount(document.createElement('div'))
  mounted.push(app)
  return app
}

function unmount(app: VueApp): void {
  app.unmount()
  mounted = mounted.filter((candidate) => candidate !== app)
}

beforeEach(() => {
  setActivePinia(createPinia())
  mocks.onFsChange.mockReset()
  mocks.invalidate.mockReset()
})

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
})

describe('the palette file watch', () => {
  it('survives a registration that fails without dropping the rejection', async () => {
    mocks.onFsChange.mockReturnValue(
      Promise.reject(new Error('listen is not available here')),
    )

    const app = mountPalette(() => false)
    await Promise.resolve()
    unmount(app)
    await Promise.resolve()

    expect(mocks.onFsChange).toHaveBeenCalledTimes(1)
  })

  it('invalidates the cached walk on an event and releases the subscription once', async () => {
    const unlisten = vi.fn()
    let handler: (() => void) | null = null
    mocks.onFsChange.mockImplementation((onChange: () => void) => {
      handler = onChange
      return Promise.resolve(unlisten)
    })

    const app = mountPalette(() => false)
    await Promise.resolve()

    expect(handler, 'the composable must subscribe on mount').not.toBeNull()
    handler!()
    expect(mocks.invalidate, 'a file event invalidates the walk').toHaveBeenCalledTimes(1)

    unmount(app)
    expect(unlisten, 'the subscription is released on unmount').toHaveBeenCalledTimes(1)
  })
})
