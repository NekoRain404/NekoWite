import { describe, expect, it } from 'vitest'
import { createApp, type App as VueApp } from 'vue'
import TemplatePicker from './TemplatePicker.vue'
import type { TemplateEntry } from '../services/noteTemplates'
import { t } from '../i18n'

interface Received {
  select: TemplateEntry[]
  close: number
}

function mountPi(
  templates: TemplateEntry[],
): { host: HTMLElement; app: VueApp; received: Received } {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const received: Received = { select: [], close: 0 }
  const app = createApp(TemplatePicker, {
    templates,
    onSelect: (e: TemplateEntry) => received.select.push(e),
    onClose: () => {
      received.close += 1
    },
  })
  app.mount(host)
  return { host, app, received }
}

function overlayEl(host: HTMLElement): HTMLElement {
  const el = host.querySelector('.dialog-overlay')
  if (!el) throw new Error('overlay not found')
  return el as HTMLElement
}

const TEMPLATES: TemplateEntry[] = [
  { name: 'daily', path: 'templates/daily.md' },
  { name: 'meeting', path: 'templates/meeting.md' },
]

describe('TemplatePicker', () => {
  it('renders each template name as a selectable option', () => {
    const { host, app } = mountPi(TEMPLATES)
    try {
      const options = [...host.querySelectorAll('button.template-option')]
      expect(options.map((b) => b.querySelector('.template-name')?.textContent?.trim())).toEqual(['daily', 'meeting'])
    } finally {
      app.unmount()
      host.remove()
    }
  })

  it('emits select with the template entry when an option is clicked', () => {
    const { host, app, received } = mountPi(TEMPLATES)
    try {
      const options = [...host.querySelectorAll<HTMLButtonElement>('button.template-option')]
      options[1].click()
      expect(received.select).toEqual([{ name: 'meeting', path: 'templates/meeting.md' }])
      expect(received.close).toBe(0)
    } finally {
      app.unmount()
      host.remove()
    }
  })

  it('emits close when the overlay backdrop is clicked', () => {
    const { host, app, received } = mountPi(TEMPLATES)
    try {
      overlayEl(host).dispatchEvent(new MouseEvent('click', { bubbles: true }))
      expect(received.close).toBe(1)
      expect(received.select.length).toBe(0)
    } finally {
      app.unmount()
      host.remove()
    }
  })

  it('emits close on Escape', () => {
    const { host, app, received } = mountPi(TEMPLATES)
    try {
      overlayEl(host).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      expect(received.close).toBe(1)
    } finally {
      app.unmount()
      host.remove()
    }
  })

  it('labels built-in templates with a friendly source instead of the internal path', () => {
    const { host, app } = mountPi([{ name: '每日日记', path: 'builtin:daily' }])
    try {
      const pathText = host.querySelector('.template-path')?.textContent?.trim()
      expect(pathText).toBe(t('template.builtin'))
    } finally {
      app.unmount()
      host.remove()
    }
  })

  it('shows an empty hint and no options when there are no templates', () => {
    const { host, app } = mountPi([])
    try {
      expect(host.querySelector('.template-empty')).toBeTruthy()
      expect(host.querySelector('button.template-option')).toBeNull()
    } finally {
      app.unmount()
      host.remove()
    }
  })
})
