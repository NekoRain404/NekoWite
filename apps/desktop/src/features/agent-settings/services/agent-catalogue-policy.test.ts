/**
 * The catalogue's rules, as a pure module.
 *
 * What this file is for: the two negatives the catalogue exists to hold, decided somewhere the
 * drawing cannot argue with.
 *
 *  - **A catalogue entry says nothing about what an engine can do.** What an engine can do is
 *    established by a handshake and a session negotiation (§3.4's capability row), and a catalogue
 *    entry describes a process nobody has run. So there is no function in
 *    `agent-catalogue-policy.ts` that answers a capability question, and the tests below hold that
 *    as a *shape*: every capability name the report uses appears in
 *    {@link CATALOGUE_SAYS_NOTHING_ABOUT}, and the row type carries none of them.
 *  - **A row this build cannot act on gets no control** (「不能让按钮看起来可用、点击后才发现不支持」).
 *    `catalogueAction` answers `none` for three of the four standings, and the tests pin the three
 *    reasons apart — a download this app may not make, a machine this app cannot run on, and a
 *    distribution kind it cannot describe are three different things to do about.
 *
 * The wire reader is held here too, because the two files are one vocabulary and a renamed field is
 * the failure that reaches a page as a blank row: the last group drives
 * `createAgentCatalogueClient` with shaped answers so a mis-narrowed arm fails a test rather than a
 * user.
 *
 * Nothing here asserts on a sentence the page draws: the wording is the component's copy tree, and
 * these tests assert on structure and facts so a reworded row does not turn a behaviour test red.
 */
import { describe, expect, it } from 'vitest'
import {
  CATALOGUE_SAYS_NOTHING_ABOUT,
  catalogueAction,
  catalogueIsEmpty,
  untransferableGates,
  type CatalogueReadout,
  type CatalogueRow,
  type CatalogueStanding,
} from './agent-catalogue-policy'
import { createAgentCatalogueClient } from './agent-catalogue-ipc'

// ---------------------------------------------------------------------------
// Fixtures — a document, read
// ---------------------------------------------------------------------------

const GATES: CatalogueReadout['installGates'] = [
  { check: 'digest', transfers: false },
  { check: 'architecture', transfers: true },
  { check: 'execute-permission', transfers: true },
  { check: 'version', transfers: false },
  { check: 'acp-initialization', transfers: true },
  { check: 'contract-tests', transfers: false },
]

function row(overrides: Partial<CatalogueRow> & { standing: CatalogueStanding }): CatalogueRow {
  return {
    id: 'someagent',
    name: 'SomeAgent',
    version: '1.0.0',
    description: 'Agent for code editing',
    repository: null,
    website: null,
    authors: [],
    license: null,
    licenseUrl: 'https://example.com/l',
    iconUrl: null,
    defects: [],
    offerable: true,
    ...overrides,
  }
}

function readout(rows: readonly CatalogueRow[]): CatalogueReadout {
  return {
    registryVersion: '1.0.0',
    freshness: 'current',
    note: null,
    rows,
    offerable: rows.filter((candidate) => candidate.offerable).length,
    installGates: GATES,
  }
}

const VIA_MANAGER: CatalogueStanding = {
  kind: 'via-package-manager',
  manager: 'npx',
  package: '@acme/ai-agent',
  program: 'npx',
  args: ['@acme/ai-agent', '--acp'],
  pinnedVersion: null,
}

// ---------------------------------------------------------------------------
// The first negative: a catalogue entry is not a capability
// ---------------------------------------------------------------------------

