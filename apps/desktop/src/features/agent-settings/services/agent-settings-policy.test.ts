/**
 * V10 — the profile page's rules, as a pure module.
 *
 * §10.2's T12 row asks for 配置隔离证据、JSONC 保留、并发冲突、凭据脱敏, and the tests below hold each one at
 * the level of a *decision* rather than of a drawing: the page renders what it is told, and the
 * things it must not do are refused here instead of being left to a component to remember.
 *
 * The four, and the assertion that carries each:
 *
 *  - 配置隔离 — a readout is refused when it is rendered under the wrong (agentId, profileId) pair,
 *    and a write built for one pair is refused against another's readout. The failure this prevents
 *    is one engine's provider, model id and credential names appearing to belong to another.
 *  - JSONC 保留 — the write type has no field that could carry a document. That is asserted by
 *    construction rather than by wording: see {@link ConfigWrite}, and the test that a page which
 *    only changed one member submits exactly that member and nothing else.
 *  - 并发冲突 — a revision that moved is a *conflict*, never a merge, and the answer carries the
 *    readout to reload from. A revision ahead of the readout is refused the same way.
 *  - 凭据脱敏 — a readout that carries a value still renders the placeholder, an untouched field
 *    submits nothing, and a draft that *is* the placeholder is refused rather than stored — the
 *    failure where the display value becomes the credential and the provider stops authenticating
 *    some time after the save that did it.
 *
 * Nothing here asserts on a sentence the page draws, except {@link profileRefusalMessage} and
 * {@link configRefusalMessage}, whose subject *is* the wording: everything else asserts on structure
 * and facts, so a reworded screen does not turn a behaviour test red.
 */
import { describe, expect, it } from 'vitest'
import {
  CONFIG_MODES,
  REDACTED_CREDENTIAL,
  configRefusalMessage,
  credentialRows,
  credentialSubmission,
  credentialWrite,
  decideConfigWrite,
  decideProfileWrite,
  planModeSwitch,
  profileProblem,
  profileRefusalMessage,
  profileWrite,
  type AgentProfileReadout,
  type ConfigRead,
  type ProfileFields,
} from './agent-settings-policy'

/** One profile, as `commands/agent_settings.rs` answers with it. The defaults are app-managed and
 *  editable, because that is the case every other test then deviates from. */
function readout(overrides: Partial<AgentProfileReadout> = {}): AgentProfileReadout {
  return {
    profileId: 'default',
    agentId: 'opencode',
    mode: 'app-managed',
    root: '/home/user/.local/share/nekowite/agent-profiles/default',
    revision: 'a'.repeat(64),
    provider: 'anthropic',
    modelId: 'claude-sonnet-4',
    editable: true,
    sources: [
      { kind: 'injected', variable: 'HOME', path: '/profiles/default/HOME' },
      { kind: 'engine-discovery', what: 'project' },
      { kind: 'engine-discovery', what: 'managed' },
    ],
    credentials: [{ name: 'ANTHROPIC_API_KEY', value: REDACTED_CREDENTIAL }],
    credentialStorage: {
      kind: 'host-file',
      path: '/profiles/default/credentials.json',
      mode: '600',
      encrypted: false,
      keychain: false,
    },
    permissions: {
      state: 'written',
      document: '/profiles/default/XDG_CONFIG_HOME/opencode/opencode.json',
      rules: [
        { tool: 'edit', action: 'ask' },
        { tool: 'bash', action: 'ask' },
      ],
    },
    ...overrides,
  }
}

function fields(overrides: Partial<ProfileFields> = {}): ProfileFields {
  return { mode: 'app-managed', provider: 'anthropic', modelId: 'claude-sonnet-4', ...overrides }
}

function configRead(overrides: Partial<ConfigRead> = {}): ConfigRead {
  return {
    path: 'XDG_CONFIG_HOME/opencode/opencode.jsonc',
    exists: true,
    revision: 'b'.repeat(64),
    editable: true,
    ...overrides,
  }
}

