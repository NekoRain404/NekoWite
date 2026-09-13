import { describe, expect, it, vi } from 'vitest'
import {
  createPersistence,
  filePersistencePort,
  localStoragePersistencePort,
  memoryPersistencePort,
} from './index'
import { createMemoryFsGateway } from '../gateways/memory'
import { createDomainPersister } from '../../services/persistence'

/** A throwaway Storage double so we can drive quota/unavailable failures. */
function throwingStorage(kind: 'set' | 'get' | 'both'): Storage {
  const backing = new Map<string, string>()
  return {
    get length() {
      return backing.size
    },
    clear: () => backing.clear(),
    key: (i: number) => Array.from(backing.keys())[i] ?? null,
    getItem: (k) => {
      if (kind === 'get' || kind === 'both') throw new DOMException('quota', 'QuotaExceededError')
      return backing.get(k) ?? null
    },
    setItem: (k, v) => {
      if (kind === 'set' || kind === 'both') throw new DOMException('quota', 'QuotaExceededError')
      backing.set(k, String(v))
    },
    removeItem: (k) => {
      backing.delete(k)
    },
  }
}

describe('localStoragePersistencePort', () => {
  it('get/set/remove round-trips a string value', () => {
    const storage = new MapBackedStorage()
    const port = localStoragePersistencePort(storage as unknown as Storage)
    expect(port.get('k')).toBeNull()
    port.set('k', 'v')
    expect(port.get('k')).toBe('v')
    expect(port.get('k', 'fallback')).toBe('v')
    port.remove('k')
    expect(port.get('k')).toBeNull()
  })

  it('returns the fallback for a missing key', () => {
    const port = localStoragePersistencePort(new MapBackedStorage() as unknown as Storage)
    expect(port.get('missing')).toBeNull()
    expect(port.get('missing', 'dflt')).toBe('dflt')
  })

  it('is quota-safe: a throwing set warns and never throws; get falls back', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const setPort = localStoragePersistencePort(throwingStorage('set'))
    expect(() => setPort.set('k', 'v')).not.toThrow()
    expect(warn).toHaveBeenCalled()

    const getPort = localStoragePersistencePort(throwingStorage('get'))
    expect(() => getPort.get('k')).not.toThrow()
    expect(getPort.get('k', 'dflt')).toBe('dflt')
    expect(() => getPort.remove('k')).not.toThrow()
    expect(() => getPort.migrate('a', 'b')).not.toThrow()
    warn.mockRestore()
  })

  it('reports whether the write landed, so an owner can shed data', () => {
    // The port cannot throw (a reactive watcher would die with it), so the
    // return value is the only way a caller learns its data is not stored. The
    // chat store relies on it to retry without images instead of losing a
    // conversation.
    const ls = localStoragePersistencePort()
    expect(ls.set('nekowite.test.ok', 'value')).toBe(true)

    const throwing = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('QuotaExceededError', 'QuotaExceededError')
      },
      removeItem: () => undefined,
    } as unknown as Storage
    expect(localStoragePersistencePort(throwing).set('nekowite.test.full', 'x')).toBe(false)
  })

  it('migrate renames a key and carries its value', () => {
    const storage = new MapBackedStorage()
    const port = localStoragePersistencePort(storage as unknown as Storage)
    port.set('old', 'value')
    port.migrate('old', 'new')
    expect(port.get('new')).toBe('value')
    expect(port.get('old')).toBeNull()
  })
})

describe('memoryPersistencePort', () => {
  it('reports a successful write like every other adapter', () => {
    expect(memoryPersistencePort().set('a', 'b')).toBe(true)
  })

  it('get/set/remove round-trips', () => {
    const port = memoryPersistencePort()
    expect(port.get('k')).toBeNull()
    port.set('k', 'v')
    expect(port.get('k')).toBe('v')
    port.remove('k')
    expect(port.get('k')).toBeNull()
  })

  it('migrate renames a key', () => {
    const port = memoryPersistencePort()
    port.set('old', 'x')
    port.migrate('old', 'new')
    expect(port.get('new')).toBe('x')
    expect(port.get('old')).toBeNull()
  })
})

describe('createPersistence', () => {
  it('routes through localStorage when available, else degrades to memory', () => {
    const port = createPersistence()
    expect(typeof port.get).toBe('function')
    // Behavior must be uniform regardless of which backend won.
    expect(() => port.set('__probe__', '1')).not.toThrow()
    port.remove('__probe__')
  })
})

