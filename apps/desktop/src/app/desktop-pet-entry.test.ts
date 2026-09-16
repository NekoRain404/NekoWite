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
    // layers.
    //
    // Three entries were added when the composition landed (D12), each with the reason the clause
    // asks for:
    //   - `app/desktop-pet-composition.ts` — §10.1's assembly point, and the only thing that
    //     decides what this window talks to;
    //   - `platform/gateways/tauri-pet.ts` — the adapter it chooses, which is `invoke`/`listen`
    //     and no application;
    //   - `features/desktop-pet/services/pet-menu-actions.ts` — the three menu actions.
    //
    // **Nine more landed with the window's own wiring, and one of them changes a claim this test
    // used to make.** The window now draws the character the settings name and the reminder a
    // finished task produces, so what it carries is:
    //   - the task surface — `PetBubble.vue`, `PetTaskList.vue`, `PetTaskRow.vue`,
    //     `PetContextMenu.vue` and the three services behind them (`pet-bubble-layout`,
    //     `pet-message-template`, `pet-context-menu`), which is D9's port of the bubble. Without
    //     it a task could arrive and have nowhere to appear;
    //   - `composables/use-pet-window.ts` and `services/pet-appearance.ts` — the appearance read
    //     and the aggregate mood, which are this window's own wiring and nothing else's;
    //   - **`platform/gateways/pet-contracts*` — the five contract modules, by value.** This is
    //     the change: the window used to import the contract with `import type` only, so it
    //     carried the shapes as nothing at all. The mood is `pet-task-view.ts`'s, and it is *not*
    //     restated here: it reads the contract's own `PET_ALERT_BY_STATE` and `isPetTaskSettled`,
    //     which is what keeps a state added to D1's union from leaving a display rule that means
    //     something else (§9's one-truth rule). What that costs is three small constant tables in
    //     a window that has no editor, index or agent client — and what the alternative costs is a
    //     second copy of the state table, which is the defect this repository names everywhere
    //     else. The bubble's layout reads `PET_SETTINGS_DEFAULTS.message` for the same reason.
    //   - `pet-contracts/appearance.ts` joined the runtime half with the window's own read:
    //     `isPetAppearance` is a value, and it is the check that keeps an answer which is not an
    //     appearance — a browser build's `undefined` for a command its stub does not know — from
    //     being read for a `status` while the window renders. It lives in the contract because the
    //     adapter and the window both need it, and `platform/` may not reach into `features/`.
    //
    // **And the feature's public entry is deliberately *not* in this list.** `features/desktop-pet/index.ts`
    // is where outside callers go (§13.11) — the settings page takes the care panel from it — and
    // reaching it from here would put the whole of it in this window: the care panel, its rules,
    // and D1's contract *values* (the panel imports `PET_CARE_PANEL_LABELS` and friends by value,
    // so the contract stops being types-only the moment the barrel is in this graph). §7.1's
    // isolation is the stronger rule for this one page, so the entry imports the root component
    // and the composition imports the one service, both by path, with the reason written at each
    // import. That is the only place in this repository where a feature is reached by path, and
    // this list is what keeps it honest: the two deep imports are *here*, in the count, rather
    // than hidden behind a re-export.
    expect(reachableFrom(ENTRY)).toEqual([
      'app/desktop-pet-composition.ts',
      'features/desktop-pet/components/DesktopPetRoot.vue',
      'features/desktop-pet/components/PetBubble.vue',
      'features/desktop-pet/components/PetContextMenu.vue',
      'features/desktop-pet/components/PetSprite.vue',
      'features/desktop-pet/components/PetTaskList.vue',
      'features/desktop-pet/components/PetTaskRow.vue',
      'features/desktop-pet/composables/use-pet-lifecycle.ts',
      'features/desktop-pet/composables/use-pet-window.ts',
      'features/desktop-pet/rendering/animation-bindings.ts',
      'features/desktop-pet/rendering/sprite-hit-test.ts',
      'features/desktop-pet/rendering/sprite-player.ts',
      'features/desktop-pet/rendering/sprite-sheet.ts',
      'features/desktop-pet/rendering/sprite-slicer.ts',
      'features/desktop-pet/services/pet-appearance.ts',
      'features/desktop-pet/services/pet-bubble-layout.ts',
      'features/desktop-pet/services/pet-context-menu.ts',
      'features/desktop-pet/services/pet-menu-actions.ts',
      'features/desktop-pet/services/pet-message-template.ts',
      'features/desktop-pet/services/pet-task-view.ts',
      'platform/gateways/pet-contracts.ts',
      'platform/gateways/pet-contracts/appearance.ts',
      'platform/gateways/pet-contracts/config.ts',
      'platform/gateways/pet-contracts/events.ts',
      'platform/gateways/pet-contracts/platform.ts',
      'platform/gateways/pet-contracts/task.ts',
      'platform/gateways/tauri-pet.ts',
      'styles/palettes.css',
      'styles/tokens.css',
    ])
  })

  it('does not reach the feature’s public entry, which is where the care surface lives', () => {
    // The rule above stated as a check rather than as a paragraph, because the day somebody
    // "tidies" the path imports into one barrel import, this is the line that says what it
    // cost: `features/desktop-pet/index.ts` re-exports `PetCarePanel`, and the panel pulls its
    // rules in behind it.
    //
    // The *contract* modules are deliberately not refused here any more — the list above names
    // them and the reason they are carried. `care.ts` and `gateway.ts` are the two that stay out:
    // both are re-exported as types only, so the care surface's shape reaches this window as
    // nothing at all.
    const reachable = reachableFrom(ENTRY)

    expect(reachable).not.toContain('features/desktop-pet/index.ts')
    expect(reachable.filter((file) => file.includes('pet-care'))).toEqual([])
    expect(reachable).not.toContain('platform/gateways/pet-contracts/care.ts')
    expect(reachable).not.toContain('platform/gateways/pet-contracts/gateway.ts')
  })

  it('stops at the Tauri client and Vue', () => {
    // The other half of the walk: `reachableFrom` ignores anything that is not a relative path, so
    // a pet entry that imported `@milkdown/core` or `pinia` would be invisible to it. This is the
    // assertion that sees those.
    //
    // `@tauri-apps/api` is the window's host connection and nothing else — `invoke` and `listen`,
    // no plugin, no `@tauri-apps/plugin-notification`, no process control (§4 removes the second
    // quit path, and the ledger's dependency table is where each of those was decided).
    expect(packagesFrom(ENTRY)).toEqual(['@tauri-apps/api/core', '@tauri-apps/api/event', 'vue'])
  })

  it('cannot reach the application, its editor, its index or its agent client', () => {
    const reachable = reachableFrom(ENTRY)
    // Regular expressions against the path relative to `src/`, so the three that name a
    // *directory of the application* can be anchored at the root: the pet has a `services/`
    // directory of its own, and `includes` would have called `features/desktop-pet/services/` the
    // editor window's.
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
      ['platform/gateways/memory-del', 'any other double'],
      ['tauri-agent', 'the agent adapter — this window runs no session'],
      ['^stores/', 'the editor window’s Pinia stores'],
      ['^services/', 'the editor window’s services'],
      ['^ui/', 'the application’s component library'],
    ]
    for (const [pattern, why] of forbidden) {
      expect(
        reachable.filter((file) => new RegExp(pattern).test(file)),
        `the pet entry reaches ${pattern}: ${why}`,
      ).toEqual([])
    }
    expect(packagesFrom(ENTRY)).not.toContain('@nekowite/plugin-host')
    expect(packagesFrom(ENTRY)).not.toContain('@nekowite/editor-core')
  })

  it('is a build entry, so the page exists in a packaged app', () => {
    // §7.1's window loads this page. The dev server serves it from the project root whether or not
    // it is an entry — which is why this is about the *build* config: only the inputs named there
    // are emitted, and a window whose page was never emitted loads a blank frame in exactly the
    // packaged app the pet ships in.
    //
    // Read as text rather than imported, because the config cannot be evaluated here: it resolves
    // `./package.json` through `import.meta.url`, which is not a file URL under the test
    // transform. The assertion is deliberately narrow — the input map exists, it names both pages,
    // and the pet's page is the one the host opens — so a config that stopped declaring them fails
    // here rather than in a release.
    const config = readFileSync(join(APP, 'vite.config.ts'), 'utf8')
    const input = /input:\s*\{([\s\S]*?)\n\s*\}/.exec(config)?.[1] ?? ''

    expect(input).toMatch(/index:\s*fileURLToPath\(new URL\('index\.html'/)
    expect(input).toMatch(/['"]desktop-pet['"]:\s*fileURLToPath\(new URL\('desktop-pet\.html'/)
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

    // The dependency is the *window's* port — the gateway half, the appearance read, the click
    // route and the settings subscription — and the double implements all of it, so this is the
    // same object the composition hands over rather than a smaller one written here. (It used to
    // be `{ gateway }`: that was the shape before the window's own surface existed, and a double
    // that no longer satisfies the interface is the drift this project has been bitten by — it
    // kept passing because vitest strips types.)
    const app = module.bootDesktopPet(() => ({
      connection: createMemoryPetGateway({ visible: true }),
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
    // and it has landed — but a happy-dom page has no `__TAURI_INTERNALS__`, so there is no host
    // to connect to and the window says so. That is the assertion: the absence this window renders
    // is "there is no host here", which is true in a test runner and true in a browser build, and
    // which the composition answers by returning nothing rather than by handing over D1's memory
    // double — a fixture-backed pet would make this window look finished while every task in it
    // came from a double.
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
