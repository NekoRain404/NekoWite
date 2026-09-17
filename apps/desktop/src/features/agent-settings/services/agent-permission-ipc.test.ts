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

/**
 * The grant half, as `agent_permission_grants` / `agent_permission_grant_revoke` answer.
 *
 * `answer` is what the list command returns; a removal returns whatever `after` says, so a test can
 * drive "the engine's list after the removal" separately from "the list before it" — which is the
 * whole point of the client trusting the backend's answer rather than editing its own copy.
 */
function grantsWire(answer: unknown, after: unknown = answer) {
  return {
    list: vi.fn(async () => answer),
    revoke: vi.fn(async () => after),
  }
}

function client(permissions: unknown) {
  return createAgentPermissionClient({
    wire: wire(permissions),
    grants: grantsWire({ kind: 'not-running' }),
    agentId: 'opencode',
    profileId: 'default',
  })
}

/** The same client, with the grants answer under the caller's control. */
function grantClient(answer: unknown, after?: unknown) {
  return createAgentPermissionClient({
    wire: wire(WRITTEN),
    grants: grantsWire(answer, after),
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

  it('refuses an absent document rather than reading it as null', async () => {
    // The one case the five clients’ narrowing copies disagreed on, and this is the copy that lost
    // it: an absent `document` was read as `null`, which is the "not this host's document" arm —
    // a state the backend never stated. The host sends the member as a path or as an explicit
    // `null` (`agent_settings.rs`'s `profile_view`), so a member that is not there at all is an
    // answer this build cannot read, and it takes the same rejection as every other field.
    await expect(
      client({ state: 'not-this-host', rules: [] }).read(),
    ).rejects.toThrow(/permissions\.document/)
  })
})

describe('the grants readout', () => {
  it('narrows the engine’s own four fields, verbatim', async () => {
    const client = grantClient({
      kind: 'listed',
      grants: [{ id: 'psv_1', projectId: 'global', action: 'edit', resource: '*' }],
    })
    expect(await client.grants()).toEqual({
      kind: 'listed',
      grants: [{ id: 'psv_1', projectId: 'global', action: 'edit', resource: '*' }],
    })
  })

  it('keeps the two non-answers apart from an empty list', async () => {
    // The defect this whole surface exists to remove: either of these drawn as `listed` with no
    // rows would be this app claiming the user has granted nothing, from a question it never put.
    expect(await grantClient({ kind: 'unsupported' }).grants()).toEqual({ kind: 'unsupported' })
    expect(await grantClient({ kind: 'not-running' }).grants()).toEqual({ kind: 'not-running' })
  })

  it('answers a removal with the engine’s list afterwards, not the row struck out', async () => {
    // The authority's answer and the page's belief about it must not be two different things.
    const client = grantClient({ kind: 'listed', grants: [{ id: 'psv_1', projectId: 'g', action: 'edit', resource: '*' }] }, { kind: 'listed', grants: [] })
    expect(await client.revoke('psv_1')).toEqual({ kind: 'listed', grants: [] })
  })

  it('refuses a kind this build has never heard of', async () => {
    // A newer backend is not a statement that the agent cannot report grants, so guessing
    // `unsupported` here would be inventing an answer out of a shape this window cannot read.
    await expect(grantClient({ kind: 'something-new' }).grants()).rejects.toThrow(/kind/)
    await expect(grantClient({ kind: 'listed', grants: [{ id: 'psv_1' }] }).grants()).rejects.toThrow(
      /grants\[0\]\.projectId/,
    )
  })
})
