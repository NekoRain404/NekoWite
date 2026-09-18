/**
 * The dropdown that replaced the native `<select>`.
 *
 * The point of the component is that the popup is in the DOM, so the two
 * things worth pinning are the ones the native element got for free: the
 * keyboard (open, walk, jump, commit, cancel-without-committing, leave) and
 * the wiring a screen reader reads it through (`combobox` → `listbox`, with
 * `aria-activedescendant` naming the row the arrows are on, since focus never
 * leaves the trigger).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type App as VueApp } from 'vue'
import SelectMenu from './SelectMenu.vue'
import type { SelectOption } from './SelectMenu.vue'

const OPTIONS: SelectOption[] = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Bravo', disabled: true },
  { value: 'c', label: 'Charlie' },
]

let mounted: VueApp[] = []

afterEach(() => {
  for (const app of mounted) app.unmount()
  mounted = []
  document.body.innerHTML = ''
})

/**
 * Mount the component where the app mounts it.
 *
 * `shell` is `AppShell.vue`'s element: the one that carries the user's appearance (the four
 * `data-*` axes and the eight inline `--app-*` properties), and therefore the element the popup is
 * teleported into. A case that leaves it off is mounting into a page the product does not have —
 * which is worth one case of its own, for the fallback, and not for the rest.
 */
function mount(
  options: { value?: string | number, attrs?: Record<string, unknown>, shell?: boolean } = {},
) {
  // The app's own shape: `.shell` is the element the appearance is published on, and 21 of the 22
  // call sites put the component inside a `<label for>` that names it — a caption the label makes
  // clickable.
  const shell = document.createElement('div')
  if (options.shell === true) {
    shell.className = 'shell'
    shell.dataset.theme = 'dark'
    shell.style.setProperty('--app-text', '#e8f3e2')
  }
  document.body.appendChild(shell)
  const host = options.shell === true ? document.createElement('label') : shell
  if (options.shell === true) {
    host.setAttribute('for', 'test-menu')
    shell.appendChild(host)
  }
  const model = ref<string | number>(options.value ?? 'a')
  const app = createApp({
    setup: () => () => h(SelectMenu, {
      id: 'test-menu',
      modelValue: model.value,
      options: OPTIONS,
      'onUpdate:modelValue': (value: string | number) => {
        model.value = value
      },
      ...options.attrs,
    }),
  })
  app.mount(host)
  mounted.push(app)
  return model
}

const trigger = (): HTMLButtonElement => document.body.querySelector<HTMLButtonElement>('.select-trigger')!
const popup = (): HTMLElement | null => document.body.querySelector<HTMLElement>('.select-popup')

function rows(): HTMLButtonElement[] {
  return [...document.body.querySelectorAll<HTMLButtonElement>('.select-option')]
}

function rowByValue(value: string): HTMLButtonElement {
  const row = rows().find((candidate) => candidate.dataset.value === value)
  expect(row, `option ${value}`).toBeDefined()
  return row!
}

/** The row the keyboard is on, read the way a screen reader reads it. */
function activeLabel(): string | undefined {
  const id = trigger().getAttribute('aria-activedescendant')
  if (!id) return undefined
  return document.getElementById(id)?.textContent?.trim()
}

async function press(key: string): Promise<void> {
  // Focused, because that is the only state in which a keydown reaches a
  // button — and it is what the Escape case asserts is still true afterwards.
  trigger().focus()
  trigger().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  await nextTick()
}

