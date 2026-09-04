import type { Component } from 'vue'
import type { EditorCommand, RegistrationBatch, ToolbarItem } from '@nekowite/editor-core'

/** Sensitive capabilities a plugin may declare it needs. The host surfaces
 *  these to the user before activation; without a real sandbox, declaring them
 *  is how the plugin makes the boundary explicit so the user can judge risk. */
export type PluginPermission = 'ai' | 'fs' | 'network' | 'clipboard'

export interface PluginMeta {
  id: string
  name: string
  version: string
  main: string
  /** Optional manifest-declared capabilities (e.g. from `package.json`). */
  permissions?: PluginPermission[]
  /** Optional HMAC-SHA256 signature (hex) from a trusted publisher, verified
   *  against the user's trusted key before the plugin is imported. */
  signature?: string
}

export interface PluginContext {
  id: string
  name: string
  insertComponent: (name: string) => void
  // Convenience: the app's active editor at emit time. Set by the host inside
  // emitLifecycle from getActiveEditor(); hooks that need the editor should
  // prefer the editor ARG (threaded into onEditorReady/onSave/onSaved).
  editor?: unknown
}

export interface PluginDefinition extends RegistrationBatch {
  name?: string
  /** Optional capabilities this plugin declares it needs. The host may gate
   *  activation of dangerous capabilities on user confirmation. */
  permissions?: PluginPermission[]
  components?: Record<string, Component>
  toolbar?: ToolbarItem[]
  commands?: EditorCommand[]
  onLoad?(ctx: PluginContext): void | (() => void) | Promise<void | (() => void)>
  onUnload?(ctx: PluginContext): void
  onEditorReady?(ctx: PluginContext, editor: unknown): void | (() => void)
  onDocChange?(ctx: PluginContext, e: { doc: string }): void | (() => void)
  onSave?(ctx: PluginContext, editor: unknown, content: string): string | void | (() => void)
  onSaved?(ctx: PluginContext, editor: unknown, content: string): void | (() => void)
  onOpenDocument?(ctx: PluginContext, tab: unknown): void | (() => void)
  onCloseTab?(ctx: PluginContext, tab: unknown): void | (() => void)
  onViewModeChange?(ctx: PluginContext, mode: unknown): void | (() => void)
}

export function definePlugin(def: PluginDefinition): PluginDefinition {
  return def
}

/** Categorised plugin failures. Every plugin-originated error should be
 *  expressed with one of these codes so the host can route it to a distinct
 *  user-facing message + recovery hint instead of a generic "plugin failed". */
export type PluginErrorCode =
  | 'PLUGIN_LOAD_FAILED'
  | 'PLUGIN_ACTIVATE_FAILED'
  | 'PLUGIN_HOOK_ERROR'
  | 'PLUGIN_PERMISSION_DENIED'
  | 'PLUGIN_NOT_FOUND'
  | 'PLUGIN_MANIFEST_INVALID'
  | 'PLUGIN_CODE_PARSE_FAILED'
  | 'PLUGIN_VERIFY_FAILED'
  | 'PLUGIN_UNSANDBOXED'
  | 'PLUGIN_SIGNATURE_INVALID'
  | 'PLUGIN_UNSIGNED_UNTRUSTED'
  | 'PLUGIN_HOOK_TIMEOUT'
  | 'PLUGIN_ABORTED'
  | 'PLUGIN_UNSTABLE'

const DEFAULT_PLUGIN_ERROR_MESSAGE: Record<PluginErrorCode, string> = {
  PLUGIN_LOAD_FAILED: 'The plugin failed to load.',
  PLUGIN_ACTIVATE_FAILED: 'The plugin failed to activate.',
  PLUGIN_HOOK_ERROR: 'A lifecycle hook of the plugin threw an error.',
  PLUGIN_PERMISSION_DENIED: 'The plugin was denied a required permission.',
  PLUGIN_NOT_FOUND: 'The plugin could not be found.',
  PLUGIN_MANIFEST_INVALID: 'The plugin manifest (package.json) is invalid.',
  PLUGIN_CODE_PARSE_FAILED: 'The plugin code could not be parsed.',
  PLUGIN_VERIFY_FAILED: 'This plugin\'s code or manifest changed since you approved it.',
  PLUGIN_UNSANDBOXED: 'The plugin runs unsandboxed in the main window.',
  PLUGIN_SIGNATURE_INVALID: 'This plugin\'s signature could not be verified against the trusted publisher key; refusing to run it.',
  PLUGIN_UNSIGNED_UNTRUSTED: 'This plugin is unsigned and not from a trusted source; refusing to run it.',
  PLUGIN_HOOK_TIMEOUT: 'A lifecycle hook of the plugin exceeded its time budget and was cancelled.',
  PLUGIN_ABORTED: 'Plugin activation was cancelled.',
  PLUGIN_UNSTABLE: 'The plugin entered an unstable state and was disabled.',
}

