import { describe, expect, it, vi } from 'vitest'
const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))
import { createTauriAgentGateway, createTauriAgentIpc } from './tauri-agent'
import { fakeIpc, openSessionOn } from './tauri-agent-fake-host'

describe('selected agent IPC', () => {
  it('preserves omitted identities and sends explicit selections', async () => {
    const ipc = createTauriAgentIpc()
    await ipc.start('vault')
    expect(invoke).toHaveBeenLastCalledWith('agent_start', { vaultId: 'vault' })
    await ipc.start('vault', 'external', 'external-profile')
    expect(invoke).toHaveBeenLastCalledWith('agent_start', {
      vaultId: 'vault', agentId: 'external', profileId: 'external-profile',
    })
  })

  it('passes requested identity from gateway options', async () => {
    const ipc = fakeIpc()
    const start = vi.spyOn(ipc, 'start')
    await createTauriAgentGateway({ vaultId: 'vault', agentId: 'external', profileId: 'profile', ipc }).start()
    expect(start).toHaveBeenCalledWith('vault', 'external', 'profile')
  })

  it('reports a prompt awaiting host acceptance as active', async () => {
    const ipc = fakeIpc()
    ipc.prompt = () => new Promise(() => {})
    const gateway = createTauriAgentGateway({ vaultId: 'vault-1', ipc })
    const session = await openSessionOn(gateway)
    const prompt = gateway.prompt(session, 'pending').catch(() => {})
    expect((await gateway.snapshot(session)).state).toBe('running')
    await gateway.stop()
    await prompt
  })
})
