/**
 * The provider form's two calls, as values: what goes to `ai_list_models`, and what a credential
 * write does when the policy refuses it.
 *
 * The component test holds the gestures; this holds the two facts a rendered test cannot state —
 * the *shape* of the request the model fetch sends, and that a refused credential write is a
 * rejection rather than a silent success. The second is the one worth a file of its own: the same
 * client is what stops the form writing a provider block that points at a variable nothing set.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { createAgentProviderAuthoringClient } from './agent-provider-authoring'
import { createAgentCredentialClient } from './agent-credential-ipc'
import { REDACTED_CREDENTIAL, type AgentProfileReadout } from './agent-settings-policy'
import { useAiPermissionStore } from '../../../stores/ai-permission'

/**
 * Every case here chooses whether an app exists, because the model fetch now reads the AI master
 * switch through the store. Starting each case with none is what keeps a Pinia left behind by an
 * earlier one from answering for a later one — the failure that would hide is a request that
 * silently stops being made.
 */
beforeEach(() => {
  localStorage.clear()
  setActivePinia(undefined)
})

function readout(stored: readonly string[] = []): AgentProfileReadout {
  return {
    profileId: 'default',
    agentId: 'bundled-engine',
    mode: 'app-managed',
    root: '/tmp/profile',
    revision: 'r1',
    provider: null,
    modelId: null,
    editable: true,
    sources: [],
    credentials: stored.map((name) => ({ name, value: REDACTED_CREDENTIAL })),
    credentialStorage: { kind: 'none' },
    permissions: { state: 'written', document: null, rules: [] },
    configDocument: null,
  } as AgentProfileReadout
}

/**
 * The profile client the credential client reads through.
 *
 * `read` answers the profile's credentials as the backend does — names, and the placeholder in
 * every value — which is the only thing the authoring client reads off it. `write` is here because
 * the port declares it, and it refuses rather than pretending: a call this test never intends to
 * make.
 */
const profile = {
  read: async () => readout(['NWK_IAPP_API_KEY']),
  write: async () => {
    throw new Error('the credential write is not supposed to reach the record')
  },
}

/** The authoring client over one wire, with the credential client built the way the app builds it. */
function authoring(made: ReturnType<typeof wire>) {
  return createAgentProviderAuthoringClient({
    models: made.models,
    credentials: createAgentCredentialClient({
      wire: made.credential,
      profile,
      agentId: 'bundled-engine',
      profileId: 'default',
    }),
  })
}

/** The commands the client is built over, with every request kept. */
function wire(): {
  models: { listModels(config: unknown): Promise<string[]> }
  credential: { write(request: { agentId: string; profileId: string; changes: unknown }): Promise<unknown> }
  configs: unknown[]
  changes: unknown[]
} {
  const configs: unknown[] = []
  const changes: unknown[] = []
  return {
    models: {
      listModels: async (config) => {
        configs.push(config)
        return ['deepseek-v4.1-flash']
      },
    },
    credential: {
      write: async (request) => {
        changes.push(request.changes)
        return readout()
      },
    },
    configs,
    changes,
  }
}

describe('the model fetch', () => {
  it('sends the address and the key it was given, under the provider that means "use this address"', async () => {
    const made = wire()
    const client = createAgentProviderAuthoringClient({
      models: made.models,
      credentials: createAgentCredentialClient({
        wire: made.credential,
        profile,
        agentId: 'bundled-engine',
        profileId: 'default',
      }),
    })

    const ids = await client.fetchModels({
      baseUrl: ' https://ai.example.org/v1 ',
      apiKey: 'sk-not-a-real-key',
      allowPrivate: true,
    })

    expect(ids).toEqual(['deepseek-v4.1-flash'])
    // The whole request, because every field of it is load-bearing: `model` is required by the
    // command's DTO, `provider` is what makes `base_url` the address rather than a default one, and
    // a key in the field is what stops the command backfilling this app's own AI key instead.
    expect(made.configs).toEqual([
      {
        provider: 'custom',
        model: '',
        base_url: 'https://ai.example.org/v1',
        api_key: 'sk-not-a-real-key',
        allow_private: true,
      },
    ])
  })
})

