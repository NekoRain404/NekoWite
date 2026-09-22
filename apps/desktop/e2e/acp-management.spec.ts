import { expect, test, type Page } from '@playwright/test'

async function mount(page: Page, view: 'picker' | 'registry' | 'permissions') {
  await page.goto('/')
  await page.evaluate(async (view) => {
    const source = await (await fetch('/src/main.ts')).text()
    const vueUrl = source.match(/["']([^"']*\/deps\/vue\.js[^"']*)["']/)?.[1]
    if (!vueUrl) throw new Error('Vue dependency unavailable')
    const vue = await import(/* @vite-ignore */ vueUrl)
    const urls = {
      picker: '/src/app/AgentPicker.vue',
      registry: '/src/features/agent-settings/components/AgentRegistrySettings.vue',
      permissions: '/src/features/agent-settings/components/AgentPermissionEditor.vue',
    }
    const component = (await import(/* @vite-ignore */ urls[view])).default
    const shell = document.querySelector<HTMLElement>('.shell')!
    const host = document.createElement('div')
    host.dataset.test = 'acp-browser-host'
    host.style.cssText = 'position:fixed;inset:12px 12px 12px auto;width:min(480px,calc(100vw - 24px));overflow:auto;z-index:100;background:var(--app-panel);color:var(--app-text);padding:12px;box-sizing:border-box'
    shell.append(host)
    let entries = [
      { agentId: 'opencode', displayName: 'OpenCode', source: 'bundled' },
      { agentId: 'claude', displayName: 'Claude Agent', source: 'external' },
      { agentId: 'custom', displayName: 'Custom ACP', source: 'external' },
    ].map(entry => ({ ...entry, program: `/usr/local/bin/${entry.agentId}`, args: ['acp'],
      env: 'user-environment', envExtra: [], enabled: true, adapterId: 'generic-acp',
      reportedVersion: null, programState: 'launchable' }))
    const registry = {
      read: async () => ({ defaultAgentId: 'opencode', entries, adapterIds: ['generic-acp', 'opencode'], runningAgentIds: [], profileOwners: {} }),
      add: async () => null, setEnabled: async () => null,
      delete: async (id: string) => { entries = entries.filter(entry => entry.agentId !== id); return null },
    }
    let revision = '1'
    let action = 'ask'
    const config = {
      read: async () => ({ state: 'document', document: {
        path: 'opencode.jsonc', resolved: '/profiles/default/opencode.jsonc', revision,
        exists: true, editable: true, text: '{}',
        permissionRules: { kind: 'object', rules: { edit: action, bash: 'ask', webfetch: 'deny', read: null } },
      } }),
      edit: async () => { action = 'deny'; revision = '2'; return { status: 'written', revision } },
    }
    vue.createApp(component, view === 'permissions'
      ? { client: config, verifiedOpenCode: true }
      : { client: registry, profileId: 'default', currentAgentId: 'opencode',
          onSelect: (id: string) => { host.dataset.selected = id },
          onManage: (page: string) => { host.dataset.manage = page },
        }).mount(host)
  }, view)
}

for (const width of [1280, 390]) {
  test(`ACP controls remain usable at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 })
    await mount(page, 'picker')
    await page.locator('[data-agent-picker]').click()
    const menu = page.locator('.agent-picker-menu')
    await expect(menu).toBeVisible()
    const bounds = await menu.boundingBox()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
    await page.screenshot({ path: info.outputPath('picker.png') })
    await page.locator('[data-agent-choice="claude"]').click()
    await expect(page.locator('[data-test="acp-browser-host"]')).toHaveAttribute('data-selected', 'claude')
    await page.locator('[data-agent-picker]').click()
    await page.locator('[data-agent-manage]').click()
    await expect(page.locator('[data-test="acp-browser-host"]')).toHaveAttribute('data-manage', 'registry')

    await mount(page, 'registry')
    await page.locator('[data-test="registry-delete-custom"]').click()
    await expect(page.getByRole('alertdialog')).toContainText('Custom ACP')
    await page.screenshot({ path: info.outputPath('registry.png') })
    await page.locator('[data-test="registry-confirm-delete"]').click()
    await expect(page.locator('[data-test="registry-row-custom"]')).toHaveCount(0)
    await expect(page.locator('[data-test="registry-delete-opencode"]')).toBeDisabled()

    await mount(page, 'permissions')
    await page.locator('[data-test="permission-editor-edit"]').selectOption('deny')
    await page.locator('[data-test="permission-editor-save"]').click()
    await expect(page.locator('[data-test="permission-editor-saved"]')).toBeVisible()
    await expect(page.locator('[data-test="permission-editor-read"]')).toHaveCount(0)
    await page.screenshot({ path: info.outputPath('permissions.png') })
    const overflow = await page.locator('[data-test="acp-browser-host"]').evaluate(element => element.scrollWidth > element.clientWidth)
    expect(overflow).toBe(false)
  })
}
