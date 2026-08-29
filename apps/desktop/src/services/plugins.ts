import { activatePlugin, loadPlugin } from '@nekowite/plugin-host'
import type { PluginMeta } from '@nekowite/plugin-host'
import { fsService } from './fs'
import { notifyError } from './errors'

interface VaultPluginPackage {
  name?: string
  version?: string
  main?: string
}

function joinVault(...parts: string[]): string {
  return parts.join('/').replace(/\/+/g, '/')
}

/**
 * Scan `vault/plugins/<id>/` for user plugins and activate each one.
 *
 * Reading goes through the Rust fs commands (the webview has no Node fs
 * access) while `loadPlugin`/`activatePlugin` keep the plugin-host contract.
 * Best-effort: a missing plugins dir is not an error; per-plugin failures are
 * surfaced through the app's error toast.
 */
export async function loadVaultPlugins(vault: string): Promise<void> {
  let dirs
  try {
    dirs = await fsService.list(vault, 'plugins')
  } catch {
    return
  }
  for (const dir of dirs.filter((d) => d.is_dir)) {
    let pkg: VaultPluginPackage
    try {
      pkg = JSON.parse(
        await fsService.read(vault, joinVault('plugins', dir.name, 'package.json')),
      ) as VaultPluginPackage
    } catch {
      continue
    }
    if (!pkg.name || !pkg.version || !pkg.main) continue
    const meta: PluginMeta = {
      id: pkg.name,
      name: pkg.name,
      version: pkg.version,
      main: joinVault('plugins', dir.name, pkg.main),
    }
    const result = await loadPlugin(meta, (specifier) => import(specifier))
    const res = await activatePlugin(result)
    if (!res.ok) notifyError(`插件加载失败：${res.id}（${res.error ?? '未知错误'}）`)
    else console.info(`[NekoWite] vault plugin activated: ${res.id}`)
  }
}
