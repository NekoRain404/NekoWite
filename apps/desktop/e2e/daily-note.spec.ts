import { expect, test, type Page } from '@playwright/test'
import {
  NOTE_NAME,
  VAULT,
  diskFiles,
  openNote,
  showSource,
  sourceCaretToEnd,
} from './support/editorHarness'
import { repoFsUrl } from './support/repoFs'

/**
 * The sidebar's 新建每日笔记 shortcut, driven through the running application.
 *
 * §8 of the user guide promises two things about it: the note lands at
 * `daily/YYYY-MM-DD.md` for today, and a second press opens the note that is
 * already there instead of producing another one or writing over what the user
 * typed. Both promises are about the composition of a real run — the date the
 * browser clock supplies, the variables the service substitutes, and the tab
 * the shortcut focuses — so neither can be checked against a unit test's fixed
 * clock. The date is therefore read back from the application's own module
 * rather than re-derived here: a second copy of the date arithmetic would
 * agree with a broken shortcut.
 *
 * WHAT THE SHORTCUT WRITES: `services/note-templates.ts` renders
 * `DEFAULT_DAILY_TEMPLATE` — frontmatter, `# {{date}}` and a single `-` — not
 * the four-section 每日日记 template in `src/templates/daily.md`. That file is
 * the choosable template the picker offers; `docs/DOC-AUDIT.md:120` records
 * this exact divergence with §8 (a guide claim the code does not implement). The
 * cases below assert the note the button really produces, and the second
 * describe drives the picker's 每日日记 template so the four sections the guide
 * names are covered where they actually live.
 *
 * The shared harness's stub cannot host this flow: it answers `stat_file` for
 * EVERY path (so the shortcut would always take its "already exists" branch and
 * create nothing) and drops writes to paths it does not already know. The
 * overlay below models those commands, so the shortcut runs against a backend
 * that can answer "free", "created" and "taken" the way the real one does.
 */

/** The application's own template service, imported into the page by URL. */
const TEMPLATES_MODULE = repoFsUrl('apps', 'desktop', 'src', 'services', 'note-templates.ts')

/**
 * Text typed into the created note before the second press. An overwrite would
 * take it with it, which is the failure the third case exists to catch.
 */
const MARKER = 'E2E-DAILY-TYPED-TEXT'

/** The shortcut's i18n key, so the label is the application's own copy. */
const DAILY_ACTION_KEY = 'daily.new'

/** The picker's i18n key — the sidebar entry that opens the template list. */
const PICKER_ACTION_KEY = 'template.pickTitle'

interface DailyExpectation {
  /** `daily/YYYY-MM-DD.md` for today, under the vault the app has open. */
  path: string
  /** Today as the service spells it, `YYYY-MM-DD`. */
  dateKey: string
  /** The built-in daily template with today's variables substituted. */
  body: string
}

/** What the application computes for the note the shortcut is about to create. */
async function dailyExpectation(page: Page, vault: string): Promise<DailyExpectation> {
  return page.evaluate(
    async ({ moduleUrl, root }: { moduleUrl: string; root: string }) => {
      const mod = (await import(moduleUrl)) as unknown as {
        dailyNotePath(vault: string, date?: Date): string
        dailyDateKey(date: Date): string
        buildDailyVars(date?: Date, overrides?: Record<string, string>): Record<string, string>
        renderTemplate(template: string, vars: Record<string, string>): string
        DEFAULT_DAILY_TEMPLATE: string
      }
      // One clock reading for all three answers: one `new Date()` per function
      // would let a midnight boundary pair a path and a body from two days.
      const now = new Date()
      return {
        path: mod.dailyNotePath(root, now),
        dateKey: mod.dailyDateKey(now),
        body: mod.renderTemplate(mod.DEFAULT_DAILY_TEMPLATE, mod.buildDailyVars(now)),
      }
    },
    { moduleUrl: TEMPLATES_MODULE, root: vault },
  )
}

