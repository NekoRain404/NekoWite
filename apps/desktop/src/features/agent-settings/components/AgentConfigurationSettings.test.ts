/**
 * The configuration page, rendered: the four arms of `configEditor`, held at the level a user meets
 * them — what is on screen.
 *
 * `agent-config-ipc.test.ts` holds the client's rules as values. This file exists for the one thing
 * a value test cannot prove, and it is the rule this whole page is built around:
 *
 *  - **Only the arm that can write draws a control.** The other three draw sentences, each its own,
 *    because their next moves are three different things. The failure being guarded against is a
 *    form on screen over a document the backend will refuse to write — a disabled-looking control
 *    that claims an action exists. So every non-editable case below asserts the *absence* of
 *    `input`, `textarea` and `button` in the page, at the DOM.
 *  - **The document is drawn as the engine wrote it.** The text arrives with its comments and is
 *    rendered verbatim; nothing here parses it, so the case where a comment survives is the case
 *    that proves the page is showing the file rather than a re-serialization of it.
 *  - **Both fields are refused before the backend is asked.** A blank member and a value that is
 *    not JSON are things this form can see, and the assertion on the call count is what keeps
 *    "refused here" from being a sentence printed after a round trip that did something.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { setLocale } from '../../../i18n'
import AgentConfigurationSettings from './AgentConfigurationSettings.vue'
import type { AgentConfigClient, AgentConfigReadout } from '../services/agent-config-ipc'
import type { ConfigEdit } from '../services/agent-settings-policy'

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

/** A document this host may write. The comment in the text is the point: it must survive. */
const EDITABLE: AgentConfigReadout = {
  state: 'document',
  document: {
    path: RELATIVE,
    resolved: `/tmp/profile/${RELATIVE}`,
    exists: true,
    revision: REVISION,
    text: '{\n  // the engine’s own comment\n  "permission": { "edit": "ask" }\n}\n',
    editable: true,
  },
}

interface Stub {
  client: AgentConfigClient
  /** Every edit the page sent, so "refused before the backend was asked" is observable. */
  edits: { relative: string; revision: string; edits: readonly ConfigEdit[] }[]
}

function stub(answers: AgentConfigReadout | Error, edit?: unknown): Stub {
  const edits: Stub['edits'] = []
  const client: AgentConfigClient = {
    read: async () => {
      if (answers instanceof Error) throw answers
      return answers
    },
    edit: async (relative, revision, list) => {
      edits.push({ relative, revision, edits: list })
      if (edit instanceof Error) throw edit
      return (edit ?? { status: 'written', revision: 'b'.repeat(64) }) as never
    },
  }
  return { client, edits }
}

async function render(client: AgentConfigClient): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(AgentConfigurationSettings, { client })
  app.mount(host)
  mounted.push(app)
  await nextTick()
  await nextTick()
}

function el(test: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-test="${test}"]`)
}

/** Every control the page drew. Used to prove an arm draws none. */
function controls(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('input, button, textarea, select')]
}

function type(test: string, value: string): void {
  const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-test="${test}"]`)
  if (!field) throw new Error(`no field ${test}`)
  field.value = value
  field.dispatchEvent(new Event('input'))
}

async function submit(): Promise<void> {
  el('config-edit')?.dispatchEvent(new Event('submit'))
  await nextTick()
  await nextTick()
}

