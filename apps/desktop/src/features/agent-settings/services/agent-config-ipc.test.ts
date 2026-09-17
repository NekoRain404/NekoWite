/**
 * The configuration-document client: what it does with each answer `agent_settings.rs` can give.
 *
 * The wire literals below are the *shape* `read_document` / `submit_document` serialize, written out
 * by hand rather than derived from the Rust types, because the coupling this file guards is between
 * two processes: a renamed JSON field keeps every Rust assertion green and would leave the page
 * offering to edit a document whose revision never arrived.
 *
 * Four properties, one per group, and the third is the one the whole capability rule rests on:
 *
 *  - **The document's *name* is the backend's.** The relative path comes off the profile readout,
 *    never from this file — so `configDocument: null` must mean "there is no document to open", and
 *    the document command must not be called at all in that case. A client that defaulted to a path
 *    would draw an editor for a profile whose configuration belongs to the user's own installation.
 *  - **The pair guard rejects rather than renders.** This page writes, and a document read from
 *    another profile's record would be edited at that profile's path.
 *  - **A malformed answer is a rejection, not an empty document.** "The engine has written nothing"
 *    is a claim about the file; a shape this window cannot read is a fact about this window. The
 *    second collapsing into the first is how an editor gets drawn over a document that failed to
 *    arrive.
 *  - **Both edit arms are the backend's.** `written` advances the revision; `conflict` carries the
 *    document that is there instead, and `null` when the file is gone — never a merge.
 */

import { describe, expect, it, vi } from 'vitest'

import { createAgentConfigClient, type AgentConfigWire } from './agent-config-ipc'
import type { AgentProviderClient } from './agent-profile-ipc'
import type { AgentProfileReadout } from './agent-settings-policy'

const RELATIVE = 'XDG_CONFIG_HOME/opencode/opencode.json'

/** The document's answer, as `read_document` serializes it. */
function documentReadout(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    path: '/home/someone/.local/share/nekowite/agent-profiles/default/XDG_CONFIG_HOME/opencode/opencode.json',
    exists: true,
    revision: 'a'.repeat(64),
    text: '{\n  "permission": { "edit": "ask" }\n}\n',
    editable: true,
    ...overrides,
  }
}

/** The profile's readout, as far as this client reads it: the pair and the document's name. */
function profile(overrides: Partial<AgentProfileReadout> = {}): AgentProfileReadout {
  return {
    profileId: 'default',
    agentId: 'bundled-engine',
    mode: 'app-managed',
    root: '/home/someone/.local/share/nekowite/agent-profiles/default',
    revision: 'r1',
    provider: null,
    modelId: null,
    editable: true,
    sources: [],
    credentials: [],
    credentialStorage: { kind: 'none' },
    permissions: { state: 'written', document: null, rules: [] },
    configDocument: RELATIVE,
    ...overrides,
  }
}

function wire(answers: {
  profile?: AgentProfileReadout | null
  document?: unknown
  edit?: unknown
}): { profile: AgentProviderClient; config: AgentConfigWire; read: ReturnType<typeof vi.fn>; edit: ReturnType<typeof vi.fn> } {
  const readConfig = vi.fn(async () => answers.document ?? documentReadout())
  const edit = vi.fn(async () => answers.edit ?? { status: 'written', revision: 'b'.repeat(64) })
  const readProfile = vi.fn(async () => answers.profile ?? profile())
  return {
    profile: { read: readProfile, write: vi.fn() } as unknown as AgentProviderClient,
    config: { read: readConfig, edit },
    read: readConfig,
    edit,
  }
}

function client(answers: Parameters<typeof wire>[0]) {
  const parts = wire(answers)
  return {
    parts,
    port: createAgentConfigClient({
      profile: parts.profile,
      config: parts.config,
      agentId: 'bundled-engine',
      profileId: 'default',
    }),
  }
}