describe('a catalogue entry says nothing about what an engine can do', () => {
  it('names every capability the report has, and answers none of them', () => {
    // The shape rule: the vocabulary a page would want to draw is named in one place, and there is
    // no function that fills it in. A catalogue row has never been near a handshake.
    expect([...CATALOGUE_SAYS_NOTHING_ABOUT].sort()).toEqual(
      [
        'audio-attachments',
        'embedded-context',
        'image-attachments',
        'model-selection',
        'session-config-options',
        'session-resume',
        'slash-commands',
      ].sort(),
    )
  })

  it('carries no capability field on a row, whatever the standing is', () => {
    // Held as a fact about the value rather than a promise in a comment: whatever a row holds, none
    // of it is a capability. A field added to `CatalogueRow` for one would have to appear here.
    const candidate = row({ standing: VIA_MANAGER })
    const fields = Object.keys(candidate)
    for (const capability of CATALOGUE_SAYS_NOTHING_ABOUT) {
      expect(fields).not.toContain(capability)
    }
    expect(fields).not.toContain('capabilities')
    expect(fields).not.toContain('finding')
    expect(fields).not.toContain('declared')
  })
})

// ---------------------------------------------------------------------------
// The second negative: no control for a row this build cannot act on
// ---------------------------------------------------------------------------