/** The `builtin:daily` entry the picker lists, and the body it would write. */
async function pickerDailyTemplate(
  page: Page,
  vault: string,
): Promise<{ name: string; body: string }> {
  return page.evaluate(
    async ({ moduleUrl, root }: { moduleUrl: string; root: string }) => {
      const mod = (await import(moduleUrl)) as unknown as {
        DEFAULT_TEMPLATES: Array<{ name: string; path: string }>
        readTemplate(vault: string, entry: { name: string; path: string }): Promise<string>
      }
      const entry = mod.DEFAULT_TEMPLATES.find((item) => item.path === 'builtin:daily')
      if (!entry) throw new Error('the app no longer ships a builtin:daily template')
      return { name: entry.name, body: await mod.readTemplate(root, entry) }
    },
    { moduleUrl: TEMPLATES_MODULE, root: vault },
  )
}

interface OpenNotes {
  /** Every open tab's path, in tab order. */
  paths: string[]
  activePath: string | null
  activeId: string | null
  activeContent: string
  /** The vault the app has open, and the root every path above is under. */
  vault: string | null
}

/** The open notes, read out of the application's own tab store. */
function openNotes(page: Page): Promise<OpenNotes> {
  return page.evaluate(async () => {
    const mod = (await import('/src/stores/tabs.ts')) as unknown as {
      useTabsStore(): {
        vault: string | null
        tabs: Array<{ id: string; path: string | null }>
        activeTab: { id: string; path: string | null; content: string } | null
      }
    }
    const store = mod.useTabsStore()
    return {
      paths: store.tabs.map((tab) => tab.path ?? ''),
      activePath: store.activeTab?.path ?? null,
      activeId: store.activeTab?.id ?? null,
      activeContent: store.activeTab?.content ?? '',
      vault: store.vault,
    }
  })
}

/** A label the application itself owns, read from its i18n module. */
function label(page: Page, key: string): Promise<string> {
  return page.evaluate(async (k) => {
    const mod = (await import('/src/i18n/index.ts')) as unknown as { t(key: string): string }
    return mod.t(k)
  }, key)
}

/** Press a sidebar quick action the way a user does: by its visible label. */
async function pressSidebarAction(page: Page, i18nKey: string): Promise<void> {
  const name = await label(page, i18nKey)
  await page.locator('.sidebar').getByRole('button', { name, exact: true }).click()
}

/** What the overlay below was asked, at the IPC boundary the app writes through. */
interface DailyFsProbe {
  /** Paths passed to `stat_file`, in call order. */
  stats: string[]
  /** Paths passed to the create-only `create_new_file`, in call order. */
  creates: string[]
}

function dailyFsProbe(page: Page): Promise<DailyFsProbe> {
  return page.evaluate(
    () =>
      (window as unknown as { __DAILY_FS_PROBE__?: DailyFsProbe }).__DAILY_FS_PROBE__ ?? {
        stats: [],
        creates: [],
      },
  )
}

/**
 * Give the booted harness a vault that can host the daily flow.
 *
 * Only the daily flow's commands are overridden; everything else is forwarded
 * to the harness's stub, so the note the boot opened keeps behaving exactly as
 * the other suites expect.
 */
async function installDailyVault(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>
        }
      }
    ).__TAURI_INTERNALS__
    const base = internals.invoke.bind(internals)
    // The harness's own vault, so the overlay never shadows the note the boot
    // opened (a `stat_file` on it must still succeed).
    const seeded = (await base('__disk_dump', {})) as Record<string, string>
    const created = new Map<string, string>()
    const probe: DailyFsProbe = { stats: [], creates: [] }
    ;(window as unknown as { __DAILY_FS_PROBE__?: DailyFsProbe }).__DAILY_FS_PROBE__ = probe

    const exists = (path: string) =>
      created.has(path) || Object.prototype.hasOwnProperty.call(seeded, path)

    internals.invoke = async (cmd, args = {}) => {
      const path = typeof args.path === 'string' ? args.path : ''
      if (cmd === 'create_new_file') {
        probe.creates.push(path)
        // The backend's create-only contract, including the `EEXIST: ` prefix
        // `platform/create-new-file.ts` reads as "the name is taken".
        if (exists(path)) throw new Error(`EEXIST: ${path}`)
        created.set(path, String(args.content ?? ''))
        return undefined
      }
      if (cmd === 'create_dir') return path
      if (cmd === 'stat_file') {
        probe.stats.push(path)
        // The shared stub answers for every path, which would tell the
        // shortcut the day's note is already there. A real backend has no stat
        // for a file that does not exist.
        if (exists(path)) return { size: 1, mtime: 1 }
        throw new Error(`no such file: ${path}`)
      }
      if (cmd === 'read_file') {
        if (created.has(path)) return created.get(path)
        return await base(cmd, args)
      }
      if (cmd === 'write_file') {
        // Saving a created note goes through the replacing write, which the
        // stub drops for any path it does not already know.
        if (created.has(path)) {
          created.set(path, String(args.content ?? ''))
          return undefined
        }
        return await base(cmd, args)
      }
      if (cmd === '__disk_dump') {
        // The bytes the app persisted, created files included, so `diskFiles()`
        // answers for the whole vault.
        const dump = (await base(cmd, args)) as Record<string, string>
        return { ...dump, ...Object.fromEntries(created) }
      }
      return await base(cmd, args)
    }
  })
}

