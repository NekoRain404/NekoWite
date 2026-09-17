/**
 * The strip's second fact: what the turn cost.
 *
 * `lastResult.usage` has been reaching this component since `run-finished` was first reduced —
 * `runs.rs` puts the engine's own usage object into the payload, the reducer stores it whole, and
 * the panel hands the result down — and the bar read two fields of it and stopped. What this file
 * holds is the whole of the claim the render makes: **the numbers are the engine's**, so a counter
 * it did not send is not drawn, a total it did not send is not computed from the two it did, and an
 * engine that reported nothing gets no line at all rather than a zero (§5.1: an unknown cost is not
 * a free one).
 *
 * The bar is mounted on its own rather than through the panel: it is props-in, events-out, and its
 * two callers in the panel's own tests are about the transcript rather than about this line.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, type App as VueApp } from 'vue'
import AgentSessionBar, { type AgentSessionBarLabels } from './AgentSessionBar.vue'
import { setLocale } from '../../../i18n'
import type { AgentRunResult } from '../../../platform/gateways/agent-contracts'

/** The bar's own words, as its caller supplies them (`src/app/AgentRailBody.vue` builds the same
 *  tree from the catalogue). The usage sentences are deliberately not in here: they carry a `{n}`
 *  slot and are read from the catalogue by the component, as the history menu's ages are. */
const LABELS: AgentSessionBarLabels = {
  untitled: 'New Memory session',
  state: {
    idle: 'Idle',
    starting: 'Starting',
    ready: 'Ready',
    running: 'Working',
    'waiting-permission': 'Waiting for you',
    completed: 'Finished',
    cancelled: 'Stopped',
    failed: 'Failed',
  },
  result: {
    'end-turn': 'Answered',
    'max-tokens': 'Stopped at the engine’s token ceiling',
    'max-turn-requests': 'Stopped at the engine’s request ceiling',
    refusal: 'The engine declined to continue',
    cancelled: 'Stopped before it finished',
    unrecognised: 'Ended for a reason this version does not know',
  },
}

let mounted: VueApp[] = []

beforeEach(() => {
  setLocale('en')
})

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
  document.body.innerHTML = ''
})

function mountBar(result: AgentRunResult | null): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(AgentSessionBar, {
    title: null,
    state: 'completed',
    failure: null,
    result,
    history: false,
    historyOpen: false,
    labels: LABELS,
  })
  app.mount(host)
  mounted.push(app)
  return host
}

const barUsage = (host: HTMLElement): HTMLElement | null =>
  host.querySelector<HTMLElement>('[data-agent-usage]')

describe('AgentSessionBar — the turn’s own token counts', () => {
  it('draws the total the engine reported, and every counter under it on hover', () => {
    // One of the two live measurements: `{"totalTokens":9189,…,"cachedReadTokens":8192}`.
    const host = mountBar({
      stopReason: 'end-turn',
      usage: { inputTokens: 1721, outputTokens: 6, totalTokens: 9189, cachedReadTokens: 8192 },
    })

    const usage = barUsage(host)
    expect(usage).not.toBeNull()
    expect(usage?.textContent?.trim()).toBe('9.2k tokens')
    // The exact numbers are not lost to the headline: the hover text names them, and the counter
    // the audit singled out — the cached read — is in it.
    expect(usage?.getAttribute('title')).toBe(
      ['input 1721', 'output 6', 'total 9189', 'cache read 8192'].join('\n'),
    )
  })

  it('draws the two counters an engine sent instead of a total, and never their sum', () => {
    // P0 §6.3: `totalTokens` is not the sum of its parts (1721 + 6 against a reported 8895), so a
    // strip that added them up would print a number the engine never sent.
    const host = mountBar({
      stopReason: 'end-turn',
      usage: { inputTokens: 1721, outputTokens: 6 },
    })

    expect(barUsage(host)?.textContent?.trim()).toBe('1.7k in · 6 out')
    expect(barUsage(host)?.getAttribute('title')).toBe('input 1721\noutput 6')
  })

  it('draws nothing at all when the engine reported no usage', () => {
    // The engine's `usage` object is optional on the wire and the reader answers `null` for one
    // that carried no counters. Nothing is drawn: a zero here would read as a free turn, which is
    // the one thing §5.1 says an unknown cost must not become.
    const host = mountBar({ stopReason: 'end-turn', usage: null })
    expect(barUsage(host)).toBeNull()
    // And a run that ended before it could report any: `cancelled` carries `usage: null` too.
    expect(barUsage(mountBar({ stopReason: 'cancelled', usage: null }))).toBeNull()
    expect(barUsage(mountBar(null))).toBeNull()
  })

  it('keeps a zero the engine really sent, rather than reading it as absent', () => {
    // The other side of the same rule, and the contract's own words (`payloads.ts`, `AgentUsage`):
    // a reported `0` is kept and is a different thing from a field nobody reported. It is the
    // engine's fact, so it is drawn as one.
    const host = mountBar({ stopReason: 'end-turn', usage: { totalTokens: 0 } })
    expect(barUsage(host)?.textContent?.trim()).toBe('0 tokens')
  })

  it('rounds for the strip and not for the record', () => {
    // Zed's rule (`humanize_token_count`): exact below a thousand, one decimal in the thousands,
    // whole thousands above ten thousand. The exact values above are asserted in the hover text.
    const exact = (total: number): string =>
      barUsage(mountBar({ stopReason: 'end-turn', usage: { totalTokens: total } }))
        ?.textContent?.trim() ?? ''
    expect(exact(999)).toBe('999 tokens')
    expect(exact(1000)).toBe('1k tokens')
    expect(exact(8733)).toBe('8.7k tokens')
    expect(exact(87330)).toBe('87k tokens')
    expect(exact(1_250_000)).toBe('1.3M tokens')
  })
})
