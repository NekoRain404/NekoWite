/**
 * The provider form, rendered: what each gesture sends, and what it refuses to send.
 *
 * The rules about the *shape* are `agent-provider-block.test.ts`'s. What is here is the half a value
 * test cannot reach — the order of the calls, what happens when one of them fails, and the two
 * claims about the screen this form is built on:
 *
 *  - **「获取模型」 reaches `models`.** The list it draws is ticked and it is what the save submits,
 *    asserted against the value that actually goes over the wire. An engine can only address a model
 *    its provider block declares, so a list that stayed on screen would be a button whose visible
 *    result the engine never sees.
 *  - **What the preview shows is what is sent.** The submission's value and the `<pre>` are the same
 *    function's output, and the test compares them rather than trusting that.
 *  - **A refusal happens before the call it refuses.** An empty key field, no ticked model, an empty
 *    id: each is a sentence on screen and a call count of zero, so "refused here" cannot be a message
 *    printed after a round trip that already wrote something.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { setLocale } from '../../../i18n'
import AgentProviderAuthoring from './AgentProviderAuthoring.vue'
import type { AgentProviderAuthoringClient } from '../services/agent-provider-authoring'
import type { AgentConfigClient, AgentConfigEditOutcome } from '../services/agent-config-ipc'
import type { ConfigEdit, ConfigRead } from '../services/agent-settings-policy'

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

const RELATIVE = 'XDG_CONFIG_HOME/opencode/opencode.json'
const REVISION = 'a'.repeat(64)

const DOCUMENT: ConfigRead = {
  path: RELATIVE,
  resolved: `/home/someone/profile/${RELATIVE}`,
  exists: true,
  revision: REVISION,
  text: '{\n  // the engine’s own file\n  "permission": { "edit": "ask" }\n}\n',
  editable: true,
}

interface Harness {
  authoring: AgentProviderAuthoringClient
  client: AgentConfigClient
  /** Every model fetch, in the order it was asked. */
  fetches: { baseUrl: string; apiKey: string; allowPrivate: boolean }[]
  /** Every credential the form stored. */
  credentials: { name: string; value: string }[]
  /** Every edit the form sent. */
  edits: { relative: string; revision: string | null; edits: readonly ConfigEdit[] }[]
}

function harness(
  options: {
    models?: string[] | Error
    credential?: Error
    edit?: AgentConfigEditOutcome | Error
  } = {},
): Harness {
  const fetches: Harness['fetches'] = []
  const credentials: Harness['credentials'] = []
  const edits: Harness['edits'] = []
  const authoring: AgentProviderAuthoringClient = {
    fetchModels: async (request) => {
      fetches.push({ baseUrl: request.baseUrl, apiKey: request.apiKey, allowPrivate: request.allowPrivate })
      if (options.models instanceof Error) throw options.models
      return options.models ?? ['deepseek-v4-flash', 'deepseek-v4.1-flash', 'glm-5.2']
    },
    setCredential: async (name, value) => {
      credentials.push({ name, value })
      if (options.credential instanceof Error) throw options.credential
    },
  }
  const client: AgentConfigClient = {
    read: async () => ({ state: 'document', document: DOCUMENT }),
    edit: async (relative, revision, list) => {
      edits.push({ relative, revision, edits: list })
      if (options.edit instanceof Error) throw options.edit
      return options.edit ?? { status: 'written', revision: 'b'.repeat(64) }
    },
  }
  return { authoring, client, fetches, credentials, edits }
}

async function render(made: Harness): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(AgentProviderAuthoring, {
    client: made.client,
    authoring: made.authoring,
    document: DOCUMENT,
  })
  app.mount(host)
  mounted.push(app)
  await nextTick()
}

