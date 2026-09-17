/**
 * The permission client: the profile readout narrowed into the page's port.
 *
 * Behaviour, not screen — the same rule the settings policy's tests follow. What is worth pinning
 * here is the one decision the client makes that a reader cannot check from the page: **which
 * states draw rules and which draw none**. `written` is the only arm where this app's rules are the
 * ones the engine was given, and a client that drew them under either of the other two would be a
 * page telling a user they are protected by a rule the engine never received.
 */
import { describe, expect, it, vi } from 'vitest'
import { createAgentPermissionClient } from './agent-permission-ipc'
import type { AgentProfileWire } from './agent-profile-ipc'

/** One profile, as `agent_profile_read` answers it — only the member this client reads matters. */
function profile(permissions: unknown): unknown {
  return { profileId: 'default', agentId: 'opencode', permissions }
}

function wire(permissions: unknown): AgentProfileWire {
  return {
    read: vi.fn(async () => profile(permissions)),
    write: vi.fn(async () => ({ status: 'written', revision: 'r2' })),
  }
}

function client(permissions: unknown) {
  return createAgentPermissionClient({
    wire: wire(permissions),
    agentId: 'opencode',
    profileId: 'default',
  })
}

const WRITTEN = {
  state: 'written',
  document: '/profiles/default/XDG_CONFIG_HOME/opencode/opencode.json',
  rules: [
    { tool: 'edit', action: 'ask' },
    { tool: 'bash', action: 'ask' },
  ],
}

describe('the permission readout', () => {
  it('draws this app’s rules, with the document they were written into', async () => {
    const readout = await client(WRITTEN).read()
    expect(readout.state).toBe('written')
    expect(readout.rules).toEqual([
      {
        tool: 'edit',
        action: 'ask',
        origin: {
          kind: 'host',
          variable: null,
          path: '/profiles/default/XDG_CONFIG_HOME/opencode/opencode.json',
        },
      },
      {
        tool: 'bash',
        action: 'ask',
        origin: {
          kind: 'host',
          variable: null,
          path: '/profiles/default/XDG_CONFIG_HOME/opencode/opencode.json',
        },
      },
    ])
  })

  it('draws nothing when the engine’s own configuration carries the rules', async () => {
    // The document has its own `permission` member, so `profile.rs` deliberately wrote nothing —
    // and the rules this app ships are then not the ones in force.
    const readout = await client({ ...WRITTEN, state: 'engine-own' }).read()
    expect(readout.state).toBe('engine-own')
    expect(readout.rules).toEqual([])
  })

  it('draws nothing for a profile reusing the user’s own installation', async () => {
    const readout = await client({
      state: 'not-this-host',
      document: null,
      rules: WRITTEN.rules,
    }).read()
    expect(readout.state).toBe('not-this-host')
    expect(readout.rules).toEqual([])
  })

  it('never lists the option kinds, because they arrive with a request', async () => {
    // §6.3: the offered options are a property of the request the engine sends. This page is read
    // with no session running, so a list here would be one this app invented.
    expect((await client(WRITTEN).read()).optionKinds).toEqual([])
  })

  it('carries §6.3’s four limitations, and they are constants rather than a readout', async () => {
    // They are statements about what this app has not built, so there is no measurement that would
    // remove one — a page that read them from a backend could show fewer of them than exist.
    expect((await client(WRITTEN).read()).limits).toEqual([
      'not-a-sandbox',
      'no-isolation',
      'stale-requests',
      'no-silent-approval',
    ])
  })

  it('refuses a state this window has no sentence for', async () => {
    // A fourth state rendered as "nothing is wrong" is the one answer this page must not give.
    await expect(client({ ...WRITTEN, state: 'unknown' }).read()).rejects.toThrow(/permissions\.state/)
  })

  it('refuses a rule that is not a tool and an action', async () => {
    await expect(
      client({ ...WRITTEN, rules: [{ tool: 'edit' }] }).read(),
    ).rejects.toThrow(/permissions\.rules\[0\]\.action/)
  })

  it('refuses a record with no permissions member at all', async () => {
    await expect(client(undefined).read()).rejects.toThrow(/permissions/)
  })
})
