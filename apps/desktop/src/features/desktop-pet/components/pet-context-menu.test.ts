/**
 * The pet's right-click menu: three things it can actually do, and the four ways a menu goes wrong.
 *
 * §7.2 is the rule the item list is built to: 「无支持则使用紧凑交互窗口」 and 「不显示可点击但无效果的
 * 控件」 — a menu is a list of promises, and an item the host cannot carry out is a promise the user
 * finds out about by clicking it. So there are exactly three items and each one names a call that
 * exists: show the tasks, open the settings page, hide the pet. The things upstream's tray menu
 * offered and this one must not — 退出 (`exit(0)`), 更新 (its own updater), 开机启动 — are the
 * duplicated shells §4 removes; a pet menu that could quit the application would be the second quit
 * path §7.1 forbids. `menu.test` below asserts the list is exactly those three, so adding a fourth
 * is a decision rather than a drift.
 *
 * The four failures it is tested against are the ones that make a menu feel broken rather than
 * wrong: an item that does nothing, picking the neighbour of the item you clicked, Escape or a
 * click outside leaving the user with no focus anywhere, and a menu opened at the window's edge
 * with half of it off screen.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, ref, type App as VueApp } from 'vue'
import type { PetContextMenuLabels } from '../services/pet-message-template'
import type { PetMenuAction } from '../services/pet-context-menu'
import PetContextMenu from './PetContextMenu.vue'

interface Harness {
  open: boolean
  selections: PetMenuAction[]
  closes: number
  openMenu: () => Promise<void>
}

const mounted: VueApp[] = []

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * A pet window with something focusable in it ("the pet") and the menu over it.
 *
 * The focusable element is not decoration: a menu that takes focus when it opens and does not give
 * it back leaves the keyboard user nowhere, and a harness without something to give it back to
 * could not tell that apart from a menu that restores correctly.
 */
function mountHost(options: { taskCount?: number; labels?: Partial<PetContextMenuLabels> } = {}): Harness {
  document.body.innerHTML = '<div id="host"></div>'
  const open = ref(false)
  const state: Harness = {
    open: false,
    selections: [],
    closes: 0,
    openMenu: async () => {
      open.value = true
      await nextTick()
      await tick()
    },
  }

  const app = createApp({
    setup: () => () =>
      h('div', [
        h('button', { id: 'pet', type: 'button' }, '🐾'),
        h(PetContextMenu, {
          open: open.value,
          anchor: { x: 40, y: 30 },
          capabilities: { taskCount: options.taskCount ?? 0 },
          labels: options.labels,
          onSelect: (action: PetMenuAction) => state.selections.push(action),
          onClose: () => {
            state.closes += 1
            open.value = false
          },
        }),
      ]),
  })
  mounted.push(app)
  app.mount(document.getElementById('host') as Element)
  return state
}

function menuItems(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('.pet-menu__item')]
}

function itemByLabel(label: string): HTMLButtonElement | undefined {
  return menuItems().find((item) => item.textContent?.includes(label))
}

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount()
  document.body.innerHTML = ''
})

