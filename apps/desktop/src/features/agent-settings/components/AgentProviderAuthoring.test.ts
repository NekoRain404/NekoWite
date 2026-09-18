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
  /** Every credential the form asked to have removed. */
  removals: string[]
  /** Every edit the form sent. */
  edits: { relative: string; revision: string | null; edits: readonly ConfigEdit[] }[]
  /** What the profile stores, as the double's own store: the form's reads answer this. */
  store: Set<string>
  /** Whether reading it fails. A test turns this off to let a retry answer. */
  readsFail: { on: boolean }
  /**
   * Every call that changed something, in the order it was made.
   *
   * The order is part of the contract rather than an implementation detail: a block that names a key
   * the store does not hold is the state the engine resolves to an empty string, so which of the
   * two writes goes first is what a half-finished save leaves behind.
   */
  order: string[]
}

function harness(
  options: {
    models?: string[] | Error
    credential?: Error
    removal?: Error
    edit?: AgentConfigEditOutcome | Error
    /** The credential names the profile stores when the form is opened. */
    stored?: string[]
    /** Whether reading them fails — the state in which nothing may be guessed. */
    storedFails?: boolean
  } = {},
): Harness {
  const fetches: Harness['fetches'] = []
  const credentials: Harness['credentials'] = []
  const removals: string[] = []
  const edits: Harness['edits'] = []
  const order: string[] = []
  // The double *is* the profile's credential file, so "save, then save again" is a sequence the
  // form meets for real: the first save puts the name in here, the second one reads it back.
  const store = new Set<string>(options.stored ?? [])
  const readsFail = { on: options.storedFails === true }
  const authoring: AgentProviderAuthoringClient = {
    fetchModels: async (request) => {
      fetches.push({ baseUrl: request.baseUrl, apiKey: request.apiKey, allowPrivate: request.allowPrivate })
      if (options.models instanceof Error) throw options.models
      return options.models ?? ['deepseek-v4-flash', 'deepseek-v4.1-flash', 'glm-5.2']
    },
    setCredential: async (name, value) => {
      credentials.push({ name, value })
      order.push(`set ${name}`)
      if (options.credential instanceof Error) throw options.credential
      store.add(name)
    },
    removeCredential: async (name) => {
      removals.push(name)
      order.push(`remove ${name}`)
      if (options.removal instanceof Error) throw options.removal
      store.delete(name)
    },
    storedCredentials: async () => {
      if (readsFail.on) throw new Error('the profile could not be read')
      return [...store]
    },
  }
  const client: AgentConfigClient = {
    read: async () => ({ state: 'document', document: DOCUMENT }),
    edit: async (relative, revision, list) => {
      edits.push({ relative, revision, edits: list })
      order.push('edit')
      if (options.edit instanceof Error) throw options.edit
      return options.edit ?? { status: 'written', revision: 'b'.repeat(64) }
    },
  }
  return { authoring, client, fetches, credentials, removals, edits, store, readsFail, order }
}

/**
 * Everything the component started, finished.
 *
 * A gesture here is a chain of awaits — a credential write, the re-read of the credential *names*
 * the block is built from, the document edit — and each hop is a microtask. `nextTick` alone covers
 * the render they cause but not the chain that causes it, so the boundary between them is a
 * macrotask: everything queued before it has run by the time it fires. Waiting with a tick count
 * instead would be a guess that grows with every call the form makes.
 */