describe('the document read', () => {
  it('the wire shape the backend sends, with the path the profile named', async () => {
    const { port, parts } = client({})
    const answer = await port.read()

    expect(answer).toEqual({
      state: 'document',
      document: {
        // The path an edit is submitted with — the backend named it, this file did not.
        path: RELATIVE,
        resolved:
          '/home/someone/.local/share/nekowite/agent-profiles/default/XDG_CONFIG_HOME/opencode/opencode.json',
        exists: true,
        revision: 'a'.repeat(64),
        text: '{\n  "permission": { "edit": "ask" }\n}\n',
        editable: true,
      },
    })
    // The path submitted is the one the backend named, not one this file knows.
    expect(parts.read).toHaveBeenCalledWith('bundled-engine', 'default', RELATIVE)
  })

  it('reads a profile this host owns no document for as no document, without asking for one', async () => {
    // `user-config`: the engine reads the user's own installation's configuration. The document
    // command takes a path inside the profile root, and this profile has none — so the call must
    // not be made at all. This is the capability rule at the client's level: no document reported,
    // no read attempted, and the page draws a sentence rather than a form.
    const { port, parts } = client({ profile: profile({ configDocument: null, mode: 'user-config' }) })
    const answer = await port.read()

    expect(answer).toEqual({ state: 'no-document' })
    expect(parts.read).not.toHaveBeenCalled()
  })

  it('refuses a document read from another profile’s record', async () => {
    // The page writes. A mismatch means the path and the revision belong to a profile other than
    // the one this page is about, and the safe direction is to open nothing at all.
    const { port, parts } = client({ profile: profile({ profileId: 'other' }) })
    await expect(port.read()).rejects.toThrow(/other/)
    expect(parts.read).not.toHaveBeenCalled()
  })

  it('refuses a document whose answer is not the shape this window reads', async () => {
    // `exists` arriving as a string is a rename or a bug on the other side, and the page's answer
    // to it is "could not be read", never "there is nothing in the file".
    const { port } = client({ document: documentReadout({ exists: 'yes' }) })
    await expect(port.read()).rejects.toThrow(/exists/)
  })

  it('reads a document that is not on disk as an existing answer, not as a failure', async () => {
    // `exists: false` is normal: an engine that has never run has written nothing. The page's arm
    // for it is a sentence, and it is reached by this answer rather than by a rejection.
    const { port } = client({
      document: documentReadout({ exists: false, revision: null, text: null }),
    })
    expect(await port.read()).toEqual({
      state: 'document',
      document: {
        path: RELATIVE,
        resolved:
          '/home/someone/.local/share/nekowite/agent-profiles/default/XDG_CONFIG_HOME/opencode/opencode.json',
        exists: false,
        revision: null,
        text: null,
        editable: true,
      },
    })
  })
})

describe('the document edit', () => {
  it('sends the pair, the path the profile named, and the revision as arguments', async () => {
    const { port, parts } = client({})
    const edits = [{ path: ['permission'], value: { edit: 'ask' } }]
    await port.edit(RELATIVE, 'r1', edits)

    expect(parts.edit).toHaveBeenCalledWith({
      agentId: 'bundled-engine',
      profileId: 'default',
      relative: RELATIVE,
      revision: 'r1',
      edits,
    })
  })

  it('reads a written answer as the revision it wrote', async () => {
    const { port } = client({ edit: { status: 'written', revision: 'c'.repeat(64) } })
    expect(await port.edit(RELATIVE, 'r1', [])).toEqual({
      status: 'written',
      revision: 'c'.repeat(64),
    })
  })

  it('carries the document that is there instead of a conflict', async () => {
    // The caller reloads and rebuilds its edit from this. Merging is how a change made elsewhere
    // gets undone, which is why the backend sends the document and this client passes it through.
    const { port } = client({
      edit: {
        status: 'conflict',
        current: { revision: 'd'.repeat(64), text: '{ "permission": { "edit": "deny" } }' },
      },
    })
    expect(await port.edit(RELATIVE, 'r1', [])).toEqual({
      status: 'conflict',
      current: { revision: 'd'.repeat(64), text: '{ "permission": { "edit": "deny" } }' },
    })
  })

  it('carries a conflict with no document as null, not as an empty one', async () => {
    // `current: null` is the file being gone. `''` would read as a document with nothing in it, and
    // a caller rebuilding an edit from that would write over whatever is there now.
    const { port } = client({ edit: { status: 'conflict', current: null } })
    expect(await port.edit(RELATIVE, 'r1', [])).toEqual({ status: 'conflict', current: null })
  })

  it('refuses an edit answer whose status this window has no arm for', async () => {
    const { port } = client({ edit: { status: 'merged' } })
    await expect(port.edit(RELATIVE, 'r1', [])).rejects.toThrow(/status/)
  })
})
