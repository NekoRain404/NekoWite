/**
 * The permission page's two halves: they answer different questions, so neither may be gated by the
 * other's read.
 *
 * `AgentPermissionSettings.vue`'s rules readout comes from `agent_profile_read` — a document, read
 * with no session running — and the grants list comes from the running engine. `AgentPermissionGrants.vue`
 * says so in its own module comment, and this file is that claim, executed: the two reads are driven
 * apart here, in both directions, and what is asserted is that a failure on one side leaves the
 * other side exactly as it is when both succeed.
 *
 * **The case that matters most is the first one.** The grants list is the only surface in this app
 * that can take a lasting permission back, and an unreadable profile document is precisely when a
 * user needs to see it. A page that hid it behind the profile read would be removing its one safety
 * control at the moment something is wrong — the exact inversion this file exists to keep out.
 *
 * Each test also asserts the *counts* of the calls each half made, because "the halves are
 * independent" is a claim about reads: a retry on one side that re-read the other would pass every
 * rendering assertion below and still be the defect in a different shape.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { setLocale } from '../../../i18n'
import AgentPermissionSettings from './AgentPermissionSettings.vue'
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

/** The profile's answer when it can be read: one rule, and one of §6.3's limitations. */
const READOUT: PermissionReadout = {
  state: 'written',
  rules: [
    {
      tool: 'edit',
      action: 'ask',
      origin: { kind: 'host', variable: null, path: '/profiles/default/opencode.json' },
    },
  ],
  optionKinds: [],
  limits: ['not-a-sandbox'],
}

/** What the engine answers when it holds one lasting permission. */
const LISTED: GrantsReadout = {
  kind: 'listed',
  grants: [{ id: 'psv_1', projectId: 'global', action: 'edit', resource: '*' }],
}

const profileRefused = async (): Promise<PermissionReadout> => {
  throw new Error('agent_profile_read refused')
}

interface Stub {
  client: AgentPermissionClient
  /** How many times each half was read, so a retry's blast radius is observable. */
  calls: { read: number; grants: number }
}

/** A page whose two halves are the caller's, counted separately. */
function stub(answers: {
  read: () => Promise<PermissionReadout>
  grants: () => Promise<GrantsReadout>
}): Stub {
  const calls = { read: 0, grants: 0 }
  return {
    calls,
    client: {
      read: async () => {
        calls.read += 1
        return answers.read()
      },
      grants: async () => {
        calls.grants += 1
        return answers.grants()
      },
      // The revoke answers the current list, which no test below presses: the removal path is
      // `AgentPermissionGrants.test.ts`'s, and this file is about which half is drawn at all.
      revoke: async () => answers.grants(),
    },
  }
}

/** Mount one page, replacing whatever this test mounted before it. */
async function mount(client: AgentPermissionClient): Promise<void> {
  mounted.forEach((app) => app.unmount())
  mounted = []
  document.body.innerHTML = ''
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(AgentPermissionSettings, { client })
  mounted.push(app)
  app.mount(host)
  await flush()
}

/**
 * Let both halves' reads settle.
 *
 * Two ticks are not enough here and the reason is worth stating: each half's load is an `await`
 * over a client that itself awaits its answer, so several microtask turns pass before either side's
 * state moves — and a rejection takes one turn more than a value. A page that has not settled is
 * asserted about silently, which is how an assertion of *absence* passes for the wrong reason.
 */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) {
    await Promise.resolve()
    await nextTick()
  }
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

