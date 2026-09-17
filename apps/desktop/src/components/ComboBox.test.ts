/**
 * The editable list: a text input with the app's own list under it.
 *
 * `SelectMenu` is a picker — its value has to be one of its options — and the
 * model field cannot be, because the list is only ever as good as the
 * provider's `/models` endpoint and people paste ids it has never heard of. So
 * what is pinned here is the half that is *not* a picker: what the user types
 * reaches the parent whether or not any row carries it, `Escape` closes
 * without clearing it, and `Enter` with no row open does nothing at all. The
 * ARIA and keyboard wiring is `SelectMenu`'s, and `CommandPalette`'s before
 * it: focus never leaves the input and `aria-activedescendant` names the row
 * the arrows are on.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type App as VueApp } from 'vue'
import ComboBox from './ComboBox.vue'
import { modalStack } from '../services/modal-stack'

const OPTIONS = ['qwen2.5-coder:3b', 'gpt-4o-mini', 'claude-sonnet-4-5']

let mounted: VueApp[] = []

afterEach(() => {
  for (const app of mounted) app.unmount()
  mounted = []
  document.body.innerHTML = ''
  modalStack.resetModalStack()
})

/**
 * Mount the field where the app mounts it.
 *
 * `shell` is `AppShell.vue`'s element: the one that carries the user's appearance (the four
 * `data-*` axes and the eight inline `--app-*` properties), and therefore the element the list is
 * teleported into. A case that leaves it off is mounting into a page the product does not have —
 * which is worth one case of its own, for the fallback, and not for the rest.
 */
function mount(options: { value?: string, options?: readonly string[], attrs?: Record<string, unknown>, shell?: boolean } = {}) {
  const shell = document.createElement('div')
  if (options.shell === true) {
    shell.className = 'shell'
    shell.dataset.theme = 'dark'
    shell.style.setProperty('--app-text', '#e8f3e2')
  }
  document.body.appendChild(shell)
  const host = document.createElement('div')
  shell.appendChild(host)
  const model = ref(options.value ?? '')
  const app = createApp({
    setup: () => () => h(ComboBox, {
      id: 'test-combo',
      modelValue: model.value,
      options: options.options ?? OPTIONS,
      'onUpdate:modelValue': (value: string) => {
        model.value = value
      },
      ...options.attrs,
    }),
  })
  app.mount(host)
  mounted.push(app)
  return model
}

const input = (): HTMLInputElement => document.body.querySelector<HTMLInputElement>('.combo-input')!
const popup = (): HTMLElement | null => document.body.querySelector<HTMLElement>('.combo-popup')

function rows(): HTMLElement[] {
  return [...document.body.querySelectorAll<HTMLElement>('.combo-option')]
}

function rowByValue(value: string): HTMLElement {
  const row = rows().find((candidate) => candidate.dataset.value === value)
  expect(row, `option ${value}`).toBeDefined()
  return row!
}

/** The row the keyboard is on, read the way a screen reader reads it. */
function activeLabel(): string | undefined {
  const id = input().getAttribute('aria-activedescendant')
  if (!id) return undefined
  return document.getElementById(id)?.textContent?.trim()
}

/** Type the way a keyboard does: set the value, then announce it. */
async function type(text: string): Promise<void> {
  const el = input()
  el.focus()
  el.value = text
  el.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}

async function press(key: string): Promise<void> {
  // Focused, because that is the only state a keydown reaches an input from —
  // and it is what the type-ahead case asserts is still true afterwards.
  input().focus()
  input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  await nextTick()
}

