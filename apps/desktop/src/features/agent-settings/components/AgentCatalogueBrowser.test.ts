/**
 * The catalogue section, rendered: the two negatives, held at the level a user actually meets them.
 *
 * `agent-catalogue-policy.test.ts` holds the rules as values. This file exists for the one thing a
 * value test cannot prove — that the *drawing* obeys them — because the failure being guarded
 * against is a control on screen.
 *
 *  - **A row this build cannot act on draws no control at all.** Not a disabled one: a disabled
 *    button claims the shape of an action that is merely unavailable, while these three rows have
 *    nothing an action could do. The tests below assert the absence, per arm, at the DOM.
 *  - **Every row says what the registry does not know.** The unverified sentence is drawn on all
 *    four standings, so a row is never read as a feature list — §3.4's capability row, made visible
 *    where a user would otherwise expect one.
 *
 * The gates line is held here too: the refusal to install arrives with its reason, and a page that
 * stated the refusal alone would be asking a user to take it on trust.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { setLocale } from '../../../i18n'
import AgentCatalogueBrowser from './AgentCatalogueBrowser.vue'
import type { CatalogueReadout, CatalogueRow, CatalogueStanding } from '../services/agent-catalogue-policy'
import type { AgentCatalogueClient } from '../services/agent-catalogue-policy'

let mounted: VueApp[] = []

beforeEach(() => {
  setLocale('en')
  document.body.innerHTML = ''
  mounted = []
})

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
})

const GATES: CatalogueReadout['installGates'] = [
  { check: 'digest', transfers: false },
  { check: 'architecture', transfers: true },
  { check: 'execute-permission', transfers: true },
  { check: 'version', transfers: false },
  { check: 'acp-initialization', transfers: true },
  { check: 'contract-tests', transfers: false },
]

function row(id: string, standing: CatalogueStanding, offerable = true): CatalogueRow {
  return {
    id,
    name: `${id} agent`,
    version: '1.0.0',
    description: 'd',
    repository: null,
    website: null,
    authors: [],
    license: null,
    licenseUrl: 'https://example.com/l',
    iconUrl: null,
    standing,
    defects: [],
    offerable,
  }
}

/** The four standings, one row each, in one answer. */
const FOUR: readonly CatalogueRow[] = [
  row('mgr', {
    kind: 'via-package-manager',
    manager: 'npx',
    package: '@acme/ai-agent',
    program: 'npx',
    args: ['@acme/ai-agent', '--acp'],
    pinnedVersion: null,
  }),
  row('arc', { kind: 'archive-only', platform: 'linux-x86_64', cmd: './a' }),
  row('mac', { kind: 'unsupported', published: ['darwin-aarch64'] }),
  row('odd', { kind: 'unrecognised', kinds: ['docker'] }),
]

function client(answer: CatalogueReadout | Error): AgentCatalogueClient {
  return {
    readCatalogue: async () => {
      if (answer instanceof Error) throw answer
      return answer
    },
  }
}

function readout(rows: readonly CatalogueRow[], overrides: Partial<CatalogueReadout> = {}): CatalogueReadout {
  return {
    registryVersion: '1.0.0',
    freshness: 'current',
    note: null,
    rows,
    offerable: rows.filter((candidate) => candidate.offerable).length,
    installGates: GATES,
    ...overrides,
  }
}

async function mount(answer: CatalogueReadout | Error): Promise<HTMLElement> {
  const app = createApp(AgentCatalogueBrowser, { client: client(answer) })
  mounted.push(app)
  const host = document.createElement('div')
  document.body.appendChild(host)
  app.mount(host)
  await nextTick()
  await nextTick()
  return host
}

