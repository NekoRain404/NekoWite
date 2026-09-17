/**
 * The grants surface: what it draws for each of the three answers, and what one revoke does.
 *
 * Behaviour, not style, and the behaviour worth pinning is the one this whole surface exists for —
 * **the three readouts must not collapse into one drawing**. `unsupported` and `not-running` drawn
 * as a list with no rows would be this app saying "you have granted nothing" from a question it
 * never put to anyone, and the brief for this page calls that a defect rather than an empty state.
 * So each case below asserts both what is drawn *and* that the other two arms' elements are absent.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { setLocale } from '../../../i18n'
import AgentPermissionGrants from './AgentPermissionGrants.vue'
import type {
  AgentPermissionClient,
  GrantsReadout,
  PermissionReadout,
} from '../services/agent-permission-ipc'

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

/**
 * A page whose grants half is the caller's, and whose other half is never reached.
 *
 * The rules readout is a stub that throws rather than an empty one: this component must not call
 * it at all, and a component that started to would fail here with a sentence rather than with a
 * rendering nobody looked at.
 */
function client(grants: unknown, revoke: unknown = grants): AgentPermissionClient {
  return {
    read: async (): Promise<PermissionReadout> => {
      throw new Error('the grants component asked for the rules readout')
    },
    grants: async () => grants as GrantsReadout,
    revoke: async () => revoke as GrantsReadout,
  }
}

async function mount(client: AgentPermissionClient): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(AgentPermissionGrants, { client })
  mounted.push(app)
  app.mount(host)
  await nextTick()
  await nextTick()
}

const row = (test: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-test="${test}"]`)

const LISTED: GrantsReadout = {
  kind: 'listed',
  grants: [
    { id: 'psv_1', projectId: 'global', action: 'edit', resource: '*' },
    { id: 'psv_2', projectId: 'global', action: 'bash', resource: '*' },
  ],
}

describe('the grants the engine holds', () => {
  it('draws one row per grant, with the engine’s own fields', async () => {
    await mount(client(LISTED))
    expect(row('grant-psv_1')?.textContent).toContain('edit')
    expect(row('grant-psv_1')?.textContent).toContain('*')
    expect(row('grant-psv_1')?.textContent).toContain('global')
    expect(row('grant-psv_2')?.textContent).toContain('bash')
    expect(row('grants-empty')).toBeNull()
  })

  it('answers a removal with the engine’s own list afterwards', async () => {
    // The page does not strike the row out itself: what it draws after a revoke is the backend's
    // answer, which is why the fake's second answer is a *different* list here.
    const after: GrantsReadout = { kind: 'listed', grants: [LISTED.grants[1]] }
    await mount(client(LISTED, after))
    row('grant-revoke-psv_1')?.click()
    await nextTick()
    await nextTick()
    expect(row('grant-psv_1')).toBeNull()
    expect(row('grant-psv_2')).not.toBeNull()
  })

  it('says the engine holds nothing, and draws no control', async () => {
    await mount(client({ kind: 'listed', grants: [] }))
    expect(row('grants-empty')?.textContent).toContain('no lasting permission')
    expect(row('grants-unsupported')).toBeNull()
    expect(row('grants-not-running')).toBeNull()
    expect(document.querySelectorAll('button')).toHaveLength(0)
  })

  it('leaves the list alone and says so when the engine refuses the removal', async () => {
    const refused = Object.assign(new Error('the engine refused the removal of psv_1: 500'), {})
    await mount({
      read: async () => {
        throw new Error('unreached')
      },
      grants: async () => LISTED,
      revoke: async () => {
        throw refused
      },
    })
    row('grant-revoke-psv_1')?.click()
    await nextTick()
    await nextTick()
    // The engine's own sentence, and the row that is still there because nothing removed it.
    expect(row('grants-failure')?.textContent).toContain('500')
    expect(row('grant-psv_1')).not.toBeNull()
  })
})

describe('the two answers that are not a list', () => {
  it('says the agent cannot report grants, and never that none were given', async () => {
    await mount(client({ kind: 'unsupported' }))
    expect(row('grants-unsupported')?.textContent).toContain('does not report the permissions')
    expect(row('grants-empty')).toBeNull()
    expect(row('grants-list')).toBeNull()
    expect(document.querySelectorAll('button')).toHaveLength(0)
  })

  it('says no agent is running, offers a retry, and claims nothing about grants', async () => {
    await mount(client({ kind: 'not-running' }))
    expect(row('grants-not-running')?.textContent).toContain('No agent is running')
    expect(row('grants-empty')).toBeNull()
    expect(row('grants-retry')).not.toBeNull()
  })

  it('reports an engine that did not answer as unreadable rather than as empty', async () => {
    await mount({
      read: async () => {
        throw new Error('unreached')
      },
      grants: async () => {
        throw new Error('the engine answered nothing')
      },
      revoke: async () => {
        throw new Error('unreached')
      },
    })
    expect(row('grants-unreadable')).not.toBeNull()
    expect(row('grants-empty')).toBeNull()
    expect(row('grants-retry')).not.toBeNull()
  })
})
