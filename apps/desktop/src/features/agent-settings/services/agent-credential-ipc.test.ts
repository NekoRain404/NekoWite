/**
 * The credential client: what it sends, what it refuses to send, and what it does with the answer.
 *
 * The page next door is tested through its port, because the page's contract is the port. This is
 * the other half — the implementation of that port over the real IPC — and the four rules it owns
 * are all about the direction a credential travels:
 *
 * - a patch, never a whole set (a form that edits one credential cannot resubmit the others);
 * - nothing at all for a field that was not touched, which is what stops the placeholder the page
 *   displayed from being stored *as* the credential;
 * - a cleared field as a removal, not as an empty value a provider would reject much later;
 * - and the readout the command answers with is re-read through the profile client rather than
 *   narrowed a second time here, so there is one narrowing of one answer in the feature.
 */
import { describe, expect, it, vi } from 'vitest'
import { createAgentCredentialClient } from './agent-credential-ipc'
import type { AgentProfileReadout, CredentialField } from './agent-settings-policy'
import type { AgentProviderClient } from './agent-profile-ipc'

function readout(): AgentProfileReadout {
  return {
    profileId: 'default',
    agentId: 'opencode',
    mode: 'app-managed',
    root: '/profiles/default',
    revision: 'r1',
    provider: null,
    modelId: null,
    editable: true,
    sources: [],
    credentials: [{ name: 'ANTHROPIC_API_KEY', value: '' }],
    credentialStorage: { kind: 'none' },
    permissions: { state: 'written', document: null, rules: [] },
    configDocument: null,
  }
}

function client(wire = { write: vi.fn().mockResolvedValue({}) }, fresh = readout()) {
  const profile: AgentProviderClient = {
    read: vi.fn(async () => fresh),
    write: vi.fn(),
  }
  return {
    wire,
    profile,
    client: createAgentCredentialClient({
      wire,
      profile,
      agentId: 'opencode',
      profileId: 'default',
    }),
  }
}

function field(overrides: Partial<CredentialField> = {}): CredentialField {
  return { name: 'ANTHROPIC_API_KEY', display: '', draft: null, ...overrides }
}

describe('the credential client', () => {
  it('sends a touched field as a set and reads the profile back', async () => {
    const { wire, profile, client: credentials } = client()

    const answer = await credentials.write([field({ draft: 'sk-new' })])

    expect(wire.write).toHaveBeenCalledWith({
      agentId: 'opencode',
      profileId: 'default',
      changes: [{ op: 'set', name: 'ANTHROPIC_API_KEY', value: 'sk-new' }],
    })
    // The command answers the profile readout; this client drops it and re-reads through the one
    // client that narrows a readout, so the answer is that shape rather than a second opinion.
    expect(profile.read).toHaveBeenCalledWith('opencode', 'default')
    expect(answer.status).toBe('written')
  })

  it('sends nothing at all for a form saved without an edit', async () => {
    const { wire, client: credentials } = client()

    await credentials.write([field({ display: '<redacted>' })])

    // Not "sent with the placeholder": not sent. A patch carrying the page's own display value
    // would store the literal string as the credential.
    expect(wire.write).not.toHaveBeenCalled()
  })

  it('refuses the placeholder as a refusal rather than as a rejection', async () => {
    const { wire, client: credentials } = client()

    const answer = await credentials.write([field({ display: '<redacted>', draft: '<redacted>' })])

    expect(wire.write).not.toHaveBeenCalled()
    // The arm matters: a refusal is answered by the page, a rejection is thrown at it. Sending
    // this one to the backend would store `<redacted>` as the key and fail much later.
    expect(answer.status).toBe('refused')
  })

  it('sends a cleared field as a removal, never as an empty value', async () => {
    const { wire, client: credentials } = client()

    await credentials.write([field({ display: '<redacted>', draft: '' })])

    expect(wire.write).toHaveBeenCalledWith({
      agentId: 'opencode',
      profileId: 'default',
      changes: [{ op: 'remove', name: 'ANTHROPIC_API_KEY' }],
    })
  })

  it('lets a rejection stay a rejection', async () => {
    const wire = {
      write: vi
        .fn()
        .mockRejectedValue('profile `default` belongs to opencode; it cannot be opened as acme'),
    }
    const { client: credentials } = client(wire)

    await expect(credentials.write([field({ draft: 'sk-new' })])).rejects.toContain(
      'cannot be opened as acme',
    )
  })

  it('still answers a readout when the patch was empty', async () => {
    const { wire, profile, client: credentials } = client()

    const answer = await credentials.write([field({ display: '<redacted>' })])

    // Nothing was written, and the caller is still handed the readout it would have repainted
    // from. The alternative — answering the readout the caller already had — is a value this
    // client was never given, so the read is what the answer's type costs. One read on a save that
    // changed nothing is cheaper than a second readout shape in the feature.
    expect(wire.write).not.toHaveBeenCalled()
    expect(profile.read).toHaveBeenCalledTimes(1)
    expect(answer.status).toBe('written')
  })
})
