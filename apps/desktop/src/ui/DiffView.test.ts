import { describe, expect, it } from 'vitest'
import { createApp, type App as VueApp } from 'vue'
import DiffView from './DiffView.vue'

const mounted: VueApp[] = []

function mountDiff(props: { current: string; history: string; historyTime?: string }): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(DiffView, props)
  app.mount(host)
  mounted.push(app)
  return host
}

describe('DiffView', () => {
  it('emits restore', () => {
    const host = mountDiff({ current: 'a', history: 'b' })
    let restored = false
    host.querySelector<HTMLButtonElement>('.btn-diff-restore')?.addEventListener('click', () => {
      restored = true
    })
    host.querySelector<HTMLButtonElement>('.btn-diff-restore')?.click()
    expect(restored).toBe(true)
  })

  it('emits close', () => {
    const host = mountDiff({ current: 'a', history: 'b' })
    let closed = false
    host.querySelector<HTMLButtonElement>('.diff-close')?.addEventListener('click', () => {
      closed = true
    })
    host.querySelector<HTMLButtonElement>('.diff-close')?.click()
    expect(closed).toBe(true)
  })
})