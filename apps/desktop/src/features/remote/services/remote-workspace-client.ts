import { invoke } from '@tauri-apps/api/core'

export interface RemoteSpec {
  user: string
  host: string
  port: number
  remotePath: string
  folder: string
}

export interface RemoteWorkspaceClient {
  import(vaultRoot: string, spec: RemoteSpec): Promise<string>
}

export const remoteWorkspaceClient: RemoteWorkspaceClient = {
  import: (vaultRoot, spec) => invoke<string>('remote_import', { vaultRoot, spec }),
}
