/**
 * E4 — the optional external-agent settings, in a real browser.
 *
 * The four things this file exists for are §10.2's T13a row: 添加/停用, 失败诊断, 不擅自更新 and
 * 切引擎新建会话. Three of them are about *what a person reads after something went wrong*, which is
 * why none of them is a unit test — the vocabulary is held in
 * `services/agent-registry-policy.test.ts` (V12), and what is checked here is that the page uses it
 * instead of swallowing it: a form that refuses a relative path without calling the backend, a
 * refusal that names the fact rather than the mood, an external program that never grows a
 * replace-in-place affordance, and an engine switch that produces a *new* session rather than a
 * re-pointed one.
 *
 * ## Why the section is mounted here rather than found in the settings dialog
 *
 * Wiring this section into the settings tree is T16's (the task table says so: 「共享导航由 T16 接线」),
 * and T13 owns the six sibling sections. Until that exists there is nothing in the running
 * application to drive, so this spec mounts the component itself in the page the dev server is
 * already serving, exactly as E1 does for the panel. Every assertion below is about the component's
 * behaviour and stays true once the dialog hosts it; what this file deliberately does not cover is
 * the wiring.
 *
 * The backend is a fake in the page rather than a mock library: it holds a readout it can be told to
 * change, records the calls it receives, and answers with a refusal the spec chooses — which is how
 * a *missing file*, a *file without an executable bit* and a *refused handshake* can each be put in
 * front of the page in a test that runs in a real browser.
 *
 * Vue is imported by URL rather than by name: a page has no import map, and the component has to be
 * compiled against the *same* Vue instance the dev server serves, not a second copy.
 */
import { expect, test, type Page } from '@playwright/test'
import type { Component } from 'vue'
import type {
  AgentDraft,
  AgentRegistryClient,
  AgentRegistryEntry,
  AgentRegistryReadout,
  RegistryRefusal,
} from '/src/features/agent-settings/services/agent-registry-policy.ts'

const COMPONENT_URL = '/src/features/agent-settings/components/AgentRegistrySettings.vue'
const HOST_ID = 'agent-registry-e2e'
const PROFILE_ID = 'prof-e2e'

/** What the page records, and what the spec can change underneath it. */
interface RegistryHarness {
  readout: AgentRegistryReadout
  calls: { add: AgentDraft[]; setEnabled: Array<[string, boolean]> }
  emitted: string[]
  /** Answered on the next `add`; `null` accepts. */
  addRefusal: RegistryRefusal | null
  /** Answered on the next `setEnabled`; `null` applies the change. */
  setEnabledRefusal: RegistryRefusal | null
  unmount(): void
}

declare global {
  interface Window {
    __agentRegistry?: RegistryHarness
  }
}

/** One registration, as the backend's readout hands it over. */
function entry(overrides: Partial<AgentRegistryEntry> = {}): AgentRegistryEntry {
  return {
    agentId: 'bundled-engine',
    displayName: 'Bundled Engine',
    source: 'bundled',
    program: '/opt/nekowite/engine',
    args: ['acp'],
    env: 'profile-isolated',
    envExtra: [],
    enabled: true,
    adapterId: 'opencode',
    reportedVersion: null,
    programState: 'launchable',
    ...overrides,
  }
}

/** The readout: the bundled default, plus whatever a test adds to it. */
function readout(overrides: Partial<AgentRegistryReadout> = {}): AgentRegistryReadout {
  return {
    defaultAgentId: 'bundled-engine',
    entries: [entry()],
    adapterIds: ['generic-acp', 'opencode'],
    runningAgentIds: [],
    profileOwners: { 'prof-e2e': 'bundled-engine' },
    ...overrides,
  }
}

