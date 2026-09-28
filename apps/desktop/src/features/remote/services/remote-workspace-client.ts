import { invoke } from '@tauri-apps/api/core'

export interface RemoteSpec {
  user: string
  host: string
  port: number
  remotePath: string
  folder: string
  auth?: RemoteAuth
}

export type RemoteAuth = { mode: 'agent' } | { mode: 'key'; identityFile: string } | { mode: 'password'; password: string }

export interface RemoteWorkspaceClient {
  import(vaultRoot: string, spec: RemoteSpec): Promise<string>
  connect(vaultRoot: string, spec: RemoteSpec): Promise<string>
  disconnect(vaultRoot: string, folder: string): Promise<void>
  connections(vaultRoot: string): Promise<RemoteConnection[]>
}

export interface RemoteConnection { path: string; connected: boolean }

export const remoteWorkspaceClient: RemoteWorkspaceClient = {
  import: (vaultRoot, spec) => invoke<string>('remote_import', { vault_root: vaultRoot, spec }),
  connect: (vaultRoot, spec) => invoke<string>('remote_connect', { vault_root: vaultRoot, spec }),
  disconnect: (vaultRoot, folder) => invoke<void>('remote_disconnect', { vault_root: vaultRoot, folder }),
  connections: (vaultRoot) => invoke<RemoteConnection[]>('remote_connections', { vault_root: vaultRoot }),
}
