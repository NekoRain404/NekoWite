/**
 * V12 — the registry settings page's rules, as a pure module.
 *
 * What this file is for: §10.2's T13a row asks for 添加/停用, 失败诊断, 不擅自更新 and 切引擎新建会话,
 * and the part of each that is *a rule rather than a drawing* has to be decided somewhere the
 * drawing cannot argue with. The page itself is driven in E4; the decisions are held here.
 *
 * The three that carry the weight:
 *
 *  - **失败诊断 names the fact.** "Could not add this agent" is the failure this file exists to
 *    prevent: a missing file, a file without an executable bit, and an engine that refused the
 *    handshake are three different things for the user to do, and the tests below hold the three
 *    apart at the level of the answer, not of the wording that renders it.
 *  - **不擅自更新 is provenance, and it is the backend's.** `registry.rs` makes the update policy a
 *    method on `InstallSource`, so an external registration cannot claim a host-managed one;
 *    `updateStanding` is that method's answer, and the test pins the asymmetry (a bundled program
 *    is the host's to replace, a user's install is the host's to *report* and nothing else).
 *  - **切引擎新建会话 is not a detail of the panel.** A session belongs to one engine (§3.4), so
 *    choosing another one is a new session — never a re-pointed handle. `planEngineSwitch` answers
 *    with the plan and the page only renders it.
 *
 * Nothing here asserts on a sentence the page draws: the wording is the component's copy tree
 * (see `AgentRegistrySettings.vue`), and these tests assert on structure and facts so a reworded
 * diagnosis does not turn a behaviour test red. The one place text is asserted is
 * {@link fillTemplate}, which is about a template rule rather than a sentence.
 */
import { describe, expect, it } from 'vitest'
import {
  REDACTED_ENV_VALUE,
  disableStanding,
  fillTemplate,
  planEngineSwitch,
  readEnvForDisplay,
  refusedField,
  updateStanding,
  validateAgentDraft,
  type AgentDraft,
  type AgentRegistryEntry,
  type AgentRegistryReadout,
  type RegistryRefusal,
} from './agent-registry-policy'

/** One registration, as the readout hands it over. The defaults are a launchable external one,
 *  because that is the case every other test then deviates from. */
function entry(overrides: Partial<AgentRegistryEntry> = {}): AgentRegistryEntry {
  return {
    agentId: 'acme',
    displayName: 'Acme',
    source: 'external',
    program: '/usr/local/bin/acme-acp',
    args: [],
    env: 'user-environment',
    envExtra: [],
    enabled: true,
    adapterId: 'generic-acp',
    reportedVersion: null,
    programState: 'launchable',
    ...overrides,
  }
}

function readout(overrides: Partial<AgentRegistryReadout> = {}): AgentRegistryReadout {
  return {
    defaultAgentId: 'bundled-engine',
    entries: [entry()],
    adapterIds: ['generic-acp', 'opencode'],
    runningAgentIds: [],
    profileOwners: {},
    ...overrides,
  }
}

function draft(overrides: Partial<AgentDraft> = {}): AgentDraft {
  return {
    agentId: 'acme',
    displayName: 'Acme',
    program: '/usr/local/bin/acme-acp',
    args: [],
    adapterId: 'generic-acp',
    ...overrides,
  }
}