describe('the four arms', () => {
  it('draws the document and a form when the backend says the profile may be written', async () => {
    await render(stub(EDITABLE).client)

    // The file as written — comment included, on one line of its own.
    expect(el('config-text')?.textContent).toBe(EDITABLE.state === 'document' ? EDITABLE.document.text : '')
    expect(el('config-location')?.textContent).toContain('opencode.json')
    expect(el('config-edit')).not.toBeNull()
    expect(el('config-none')).toBeNull()
    expect(el('config-unwritten')).toBeNull()
    expect(el('config-read-only')).toBeNull()
  })

  it('states the reason, and draws no control, when this host owns no document for the pair', async () => {
    await render(stub({ state: 'no-document' }).client)

    expect(el('config-none')).not.toBeNull()
    expect((el('config-none')?.textContent ?? '').length).toBeGreaterThan(20)
    // Not a greyed-out form: nothing at all. A control that can only fail reads as a feature that
    // is broken rather than one that was never built.
    expect(controls()).toEqual([])
  })

  it('states that the engine has written nothing, and draws no control', async () => {
    // `agent_config_edit` cannot create a document (`apply` answers `Conflicted { current: None }`
    // for a file that is not there), so a form here would be a control that cannot work.
    await render(
      stub({
        state: 'document',
        document: { ...EDITABLE.document, exists: false, revision: null, text: null },
      }).client,
    )

    expect(el('config-unwritten')).not.toBeNull()
    expect(el('config-edit')).toBeNull()
    expect(controls()).toEqual([])
  })

  it('states that this host may not write the document, and draws no control', async () => {
    await render(
      stub({
        state: 'document',
        document: { ...EDITABLE.document, editable: false },
      }).client,
    )

    // The text is still drawn: §8.1 asks a page to say what is actually in effect, and a file a
    // user may not edit is still a file they may read.
    expect(el('config-text')).not.toBeNull()
    expect(el('config-read-only')).not.toBeNull()
    expect(el('config-edit')).toBeNull()
    expect(controls()).toEqual([])
  })

  it('draws its own unreadable arm with a retry when the read does not complete', async () => {
    await render(stub(new Error('agent_config_document refused')).client)

    expect(el('config-unreadable')).not.toBeNull()
    // The retry is the one control this arm has, and it is not an editor.
    expect(controls().map((control) => control.dataset.test)).toEqual(['config-retry'])
  })
})

describe('the edit', () => {
  it('sends the member, the value and the revision the page read', async () => {
    const { client, edits } = stub(EDITABLE)
    await render(client)

    type('config-member', 'permission')
    type('config-value', '{ "edit": "ask" }')
    await submit()

    expect(edits).toHaveLength(1)
    expect(edits[0].relative).toBe(RELATIVE)
    expect(edits[0].revision).toBe(REVISION)
    // One member, as one path segment: §3.4.3's rule read one layer in — a name is never joined
    // with its parent, and a key containing a dot is not two keys.
    expect(edits[0].edits).toEqual([{ path: ['permission'], value: { edit: 'ask' } }])
    expect(el('config-applied')).not.toBeNull()
  })

  it('refuses a blank member without asking the backend', async () => {
    const { client, edits } = stub(EDITABLE)
    await render(client)

    type('config-value', 'true')
    await submit()

    expect(el('config-no-member')).not.toBeNull()
    expect(edits).toHaveLength(0)
  })

  it('refuses a value that is not JSON without asking the backend', async () => {
    const { client, edits } = stub(EDITABLE)
    await render(client)

    type('config-member', 'permission')
    // A bare word is the case a form has to catch: the backend parses JSON, and a user who typed
    // `ask` means the string, which is why the sentence says what the field wants.
    type('config-value', 'ask')
    await submit()

    expect(el('config-invalid-value')).not.toBeNull()
    expect(edits).toHaveLength(0)
  })

  it('says the file changed elsewhere and writes nothing, rather than retrying', async () => {
    const { client, edits } = stub(EDITABLE, {
      status: 'conflict',
      current: { revision: 'c'.repeat(64), text: '{ "permission": { "edit": "deny" } }' },
    })
    await render(client)

    type('config-member', 'permission')
    type('config-value', '{ "edit": "ask" }')
    await submit()

    expect(edits).toHaveLength(1)
    expect(el('config-conflict')).not.toBeNull()
    // Not retried: merging an edit into a document nobody read is how the other change is undone.
    expect(el('config-applied')).toBeNull()
  })

  it('says the change could not be sent when the call does not complete', async () => {
    const { client } = stub(EDITABLE, new Error('agent_config_edit refused'))
    await render(client)

    type('config-member', 'permission')
    type('config-value', '{}')
    await submit()

    expect(el('config-failed')).not.toBeNull()
    expect(el('config-applied')).toBeNull()
  })
})
