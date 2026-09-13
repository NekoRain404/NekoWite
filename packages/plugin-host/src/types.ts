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

/** The AI capability a plugin gets when the host has one to offer.
 *
 *  `permissions: ['ai']` used to buy nothing: the host had no AI surface at all,
 *  so a plugin could only reach a model by going around the app. The provider is
 *  injected (see `setPluginAiProvider`) because the model belongs to the APPL
 *  - its settings, its key, its cost - not to the plugin host, and the app is
 *  what must apply the user's write policy to whatever comes back. */
export interface PluginAiApi {
  /** One completion. The provider applies the app's own settings; a plugin can
   *  shape the prompt but not the endpoint, the key or the token budget. */
  complete(prompt: string): Promise<string>
}

export interface PluginContext {
  id: string
  name: string
  insertComponent: (name: string) => void
  // Convenience: the app's active editor at emit time. Set by the host inside
  // emitLifecycle from getActiveEditor(); hooks that need the editor should
  // prefer the editor ARG (threaded into onEditorReady/onSave/onSaved).
  editor?: unknown
  /** Present only when the plugin declared the `ai` permission AND the app
   *  installed a provider. Its absence is the honest answer to "can I call a
   *  model?": no capability, rather than a call that fails at the wire. */
  ai?: PluginAiApi
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
  | 'PLUGIN_CALLBACK_ERROR'
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
  | 'PLUGIN_REVOKED'
  | 'PLUGIN_VERSION_REFUSED'
  | 'PLUGIN_QUOTA_EXCEEDED'

const DEFAULT_PLUGIN_ERROR_MESSAGE: Record<PluginErrorCode, string> = {
  PLUGIN_LOAD_FAILED: 'The plugin failed to load.',
  PLUGIN_ACTIVATE_FAILED: 'The plugin failed to activate.',
  PLUGIN_HOOK_ERROR: 'A lifecycle hook of the plugin threw an error.',
  PLUGIN_CALLBACK_ERROR: 'A plugin button or command threw an error.',
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
  PLUGIN_REVOKED: 'This plugin has been revoked and is no longer permitted to run.',
  PLUGIN_VERSION_REFUSED: 'This plugin version is outside the supported version range.',
  PLUGIN_QUOTA_EXCEEDED: 'The plugin exceeded its session resource quota and was disabled.',
}

const DEFAULT_PLUGIN_ERROR_RECOVERY: Record<PluginErrorCode, string> = {
  PLUGIN_LOAD_FAILED: 'Reinstall the plugin or check its entry file.',
  PLUGIN_ACTIVATE_FAILED: 'Disable and re-enable the plugin, or reinstall it.',
  PLUGIN_HOOK_ERROR: 'Disable the plugin or check its logs.',
  PLUGIN_CALLBACK_ERROR: 'Disable the plugin or check its logs.',
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
  PLUGIN_REVOKED: 'The publisher revoked this plugin; update or remove it.',
  PLUGIN_VERSION_REFUSED: 'Update the plugin to a supported version, or remove it.',
  PLUGIN_QUOTA_EXCEEDED: 'Let the plugin fail, then re-approve it to grant a fresh session budget.',
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
  'PLUGIN_REVOKED',
  'PLUGIN_VERSION_REFUSED',
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
