import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'

const citeOrder = vi.hoisted(() => new Map<string, number>())

vi.mock('@nekowite/editor-core', () => ({
  computeCiteOrder: () => citeOrder,
  doiUrl: (doi: string) => `https://doi.org/${doi}`,
  CITE_UNRESOLVED: 0,
}))
vi.mock('../features/editor/sessionManager', () => ({
  editorSessionManager: {
    getView: () => ({}),
    getActiveEditor: () => null,
    subscribe: () => () => {},
  },
}))

import ReferencesPanel from './ReferencesPanel.vue'
import { useRefsStore } from '../stores/refs'
import { t } from '../i18n'
import type { Reference } from '../services/refs'

let pinia: Pinia
let mounted: VueApp[] = []

function mountPanel(): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(ReferencesPanel)
  app.use(pinia)
  app.mount(host)
  mounted.push(app)
  return host
}

function seed(key: string, ref: Reference): void {
  useRefsStore().refs.set(key, ref)
}

const base: Omit<Reference, 'key'> = { title: '', authors: [], year: '', type: '' }

describe('ReferencesPanel', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    document.body.innerHTML = ''
    mounted = []
    citeOrder.clear()
  })

  afterEach(() => {
    for (const app of mounted) app.unmount()
  })

  it('says an entry with an empty title is in the library instead of calling it missing', () => {
    citeOrder.set('ris-without-title', 1)
    seed('ris-without-title', { ...base, key: 'ris-without-title', authors: ['Smith, John'] })
    const host = mountPanel()
    expect(host.querySelector('.refs-missing')).toBeNull()
    expect(host.querySelector('.refs-no-title')?.textContent?.trim()).toBe(t('references.noTitle'))
  })

  it('reports a key the library does not hold, without a bibliography number', () => {
    citeOrder.set('ghost2020', 0)
    const host = mountPanel()
    expect(host.querySelector('.refs-missing')?.textContent?.trim()).toBe(t('references.missing'))
    // The chip in the document shows `[?]` for this key, so the panel must not
    // claim a number the document does not use.
    expect(host.querySelector('.refs-num')?.textContent?.trim()).toBe('[?]')
  })

  it('shows the entry detail when there is a title', () => {
    citeOrder.set('smith2020', 1)
    seed('smith2020', { ...base, key: 'smith2020', title: 'A Great Paper', year: '2020' })
    const host = mountPanel()
    expect(host.textContent).toContain('A Great Paper')
    expect(host.querySelector('.refs-missing')).toBeNull()
    expect(host.querySelector('.refs-no-title')).toBeNull()
  })
})