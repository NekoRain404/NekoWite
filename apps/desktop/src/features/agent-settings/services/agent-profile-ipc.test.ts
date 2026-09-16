/**
 * V14 — the profile client: what it does with each answer `R/src/commands/agent_settings.rs` can give.
 *
 * The wire literals below are the *shape* that file serializes (`profile_view`), written out by
 * hand rather than derived from the Rust types, because the coupling this file guards is between
 * two processes: a renamed JSON field keeps every Rust assertion green and would leave the page
 * with a blank line. `the wire shape the backend sends` is the litmus — if the Rust side changes a
 * key, that case changes with it, and review is what catches the pair drifting.
 *
 * Four properties, one per group:
 *
 *  - **The pair is the backend's answer, not the caller's request.** `read` hands back the
 *    (agentId, profileId) the record *is*, which is what lets the page refuse to render another
 *    engine's provider (§8.1's configuration ownership).
 *  - **A written answer is `applied`; a conflict carries the record to reload.** Those are the two
 *    arms the backend really sends. A rejection — the backend's own sentence for a call that ran
 *    and was refused — stays a rejection, because the page's `refused` arm is its *pre-flight*
 *    (`decideProfileWrite`), not a second rendering of prose.
 *  - **Nothing is cast.** Every field a page reads is narrowed, and a storage record that claims
 *    encryption this app does not do is refused rather than drawn as its opposite.
 *  - **A message never quotes a value.** The malformed-answer errors name the field, not what was
 *    in it: a credential value is the one thing that must not reach a sentence by accident.
 */

import { describe, expect, it, vi } from 'vitest'

import { createAgentProviderClient, type AgentProfileWire } from './agent-profile-ipc'
import type { ProfileFields, ProfileWrite } from './agent-settings-policy'

/** One record, spelled the way `agent_settings.rs`'s `profile_view` serializes it. */
function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    profileId: 'default',
    agentId: 'opencode',
    mode: 'app-managed',
    root: '/home/someone/.local/share/nekowite/agent-profiles/default',
    revision: 'r1',
    provider: 'iapp',
    modelId: 'iapp/deepseek-v4-flash',
    editable: true,
    sources: [
      { kind: 'injected', variable: 'OPENCODE_CONFIG_DIR', path: '/tmp/profile' },
      { kind: 'engine-discovery', what: 'the project .opencode directory' },
    ],
    credentials: [{ name: 'ANTHROPIC_API_KEY', value: '<redacted>' }],
    credentialStorage: { kind: 'host-file', path: '/tmp/profile/auth.json', mode: '600', encrypted: false, keychain: false },
    ...overrides,
  }
}

const fields: ProfileFields = { mode: 'app-managed', provider: 'iapp', modelId: 'iapp/x' }
const write: ProfileWrite = { agentId: 'opencode', profileId: 'default', revision: 'r1', fields }

function wire(answers: { read?: unknown; write?: unknown }): {
  port: AgentProfileWire
  read: ReturnType<typeof vi.fn>
  write: ReturnType<typeof vi.fn>
} {
  const read = vi.fn(async () => answers.read ?? record())
  const wrote = vi.fn(async () => answers.write ?? { status: 'written', revision: 'r2' })
  return { port: { read, write: wrote }, read, write: wrote }
}

describe('the readout', () => {
  it('the wire shape the backend sends', async () => {
    const { port } = wire({})
    const answer = await createAgentProviderClient(port).read('opencode', 'default')

    expect(answer).toEqual({
      profileId: 'default',
      agentId: 'opencode',
      mode: 'app-managed',
      root: '/home/someone/.local/share/nekowite/agent-profiles/default',
      revision: 'r1',
      provider: 'iapp',
      modelId: 'iapp/deepseek-v4-flash',
      editable: true,
      sources: [
        { kind: 'injected', variable: 'OPENCODE_CONFIG_DIR', path: '/tmp/profile' },
        { kind: 'engine-discovery', what: 'the project .opencode directory' },
      ],
      credentials: [{ name: 'ANTHROPIC_API_KEY', value: '<redacted>' }],
      credentialStorage: { kind: 'host-file', path: '/tmp/profile/auth.json', mode: '600', encrypted: false, keychain: false },
    })
  })

  it('answers the pair the record is, not the pair that was asked for', async () => {
    // §8.1: a profile belongs to one engine, and the page compares what it got with what it
    // believes it is showing (`profileProblem`). The client must not paper over a mismatch.
    const { port } = wire({ read: record({ agentId: 'acme' }) })
    const answer = await createAgentProviderClient(port).read('opencode', 'default')
    expect(answer.agentId).toBe('acme')
  })

  it('reads a profile whose provider and model are unset as null, not as an empty string', async () => {
    const { port } = wire({ read: record({ provider: null, modelId: null }) })
    const answer = await createAgentProviderClient(port).read('opencode', 'default')
    expect(answer.provider).toBeNull()
    expect(answer.modelId).toBeNull()
  })

  it('refuses a mode this build does not know rather than defaulting it', async () => {
    const { port } = wire({ read: record({ mode: 'host-managed' }) })
    await expect(createAgentProviderClient(port).read('opencode', 'default')).rejects.toThrow(/mode/)
  })

  it('refuses a source kind it does not know', async () => {
    const { port } = wire({ read: record({ sources: [{ kind: 'environment', what: 'x' }] }) })
    await expect(createAgentProviderClient(port).read('opencode', 'default')).rejects.toThrow(
      /sources\[0\]\.kind/,
    )
  })

  it('refuses a storage record that claims encryption, rather than drawing the opposite', async () => {
    // The page's sentence is "not encrypted, no keychain" (§8.1), and its type can only say
    // `false`. A backend that answered `true` would be describing a promise this window cannot
    // render, so the answer is a rejection with a retry — never a reassurance it cannot back.
    const { port } = wire({
      read: record({
        credentialStorage: { kind: 'host-file', path: '/tmp/a', mode: '600', encrypted: true, keychain: false },
      }),
    })
    await expect(createAgentProviderClient(port).read('opencode', 'default')).rejects.toThrow(
      /credentialStorage\.encrypted/,
    )
  })

  it('a credential value the backend sends is passed through as it is', async () => {
    // The masking is the backend's and the page's; this layer's job is not to invent a third
    // treatment. What it must never do is put the value in an *error*, which the last group checks.
    const { port } = wire({
      read: record({ credentials: [{ name: 'ANTHROPIC_API_KEY', value: '' }] }),
    })
    const answer = await createAgentProviderClient(port).read('opencode', 'default')
    expect(answer.credentials).toEqual([{ name: 'ANTHROPIC_API_KEY', value: '' }])
  })
})

