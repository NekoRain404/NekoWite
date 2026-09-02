export interface FileEntry {
  name: string
  path: string
  is_dir: boolean
  is_mdx: boolean
}

export interface FsChangeEvent {
  path: string
  kind: string
}

export interface FsGateway {
  read(vault: string, path: string): Promise<string>
  write(vault: string, path: string, content: string): Promise<void>
  list(vault: string, dir: string): Promise<FileEntry[]>
  watch(vault: string): Promise<void>
  openFolderDialog(): Promise<string | null>
  saveFileDialog(defaultName: string, startDir?: string): Promise<string | null>
  onFsChange(cb: (e: FsChangeEvent) => void): Promise<() => void>
}

export interface AiGateway {
  complete(config: unknown, prompt: string): Promise<void>
  cancel(id: string): Promise<void>
}

export interface KeyGateway {
  storeAiKey(provider: string, key: string): Promise<void>
  loadAiKey(provider: string): Promise<string | null>
}

export interface AppGateways {
  fs: FsGateway
  ai: AiGateway
  keys: KeyGateway
}
