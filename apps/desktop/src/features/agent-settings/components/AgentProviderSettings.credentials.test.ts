/**
 * The credential write, reached the way a user reaches it: through the provider page.
 *
 * `agent_credentials_write` was the third command in this tree with no caller under `src/` — the
 * page named the credential, stated where it was stored, and offered nothing to put there. So
 * these tests mount the *real* `AgentProviderSettings.vue` and drive the gesture. A form with
 * passing tests of its own is still that defect if the page that owns its subject never renders
 * it, which is why the port is a stub here and the concrete client is tested next door: what this
 * file is evidence for is the **page**, and the page's contract is the port.
 *
 * What the page owns, and what these pin:
 *
 * - one field per credential name the readout carries, masked, with the placeholder standing in
 *   for a stored value — and the stored value nowhere in the document;
 * - a draft of `null` for every field the user did not touch, which is what stops a save with no
 *   edit from re-submitting the page's own display value as the credential;
 * - a cleared field drafting `''`, which the policy reads as *remove* rather than as an empty
 *   credential;
 * - no form at all for a profile this app may not write to;
 * - and a rejection drawn as itself, with no claim of a save and no value echoed into it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import AgentProviderSettings from './AgentProviderSettings.vue'
import type { AgentCredentialClient } from '../services/agent-credential-ipc'
import type { AgentProfileReadout, CredentialField } from '../services/agent-settings-policy'
import type { AgentProviderClient } from '../services/agent-profile-ipc'
import { setLocale } from '../../../i18n'

/** A value the backend must never have sent, used to prove the page does not render one. */
const STORED_VALUE = 'sk-live-NEVER-PRINTED'

function readout(overrides: Partial<AgentProfileReadout> = {}): AgentProfileReadout {
  return {
    profileId: 'default',
    agentId: 'opencode',
    mode: 'app-managed',
    root: '/home/someone/.local/share/nekowite/agent-profiles/default',
    revision: 'r1',
    provider: 'anthropic',
    modelId: 'claude-sonnet-4',
    editable: true,
    sources: [],
    credentials: [{ name: 'ANTHROPIC_API_KEY', value: STORED_VALUE }],
    credentialStorage: {
      kind: 'host-file',
      path: '/home/someone/.local/share/nekowite/agent-profiles/default/auth.json',
      mode: '600',
      encrypted: false,
      keychain: false,
    },
    permissions: { state: 'written', document: null, rules: [] },
    configDocument: null,
    ...overrides,
  }
}

let mounted: VueApp[] = []
/** Every submission the page made, as the port received it. */
let submissions: CredentialField[][]
let answer: Awaited<ReturnType<AgentCredentialClient['write']>>
let profile: AgentProviderClient

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  setLocale('zh')
  submissions = []
  answer = { status: 'written', readout: readout() }
  profile = { read: vi.fn(), write: vi.fn() }
  globalThis.matchMedia = vi.fn(() => ({
    matches: false,
    media: '',
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as never
  document.body.innerHTML = ''
  mounted = []
})

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
  document.body.innerHTML = ''
})

/** Mount the real page over the given readout, with a credential port that records what it got. */
async function mountPage(initial: AgentProfileReadout): Promise<void> {
  const credentialClient: AgentCredentialClient = {
    write: vi.fn(async (fields: readonly CredentialField[]) => {
      submissions.push([...fields.map((field) => ({ ...field }))])
      if (answer instanceof Error) throw answer
      return answer
    }),
    // The port's read, and this page is not a caller of it: the provider *form* asks what the
    // profile stores so it can decide whether a block names a key. Here it answers the names the
    // readout carries, which is what the real one does, so the double is not a second vocabulary.
    names: vi.fn(async () => initial.credentials.map((entry) => entry.name)),
  }
  profile = { read: vi.fn(async () => initial), write: vi.fn() }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(AgentProviderSettings, {
    client: profile,
    credentialClient,
    agentId: initial.agentId,
    profileId: initial.profileId,
  } as never)
  app.mount(host)
  mounted.push(app)
  await flush()
}

async function flush(): Promise<void> {
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

function fieldFor(name: string): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>(`[data-test="credential-field-${name}"]`)
  if (!input) throw new Error(`the credential field for ${name} is not on the page`)
  return input
}