/** One external registration, the case most of these tests are about. */
function external(overrides: Partial<AgentRegistryEntry> = {}): AgentRegistryEntry {
  return entry({
    agentId: 'acme',
    displayName: 'Acme',
    source: 'external',
    program: '/home/someone/.local/bin/acme-acp',
    env: 'user-environment',
    adapterId: 'generic-acp',
    ...overrides,
  })
}

/**
 * Put the section on screen with a fake backend.
 *
 * The readout is passed into the page once and then *mutated there* by the fake itself, so the
 * re-read the component performs after a change reflects it — which is what the real client
 * promises and what the component assumes.
 */
async function open(
  page: Page,
  initial: AgentRegistryReadout = readout(),
  options: { readFails?: boolean; sessionAgentId?: string | null } = {},
): Promise<void> {
  // The section draws its copy from the catalogue (`agent.registry.*`), and the app's default
  // locale is Chinese — so the assertions below pin English before the page loads, rather than
  // asserting a language the app happens to be set to. Everything asserted here is a fact about the
  // registry (a path, an executable bit, an engine's own message), not a translation of one.
  await page.addInitScript(() => {
    localStorage.setItem('nekowite.locale', 'en')
  })
  await page.goto('/')
  await page.evaluate(
    async ({ url, hostId, profileId, first, fails, session }) => {
      const source = await (await fetch('/src/main.ts')).text()
      const vueUrl = source.match(/["']([^"']*\/deps\/vue\.js[^"']*)["']/)?.[1]
      if (vueUrl === undefined) throw new Error('the dev server serves no vue dependency')
      const vue = (await import(/* @vite-ignore */ vueUrl)) as typeof import('vue')
      const component = (await import(/* @vite-ignore */ url)) as { default: Component }

      // A section mounted before this one goes away first: two hosts would leave two live sections
      // answering to whichever selectors the test happens to use.
      window.__agentRegistry?.unmount()

      const state: RegistryHarness = {
        readout: first,
        calls: { add: [], setEnabled: [] },
        emitted: [],
        addRefusal: null,
        setEnabledRefusal: null,
        unmount: () => undefined,
      }
      const client: AgentRegistryClient = {
        read: async () => state.readout,
        add: async (draft) => {
          state.calls.add.push(draft)
          if (state.addRefusal !== null) return state.addRefusal
          // What the backend does with an accepted registration: it becomes an *external*
          // definition, because the draft has no source to claim one with.
          state.readout = {
            ...state.readout,
            entries: [
              ...state.readout.entries,
              external({
                agentId: draft.agentId,
                displayName: draft.displayName || draft.agentId,
                program: draft.program,
                args: draft.args,
                adapterId: draft.adapterId,
              }),
            ],
          }
          return null
        },
        setEnabled: async (agentId, enabled) => {
          state.calls.setEnabled.push([agentId, enabled])
          if (state.setEnabledRefusal !== null) return state.setEnabledRefusal
          state.readout = {
            ...state.readout,
            entries: state.readout.entries.map((candidate) =>
              candidate.agentId === agentId ? { ...candidate, enabled } : candidate,
            ),
          }
          return null
        },
      }

      const host = document.createElement('div')
      host.id = hostId
      // Fixed and out of the application's flow: the app is running on this page, and a section
      // that took part in its layout would be measuring the app as much as itself.
      host.style.cssText =
        'position: fixed; top: 0; left: 0; width: 520px; max-height: 100vh; overflow: auto; z-index: 60;'
      host.dataset.test = 'registry-host'
      document.body.append(host)
      const app = vue.createApp(component.default, {
        client,
        profileId,
        sessionAgentId: session,
        onNewSession: (agentId: string) => state.emitted.push(agentId),
      })
      // The first read rejects, as an unreachable backend does; the retry then finds it.
      if (fails) {
        const read = client.read
        client.read = async () => {
          client.read = read
          throw new Error('the registry is unreachable')
        }
      }
      app.mount(host)
      state.unmount = () => app.unmount()
      window.__agentRegistry = state
    },
    {
      url: COMPONENT_URL,
      hostId: HOST_ID,
      profileId: PROFILE_ID,
      first: initial,
      fails: options.readFails ?? false,
      session: options.sessionAgentId ?? null,
    },
  )
  await expect(
    page.locator(options.readFails === true ? '[data-test="registry-unreadable"]' : '[data-test="registry-row-bundled-engine"]'),
  ).toBeVisible()
}

/** Tell the page's fake backend something before the next call. */
async function arrange(
  page: Page,
  change: Partial<Pick<RegistryHarness, 'addRefusal' | 'setEnabledRefusal'>>,
): Promise<void> {
  await page.evaluate((next) => {
    const state = window.__agentRegistry
    if (state === undefined) throw new Error('the section is not mounted')
    Object.assign(state, next)
  }, change)
}

const calls = (page: Page) =>
  page.evaluate(() => window.__agentRegistry?.calls ?? { add: [], setEnabled: [] })

const emitted = (page: Page) => page.evaluate(() => window.__agentRegistry?.emitted ?? [])

/** The row for one registration. */
const row = (page: Page, agentId: string) => page.locator(`[data-test="registry-row-${agentId}"]`)

/** Fill the add form and submit it. */
async function submitDraft(
  page: Page,
  draft: { agentId: string; displayName: string; program: string; args?: string; adapterId: string },
): Promise<void> {
  await page.locator('[data-test="registry-field-agentId"]').fill(draft.agentId)
  await page.locator('[data-test="registry-field-displayName"]').fill(draft.displayName)
  await page.locator('[data-test="registry-field-program"]').fill(draft.program)
  await page.locator('[data-test="registry-field-args"]').fill(draft.args ?? '')
  await page.locator('[data-test="registry-field-adapter"]').selectOption(draft.adapterId)
  await page.locator('[data-test="registry-add"]').click()
}

test.describe('adding a program', () => {
  test('refuses a relative path at the field and never sends it', async ({ page }) => {
    // §3.4.3's path half, caught before the round trip: a bare name would be resolved against this
    // app's own working directory, so it is a typo rather than a registration to try.
    await open(page)
    await submitDraft(page, {
      agentId: 'acme',
      displayName: 'Acme',
      program: 'acme-acp',
      adapterId: 'generic-acp',
    })
    await expect(page.locator('[data-test="registry-problem-program"]')).toContainText(
      'not an absolute path',
    )
    expect((await calls(page)).add).toEqual([])
    await expect(row(page, 'acme')).toHaveCount(0)
  })

  test('sends a draft that cannot claim a provenance, and shows what it became', async ({ page }) => {
    await open(page)
    await submitDraft(page, {
      agentId: 'acme',
      displayName: 'Acme',
      program: '/usr/local/bin/acme-acp',
      args: '--stdio\n--workspace /tmp/a dir',
      adapterId: 'generic-acp',
    })
    const sent = (await calls(page)).add
    expect(sent).toHaveLength(1)
    // A registration the form creates is the user's own program: the draft has no field to claim
    // that the host manages it, which is why an external entry can never be shown as host-managed.
    expect(sent[0]).toMatchObject({ agentId: 'acme', program: '/usr/local/bin/acme-acp' })
    expect(Object.keys(sent[0] ?? {})).not.toContain('source')
    // One argument per line, and the space inside the second one is the point of that format: an
    // argument containing spaces must reach `execve` as one argument (§3.4.3).
    expect(sent[0]?.args).toEqual(['--stdio', '--workspace /tmp/a dir'])

    await expect(row(page, 'acme')).toHaveCount(1)
    await expect(row(page, 'acme').locator('.registry-source')).toHaveText('Your own installation')
    // 添加 succeeding is not a verdict on the program, and the row says so.
    await expect(row(page, 'acme').locator('.registry-standing')).toContainText('Not verified')
  })
})

test.describe('diagnosing what failed', () => {
  test('says which of the three failures it was', async ({ page }) => {
    // The acceptance in one test: 失败诊断 is not "could not add this agent". Each of these is a
    // different thing for a user to do — restore a program, chmod it, or read the engine's own words
    // about its handshake — so each has to arrive as its own sentence.
    await open(page)
    const draft = {
      agentId: 'acme',
      displayName: 'Acme',
      program: '/opt/acme/acme-acp',
      adapterId: 'generic-acp',
    }
    const said: string[] = []
    const refusals: RegistryRefusal[] = [
      { kind: 'program', path: '/opt/acme/acme-acp', state: 'missing' },
      { kind: 'program', path: '/opt/acme/acme-acp', state: 'not-executable' },
      {
        kind: 'launch-failed',
        agentId: 'acme',
        code: 'invalid-response',
        message: 'the engine did not answer initialize',
      },
    ]
    for (const refusal of refusals) {
      await arrange(page, { addRefusal: refusal })
      await submitDraft(page, draft)
      const line = page.locator('[data-test="registry-add-refusal"]')
      await expect(line).toBeVisible()
      said.push((await line.innerText()).trim())
    }
    expect(new Set(said).size).toBe(3)
    expect(said[0]).toContain('no file at /opt/acme/acme-acp')
    expect(said[1]).toContain('executable bit')
    // The engine's own message is passed through rather than replaced by a summary of it.
    expect(said[2]).toContain('the engine did not answer initialize')
    await expect(row(page, 'acme')).toHaveCount(0)
  })

  test('reports a program that went missing without deleting the registration', async ({ page }) => {
    await open(
      page,
      readout({
        entries: [entry(), external({ programState: 'missing' })],
      }),
    )
    await expect(row(page, 'acme').locator('.registry-state')).toContainText(
      'no file at /home/someone/.local/bin/acme-acp',
    )
    // §3.4.7: nothing here deletes a definition because a file moved — the switch is still usable
    // and no refusal is invented.
    await expect(row(page, 'acme').locator('[data-test="registry-toggle-acme"]')).toBeEnabled()
    await expect(row(page, 'acme').locator('.registry-refusal')).toHaveCount(0)
  })
})

test.describe('switching a registration on and off', () => {
  test('refuses to switch off the default engine, and says why', async ({ page }) => {
    // §3.4.1: the default is the fixed answer for a new session, so a new-session list with nothing
    // to preselect is not a state this app has. The control is not offered rather than offered and
    // then refused.
    await open(page)
    await expect(page.locator('[data-test="registry-toggle-bundled-engine"]')).toBeDisabled()
    await expect(row(page, 'bundled-engine').locator('.registry-blocked')).toContainText(
      'a new session starts on',
    )
  })

  test('refuses while a task is running on the registration', async ({ page }) => {
    await open(page, readout({ entries: [entry(), external()], runningAgentIds: ['acme'] }))
    await expect(row(page, 'acme').locator('[data-test="registry-toggle-acme"]')).toBeDisabled()
    await expect(row(page, 'acme').locator('.registry-blocked')).toContainText('A task is running')
  })

  test('applies a switch-off the backend accepts', async ({ page }) => {
    await open(page, readout({ entries: [entry(), external()] }))
    await row(page, 'acme').locator('[data-test="registry-toggle-acme"]').click()
    await expect.poll(async () => (await calls(page)).setEnabled).toEqual([['acme', false]])
    await expect(row(page, 'acme').locator('[data-test="registry-toggle-acme"]')).not.toBeChecked()
  })

  test('leaves the box where the backend left it when the change is refused', async ({ page }) => {
    // The one place this page must not look like it succeeded: a checkbox that stayed flipped would
    // be the page claiming a change the backend refused.
    await open(page, readout({ entries: [entry(), external()] }))
    await arrange(page, { setEnabledRefusal: { kind: 'instance-running', agentId: 'acme' } })
    await row(page, 'acme').locator('[data-test="registry-toggle-acme"]').click()
    await expect(row(page, 'acme').locator('.registry-refusal')).toContainText('A task is running')
    await expect(row(page, 'acme').locator('[data-test="registry-toggle-acme"]')).toBeChecked()
  })
})

test.describe('updating a program', () => {
  test('states the provenance rule, and offers nothing that acts on a version', async ({ page }) => {
    await open(
      page,
      readout({
        entries: [
          entry({ reportedVersion: '1.18.29' }),
          external({ reportedVersion: '0.9.0' }),
        ],
      }),
    )
    // §3.1.4 and §3.4.6: what a user has to be able to tell apart is what the app manages and what
    // it only observes.
    await expect(row(page, 'bundled-engine').locator('.registry-update')).toContainText(
      'may fetch and switch',
    )
    await expect(row(page, 'acme').locator('.registry-update')).toContainText(
      'never replaces a program you installed',
    )
    // The version is a fact about the user's own installation, shown as a fact: no control in the
    // row acts on it, and there is no update anywhere in the section for one to act with.
    await expect(row(page, 'acme').locator('.registry-version')).toContainText('0.9.0')
    await expect(row(page, 'acme').locator('button')).toHaveCount(0)
    await expect(row(page, 'bundled-engine').locator('.registry-version')).toContainText('1.18.29')
  })
})

test.describe('choosing the engine for a new session', () => {
  test('plans a new session for another engine and emits it', async ({ page }) => {
    // The profile is one no engine owns yet: §3.4's Profile row means the engine chosen for the
    // next session is the engine that will take it, which is exactly the choice being made here.
    await open(page, readout({ entries: [entry(), external()], profileOwners: {} }), {
      sessionAgentId: 'bundled-engine',
    })
    // The session is on the default engine, so choosing it again is not a switch: there is nothing
    // to start, and nothing to re-point.
    await expect(page.locator('.registry-engine-plan')).toContainText('already the engine')
    await expect(page.locator('[data-test="registry-new-session"]')).toHaveCount(0)

    await page.locator('[data-test="registry-engine-select"]').selectOption('acme')
    // §3.4.2: the old session is left exactly as it is, and the page says so before the user acts.
    await expect(page.locator('.registry-engine-plan')).toContainText(
      'A new session will be started on Acme',
    )
    await expect(page.locator('.registry-engine-plan')).toContainText('keeps its engine')
    await page.locator('[data-test="registry-new-session"]').click()
    expect(await emitted(page)).toEqual(['acme'])
  })

  test('refuses a profile that belongs to another engine', async ({ page }) => {
    // §3.4's Profile row: credentials, model ids and configuration are not moved between engines, so
    // this is refused before anything starts — and the owner is named, because "it is taken" and "it
    // is taken by *that* engine" are different answers.
    await open(page, readout({ entries: [entry(), external()] }), {
      sessionAgentId: 'bundled-engine',
    })
    await page.locator('[data-test="registry-engine-select"]').selectOption('acme')
    await expect(page.locator('.registry-engine-plan')).toContainText('belongs to bundled-engine')
    await expect(page.locator('[data-test="registry-new-session"]')).toHaveCount(0)
  })
})

test.describe('when the registry cannot be read', () => {
  test('says so instead of showing an empty list, and retries', async ({ page }) => {
    // "No agents are registered" is a claim about the backend; a failed read is a claim about the
    // connection, and telling them apart is the difference between two next moves for the user.
    await open(page, readout(), { readFails: true })
    await expect(page.locator('[data-test="registry-unreadable"]')).toBeVisible()
    await expect(page.locator('[data-test="registry-empty"]')).toHaveCount(0)
    await page.locator('[data-test="registry-retry"]').click()
    await expect(page.locator('[data-test="registry-row-bundled-engine"]')).toBeVisible()
  })
})
