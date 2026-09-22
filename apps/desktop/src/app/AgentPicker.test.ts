import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import AgentPicker from './AgentPicker.vue'
import type { AgentRegistryClient, AgentRegistryReadout } from '../features/agent-settings/services/agent-registry-policy'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))
const flush = async () => { for (let i = 0; i < 8; i++) await nextTick() }
function readout(): AgentRegistryReadout {
  return { defaultAgentId: 'one', adapterIds: ['generic-acp'], runningAgentIds: [], profileOwners: {},
    entries: ['one', 'two', 'disabled'].map(agentId => ({ agentId, displayName: agentId, source: 'external',
      program: '/bin/agent', args: [], env: 'user-environment', envExtra: [], enabled: agentId !== 'disabled',
      adapterId: 'generic-acp', reportedVersion: null, programState: 'launchable' })) }
}
async function mount(busy = false) {
  const read = vi.fn(async () => readout())
  const client: AgentRegistryClient = { read, add: async () => null, delete: async () => null, setEnabled: async () => null }
  const select = vi.fn(); const manage = vi.fn()
  const host = document.createElement('div'); host.className = 'shell'; document.body.append(host)
  const app = createApp(AgentPicker, { client, busy, onSelect: select, onManage: manage })
  app.mount(host)
  cleanups.push(() => { app.unmount(); host.remove() })
  await flush()
  const click = async (selector: string) => { host.querySelector<HTMLButtonElement>(selector)!.click(); await flush() }
  return { host, click, read, select, manage }
}
describe('ACP picker', () => {
  it('refreshes registrations each open and starts the selected enabled agent', async () => {
    const { host, click, read, select } = await mount()
    await click('[data-agent-picker]')
    expect(host.querySelector('[role="menu"]')).not.toBeNull()
    expect(host.querySelector('[data-agent-choice="disabled"]')).toBeNull()
    await click('[data-agent-choice="two"]')
    expect(select).toHaveBeenCalledWith('two')
    expect(host.querySelector('[role="menu"]')).toBeNull()
    await click('[data-agent-picker]')
    expect(read).toHaveBeenCalledTimes(2)
  })
  it('keeps management available while a run prevents switching', async () => {
    const { host, click, select, manage } = await mount(true)
    await click('[data-agent-picker]')
    expect(host.querySelector<HTMLButtonElement>('[data-agent-choice="one"]')!.disabled).toBe(true)
    await click('[data-agent-choice="one"]')
    expect(select).not.toHaveBeenCalled()
    await click('[data-agent-manage]')
    expect(manage).toHaveBeenCalledWith('registry')
  })
  it('offers retry and management after a read failure', async () => {
    const { host, click, read } = await mount()
    read.mockRejectedValueOnce(new Error('unavailable'))
    await click('[data-agent-picker]')
    expect(host.querySelector('[role="alert"]')).not.toBeNull()
    await click('[role="menuitem"]')
    expect(host.querySelector('[data-agent-choice="two"]')).not.toBeNull()
  })
  it('returns focus to the trigger when Escape closes the menu', async () => {
    const { host, click } = await mount()
    await click('[data-agent-picker]')
    host.querySelector('[role="menu"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flush()
    expect(host.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(host.querySelector('[data-agent-picker]'))
  })
})
