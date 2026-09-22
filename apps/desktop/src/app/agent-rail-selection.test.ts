import { describe, expect, it, vi } from 'vitest'
import { createAgentRail } from './agent-rail'
import { createAgentComposition } from './agent-composition'

function setup() {
  const first = createAgentComposition({ vaultId: 'vault', environment: 'browser', agentId: 'first' })
  const second = createAgentComposition({ vaultId: 'vault', environment: 'browser', agentId: 'second' })
  for (const composition of [first, second]) {
    const open = composition.openSession.bind(composition)
    composition.openSession = async (request) => {
      await composition.start()
      return open(request)
    }
  }
  const stop = vi.spyOn(first, 'stop')
  const compose = vi.fn((_vault: string, agentId?: string) => agentId === 'second' ? second : first)
  const failed = vi.fn()
  const rail = createAgentRail({ compose, onNewSessionFailed: failed, onStopFailed: vi.fn() })
  return { first, second, stop, compose, failed, rail }
}

describe('selected agent sessions', () => {
  it('stops the old engine and starts the selected identity', async () => {
    const { rail, compose, stop } = setup()
    await rail.open('vault', '/notes')
    await rail.newSession('second')
    expect(stop).toHaveBeenCalledOnce()
    expect(compose).toHaveBeenLastCalledWith('vault', 'second')
    expect(rail.state.value).toMatchObject({ kind: 'live', session: { agentId: 'second' } })
  })

  it('keeps same-agent new sessions on the existing engine', async () => {
    const { rail, compose, stop } = setup()
    await rail.open('vault', '/notes')
    await rail.newSession('first')
    expect(stop).not.toHaveBeenCalled()
    expect(compose).toHaveBeenCalledOnce()
  })

  it.each(['running', 'waiting-permission', 'starting'] as const)('refuses an offscreen %s session', async (state) => {
    const { rail, first, stop, failed } = setup()
    await rail.open('vault', '/notes')
    const original = rail.state.value
    if (original.kind !== 'live') throw new Error('missing live session')
    await rail.newSession()
    const snapshot = first.gateway.snapshot.bind(first.gateway)
    vi.spyOn(first.gateway, 'snapshot').mockImplementation(async (session) => ({
      ...await snapshot(session), state: session === original.session ? state : 'ready',
    }))
    await rail.newSession('second')
    expect(stop).not.toHaveBeenCalled()
    expect(failed).toHaveBeenCalledOnce()
    expect(rail.state.value).toMatchObject({ kind: 'live', session: { agentId: 'first' } })
  })

  it('refuses switching when a snapshot is unavailable', async () => {
    const { rail, first, stop, failed } = setup()
    await rail.open('vault', '/notes')
    vi.spyOn(first.gateway, 'snapshot').mockRejectedValue(new Error('snapshot unavailable'))
    await rail.newSession('second')
    expect(stop).not.toHaveBeenCalled()
    expect(failed).toHaveBeenCalledOnce()
  })

  it('retains the live engine when stop fails and retries the selected target', async () => {
    const { rail, compose, stop, first } = setup()
    await rail.open('vault', '/notes')
    stop.mockRejectedValueOnce(new Error('stop failed'))
    await rail.newSession('second')
    expect(compose).toHaveBeenCalledOnce()
    expect(rail.composition.value).toBe(first)
    await rail.retry()
    expect(compose).toHaveBeenLastCalledWith('vault', 'second')
    expect(rail.state.value).toMatchObject({ kind: 'live', session: { agentId: 'second' } })
  })

  it('does not let another new-session request reuse an engine while it is stopping', async () => {
    const { rail, stop, first } = setup()
    await rail.open('vault', '/notes')
    let finish!: () => void
    stop.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    const switching = rail.newSession('second')
    for (let tick = 0; tick < 20 && stop.mock.calls.length === 0; tick++) await Promise.resolve()
    const open = vi.spyOn(first, 'openSession')
    const duplicate = rail.newSession()
    finish()
    await Promise.all([switching, duplicate])
    expect(open).not.toHaveBeenCalled()
    expect(rail.state.value).toMatchObject({ kind: 'live', session: { agentId: 'second' } })
  })

  it('retries the chosen identity after its startup fails', async () => {
    const { rail, second, compose } = setup()
    await rail.open('vault', '/notes')
    vi.spyOn(second, 'openSession').mockRejectedValueOnce(new Error('start failed'))
    await rail.newSession('second')
    expect(rail.state.value.kind).toBe('refused')
    await rail.retry()
    expect(compose).toHaveBeenLastCalledWith('vault', 'second')
    expect(rail.state.value).toMatchObject({ kind: 'live', session: { agentId: 'second' } })
  })

  it('allows selecting another agent after a refused startup', async () => {
    const { rail, first, compose } = setup()
    vi.spyOn(first, 'openSession').mockRejectedValueOnce(new Error('default unavailable'))
    await rail.open('vault', '/notes')
    expect(rail.state.value.kind).toBe('refused')
    await rail.newSession('second')
    expect(compose).toHaveBeenLastCalledWith('vault', 'second')
    expect(rail.state.value).toMatchObject({ kind: 'live', session: { agentId: 'second' } })
  })
})
