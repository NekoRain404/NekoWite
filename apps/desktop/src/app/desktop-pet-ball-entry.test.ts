/**
 * The ball window's isolation, as an assertion about the build rather than a paragraph about it.
 *
 * The ball is the pet's *second* window, and the two are opposites on the axis §7.2 is about: the
 * character window is click-through whenever it has nothing for the pointer, and the ball is a
 * stable click target that exists to be clicked. So the same clause §7.1 states for the pet entry
 * — 「入口只初始化桌宠」 — has a second, sharper edge here: **`usePetClickThrough` must not be
 * reachable from this page**, because a composable that can turn this window's input region off
 * would turn the ball into the one thing it must not be. That is asserted by name below, and the
 * whole reachable list is compared with one somebody chose for the same reason the pet's is: it
 * fails on additions, and the fix for a new entry is to write down why the ball needs it.
 *
 * The walk is `desktop-pet-entry.test.ts`'s, deliberately: two pages with two different rules are
 * exactly where a copied-and-diverged walker would start lying.
 */
import { describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { createMemoryPetGateway } from '../platform/gateways/memory-pet'
import { DESKTOP_PET_BALL_ROOT_ID } from './desktop-pet-ball-entry'

const APP = resolve(__dirname, '..', '..')
const SRC = resolve(__dirname, '..')
const ENTRY = resolve(__dirname, 'desktop-pet-ball-entry.ts')

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
 * `import type` / `export type` statements are removed first — they are erased by TypeScript, so
 * what they name cannot reach the window, and the ball reads three of its dependencies as types
 * alone (`PetWindowGateway`, `PetBallPlatform`, the sprite seams). A mixed import is not removed,
 * because part of it does survive.
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

/** Where a relative specifier points, or null when it leaves this source tree. */
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

describe('the ball entry is one orb and not the character window', () => {
  it('reaches this much and no more', () => {
    // The orb, the sprite it wears, the drawing pipeline D2 ported, the appearance read D8/D12
    // wired, and the two stylesheets that make it follow the host's theme.
    expect(reachableFrom(ENTRY)).toEqual([
      'app/desktop-pet-composition.ts',
      'features/desktop-pet/components/PetBallWindow.vue',
      'features/desktop-pet/components/PetFloatingBall.vue',
      'features/desktop-pet/components/PetSprite.vue',
      'features/desktop-pet/composables/use-pet-drawing-failure.ts',
      'features/desktop-pet/rendering/animation-bindings.ts',
      // `PetSprite` carries the hit test D2 ported. Nothing calls it yet — the shell that would is
      // §7.2's 「角色可点区」, and `DesktopPetRoot.vue` records the same gap for the character
      // window — so this is a module in the orb's graph that no gesture of the orb reaches.
      'features/desktop-pet/rendering/sprite-hit-test.ts',
      'features/desktop-pet/rendering/sprite-player.ts',
      'features/desktop-pet/rendering/sprite-sheet.ts',
      'features/desktop-pet/rendering/sprite-slicer.ts',
      'features/desktop-pet/services/pet-appearance.ts',
      'features/desktop-pet/services/pet-ball-input.ts',
      // The drag, wired to the app's window controls rather than to the Tauri bridge. It arrives
      // through the composition — which both pet windows import — so a reader looking for why the
      // *character* window carries a drag adapter it does not use will find it here: the resolver
      // hands it to this page alone, and the import is what the two windows share.
      'features/desktop-pet/services/pet-ball-platform.ts',
      // A carry and **not** a call, which is the one thing worth saying about it here: the theme
      // reader arrived with the character window's own page (`pet-appearance.ts` resolves
      // `message.theme` through it), and this page reads that same appearance for its orb. The orb
      // draws no `--app-*` token at all — measured: `PetBallWindow.vue` names none — so nothing on
      // this page acts on the theme; the module is here because one read answers both windows.
      'features/desktop-pet/services/pet-bubble-theme.ts',
      'features/desktop-pet/services/pet-menu-actions.ts',
      'platform/gateways/pet-contracts.ts',
      'platform/gateways/pet-contracts/appearance.ts',
      // §8's 在线角色库, which arrived after this list was written: the contract's barrel re-exports
      // `isPetCatalogueReading` by value, so it is in every window the barrel reaches — this one
      // included, though the orb has no catalogue surface and calls no catalogue command. It is a
      // carry, not a call, and this line is where a reader can see that a new contract module
      // costs every pet window a little.
      'platform/gateways/pet-contracts/catalogue.ts',
      'platform/gateways/pet-contracts/config.ts',
      'platform/gateways/pet-contracts/events.ts',
      'platform/gateways/pet-contracts/platform.ts',
      'platform/gateways/pet-contracts/task.ts',
      'platform/gateways/tauri-pet.ts',
      // The app's own window controls, which `pet-ball-platform.ts` builds the drag on. It is the
      // module the whole application reaches the window API through (`platform/window.ts`'s own
      // rule), so this is one shared adapter rather than a pet-shaped second one.
      'platform/window.ts',
      'styles/palettes.css',
      'styles/tokens.css',
    ])
  })

  it('cannot be made click-through: the composable is not in this window', () => {
    // The separation stated as a check, because it is one import away from being undone and the
    // failure would be invisible: a ball with an empty input region receives no pointer events at
    // all, so nothing on screen could report that it had stopped being clickable. The host would
    // refuse the request anyway (the ball is not a character instance — `window_host.rs`), and
    // this is the half that keeps the window from asking.
    const reachable = reachableFrom(ENTRY)

    expect(reachable).not.toContain('features/desktop-pet/composables/use-pet-click-through.ts')
    expect(reachable.filter((file) => file.includes('click-through'))).toEqual([])
  })

  it('does not carry the character window, its bubble, its rows or its menu', () => {
    // The other direction, and the reason the ball has a page of its own rather than a branch in
    // `desktop-pet.html`: a launcher that carried the surface it launches would be the pet window
    // in a second window, with a second task subscription and a second bubble for every task.
    const reachable = reachableFrom(ENTRY)

    expect(reachable).not.toContain('features/desktop-pet/components/DesktopPetRoot.vue')
    expect(reachable).not.toContain('features/desktop-pet/components/PetBubble.vue')
    expect(reachable).not.toContain('features/desktop-pet/components/PetTaskList.vue')
    expect(reachable).not.toContain('features/desktop-pet/components/PetTaskRow.vue')
    expect(reachable).not.toContain('features/desktop-pet/components/PetContextMenu.vue')
    expect(reachable).not.toContain('features/desktop-pet/composables/use-pet-lifecycle.ts')
    expect(reachable).not.toContain('features/desktop-pet/composables/use-pet-window.ts')
    // The feature's public entry carries the care surface; §7.1's isolation sends this page
    // through the two deep imports it actually needs instead.
    expect(reachable).not.toContain('features/desktop-pet/index.ts')
    expect(reachable.filter((file) => file.includes('pet-care'))).toEqual([])
    // And the settings *pages*, which are the main window's: the ball asks the host to raise them.
    expect(reachable.filter((file) => file.includes('desktop-pet-settings'))).toEqual([])
  })

  it('cannot reach the application, its editor, its index or its agent client', () => {
    const reachable = reachableFrom(ENTRY)
    const forbidden: [string, string][] = [
      ['app/app-bootstrap', 'the app runtime: vault registry, index, file watcher, AI client'],
      ['app/app-lifecycle', 'the editor window’s teardown'],
      ['appAppShell', 'the application shell'],
      ['App.vue', 'the editor window’s root'],
      ['features/settings', 'the settings application'],
      ['features/editor', 'the editor'],
      ['i18n', 'the whole dictionary — §10.1 adds a pet namespace instead'],
      ['platform/gateways/index', 'every gateway, not only the pet one'],
      ['platform/gateways/memory-pet', 'the test double, which must never be a production entry'],
      ['tauri-agent', 'the agent adapter — this window runs no session'],
      ['^stores/', 'the editor window’s Pinia stores'],
      ['^services/', 'the editor window’s services'],
      ['^ui/', 'the application’s component library'],
    ]
    for (const [pattern, why] of forbidden) {
      expect(
        reachable.filter((file) => new RegExp(pattern).test(file)),
        `the ball entry reaches ${pattern}: ${why}`,
      ).toEqual([])
    }
    // `@tauri-apps/api/window` arrived with the ball's drag: `platform/window.ts` is the one module
    // in this app that imports it, and the orb needs one call from it. Still four packages and no
    // more — no framework, no editor, no agent client.
    expect(packagesFrom(ENTRY)).toEqual([
      '@tauri-apps/api/core',
      '@tauri-apps/api/event',
      '@tauri-apps/api/window',
      'vue',
    ])
  })

  it('is a build entry, so the page exists in a packaged app', () => {
    // The dev server serves any file under the project root; a *build* emits only the inputs the
    // config names, and a window whose page was never emitted loads a blank frame in exactly the
    // packaged app this ships in. Read as text rather than imported, like the pet's own check.
    const config = readFileSync(join(APP, 'vite.config.ts'), 'utf8')
    const input = /input:\s*\{([\s\S]*?)\n\s*\}/.exec(config)?.[1] ?? ''

    expect(input).toMatch(
      /['"]desktop-pet-ball['"]:\s*fileURLToPath\(new URL\('desktop-pet-ball\.html'/,
    )
  })

  it('is the entry for a page that declares exactly one mount point', () => {
    const html = readFileSync(join(APP, 'desktop-pet-ball.html'), 'utf8')

    expect(html.match(new RegExp(`id="${DESKTOP_PET_BALL_ROOT_ID}"`, 'g'))).toHaveLength(1)
    expect(html.match(/<script/g)).toHaveLength(1)
    expect(html).toContain('src="/src/app/desktop-pet-ball-entry.ts"')
    // The character window's page, and the editor's, are both the wrong window.
    expect(html).not.toContain('/src/app/desktop-pet-entry.ts')
    expect(html).not.toContain('/src/main.ts')
  })
})

describe('the ball entry boots only where its page is', () => {
  async function entry(): Promise<typeof import('./desktop-pet-ball-entry')> {
    vi.resetModules()
    return import('./desktop-pet-ball-entry')
  }

  it('mounts nothing in a page that is not its own', async () => {
    document.body.innerHTML = '<div id="desktop-pet"></div>'
    const module = await entry()

    expect(document.querySelector('.pet-ball')).toBeNull()
    expect(module.bootDesktopPetBall()).toBeNull()
  })

  it('mounts the orb when the page declares the mount point', async () => {
    document.body.innerHTML = ''
    const module = await entry()
    document.body.innerHTML = `<div id="${DESKTOP_PET_BALL_ROOT_ID}"></div>`

    const app = module.bootDesktopPetBall(() => ({
      connection: createMemoryPetGateway({ visible: true }),
    }))
    await flush()

    expect(app).not.toBeNull()
    const orb = document.querySelector('.pet-ball__orb')
    expect(orb).not.toBeNull()
    // The ball is a real control, not a painted image: it is a button with a name, and it says
    // what its two gestures do (§7.2's keyboard reach included).
    expect(orb?.getAttribute('aria-label')).toBe('Desktop pet ball')
    expect(orb?.getAttribute('title')).toMatch(/Right-click: settings/)
    app?.dispose()
  })

  it('draws the plain orb for a page with no host behind it', async () => {
    document.body.innerHTML = ''
    const module = await entry()
    document.body.innerHTML = `<div id="${DESKTOP_PET_BALL_ROOT_ID}"></div>`

    // A happy-dom page has no `__TAURI_INTERNALS__`, so the composition answers `undefined` rather
    // than handing over D1's memory double: a fixture-backed ball would make this window look
    // finished while every character in it came from a double. Upstream's own ball was an orb with
    // no character in it, which is exactly what is left.
    const app = module.bootDesktopPetBall()
    await flush()

    expect(app).not.toBeNull()
    expect(document.querySelector('.pet-ball__orb')).not.toBeNull()
    expect(document.querySelector('.pet-ball__face')).toBeNull()
    app?.dispose()
  })
})

/** One microtask turn plus a macrotask, which is what the appearance read needs. */
async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((done) => setTimeout(done, 0))
}
