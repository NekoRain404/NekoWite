/**
 * The window's half of the Tauri agent IPC, and the refusals it has to spell.
 *
 * `invoke` and `listen` are mocked the way every other gateway test in this package mocks them:
 * this is the layer that names the Rust commands, so the argument shapes it invokes with — the
 * camelCase keys Tauri deserializes them from, and the `Option<Vec<PromptAttachment>>` that makes
 * an empty attachment list a stated `null` rather than an absent key — the event envelope a
 * listener is handed, and the attachment enum read off the Rust source are all asserted here
 * rather than through the gateway above them.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn())
const listenMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { AGENT_PROMPT_ATTACHMENT_KINDS, AgentFailure } from './agent-contracts'
import { createTauriAgentIpc } from './tauri-agent'
import { IDENTITY } from './tauri-agent-frames'

// ---------------------------------------------------------------------------
// The IPC arguments
// ---------------------------------------------------------------------------

describe('the window’s half of the IPC', () => {
  beforeEach(() => invokeMock.mockReset())

  it('invokes the two commands the backend has with the arguments it declared', async () => {
    // `commands/agent.rs`: `agent_permission_answer(answer: PermissionAnswer)` and
    // `agent_cancel_run(session_id: String)`, neither with `rename_all`, so the keys are the
    // camelCase spelling Tauri deserializes them from.
    invokeMock.mockResolvedValue(undefined)
    const ipc = createTauriAgentIpc()
    await ipc.answerPermission({
      session: { ...IDENTITY },
      requestId: 'perm-1',
      optionId: 'once',
    })
    expect(invokeMock).toHaveBeenLastCalledWith('agent_permission_answer', {
      answer: { session: IDENTITY, requestId: 'perm-1', optionId: 'once' },
    })
    await ipc.cancel('ses_fake_1')
    expect(invokeMock).toHaveBeenLastCalledWith('agent_cancel_run', { sessionId: 'ses_fake_1' })
  })

  it('names every command it calls, so a missing backend command is one line to find', async () => {
    invokeMock.mockResolvedValue({})
    const ipc = createTauriAgentIpc()
    await ipc.start('vault-1')
    await ipc.stop()
    await ipc.openSession('vault-1', '/vault')
    await ipc.selectModel('ses_fake_1', 'model', 'fake/model-b')
    await ipc.prompt('ses_fake_1', 'hello', [])
    await ipc.snapshot('ses_fake_1')
    expect(invokeMock.mock.calls.map((call) => call[0])).toEqual([
      'agent_start',
      'agent_stop',
      'agent_open_session',
      'agent_set_config_option',
      'agent_prompt',
      'agent_session_snapshot',
    ])
    // `null` rather than an absent key, and that is the Rust command's own signature: its
    // `attachments` parameter is `Option<Vec<PromptAttachment>>`, so a turn with nothing attached
    // is stated rather than left out — and the assertion has to say which of the two it is, or it
    // would pass on both.
    expect(invokeMock).toHaveBeenCalledWith('agent_prompt', {
      sessionId: 'ses_fake_1',
      text: 'hello',
      attachments: null,
    })
  })

  it('carries an attachment to the command as the window described it', async () => {
    invokeMock.mockResolvedValue('run-0')
    const ipc = createTauriAgentIpc()
    await ipc.prompt('ses_fake_1', 'look', [
      { kind: 'image', name: 'shot.png', mediaType: 'image/png', data: 'QUJD' },
    ])
    expect(invokeMock).toHaveBeenCalledWith('agent_prompt', {
      sessionId: 'ses_fake_1',
      text: 'look',
      attachments: [{ kind: 'image', name: 'shot.png', mediaType: 'image/png', data: 'QUJD' }],
    })
  })

  it('spells the attachment the way the Rust enum does', () => {
    // The Rust half is a serde internally-tagged enum: `#[serde(tag = "kind", rename_all =
    // "camelCase")]` over variants `Resource`/`Image` carrying `path`/`text`/`mediaType` and
    // `name`/`mediaType`/`data`. Read off the source rather than restated, because a field that
    // drifted would deserialize to a default and the block would reach the engine empty.
    const rust = readFileSync(
      resolve(__dirname, '../../../src-tauri/src/agent_runtime/attachments.rs'),
      'utf8',
    )
    const enumStart = rust.indexOf('pub enum PromptAttachment {')
    expect(enumStart, 'PromptAttachment is not declared in attachments.rs').toBeGreaterThan(-1)
    const body = rust.slice(enumStart, rust.indexOf('\n}', enumStart))
    expect(rust.slice(0, enumStart)).toContain('#[serde(tag = "kind", rename_all = "camelCase")]')
    expect(body).toContain('Resource {')
    expect(body).toContain('Image {')
    for (const field of ['path: String', 'text: String', 'name: String', 'data: String']) {
      expect(body, `the Rust enum has no field ${field}`).toContain(field)
    }
    // The two `media_type` fields, each renamed to the wire's spelling — one per arm.
    expect(body.match(/#\[serde\(rename = "mediaType"\)\]/g)).toHaveLength(2)
    expect(AGENT_PROMPT_ATTACHMENT_KINDS).toEqual(['resource', 'image'])
  })

  it('unwraps the event envelope Tauri hands a listener', async () => {
    const received: unknown[] = []
    listenMock.mockImplementation(async (_channel: string, handler: (event: { payload: unknown }) => void) => {
      handler({ payload: 'the-frame' })
      return () => {}
    })
    await createTauriAgentIpc().onEvent((frame) => received.push(frame))
    expect(listenMock).toHaveBeenCalledWith('agent-event', expect.any(Function))
    expect(received).toEqual(['the-frame'])
  })
})

/**
 * The rejected-call half of the same boundary, in a describe of its own.
 *
 * **Why it does not share the describe above.** That one resets `invoke` in a `beforeEach`, and a
 * mock whose *result* is a rejection does not survive it in this vitest version: the raw rejection
 * is then reported as an unhandled error — which this project's config turns into a red run
 * (`vitest.unhandled-reporter.ts` states the ruling) — even though the assertion that awaited it
 * passed. Nothing here calls `mockReset` or `mockClear` for that reason, and every test sets the
 * implementation it needs before it calls. The failure that constraint costs is a test that cannot
 * see leftover implementations; the one it buys is a test that can see a rejection at all.
 */