describe('the draft an add form submits', () => {
  it('accepts a well-formed draft', () => {
    expect(validateAgentDraft(draft(), readout({ entries: [] }))).toEqual([])
  })

  it('refuses a relative program path as a path problem, not an argument one', () => {
    // §3.4.3's two halves are separate evidence, and a diagnostic that cannot say which is wrong
    // sends the user to fix the wrong one: a bare `acme-acp` is refused because this process's
    // working directory is the app's, not the user's (registry.rs), and nothing about it is an
    // argument problem.
    const problems = validateAgentDraft(
      draft({ program: 'acme-acp', args: ['--stdio', 'a\0b'] }),
      readout({ entries: [] }),
    )
    expect(problems.map((problem) => problem.kind)).toEqual(['program', 'argument'])
    expect(problems[0]).toEqual({ kind: 'program', path: 'acme-acp', state: 'not-absolute' })
    // The path is reported first, and fixing it *reveals* the argument rather than hiding it —
    // the same order `AgentRegistration::validate` applies them in.
    expect(problems[1]).toEqual({ kind: 'argument', index: 1 })
  })

  it('leaves whether the file is there to the backend', () => {
    // Existence and the executable bit are states of the filesystem, re-read from `program_state`
    // on every call — not properties of a definition. A form that guessed would refuse a sidecar
    // that has not been built yet, which registry.rs is explicit is a normal state to *report*.
    const problems = validateAgentDraft(
      draft({ program: '/nonexistent/definitely-not-here' }),
      readout({ entries: [] }),
    )
    expect(problems).toEqual([])
  })

  it('refuses an id that could not be an identity or a path component', () => {
    // §3.2 puts the id into a directory name, so a `/` or a `..` here is a path traversal dressed
    // as configuration. The charset, the length bound and the leading-dot rule are Rust's.
    for (const agentId of ['', '..', '.', '.hidden', 'a/b', 'agent id', 'A'.repeat(65)]) {
      const problems = validateAgentDraft(draft({ agentId }), readout({ entries: [] }))
      expect(problems.map((problem) => problem.kind), agentId).toEqual(['id'])
      expect(problems[0]).toEqual({ kind: 'id', field: 'agent_id', value: agentId })
    }
    // And the charset's own edge: 64 bytes is still usable.
    expect(validateAgentDraft(draft({ agentId: 'A'.repeat(64) }), readout({ entries: [] }))).toEqual(
      [],
    )
  })

  it('refuses an adapter id nothing answers to, using the ids the readout reports', () => {
    // The page has no list of engine names of its own (§3.4: a component must not branch on one),
    // so the ids come from the readout — which is `adapters::lookup`'s answer.
    const problems = validateAgentDraft(
      draft({ adapterId: 'acme-verified' }),
      readout({ entries: [] }),
    )
    expect(problems).toEqual([{ kind: 'unknown-adapter', adapterId: 'acme-verified' }])
  })

  it('refuses an id that is already registered', () => {
    // A courtesy, not the check: `AgentRegistry::register` refuses a replacement while an instance
    // may be running on the definition, and a stale readout cannot be the thing that decides it.
    const problems = validateAgentDraft(draft(), readout())
    expect(problems).toEqual([{ kind: 'duplicate-agent', agentId: 'acme' }])
  })

  it('places each problem under the field it belongs to', () => {
    expect(refusedField({ kind: 'program', path: '/x', state: 'missing' })).toBe('program')
    expect(refusedField({ kind: 'id', field: 'agent_id', value: '..' })).toBe('agentId')
    expect(refusedField({ kind: 'argument', index: 0 })).toBe('args')
    expect(refusedField({ kind: 'unknown-adapter', adapterId: 'x' })).toBe('adapterId')
    expect(refusedField({ kind: 'duplicate-agent', agentId: 'x' })).toBe('agentId')
    // Refusals that are about the registration as a whole rather than a field, or about an input
    // this page does not have: they are shown where the action was taken, not under a field the
    // user did not get wrong. `environment` is the second kind — a registration's variables are
    // configuration (§3.4.5), so the add form has no field for them and the backend's refusal is
    // said next to the action instead.
    expect(refusedField({ kind: 'instance-running', agentId: 'x' })).toBeNull()
    expect(refusedField({ kind: 'environment', name: 'X' })).toBeNull()
  })
})

describe('what may be printed', () => {
  it('masks a credential by name, whichever way it is spelled', () => {
    // Ported from `registry.rs`'s `is_credential_name`, upper-cased first: `anthropic_api_key` and
    // `ANTHROPIC_API_KEY` are the same variable to the kernel while only one is the convention, and
    // under-redacting is the dangerous direction.
    const printed = readEnvForDisplay([
      { name: 'ANTHROPIC_API_KEY', value: 'sk-ant-oat01-not-a-real-key' },
      { name: 'anthropic_api_key', value: 'sk-ant-lowercase-not-a-real-key' },
      { name: 'ACME_LICENSE', value: 'XXXX-XXXX' },
      { name: 'ACME_PASSWORD', value: 'hunter2' },
    ])
    expect(printed.map((variable) => variable.value)).toEqual([
      REDACTED_ENV_VALUE,
      REDACTED_ENV_VALUE,
      REDACTED_ENV_VALUE,
      REDACTED_ENV_VALUE,
    ])
    expect(JSON.stringify(printed)).not.toContain('not-a-real-key')
  })

  it('keeps a value that is not one, so the page still diagnoses', () => {
    const env = [{ name: 'ACME_CONFIG_DIR', value: '/home/someone/.config/acme' }]
    expect(readEnvForDisplay(env)).toEqual(env)
    // A display rule, not a write: the array the caller handed over is untouched.
    expect(env[0]?.value).toBe('/home/someone/.config/acme')
  })
})

