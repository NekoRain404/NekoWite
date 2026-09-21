/**
 * The reference plugin is executed here, not only described.
 *
 * `examples/plugins/hello` is what `docs/PLUGIN_SDK.md` tells a plugin author to read, and until
 * 2026-09-22 **nothing ran it**: no test imported it, no code path loaded it (the application
 * refuses vault plugins in both builds — § 4 of that document), and it sits outside every
 * tsconfig and eslint project. So the one file the SDK documents as its example could drift out
 * of the API with no red test anywhere — the same shape of gap the audit found from the other
 * side when it asked what the API-surface list actually required.
 *
 * **How it is executed, and why not by `import`.** A bare `@nekowite/plugin-host` cannot resolve
 * from `examples/`: Vite resolves a bare specifier from the importing file's directory upward,
 * and only `apps/desktop/node_modules` holds the workspace link. A real host does not depend on
 * Node resolution either — it hands `loadPlugin` a `dynamicImport` adapter, which is what maps
 * the SDK for a plugin. So this file does what that adapter does: the example's own bytes are
 * read from disk, its single import is replaced by the SDK the adapter would supply, and the
 * module body is evaluated. The source is not modified on disk and the assertions run against
 * the real barrel's real `definePlugin`/`getActiveEditor`.
 *
 * What that cannot catch, stated rather than implied: the example is plain `.js` outside every
 * tsconfig, so a wrong-but-plausible argument to a typed API still passes here. The last case
 * says so out loud.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as sdk from '@nekowite/plugin-host'
import type { PluginDefinition } from '@nekowite/plugin-host'

const EXAMPLE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../examples/plugins/hello')
const IMPORT_LINE = /^import\s.*?from\s+'@nekowite\/plugin-host'\s*$/m

interface ExampleManifest {
  name?: string
  version?: string
  main?: string
  type?: string
}

function readManifest(): ExampleManifest {
  return JSON.parse(readFileSync(join(EXAMPLE_DIR, 'package.json'), 'utf8')) as ExampleManifest
}

/** The names the example imports from the SDK, read out of its own import statement. */
function importedSdkNames(source: string): string[] {
  const line = source.match(IMPORT_LINE)?.[0] ?? ''
  const braces = line.match(/\{([^}]*)\}/)?.[1] ?? ''
  return braces
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
}

/** The examples's module body, evaluated with the SDK a host's `dynamicImport` would give it. */
function evaluateExample(source: string, log: string[]): PluginDefinition {
  const body = source
    .replace(IMPORT_LINE, '')
    .replace(/export default\s+/, 'return ')
  const factory = new Function('definePlugin', 'getActiveEditor', 'console', body) as (
    definePlugin: typeof sdk.definePlugin,
    getActiveEditor: typeof sdk.getActiveEditor,
    console: { log: (...args: unknown[]) => void },
  ) => PluginDefinition
  return factory(sdk.definePlugin, sdk.getActiveEditor, {
    log: (...args: unknown[]) => log.push(args.map(String).join(' ')),
  })
}

const source = (): string => readFileSync(join(EXAMPLE_DIR, 'index.js'), 'utf8')

let logged: string[] = []
let definition: PluginDefinition

beforeEach(() => {
  logged = []
  definition = evaluateExample(source(), logged)
})

afterEach(() => {
  sdk.setActiveEditor(null)
  vi.restoreAllMocks()
})

describe('the reference plugin at examples/plugins/hello', () => {
  it('carries the three manifest fields the loader requires, and its main exists', () => {
    const manifest = readManifest()
    // `loader.ts` skips a plugin whose manifest lacks any of these three, silently: a reference
    // plugin missing one would be an example of a plugin that never loads.
    expect(manifest.name).toBe('hello')
    expect(typeof manifest.version).toBe('string')
    expect(typeof manifest.main).toBe('string')
    expect(existsSync(join(EXAMPLE_DIR, manifest.main!))).toBe(true)
    expect(manifest.type).toBe('module')
  })

  it('imports only names the public barrel still exports', () => {
    const names = importedSdkNames(source())
    expect(names.length).toBeGreaterThan(0)
    for (const name of names) {
      // The example is the document's promise in code; a rename in the barrel that misses it
      // makes the first thing a plugin author copies fail.
      expect(Object.keys(sdk), `the SDK no longer exports "${name}"`).toContain(name)
    }
  })

  it('builds the definition the document describes', () => {
    expect(definition.name).toBe('hello')
    expect(definition.permissions).toEqual(['clipboard'])
    expect(definition.toolbar).toHaveLength(1)
    expect(definition.toolbar?.[0]?.id).toBe('hello.insert-greeting')
    expect(definition.toolbar?.[0]?.label).toBe('Insert greeting')
    expect(typeof definition.toolbar?.[0]?.run).toBe('function')
    for (const hook of ['onLoad', 'onEditorReady', 'onDocChange'] as const) {
      expect(typeof definition[hook], `${hook} is declared`).toBe('function')
    }
  })

  it('inserts its greeting through the active editor, not through Tauri IPC', async () => {
    const inserted: string[] = []
    sdk.setActiveEditor({ insertMarkdownAtCursor: (text: string) => Promise.resolve(inserted.push(text)) })

    definition.toolbar?.[0]?.run()
    // The example calls it with `void`, so the insert lands on a microtask.
    await Promise.resolve()
    expect(inserted).toEqual(['Hello from the hello plugin!\n'])
  })

  it('does nothing — and does not throw — when no editor is active', () => {
    sdk.setActiveEditor(null)
    // A toolbar item outlives the editor it was clicked in, so the guard in the example is the
    // difference between a no-op and a TypeError from the host calling run() on a dead window.
    expect(() => definition.toolbar?.[0]?.run()).not.toThrow()
    expect(sdk.getActiveEditor()).toBeNull()
  })

  it('runs every hook it declares, and onLoad hands back its unload cleanup', () => {
    const ctx = { id: 'hello', name: 'hello', insertComponent: () => {} }

    const cleanup = definition.onLoad?.(ctx)
    expect(typeof cleanup).toBe('function')
    expect(logged.join('\n')).toContain('[hello] plugin "hello" loaded')
    ;(cleanup as () => void)()
    expect(logged.join('\n')).toContain('[hello] plugin "hello" unloaded')

    expect(() => definition.onEditorReady?.(ctx, {})).not.toThrow()
    expect(() => definition.onDocChange?.(ctx, { doc: 'abc' })).not.toThrow()
    expect(logged.join('\n')).toContain('[hello] document changed 3')
  })

  it('is plain JavaScript outside every tsconfig, and this test cannot check its types', () => {
    // Stated rather than implied: the honest scope of a runtime fixture. `setActiveEditor(someString)`
    // would pass here and only fail inside a host.
    expect(readFileSync(join(EXAMPLE_DIR, 'package.json'), 'utf8')).not.toContain('typescript')
    expect(source()).toContain("from '@nekowite/plugin-host'")
  })
})