describe('a row this build cannot act on offers nothing', () => {
  it('prefills the add form for a package-manager invocation and nothing else', () => {
    // The one actionable arm. `program` and `args` stay apart — §3.4.3 forbids a command line, and
    // the array is the shape that keeps the promise.
    const action = catalogueAction(row({ standing: VIA_MANAGER }))
    expect(action).toEqual({
      kind: 'prefill',
      program: 'npx',
      args: ['@acme/ai-agent', '--acp'],
      displayName: 'SomeAgent',
      agentId: 'someagent',
    })
    if (action.kind === 'prefill') {
      expect(action.args.join(' ')).not.toBe(action.program)
    }
  })

  it('gives the three inactionable arms three different reasons', () => {
    // Not one "unavailable": an archive this app may not download, a machine this app cannot run
    // on, and a kind it cannot describe send a user to three different places.
    const arms: readonly CatalogueStanding[] = [
      { kind: 'archive-only', platform: 'linux-x86_64', cmd: './a' },
      { kind: 'unsupported', published: ['darwin-aarch64'] },
      { kind: 'unrecognised', kinds: ['docker'] },
    ]
    const reasons = arms.map((standing) => {
      const action = catalogueAction(row({ standing }))
      expect(action.kind).toBe('none')
      return action.kind === 'none' ? action.reason : ''
    })
    expect(reasons).toEqual(['archive-only', 'unsupported', 'unrecognised'])
    expect(new Set(reasons).size).toBe(3)
  })

  it('refuses a control when the backend said the row is not offerable', () => {
    // `offerable` is read, never re-derived. A row whose standing looks actionable and which the
    // backend marked unofferable resolves towards drawing nothing — the direction a disagreement
    // has to resolve in, because the other one draws a control that cannot work.
    const action = catalogueAction(row({ standing: VIA_MANAGER, offerable: false }))
    expect(action.kind).toBe('none')
  })

  it('names the §3.3 checks that do not transfer, from the readout', () => {
    // Derived rather than listed here: the backend is the authority on which checks transfer, and a
    // second list on this side is a second answer that could drift from it.
    expect(untransferableGates(readout([]))).toEqual(['digest', 'version', 'contract-tests'])
  })

  it('tells an empty catalogue from an unreadable one', () => {
    // A page that tested only `rows.length` would draw the same thing for "the registry listed
    // nothing" and "this window could not read it".
    expect(catalogueIsEmpty(readout([]))).toBe(true)
    expect(catalogueIsEmpty(readout([row({ standing: VIA_MANAGER })]))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The wire reader
// ---------------------------------------------------------------------------

/** The backend's answer, spelled the way `commands/agent_catalogue.rs` returns it. */
function answer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    registryVersion: '1.0.0',
    freshness: 'current',
    note: null,
    offerable: 1,
    installGates: GATES,
    rows: [
      {
        id: 'someagent',
        name: 'SomeAgent',
        version: '1.0.0',
        description: 'd',
        repository: null,
        website: null,
        authors: ['Example Team'],
        license: 'MIT',
        licenseUrl: 'https://example.com/l',
        iconUrl: 'https://raw.githubusercontent.com/agentclientprotocol/registry/main/someagent/icon.svg',
        standing: {
          kind: 'via-package-manager',
          manager: 'npx',
          package: '@acme/ai-agent',
          program: 'npx',
          args: ['@acme/ai-agent', '--acp'],
          pinnedVersion: null,
        },
        defects: [],
        offerable: true,
      },
    ],
    ...overrides,
  }
}

/** The answer's one row, as a mutable record, so a test can spoil exactly one field of it. */
function firstRow(): Record<string, unknown> {
  const rows = answer()['rows'] as Record<string, unknown>[]
  return { ...rows[0]! }
}

describe('the catalogue client narrows what the backend answered', () => {
  it('reads a full answer into the port types', async () => {
    const client = createAgentCatalogueClient({ readCatalogue: async () => answer() })
    const read = await client.readCatalogue()
    expect(read.registryVersion).toBe('1.0.0')
    expect(read.freshness).toBe('current')
    expect(read.note).toBeNull()
    expect(read.rows).toHaveLength(1)
    expect(read.rows[0]!.authors).toEqual(['Example Team'])
    expect(read.rows[0]!.standing.kind).toBe('via-package-manager')
  })

  it('flattens the note object rather than reading it as a string', async () => {
    // `note` is `{ detail }` on the wire, not a bare string. A reader that expected a string would
    // reject an answer that is perfectly well formed — which is why this is asserted rather than
    // assumed.
    const client = createAgentCatalogueClient({
      readCatalogue: async () =>
        answer({ freshness: 'stale', note: { detail: 'the registry could not be reached' } }),
    })
    const read = await client.readCatalogue()
    expect(read.freshness).toBe('stale')
    expect(read.note).toBe('the registry could not be reached')
  })

  it('reads an unavailable answer, which has no rows and still has the gates', async () => {
    // The state a machine with no network produces. It must survive narrowing: the gates are a
    // property of this build, not of the network, and a page shows them with no rows at all.
    const client = createAgentCatalogueClient({
      readCatalogue: async () =>
        answer({ freshness: 'unavailable', rows: [], offerable: 0, note: { detail: 'no route to host' } }),
    })
    const read = await client.readCatalogue()
    expect(read.freshness).toBe('unavailable')
    expect(read.rows).toEqual([])
    expect(read.installGates).toHaveLength(GATES.length)
  })

  it('rejects a malformed answer instead of calling it an empty catalogue', async () => {
    // "No agents are listed" is a claim about the registry; a shape this window cannot read is a
    // fact about this window. Collapsing them lets a broken reader look like a small registry.
    const cases: readonly unknown[] = [
      { ...answer(), freshness: 'maybe' },
      { ...answer(), rows: [{ ...firstRow(), standing: { kind: 'npx' } }] },
      { ...answer(), rows: [{ ...firstRow(), offerable: 'yes' }] },
      { ...answer(), installGates: [{ check: 'digest' }] },
      { ...answer(), note: { detail: 7 } },
      'not an object',
    ]
    for (const malformed of cases) {
      const client = createAgentCatalogueClient({ readCatalogue: async () => malformed })
      await expect(client.readCatalogue()).rejects.toThrow(/does not understand/)
    }
  })

  it('names the field and never the value it could not read', async () => {
    // What a malformed answer contains is unknown by construction — that is the whole point of the
    // check that failed — so the message names the field, not what was in it.
    const client = createAgentCatalogueClient({
      readCatalogue: async () => answer({ registryVersion: 'a-secret-that-must-not-be-printed' }),
    })
    // A string is fine here, so this one succeeds; the check below uses a value that does not.
    await expect(client.readCatalogue()).resolves.toBeDefined()
    const failing = createAgentCatalogueClient({
      readCatalogue: async () => answer({ freshness: 'a-secret-that-must-not-be-printed' }),
    })
    await expect(failing.readCatalogue()).rejects.toThrow(/freshness$/)
    await expect(failing.readCatalogue()).rejects.not.toThrow(/a-secret/)
  })
})