describe('the catalogue section', () => {
  it('draws a control for the package-manager row and for nothing else', async () => {
    // Three of the four arms get no button at all. `querySelector` returning null is the assertion:
    // a disabled button would satisfy `toBeTruthy` and fail this, which is the point.
    const host = await mount(readout(FOUR))
    expect(host.querySelector('[data-test="catalogue-use-mgr"]')).not.toBeNull()
    for (const id of ['arc', 'mac', 'odd']) {
      expect(host.querySelector(`[data-test="catalogue-use-${id}"]`)).toBeNull()
    }
    // And exactly one control in the whole section, counted rather than sampled: a template that
    // grew a second button would fail here even if each id-based check still passed.
    expect(host.querySelectorAll('button[data-test^="catalogue-use-"]')).toHaveLength(1)
  })

  it('says what the registry does not know, on every row whatever its standing is', async () => {
    // The rule that keeps a listing from reading as a capability report.
    const host = await mount(readout(FOUR))
    for (const id of ['mgr', 'arc', 'mac', 'odd']) {
      const sentence = host.querySelector(`[data-test="catalogue-unverified-${id}"]`)
      expect(sentence, id).not.toBeNull()
      expect(sentence!.textContent).toMatch(/established by talking to it/i)
    }
  })

  it('gives each inactionable arm its own reason rather than one "unavailable"', async () => {
    const host = await mount(readout(FOUR))
    const text = host.textContent ?? ''
    expect(text).toMatch(/package manager fetches/i)
    expect(text).toMatch(/make NekoWite the downloader/i)
    expect(text).toMatch(/not for this machine/i)
    expect(text).toMatch(/cannot read/i)
  })

  it('carries the refusal reason: which §3.3 checks do not transfer', async () => {
    // The refusal is drawn with its reason, and the reasons come from the readout rather than a
    // list in the component — so a backend that changed its answer changes this line.
    const host = await mount(readout(FOUR))
    const gates = host.querySelector('[data-test="catalogue-gates"]')
    expect(gates).not.toBeNull()
    const text = gates!.textContent ?? ''
    expect(text).toContain('digest')
    expect(text).toContain('version')
    expect(text).toContain('contract-tests')
    // A check that *does* transfer must not be named as a reason.
    expect(text).not.toContain('architecture')
    expect(text).not.toContain('acp-initialization')
  })

  it('offers the package-manager row as a prefill and never as a command line', async () => {
    // §3.4.3 across the DOM: what leaves the component is a program and an array, never a joined
    // string. A template that concatenated them would have nothing to emit here.
    const host = await mount(readout(FOUR))
    const emitted: unknown[] = []
    const app = createApp(AgentCatalogueBrowser, {
      client: client(readout(FOUR)),
      onUse: (prefill: unknown) => emitted.push(prefill),
    })
    mounted.push(app)
    const own = document.createElement('div')
    document.body.appendChild(own)
    app.mount(own)
    await nextTick()
    await nextTick()
    const button = own.querySelector<HTMLButtonElement>('[data-test="catalogue-use-mgr"]')
    expect(button).not.toBeNull()
    button!.click()
    await nextTick()
    expect(emitted).toEqual([
      {
        agentId: 'mgr',
        displayName: 'mgr agent',
        program: 'npx',
        args: ['@acme/ai-agent', '--acp'],
      },
    ])
    // The host from the first mount is untouched by the second: the control is per-component.
    expect(host.querySelector('[data-test="catalogue-used-mgr"]')).toBeNull()
  })

  it('separates an unreadable catalogue from an empty one', async () => {
    // A rejection is a fact about this window; no rows is a fact about the registry. A section that
    // drew the same thing for both would let a broken reader look like a small registry.
    const broken = await mount(new Error('the shape did not match'))
    expect(broken.querySelector('[data-test="catalogue-unreadable"]')).not.toBeNull()
    expect(broken.querySelector('[data-test="catalogue-empty"]')).toBeNull()

    const empty = await mount(readout([]))
    expect(empty.querySelector('[data-test="catalogue-empty"]')).not.toBeNull()
    expect(empty.querySelector('[data-test="catalogue-unreadable"]')).toBeNull()
  })

  it('marks a stale listing as stale and says why', async () => {
    // Rows served from a cache are real and old; a page that drew them as current would be the
    // flattering failure this section is written against.
    const host = await mount(
      readout(FOUR, { freshness: 'stale', note: 'the registry could not be reached (showing a copy fetched 2 hours ago)' }),
    )
    const line = host.querySelector('[data-test="catalogue-freshness"]')
    expect(line).not.toBeNull()
    expect(line!.textContent).toMatch(/out of date/i)
    expect(line!.textContent).toMatch(/2 hours ago/)
  })

  it('names a defect on the row that has one, and still draws the row', async () => {
    // An entry this build cannot use is reported rather than dropped: a vanished row would make a
    // malformed listing look like an agent that does not exist.
    const defect = readout([row('debs', { kind: 'archive-only', platform: 'linux-x86_64', cmd: './a' }, false)])
    const withDefect: CatalogueReadout = {
      ...defect,
      rows: [{ ...defect.rows[0]!, defects: ['https://example.com/a.deb: an installer format'] }],
    }
    const host = await mount(withDefect)
    const notes = host.querySelector('[data-test="catalogue-defects-debs"]')
    expect(notes).not.toBeNull()
    expect(notes!.textContent).toMatch(/installer format/)
    expect(host.querySelector('[data-test="catalogue-use-debs"]')).toBeNull()
  })
})
