import type { AiGateway, FileEntry, FsGateway, KeyGateway } from './contracts'

const DEFAULT_SEED: Record<string, string> = {
  'welcome.md':
    '# Welcome to NekoWite (demo)\n\nThis is the in-browser demo vault.',
}

export function createMemoryFsGateway(
  seed: Record<string, string> = DEFAULT_SEED,
): FsGateway {
  const files = new Map(Object.entries(seed))

  function normalizeDir(dir: string): string {
    if (dir === '.' || dir === '' || dir === 'memoir://demo') return ''
    if (dir.startsWith('memoir://demo/')) return dir.slice('memoir://demo/'.length)
    return dir.replace(/\/+$/, '')
  }

  function isHiddenKey(key: string): boolean {
    return key.split('/').some((seg) => seg.startsWith('.'))
  }

  return {
    read: async (_vault, path) => {
      const content = files.get(path)
      if (content === undefined) {
        throw new Error(`No such file in demo vault: ${path}`)
      }
      return content
    },
    write: async (_vault, path, content) => {
      files.set(path, content)
    },
    list: async (_vault, dir) => {
      const base = normalizeDir(dir)
      const prefix = base === '' ? '' : `${base}/`
      const dirs = new Set<string>()
      const fileKeys = new Map<string, string>()
      for (const key of files.keys()) {
        if (!key.startsWith(prefix) || isHiddenKey(key)) continue
        const rest = key.slice(prefix.length)
        if (rest === '') continue
        const [seg] = rest.split('/')
        if (rest.includes('/')) dirs.add(seg)
        else fileKeys.set(seg, key)
      }
      const entries: FileEntry[] = []
      for (const name of dirs) {
        entries.push({
          name,
          path: base === '' ? name : `${base}/${name}`,
          is_dir: true,
          is_mdx: false,
        })
      }
      for (const [name, key] of fileKeys) {
        entries.push({
          name,
          path: key,
          is_dir: false,
          is_mdx: /\.(md|mdx)$/i.test(name),
        })
      }
      return entries.sort((a, b) => {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1
        return a.name.localeCompare(b.name)
      })
    },
    watch: async () => undefined,
    openFolderDialog: async () => 'memoir://demo',
    saveFileDialog: async () => null,
    onFsChange: () => Promise.resolve(() => undefined),
  }
}

export const memoryFsGateway = createMemoryFsGateway()

export const memoryAiGateway: AiGateway = {
  complete: async () => undefined,
  cancel: async () => undefined,
}

export const memoryKeyGateway: KeyGateway = {
  storeAiKey: async () => undefined,
  loadAiKey: async () => null,
}
