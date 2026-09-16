/**
 * §7.1's isolation clause, as an assertion about the build rather than a paragraph about it.
 *
 * The requirement is an absence — 「入口只初始化桌宠，不挂载 AppShell、编辑器、整套索引和 Agent
 * 客户端」 — and an absence is the requirement that fails silently. An entry that imported
 * `app-bootstrap` would mount a working pet, pass every rendering test, and quietly run a second
 * vault watcher, a second index and a second AI client in a window the user thinks is a
 * decoration. So the graph is walked here rather than trusted: `reachableFrom` follows every
 * relative import from `desktop-pet-entry.ts` through `.vue` script blocks and reports what it
 * finds, and the list is compared with one somebody chose.
 *
 * That comparison is the test's value and also its cost: it fails on *additions*, including
 * harmless ones. That is the point — "the pet window is still only the pet window" is a claim
 * nobody reviews by reading a diff, and the fix for a new entry in the list is to write down why
 * the pet needs it, which is the review the clause was asking for.
 */
import { describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { createMemoryPetGateway } from '../platform/gateways/memory-pet'
import { DESKTOP_PET_ROOT_ID } from './desktop-pet-entry'

const APP = resolve(__dirname, '..', '..')
const SRC = resolve(__dirname, '..')
const ENTRY = resolve(__dirname, 'desktop-pet-entry.ts')

/** Comments are stripped before the specifier scan: prose about a module is not an import of it. */
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** A `.vue` file's imports live in its script block; the template's are component references. */
function scriptOf(file: string, raw: string): string {
  if (!file.endsWith('.vue')) return raw
  const match = /<script[^>]*>([\s\S]*?)<\/script>/.exec(raw)
  if (!match) throw new Error(`${file} has no <script> block, so its imports cannot be read`)
  return match[1]
}

const SPECIFIER =
  /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm

/**
 * The specifiers this file still has after compilation.
 *
 * `import type` / `export type` statements are removed first. They are erased by TypeScript, so
 * what they name cannot reach the window, and counting them would turn this list into what the
 * source *mentions* rather than what the pet carries — the pet reuses the ACP contract's types
 * (`pet-contracts/events.ts:13`) precisely so that it does not re-declare them, and that is a
 * type-level statement. A mixed `import { type A, B }` is not removed, because part of it does
 * survive: the conservative direction is the one that keeps a runtime dependency visible.
 */
function specifiersOf(file: string): string[] {
  const code = stripComments(scriptOf(file, readFileSync(file, 'utf8'))).replace(
    /\b(?:import|export)\s+type\s[\s\S]*?\bfrom\s*['"][^'"]+['"]/g,
    '',
  )
  const found = new Set<string>()
  for (const match of code.matchAll(SPECIFIER)) {
    const specifier = match[1] ?? match[2] ?? match[3]
    if (specifier) found.add(specifier)
  }
  return [...found]
}

/**
 * Where a relative specifier points, or null when it leaves this source tree.
 *
 * Returning null for a package is what makes the two assertions below complementary: this walk
 * covers first-party code, and `PACKAGES` is the (much shorter) list of what it stops at. An
 * unresolved *relative* specifier throws rather than shortening the graph, because a walk that
 * silently found less would pass by finding nothing.
 */
function resolveRelative(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null
  const base = resolve(dirname(from), specifier)
  for (const candidate of [base, `${base}.ts`, `${base}.vue`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  throw new Error(`${relative(APP, from)} imports ${specifier}, which resolves to nothing`)
}

/** Every first-party module `entry` can reach, sorted, as paths relative to `src/`. */
function reachableFrom(entry: string): string[] {
  const seen = new Set<string>([entry])
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.shift() as string
    for (const specifier of specifiersOf(file)) {
      const target = resolveRelative(file, specifier)
      if (target && !seen.has(target)) {
        seen.add(target)
        queue.push(target)
      }
    }
  }
  seen.delete(entry)
  return [...seen].map((file) => relative(SRC, file).split(sep).join('/')).sort()
}

/** Every package the graph stops at, so a dependency cannot replace a first-party import. */
function packagesFrom(entry: string): string[] {
  const found = new Set<string>()
  const files = [entry, ...reachableFrom(entry).map((file) => join(SRC, file))]
  for (const file of files) {
    for (const specifier of specifiersOf(file)) {
      if (!specifier.startsWith('.')) found.add(specifier)
    }
  }
  return [...found].sort()
}

describe('the pet entry is one lightweight window and not a second application', () => {
  it('reaches this much and no more', () => {
    // Written out because the list is the contract. The root, the sprite it draws, the rendering
    // pipeline D2 ported, the lifecycle that owns what the window holds, and the two stylesheets
    // that make it follow the host's theme (§1) without carrying the application's component
    // layers. D1's contract is *not* here and that is the right answer rather than a gap: this
    // window imports it with `import type` only, so the pet's runtime carries the task and setting
    // shapes as nothing at all.
    expect(reachableFrom(ENTRY)).toEqual([
      'features/desktop-pet/components/DesktopPetRoot.vue',
      'features/desktop-pet/components/PetSprite.vue',
      'features/desktop-pet/composables/use-pet-lifecycle.ts',
      'features/desktop-pet/rendering/animation-bindings.ts',
      'features/desktop-pet/rendering/sprite-hit-test.ts',
      'features/desktop-pet/rendering/sprite-player.ts',
      'features/desktop-pet/rendering/sprite-sheet.ts',
      'features/desktop-pet/rendering/sprite-slicer.ts',
      'styles/palettes.css',
      'styles/tokens.css',
    ])
  })

  it('stops at one package', () => {
    // The other half of the walk: `reachableFrom` ignores anything that is not a relative path, so
    // a pet entry that imported `@milkdown/core` or `pinia` would be invisible to it. This is the
    // assertion that sees those.
    expect(packagesFrom(ENTRY)).toEqual(['vue'])
  })

  it('cannot reach the application, its editor, its index or its agent client', () => {
    const reachable = reachableFrom(ENTRY)
    const forbidden: [string, string][] = [
      ['app/app-bootstrap', 'the app runtime: vault registry, index, file watcher, AI client'],
      ['app/app-lifecycle', 'the editor window’s teardown'],
      ['app/app-dialogs', 'the editor window’s dialogs'],
      ['appAppShell', 'the application shell'],
      ['App.vue', 'the editor window’s root'],
      ['features/settings', 'the settings application'],
      ['features/editor', 'the editor'],
      ['i18n', 'the whole dictionary — §10.1 adds a pet namespace instead'],
      ['platform/gateways/index', 'every gateway, not only the pet one'],
      ['platform/gateways/memory-pet', 'the test double, which must never be a production entry'],
      ['platform/gateways/tauri-pet', 'the host adapter, which the composition owns'],
      ['stores/', 'the editor window’s Pinia stores'],
      ['services/', 'the editor window’s services'],
      ['ui/', 'the application’s component library'],
    ]
    for (const [pattern, why] of forbidden) {
      expect(
        reachable.filter((file) => file.includes(pattern)),
        `the pet entry reaches ${pattern}: ${why}`,
      ).toEqual([])
    }
    expect(packagesFrom(ENTRY)).not.toContain('@nekowite/plugin-host')
    expect(packagesFrom(ENTRY)).not.toContain('@nekowite/editor-core')
  })

  it('is the entry for a page that declares exactly one mount point', () => {
    const html = readFileSync(join(APP, 'desktop-pet.html'), 'utf8')

    expect(html.match(new RegExp(`id="${DESKTOP_PET_ROOT_ID}"`, 'g'))).toHaveLength(1)
    expect(html.match(/<script/g)).toHaveLength(1)
    expect(html).toContain('src="/src/app/desktop-pet-entry.ts"')
    // A page that also loaded the editor's entry would be the second application §7.1 forbids,
    // and it would look like a one-line change to `desktop-pet.html`.
    expect(html).not.toContain('/src/main.ts')
  })
})

describe('the entry boots only where the pet page is, and states a missing host', () => {
  async function entry(): Promise<typeof import('./desktop-pet-entry')> {
    vi.resetModules()
    return import('./desktop-pet-entry')
  }

  it('mounts nothing in a page that is not its own', async () => {
    document.body.innerHTML = '<div id="app"></div>'
    const module = await entry()

    expect(document.querySelector('.pet-root')).toBeNull()
    expect(module.bootDesktopPet()).toBeNull()
  })

  it('mounts the pet when the page declares the mount point', async () => {
    document.body.innerHTML = ''
    const module = await entry()
    document.body.innerHTML = `<div id="${DESKTOP_PET_ROOT_ID}"></div>`

    const app = module.bootDesktopPet(() => ({
      gateway: createMemoryPetGateway({ visible: true }),
    }))
    await flush()

    expect(app).not.toBeNull()
    expect(document.querySelector('.pet-root')).not.toBeNull()
    app?.dispose()
  })

  it('renders a missing host connection as a fact rather than as an idle pet', async () => {
    document.body.innerHTML = ''
    const module = await entry()
    document.body.innerHTML = `<div id="${DESKTOP_PET_ROOT_ID}"></div>`

    const app = module.bootDesktopPet()
    await flush()

    // The composition that supplies the gateway is `S/app/desktop-pet-composition.ts` (§9, §10.1)
    // and it does not exist yet. This assertion is deliberately about the *shape* of "not wired":
    // it fails the day a gateway arrives, which is the day the absence stops being true, and it
    // fails just as loudly if one arrives here from somewhere that is not the host — a memory
    // gateway in the entry would make this window look finished while every task in it came from
    // a fixture.
    expect(app).not.toBeNull()
    expect(document.querySelector('.pet-root')).not.toBeNull()
    expect(document.querySelector('.pet-root__notice')?.textContent).toMatch(/host connection/i)
  })
})

/** One microtask turn plus a macrotask, which is what the lifecycle's first read needs. */
async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((done) => setTimeout(done, 0))
}