/** Boot the app and open the harness note, with a daily-capable vault. */
async function bootWithDailyVault(
  page: Page,
): Promise<{ vault: string; expected: DailyExpectation }> {
  await openNote(page, {})
  await installDailyVault(page)
  const { vault } = await openNotes(page)
  if (!vault) throw new Error('the app booted with no vault open')
  return { vault, expected: await dailyExpectation(page, vault) }
}

test.describe('the 新建每日笔记 shortcut', () => {
  test('creates the daily note at the path the service computes', async ({ page }) => {
    const { vault, expected } = await bootWithDailyVault(page)
    expect((await openNotes(page)).paths).toEqual([`${VAULT}/${NOTE_NAME}`])

    // The layout the guide documents, composed from the service's own date
    // value. The day and its zero padding are the service's answer (never
    // re-derived here), but the `daily/YYYY-MM-DD.md` spelling is the promise,
    // so a filename format that drifts from the date key fails on this line.
    expect(expected.path).toBe(`${vault}/daily/${expected.dateKey}.md`)

    await pressSidebarAction(page, DAILY_ACTION_KEY)

    // The path the app asked its backend to create — the one `dailyNotePath`
    // computes for today, not a spelling this spec derived.
    await expect.poll(async () => (await dailyFsProbe(page)).creates).toEqual([expected.path])
    // And the note it opened is that file.
    await expect.poll(async () => (await openNotes(page)).activePath).toBe(expected.path)

    const after = await openNotes(page)
    expect(after.paths).toEqual([`${VAULT}/${NOTE_NAME}`, expected.path])
    expect(after.activeContent, 'the tab does not show the note it just created').toContain(
      expected.dateKey,
    )
    expect(Object.keys(await diskFiles(page))).toContain(expected.path)
  })

  test('the created body is the built-in daily template with its variables interpolated', async ({
    page,
  }) => {
    const { expected } = await bootWithDailyVault(page)

    await pressSidebarAction(page, DAILY_ACTION_KEY)
    await expect.poll(async () => (await diskFiles(page))[expected.path]).toBeTruthy()
    const body = (await diskFiles(page))[expected.path]

    // A placeholder the variable map does not cover is kept verbatim by
    // `renderTemplate`, and only a real run shows what the real clock
    // interpolated. This is the assertion a template variable added without a
    // matching entry in `buildDailyVars` fails.
    //
    // The body asserted here is `DEFAULT_DAILY_TEMPLATE` — frontmatter,
    // `# {{date}}` and one `-`. The four sections the guide's §8 lists (今日焦点,
    // 时间安排, 今日记录, 今日复盘) are NOT written by this shortcut; they belong
    // to the picker's 每日日记 template, which the case at the end of this file
    // drives instead of pretending this one produces them.
    expect(body).not.toContain('{{')
    expect(body).toContain(expected.dateKey)
    // The body, not merely its shape: the application's own template rendered
    // with the application's own variables.
    expect(body).toBe(expected.body)

    // The tab the shortcut opened shows the interpolated text, not the
    // template. It is NOT compared byte for byte with the file: loading the
    // markdown into the editor re-serializes the empty bullet as `- <br />`
    // (an editor representation of the same document, and the reason this
    // assertion is about what the note says rather than its exact bytes).
    const shown = (await openNotes(page)).activeContent
    expect(shown).toContain(expected.dateKey)
    expect(shown).not.toContain('{{')
  })

  test('a second press opens the same note and keeps the text typed into it', async ({ page }) => {
    const { expected } = await bootWithDailyVault(page)

    await pressSidebarAction(page, DAILY_ACTION_KEY)
    await expect.poll(async () => (await openNotes(page)).activePath).toBe(expected.path)

    // Type into the note the shortcut created and save it, so an overwrite on
    // the second press has something to destroy — and destroys it in the file,
    // not only in the buffer.
    await showSource(page)
    await sourceCaretToEnd(page)
    await page.keyboard.press('Enter')
    await page.keyboard.type(MARKER)
    await page.keyboard.press('Control+s')
    await expect.poll(async () => (await diskFiles(page))[expected.path]).toContain(MARKER)
    const typed = (await diskFiles(page))[expected.path]
    const before = await openNotes(page)
    expect(before.activePath).toBe(expected.path)
    const statsBefore = (await dailyFsProbe(page)).stats.length

    await pressSidebarAction(page, DAILY_ACTION_KEY)

    // The press reached the backend's "does it exist?" question...
    await expect
      .poll(async () => (await dailyFsProbe(page)).stats.length)
      .toBeGreaterThan(statsBefore)
    // ...and created nothing: a second file (`daily/<date>-1.md`) would appear
    // as another create call, an overwrite as changed bytes below.
    expect((await dailyFsProbe(page)).creates).toEqual([expected.path])

    const after = await openNotes(page)
    expect(after.paths, 'the second press opened another note').toEqual(before.paths)
    expect(after.activeId, 'the second press replaced the tab instead of focusing it').toBe(
      before.activeId,
    )
    expect(after.activeContent).toContain(MARKER)

    const diskAfter = await diskFiles(page)
    const dailyDir = expected.path.slice(0, expected.path.lastIndexOf('/') + 1)
    expect(Object.keys(diskAfter).filter((path) => path.startsWith(dailyDir))).toEqual([
      expected.path,
    ])
    expect(diskAfter[expected.path]).toBe(typed)
  })
})