function el(test: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-test="${test}"]`)
}

function type(test: string, value: string): void {
  const field = document.querySelector<HTMLInputElement>(`[data-test="${test}"]`)
  if (!field) throw new Error(`no field ${test}`)
  field.value = value
  field.dispatchEvent(new Event('input'))
}

function tick(test: string, checked: boolean): void {
  const field = document.querySelector<HTMLInputElement>(`[data-test="${test}"]`)
  if (!field) throw new Error(`no checkbox ${test}`)
  field.checked = checked
  field.dispatchEvent(new Event('change'))
  field.dispatchEvent(new Event('input'))
}

async function press(test: string): Promise<void> {
  el(test)?.click()
  await nextTick()
  await nextTick()
  await nextTick()
}

/** The form filled in, up to but not including the fetch. */
async function fill(made: Harness): Promise<void> {
  await render(made)
  type('provider-form-id', 'iapp')
  type('provider-form-name', 'iApp Gateway')
  type('provider-form-base-url', 'https://ai.example.org/v1')
  type('provider-form-api-key', 'sk-not-a-real-key')
  await nextTick()
}

describe('fetching the models', () => {
  it('asks the endpoint for the address and the key that were typed', async () => {
    const made = harness()
    await fill(made)
    await press('provider-form-fetch')

    expect(made.fetches).toEqual([
      { baseUrl: 'https://ai.example.org/v1', apiKey: 'sk-not-a-real-key', allowPrivate: false },
    ])
    expect(el('provider-form-fetched')?.textContent).toContain('3')
  })

  it('draws the ids it was given, named for a person, ticked', async () => {
    const made = harness()
    await fill(made)
    await press('provider-form-fetch')

    const rows = [...document.querySelectorAll<HTMLElement>('.provider-model')]
    expect(rows).toHaveLength(3)
    expect(rows.map((row) => row.querySelector('.provider-model-name')?.textContent)).toEqual([
      'Deepseek V4 Flash',
      'Deepseek V4.1 Flash',
      'Glm 5.2',
    ])
    for (const row of rows) {
      expect(row.querySelector<HTMLInputElement>('input')?.checked).toBe(true)
    }
    expect(el('provider-form-model-deepseek-v4.1-flash')).not.toBeNull()
  })

  it('refuses an empty key field without asking, and says what it would have sent', async () => {
    const made = harness()
    await render(made)
    type('provider-form-base-url', 'https://ai.example.org/v1')
    await nextTick()
    await press('provider-form-fetch')

    expect(made.fetches).toEqual([])
    expect(el('provider-form-fetch-needs-key')?.textContent).toContain('its own AI')
  })

  it('reports the endpoint’s own refusal and leaves the fields alone', async () => {
    const made = harness({ models: new Error('AI Base URL 指向了本机/内网地址（localhost）') })
    await fill(made)
    await press('provider-form-fetch')

    expect(el('provider-form-fetch-failed')?.textContent).toContain('localhost')
    expect(document.querySelector<HTMLInputElement>('[data-test="provider-form-base-url"]')?.value).toBe(
      'https://ai.example.org/v1',
    )
    // Nothing was written by a failed fetch: there is nothing to save and nothing to submit.
    expect(made.edits).toEqual([])
    expect(made.credentials).toEqual([])
  })

  it('carries the private-address opt-in through to the fetch', async () => {
    const made = harness()
    await fill(made)
    el('provider-form-allow-private')?.click()
    await nextTick()
    await press('provider-form-fetch')

    expect(made.fetches[0]?.allowPrivate).toBe(true)
  })

  it('keeps a tick off the models the user unticked, and adds a typed id', async () => {
    const made = harness()
    await fill(made)
    await press('provider-form-fetch')
    tick('provider-form-model-glm-5.2', false)
    type('provider-form-manual', 'deepseek-v5-flash')
    await nextTick()
    await press('provider-form-manual-add')
    await press('provider-form-save')

    const value = made.edits[0]?.edits[1]?.value as Record<string, unknown>
    expect(Object.keys(value['models'] as Record<string, unknown>)).toEqual([
      'deepseek-v4-flash',
      'deepseek-v4.1-flash',
      'deepseek-v5-flash',
    ])
  })
})

describe('saving', () => {
  it('stores the key under the derived name, then writes the block at the revision it read', async () => {
    const made = harness()
    await fill(made)
    await press('provider-form-fetch')
    await press('provider-form-save')

    expect(made.credentials).toEqual([
      { name: 'NWK_IAPP_API_KEY', value: 'sk-not-a-real-key' },
    ])
    expect(made.edits).toEqual([
      {
        relative: RELATIVE,
        revision: REVISION,
        edits: [
          { path: ['provider'], value: {}, ifAbsent: true },
          {
            path: ['provider', 'iapp'],
            value: {
              npm: '@ai-sdk/openai-compatible',
              name: 'iApp Gateway',
              options: {
                baseURL: 'https://ai.example.org/v1',
                apiKey: '{env:NWK_IAPP_API_KEY}',
              },
              models: {
                'deepseek-v4-flash': { name: 'Deepseek V4 Flash' },
                'deepseek-v4.1-flash': { name: 'Deepseek V4.1 Flash' },
                'glm-5.2': { name: 'Glm 5.2' },
              },
            },
          },
        ],
      },
    ])
    expect(el('provider-form-applied')).not.toBeNull()
  })

  it('shows the value it is about to write, and it is the value it sent', async () => {
    const made = harness()
    await fill(made)
    await press('provider-form-fetch')

    const shown = JSON.parse(el('provider-form-preview')?.textContent ?? '{}') as unknown
    await press('provider-form-save')

    expect(made.edits[0]?.edits[1]?.value).toEqual(shown)
  })

  it('carries no key in the document, and clears the field once the key is stored', async () => {
    const made = harness()
    await fill(made)
    await press('provider-form-fetch')
    await press('provider-form-save')

    const written = JSON.stringify(made.edits[0]?.edits)
    expect(written).not.toContain('sk-not-a-real-key')
    expect(written).toContain('{env:NWK_IAPP_API_KEY}')
    expect(document.querySelector<HTMLInputElement>('[data-test="provider-form-api-key"]')?.value).toBe('')
  })

  it('says nothing was written, and writes nothing, when the key cannot be stored', async () => {
    const made = harness({ credential: new Error('vault is locked') })
    await fill(made)
    await press('provider-form-fetch')
    await press('provider-form-save')

    expect(made.edits).toEqual([])
    expect(el('provider-form-credential-failed')?.textContent).toContain('vault is locked')
  })

  it('writes no credential when the key field is empty, and names none in the block', async () => {
    const made = harness()
    await render(made)
    type('provider-form-id', 'iapp')
    type('provider-form-base-url', 'https://ai.example.org/v1')
    await nextTick()
    type('provider-form-manual', 'glm-5.2')
    await nextTick()
    await press('provider-form-manual-add')
    await press('provider-form-save')

    expect(made.credentials).toEqual([])
    const value = made.edits[0]?.edits[1]?.value as Record<string, unknown>
    expect(value['options']).toEqual({ baseURL: 'https://ai.example.org/v1' })
    expect(el('provider-form-key-blank')).not.toBeNull()
  })

  it('refuses a save with no models without asking the backend', async () => {
    const made = harness()
    await fill(made)
    await press('provider-form-save')

    expect(made.edits).toEqual([])
    expect(made.credentials).toEqual([])
    expect(el('provider-form-problem')?.textContent).toContain('can see and cannot use')
  })

  it('refuses an id the credential name could not keep apart, before anything is sent', async () => {
    const made = harness()
    await fill(made)
    type('provider-form-id', 'ia pp')
    await nextTick()
    await press('provider-form-fetch')
    await press('provider-form-save')

    expect(made.edits).toEqual([])
    expect(el('provider-form-problem')?.textContent).toContain('letters, digits')
  })

  it('reports a conflict instead of retrying, and asks the page to reload', async () => {
    const made = harness({ edit: { status: 'conflict', current: null } })
    await fill(made)
    await press('provider-form-fetch')
    await press('provider-form-save')

    expect(el('provider-form-conflict')).not.toBeNull()
    expect(el('provider-form-applied')).toBeNull()
    expect(made.edits).toHaveLength(1)
  })

  it('shows the backend’s own sentence when the edit does not complete', async () => {
    const made = harness({ edit: new Error('this profile reuses the engine’s own configuration') })
    await fill(made)
    await press('provider-form-fetch')
    await press('provider-form-save')

    expect(el('provider-form-failed')?.textContent).toContain('reuses the engine’s own configuration')
  })
})
