import { invoke } from '@tauri-apps/api/core'

export type GitAction =
  | { kind: 'status' | 'init' | 'pull' | 'push' }
  | { kind: 'setOrigin'; url: string }
  | { kind: 'commit'; message: string }

export interface GitReadout {
  initialized: boolean
  branch: string
  origin: string
  changes: string
}

export interface VaultGitClient {
  run(vaultRoot: string, action: GitAction): Promise<GitReadout>
}

export const vaultGitClient: VaultGitClient = {
  run: (vaultRoot, action) => invoke<GitReadout>('vault_git', { vaultRoot, action }),
}