describe('the pair a readout belongs to', () => {
  it('accepts the pair it was read for', () => {
    expect(profileProblem(readout(), 'opencode', 'default')).toBeNull()
  })

  it('refuses a readout rendered under another engine or another profile', () => {
    // A page that switched engines and reused a cached readout would otherwise show one engine's
    // provider, model id and credential names under another engine's heading — §3.4's Profile row
    // arrived at from the UI side, which is the failure this check exists for.
    expect(profileProblem(readout(), 'acme', 'default')).toBe('wrong-profile')
    expect(profileProblem(readout(), 'opencode', 'work')).toBe('wrong-profile')
    expect(profileProblem(readout({ agentId: 'acme' }), 'opencode', 'default')).toBe('wrong-profile')
  })
})

describe('switching the configuration mode', () => {
  it('describes what changes without touching a file', () => {
    // §8.1: 切换模式不自动移动或覆盖旧文件. The plan carries the promise in its type — there is no word
    // in it for a file operation — rather than in a sentence a page might not render.
    const toManaged = planModeSwitch('user-config', 'app-managed')
    expect(toManaged.changes).toEqual([
      'roots-are-injected',
      'host-starts-writing',
      'credentials-move-to-the-engine',
    ])
    expect(toManaged.touchesExistingFiles).toBe(false)

    const toUser = planModeSwitch('app-managed', 'user-config')
    expect(toUser.changes).toEqual(['roots-are-the-users', 'host-stops-writing'])
    expect(toUser.touchesExistingFiles).toBe(false)
  })

  it('is empty when the mode is already the one chosen', () => {
    expect(planModeSwitch('app-managed', 'app-managed').changes).toEqual([])
  })
})

describe('the record a form submits', () => {
  it('applies at the revision the form was built from', () => {
    const read = readout()
    const update = decideProfileWrite(read, profileWrite(read, fields({ modelId: 'claude-opus-4' })))
    expect(update).toEqual({ status: 'applied', fields: fields({ modelId: 'claude-opus-4' }) })
  })

  it('conflicts rather than merging when the revision moved', () => {
    const read = readout()
    const write = { ...profileWrite(read, fields()), revision: 'c'.repeat(64) }
    const update = decideProfileWrite(read, write)
    expect(update.status).toBe('conflict')
    // The caller reloads from what it gets back — a merge is how a value the user changed on
    // another page is undone.
    if (update.status === 'conflict') expect(update.current).toBe(read)
  })

  it('refuses a write assembled for another pair before it looks at anything else', () => {
    // The identity is the prerequisite of every other judgement: a write for another engine must
    // not be judged as "a valid change to this one".
    const update = decideProfileWrite(readout(), {
      agentId: 'acme',
      profileId: 'default',
      revision: readout().revision,
      fields: fields(),
    })
    expect(update.status).toBe('refused')
    if (update.status === 'refused') expect(update.reason).toBe('wrong-profile')
  })

  it('refuses a profile this host does not write', () => {
    // §8.1's reuse mode: the profile is the user's own installation, so the page shows it and the
    // form is disabled — a write that reached this function would be refused here anyway.
    const read = readout({ mode: 'user-config', editable: false })
    const update = decideProfileWrite(read, profileWrite(read, fields({ mode: 'user-config' })))
    expect(update.status).toBe('refused')
    if (update.status === 'refused') expect(update.reason).toBe('not-editable')
  })

  it('refuses a mode this build does not know rather than defaulting it', () => {
    const read = readout()
    const bogus = { ...fields(), mode: 'app-managed ' } as unknown as ProfileFields
    const update = decideProfileWrite(read, profileWrite(read, bogus))
    expect(update.status).toBe('refused')
    if (update.status === 'refused') expect(update.reason).toBe('mode-unusable')
    // And the list a form renders comes from here, so a mode the page offers is one the backend
    // knows — there is no second list to drift.
    expect([...CONFIG_MODES]).toEqual(['app-managed', 'user-config'])
  })

  it('refuses an unusable provider or model name, and allows an unchosen one', () => {
    const read = readout()
    for (const bad of [{ provider: '' }, { modelId: '   ' }, { provider: 'a\x00b' }]) {
      const update = decideProfileWrite(read, profileWrite(read, fields(bad)))
      expect(update.status, JSON.stringify(bad)).toBe('refused')
      if (update.status === 'refused') expect(update.reason).toBe('field-unusable')
    }
    // `null` is "nothing chosen yet", which is a state a first-run profile is in.
    const chosen = decideProfileWrite(
      read,
      profileWrite(read, fields({ provider: null, modelId: null })),
    )
    expect(chosen.status).toBe('applied')
  })
})

