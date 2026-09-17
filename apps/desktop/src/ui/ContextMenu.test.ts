import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, ref, type App as VueApp } from 'vue'
import ContextMenu from './ContextMenu.vue'
import type { ContextMenuItem } from './ContextMenu.vue'

/**
 * Focus handling around the menu.
 *
 * The menu deliberately takes focus into its first item when it opens — that is
 * what makes the arrow keys and Enter work without a mouse. What it must NOT do
 * is leave the user nowhere when it closes: without restoring, Escape drops
 * focus to `<body>`, so the next Tab starts from the top of the app and the
 * keyboard user has lost the card (or row) they were working on.
 */

const ITEMS: ContextMenuItem[] = [
  { id: 'open', label: 'Open' },
  { id: 'rename', label: 'Rename' },
]

let mounted: VueApp[] = []

/** happy-dom resolves focus synchronously; the tick flushes the mount/unmount. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  for (const app of mounted) app.unmount()
  mounted = []
  document.body.innerHTML = ''
})

/**
 * A host with something focusable ("the card"), the menu, and a select handler
 * the test can swap — including one that moves focus somewhere else, which is
 * what picking "rename" does in the note list.
 *
 * `shell` is `AppShell.vue`'s element: the one that carries the user's appearance (the four
 * `data-*` axes and the eight inline `--app-*` properties), and therefore the element the menu is
 * rendered into. A case that leaves it off is mounting into a page the product does not have —
 * worth one case of its own, for the fallback, and not for the rest.
 */
function mountHost(options: { shell?: boolean } = {}) {
  const shell = document.createElement('div')
  if (options.shell === true) {
    shell.className = 'shell'
    shell.dataset.theme = 'dark'
    shell.style.setProperty('--app-text', '#e8f3e2')
  }
  document.body.appendChild(shell)
  const host = document.createElement('div')
  shell.appendChild(host)
  const open = ref(false)
  const card = ref<HTMLButtonElement | null>(null)
  const other = ref<HTMLButtonElement | null>(null)
  let onSelect: (id: string) => void = () => {}

  const app = createApp({
    setup: () => () =>
      h('div', [
        h('button', { id: 'card', ref: card }, 'card'),
        h('button', { id: 'other', ref: other }, 'other'),
        open.value
          ? h(ContextMenu, {
              x: 10,
              y: 10,
              items: ITEMS,
              onSelect: (id: string) => onSelect(id),
              onClose: () => {
                open.value = false
              },
            })
          : null,
      ]),
  })
  app.mount(host)
  mounted.push(app)

  async function showMenu(): Promise<void> {
    open.value = true
    await nextTick()
    await tick()
  }

  return { open, card, other, showMenu, setSelect: (fn: (id: string) => void) => { onSelect = fn } }
}

function menuItem(label: string): HTMLButtonElement {
  const item = [...document.body.querySelectorAll<HTMLButtonElement>('.ctx-menu-item')].find(
    (b) => b.querySelector('.ctx-menu-label')?.textContent?.trim() === label,
  )
  expect(item, `context menu item ${label}`).toBeDefined()
  return item!
}

describe('ContextMenu focus', () => {
  it('returns focus to whatever had it before the menu opened, on Escape', async () => {
    const panel = mountHost()
    await nextTick()
    panel.card.value!.focus()
    expect(document.activeElement).toBe(panel.card.value)

    await panel.showMenu()
    // Opening moves focus into the menu — the arrow keys and Enter rely on it.
    expect(document.activeElement?.classList.contains('ctx-menu-item')).toBe(true)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    await tick()

    expect(document.querySelector('.ctx-menu')).toBeNull()
    // Not `<body>`: the card the user right-clicked gets the focus back.
    expect(document.activeElement).toBe(panel.card.value)
  })

  it('returns focus to that element when an item is picked too', async () => {
    const panel = mountHost()
    await nextTick()
    panel.card.value!.focus()

    await panel.showMenu()
    menuItem('Open').click()
    await nextTick()
    await tick()

    expect(document.querySelector('.ctx-menu')).toBeNull()
    expect(document.activeElement).toBe(panel.card.value)
  })

  it('does not steal focus back from wherever the selection sent it', async () => {
    // Picking "rename" replaces the menu with an inline input (or opens a
    // dialog). Restoring the pre-menu element unconditionally would take focus
    // straight back out of the field the user is now typing in.
    const panel = mountHost()
    await nextTick()
    panel.card.value!.focus()
    panel.setSelect(() => panel.other.value!.focus())

    await panel.showMenu()
    menuItem('Rename').click()
    await nextTick()
    await tick()

    expect(document.querySelector('.ctx-menu')).toBeNull()
    expect(document.activeElement).toBe(panel.other.value)
  })
})

describe('where the menu is rendered', () => {
  /**
   * The menu used to be teleported to `body`, which is *outside* `.shell` — the one element
   * `AppShell.vue:285-292` puts the user's appearance on (the four `data-*` axes and the eight
   * inline `--app-*` properties). So a right click on a tab, measured in a dark `forest` window,
   * drew `color(srgb 0.998431 0.994353 0.982275)` on `--app-elevated: #fffefb` with the light
   * border, the light shadow and `system-ui` on its rows.
   */
  it('renders inside the element that carries the appearance', async () => {
    const panel = mountHost({ shell: true })
    await nextTick()
    await panel.showMenu()

    const shell = document.body.querySelector('.shell')
    expect(shell).not.toBeNull()
    expect(document.querySelector('.ctx-menu')?.parentElement).toBe(shell)
    expect(document.querySelector('.ctx-menu')?.parentElement).not.toBe(document.body)
  })

  it('falls back to the body on a page that has no shell', async () => {
    // The pet window's page is the shape: it publishes the appearance on the document element
    // (`pet-page-appearance.ts`), so everything under `body` there is inside the scope — and a
    // `Teleport` aimed at a selector that matched nothing would render *nothing* rather than an
    // unthemed menu. This is the case that says the fallback is deliberate.
    const panel = mountHost()
    await nextTick()
    await panel.showMenu()

    expect(document.querySelector('.ctx-menu')?.parentElement).toBe(document.body)
  })
})
