import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, shallowRef, type App } from 'vue'
import { setLocale } from '../../../i18n'
import AgentPermissionEditor from './AgentPermissionEditor.vue'
import type { AgentConfigClient, AgentConfigReadout, AgentConfigEditOutcome } from '../services/agent-config-ipc'

let app: App | undefined
const readout: AgentConfigReadout = { state: 'document', document: {
  path: 'opencode.jsonc', resolved: '/profile/opencode.jsonc', revision: 'r1', exists: true,
  text: '{}', editable: true, permissionRules: { kind: 'object', rules: { edit: 'ask', bash: null } },
} }
const flush = async () => { for (let i = 0; i < 8; i++) { await Promise.resolve(); await nextTick() } }
const element = (name: string) => document.querySelector<HTMLElement>(`[data-test="${name}"]`)
function client(): AgentConfigClient {
  return { read: vi.fn(async () => readout), edit: vi.fn(async (): Promise<AgentConfigEditOutcome> => ({ status: 'written', revision: 'r2' })) }
}
async function mount(port: AgentConfigClient, verifiedOpenCode = true) {
  const current = shallowRef(port)
  app = createApp({ render: () => h(AgentPermissionEditor, { client: current.value, verifiedOpenCode }) })
  app.mount(document.body.appendChild(document.createElement('div')))
  await flush()
  return current
}
async function change() {
  const select = element('permission-editor-edit') as HTMLSelectElement
  select.value = 'deny'
  select.dispatchEvent(new Event('change', { bubbles: true }))
  await flush()
}
beforeEach(() => { setLocale('en') })
afterEach(() => { app?.unmount(); document.body.innerHTML = '' })

describe('permission editor', () => {
  it('writes only changed scalar rules and reports restart required', async () => {
    const port = client()
    await mount(port)
    expect(element('permission-editor-bash')).toBeNull()
    await change()
    element('permission-editor-save')?.click()
    await flush()
    expect(port.edit).toHaveBeenCalledWith('opencode.jsonc', 'r1', [{ path: ['permission', 'edit'], value: 'deny' }])
    expect(element('permission-editor-saved')?.textContent).toContain('Restart')
    expect(document.body.textContent).toContain('Temporary ACP grants')
    element('permission-editor-reload')?.click()
    await flush()
    expect(element('permission-editor-saved')?.textContent).toContain('Restart')
  })
  it('blocks repeated writes after conflict until explicit reload', async () => {
    const port = client()
    vi.mocked(port.edit).mockResolvedValue({ status: 'conflict', current: null })
    await mount(port)
    await change()
    element('permission-editor-save')?.click()
    await flush()
    expect(element('permission-editor-conflict')).not.toBeNull()
    expect((element('permission-editor-save') as HTMLButtonElement).disabled).toBe(true)
    element('permission-editor-reload')?.click()
    await flush()
    expect(port.read).toHaveBeenCalledTimes(2)
  })
  it('keeps draft after a failed write and allows retry', async () => {
    const port = client()
    vi.mocked(port.edit).mockRejectedValue(new Error('disk full'))
    await mount(port)
    await change()
    element('permission-editor-save')?.click()
    await flush()
    expect(element('permission-editor-failed')?.textContent).toContain('disk full')
    expect((element('permission-editor-edit') as HTMLSelectElement).value).toBe('deny')
    expect((element('permission-editor-save') as HTMLButtonElement).disabled).toBe(false)
  })
  it('does not display a stale save result after changing clients', async () => {
    let resolve!: (value: AgentConfigEditOutcome) => void
    const first = client()
    vi.mocked(first.edit).mockReturnValue(new Promise(done => { resolve = done }))
    const current = await mount(first)
    await change()
    element('permission-editor-save')?.click()
    element('permission-editor-save')?.click()
    expect(first.edit).toHaveBeenCalledTimes(1)
    current.value = client()
    await flush()
    resolve({ status: 'written', revision: 'old-client-r2' })
    await flush()
    expect(element('permission-editor-saved')).toBeNull()
    expect((element('permission-editor-edit') as HTMLSelectElement).value).toBe('ask')
  })
  it('ignores a stale read and hides unsupported and readonly editors', async () => {
    let resolve!: (value: AgentConfigReadout) => void
    const first = client()
    vi.mocked(first.read).mockReturnValue(new Promise(done => { resolve = done }))
    const current = await mount(first)
    const second = client()
    vi.mocked(second.read).mockResolvedValue({ state: 'no-document' })
    current.value = second
    await flush()
    resolve(readout)
    await flush()
    expect(element('permission-editor-save')).toBeNull()
    expect(element('permission-editor-readonly')).not.toBeNull()
  })
  it('does not read configuration for unverified adapters', async () => {
    const port = client()
    await mount(port, false)
    expect(port.read).not.toHaveBeenCalled()
    expect(element('permission-editor-unsupported')).not.toBeNull()
    expect(element('permission-editor-save')).toBeNull()
  })
  it('keeps the startup scope visible on reopening without claiming runtime state', async () => {
    await mount(client())
    expect(element('permission-editor-scope')?.textContent).toContain('Agent starts')
    app?.unmount()
    await mount(client())
    expect(element('permission-editor-scope')?.textContent).toContain('Agent starts')
    expect(element('permission-editor-saved')).toBeNull()
  })
})