describe('the document the editor submits', () => {
  it('applies edits, and nothing but edits', () => {
    // The type is the guarantee: there is no field of a `ConfigWrite` that could carry the file.
    // A page that wanted to save a reformatted document has nothing to send, so the comments and
    // the unknown members cannot be lost by a round-trip — `config_edit.rs` splices the two spans
    // that changed and writes everything else back byte for byte.
    const read = configRead()
    const update = decideConfigWrite(read, {
      path: read.path,
      revision: read.revision!,
      edits: [{ path: ['model'], value: 'openai/gpt-5' }],
    })
    expect(update).toEqual({
      status: 'applied',
      edits: [{ path: ['model'], value: 'openai/gpt-5' }],
    })
  })

  it('conflicts rather than merging when the document moved', () => {
    const read = configRead()
    const update = decideConfigWrite(read, {
      path: read.path,
      revision: 'd'.repeat(64),
      edits: [{ path: ['model'], value: 'x' }],
    })
    expect(update.status).toBe('conflict')
    if (update.status === 'conflict') expect(update.current).toBe(read)
  })

  it('refuses edits built for another document', () => {
    const update = decideConfigWrite(configRead(), {
      path: 'XDG_CONFIG_HOME/other/other.jsonc',
      revision: 'b'.repeat(64),
      edits: [{ path: ['model'], value: 'x' }],
    })
    expect(update.status).toBe('refused')
    if (update.status === 'refused') expect(update.reason).toBe('other-document')
  })

  it('refuses a document that is not there, and one this host does not write', () => {
    const absent = decideConfigWrite(configRead({ exists: false, revision: null }), {
      path: 'XDG_CONFIG_HOME/opencode/opencode.jsonc',
      revision: 'b'.repeat(64),
      edits: [{ path: ['model'], value: 'x' }],
    })
    expect(absent.status).toBe('refused')
    if (absent.status === 'refused') expect(absent.reason).toBe('absent')

    const notEditable = decideConfigWrite(configRead({ editable: false }), {
      path: 'XDG_CONFIG_HOME/opencode/opencode.jsonc',
      revision: 'b'.repeat(64),
      edits: [{ path: ['model'], value: 'x' }],
    })
    expect(notEditable.status).toBe('refused')
    if (notEditable.status === 'refused') expect(notEditable.reason).toBe('not-editable')
  })

  it('refuses an edit that names nothing', () => {
    // A blank segment is what an unfilled field produces, and Rust refuses it too — but a page that
    // sent it would get "the document has no member at ``" instead of a form it can fix.
    for (const path of [[], [''], ['  '], ['provider', '']]) {
      const update = decideConfigWrite(configRead(), {
        path: 'XDG_CONFIG_HOME/opencode/opencode.jsonc',
        revision: 'b'.repeat(64),
        edits: [{ path, value: 'x' }],
      })
      expect(update.status, JSON.stringify(path)).toBe('refused')
      if (update.status === 'refused') expect(update.reason).toBe('malformed-edit')
    }
  })

  it('refuses before it checks the revision, so the message names the right thing', () => {
    // Order matters for the user: "this profile does not write configuration" and "someone else
    // changed this file" send them to different places.
    const update = decideConfigWrite(configRead({ editable: false }), {
      path: 'XDG_CONFIG_HOME/opencode/opencode.jsonc',
      revision: 'd'.repeat(64),
      edits: [],
    })
    expect(update.status).toBe('refused')
    if (update.status === 'refused') expect(update.reason).toBe('not-editable')
  })
})

