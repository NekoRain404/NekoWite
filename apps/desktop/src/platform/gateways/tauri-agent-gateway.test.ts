/**
 * The gateway over a fake IPC: the session handle, the model catalogue, and one turn per session.
 *
 * The port is faked here (`tauri-agent-fake-host.ts`) rather than the Tauri calls, so what is under
 * test is the adapter *above* the IPC — the handle it mints from the host's epoch and the engine's
 * id, the catalogue it projects out of the host's option shape, the turn latch, and the promises a
 * frame settles. The frames it pushes are the measured ones (`tauri-agent-frames.ts`).
 */

import { describe, expect, it, vi } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn())
const listenMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))

import { createTauriAgentGateway } from './tauri-agent'
import { LISTED_TITLE, fakeIpc, openSessionOn, settleMicrotasks } from './tauri-agent-fake-host'
import { IDENTITY, RUN_FINISHED, frame } from './tauri-agent-frames'

describe('the real gateway', () => {
  it('mints a session handle from the host’s epoch and the engine’s id', async () => {
    const gateway = createTauriAgentGateway({ vaultId: 'vault-1', ipc: fakeIpc() })
    const session = await openSessionOn(gateway)
    expect(session).toMatchObject(IDENTITY)
    // The catalog is the projection of the option the host named — one read, both halves.
    expect(session.models).toEqual([
      { id: 'fake/model-a', name: 'Model A' },
      { id: 'fake/model-b', name: 'Model B' },
    ])
    expect(session.initialModelId).toBe('fake/model-a')
  })

  it('answers a config set with the engine’s refreshed list, read out of the schema shape', async () => {
    // `agent_set_config_option` returns `serde_json::Value` holding the full option set with its
    // current values, in the same schema shape `agent_open_session` answers — and it used to be
    // dropped on the floor (`Promise<void>` on the port), so a caller that shows the option had
    // nothing to show unless the engine *also* announced the change as `config-changed`. The
    // pinned engine does; an engine that answered without notifying would have left the row
    // showing the value the reader had just left.
    const ipc = fakeIpc({
      selectModel: async () => [
        {
          id: 'model',
          name: 'Model',
          type: 'select',
          currentValue: 'fake/model-b',
          options: [
            { value: 'fake/model-a', name: 'Model A' },
            { value: 'fake/model-b', name: 'Model B' },
          ],
        },
      ],
    })
    const gateway = createTauriAgentGateway({ vaultId: 'vault-1', ipc })
    const session = await openSessionOn(gateway)

    expect(await gateway.setConfigOption(session, 'model', 'fake/model-b')).toEqual([
      {
        id: 'model',
        name: 'Model',
        value: {
          kind: 'select',
          current: 'fake/model-b',
          choices: [
            { value: 'fake/model-a', name: 'Model A' },
            { value: 'fake/model-b', name: 'Model B' },
          ],
        },
      },
    ])
  })

  it('answers null rather than an empty list when the set’s answer cannot be read', async () => {
    // The two arms are two different statements. An answer this window cannot read must leave the
    // caller's list alone: `[]` would be read as the engine withdrawing every option, which is a
    // change it never stated — and it would clear the row on a bad answer rather than on a fact.
    const ipc = fakeIpc({ selectModel: async () => ({ not: 'a list' }) })
    const gateway = createTauriAgentGateway({ vaultId: 'vault-1', ipc })
    const session = await openSessionOn(gateway)

    expect(await gateway.setConfigOption(session, 'model', 'fake/model-b')).toBeNull()
  })

  it('carries the name the engine gave a session onto the handle a reopen answers with', async () => {
    // A reopened session is one the engine has already named, and the only answer this window is
    // ever given that name in is `session/list` — the load response carries no title, and the
    // frame that would state one (`SessionInfoUpdate`) is not mapped on the host side. So the row
    // the reader picked from is the one place the string exists, and it is this adapter that read
    // it: the pick arrives here as a `loadSession` for the same id.
    const gateway = createTauriAgentGateway({ vaultId: 'vault-1', ipc: fakeIpc() })
    // The list needs a live runtime: `agent_list_sessions` reaches the engine through the session
    // slot, so a gateway that was never started refuses the call itself and no list is read.
    await gateway.start()

    const listed = await gateway.listSessions()
    expect(listed.sessions[0]?.title).toBe(LISTED_TITLE)
    expect(listed.sessions[0]?.held).toBe(true)

    const reopened = await gateway.loadSession('ses_fake_1', { vaultId: 'vault-1', cwd: '/vault' })
    expect(reopened.title).toBe(LISTED_TITLE)
  })

  it('leaves a session it was never told a name for without one, rather than inventing a name', async () => {
    // A new session has no name in any answer yet, and a reopen the window never listed has none
    // either. Both are `null`, which is the bar's own sentence ('New {engine} session') — a name
    // this app wrote would be a fact the engine never stated.
    const gateway = createTauriAgentGateway({ vaultId: 'vault-1', ipc: fakeIpc() })

    const opened = await openSessionOn(gateway)
    expect(opened.title).toBeNull()
    const reopened = await gateway.loadSession('ses_fake_1', { vaultId: 'vault-1', cwd: '/vault' })
    expect(reopened.title).toBeNull()
  })

  it('refuses to send a model the session never offered, before the engine sees it', async () => {
    const ipc = fakeIpc()
    const gateway = createTauriAgentGateway({ vaultId: 'vault-1', ipc })
    const session = await openSessionOn(gateway)
    await expect(gateway.selectModel(session, 'fake/never')).rejects.toMatchObject({
      code: 'invalid-response',
    })
    // The option the catalog came from is what a real switch moves — the contract's
    // `selectModel` carries no option id, so the adapter has to have kept it.
    await gateway.selectModel(session, 'fake/model-b')
    expect(ipc.calls).toContain('selectModel')
  })

  it('refuses a call on a runtime that is not started', async () => {
    const gateway = createTauriAgentGateway({ vaultId: 'vault-1', ipc: fakeIpc() })
    await expect(gateway.openSession({ vaultId: 'vault-1', cwd: '/vault' })).rejects.toMatchObject({
      code: 'runtime-unavailable',
    })
  })

  it('resolves a prompt when the run’s ending arrives as a frame', async () => {
    const ipc = fakeIpc()
    const gateway = createTauriAgentGateway({ vaultId: 'vault-1', ipc })
    const session = await openSessionOn(gateway)
    const pending = gateway.prompt(session, 'hello')
    await settleMicrotasks()
    expect(ipc.listeners).toBe(1)
    ipc.push(frame('text-delta', { text: 'PONG' }))
    ipc.push(frame('run-finished', RUN_FINISHED))
    await expect(pending).resolves.toEqual({
      stopReason: 'end-turn',
      usage: { inputTokens: 11, outputTokens: 2, totalTokens: 13, thoughtTokens: 1 },
    })
  })

  it('settles a run whose ending arrives before the prompt call has returned', async () => {
    // The race the store documents in its own header: the engine's reaction can be delivered
    // before the call that asked for it returns. A frame dropped here would leave `prompt`
    // waiting on a turn that is already over.
    const ipc = fakeIpc()
    ipc.prompt = async () => {
      ipc.push(frame('run-finished', RUN_FINISHED))
      return 'run-0'
    }
    const gateway = createTauriAgentGateway({ vaultId: 'vault-1', ipc })
    const session = await openSessionOn(gateway)
    await expect(gateway.prompt(session, 'hello')).resolves.toMatchObject({ stopReason: 'end-turn' })
  })

  it('rejects the turn when the host reports it failed', async () => {
    const ipc = fakeIpc()
    const gateway = createTauriAgentGateway({ vaultId: 'vault-1', ipc })
    const session = await openSessionOn(gateway)
    const pending = gateway.prompt(session, 'hello')
    await settleMicrotasks()
    expect(ipc.listeners).toBe(1)
    ipc.push(frame('run-failed', { code: 'process-exited', message: 'the engine exited' }))
    await expect(pending).rejects.toMatchObject({ code: 'process-exited' })
  })

  it('keeps one active generation per session', async () => {
    // The refusal is the point of the test and it is unchanged — §6.2 allows one generation per
    // session, and this is the boundary that holds it. Only the code moved: `turn-in-flight`
    // names the condition, where `buffer-conflict` named a stream that cannot be continued
    // (`channel.ts`) or a view larger than the host will hold (`agent-event-reducer.ts`). How the
    // latch is *released* is what `tauri-agent/turn-liveness.test.ts` covers.
    const gateway = createTauriAgentGateway({ vaultId: 'vault-1', ipc: fakeIpc() })
    const session = await openSessionOn(gateway)
    const first = gateway.prompt(session, 'one')
    await expect(gateway.prompt(session, 'two')).rejects.toMatchObject({ code: 'turn-in-flight' })
    void first.catch(() => {})
  })

  it('ends a turn in flight when the runtime stops, and rejects the caller’s promise', async () => {
    const ipc = fakeIpc()
    const gateway = createTauriAgentGateway({ vaultId: 'vault-1', ipc })
    const session = await openSessionOn(gateway)
    const pending = gateway.prompt(session, 'hello')
    await settleMicrotasks()
    expect(ipc.listeners).toBe(1)
    await gateway.stop()
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    // The listener goes with the runtime: nothing is left registered for a gateway whose
    // every call would now be refused.
    expect(ipc.unlistened).toBe(1)
    expect(ipc.listeners).toBe(0)
  })
})
