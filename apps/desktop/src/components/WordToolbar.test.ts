import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, type App as VueApp } from 'vue'
import { registerToolbar, unregisterToolbar } from '@nekowite/editor-core'

import WordToolbar from './WordToolbar.vue'
import { t } from '../i18n'

let mounted: VueApp[] = []

beforeEach(() => {
  document.body.innerHTML = ''
})

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
  document.body.innerHTML = ''
})

function mountToolbar(): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(WordToolbar)
  mounted.push(app)
  app.mount(host)
  return host
}

/** The title attribute of every button in the registry (plugin) group. */
function registryTitles(host: HTMLElement): string[] {
  return [...host.querySelectorAll('button[title]')].map((b) => b.getAttribute('title') ?? '')
}

describe('WordToolbar registry items', () => {
  it('localizes a builtin registry button instead of showing its English label', () => {
    // "Table" is registered from editor-core, which has no i18n, so its tooltip
    // shipped in English while every hardcoded button was localized.
    const host = mountToolbar()
    const titles = registryTitles(host)
    expect(titles).toContain(t('command.table.insert'))
    expect(titles).not.toContain('Table')
  })

  it('keeps the registered label for an id that has no message key', () => {
    // Third-party plugin buttons bring their own text and must not be blanked.
    registerToolbar({ id: 'plugin.custom', label: 'Custom Plugin Action', run: () => {} })
    try {
      const host = mountToolbar()
      expect(registryTitles(host)).toContain('Custom Plugin Action')
    } finally {
      unregisterToolbar('plugin.custom')
    }
  })
})