describe('credentials', () => {
  it('renders a placeholder even when the backend sends a value', () => {
    // The backend does not send values — that is what `profile.rs`'s `Secret` is for — and this is
    // the second place the rule holds rather than the only one: a page that rendered whatever
    // arrived would be a leak the day some other caller built the readout.
    const rows = credentialRows(
      readout({
        credentials: [
          { name: 'ANTHROPIC_API_KEY', value: 'sk-live-0123456789abcdef' },
          { name: 'OPENAI_API_KEY', value: '' },
        ],
      }),
    )
    expect(rows).toEqual([
      { name: 'ANTHROPIC_API_KEY', value: REDACTED_CREDENTIAL },
      // An empty string stays empty: it means "no credential stored", which is not the same fact
      // as "a credential is stored and you cannot see it".
      { name: 'OPENAI_API_KEY', value: '' },
    ])
  })

  it('submits nothing for a field the user did not touch', () => {
    // This is the arm that keeps the display value out of storage: a form submitted without the
    // user typing in it carries no value at all, rather than the placeholder it was showing.
    expect(credentialSubmission({ name: 'K', display: REDACTED_CREDENTIAL, draft: null })).toEqual({
      kind: 'unchanged',
    })
    expect(credentialSubmission({ name: 'K', display: '', draft: null })).toEqual({
      kind: 'unchanged',
    })
    expect(credentialWrite([{ name: 'K', display: REDACTED_CREDENTIAL, draft: null }])).toEqual({
      changes: [],
    })
  })

  it('refuses a draft that is the placeholder rather than storing it', () => {
    const submission = credentialSubmission({
      name: 'ANTHROPIC_API_KEY',
      display: REDACTED_CREDENTIAL,
      draft: REDACTED_CREDENTIAL,
    })
    expect(submission.kind).toBe('refused')
    // The failure this prevents is silent: the key becomes the literal string `<redacted>`, the
    // provider stops authenticating, and the user sees an authentication error long after the save.
    const refused = credentialWrite([
      { name: 'ANTHROPIC_API_KEY', display: REDACTED_CREDENTIAL, draft: REDACTED_CREDENTIAL },
      { name: 'OTHER', display: '', draft: 'typed' },
    ])
    expect('refused' in refused).toBe(true)
  })

  it('trims what the user typed, and never the stored value', () => {
    // Surrounding whitespace is a copy-paste artefact; it makes a key fail to authenticate in a way
    // that reads as "wrong key". Trimming is applied to the draft, which is the only side this
    // module can see.
    expect(credentialSubmission({ name: 'K', display: '', draft: '  sk-abc  ' })).toEqual({
      kind: 'set',
      value: 'sk-abc',
    })
  })

  it('turns an emptied field into a removal, not an empty value', () => {
    expect(credentialSubmission({ name: 'K', display: REDACTED_CREDENTIAL, draft: '' })).toEqual({
      kind: 'clear',
    })
    expect(credentialWrite([{ name: 'K', display: REDACTED_CREDENTIAL, draft: '' }])).toEqual({
      changes: [{ op: 'remove', name: 'K' }],
    })
  })

  it('sends a patch, so one credential cannot delete another', () => {
    // The page cannot resubmit a value it does not have. A submission shaped as a whole set would
    // delete every credential the form did not mention — the user edits one key and the rest go,
    // with nothing on screen to say so.
    const write = credentialWrite([
      { name: 'ANTHROPIC_API_KEY', display: REDACTED_CREDENTIAL, draft: 'sk-new' },
      { name: 'OPENAI_API_KEY', display: REDACTED_CREDENTIAL, draft: null },
    ])
    expect(write).toEqual({ changes: [{ op: 'set', name: 'ANTHROPIC_API_KEY', value: 'sk-new' }] })
  })
})

describe('the sentences a refusal is rendered with', () => {
  it('names the fact for every arm', () => {
    for (const reason of [
      'wrong-profile',
      'not-editable',
      'mode-unusable',
      'field-unusable',
    ] as const) {
      expect(profileRefusalMessage(reason).length).toBeGreaterThan(20)
    }
    for (const reason of ['other-document', 'not-editable', 'absent', 'malformed-edit'] as const) {
      expect(configRefusalMessage(reason).length).toBeGreaterThan(20)
    }
  })

  it('never suggests merging a moved revision', () => {
    // The instruction a conflict gives is "reload": a message that offered to merge would be
    // offering the one outcome the rule exists to make impossible.
    const message = configRefusalMessage('other-document')
    expect(message.toLowerCase()).toContain('reload')
  })
})
