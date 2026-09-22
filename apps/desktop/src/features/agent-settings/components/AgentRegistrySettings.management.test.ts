import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import AgentRegistrySettings from './AgentRegistrySettings.vue'
import type { AgentRegistryClient, AgentRegistryEntry } from '../services/agent-registry-policy'

const entry: AgentRegistryEntry = {
  agentId: 'custom', displayName: 'Custom', source: 'external', program: '/usr/bin/custom',
  args: ['acp'], env: 'user-environment', envExtra: [], enabled: true,
  adapterId: 'generic-acp', reportedVersion: null, programState: 'launchable',
}
const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))
async function mount(running = false) {
  let entries = [entry]
  const deleteAgent = vi.fn(async () => { entries = []; return null })
  const client: AgentRegistryClient = {
    read: async () => ({ defaultAgentId: 'opencode', entries, adapterIds: ['generic-acp'],
      runningAgentIds: running ? ['custom'] : [], profileOwners: { default: 'opencode' } }),
    add: vi.fn(async () => null), setEnabled: vi.fn(async () => null), delete: deleteAgent,
  }
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(AgentRegistrySettings, { client, profileId: 'default' })
  app.mount(host)
  cleanups.push(() => { app.unmount(); host.remove() })
  await nextTick(); await nextTick()
  return { host, client, deleteAgent }
}
async function click(host: HTMLElement, selector: string) {
  const button = host.querySelector<HTMLButtonElement>(selector)
  expect(button).not.toBeNull()
  button!.click()
  await nextTick(); await nextTick(); await nextTick()
}
describe('Agent registration management', () => {
  it('retains the registration and allows retry after deletion fails', async () => {
    const { host, deleteAgent } = await mount()
    deleteAgent.mockRejectedValueOnce(new Error('disk full'))
    await click(host, '[data-test="registry-delete-custom"]')
    await click(host, '[data-test="registry-confirm-delete"]')
    expect(host.querySelector('[data-test="registry-row-custom"]')).not.toBeNull()
    expect(host.querySelector('[data-test="registry-action-failed"]')).not.toBeNull()
    await click(host, '[data-test="registry-confirm-delete"]')
    expect(deleteAgent).toHaveBeenCalledTimes(2)
  })
  it('suggests an unused ID without replacing a manually edited ID', async () => {
    const { host } = await mount()
    const set = async (field: string, value: string) => {
      const input = host.querySelector<HTMLInputElement>(`[data-test="registry-field-${field}"]`)!
      input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); await nextTick()
    }
    await set('displayName', 'Custom')
    expect(host.querySelector<HTMLInputElement>('[data-test="registry-field-agentId"]')!.value).toBe('custom-2')
    await set('agentId', 'my-agent')
    await set('displayName', 'Different Name')
    expect(host.querySelector<HTMLInputElement>('[data-test="registry-field-agentId"]')!.value).toBe('my-agent')
  })
  it('requires confirmation and refreshes after persistent deletion', async () => {
    const { host, deleteAgent } = await mount()
    await click(host, '[data-test="registry-delete-custom"]')
    expect(deleteAgent).not.toHaveBeenCalled()
    await click(host, '[data-test="registry-confirm-delete"]')
    expect(deleteAgent).toHaveBeenCalledWith('custom')
    expect(host.querySelector('[data-test="registry-row-custom"]')).toBeNull()
  })
  it('cancels deletion without calling the backend', async () => {
    const { host, deleteAgent } = await mount()
    await click(host, '[data-test="registry-delete-custom"]')
    await click(host, '[data-test="registry-cancel-delete"]')
    expect(deleteAgent).not.toHaveBeenCalled()
    expect(host.querySelector('[data-test="registry-confirm-delete"]')).toBeNull()
  })
  it('disables deletion while the engine is running', async () => {
    const { host } = await mount(true)
    expect(host.querySelector<HTMLButtonElement>('[data-test="registry-delete-custom"]')?.disabled).toBe(true)
  })
  it('selects the generic ACP adapter for a new registration', async () => {
    const { host } = await mount()
    expect(host.querySelector<HTMLSelectElement>('[data-test="registry-field-adapter"]')?.value).toBe('generic-acp')
  })
})
