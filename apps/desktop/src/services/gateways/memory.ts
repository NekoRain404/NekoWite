import type { AiGateway, FsGateway, KeyGateway } from './contracts'

// Placeholder browser in-memory implementation for this task. Only enough to
// make the getGateways() selector deterministic without Tauri: list() resolves
// an empty virtual root (no invoke involved), the rest are no-ops or reject.
// Task 2 replaces this with a full seeded in-memory vault (memoryFsGateway with
// a Map + virtual directory tree).

export const memoryFsGateway: FsGateway = {
  read: () => Promise.reject(new Error('memory fs: read not implemented yet')),
  write: () => Promise.reject(new Error('memory fs: write not implemented yet')),
  list: () => Promise.resolve([]),
  watch: () => Promise.resolve(),
  openFolderDialog: () => Promise.resolve(null),
  saveFileDialog: () => Promise.resolve(null),
  onFsChange: () => Promise.resolve(() => undefined),
}

export const memoryAiGateway: AiGateway = {
  complete: () => Promise.resolve(),
  cancel: () => Promise.resolve(),
}

export const memoryKeyGateway: KeyGateway = {
  storeAiKey: () => Promise.resolve(),
  loadAiKey: () => Promise.resolve(null),
}