const el = (dataTest: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-test="${dataTest}"]`)

describe('the rules half when the profile cannot be read', () => {
  it('still draws the grants the engine holds, and the control that takes one back', async () => {
    const { client } = stub({ read: profileRefused, grants: async () => LISTED })
    await mount(client)

    // The half that failed says so, in its own words, with its own retry — and claims nothing it
    // could not read.
    expect(el('permission-unreadable')).not.toBeNull()
    expect(el('permission-retry')).not.toBeNull()
    expect(el('permission-state')).toBeNull()
    expect(el('permission-rule-edit')).toBeNull()
    expect(el('permission-no-invention')).toBeNull()

    // The half that did not fail is a different question, put to a different authority. A profile
    // read this page cannot complete is not a reason to take the revoke control off the screen.
    expect(el('permission-grants')).not.toBeNull()
    expect(el('grant-psv_1')).not.toBeNull()
    expect(el('grant-revoke-psv_1')).not.toBeNull()
  })

  it('keeps the engine’s three answers apart while the profile is unreadable', async () => {
    // The arms are `AgentPermissionGrants.vue`'s, and this file's business is only that the page
    // does not collapse them on the way in: "cannot ask" and "nothing to ask" drawn as a list with
    // no rows would be this page claiming consent it never established.
    const arms: Array<{ answer: GrantsReadout; drawn: string; absent: string[] }> = [
      { answer: LISTED, drawn: 'grant-psv_1', absent: ['grants-unsupported', 'grants-not-running', 'grants-empty'] },
      { answer: { kind: 'unsupported' }, drawn: 'grants-unsupported', absent: ['grants-list', 'grants-not-running', 'grants-empty'] },
      { answer: { kind: 'not-running' }, drawn: 'grants-not-running', absent: ['grants-list', 'grants-unsupported', 'grants-empty'] },
    ]
    for (const arm of arms) {
      const { client } = stub({ read: profileRefused, grants: async () => arm.answer })
      await mount(client)
      expect(el('permission-unreadable')).not.toBeNull()
      expect(el(arm.drawn)).not.toBeNull()
      for (const gone of arm.absent) expect(el(gone)).toBeNull()
    }
  })

  it('retries the rules half without re-reading the engine', async () => {
    let attempt = 0
    const { client, calls } = stub({
      read: async () => {
        attempt += 1
        if (attempt === 1) throw new Error('agent_profile_read refused')
        return READOUT
      },
      grants: async () => LISTED,
    })
    await mount(client)
    expect(el('grant-psv_1')).not.toBeNull()

    el('permission-retry')?.click()
    await flush()

    expect(el('permission-state')).not.toBeNull()
    expect(el('permission-rule-edit')).not.toBeNull()
    // The grants block was not unmounted and rebuilt by the other half's retry: the engine was
    // asked once, and that answer is still on screen.
    expect(calls).toEqual({ read: 2, grants: 1 })
    expect(el('grant-psv_1')).not.toBeNull()
  })
})

describe('where the grants block is read', () => {
  it('stands under the rules they are an answer to, ahead of what a request can answer', async () => {
    // Independence is not "anywhere on the page": the reason this block sits between the two parts
    // of the rules half is that "what the engine will ask" and "what you have already answered for
    // good" are two halves of one question, and the fix that moved it below the limitations would
    // satisfy every test above while breaking that reading. Document order is what is asserted, so
    // the assertions above cannot be satisfied by a page that drew the block somewhere else.
    const { client } = stub({ read: async () => READOUT, grants: async () => LISTED })
    await mount(client)

    const order = [...document.querySelectorAll<HTMLElement>('[data-test]')].map(
      (element) => element.dataset.test ?? '',
    )
    expect(order.indexOf('permission-rule-edit')).toBeLessThan(order.indexOf('permission-grants'))
    expect(order.indexOf('permission-grants')).toBeLessThan(order.indexOf('permission-no-invention'))
    expect(order.indexOf('permission-grants')).toBeLessThan(
      order.indexOf('permission-limit-not-a-sandbox'),
    )
  })
})

describe('the grants half when the engine cannot be read', () => {
  it('says so on its own, beside a rules readout that is drawn', async () => {
    const { client } = stub({
      read: async () => READOUT,
      grants: async () => {
        throw new Error('the engine answered nothing')
      },
    })
    await mount(client)

    expect(el('permission-state')).not.toBeNull()
    expect(el('permission-rule-edit')).not.toBeNull()
    expect(el('permission-unreadable')).toBeNull()

    // And the failure is this half's own: said, retryable, and never turned into "you have
    // granted nothing" — the one reading a broken answer must not produce.
    expect(el('grants-unreadable')).not.toBeNull()
    expect(el('grants-retry')).not.toBeNull()
    expect(el('grants-empty')).toBeNull()
  })

  it('retries the grants half without re-reading the profile', async () => {
    let attempt = 0
    const { client, calls } = stub({
      read: async () => READOUT,
      grants: async () => {
        attempt += 1
        if (attempt === 1) throw new Error('the engine answered nothing')
        return LISTED
      },
    })
    await mount(client)
    expect(el('grants-unreadable')).not.toBeNull()

    el('grants-retry')?.click()
    await flush()

    expect(el('grant-psv_1')).not.toBeNull()
    expect(el('grants-unreadable')).toBeNull()
    // The retry asked the authority that failed, and only that one.
    expect(calls).toEqual({ read: 1, grants: 2 })
  })
})