function saveButton(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>('[data-test="credential-save"]')
  if (!button) throw new Error('the credential save button is not on the page')
  return button
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}

describe('the provider page reaches the credential write', () => {
  it('drafts what was typed, and repaints both halves from what the backend answered', async () => {
    await mountPage(readout())
    // The answer names one credential more than the read the form was built on, which is the
    // difference between repainting from the answer and repainting from what was typed.
    answer = {
      status: 'written',
      readout: readout({
        revision: 'r2',
        credentials: [
          { name: 'ANTHROPIC_API_KEY', value: 'sk-new' },
          { name: 'OPENAI_API_KEY', value: '' },
        ],
      }),
    }

    await type(fieldFor('ANTHROPIC_API_KEY'), 'sk-new')
    saveButton().click()
    await flush()

    expect(submissions).toHaveLength(1)
    expect(submissions[0]).toEqual([
      { name: 'ANTHROPIC_API_KEY', display: '<redacted>', draft: 'sk-new' },
    ])
    // Both halves are the new readout's: the row the backend answered with, and a field for the
    // credential it added.
    expect(document.querySelector('[data-test="provider-credential-OPENAI_API_KEY"]')).not.toBeNull()
    expect(document.querySelector('[data-test="credential-field-OPENAI_API_KEY"]')).not.toBeNull()
  })

  it('drafts nothing for a field the user did not touch', async () => {
    await mountPage(readout())

    saveButton().click()
    await flush()

    // `null`, not the placeholder: the policy reads `null` as unchanged and sends nothing for it,
    // so a save with no edit cannot replace a working key with the page's own display value.
    expect(submissions[0][0].draft).toBeNull()
    expect(submissions[0][0].display).toBe('<redacted>')
  })

  it('drafts a cleared field as empty, which the policy reads as remove', async () => {
    await mountPage(readout())

    await type(fieldFor('ANTHROPIC_API_KEY'), '')
    saveButton().click()
    await flush()

    expect(submissions[0][0].draft).toBe('')
  })

  it('never renders the value the readout carries, and offers the form masked', async () => {
    await mountPage(readout())

    const field = fieldFor('ANTHROPIC_API_KEY')
    expect(field.value, 'a stored value must not be written into the field').toBe('')
    expect(field.type).toBe('password')
    // The placeholder is what stands in for it, and it is the page's own word rather than a value.
    expect(field.placeholder.length).toBeGreaterThan(0)
    expect(document.body.textContent ?? '').not.toContain(STORED_VALUE)
  })

  it('shows a refusal as the policy’s sentence rather than sending it', async () => {
    await mountPage(readout())
    answer = { status: 'refused', message: 'That is the value this page shows in place of a key.' }

    await type(fieldFor('ANTHROPIC_API_KEY'), 'sk-new')
    saveButton().click()
    await flush()

    expect(document.querySelector('[data-test="credential-failed"]')?.textContent ?? '').toContain(
      'in place of a key',
    )
    expect(document.querySelector('[data-test="credential-saved"]')).toBeNull()
  })

  it('shows a rejection as the backend’s sentence rather than claiming a save', async () => {
    await mountPage(readout())
    answer = new Error(
      '`default` cannot be a profile id: a profile is a directory name inside this app’s own folder',
    ) as never

    await type(fieldFor('ANTHROPIC_API_KEY'), 'sk-new')
    saveButton().click()
    await flush()

    const failure = document.querySelector('[data-test="credential-failed"]')?.textContent ?? ''
    expect(failure).toContain('cannot be a profile id')
    expect(document.querySelector('[data-test="credential-saved"]')).toBeNull()
    // And no value was echoed into the sentence that reports the failure.
    expect(failure).not.toContain('sk-new')
  })

  it('draws no write form for a profile this app may not write to', async () => {
    await mountPage(readout({ editable: false, mode: 'user-config' }))

    // §8.1 with T12's rule for the record's own controls: absent rather than present and refused.
    expect(document.querySelector('[data-test="credential-save"]')).toBeNull()
    expect(document.querySelector('[data-test="credential-field-ANTHROPIC_API_KEY"]')).toBeNull()
    // The read half is still drawn: what is stored is a fact about the profile either way.
    expect(document.querySelector('[data-test="provider-credential-ANTHROPIC_API_KEY"]')).not.toBeNull()
  })
})
