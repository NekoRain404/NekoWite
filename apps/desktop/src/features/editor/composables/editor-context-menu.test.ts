import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App as VueApp } from 'vue'
import { useEditorContextMenu } from './editor-context-menu'

/**
 * The editor menu's contract, in the two halves that matter.
 *
 * First: `preventDefault` on `contextmenu` is the entire mechanism by which the
 * webview's own menu is kept off the screen, so it is asserted directly rather
 * than inferred from a mount.
 *
 * Second: the menu opens onto its own first item, which steals the keyboard
 * from the editor, and a Cut or Copy that runs against a selection nobody holds
 * silently does nothing. `select` must therefore hand the keyboard back before
 * it dispatches — and to the element that had it, not to the menu item.
 *
 * What is NOT asserted here is that the engine honours any of it: that is
 * WebKit's behaviour, not this module's, and it was verified against a real
 * WebKitGTK 2.52.6 webview instead (see the report). Paste is the one item that
 * depends on something outside this module entirely — the window is built with
 * `enable_clipboard_access()` in `lib.rs`, and no test here can see that call.
 */

/** The commands `select` asked the DOM for, in order. */
let execCommands: string[] = []
let execImpl: ((command: string) => boolean) | null = null
let restoreExecCommand: (() => void) | null = null

/**
 * happy-dom ships no editing commands at all, so the stub is installed rather
 * than spied on. The point is which command is asked for and when — that the
 * engine carries it out is WebKit's half, checked against a real webview.
 */
function stubExecCommand(): void {
  const doc = document as unknown as { execCommand?: (command: string) => boolean }
  const original = doc.execCommand
  execCommands = []
  execImpl = null
  doc.execCommand = (command: string): boolean => {
    execCommands.push(command)
    return execImpl ? execImpl(command) : true
  }
  restoreExecCommand = () => {
    doc.execCommand = original
  }
}

function contextMenuEvent(x = 40, y = 60): MouseEvent {
  return new MouseEvent('contextmenu', { clientX: x, clientY: y, cancelable: true, bubbles: true })
}

/** A stand-in for the focused editor surface: what the menu hands focus back to. */
function focusedEditor(): HTMLButtonElement {
  const el = document.createElement('button')
  document.body.appendChild(el)
  el.focus()
  return el
}

let mounted: VueApp[] = []

afterEach(() => {
  for (const app of mounted) app.unmount()
  mounted = []
  restoreExecCommand?.()
  restoreExecCommand = null
  execImpl = null
  document.body.innerHTML = ''
})

function setup() {
  stubExecCommand()
  const runCommand = vi.fn()
  const menu = useEditorContextMenu({ runCommand })
  return { menu, runCommand }
}

describe('editor context menu', () => {
  it('cancels the contextmenu event, which is what suppresses the webview menu', () => {
    const { menu } = setup()
    const e = contextMenuEvent()

    menu.onContextMenu(e)

    expect(e.defaultPrevented).toBe(true)
  })

  it('opens at the point that was right-clicked', () => {
    const { menu } = setup()

    menu.onContextMenu(contextMenuEvent(120, 240))

    expect(menu.target.value).toEqual({ x: 120, y: 240 })
  })

  it('offers the editing verbs and the editor own inline commands', () => {
    const { menu } = setup()
    menu.onContextMenu(contextMenuEvent())

    expect(menu.items.value.map((item) => item.id)).toEqual([
      'cut',
      'copy',
      'paste',
      'select-all',
      'bold',
      'italic',
      'strike',
      'inline-code',
      'link',
    ])
  })

  it('offers Paste, which the host opted into when it built the window', () => {
    // This assertion used to run the other way: no Paste item, because WebKit's
    // clipboard setting was off and the entry could only ever be a silent
    // no-op. `lib.rs` now builds the window with `enable_clipboard_access()`,
    // which is what makes the item honest — and the only thing that does, so
    // it is worth asserting rather than merely commenting.
    const { menu } = setup()
    menu.onContextMenu(contextMenuEvent())

    const ids = menu.items.value.map((item) => item.id)
    expect(ids).toContain('paste')
    // Where the native menu had it: with the other clipboard verbs, before the
    // divider that sets off the selection commands.
    expect(ids.indexOf('paste')).toBe(ids.indexOf('copy') + 1)
  })

  it('is empty while closed', () => {
    const { menu } = setup()

    expect(menu.items.value).toEqual([])

    menu.onContextMenu(contextMenuEvent())
    menu.close()

    expect(menu.target.value).toBeNull()
    expect(menu.items.value).toEqual([])
  })

  it('hands the keyboard back to the editor before running a selection command', () => {
    const { menu } = setup()
    const editor = focusedEditor()
    menu.onContextMenu(contextMenuEvent())
    // What ContextMenu does on open: focus moves into the menu's first item.
    const menuItem = document.createElement('button')
    document.body.appendChild(menuItem)
    menuItem.focus()
    const focusedAtRun: Array<string | undefined> = []
    execImpl = () => {
      focusedAtRun.push(document.activeElement?.tagName)
      return true
    }

    menu.select('copy')

    expect(document.activeElement).toBe(editor)
    expect(focusedAtRun).toEqual(['BUTTON'])
    expect(execCommands).toEqual(['copy'])
  })

  it('maps the menu ids onto the commands the DOM knows', () => {
    const { menu } = setup()
    menu.onContextMenu(contextMenuEvent())

    menu.select('cut')
    menu.select('paste')
    menu.select('select-all')

    // `paste` is the load-bearing one: the engine's own command, which is what
    // the host's clipboard opt-in makes execute.
    expect(execCommands).toEqual(['cut', 'paste', 'selectAll'])
  })

  it('routes a formatting pick to the pane command runner instead of the DOM', () => {
    const { menu, runCommand } = setup()
    menu.onContextMenu(contextMenuEvent())

    menu.select('inline-code')

    expect(runCommand).toHaveBeenCalledWith('inline-code')
    expect(execCommands).toEqual([])
  })
})

/**
 * The wiring, not just the handler.
 *
 * The composable test above proves the listener cancels. What remains — and
 * what the fix actually depends on — is that the listener is attached to the
 * panes' common ancestor in the CAPTURE phase, so it runs ahead of whatever
 * ProseMirror and CodeMirror install on the editable itself. The host below
 * reproduces that shape: a `.panes` ancestor, an editable inside it.
 */
describe('editor context menu wiring', () => {
  it('cancels a right-click on the editable from an ancestor capture listener', async () => {
    stubExecCommand()
    const menu = useEditorContextMenu({ runCommand: vi.fn() })

    const host = defineComponent({
      setup: () => () =>
        h(
          'div',
          { class: 'panes', onContextmenuCapture: menu.onContextMenu },
          h('div', { class: 'editor-container', contenteditable: 'true' }, 'text'),
        ),
    })
    const el = document.createElement('div')
    document.body.appendChild(el)
    const app = createApp(host)
    mounted.push(app)
    app.mount(el)
    await nextTick()

    const editable = el.querySelector('.editor-container') as HTMLElement
    const e = new MouseEvent('contextmenu', {
      clientX: 11,
      clientY: 22,
      bubbles: true,
      cancelable: true,
    })
    editable.dispatchEvent(e)

    expect(e.defaultPrevented).toBe(true)
    expect(menu.target.value).toEqual({ x: 11, y: 22 })
  })
})
