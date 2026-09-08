import { ref, type Ref } from 'vue'
import {
  setPluginIntegrityDecider,
  setPluginPermissionDecider,
  type PluginIntegrityRequest,
  type PluginPermissionRequest,
} from '../services/plugins'

/**
 * Global dialog state model for the app shell.
 *
 * Replaces the pile of mutually-ignoring `showXxx` booleans with a single
 * discriminated union so only one app-level dialog can be present at a time.
 * Covers the permission / integrity re-approval prompts the plugin loader asks
 * for through its decider callbacks, and the file-conflict prompt raised by the
 * sidebar. (Recovery/restore prompts are owned by <Toast> via the error bus.)
 *
 * The dialog itself is presentational; this module owns the state and the async
 * `resolve` continuations, so installing a decider and answering it never
 * reaches into a component.
 */
export type AppDialogState =
  | { kind: 'none' }
  | { kind: 'conflict'; tabId: string; path: string }
  | { kind: 'permission'; request: PluginPermissionRequest }
  | { kind: 'integrity'; request: PluginIntegrityRequest }

export interface AppDialogs {
  state: Ref<AppDialogState>
  showConflict(tabId: string, path: string): void
  showPermission(request: PluginPermissionRequest): void
  showIntegrity(request: PluginIntegrityRequest): void
  close(): void
  resolvePermission(allowed: boolean): void
  resolveIntegrity(reapprove: boolean): void
  installPluginDeciders(): void
}

export function useAppDialogs(): AppDialogs {
  const state = ref<AppDialogState>({ kind: 'none' })

  function showConflict(tabId: string, path: string): void {
    state.value = { kind: 'conflict', tabId, path }
  }

  function showPermission(request: PluginPermissionRequest): void {
    state.value = { kind: 'permission', request }
  }

  function showIntegrity(request: PluginIntegrityRequest): void {
    state.value = { kind: 'integrity', request }
  }

  function close(): void {
    state.value = { kind: 'none' }
  }

  function resolvePermission(allowed: boolean): void {
    const s = state.value
    if (s.kind !== 'permission') return
    s.request.resolve(allowed)
    state.value = { kind: 'none' }
  }

  function resolveIntegrity(reapprove: boolean): void {
    const s = state.value
    if (s.kind !== 'integrity') return
    s.request.resolve(reapprove)
    state.value = { kind: 'none' }
  }

  function installPluginDeciders(): void {
    // Vault plugins run in the same process as the app (no sandbox). When one
    // declares dangerous capabilities, ask the user before activating it.
    setPluginPermissionDecider((meta, permissions) => {
      return new Promise<boolean>((resolve) => {
        showPermission({ meta, permissions, resolve })
      })
    })
    // When a plugin's code/manifest changed since the user last approved it, the
    // loader refuses to run it silently. Present the change-detection prompt so a
    // real user can approve the new version (recorded as the new baseline) or
    // deny it. With no UI present the safe default (deny) applies.
    setPluginIntegrityDecider((meta, expectedDigest, actualDigest) => {
      return new Promise<boolean>((resolve) => {
        showIntegrity({ meta, expectedDigest, actualDigest, resolve })
      })
    })
  }

  return {
    state,
    showConflict,
    showPermission,
    showIntegrity,
    close,
    resolvePermission,
    resolveIntegrity,
    installPluginDeciders,
  }
}
