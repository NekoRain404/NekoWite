/**
 * §8.2's page, and the one distinction this file exists to hold: a directory the engine's rules name
 * and a directory this launch actually reads are two facts.
 *
 * The app-managed launch sets `OPENCODE_DISABLE_EXTERNAL_SKILLS`, so the two compatible-tool
 * directories are *configured* and contribute nothing. The page has to say both — §8.2 asks for the
 * 来源目录 and the 实际权限状态, so a row is not hidden for being unread — and the failure this file
 * is written against is the flattering one: a page that told a user "this launch does not set that
 * variable" while it did, which is exactly what a single sentence keyed on the *row's* surface said
 * before the scope's own state was carried beside it.
 *
 * The three cases are the three combinations that come apart in practice: a scope the launch
 * switched off, the same scope with a skill whose frontmatter is unusable (the row's surface then
 * says nothing about the directory, which is why `suppressedBy` is a field of its own), and a scope
 * no switch is set for.
 *
 * ## The other half: what the page says instead of drawing something
 *
 * The second group is §5.2's 「不可用选项要说明原因，不显示可点击但无效果的控件」, and every case in it
 * is a control that would otherwise be drawn and could not work: a directory with no skills (its
 * own sentence, per directory, rather than one sentence for the page), a directory this launch is
 * not reading (the switch's sentence, not "no skills"), a project's own skills and the engine's
 * declared `skills.paths` (both stated with their reason and drawn as nothing at all), an import
 * with nowhere to install (the form is not drawn), and a read the backend refused (the reason, and
 * no retry — a retry would be a control that cannot change the arrangement it is refusing).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { setLocale } from '../../../i18n'
import AgentSkillsSettings from './AgentSkillsSettings.vue'
import type {
  AgentSkillsReadout,
  SkillEntryView,
  SkillRefusal,
  SkillScopeView,
} from './AgentSkillsSettings.vue'

const SET = 'OPENCODE_DISABLE_EXTERNAL_SKILLS'
const WOULD_CLOSE = 'OPENCODE_DISABLE_CLAUDE_CODE_SKILLS'

let mounted: VueApp[] = []

beforeEach(() => {
  setLocale('en')
  document.body.innerHTML = ''
  mounted = []
})

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
  document.body.innerHTML = ''
})

/** One row of the readout, with everything but the two facts under test already decided. */
function entry(overrides: Partial<SkillEntryView>): SkillEntryView {
  return {
    name: 'planted',
    description: 'a skill',
    directory: '/profile/HOME/.claude/skills/planted',
    scope: 'claude-code',
    scopeLabel: "Another tool's directory (.claude)",
    owner: 'foreign',
    conflicts: [],
    surface: { kind: 'suppressed', variable: SET },
    suppressedBy: SET,
    disable: { kind: 'engine-switch', variable: WOULD_CLOSE },
    ...overrides,
  }
}

/** One directory of the scope list, as `agent_skills_read` answers it. */
function scope(overrides: Partial<SkillScopeView>): SkillScopeView {
  return {
    id: 'claude-code',
    label: "Another tool's directory (.claude)",
    root: '/profile/HOME/.claude/skills',
    suppressedBy: SET,
    ...overrides,
  }
}

/**
 * Mount the page over a readout.
 *
 * The scope list defaults to the one directory the rows in these cases live in, because a readout
 * that named no directory at all is its own case below: the page then draws the row under the
 * label the row carries, which is the arm that keeps a skill from disappearing when a page cannot
 * find its heading.
 */
async function mount(
  skills: SkillEntryView[],
  overrides: Partial<AgentSkillsReadout> = {},
  read?: () => Promise<AgentSkillsReadout | SkillRefusal>,
): Promise<void> {
  const client = {
    read:
      read ??
      (async (): Promise<AgentSkillsReadout> => ({
        scopes: [scope({})],
        skills,
        disabled: [],
        importScope: 'engine-global',
        ...overrides,
      })),
    preview: async (): Promise<SkillRefusal> => ({ kind: 'missing', path: 'unused' }),
    import: async (): Promise<SkillRefusal | null> => null,
    setEnabled: async (): Promise<SkillRefusal | null> => null,
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(AgentSkillsSettings, { client })
  mounted.push(app)
  app.mount(host)
  await nextTick()
  await nextTick()
}

function row(name: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-test="skill-row-${name}"]`)
  if (!found) throw new Error(`the page drew no row for ${name}`)
  return found
}

function el(dataTest: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-test="${dataTest}"]`)
}

/** The scope's own note, which is what stands where a control would be. */
function note(name: string): string {
  return row(name).querySelector<HTMLElement>('[data-test="skill-no-switch"]')?.textContent ?? ''
}