describe('a write', () => {
  it('sends the pair, the revision and the three fields, under the names the command takes', async () => {
    const { port, write: wrote } = wire({})
    await createAgentProviderClient(port).write(write)

    // `agent_profile_write` takes `agent_id`, `profile_id`, `revision` and `submission`, and Tauri
    // camel-cases the first three: a key in the wrong case rejects, which reads exactly like the
    // command not being registered at all.
    expect(wrote).toHaveBeenCalledWith({
      agentId: 'opencode',
      profileId: 'default',
      revision: 'r1',
      submission: { mode: 'app-managed', provider: 'iapp', modelId: 'iapp/x' },
    })
  })

  it('an applied write comes back as applied, with the fields that were submitted', async () => {
    const { port } = wire({ write: { status: 'written', revision: 'r2' } })
    const answer = await createAgentProviderClient(port).write(write)
    expect(answer).toEqual({ status: 'applied', fields })
  })

  it('a conflict comes back with the record to rebuild the form from', async () => {
    const { port } = wire({ write: { status: 'conflict', current: record({ revision: 'r9' }) } })
    const answer = await createAgentProviderClient(port).write(write)
    expect(answer.status).toBe('conflict')
    expect(answer.status === 'conflict' && answer.current.revision).toBe('r9')
  })

  it('a write answer with no revision is refused: the next write has nothing to be built on', async () => {
    const { port } = wire({ write: { status: 'written' } })
    await expect(createAgentProviderClient(port).write(write)).rejects.toThrow(/revision/)
  })

  it('a status this build does not know is refused rather than read as a success', async () => {
    const { port } = wire({ write: { status: 'saved' } })
    await expect(createAgentProviderClient(port).write(write)).rejects.toThrow(/status/)
  })

  it('the backend refusing stays a rejection, which is the page’s failed-send state', async () => {
    // `agent_settings.rs` answers a refusal by rejecting with its own sentence. It is not turned
    // into `{status:'refused'}` here: that arm's reason codes are the *pre-flight* vocabulary
    // (`decideProfileWrite`), and mapping prose onto them would be inventing a diagnosis.
    const port: AgentProfileWire = {
      read: async () => record(),
      write: async () => {
        throw new Error('`host-managed` is not a mode this app writes')
      },
    }
    await expect(createAgentProviderClient(port).write(write)).rejects.toThrow(/not a mode/)
  })
})

describe('a malformed answer', () => {
  it('is a rejection, so the page says so instead of drawing a blank row', async () => {
    const { port } = wire({ read: { ...record(), revision: 7 } })
    await expect(createAgentProviderClient(port).read('opencode', 'default')).rejects.toThrow(
      /revision/,
    )
  })

  it('names the field and never a value from the payload', async () => {
    // The value is unknown by construction — that is why the check failed — and the same answer
    // carries the credential masked by name; a message built from the payload is how a value
    // reaches a log, a toast or a screenshot it should not be in.
    const { port } = wire({
      read: record({
        provider: 42,
        credentials: [{ name: 'ANTHROPIC_API_KEY', value: 'sk-live-NEVER-PRINTED' }],
      }),
    })
    const failed = await createAgentProviderClient(port)
      .read('opencode', 'default')
      .then(() => null, (error: Error) => error)
    expect(failed?.message).toMatch(/provider/)
    expect(failed?.message).not.toContain('sk-live-NEVER-PRINTED')
  })
})