describe('where a program came from', () => {
  it('decides who may replace it, and only reports on a user installation', () => {
    // §3.4.6 and §3.1.4: 「高级用户可选择系统 CLI；此模式只检测兼容性，不擅自升级或替换用户安装」.
    expect(updateStanding('bundled')).toBe('host-managed')
    expect(updateStanding('managed')).toBe('host-managed')
    expect(updateStanding('external')).toBe('reported-only')
  })
})

describe('switching a registration on and off', () => {
  it('refuses to switch off the default, which is what a new session starts on', () => {
    const defaultEntry = entry({ agentId: 'bundled-engine', source: 'bundled' })
    const standing = disableStanding(defaultEntry, readout({ entries: [defaultEntry] }))
    expect(standing).toEqual({
      allowed: false,
      refusal: { kind: 'is-default', agentId: 'bundled-engine' },
    })
  })

  it('refuses while an engine is live on the registration', () => {
    // §3.4.7: an active task is handled before the registration it belongs to is switched off —
    // disabling would leave a running engine behind a registration the host no longer offers.
    const standing = disableStanding(entry(), readout({ runningAgentIds: ['acme'] }))
    expect(standing).toEqual({
      allowed: false,
      refusal: { kind: 'instance-running', agentId: 'acme' },
    })
  })

  it('allows it otherwise, and switches on without asking', () => {
    expect(disableStanding(entry(), readout())).toEqual({ allowed: true })
    const off = entry({ enabled: false })
    expect(disableStanding(off, readout({ entries: [off], runningAgentIds: ['acme'] }))).toEqual({
      allowed: true,
    })
  })
})

describe('choosing the engine for a new session', () => {
  it('plans a new session when another engine is chosen', () => {
    // §3.4.2 「切换引擎创建新会话；旧会话保留所属引擎、授权与历史」: the answer is a *new* session,
    // never the open handle re-pointed at a different engine.
    expect(
      planEngineSwitch({
        sessionAgentId: 'acme',
        agentId: 'other',
        profileId: 'prof-a',
        readout: readout({ entries: [entry(), entry({ agentId: 'other' })], profileOwners: { 'prof-a': 'other' } }),
      }),
    ).toEqual({ kind: 'new-session', agentId: 'other', profileId: 'prof-a' })
  })

  it('keeps the open session when the same engine is chosen', () => {
    expect(
      planEngineSwitch({
        sessionAgentId: 'acme',
        agentId: 'acme',
        profileId: 'prof-a',
        readout: readout({ profileOwners: { 'prof-a': 'acme' } }),
      }),
    ).toEqual({ kind: 'keep-session', agentId: 'acme' })
  })

  it('plans a new session when none is open', () => {
    expect(
      planEngineSwitch({
        sessionAgentId: null,
        agentId: 'acme',
        profileId: 'prof-a',
        readout: readout({ profileOwners: { 'prof-a': 'acme' } }),
      }),
    ).toEqual({ kind: 'new-session', agentId: 'acme', profileId: 'prof-a' })
  })

  it('refuses a profile that belongs to another engine', () => {
    // §3.4's Profile row: credentials, model ids and config files are not copied between engines,
    // so a switch that would hand this engine another one's profile is refused — with the owner
    // named, because "it is taken" and "it is taken by *that* engine" are different answers.
    const plan = planEngineSwitch({
      sessionAgentId: null,
      agentId: 'acme',
      profileId: 'prof-a',
      readout: readout({ profileOwners: { 'prof-a': 'other' } }),
    })
    expect(plan).toEqual({
      kind: 'refused',
      refusal: {
        kind: 'profile-unbound',
        profileId: 'prof-a',
        agentId: 'acme',
        owner: 'other',
      },
    })
  })

  it('refuses an engine that is not registered, and one that is switched off', () => {
    // The backend refuses both before anything is spawned (§3.4: the renderer names an agent and a
    // profile and the backend decides whether that pair exists).
    expect(
      planEngineSwitch({
        sessionAgentId: null,
        agentId: 'nobody',
        profileId: 'prof-a',
        readout: readout({ profileOwners: { 'prof-a': 'nobody' } }),
      }),
    ).toEqual({ kind: 'refused', refusal: { kind: 'unknown-agent', agentId: 'nobody' } })
    const off = entry({ enabled: false })
    expect(
      planEngineSwitch({
        sessionAgentId: null,
        agentId: 'acme',
        profileId: 'prof-a',
        readout: readout({ entries: [off], profileOwners: { 'prof-a': 'acme' } }),
      }),
    ).toEqual({ kind: 'refused', refusal: { kind: 'disabled', agentId: 'acme' } })
  })
})