describe('filePersistencePort (fs-backed async)', () => {
  const VAULT = 'memoir://demo'

  it('round-trips a key through .nekowite/<key>.json and removes it', async () => {
    const fs = createMemoryFsGateway()
    const port = filePersistencePort(fs, VAULT)
    await port.set('index.meta', '{"v":1}')
    expect(await port.get('index.meta')).toBe('{"v":1}')
    // The value lives at `.nekowite/index.meta.json`.
    expect(await fs.read(VAULT, '.nekowite/index.meta.json')).toBe('{"v":1}')
    await port.remove('index.meta')
    expect(await port.get('index.meta')).toBeNull()
  })

  it('migrate renames a key', async () => {
    const fs = createMemoryFsGateway()
    const port = filePersistencePort(fs, VAULT)
    await port.set('old', 'value')
    await port.migrate('old', 'new')
    expect(await port.get('new')).toBe('value')
    expect(await port.get('old')).toBeNull()
  })

  it('a missing key reads as the fallback, and a failed write never throws', async () => {
    const fs = createMemoryFsGateway()
    const port = filePersistencePort(fs, VAULT)
    expect(await port.get('missing', 'dflt')).toBe('dflt')
    expect(await port.get('missing')).toBeNull()
    // A failing FsPort (read/write reject) degrades: set warns, get → null.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failing = createMemoryFsGateway(undefined, {
      fail: { read: () => new Error('boom'), write: () => new Error('boom') },
    })
    const bad = filePersistencePort(failing, VAULT)
    await expect(bad.set('k', 'v')).resolves.toBeUndefined()
    expect(await bad.get('k')).toBeNull()
    warn.mockRestore()
  })
})

describe('createDomainPersister (versioned domains)', () => {
  interface ShapeV2 {
    theme: string
    fontSize: number
  }

  const ser = (v: ShapeV2) => JSON.stringify(v)

  it('a version bump triggers the migrate chain on load and re-saves', () => {
    const port = memoryPersistencePort()
    // Store an old v1 payload: `{ theme }` -> v2 adds fontSize (default 15).
    port.set('appearance', JSON.stringify({ theme: 'dark' }))
    const persister = createDomainPersister<ShapeV2>(port, {
      key: 'appearance',
      version: 2,
      defaults: () => ({ theme: 'system', fontSize: 15 }),
      parse: (raw) => JSON.parse(raw) as ShapeV2,
      serialize: ser,
      migrations: {
        1: (raw) => {
          const v1 = JSON.parse(raw) as { theme?: string }
          return JSON.stringify({ theme: v1.theme ?? 'system', fontSize: 15 })
        },
      },
    })
    const value = persister.load()
    expect(value).toEqual({ theme: 'dark', fontSize: 15 })
    // The migrated payload is written back at the current version.
    expect(port.get('appearance')).toEqual(JSON.stringify({ theme: 'dark', fontSize: 15 }))
  })

  it('a key-rename migration pulls a legacy key forward', () => {
    const port = memoryPersistencePort()
    port.set('nekowite.appearance.old', JSON.stringify({ theme: 'light', fontSize: 20 }))
    const persister = createDomainPersister<ShapeV2>(port, {
      key: 'appearance',
      version: 1,
      defaults: () => ({ theme: 'system', fontSize: 15 }),
      parse: (raw) => JSON.parse(raw) as ShapeV2,
      serialize: ser,
      migratedFrom: ['nekowite.appearance.old'],
    })
    expect(persister.load()).toEqual({ theme: 'light', fontSize: 20 })
    expect(port.get('appearance')).toEqual(JSON.stringify({ theme: 'light', fontSize: 20 }))
    expect(port.get('nekowite.appearance.old')).toBeNull()
  })

  it('a corrupt stored value yields the default and never throws', () => {
    const port = memoryPersistencePort()
    port.set('appearance', '{not valid json')
    const persister = createDomainPersister<ShapeV2>(port, {
      key: 'appearance',
      version: 1,
      defaults: () => ({ theme: 'system', fontSize: 15 }),
      parse: (raw) => JSON.parse(raw) as ShapeV2,
      serialize: ser,
    })
    expect(persister.load()).toEqual({ theme: 'system', fontSize: 15 })
  })

  it('a missing stored value yields the default', () => {
    const persister = createDomainPersister<ShapeV2>(memoryPersistencePort(), {
      key: 'appearance',
      version: 1,
      defaults: () => ({ theme: 'system', fontSize: 15 }),
      parse: (raw) => JSON.parse(raw) as ShapeV2,
      serialize: ser,
    })
    expect(persister.load()).toEqual({ theme: 'system', fontSize: 15 })
  })
})

/** A minimal `Storage` double backed by a Map (test-setup MemoryStorage shape). */
class MapBackedStorage {
  private store = new Map<string, string>()
  get length() {
    return this.store.size
  }
  clear() {
    this.store.clear()
  }
  getItem(k: string) {
    return this.store.get(k) ?? null
  }
  key(i: number) {
    return Array.from(this.store.keys())[i] ?? null
  }
  removeItem(k: string) {
    this.store.delete(k)
  }
  setItem(k: string, v: string) {
    this.store.set(k, String(v))
  }
}