async function settle(): Promise<void> {
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
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
  // The mount's own read included: the block is built from the credential names it answers, so a
  // test that pressed save before it landed would be measuring a form mid-flight.
  await settle()
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
  await settle()
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

/**
 * The form opened on an id and an address, with one model, and the key field left alone.
 *
 * The key field is what the two halves of this file are about: `fill` puts a value in it, and this
 * leaves it empty — the state a form is in when it is opened on a provider whose key is already
 * stored, which is the state the defect was invisible from.
 */
async function opened(made: Harness): Promise<void> {
  await render(made)
  type('provider-form-id', 'iapp')
  type('provider-form-base-url', 'https://ai.example.org/v1')
  await nextTick()
  type('provider-form-manual', 'glm-5.2')
  await nextTick()
  await press('provider-form-manual-add')
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

  /**
   * The defect, in the sequence the maintainer hit: fill the form, save, save again.
   *
   * The field is cleared by the first save — deliberately, because a credential on screen for as
   * long as the dialog is open is a second copy of a key — so the second save is built from a blank
   * field over a provider whose key *is* stored. Read as "no key", that save wrote a block naming
   * none while the credential stayed in the file, and the engine then authenticated with nothing:
   * the relay answered 「请求缺少有效的用户或 API Key 认证上下文」, and the key looked fine everywhere it
   * was checked.
   */
  it('keeps the block’s key reference when the same form is saved twice', async () => {
    const made = harness()
    await fill(made)
    await press('provider-form-fetch')
    await press('provider-form-save')
    await press('provider-form-save')

    expect(made.edits).toHaveLength(2)
    const options = (edit: number): unknown =>
      ((made.edits[edit]?.edits[1]?.value as Record<string, unknown>)['options'])
    expect(options(0)).toEqual({
      baseURL: 'https://ai.example.org/v1',
      apiKey: '{env:NWK_IAPP_API_KEY}',
    })
    expect(options(1)).toEqual({
      baseURL: 'https://ai.example.org/v1',
      apiKey: '{env:NWK_IAPP_API_KEY}',
    })
    // The second save had no value to write, and the store still holds the one the first one put
    // there — which is what makes the reference it keeps naming a key that is really there.
    expect(made.credentials).toHaveLength(1)
    expect([...made.store]).toEqual(['NWK_IAPP_API_KEY'])
  })

  /**
   * The same defect's second face: a form opened on a provider that already has a credential.
   *
   * The field is blank from the start — there is no value on the page to put in it — so the first
   * save from that state is a save with a blank field over a stored key, and the reference goes the
   * same way as above unless the form asks the store instead of reading the field.
   */
  it('keeps the reference on the first save after being opened on a provider that has a key', async () => {
    const made = harness({ stored: ['NWK_IAPP_API_KEY'] })
    await render(made)
    type('provider-form-id', 'iapp')
    type('provider-form-base-url', 'https://ai.example.org/v1')
    await nextTick()
    type('provider-form-manual', 'glm-5.2')
    await nextTick()
    await press('provider-form-manual-add')
    await press('provider-form-save')

    const options = (made.edits[0]?.edits[1]?.value as Record<string, unknown>)['options']
    expect(options).toEqual({
      baseURL: 'https://ai.example.org/v1',
      apiKey: '{env:NWK_IAPP_API_KEY}',
    })
    // Nothing was written back to the store: the key that is there is the one the block names.
    expect(made.credentials).toEqual([])
    expect(made.removals).toEqual([])
  })

  it('says a key is stored rather than showing an empty field as an empty provider', async () => {
    const made = harness({ stored: ['NWK_IAPP_API_KEY'] })
    await render(made)
    type('provider-form-id', 'iapp')
    await nextTick()

    const note = el('provider-form-key-stored')?.textContent ?? ''
    expect(note).toContain('NWK_IAPP_API_KEY')
    // Not the sentence for a provider with no key: the two states read differently, which is the
    // whole reason the blank field stopped being allowed to carry both.
    expect(el('provider-form-key-none')).toBeNull()
  })

  it('says nothing is stored when the id names no credential, and writes no reference', async () => {
    const made = harness({ stored: ['NWK_OTHER_API_KEY'] })
    await render(made)
    type('provider-form-id', 'iapp')
    type('provider-form-base-url', 'https://ai.example.org/v1')
    await nextTick()
    type('provider-form-manual', 'glm-5.2')
    await nextTick()
    await press('provider-form-manual-add')
    await press('provider-form-save')

    expect(el('provider-form-key-none')).not.toBeNull()
    expect(el('provider-form-key-stored')).toBeNull()
    expect((made.edits[0]?.edits[1]?.value as Record<string, unknown>)['options']).toEqual({
      baseURL: 'https://ai.example.org/v1',
    })
  })

  /**
   * The same fact, one page over: both pages of this dialog are on screen at once, so the
   * credentials section can move while this form is mounted. A block built from the answer this
   * form mounted with would be the defect again — a reference to a key that was just removed, or
   * no reference to one that was just stored.
   */
  it('stops naming a key that was removed while this form was on screen', async () => {
    const made = harness({ stored: ['NWK_IAPP_API_KEY'] })
    await opened(made)
    made.store.delete('NWK_IAPP_API_KEY')
    await press('provider-form-save')

    const options = (made.edits[0]?.edits[1]?.value as Record<string, unknown>)['options']
    expect(options).toEqual({ baseURL: 'https://ai.example.org/v1' })
  })

  it('names a key that was stored while this form was on screen', async () => {
    const made = harness()
    await opened(made)
    made.store.add('NWK_IAPP_API_KEY')
    await press('provider-form-save')

    const options = (made.edits[0]?.edits[1]?.value as Record<string, unknown>)['options']
    expect(options).toEqual({
      baseURL: 'https://ai.example.org/v1',
      apiKey: '{env:NWK_IAPP_API_KEY}',
    })
  })

  it('refuses to guess, and writes nothing, when the credential set cannot be read', async () => {
    // The one arm where the page does not know. Guessing "no key" is the defect; guessing "a key"
    // writes a reference to a variable that may not be set. So it writes neither and says so.
    const made = harness({ storedFails: true })
    await render(made)
    type('provider-form-id', 'iapp')
    type('provider-form-base-url', 'https://ai.example.org/v1')
    await nextTick()
    type('provider-form-manual', 'glm-5.2')
    await nextTick()
    await press('provider-form-manual-add')
    await press('provider-form-save')

    expect(made.edits).toEqual([])
    expect(made.credentials).toEqual([])
    expect(el('provider-form-key-unread')).not.toBeNull()
    expect(el('provider-form-problem')?.textContent).toContain('Nothing was written')
  })

  it('asks for a re-read, and then writes the reference the profile stores', async () => {
    const made = harness({ stored: ['NWK_IAPP_API_KEY'], storedFails: true })
    await render(made)
    type('provider-form-id', 'iapp')
    type('provider-form-base-url', 'https://ai.example.org/v1')
    await nextTick()
    type('provider-form-manual', 'glm-5.2')
    await nextTick()
    await press('provider-form-manual-add')

    // The read failed once — a profile that could not be opened — and answers on the retry.
    made.readsFail.on = false
    await press('provider-form-key-retry')
    await press('provider-form-save')

    expect((made.edits[0]?.edits[1]?.value as Record<string, unknown>)['options']).toEqual({
      baseURL: 'https://ai.example.org/v1',
      apiKey: '{env:NWK_IAPP_API_KEY}',
    })
  })

  it('offers the removal where a key is stored under this id', async () => {
    const made = harness({ stored: ['NWK_IAPP_API_KEY'] })
    await opened(made)

    expect(el('provider-form-key-remove')).not.toBeNull()
  })

  it('offers no removal for a credential that belongs to another provider', async () => {
    const made = harness({ stored: ['NWK_OTHER_API_KEY'] })
    await opened(made)

    expect(el('provider-form-key-remove')).toBeNull()
  })

  it('says what the removal will do before it does it', async () => {
    const made = harness({ stored: ['NWK_IAPP_API_KEY'] })
    await opened(made)
    await press('provider-form-key-remove')

    expect(el('provider-form-key-removing')?.textContent).toContain('NWK_IAPP_API_KEY')
    // Nothing has happened yet: the change is the save's, and a control that removed the key the
    // moment it was pressed would leave the block naming a variable nothing sets until the next one.
    expect(made.removals).toEqual([])
    expect(made.edits).toEqual([])
  })

  it('drops the reference, then the credential, in that order', async () => {
    const made = harness({ stored: ['NWK_IAPP_API_KEY'] })
    await opened(made)
    await press('provider-form-key-remove')
    await press('provider-form-save')

    expect((made.edits[0]?.edits[1]?.value as Record<string, unknown>)['options']).toEqual({
      baseURL: 'https://ai.example.org/v1',
    })
    expect(made.removals).toEqual(['NWK_IAPP_API_KEY'])
    // The block first: a block that names a key the store still holds is invisible and harmless,
    // and the other order leaves the engine authenticating with nothing whenever the second call
    // is the one that fails.
    expect(made.order).toEqual(['edit', 'remove NWK_IAPP_API_KEY'])
    expect([...made.store]).toEqual([])
  })

  it('keeps the credential when the block could not be written', async () => {
    const made = harness({ stored: ['NWK_IAPP_API_KEY'], edit: new Error('the document moved') })
    await opened(made)
    await press('provider-form-key-remove')
    await press('provider-form-save')

    expect(made.removals).toEqual([])
    expect([...made.store]).toEqual(['NWK_IAPP_API_KEY'])
    expect(el('provider-form-failed')?.textContent).toContain('the document moved')
  })

  it('stops being a pending removal once the key is typed again', async () => {
    const made = harness({ stored: ['NWK_IAPP_API_KEY'] })
    await opened(made)
    await press('provider-form-key-remove')
    type('provider-form-api-key', 'sk-a-new-key')
    await nextTick()
    await press('provider-form-save')

    expect(made.removals).toEqual([])
    expect(made.credentials).toEqual([{ name: 'NWK_IAPP_API_KEY', value: 'sk-a-new-key' }])
    expect((made.edits[0]?.edits[1]?.value as Record<string, unknown>)['options']).toEqual({
      baseURL: 'https://ai.example.org/v1',
      apiKey: '{env:NWK_IAPP_API_KEY}',
    })
  })

  it('can be taken back before it is saved', async () => {
    const made = harness({ stored: ['NWK_IAPP_API_KEY'] })
    await opened(made)
    await press('provider-form-key-remove')
    const label = el('provider-form-key-remove')?.textContent
    await press('provider-form-key-remove')

    expect(label).toBeTruthy()
    expect(el('provider-form-key-removing')).toBeNull()
    await press('provider-form-save')
    expect(made.removals).toEqual([])
    expect([...made.store]).toEqual(['NWK_IAPP_API_KEY'])
  })

  it('reports the block as written and the key as still stored when only the second call fails', async () => {
    const made = harness({ stored: ['NWK_IAPP_API_KEY'], removal: new Error('the vault is locked') })
    await opened(made)
    await press('provider-form-key-remove')
    await press('provider-form-save')

    // The block no longer names the key — that half landed — and the credential is still there. The
    // failure is reported as itself rather than as a save that did nothing, because the user's next
    // move is the removal, and the control that retries it is the one still on screen.
    expect(el('provider-form-removal-failed')?.textContent).toContain('the vault is locked')
    expect([...made.store]).toEqual(['NWK_IAPP_API_KEY'])
    expect(el('provider-form-key-remove')).not.toBeNull()
  })
})

describe('saving, and what it refuses', () => {
  it('says nothing was written, and writes nothing, when the key cannot be stored', async () => {
    const made = harness({ credential: new Error('vault is locked') })
    await fill(made)
    await press('provider-form-fetch')
    await press('provider-form-save')

    expect(made.edits).toEqual([])
    expect(el('provider-form-credential-failed')?.textContent).toContain('vault is locked')
  })

  it('writes no credential when the profile stores none and none was typed', async () => {
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
    expect(el('provider-form-key-none')).not.toBeNull()
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
