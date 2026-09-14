import type { PluginAiApi, PluginPermission } from './types'

/* ------------------------------------------------------------------------- *
 * The `ai` surface the host offers to plugins: what the app installs there, and
 * which plugins may have it.
 *
 * The model belongs to the APP — its settings, its key, its bill, and its write
 * policy — so the host does not implement AI; the app installs a provider. With
 * none installed, `ctx.ai` is simply absent: a plugin that declared `ai` gets no
 * capability rather than a call that fails at the wire.
 * ------------------------------------------------------------------------- */

type PluginAiProvider = (pluginId: string, prompt: string) => Promise<string>

let pluginAiProvider: PluginAiProvider | null = null

/** Install (or clear) the provider the host hands to `ai`-declaring plugins. */
export function setPluginAiProvider(provider: PluginAiProvider | null): void {
  pluginAiProvider = provider
}

/**
 * The `ai` surface for a plugin, or undefined when it may not have one: the
 * plugin must have DECLARED the permission (a plugin that did not must not gain
 * the capability by asking) and the app must have installed a provider.
 *
 * `declared` has to be the PINNED declaration (see `declaredPermissionsOf` in
 * ./permissions), never a fresh read of the plugin's own object: this is the
 * grant, so it must be the same answer the user's consent decision rested on.
 */
export function aiApiFor(id: string, declared: readonly PluginPermission[]): PluginAiApi | undefined {
  if (!declared.includes('ai') || !pluginAiProvider) return undefined
  const provider = pluginAiProvider
  return {
    complete: (prompt: string) => provider(id, String(prompt ?? '')),
  }
}
