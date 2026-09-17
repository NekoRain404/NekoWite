/**
 * The skills client: what it does with each answer `agent_skills.rs` can give.
 *
 * The wire literals below are the *shape* `read_skills` / `preview_skill` / `import_skill` /
 * `set_skill_enabled` serialize, written out by hand rather than derived from the Rust types,
 * because the coupling this file guards is between two processes: a renamed JSON field keeps every
 * Rust assertion green and would leave the page drawing a row with a blank directory or a surface
 * it cannot name.
 *
 * Four properties, one per group:
 *
 *  - **The pair is the client's, and every call carries it.** The scope list is built from *that
 *    profile's* roots, so a client built for one pair and asking about another is a page describing
 *    directories that are not the profile's.
 *  - **A refusal is data and a rejection is a throw.** The two channels are asserted from both
 *    sides: a refusal comes back as the kind plus its facts (and the facts are kept as they arrived,
 *    because the page's sentences interpolate them), and a shape this window cannot read rejects —
 *    which is the page's unreadable state rather than a refusal sentence about a skill.
 *  - **The read carries both channels.** A backend that refuses the arrangement itself answers the
 *    read with a refusal; a malformed readout rejects. Collapsing them would put "could not be read
 *    from the backend" over a backend that answered.
 *  - **The rows are checked, not cast.** Every field of a row is narrowed, including the two tagged
 *    unions — an arm the page does not know is a rejection rather than a row that renders as
 *    nothing.
 */

import { describe, expect, it } from 'vitest'

import { createAgentSkillsClient, type AgentSkillsWire } from './agent-skills-ipc'
import type {
  AgentSkillsReadout,
  SkillPreviewView,
  SkillRefusal,
} from '../components/AgentSkillsSettings.vue'

const AGENT = 'bundled-engine'
const PROFILE = 'default'

/** A row, as `skill_view` serializes one. */
function rowWire(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'demo',
    description: 'A demo skill.',
    directory: '/profile/XDG_CONFIG_HOME/skills/demo',
    scope: 'engine-global',
    scopeLabel: "This app's profile, read by the engine",
    owner: 'managed',
    conflicts: [],
    surface: { kind: 'offered' },
    suppressedBy: null,
    disable: { kind: 'per-skill' },
    ...overrides,
  }
}

/** A readout, as `readout()` serializes one for an app-managed profile. */
function readoutWire(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scopes: [
      {
        id: 'engine-global',
        label: "This app's profile, read by the engine",
        root: '/profile/XDG_CONFIG_HOME/skills',
        suppressedBy: null,
      },
      {
        id: 'claude-code',
        label: "Another tool's directory (.claude)",
        root: '/profile/HOME/.claude/skills',
        suppressedBy: 'OPENCODE_DISABLE_EXTERNAL_SKILLS',
      },
    ],
    skills: [rowWire()],
    disabled: [],
    importScope: 'engine-global',
    ...overrides,
  }
}

/** The wire, with every call recorded, over the answers a test hands it. */
function wire(answers: Partial<Record<keyof AgentSkillsWire, unknown>>): {
  port: AgentSkillsWire
  calls: { method: string; args: unknown[] }[]
} {
  const calls: { method: string; args: unknown[] }[] = []
  const answer = (method: string, args: unknown[], value: unknown): Promise<unknown> => {
    calls.push({ method, args })
    return Promise.resolve(value)
  }
  return {
    calls,
    port: {
      read: (...args) => answer('read', args, answers.read),
      preview: (...args) => answer('preview', args, answers.preview),
      import: (...args) => answer('import', args, answers.import),
      setEnabled: (...args) => answer('setEnabled', args, answers.setEnabled),
    },
  }
}

