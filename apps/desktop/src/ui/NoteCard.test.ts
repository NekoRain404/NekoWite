import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, type App as VueApp } from 'vue'

import NoteCard from './NoteCard.vue'
import type { NoteSummary } from '../services/noteMeta'

let mounted: VueApp[] = []

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
  document.body.innerHTML = ''
})

function note(overrides: Partial<NoteSummary> = {}): NoteSummary {
  return {
    path: 'notes/hello.md',
    name: 'hello',
    title: 'Hello',
    tags: ['a', 'b'],
    summary: 'A short summary.',
    mtime: Date.now(),
    size: 42,
    dir: 'notes',
    links: [],
    ...overrides,
  }
}

function mount(props: Partial<{ note: NoteSummary; active: boolean; favorite: boolean }>, emits: Record<string, unknown>): void {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(NoteCard, { note: note(), active: false, favorite: false, ...props, ...emits } as never)
  app.mount(host)
  mounted.push(app)
}

function cardMain(): HTMLButtonElement {
  return document.body.querySelector<HTMLButtonElement>('.card-main')!
}

function cardStar(): HTMLButtonElement {
  return document.body.querySelector<HTMLButtonElement>('.card-star')!
}

describe('NoteCard', () => {
  it('renders a real open button and a separate favorite button (no nested interactive controls)', () => {
    mount({}, {})
    expect(cardMain()).toBeTruthy()
    expect(cardStar()).toBeTruthy()
    expect(cardMain().tagName).toBe('BUTTON')
    expect(cardStar().tagName).toBe('BUTTON')
    // The favorite button must not be nested inside the open button.
    expect(cardMain().contains(cardStar())).toBe(false)
  })

  it('emits open when the main button is clicked', () => {
    const open = vi.fn()
    mount({}, { onOpen: open })
    cardMain().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith()
  })

  it('emits toggle-favorite (not open) when the star is clicked', () => {
    const open = vi.fn()
    const toggle = vi.fn()
    mount({}, { onOpen: open, onToggleFavorite: toggle })
    cardStar().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(toggle).toHaveBeenCalledTimes(1)
    expect(open).not.toHaveBeenCalled()
  })

  it('does not open when clicking the favorite button (stop propagation)', () => {
    const open = vi.fn()
    mount({}, { onOpen: open })
    cardStar().click()
    expect(open).not.toHaveBeenCalled()
  })
})