describe('the skills page, where a scope is configured and where it contributes', () => {
  it('keeps listing a directory the launch does not read, and says which switch is set', async () => {
    await mount([entry({})])

    const html = row('planted')
    // Configured: the row is there, with the scope and the directory a user would recognise.
    expect(html.textContent).toContain("Another tool's directory (.claude)")
    expect(html.textContent).toContain('/profile/HOME/.claude/skills/planted')
    // Contributing: it is not, and the row says so in the engine's own terms.
    expect(html.querySelector('[data-surface]')?.getAttribute('data-surface')).toBe('suppressed')
    expect(html.textContent).toContain(SET)
    // And the absence of a control is explained by the launch, not by a claim the app does not set
    // the variable — which is the sentence that was false for every app-managed profile.
    expect(note('planted')).toContain('this launch sets it')
    expect(note('planted')).not.toContain('does not set that variable')
  })

  it('reports the scope from the scope when the skill itself cannot be used', async () => {
    // A broken SKILL.md makes the *row* unusable, which says nothing about whether the directory
    // is read. A page inferring suppression from the surface would fall silent here — and silence
    // beside a skill name reads as "the engine is being offered this".
    const unusable: SkillRefusal = { kind: 'no-frontmatter', path: '/profile/HOME/.claude/skills/broken/SKILL.md' }
    await mount([entry({ name: 'broken', surface: { kind: 'unusable', error: unusable } })])

    expect(row('broken').querySelector('[data-surface]')?.getAttribute('data-surface')).toBe('unusable')
    expect(note('broken')).toContain('this launch sets it')
    expect(note('broken')).not.toContain('does not set that variable')
  })

  it('names the switch that would close a directory no switch is set for', async () => {
    // A profile reusing the user's own configuration injects nothing, so the app-managed launch's
    // switch is not in that engine's environment. The honest sentence there is the other one.
    await mount([
      entry({
        surface: { kind: 'offered' },
        suppressedBy: null,
      }),
    ])

    expect(row('planted').textContent).toContain(WOULD_CLOSE)
    expect(note('planted')).toContain('This launch does not set that variable')
    expect(note('planted')).not.toContain('this launch sets it')
  })
})

describe('what the page says instead of drawing a control', () => {
  it('gives each directory its own empty sentence, and never calls an unread one empty', async () => {
    // Three directories, one of them read and empty, one of them not read at all. "The engine finds
    // no skills" is a claim about a directory's contents, and a page that made it for a directory
    // the engine has stopped reading would be answering a question nobody asked.
    await mount([], {
      scopes: [
        scope({ id: 'engine-global', label: "This app's profile, read by the engine", root: '/profile/XDG_CONFIG_HOME/skills', suppressedBy: null }),
        scope({ id: 'claude-code' }),
        scope({ id: 'agents-directory', suppressedBy: null }),
      ],
      importScope: 'engine-global',
    })

    expect(el('skill-scope-empty-engine-global')?.textContent).toContain('no skills in this directory')
    expect(el('skill-scope-empty-agents-directory')?.textContent).toContain('no skills in this directory')
    // The scope this launch stopped the engine reading says that instead — the same sentence the
    // rows in it would carry, with the engine's own variable named.
    expect(el('skill-scope-unread-claude-code')?.textContent).toContain(SET)
    expect(el('skill-scope-empty-claude-code')).toBeNull()
  })

  it('states the project scope and the declared paths, and draws no control for either', async () => {
    // §5.2. Both are absent for a reason the backend really has, and the sentence carries it: a
    // project needs a folder this dialog does not have, and `skills.paths` lives in a document
    // this page does not parse. Nothing inside the block is a control — a greyed one would be a
    // claim that the capability exists and is temporarily off.
    await mount([])

    expect(el('skills-project-scope')?.textContent).toContain('.opencode/skills')
    expect(el('skills-project-scope')?.textContent).toContain('which project')
    expect(el('skills-declared-scope')?.textContent).toContain('skills.paths')
    const block = el('skills-unmanaged')
    expect(block?.querySelectorAll('input, button, select, [role="switch"]').length).toBe(0)
  })

  it('draws the import form only where there is a directory this host may write in', async () => {
    // A profile reusing the user's installation has none, so the form's only possible outcome
    // would be a refusal. The sentence says what such a profile would need instead.
    await mount([], { importScope: null })
    expect(el('skills-no-import')?.textContent).toContain('nothing here to import into')
    expect(el('skills-source')).toBeNull()
    expect(el('skills-preview')).toBeNull()
  })

  it('names the directory an import would land in', async () => {
    await mount([], {
      scopes: [
        scope({
          id: 'engine-global',
          label: "This app's profile, read by the engine",
          root: '/profile/XDG_CONFIG_HOME/skills',
          suppressedBy: null,
        }),
      ],
      importScope: 'engine-global',
    })

    expect(el('skills-source')).not.toBeNull()
    const form = el('skills-source')?.closest('.skills-import')
    expect(form?.textContent).toContain('/profile/XDG_CONFIG_HOME/skills')
  })

  it('renders a refused read as its reason, and offers no retry for it', async () => {
    // The backend answered: the arrangement it would have to run under is one this host refuses.
    // A retry would be a control that cannot change the arrangement, and the page's "could not be
    // read from the backend" would be a claim about the connection instead.
    await mount([], {}, async (): Promise<SkillRefusal> => ({ kind: 'store-inside-scope', path: '/profile/skills-store', scope: 'engine-global' }))

    expect(el('skills-refused')?.textContent).toContain('would still be found')
    expect(el('skills-retry')).toBeNull()
    expect(el('skills-unreadable')).toBeNull()
  })
})
