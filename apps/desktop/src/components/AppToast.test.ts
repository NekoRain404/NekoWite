import { beforeEach, describe, expect, it } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import AppToast from './AppToast.vue'
import { notifyRecovery } from '../services/errors'
import type { RecoveryPrompt } from '../services/errors'
import { t } from '../i18n'
function prompt(name: string, log: string[]): RecoveryPrompt {
  return {
    message: name,
    onRestore: () => log.push(`${name}:restore`),
    onDismiss: () => log.push(`${name}:dismiss`),
  }
}

let app: VueApp | null = null

function mount(): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(AppToast)
  app.mount(host)
  return host
}

function clickButton(host: HTMLElement, label: string): void {
  const target = [...host.querySelectorAll('button')].find((b) =>
    (b.textContent ?? '').includes(label),
  )
  target?.click()
}

async function settle(): Promise<void> {
  await nextTick()
  await nextTick()
}
describe('AppToast recovery prompts', () => {
  beforeEach(() => {
    app?.unmount()
    app = null
    document.body.innerHTML = ''
  })

  it('queues a second prompt instead of dropping the first', async () => {
    // There is ONE slot. A second prompt used to overwrite the first without
    // settling it, so the first one's callbacks never ran - and one of those
    // callbacks is the vault switch's, whose promise the switch awaits. A
    // recovery notice arriving at the wrong moment made "open folder" do nothing
    // at all, with no error and no progress.
    const log: string[] = []
    const host = mount()
    notifyRecovery(prompt('first', log))
    notifyRecovery(prompt('second', log))
    await settle()

    expect(host.textContent).toContain('first')
    expect(host.textContent).not.toContain('second')

    clickButton(host, t('toast.restore'))
    await settle()

    expect(log).toContain('first:restore')
    expect(host.textContent).toContain('second')
  })

  it('still settles a single prompt normally', async () => {
    const log: string[] = []
    const host = mount()
    notifyRecovery(prompt('only', log))
    await settle()
    expect(host.textContent).toContain('only')

    clickButton(host, t('toast.restore'))
    await settle()
    expect(log).toEqual(['only:restore'])
  })
})