describe('ComboBox', () => {
  it('is a text input with no native suggestion list behind it', () => {
    mount({ value: 'gpt-4o-mini' })

    expect(input().value).toBe('gpt-4o-mini')
    expect(input().getAttribute('role')).toBe('combobox')
    expect(input().getAttribute('aria-expanded')).toBe('false')
    // The whole reason the component exists: a `<datalist>` popup is drawn by
    // the engine outside the DOM, and WebKitGTK barely draws one at all.
    expect(input().hasAttribute('list')).toBe(false)
    expect(document.body.querySelector('datalist')).toBeNull()
    expect(popup()).toBeNull()
  })

  it('renders the list inside the element that carries the appearance', async () => {
    mount({ value: 'gpt-4o-mini', shell: true })
    input().click()
    await nextTick()

    // The list is teleported out of the field's subtree — it has to be: `place()` turns a
    // *viewport* rectangle into `left`/`top`, which is only an answer while the containing block
    // is the viewport, and the field's one call site wraps it in a `<label>` that would hand a
    // press on the list's own padding to the input. Where it is teleported *to* is the whole of
    // this case: `.shell` is where `AppShell.vue:285-292` publishes the user's appearance, and
    // `body` is outside it — which is why every one of these lists used to draw the page root's
    // light palette, its `system-ui` and its `ink` accent inside a dark window.
    const shell = document.body.querySelector('.shell')
    expect(shell).not.toBeNull()
    expect(popup()?.parentElement).toBe(shell)
    expect(popup()?.parentElement).not.toBe(document.body)
  })

  it('falls back to the body on a page that has no shell', async () => {
    // The pet window's page is the shape: it publishes the appearance on the document element
    // (`pet-page-appearance.ts`), so everything under `body` there is inside the scope — and a
    // `Teleport` aimed at a selector that matched nothing would render *nothing* rather than an
    // unthemed list. This is the case that says the fallback is deliberate.
    mount({ value: 'gpt-4o-mini' })
    input().click()
    await nextTick()
    expect(popup()?.parentElement).toBe(document.body)
  })

  it('opens on a click with every option, and names the listbox from the input', async () => {
    mount({ value: 'gpt-4o-mini' })
    input().click()
    await nextTick()

    expect(input().getAttribute('aria-expanded')).toBe('true')
    expect(popup()?.id).toBe('test-combo-list')
    expect(popup()?.getAttribute('role')).toBe('listbox')
    expect(input().getAttribute('aria-controls')).toBe('test-combo-list')
    expect(rows().map((row) => row.textContent?.trim())).toEqual(OPTIONS)
    expect(rows().map((row) => row.getAttribute('role'))).toEqual(['option', 'option', 'option'])

    // The highlight starts on the value in the field, not on the first row.
    expect(activeLabel()).toBe('gpt-4o-mini')
    expect(rowByValue('gpt-4o-mini').getAttribute('aria-selected')).toBe('true')
    expect(rowByValue('qwen2.5-coder:3b').getAttribute('aria-selected')).toBe('false')
  })

  it('places the popup against the box the list measured', async () => {
    mount({ value: 'gpt-4o-mini' })
    input().click()

    // jsdom measures every rect as zero, so what lands is the field's own 8px
    // margin and its 4px gap under the anchor — the values the default `pos`
    // (0, 0) never produces. The list is a child component, and this is what
    // pins that its size still crosses back: a measurement that went missing
    // would leave the popup at the origin.
    await vi.waitFor(() => expect(popup()?.style.left).toBe('8px'))
    expect(popup()?.style.top).toBe('4px')
  })

  it('walks the list with the arrows and commits the row they are on', async () => {
    const model = mount({ value: 'gpt-4o-mini' })
    await press('ArrowDown')
    expect(input().getAttribute('aria-expanded')).toBe('true')
    expect(activeLabel()).toBe('gpt-4o-mini')

    await press('ArrowDown')
    expect(activeLabel()).toBe('claude-sonnet-4-5')
    // Wrapping, as a select does.
    await press('ArrowDown')
    expect(activeLabel()).toBe('qwen2.5-coder:3b')
    await press('ArrowUp')
    expect(activeLabel()).toBe('claude-sonnet-4-5')

    await press('Enter')
    expect(model.value).toBe('claude-sonnet-4-5')
    expect(input().value).toBe('claude-sonnet-4-5')
    expect(input().getAttribute('aria-expanded')).toBe('false')
    // The keyboard never left the field, which is what lets the next keystroke
    // edit the value it just committed.
    expect(document.activeElement).toBe(input())
    await vi.waitFor(() => expect(popup()).toBeNull())
  })

  it('keeps focus in the field while the pointer picks a row', async () => {
    const model = mount({ value: 'gpt-4o-mini' })
    input().click()
    await nextTick()
    input().focus()

    // mousedown would move focus to the row (and blur the input) before the
    // click lands, so the row has to refuse it.
    const row = rowByValue('claude-sonnet-4-5')
    const mousedown = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    row.dispatchEvent(mousedown)
    row.click()
    await nextTick()

    expect(mousedown.defaultPrevented).toBe(true)
    expect(model.value).toBe('claude-sonnet-4-5')
    expect(document.activeElement).toBe(input())
  })

  it('closes on Escape without clearing what was typed', async () => {
    const model = mount({ value: 'gpt-4o-mini' })
    await press('ArrowDown')
    expect(popup()).not.toBeNull()

    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    input().dispatchEvent(escape)
    await nextTick()

    // Absorbed, so the dialog behind it does not close as well; the modal-stack
    // claim is what silences the handlers that already ran.
    expect(escape.defaultPrevented).toBe(true)
    expect(input().getAttribute('aria-expanded')).toBe('false')
    expect(input().value).toBe('gpt-4o-mini')
    expect(model.value).toBe('gpt-4o-mini')
    expect(document.activeElement).toBe(input())
  })

  it('closes on Tab and leaves the browser to move focus on', async () => {
    mount({ value: 'gpt-4o-mini' })
    await press('ArrowDown')
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    input().dispatchEvent(tab)
    await nextTick()

    expect(tab.defaultPrevented).toBe(false)
    expect(input().getAttribute('aria-expanded')).toBe('false')
  })

  it('narrows the open list to what is typed, and commits nothing behind it', async () => {
    mount({ value: '' })
    input().click()
    await nextTick()
    expect(rows()).toHaveLength(3)

    await type('claude')
    expect(rows().map((row) => row.textContent?.trim())).toEqual(['claude-sonnet-4-5'])
    expect(activeLabel()).toBe('claude-sonnet-4-5')
  })

  it('takes a model id no row carries, and never opens over it', async () => {
    const model = mount({ value: '' })

    await type('tokenflux/uncensored-72b')

    // The value is the user's, not the list's: the field stays editable and
    // the parent hears about text no option carries.
    expect(model.value).toBe('tokenflux/uncensored-72b')
    // Nothing matches, so there is nothing to draw — and an empty popup is
    // worse than none.
    expect(popup()).toBeNull()
    expect(input().getAttribute('aria-expanded')).toBe('false')

    // Enter with no row highlighted is the page's key, not ours: it must not
    // commit a suggestion the user did not ask for, or swallow a form submit.
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    input().dispatchEvent(enter)
    await nextTick()
    expect(enter.defaultPrevented).toBe(false)
    expect(model.value).toBe('tokenflux/uncensored-72b')
  })

  it('offers nothing at all when the list is empty', async () => {
    mount({ options: [] })
    input().click()
    await nextTick()

    // The refresh found no models: the field is an ordinary text input then,
    // not a control that opens a blank box.
    expect(input().getAttribute('aria-expanded')).toBe('false')
    expect(popup()).toBeNull()
  })

  it('dismisses on a click outside', async () => {
    mount({ value: 'gpt-4o-mini' })
    await press('ArrowDown')
    expect(popup()).not.toBeNull()

    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await nextTick()
    expect(input().getAttribute('aria-expanded')).toBe('false')
  })

  it('holds the top of the modal stack while the list is up', async () => {
    // The bug this prevents: `useModalEscape` listens on window in the capture
    // phase, so without a claim the field's own Escape closed the whole
    // settings dialog out from under the open list.
    const dialog = modalStack.claimModal('settings-dialog')
    mount({ value: 'gpt-4o-mini' })
    expect(modalStack.isTopModal(dialog)).toBe(true)

    await press('ArrowDown')
    expect(modalStack.isTopModal(dialog)).toBe(false)

    await press('Escape')
    expect(modalStack.isTopModal(dialog)).toBe(true)
  })

  it('carries the host attributes onto the input', () => {
    // `class`, `id` and `placeholder` are what the closed control looks like:
    // the input is a real input and the field it sits in is the same field, so
    // they have to land on it and not on the wrapper.
    mount({ attrs: { class: 'input', placeholder: 'qwen2.5-coder:3b', style: 'color: red' } })
    expect(input().classList.contains('input')).toBe(true)
    expect(input().getAttribute('placeholder')).toBe('qwen2.5-coder:3b')
    expect(input().getAttribute('style')).toContain('color: red')
    expect(input().id).toBe('test-combo')
  })
})