/**
 * The template §8 attributes to the shortcut.
 *
 * The four sections live in the picker's 每日日记 entry, so this drives that
 * entry — the sidebar's 从模板新建 shortcut — rather than the daily one, and
 * asserts the note it produces. Without this, a reading of the guide would
 * believe the daily button writes these sections; the case above shows what it
 * really writes.
 */
test.describe('the 每日日记 picker template', () => {
  test('carries the four sections the guide names', async ({ page }) => {
    const { vault } = await bootWithDailyVault(page)
    const template = await pickerDailyTemplate(page, vault)
    // Read from the app's own template file, so the case cannot pass by
    // finding nothing: every `##` section the template has must reach the note.
    const sections = template.body.match(/^## .+$/gm) ?? []
    expect(sections.length, 'the built-in daily template has no sections').toBeGreaterThan(0)

    await pressSidebarAction(page, PICKER_ACTION_KEY)
    await page.locator('.template-option', { hasText: template.name }).first().click()

    // The note's path is read from the app rather than spelled here: this case
    // is about the body, and the picker's own name for the file is not part of
    // what the guide promises.
    await expect.poll(async () => (await openNotes(page)).paths.length).toBe(2)
    const path = (await openNotes(page)).activePath
    if (!path) throw new Error('the picker created no note')
    const body = (await diskFiles(page))[path]
    expect(body, `the picker wrote no note at ${path}`).toBeTruthy()

    expect(body).not.toContain('{{')
    for (const section of sections) {
      expect(body, `the note is missing the template section ${section}`).toContain(section)
    }
    // The template's own frontmatter, two lines the guide names by value.
    expect(body).toContain('type: daily')
    expect(body).toContain('tags: [daily]')
  })
})