function client(answers: Partial<Record<keyof AgentSkillsWire, unknown>>): {
  skills: ReturnType<typeof createAgentSkillsClient>
  calls: { method: string; args: unknown[] }[]
} {
  const built = wire(answers)
  return { skills: createAgentSkillsClient({ skills: built.port, agentId: AGENT, profileId: PROFILE }), calls: built.calls }
}

describe('the skills client, over the window’s IPC', () => {
  it('reads the pair it was built for, and narrows the whole readout', async () => {
    const { skills, calls } = client({ read: readoutWire() })

    const readout = (await skills.read()) as AgentSkillsReadout
    expect(calls).toEqual([{ method: 'read', args: [AGENT, PROFILE] }])
    expect(readout.importScope).toBe('engine-global')
    expect(readout.scopes.map((scope) => scope.id)).toEqual(['engine-global', 'claude-code'])
    expect(readout.scopes[1].suppressedBy).toBe('OPENCODE_DISABLE_EXTERNAL_SKILLS')
    expect(readout.skills[0]).toMatchObject({
      name: 'demo',
      description: 'A demo skill.',
      scope: 'engine-global',
      owner: 'managed',
      surface: { kind: 'offered' },
      disable: { kind: 'per-skill' },
      suppressedBy: null,
    })
  })

  it('carries the two scopes that are not this host’s, with the fact each one turns on', async () => {
    // The row for a directory the launch stopped the engine reading, and the arm where the engine
    // could not use the skill at all: the surface's error is the same refusal vocabulary the page's
    // sentence table is keyed by, so it is narrowed here rather than passed through.
    const { skills } = client({
      read: readoutWire({
        skills: [
          rowWire({
            name: 'borrowed',
            scope: 'claude-code',
            owner: 'foreign',
            surface: { kind: 'suppressed', variable: 'OPENCODE_DISABLE_EXTERNAL_SKILLS' },
            suppressedBy: 'OPENCODE_DISABLE_EXTERNAL_SKILLS',
            disable: { kind: 'engine-switch', variable: 'OPENCODE_DISABLE_CLAUDE_CODE_SKILLS' },
          }),
          rowWire({
            name: 'broken',
            surface: { kind: 'unusable', error: { kind: 'name-mismatch', name: 'other', folder: 'broken' } },
          }),
        ],
      }),
    })

    const readout = (await skills.read()) as AgentSkillsReadout
    expect(readout.skills[0].surface).toEqual({
      kind: 'suppressed',
      variable: 'OPENCODE_DISABLE_EXTERNAL_SKILLS',
    })
    expect(readout.skills[0].disable).toEqual({
      kind: 'engine-switch',
      variable: 'OPENCODE_DISABLE_CLAUDE_CODE_SKILLS',
    })
    expect(readout.skills[1].surface).toEqual({
      kind: 'unusable',
      error: { kind: 'name-mismatch', name: 'other', folder: 'broken' },
    })
  })

  it('passes a refused read through as the refusal it is, not as a broken connection', async () => {
    // `store-inside-scope`: the backend answered, and what it says is that this host will not run
    // with its store inside a directory the engine scans. The page renders that sentence.
    const { skills } = client({
      read: { kind: 'store-inside-scope', path: '/profile/skills-store', scope: 'engine-global' },
    })

    const answer = (await skills.read()) as SkillRefusal
    expect(answer).toEqual({
      kind: 'store-inside-scope',
      path: '/profile/skills-store',
      scope: 'engine-global',
    })
  })

  it('rejects a shape it cannot read rather than drawing it', async () => {
    // A row with a surface this window does not know. "No skills are installed" is a claim about
    // the engine; this is a fact about the window, and the two lead to different next moves.
    const { skills } = client({ read: readoutWire({ skills: [rowWire({ surface: { kind: 'maybe' } })] }) })
    await expect(skills.read()).rejects.toThrow(/surface/)

    // And a fact the page's sentences interpolate may not be an object: a sentence with a hole in
    // it is what this whole table exists to prevent.
    const nested = client({ read: readoutWire({ importScope: { id: 'engine-global' } }) })
    await expect(nested.skills.read()).rejects.toThrow(/importScope/)
  })

  it('reads a folder with the pair and the path, and answers a preview as its own shape', async () => {
    const preview = {
      name: 'demo',
      description: 'A demo skill.',
      files: [
        { path: 'SKILL.md', bytes: 120 },
        { path: 'scripts/run.sh', bytes: 64 },
      ],
      scripts: [{ path: 'scripts/run.sh', bytes: 64 }],
      totalBytes: 184,
    }
    const { skills, calls } = client({ preview })

    const answer = (await skills.preview('/home/someone/incoming/demo')) as SkillPreviewView
    expect(calls).toEqual([{ method: 'preview', args: [AGENT, PROFILE, '/home/someone/incoming/demo'] }])
    expect(answer.scripts).toEqual([{ path: 'scripts/run.sh', bytes: 64 }])
    expect(answer.totalBytes).toBe(184)
  })

  it('answers a preview refusal with its facts, and an accepted import with null', async () => {
    const refused = client({ preview: { kind: 'name-mismatch', name: 'other', folder: 'demo' } })
    expect(await refused.skills.preview('/x')).toEqual({
      kind: 'name-mismatch',
      name: 'other',
      folder: 'demo',
    })

    const accepted = client({ import: null })
    expect(await accepted.skills.import('/home/someone/incoming/demo', false)).toBeNull()
    expect(accepted.calls).toEqual([
      { method: 'import', args: [AGENT, PROFILE, '/home/someone/incoming/demo', false] },
    ])

    // The confirmed second step is its own argument, and the client never invents it.
    const replacing = client({ import: null })
    await replacing.skills.import('/home/someone/incoming/demo', true)
    expect(replacing.calls[0].args[3]).toBe(true)
  })

  it('switches a skill by scope and name, and answers a refusal as data', async () => {
    const refused = client({
      setEnabled: { kind: 'no-such-skill', name: 'demo', scope: 'engine-global' },
    })
    expect(await refused.skills.setEnabled('demo', 'engine-global', false)).toEqual({
      kind: 'no-such-skill',
      name: 'demo',
      scope: 'engine-global',
    })
    // No directory anywhere in the call: what the backend moves is resolved from these two facts.
    expect(refused.calls).toEqual([
      { method: 'setEnabled', args: [AGENT, PROFILE, 'demo', 'engine-global', false] },
    ])
  })

  it('refuses a refusal kind this window has no sentence for', async () => {
    // The copy record is keyed by `SkillRefusalKind`, so an arm outside it would render as a blank
    // line. It is a rejection here, which the page answers with its own words.
    const { skills } = client({ import: { kind: 'something-new' } })
    await expect(skills.import('/x', false)).rejects.toThrow(/kind/)
  })

  it('does not swallow a refusal into a null answer', async () => {
    // `null` is the accepted arm and nothing else may become it: a client that turned a refusal
    // into `null` would tell the page an import happened that did not.
    const refused = client({ import: { kind: 'name-taken', name: 'demo', directory: '/x/demo' } })
    const answer = (await refused.skills.import('/x', false)) as SkillRefusal
    expect(answer.kind).toBe('name-taken')
    expect(answer).not.toBeNull()
  })

  it('never puts a value into a rejection’s message', async () => {
    // What a malformed answer holds is unknown by construction — that is the check that failed —
    // so the message names the field. A path or a name echoed here would be the one string in this
    // tree that travelled from a foreign process into a log line unmasked.
    const secret = '/home/someone/.ssh/id_ed25519'
    const { skills } = client({ read: readoutWire({ skills: [rowWire({ directory: secret, owner: 'SEKRIT' })] }) })
    await expect(skills.read()).rejects.toThrow(/owner/)
    await expect(skills.read()).rejects.not.toThrow(new RegExp(secret))
  })
})