describe('a call the host refused', () => {
  it('turns a rejected call into the contract’s failure, code and all', async () => {
    // The Rust commands reject with `commands::agent::AgentFailure` — `{code, message}`, the same
    // pair a `run-failed` frame carries — and this is the one place that knows the wire, so it is
    // the one place that can turn it into the contract's own `AgentFailure`. Before this existed
    // the rejection was the *sentence alone*: `SessionError::failure_code` was computed, tested and
    // reached by nothing, and a caller here had to match on wording to learn the condition.
    invokeMock.mockRejectedValue({
      code: 'load-in-flight',
      message: 'session ses_fake_1 is still being reopened; wait for it to finish',
    })
    const ipc = createTauriAgentIpc()
    const rejection = await ipc.loadSession('vault-1', '/vault', 'ses_fake_1').catch((e: unknown) => e)
    expect(rejection).toBeInstanceOf(AgentFailure)
    expect((rejection as AgentFailure).code).toBe('load-in-flight')
    expect((rejection as AgentFailure).message).toBe(
      'session ses_fake_1 is still being reopened; wait for it to finish',
    )
  })

  it('never invents a code for a rejection it cannot read, and never drops the sentence', async () => {
    // Two arms, and both have to stay honest. A rejection that is still a bare string is what two
    // commands answer today — the permission-grant pair, whose failures are the engine's HTTP
    // surface rather than the ACP pipe this vocabulary classifies — and Tauri's own "command not
    // found" is a string too. What a caller must not receive is a *code*, because a code is a
    // claim about a condition nobody stated: `invalid-response` is this list's word for "the answer
    // could not be read", which is exactly what happened.
    invokeMock.mockRejectedValue('the runtime is not started')
    const ipc = createTauriAgentIpc()
    const rejection = await ipc.stop().catch((e: unknown) => e)
    expect(rejection).toBeInstanceOf(AgentFailure)
    expect((rejection as AgentFailure).code).toBe('invalid-response')
    expect((rejection as AgentFailure).message).toBe('the runtime is not started')

    // And a code this window does not know is not one it passes through: a newer backend's
    // vocabulary arriving here would otherwise reach a feature whose switch has no arm for it.
    invokeMock.mockRejectedValue({ code: 'a-code-from-the-future', message: 'something new' })
    const unknown = await ipc.stop().catch((e: unknown) => e)
    expect((unknown as AgentFailure).code).toBe('invalid-response')
    expect((unknown as AgentFailure).message).toBe('something new')
  })

})
