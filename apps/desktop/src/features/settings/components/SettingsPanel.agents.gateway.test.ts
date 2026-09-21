/**
 * What the section sends out: the catalogue's hand-off to the registry's add form, and the provider
 * form's key, model fetch and document write.
 *
 * The section is split by behaviour domain across sibling `SettingsPanel.agents.*.test.ts` files;
 * this one is the wire in the outward direction. Both gestures here end at a command rather than at
 * an event: the catalogue's control means "register this one" and fills the form the registry
 * actually submits, and the provider form is driven through the real dialog so that what is proven
 * is a user's gesture — typing an address, fetching its models, saving a provider — reaching the
 * backend as the backend asked for it, with the key in the credentials command and in no document.
 */
import { describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import {
  asked,
  el,
  openAgents,
  startAgentPanelAgents,
  type,
  untilDom,
} from './SettingsPanel.agents.mount'

// The mock `vi.mock` hoists above this file's imports; the harness installs it and answers through it.
const invokeMock = vi.hoisted(() => vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

startAgentPanelAgents(invokeMock)

describe('the agents section in the settings dialog', () => {
  it('hands a catalogue entry to the registry’s add form, rather than emitting to nobody', async () => {
    await openAgents()
    await untilDom(() => el('catalogue-use-acme-agent') !== null, 'the catalogue’s control')

    // The catalogue's only control means "register this one", and it holds no `add` of its own. The
    // two assertions below are the difference between a wired control and a button that emits into
    // an empty room: the entry's program and its arguments are in the *form the registry submits*,
    // as an array joined one argument per line (§3.4.3 — never a command line).
    el('catalogue-use-acme-agent')?.dispatchEvent(new MouseEvent('click'))
    await nextTick()
    await nextTick()

    const program = document.querySelector<HTMLInputElement>('[data-test="registry-field-program"]')
    const args = document.querySelector<HTMLTextAreaElement>('[data-test="registry-field-args"]')
    expect(program?.value).toBe('npx')
    expect(args?.value).toBe('-y\nacme-agent@2.1.0')
    expect(document.querySelector<HTMLInputElement>('[data-test="registry-field-agentId"]')?.value).toBe(
      'acme-agent',
    )
  })

  it('configures a provider from the dialog, and the key reaches no document', async () => {
    // The gesture the whole feature exists for, driven through the real dialog: the section builds
    // the client over the window's own commands (`createAgentSettingsClients`), so what this proves
    // is that a user with this build can type an address, fetch its models and save a provider
    // without writing JSONC by hand — and that the mode (which document, which profile) is the one
    // the registry answered with rather than anything the page decided.
    await openAgents()
    await untilDom(() => el('provider-authoring') !== null, 'the provider form')

    await type('provider-form-id', 'iapp')
    await type('provider-form-name', 'iApp Gateway')
    await type('provider-form-base-url', 'https://ai.example.org/v1')
    await type('provider-form-api-key', 'sk-not-a-real-key')

    el('provider-form-fetch')?.click()
    await untilDom(() => asked.includes('ai_list_models'), 'the model fetch')
    // The fetch carries the key that was typed and the address that was typed, and nothing this app
    // holds for its own AI: the command backfills a missing key from its own vault, so a request
    // without one would answer about a credential the engine never uses.
    expect(invokeMock).toHaveBeenCalledWith('ai_list_models', {
      config: expect.objectContaining({
        provider: 'custom',
        base_url: 'https://ai.example.org/v1',
        api_key: 'sk-not-a-real-key',
      }),
    })
    await untilDom(() => el('provider-form-model-deepseek-v4.1-flash') !== null, 'the fetched models')

    // Read the preview *before* the save: it is a statement about what is on screen when the user
    // presses the button, and a save that lands deliberately empties the key field.
    const shown = JSON.parse(el('provider-form-preview')?.textContent ?? '{}') as unknown
    el('provider-form-save')?.click()
    await untilDom(() => asked.includes('agent_config_edit'), 'the document write')

    expect(invokeMock).toHaveBeenCalledWith('agent_credentials_write', {
      agentId: 'bundled-engine',
      profileId: 'default',
      changes: [{ op: 'set', name: 'NWK_IAPP_API_KEY', value: 'sk-not-a-real-key' }],
    })
    const edit = invokeMock.mock.calls.find((call) => call[0] === 'agent_config_edit')?.[1] as {
      agentId: string
      relative: string
      revision: string
      edits: { path: string[]; value: unknown; ifAbsent?: boolean }[]
    }
    expect(edit.agentId).toBe('bundled-engine')
    expect(edit.relative).toBe('XDG_CONFIG_HOME/opencode/opencode.json')
    expect(edit.revision).toBe('r1')
    expect(edit.edits[0]).toEqual({ path: ['provider'], value: {}, ifAbsent: true })
    expect(edit.edits[1]?.path).toEqual(['provider', 'iapp'])
    const value = edit.edits[1]?.value as { options: Record<string, unknown>; models: object }
    expect(value.options).toEqual({
      baseURL: 'https://ai.example.org/v1',
      apiKey: '{env:NWK_IAPP_API_KEY}',
    })
    expect(Object.keys(value.models)).toEqual(['deepseek-v4-flash', 'deepseek-v4.1-flash', 'glm-5.2'])
    // The value on screen was the value sent, and the key is in neither.
    expect(JSON.stringify(edit.edits)).not.toContain('sk-not-a-real-key')
    expect(shown).toEqual(edit.edits[1]?.value)
    // And the save did not take the rest of the form with it: the reload behind it re-reads the
    // document without blanking the page, so the address and the model list are still there for a
    // second provider — while the key, which is stored now, is not.
    expect(document.querySelector<HTMLInputElement>('[data-test="provider-form-base-url"]')?.value).toBe(
      'https://ai.example.org/v1',
    )
    expect(document.querySelector<HTMLInputElement>('[data-test="provider-form-api-key"]')?.value).toBe('')
  })
})