describe('SelectMenu', () => {
  it('shows the chosen value and offers no native select at all', () => {
    mount({ value: 'c' })
    expect(trigger().textContent?.trim()).toBe('Charlie')
    // The whole reason the component exists: nothing here can fall back to the
    // OS-drawn popup.
    expect(document.body.querySelector('select')).toBeNull()
  })

  it('falls back to the raw value when nothing in the list carries it', () => {
    // A directory filter whose directory has since gone still has to say
    // something rather than render blank.
    mount({ value: 'docs/gone' })
    expect(trigger().textContent?.trim()).toBe('docs/gone')
  })

  it('names the listbox from the trigger and keeps the label association', async () => {
    mount()
    expect(trigger().id).toBe('test-menu')
    expect(trigger().getAttribute('aria-controls')).toBe('test-menu-list')
    await press('Enter')
    expect(popup()?.id).toBe('test-menu-list')
    expect(popup()?.getAttribute('role')).toBe('listbox')
  })

  it('opens on Enter, marks the selected row and moves by arrows', async () => {
    mount({ value: 'a' })
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(popup()).toBeNull()

    await press('Enter')
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    expect(popup()).not.toBeNull()
    expect(rows().map((row) => row.getAttribute('role'))).toEqual(['option', 'option', 'option'])
    expect(rowByValue('a').getAttribute('aria-selected')).toBe('true')
    expect(rowByValue('c').getAttribute('aria-selected')).toBe('false')
    expect(activeLabel()).toBe('Alpha')

    // Bravo is disabled: the arrows step over it, so the next stop is Charlie.
    await press('ArrowDown')
    expect(activeLabel()).toBe('Charlie')
    await press('ArrowDown')
    expect(activeLabel()).toBe('Alpha')
    await press('ArrowUp')
    expect(activeLabel()).toBe('Charlie')
  })

  it('jumps to either end with Home and End', async () => {
    mount({ value: 'a' })
    await press('Enter')
    await press('End')
    expect(activeLabel()).toBe('Charlie')
    await press('Home')
    expect(activeLabel()).toBe('Alpha')
  })

  it('commits the row the arrows are on, and closes on the way out', async () => {
    const model = mount({ value: 'a' })
    await press('Enter')
    await press('ArrowDown')
    await press('Enter')

    expect(model.value).toBe('c')
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(trigger().textContent?.trim()).toBe('Charlie')
    // The exit owns the element for its one rung; it must not outlive it.
    await vi.waitFor(() => expect(popup()).toBeNull())
  })

  it('cancels on Escape without committing', async () => {
    const model = mount({ value: 'a' })
    await press('Enter')
    await press('ArrowDown')
    await press('Escape')

    expect(model.value).toBe('a')
    await nextTick()
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger())
  })

  it('closes on Tab and leaves the browser to move focus on', async () => {
    mount({ value: 'a' })
    await press('Enter')
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    trigger().dispatchEvent(tab)
    await nextTick()

    // Not swallowed: the popup is teleported out of the host's subtree and
    // its rows are not tabbable, so the next stop is the field after this one.
    expect(tab.defaultPrevented).toBe(false)
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
  })

  it('opens upward-compatible: ArrowDown opens the list too, Space as well', async () => {
    mount({ value: 'a' })
    await press('ArrowDown')
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    await press('Escape')
    await press(' ')
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
  })

  it('picks a row with the pointer and dismisses on a click outside', async () => {
    const model = mount({ value: 'a' })
    await press('Enter')
    rowByValue('c').click()
    expect(model.value).toBe('c')

    await press('Enter')
    expect(popup()).not.toBeNull()
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await nextTick()
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
  })

  it('announces a disabled row but refuses to take it', async () => {
    const model = mount({ value: 'a' })
    await press('Enter')
    const disabled = rowByValue('b')
    expect(disabled.getAttribute('aria-disabled')).toBe('true')
    // `aria-disabled` rather than `disabled`, so the row is still read out.
    expect(disabled.hasAttribute('disabled')).toBe(false)

    disabled.click()
    await nextTick()
    expect(model.value).toBe('a')
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
  })

  it('stages the enter from the closed look, then drops the starting class', async () => {
    mount({ value: 'a' })
    await press('Enter')
    // `<Transition>` inserts the popup already carrying -enter-from, which is
    // the value the open transition travels away from. What the classes cost is
    // the stylesheet's business — and the global prefers-reduced-motion rule is
    // what shortens them — so all that is pinned here is that they are staged.
    expect(popup()?.className).toContain('select-popup-enter-from')
    await vi.waitFor(() =>
      expect(popup()?.className).not.toContain('select-popup-enter-from'),
    )
  })

  it('renders the popup inside the element that carries the appearance', async () => {
    mount({ value: 'a', shell: true })
    await press('Enter')

    // The popup is teleported — it has to be, so that no ancestor can become the containing block
    // of a `position: fixed` box and answer its coordinates from somewhere else — but *where* it is
    // teleported to is the whole of this case. `.shell` is `AppShell.vue`'s element and the only
    // place `data-theme` and the inline `--app-*` properties live; `body` is outside it, which is
    // why every popup in the app used to draw `palettes.css`'s light `:root` block in a dark theme.
    const shell = document.body.querySelector('.shell')
    expect(shell).not.toBeNull()
    expect(popup()?.parentElement).toBe(shell)
    expect(popup()?.parentElement).not.toBe(document.body)
    // And not in the host's own subtree either: the call site wraps the trigger in a `<label for>`,
    // whose activation behaviour would forward a press on the popup's own padding to the control it
    // names, closing the list it was pressed inside (measured in Chromium — the reason the popup is
    // not simply rendered where it is written).
    const label = trigger().closest('label')
    expect(label, 'the host wrapped the trigger in a label').not.toBeNull()
    expect(label?.contains(popup())).toBe(false)
  })

  it('falls back to the body on a page that has no shell', async () => {
    // The pet window's page is the shape: it publishes the appearance on the document element
    // (`pet-page-appearance.ts`), so everything under `body` there is inside the scope — and a
    // `Teleport` aimed at a selector that matched nothing would render *nothing* rather than an
    // unthemed popup. This is the case that says the fallback is deliberate.
    mount({ value: 'a' })
    await press('Enter')
    expect(popup()?.parentElement).toBe(document.body)
  })

  it('writes the measured placement onto the popup as inline coordinates', async () => {
    mount({ value: 'a' })
    await press('Enter')

    // The placement is measured in `use-select-placement.ts` and comes back as a ref *nested* in
    // that composable's return value, which a template does not unwrap: reading
    // `placement.pos.left` rather than `placement.pos.value.left` binds the string `undefinedpx`,
    // which is not a value, so the property is dropped and the list draws wherever the teleport
    // left it — at no trigger's edge, and with the whole of the placement code still exercised.
    // This is the case that ties the two files together, and nothing else in this suite sees it.
    const style = popup()!.style
    // The pad from the left edge, and the four pixels below the control: happy-dom lays nothing
    // out, so the control is at the origin and these are the placement's own two numbers.
    expect(style.left).toBe('8px')
    expect(style.top).toBe('4px')
    // Its floor, for a control narrower than a list can usefully be — and its ceiling, which is the
    // window's room and is what a `max-width` in the stylesheet used to answer instead.
    expect(style.minWidth).toBe('180px')
    expect(style.maxWidth).toBe(`${window.innerWidth - 16}px`)
  })

  it('carries the host attributes onto the trigger', () => {
    // class / title / aria-label / disabled are not props: the trigger is a
    // real button, so they fall through to it and behave as they always did.
    // The closed control's whole look comes from that class — `.input`,
    // `.graph-select`, `.chat-session-select` — so it has to land here.
    mount({ attrs: { class: 'input', title: 'Pick one', 'aria-label': 'Language', disabled: true } })
    expect(trigger().classList.contains('input')).toBe(true)
    expect(trigger().classList.contains('select-trigger')).toBe(true)
    expect(trigger().getAttribute('title')).toBe('Pick one')
    expect(trigger().getAttribute('aria-label')).toBe('Language')
    expect(trigger().disabled).toBe(true)
  })
})