describe('the credential write', () => {
  it('is the credentials section’s own patch rule, one field at a time', async () => {
    const made = wire()
    const client = createAgentProviderAuthoringClient({
      models: made.models,
      credentials: createAgentCredentialClient({
        wire: made.credential,
        profile,
        agentId: 'bundled-engine',
        profileId: 'default',
      }),
    })

    await client.setCredential('NWK_IAPP_API_KEY', '  sk-not-a-real-key  ')

    // Trimmed by `credentialSubmission`, which is the same function the credentials section's form
    // submits through — so a key stored from here and one stored there are the same kind of value.
    expect(made.changes).toEqual([
      [{ op: 'set', name: 'NWK_IAPP_API_KEY', value: 'sk-not-a-real-key' }],
    ])
  })

  it('removes one through the same patch rule the credentials section submits', async () => {
    const made = wire()

    await authoring(made).removeCredential('NWK_IAPP_API_KEY')

    // `op: 'remove'`, not an empty value: a provider handed an empty key rejects much later and in
    // a much less obvious way. This is the explicit half of the form — the user asked for the key
    // to go — and it travels the same rule as clearing a field in the credentials section.
    expect(made.changes).toEqual([[{ op: 'remove', name: 'NWK_IAPP_API_KEY' }]])
  })

  it('answers the names the profile stores, and nothing else', async () => {
    const made = wire()

    expect(await authoring(made).storedCredentials()).toEqual(['NWK_IAPP_API_KEY'])
    // Nothing was written by asking: the read is the profile client's, and no patch went out.
    expect(made.changes).toEqual([])
  })

  it('rejects rather than reporting success when the policy refuses the value', async () => {
    const made = wire()
    const client = createAgentProviderAuthoringClient({
      models: made.models,
      credentials: {
        write: async () => ({
          status: 'refused' as const,
          message: 'that is the value this page shows in place of a key, not a key',
        }),
        // Declared, and never reached on this path: the refusal above is what this test is about.
        names: async () => [],
      },
    })

    // The arm is reachable from a real field: a user who pastes the placeholder the credentials
    // section displays. Silence here would let the save carry on and write a block pointing at a
    // variable no call ever set.
    await expect(client.setCredential('NWK_IAPP_API_KEY', REDACTED_CREDENTIAL)).rejects.toThrow(
      /not a key/,
    )
  })
})

/**
 * 「获取模型」 is the third gesture that reaches `ai_list_models`, and the one that carries a key
 * the user just typed — so it is the last place a switched-off AI may still send something. The
 * settings page's two gestures go through the store (`settings-ai-list-models-gate.test.ts`); this
 * client has a port of its own and answers the switch here.
 */
describe('the model fetch under the AI master switch', () => {
  it('asks the endpoint for nothing when AI is switched off', async () => {
    setActivePinia(createPinia())
    useAiPermissionStore().setEnabled(false)
    const made = wire()

    const ids = await authoring(made).fetchModels({
      baseUrl: 'https://ai.example.org/v1',
      apiKey: 'sk-not-a-real-key',
      allowPrivate: true,
    })

    // No request at all: the key in the field is a credential, and the command would backfill this
    // app's own stored key on top of it. The empty answer is what the form's `ok` state can hold
    // without inventing a failure the user cannot act on; the block itself is announced once for
    // the whole app (`ai-gate.announceBlock`), so pressing the button twice does not repeat it.
    expect(made.configs).toEqual([])
    expect(ids).toEqual([])
  })

  it('still fetches for a switched-on AI', async () => {
    // The paired half: the default state, and what an install predating the switch reads back.
    setActivePinia(createPinia())
    const made = wire()

    const ids = await authoring(made).fetchModels({
      baseUrl: 'https://ai.example.org/v1',
      apiKey: 'sk-not-a-real-key',
      allowPrivate: true,
    })

    expect(made.configs).toHaveLength(1)
    expect(ids).toEqual(['deepseek-v4.1-flash'])
  })

  it('stays open with no app at all, as a bare unit test and the plugin host have', async () => {
    // `ai-gate.permissionState()` is deliberately null outside an app and `aiDisabled()` false
    // then: a state we cannot read is not evidence that the user switched AI off. A gate that
    // closed here would also be a gate this suite could not tell apart from the bug — every case
    // above would pass for the wrong reason.
    setActivePinia(undefined)
    const made = wire()

    await authoring(made).fetchModels({
      baseUrl: 'https://ai.example.org/v1',
      apiKey: 'sk-not-a-real-key',
      allowPrivate: true,
    })

    expect(made.configs).toHaveLength(1)
  })
})