const DEFAULT_PLUGIN_ERROR_RECOVERY: Record<PluginErrorCode, string> = {
  PLUGIN_LOAD_FAILED: 'Reinstall the plugin or check its entry file.',
  PLUGIN_ACTIVATE_FAILED: 'Disable and re-enable the plugin, or reinstall it.',
  PLUGIN_HOOK_ERROR: 'Disable the plugin or check its logs.',
  PLUGIN_PERMISSION_DENIED: 'Grant the requested permission in the plugin settings.',
  PLUGIN_NOT_FOUND: 'Reinstall the plugin.',
  PLUGIN_MANIFEST_INVALID: 'Fix or reinstall the plugin manifest.',
  PLUGIN_CODE_PARSE_FAILED: 'Update the plugin to a compatible version.',
  PLUGIN_VERIFY_FAILED: 'Re-approve it only if you trust the new version, or reinstall it.',
  PLUGIN_UNSANDBOXED: 'Only approve plugins from a source you trust.',
  PLUGIN_SIGNATURE_INVALID: 'Only run plugins from a source you trust; reinstall the plugin or add its publisher key.',
  PLUGIN_UNSIGNED_UNTRUSTED: 'Trust the plugin explicitly only if you trust its source, or add its publisher to the trusted sources.',
  PLUGIN_HOOK_TIMEOUT: 'Disable the plugin or check its logs.',
  PLUGIN_ABORTED: 'Retry activation, or disable the plugin.',
  PLUGIN_UNSTABLE: 'Disable and re-enable the plugin, or reinstall it.',
}

/** Union of error codes that represent a failure during plugin *loading*
 *  (before activation). Used to choose a sensible default `phase`. */
const LOAD_PHASE_CODES: ReadonlySet<PluginErrorCode> = new Set<PluginErrorCode>([
  'PLUGIN_LOAD_FAILED',
  'PLUGIN_MANIFEST_INVALID',
  'PLUGIN_CODE_PARSE_FAILED',
  'PLUGIN_NOT_FOUND',
  'PLUGIN_VERIFY_FAILED',
  'PLUGIN_SIGNATURE_INVALID',
  'PLUGIN_UNSIGNED_UNTRUSTED',
])

export interface PluginErrorOptions {
  pluginId: string
  /** User-facing summary. Falls back to a default derived from `code`. */
  message?: string
  /** Optional, actionable hint e.g. "reinstall the plugin" / "grant the permission". */
  recovery?: string
  /** 'load' (before activation) or 'run' (activation/lifecycle). */
  phase?: 'load' | 'run'
  /** The original thrown value, preserved for logs and debugging. */
  cause?: unknown
}

/** A structured, categorised plugin error carrying an error code, a
 *  user-facing message, and an actionable recovery hint so plugin failures are
 *  observable and actionable rather than silent. */
export class PluginError extends Error {
  readonly code: PluginErrorCode
  readonly pluginId: string
  readonly phase: 'load' | 'run'
  readonly recovery?: string

  constructor(code: PluginErrorCode, opts: PluginErrorOptions) {
    const message = opts.message?.trim() || DEFAULT_PLUGIN_ERROR_MESSAGE[code]
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined)
    this.name = 'PluginError'
    this.code = code
    this.pluginId = opts.pluginId
    this.phase = opts.phase ?? (LOAD_PHASE_CODES.has(code) ? 'load' : 'run')
    this.recovery = opts.recovery ?? DEFAULT_PLUGIN_ERROR_RECOVERY[code]
  }
}

/** Convenience factory for the structured plugin error. */
export function createPluginError(code: PluginErrorCode, opts: PluginErrorOptions): PluginError {
  return new PluginError(code, opts)
}
