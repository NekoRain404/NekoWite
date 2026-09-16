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
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { setLocale } from '../../../i18n'
import AgentSkillsSettings from './AgentSkillsSettings.vue'
import type {
  AgentSkillsReadout,
  SkillEntryView,
  SkillRefusal,
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

async function mount(skills: SkillEntryView[]): Promise<void> {
  const client = {
    read: async (): Promise<AgentSkillsReadout> => ({ skills, disabled: [] }),
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