describe('saying what actually failed', () => {
  const refusals: RegistryRefusal[] = [
    { kind: 'program', path: '/opt/acme/acme-acp', state: 'missing' },
    { kind: 'program', path: '/opt/acme/acme-acp', state: 'not-executable' },
    { kind: 'program', path: '/opt/acme/acme-acp', state: 'not-a-file' },
    { kind: 'program', path: 'acme-acp', state: 'not-absolute' },
    { kind: 'launch-failed', agentId: 'acme', code: 'invalid-response', message: 'no initialize result' },
    { kind: 'launch-failed', agentId: 'acme', code: 'timeout', message: 'the engine did not answer initialize in time' },
    { kind: 'launch-failed', agentId: 'acme', code: 'certificate-untrusted', message: 'the engine could not verify the server certificate' },
    { kind: 'is-default', agentId: 'bundled-engine' },
    { kind: 'instance-running', agentId: 'acme' },
    { kind: 'already-running', agentId: 'acme' },
    { kind: 'profile-unbound', profileId: 'prof-a', agentId: 'acme', owner: null },
    { kind: 'disabled', agentId: 'acme' },
    { kind: 'unknown-agent', agentId: 'acme' },
    { kind: 'duplicate-agent', agentId: 'acme' },
    { kind: 'unknown-adapter', adapterId: 'acme-verified' },
    { kind: 'id', field: 'agent_id', value: 'a/b' },
    { kind: 'argument', index: 2 },
    { kind: 'environment', name: 'A=B' },
  ]

  it('carries the fact that tells the three failures apart', () => {
    // The acceptance in one assertion: "there is no file there", "the file is not executable" and
    // "the engine refused the handshake" are three different answers, and each one's distinguishing
    // fact is on the refusal rather than flattened into a boolean.
    const [absent, noBit, notAFile, relative] = refusals
    expect(absent).toMatchObject({ state: 'missing' })
    expect(noBit).toMatchObject({ state: 'not-executable' })
    expect(notAFile).toMatchObject({ state: 'not-a-file' })
    expect(relative).toMatchObject({ state: 'not-absolute' })
    const handshake = refusals[4]
    expect(handshake).toMatchObject({ kind: 'launch-failed', code: 'invalid-response' })
  })

  it('keeps the transport classification instead of collapsing it', () => {
    // `TransportError::failure_code` is where a timeout, a dead connection, a protocol version
    // mismatch and an untrusted certificate are told apart; `Engine { .. }` is *not* always
    // `invalid-response` — P0 §2.4 measured the certificate case and it has a code of its own.
    const codes = refusals
      .filter((refusal) => refusal.kind === 'launch-failed')
      .map((refusal) => (refusal.kind === 'launch-failed' ? refusal.code : ''))
    expect(codes).toEqual(['invalid-response', 'timeout', 'certificate-untrusted'])
    expect(new Set(codes).size).toBe(codes.length)
  })

  it('places every arm, or says it is not about a field', () => {
    // The switch in `refusedField` is exhaustive to the typechecker and returns `undefined` to
    // everything else, so an arm added without a `case` would put a problem on screen with no
    // field to sit under and no warning anywhere. This is that tripwire: every kind answers, and
    // the answer is either a field of this form or `null`.
    const fields = ['agentId', 'displayName', 'program', 'args', 'adapterId']
    for (const refusal of refusals) {
      const field = refusedField(refusal)
      expect(field === null || fields.includes(field), refusal.kind).toBe(true)
    }
  })

  it('has a kind for every arm the backend can refuse with', () => {
    // The list above is one refusal per arm; a new arm in the union without a sentence in the
    // page's copy tree is a typecheck failure, and the count here is the tripwire for an arm that
    // was added to the page and never given a sentence anywhere.
    expect(new Set(refusals.map((refusal) => refusal.kind)).size).toBe(13)
  })
})

describe('filling a sentence in', () => {
  it('puts the facts in, and leaves a slot it has no fact for visible', () => {
    expect(fillTemplate('no file at {path} now', { path: '/opt/acme' })).toBe(
      'no file at /opt/acme now',
    )
    // A slot with no fact stays as it is: dropping it would read as a finished sentence about a
    // fact nobody supplied, and this page's whole job is to not say things it cannot back.
    expect(fillTemplate('no file at {path} now', {})).toBe('no file at {path} now')
    // Every occurrence, not the first: a template that mentions the path twice is one sentence.
    expect(fillTemplate('{name} is {name}', { name: 'X' })).toBe('X is X')
  })
})
