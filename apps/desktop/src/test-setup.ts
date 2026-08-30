import { beforeAll, afterEach } from 'vitest'

class MemoryStorage implements Storage {
  private store = new Map<string, string>()

  get length(): number {
    return this.store.size
  }

  clear(): void {
    this.store.clear()
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null
  }

  removeItem(key: string): void {
    this.store.delete(key)
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value))
  }
}

// vitest's happy-dom environment does not surface window.localStorage in this
// setup; provide an in-memory Storage so tests (and the settings store's
// persistence) behave as they do inside the Tauri webview.
let storage = new MemoryStorage()

beforeAll(() => {
  storage = new MemoryStorage()
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: storage,
  })
})

afterEach(() => {
  storage.clear()
})