import { afterEach, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, shallowRef, type App } from 'vue'
import { useAgentRegistryReadout } from './use-agent-registry-readout'
import type { AgentRegistryClient, AgentRegistryReadout } from '../services/agent-registry-policy'

const answer = (id: string): AgentRegistryReadout => ({ defaultAgentId: id, entries: [], adapterIds: [], runningAgentIds: [], profileOwners: {} })
const client = (read: AgentRegistryClient['read']): AgentRegistryClient => ({ read, add: vi.fn(), update: vi.fn(), delete: vi.fn(), setEnabled: vi.fn() })
let app: App
afterEach(() => { app.unmount(); document.body.innerHTML = '' })
const flush = async () => { await nextTick(); await nextTick(); await nextTick() }

it('does not let a late old-client response replace the new registry', async () => {
  let resolve!: (value: AgentRegistryReadout) => void
  const source = shallowRef(client(() => new Promise(done => { resolve = done })))
  let state!: ReturnType<typeof useAgentRegistryReadout>
  app = createApp({ setup() { state = useAgentRegistryReadout(() => source.value); return () => h('div') } })
  app.mount(document.body.appendChild(document.createElement('div')))
  source.value = client(async () => answer('new'))
  await flush()
  resolve(answer('old'))
  await flush()
  expect(state.readout.value?.defaultAgentId).toBe('new')
})

it('discards reads after unmount and allows explicit retry after read failure', async () => {
  let resolve!: (value: AgentRegistryReadout) => void
  const read = vi.fn<AgentRegistryClient['read']>().mockRejectedValueOnce(new Error('unavailable'))
    .mockImplementationOnce(() => new Promise(done => { resolve = done }))
  const port = client(read)
  let state!: ReturnType<typeof useAgentRegistryReadout>
  app = createApp({ setup() { state = useAgentRegistryReadout(() => port); return () => h('div') } })
  app.mount(document.body.appendChild(document.createElement('div')))
  await flush()
  expect(state.loadState.value).toBe('unreadable')
  const retry = state.load()
  app.unmount()
  resolve(answer('late'))
  await retry
  expect(state.readout.value).toBeNull()
  await state.load()
  expect(read).toHaveBeenCalledTimes(2)
})
