/**
 * The capability report, and the two pins that hold this window's copies to the Rust source.
 *
 * A page renders a feature as it arrived rather than translating it, and the host decides what this
 * app offers; both tables live in TypeScript as copies, so both are read off the Rust that owns
 * them (`adapters/mod.rs`, `capabilities.rs`) instead of being trusted. The paths are the pin: a
 * Rust file that moves or is split turns these red, which is the point of keeping them.
 */

import { describe, expect, it, vi } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn())
const listenMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { AGENT_CAPABILITY_FEATURES, AGENT_CAPABILITY_HOST_OFFERS } from './agent-contracts'
import { createTauriAgentGateway } from './tauri-agent'
import { capabilityAnswer, fakeIpc, openSessionOn } from './tauri-agent-fake-host'

// ---------------------------------------------------------------------------
// The capability report
// ---------------------------------------------------------------------------

describe('the capability report', () => {
  it('asks the host for the session’s report and hands every row on, declared beside finding', async () => {
    const ipc = fakeIpc()
    const gateway = createTauriAgentGateway({ vaultId: 'vault-1', ipc })
    const session = await openSessionOn(gateway)

    const reports = await gateway.capabilities(session)

    expect(ipc.calls).toContain('capabilities')
    expect(reports.map((report) => report.feature)).toEqual([...AGENT_CAPABILITY_FEATURES])
    expect(reports.find((report) => report.feature === 'image-attachments')).toEqual({
      feature: 'image-attachments',
      declared: 'unverified',
      finding: { status: 'available' },
      host: { status: 'control' },
    })
    // The three halves stay three fields: a report that merged the finding with the host's own half
    // could not show the case the third one exists for — an engine that advertises something
    // nothing in this build can ask it for.
    expect(reports.find((report) => report.feature === 'slash-commands')).toEqual({
      feature: 'slash-commands',
      declared: 'unverified',
      finding: { status: 'unverified', detail: 'slash-commands has not been negotiated' },
      host: { status: 'control' },
    })
  })

  it('refuses a report it cannot read, rather than showing a shorter one', async () => {
    // Every arm below is a way the host could answer something this contract does not describe, and
    // each one would reach a page as a *fact* if it were repaired on the way through: a row with no
    // reason, a feature the window cannot render, and a report that simply left one out.
    const unreadable: unknown[] = [
      capabilityAnswer(() => ({ status: 'unavailable' })),
      [{ feature: 'telepathy', declared: 'advertised', finding: { status: 'available' } }],
      capabilityAnswer().slice(1),
    ]
    for (const answer of unreadable) {
      const ipc = fakeIpc({ capabilities: async () => answer })
      const gateway = createTauriAgentGateway({ vaultId: 'vault-1', ipc })
      const session = await openSessionOn(gateway)
      await expect(gateway.capabilities(session)).rejects.toMatchObject({
        code: 'invalid-response',
      })
    }
  })

  it('refuses a report about a session this gateway did not open', async () => {
    // The same boundary every session-scoped call passes: rows are state about a session, and a
    // handle the book does not know is not one to answer about.
    const ipc = fakeIpc()
    const gateway = createTauriAgentGateway({ vaultId: 'vault-1', ipc })
    const session = await openSessionOn(gateway)
    // A second runtime instance: the handles of the first are stale rather than merely unknown
    // (§6.2), and the report is refused before any call leaves the window.
    await gateway.stop()
    await gateway.start()

    await expect(gateway.capabilities(session)).rejects.toMatchObject({ code: 'session-stale' })
    expect(ipc.calls).not.toContain('capabilities')
  })

  it('names the features the host names, read off both sides', () => {
    // The list is data: a page renders `feature` as it arrived rather than translating it, so a
    // rename on either side is a page showing a name nothing produces. The Rust half is the
    // authority (`HostFeature::ALL`) and this test reads its source, because a TypeScript test
    // cannot import a Rust enum — the same guard `tauri-pet.test.ts` keeps over the care ledger.
    const rust = readFileSync(
      resolve(__dirname, '../../../src-tauri/src/agent_runtime/adapters/mod.rs'),
      'utf8',
    )
    const start = rust.indexOf('pub const ALL: [HostFeature;')
    expect(start, 'HostFeature::ALL is not declared in adapters/mod.rs').toBeGreaterThan(-1)
    const list = rust.slice(start, rust.indexOf('];', start))
    const variants = [...list.matchAll(/HostFeature::(\w+)/g)].map(([, variant]) => variant)
    expect(variants.length, 'HostFeature::ALL lists no features').toBeGreaterThan(0)

    // The spellings, from `as_str`, which is where the host decides what it calls them.
    const asStr = rust.slice(rust.indexOf('pub fn as_str(&self)'))
    const spelling = new Map(
      [...asStr.matchAll(/HostFeature::(\w+) => "([a-z-]+)"/g)].map(([, variant, name]) => [
        variant,
        name,
      ]),
    )
    expect(
      variants.map((variant) => spelling.get(variant)),
      'the contract’s feature list no longer matches the host’s',
    ).toEqual([...AGENT_CAPABILITY_FEATURES])
  })

  it('offers what the host offers, read off both sides', () => {
    // `AGENT_CAPABILITY_HOST_OFFERS` is a copy of `host_offer` in `agent_runtime/capabilities.rs`,
    // and this is what keeps it one: the host decides what this app offers, the window only renders
    // it, and the arm that matters — `nothing` — is the one a stale copy would quietly get wrong,
    // telling a reader that a feature the engine advertises is reachable here.
    //
    // The variant-to-feature spelling comes from `adapters/mod.rs`, the same authority the case
    // above reads, because `capabilities.rs` matches on the Rust enum rather than on the wire name.
    const directory = resolve(__dirname, '../../../src-tauri/src/agent_runtime')
    const adapters = readFileSync(resolve(directory, 'adapters/mod.rs'), 'utf8')
    const asStr = adapters.slice(adapters.indexOf('pub fn as_str(&self)'))
    const spelling = new Map(
      [...asStr.matchAll(/HostFeature::(\w+) => "([a-z-]+)"/g)].map(([, variant, name]) => [
        variant,
        name,
      ]),
    )

    const source = readFileSync(resolve(directory, 'capabilities.rs'), 'utf8')
    const start = source.indexOf('fn host_offer(')
    expect(start, 'host_offer is not declared in capabilities.rs').toBeGreaterThan(-1)
    const body = source.slice(start, source.indexOf('\n}', start))
    // One arm per line group: `HostFeature::A | HostFeature::B => HostOffer::Control,`, and the
    // `Command` arm carries its name in a braced field on the lines after the arrow.
    const arms = [
      ...body.matchAll(
        /((?:HostFeature::\w+\s*(?:\|\s*)?)+)=>\s*HostOffer::(\w+)\s*,?\s*(?:\{\s*command:\s*"([^"]+)",?\s*\})?/g,
      ),
    ]
    expect(arms.length, 'host_offer matched no arms').toBeGreaterThan(0)
    const offered = new Map<string, unknown>()
    for (const [, variants, arm, command] of arms) {
      for (const [, variant] of variants!.matchAll(/HostFeature::(\w+)/g)) {
        const feature = spelling.get(variant!)
        expect(feature, `${variant} has no wire spelling`).toBeDefined()
        expect(offered.has(feature!), `${feature} is matched twice`).toBe(false)
        offered.set(
          feature!,
          arm === 'Command'
            ? { status: 'command', command }
            : { status: arm === 'Control' ? 'control' : 'nothing' },
        )
      }
    }
    // Every feature, or the parse quietly matched fewer arms than the function has and the
    // equality below would be comparing a short table against a full one.
    expect([...offered.keys()].sort()).toEqual([...AGENT_CAPABILITY_FEATURES].sort())

    expect(Object.fromEntries(offered)).toEqual({ ...AGENT_CAPABILITY_HOST_OFFERS })
  })
})
