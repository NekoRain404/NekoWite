import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

vi.hoisted(() => {
  const g = globalThis as { window?: { __TAURI_INTERNALS__?: unknown } }
  if (!g.window) g.window = {}
  g.window.__TAURI_INTERNALS__ = {}
})

const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { useSettingsStore } from './settings'

type Store = ReturnType<typeof useSettingsStore>

/**
 * Every setting the store persists, and the identity it persists it under.
 *
 * **The `key` is spelled out here on purpose, and never read from the store.**
 * A renamed `LS_*` key does not throw, does not warn, and does not fail a test
 * that takes the name from the constant — an existing install simply comes back
 * with the default and the user reports that the app forgot their settings. The
 * only way this file can catch that is by disagreeing with the constant, so the
 * string below is a second, independent copy of it.
 *
 * Each case is therefore a round trip in both directions: written through the
 * store it must appear under this exact key, and seeded under this exact key it
 * must come back through the store.
 */
interface PersistedCase {
  setting: string
  key: string
  write: (s: Store) => void
  /** Exactly what must be in storage once `write` has been flushed. */
  stored: string
  /** What a store built over that storage must read back. */
  readBack: unknown
}

/** The Base URL field is scoped to the selected provider, so a case that writes
 *  one has to select it first — and the map it lands in carries the local
 *  default beside it (see `provider-urls.ts`). */
const BASE_MAP = JSON.stringify({
  local: 'http://localhost:1234/v1',
  anthropic: 'https://proxy.example.com/v1',
})

const CASES: PersistedCase[] = [
  {
    setting: 'provider',
    key: 'nekowite.ai.provider',
    write: (s) => { s.provider = 'anthropic' },
    stored: 'anthropic',
    readBack: 'anthropic',
  },
  {
    setting: 'model',
    key: 'nekowite.ai.model',
    write: (s) => { s.model = 'claude-sonnet-4-5' },
    stored: 'claude-sonnet-4-5',
    readBack: 'claude-sonnet-4-5',
  },
  {
    setting: 'baseUrl',
    key: 'nekowite.ai.baseUrls',
    write: (s) => {
      s.provider = 'anthropic'
      s.baseUrl = 'https://proxy.example.com/v1'
    },
    stored: BASE_MAP,
    readBack: 'https://proxy.example.com/v1',
  },
  {
    setting: 'modelsUrl',
    key: 'nekowite.ai.modelsUrls',
    write: (s) => {
      s.provider = 'anthropic'
      s.modelsUrl = 'https://proxy.example.com/v1/models'
    },
    stored: JSON.stringify({ anthropic: 'https://proxy.example.com/v1/models' }),
    readBack: 'https://proxy.example.com/v1/models',
  },
  {
    setting: 'temperature',
    key: 'nekowite.ai.temperature',
    write: (s) => { s.temperature = 1.25 },
    stored: '1.25',
    readBack: 1.25,
  },
  {
    setting: 'maxTokens',
    key: 'nekowite.ai.maxTokens',
    write: (s) => { s.maxTokens = 4096 },
    stored: '4096',
    readBack: 4096,
  },
  {
    setting: 'systemPrompt',
    key: 'nekowite.ai.systemPrompt',
    write: (s) => { s.systemPrompt = 'Be concise.' },
    stored: 'Be concise.',
    readBack: 'Be concise.',
  },
  {
    setting: 'systemPromptOn',
    key: 'nekowite.ai.systemPromptOn',
    write: (s) => { s.systemPromptOn = true },
    stored: 'true',
    readBack: true,
  },
  {
    setting: 'allowPrivate',
    key: 'nekowite.ai.allowPrivate',
    write: (s) => { s.allowPrivate = false },
    stored: 'false',
    readBack: false,
  },
  {
    setting: 'reasoningEffort',
    key: 'nekowite.ai.reasoningEffort',
    write: (s) => { s.reasoningEffort = 'high' },
    stored: 'high',
    readBack: 'high',
  },
  {
    setting: 'contextChars',
    key: 'nekowite.ai.contextChars',
    write: (s) => { s.contextChars = 9000 },
    stored: '9000',
    readBack: 9000,
  },
  {
    setting: 'disabledPrompts',
    key: 'nekowite.ai.disabledPrompts',
    write: (s) => { s.disabledPrompts = ['rewrite', 'outline'] },
    stored: JSON.stringify(['rewrite', 'outline']),
    readBack: ['rewrite', 'outline'],
  },
  {
    setting: 'autosaveInterval',
    key: 'nekowite.settings.autosaveInterval',
    write: (s) => { s.autosaveInterval = 'off' },
    stored: 'off',
    readBack: 'off',
  },
  {
    setting: 'maxHistory',
    key: 'nekowite.settings.maxHistory',
    write: (s) => { s.maxHistory = 25 },
    stored: '25',
    readBack: 25,
  },
  {
    setting: 'exportIncludeFrontmatter',
    key: 'nekowite.settings.exportFrontmatter',
    write: (s) => { s.exportIncludeFrontmatter = false },
    stored: 'false',
    readBack: false,
  },
  {
    setting: 'exportPdfPageSize',
    key: 'nekowite.settings.exportPageSize',
    write: (s) => { s.exportPdfPageSize = 'Legal' },
    stored: 'Legal',
    readBack: 'Legal',
  },
  {
    setting: 'exportPdfOrientation',
    key: 'nekowite.settings.exportOrientation',
    write: (s) => { s.exportPdfOrientation = 'landscape' },
    stored: 'landscape',
    readBack: 'landscape',
  },
  {
    setting: 'exportMarginMm',
    key: 'nekowite.settings.exportMarginMm',
    write: (s) => { s.exportMarginMm = 12.5 },
    stored: '12.5',
    readBack: 12.5,
  },
  {
    setting: 'exportImageFormat',
    key: 'nekowite.settings.exportImageFormat',
    write: (s) => { s.exportImageFormat = 'jpeg' },
    stored: 'jpeg',
    readBack: 'jpeg',
  },
  {
    setting: 'exportImageQuality',
    key: 'nekowite.settings.exportImageQuality',
    write: (s) => { s.exportImageQuality = 0.75 },
    stored: '0.75',
    readBack: 0.75,
  },
]