describe('what the pet can be asked to do', () => {
  it('offers exactly the three things it can carry out, in the order they are listed', async () => {
    const view = mountHost({ taskCount: 2 })
    await view.openMenu()

    const menu = document.querySelector<HTMLElement>('.pet-menu')
    expect(menu?.getAttribute('role')).toBe('menu')
    expect(menu?.getAttribute('aria-label')).toBe('Pet menu')
    expect(menuItems().map((item) => item.getAttribute('role'))).toEqual([
      'menuitem',
      'menuitem',
      'menuitem',
    ])
    // Three, and not one of them is 退出, 更新 or 开机启动: §4 removes the duplicated shells, and a
    // pet menu that could quit the application would be the second quit path §7.1 forbids.
    expect(menuItems().map((item) => item.textContent?.trim())).toEqual([
      'Show tasks',
      'Settings…',
      'Hide',
    ])
  })

  it('picks the item that was clicked, whichever one it is', async () => {
    const view = mountHost({ taskCount: 3 })
    await view.openMenu()

    for (const label of ['Show tasks', 'Settings…', 'Hide']) {
      itemByLabel(label)?.click()
      await nextTick()
    }

    expect(view.selections).toEqual([
      { id: 'tasks' },
      { id: 'settings', page: 'general' },
      { id: 'hide' },
    ])
    // Picking an item does not close the menu behind the caller's back: `open` is the caller's, and
    // a component that closed itself would make the two disagree.
    expect(view.closes).toBe(0)
  })

  it('states why the tasks item cannot be picked instead of hiding it', async () => {
    // §7.2: a capability that is not there is stated. A menu item that vanished when nothing was
    // running would leave the user wondering whether they had misremembered, and one that was
    // clickable and inert would be worse.
    const empty = mountHost({ taskCount: 0 })
    await empty.openMenu()

    const tasksItem = itemByLabel('Show tasks')
    expect(tasksItem?.disabled).toBe(true)
    expect(document.querySelector('.pet-menu__reason')?.textContent?.trim()).toBe(
      'Nothing is running',
    )
    expect(itemByLabel('Settings…')?.disabled).toBe(false)

    document.body.innerHTML = ''
    const running = mountHost({ taskCount: 1 })
    await running.openMenu()

    expect(itemByLabel('Show tasks')?.disabled).toBe(false)
    expect(document.querySelector('.pet-menu__reason')).toBeNull()
  })

  it('takes its wording from the caller', async () => {
    const view = mountHost({
      taskCount: 0,
      labels: { menu: '桌宠菜单', tasks: '查看任务', settings: '设置…', hide: '隐藏', noTasks: '当前没有任务' },
    })
    await view.openMenu()

    expect(document.querySelector('.pet-menu')?.getAttribute('aria-label')).toBe('桌宠菜单')
    expect(itemByLabel('查看任务')?.disabled).toBe(true)
    expect(document.querySelector('.pet-menu__reason')?.textContent?.trim()).toBe('当前没有任务')
  })
})

describe('the menu behaves like a menu', () => {
  it('opens focused on the first item it can actually pick', async () => {
    const view = mountHost({ taskCount: 0 })
    await view.openMenu()

    // Not the first item *in the list*: focusing a disabled one would leave the arrow keys with
    // nowhere to start from.
    expect(document.activeElement).toBe(itemByLabel('Settings…'))
  })

  it('moves focus with the arrows, skipping what cannot be picked, and wraps', async () => {
    const view = mountHost({ taskCount: 0 })
    await view.openMenu()
    const menu = document.querySelector<HTMLElement>('.pet-menu') as HTMLElement

    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(document.activeElement).toBe(itemByLabel('Hide'))

    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(document.activeElement).toBe(itemByLabel('Settings…'))

    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    expect(document.activeElement).toBe(itemByLabel('Hide'))

    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    expect(document.activeElement).toBe(itemByLabel('Settings…'))
  })

  it('closes on Escape and gives the focus back to what had it', async () => {
    const view = mountHost({ taskCount: 1 })
    const pet = document.getElementById('pet') as HTMLButtonElement
    pet.focus()
    await view.openMenu()
    expect(document.activeElement).not.toBe(pet)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()
    await tick()

    expect(view.closes).toBe(1)
    // The place in the window the user came from, not `<body>`: without this the next Tab starts
    // at the top of the window and the pet they were working with is lost.
    expect(document.activeElement).toBe(pet)
  })

  it('closes when the click was somewhere else, and stays open when it was not', async () => {
    const view = mountHost({ taskCount: 1 })
    await view.openMenu()

    menuItems()[1]?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(view.closes).toBe(0)

    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(view.closes).toBe(1)
  })

  it('opens at the point it was given, and stays inside the window', async () => {
    const view = mountHost({ taskCount: 1 })
    await view.openMenu()

    // happy-dom reports a zero-sized box for the menu, so this is the anchor itself: the clamped
    // arithmetic is the placement service's own test, and this one is about the menu asking.
    const menu = document.querySelector<HTMLElement>('.pet-menu')
    expect(menu?.style.left).toBe('40px')
    expect(menu?.style.top).toBe('30px')
    expect(menu?.style.position).toBe('fixed')
  })
})
