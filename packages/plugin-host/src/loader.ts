import type { PluginDefinition, PluginMeta } from './types'

export type { PluginDefinition, PluginMeta } from './types'

export type LoadResult =
  | { ok: true; id: string; meta: PluginMeta; definition: PluginDefinition }
  | { ok: false; id: string; error: string }

export interface LoadedPlugin {
  meta: PluginMeta
  definition: PluginDefinition
}

export type DynamicImport = (specifier: string) => Promise<{ default?: PluginDefinition }>

export async function loadPlugin(meta: PluginMeta, dynamicImport: DynamicImport): Promise<LoadResult> {
  try {
    const mod = await dynamicImport(meta.main)
    if (!mod.default) return { ok: false, id: meta.id, error: 'plugin has no default export' }
    return { ok: true, id: meta.id, meta, definition: mod.default }
  } catch (err) {
    return { ok: false, id: meta.id, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function loadPluginsFromDir(vaultPath: string): Promise<LoadedPlugin[]> {
  const { readdir, readFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const entries = await readdir(vaultPath, { withFileTypes: true })
  const plugins: LoadedPlugin[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(vaultPath, entry.name)
    const pkgPath = join(dir, 'package.json')
    let pkg: { name?: string; version?: string; main?: string }
    try {
      pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as typeof pkg
    } catch {
      continue
    }
    if (!pkg.name || !pkg.version || !pkg.main) continue
    const meta: PluginMeta = {
      id: pkg.name,
      name: pkg.name,
      version: pkg.version,
      main: join(dir, pkg.main),
    }
    const result = await loadPlugin(meta, (specifier) => import(specifier))
    if (result.ok) plugins.push({ meta, definition: result.definition })
  }
  return plugins
}