/** Reads back the setting a case is about, from a store built over storage the
 *  case has just written. */
function read(store: Store, c: PersistedCase): unknown {
  return (store as unknown as Record<string, unknown>)[c.setting]
}

function storedKeys(): string[] {
  const keys: string[] = []
  for (let i = 0; i < localStorage.length; i += 1) {
    const k = localStorage.key(i)
    if (k) keys.push(k)
  }
  return keys.sort()
}

describe('every persisted setting, by round trip', () => {
  beforeEach(() => {
    localStorage.clear()
    invokeMock.mockReset()
    setActivePinia(createPinia())
  })

  for (const c of CASES) {
    it(`${c.setting}: written under ${c.key}, and read back from it`, async () => {
      const first = useSettingsStore()
      c.write(first)
      // The store persists through watchers, which Vue flushes on the next tick.
      await nextTick()
      await nextTick()
      expect(
        localStorage.getItem(c.key),
        `${c.setting} must be stored under the key it has always had`,
      ).toBe(c.stored)

      setActivePinia(createPinia())
      const second = useSettingsStore()
      expect(read(second, c), `${c.setting} must come back from storage`).toEqual(c.readBack)
    })
  }

  it('writes no key this list does not name', async () => {
    // The other half of a rename: a *new* key beside the old one would leave the
    // old value stale and the setting reset on the next launch, while every
    // per-setting case above still passed.
    const s = useSettingsStore()
    for (const c of CASES) c.write(s)
    await nextTick()
    await nextTick()
    expect(storedKeys()).toEqual([...new Set(CASES.map((c) => c.key))].sort())
  })

  it('reads every key back from storage seeded by hand', async () => {
    // The other direction of the same round trip: a store that merely wrote the
    // right key while reading a different one would pass the write half above.
    for (const c of CASES) localStorage.setItem(c.key, c.stored)
    const s = useSettingsStore()
    for (const c of CASES) {
      expect(read(s, c), `${c.setting} must be read from ${c.key}`).toEqual(c.readBack)
    }
  })

  it('still reads the legacy Base URL scalar, and never writes it again', async () => {
    // `nekowite.ai.baseUrl` predates the per-provider map. It is read once, for
    // an install that has one, and the map is what carries it forward.
    localStorage.setItem('nekowite.ai.baseUrl', 'https://legacy.example.com/v1')
    const s = useSettingsStore()
    expect(s.baseUrl).toBe('https://legacy.example.com/v1')

    // Drop the scalar and write something, so the assertion below is about the
    // store never *creating* it again rather than about the line above not
    // having removed it.
    localStorage.removeItem('nekowite.ai.baseUrl')
    s.provider = 'deepseek'
    s.temperature = 1.25
    s.baseUrl = 'https://api.deepseek.com'
    await nextTick()
    await nextTick()
    expect(storedKeys()).not.toContain('nekowite.ai.baseUrl')
  })
})
