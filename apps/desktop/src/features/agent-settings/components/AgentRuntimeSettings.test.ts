/**
 * The runtime page, rendered: the arms where it must draw *less*, held at the level a user meets
 * them.
 *
 * `agent-runtime-ipc.test.ts` holds the wire as values, and `SettingsPanel.agents.test.ts` holds the
 * page where a reader actually reaches it. This file exists for the arms those two do not take:
 * every one of them is a case where the honest page is the *smaller* one, and each is a rule the
 * first version of this page broke.
 *
 *  - **No negotiation, no negotiation to draw.** A `not-read` handshake draws the backend's own
 *    sentence in place of the protocol line *and* the capability list — not an empty list, and not a
 *    version. The page this replaced drew `Not negotiated in this runtime` from a readout that had
 *    never asked an engine anything, which is a claim about an engine made from a failed read of one.
 *  - **A label with nothing under it is not drawn.** ACP makes `agentInfo` optional, so an engine
 *    that sent none gets no line at all rather than a heading and a blank.
 *  - **An engine that advertises no authentication says so.** The empty list is a fact ("it named
 *    none"), and it is a different sentence from the list itself.
 *  - **Nothing here is pressable.** The methods are the engine's advertisement and this app has no
 *    call that acts on one, so the page draws the sentence saying so and no control at all — §7.2's
 *    「不能让按钮看起来可用」 at the one place on this page where it could have been broken.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { setLocale } from '../../../i18n'
import AgentRuntimeSettings from './AgentRuntimeSettings.vue'
import type { AgentRuntimeReadout } from './AgentRuntimeSettings.vue'

let mounted: VueApp[] = []

beforeEach(() => {
  setLocale('en')
  document.body.innerHTML = ''
  mounted = []
})

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
  document.body.innerHTML = ''
})

function readout(overrides: Partial<AgentRuntimeReadout> = {}): AgentRuntimeReadout {
  return {
    agentId: 'bundled-engine',
    displayName: 'Bundled Engine',
    source: 'bundled',
    program: '/opt/nekowite/engine',
    reportedVersion: '1.18.29',
    adapterId: 'opencode',
    process: 'ready',
    updatePolicy: 'host-managed',
    handshake: {
      status: 'read',
      protocolVersion: 1,
      agentName: 'OpenCode',
      agentVersion: '1.18.29',
      authMethods: [{ id: 'opencode-login', name: 'Sign in to OpenCode' }],
    },
    capabilities: [
      { feature: 'session-list', standing: 'advertised', detail: null },
    ],
    ...overrides,
  }
}

async function render(answer: AgentRuntimeReadout): Promise<void> {
  // Cleared first, so a test that renders twice reads the second page rather than the first one
  // still sitting in the document.
  document.body.innerHTML = ''
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(AgentRuntimeSettings, {
    client: { read: async () => answer },
  })
  app.mount(host)
  mounted.push(app)
  await nextTick()
  await nextTick()
}

function el(dataTest: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-test="${dataTest}"]`)
}

describe('the runtime page, when nothing has been negotiated', () => {
  const absent = readout({
    process: 'stopped',
    handshake: { status: 'not-read', reason: 'no-engine' },
    capabilities: [],
  })

  it('draws the sentence for the reason the host named, and no version, name or row', async () => {
    await render(absent)

    expect(el('runtime-not-negotiated')?.textContent).toContain('No engine is running')
    // The other id reaches its own sentence — neither is a stand-in for the other, and a page that
    // drew one of them for both would be telling a user to go and start an engine they already have.
    await render(
      readout({
        handshake: { status: 'not-read', reason: 'not-yet' },
        capabilities: [],
      }),
    )
    expect(el('runtime-not-negotiated')?.textContent).toContain('has not been asked yet')
    expect(el('runtime-not-negotiated')?.textContent).not.toContain('No engine is running')

    await render(absent)
    for (const absent of [
      'runtime-protocol',
      'runtime-engine-report',
      'runtime-auth-methods',
      'runtime-auth-none',
      'runtime-capability-session-list',
    ]) {
      expect(el(absent), absent).toBeNull()
    }
  })

  it('still draws what is a fact about this app rather than about an engine', async () => {
    // The process state, the program and the provenance are answers the host has without asking
    // anything — and the update policy is the provenance's, not a network's. Dropping them with the
    // handshake would make "no engine" read as "nothing is known".
    await render(absent)

    expect(el('runtime-process')?.textContent).toContain('Not running')
    expect(el('runtime-agent')?.textContent).toContain('bundled-engine')
    expect(el('runtime-program')?.textContent).toContain('/opt/nekowite/engine')
    expect(el('runtime-update')).not.toBeNull()
    // And the §3.1.4 sentence is *not* drawn, because it exists to qualify a running process.
    expect(el('runtime-not-a-model')).toBeNull()
  })
})

describe('the runtime page, when the handshake answered', () => {
  it('draws no line for an engine that sent no agentInfo', async () => {
    // A heading with nothing under it reads as a fact that failed to arrive. ACP documents the
    // field as optional, so the absence is an engine that said nothing — and the protocol version
    // beside it is still an answer, which is why this is not the `not-read` arm.
    await render(
      readout({
        handshake: {
          status: 'read',
          protocolVersion: 1,
          agentName: null,
          agentVersion: null,
          authMethods: [],
        },
      }),
    )

    expect(el('runtime-engine-report')).toBeNull()
    expect(el('runtime-protocol')?.textContent).toContain('1')
  })

  it('says an engine advertised no authentication, rather than drawing nothing', async () => {
    await render(
      readout({
        handshake: {
          status: 'read',
          protocolVersion: 1,
          agentName: 'OpenCode',
          agentVersion: '1.18.29',
          authMethods: [],
        },
      }),
    )

    expect(el('runtime-auth-none')).not.toBeNull()
    expect(el('runtime-auth-methods')).toBeNull()
    // The note about what this app does with these is drawn either way: it is about the app, not
    // about how many methods there are.
    expect(el('runtime-auth-not-acted-on')).not.toBeNull()
  })

  it('offers nothing to press, on any arm', async () => {
    await render(readout())
    const section = document.querySelector<HTMLElement>('.runtime')
    expect(section).not.toBeNull()
    // No control of any kind: not an enabled one, and not a disabled one either — a disabled control
    // claims the shape of an action that is merely unavailable, and every fact on this page is one
    // this page does not own.
    for (const selector of ['button', 'input', 'select', 'textarea', '[role="switch"]']) {
      expect(section?.querySelectorAll(selector).length, selector).toBe(0)
    }
    // The retry is the one control that ever exists here, and only in the unreadable state.
    expect(el('runtime-retry')).toBeNull()
  })

  it('draws the reason the runtime is unreadable, and a retry, when the read rejects', async () => {
    // A rejection is the call not completing — a different thing from a runtime that is not up,
    // which arrives as data (`process: 'stopped'`). Collapsing them would report an engine as
    // absent because this window could not read one.
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp(AgentRuntimeSettings, {
      client: {
        read: async () => {
          throw new Error('no handler registered')
        },
      },
    })
    app.mount(host)
    mounted.push(app)
    await nextTick()
    await nextTick()

    expect(el('runtime-unreadable')).not.toBeNull()
    expect(el('runtime-retry')).not.toBeNull()
    expect(el('runtime-process')).toBeNull()
  })
})
