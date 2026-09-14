import { computed, markRaw, ref, type ComputedRef } from 'vue'
import {
  Bold,
  BoxSelect,
  ClipboardPaste,
  Code,
  Copy,
  Italic,
  Link,
  Scissors,
  Strikethrough,
} from 'lucide-vue-next'
import { t } from '../../../i18n'
import type { ContextMenuItem } from '../../../ui/ContextMenu.vue'
import { COMMAND_CATALOG } from '../../../ui/command-catalog'

/**
 * The editor's context menu: what a right-click on the writing surface offers,
 * and what picking one of those items does.
 *
 * Suppressing the webview's menu means taking over the editing operations it
 * carried, so the list is a product decision rather than a wiring detail — and
 * the engine decides which of them are even possible. That was measured against
 * WebKitGTK 2.52.6 (the engine Tauri 2 renders in here), not assumed:
 *
 * - `cut`, `copy` and `selectAll` execute, and neither the write side nor the
 *   selection side needs a permission.
 * - `paste` is behind a WebKit setting the **host** owns:
 *   `WebKitSettings:javascript-can-access-clipboard`. With it off,
 *   `document.execCommand('paste')` returns false and leaves the document
 *   untouched, and `navigator.clipboard.readText()` rejects with
 *   `NotAllowedError` — identically with no gesture and from a real trusted
 *   click. `lib.rs` builds the main window with `enable_clipboard_access()`,
 *   which turns it on, and that is the only reason the item below is honest.
 *   Remove that call and this entry becomes a no-op again.
 *
 *   Which is why the item is listed unconditionally rather than probed for:
 *   `queryCommandSupported('paste')` reports `true` in both states, so there is
 *   nothing to probe with.
 *
 * Paste is also the one verb here the webview reaches on its own: Ctrl+V and
 * Shift+Insert are the engine's own editing commands and never went through the
 * context menu, which is why they kept working while the item was missing.
 */

/** The editing verbs the engine will carry out for a right-click. `cut`, `copy`
 *  and `selectAll` need no permission; `paste` needs the host's, which `lib.rs`
 *  grants. */
export type EditorEditId = 'cut' | 'copy' | 'paste' | 'select-all'

/** `execCommand` names. Kept apart from the item ids so the menu's vocabulary
 *  and the DOM's do not have to agree on spelling. */
const EDIT_COMMAND: Record<EditorEditId, string> = {
  cut: 'cut',
  copy: 'copy',
  paste: 'paste',
  'select-all': 'selectAll',
}

/**
 * The inline formatting the editor already owns, in the order the toolbar
 * offers it. These are `editor-core` command ids, so a pick routes through the
 * same mode-aware runner the toolbar and the palette use — the menu adds an
 * entry point, never a second implementation of a command.
 */
const INLINE_COMMAND_IDS = ['bold', 'italic', 'strike', 'inline-code', 'link'] as const

const EDIT_ICONS = {
  cut: markRaw(Scissors),
  copy: markRaw(Copy),
  paste: markRaw(ClipboardPaste),
  'select-all': markRaw(BoxSelect),
}

const INLINE_ICONS = {
  bold: markRaw(Bold),
  italic: markRaw(Italic),
  strike: markRaw(Strikethrough),
  'inline-code': markRaw(Code),
  link: markRaw(Link),
}

/** Where the menu was opened, in viewport coordinates. */
export interface EditorMenuTarget {
  x: number
  y: number
}

export interface EditorContextMenuOptions {
  /** Run an `editor-core` command id. The pane supplies its mode-aware runner
   *  (`runEditorCommand`), so a menu pick behaves like the toolbar button. */
  runCommand: (id: string) => void
}

export interface EditorContextMenuModel {
  /** The point the menu is open at, or null when it is closed. */
  target: ComputedRef<EditorMenuTarget | null>
  items: ComputedRef<ContextMenuItem[]>
  /** The surface's `contextmenu` listener. */
  onContextMenu: (e: MouseEvent) => void
  close: () => void
  select: (id: string) => void
}

export function useEditorContextMenu(options: EditorContextMenuOptions): EditorContextMenuModel {
  const target = ref<EditorMenuTarget | null>(null)

  /**
   * What had the keyboard when the menu opened.
   *
   * Opening the menu moves focus into its first item — that is what makes the
   * arrow keys and Enter work without a mouse — and WebKit drops the document
   * selection as soon as focus leaves an editable region. Measured: after
   * focusing a plain button, `window.getSelection()` is empty and Copy runs
   * against nothing. So the editor is put back in charge before a command runs;
   * both editors keep their selection in their own state, so regaining focus
   * restores it.
   *
   * This is also why the restore cannot be left to `ContextMenu`'s own
   * focus-return: that fires on unmount, one tick after `select`.
   */
  let focusHost: HTMLElement | null = null

  const items = computed<ContextMenuItem[]>(() => {
    if (!target.value) return []
    const edit: ContextMenuItem[] = [
      { id: 'cut', label: t('contextMenu.cut'), icon: EDIT_ICONS.cut },
      { id: 'copy', label: t('contextMenu.copy'), icon: EDIT_ICONS.copy },
      { id: 'paste', label: t('contextMenu.paste'), icon: EDIT_ICONS.paste },
      // A leading divider sets the selection commands apart from the editing
      // ones — the same shape the native menu used.
      { id: 'select-all', label: t('contextMenu.selectAll'), icon: EDIT_ICONS['select-all'], separator: true },
    ]
    const inline: ContextMenuItem[] = INLINE_COMMAND_IDS.map((id, index) => ({
      id,
      // Fall back to the id rather than dropping the item: an id the catalog
      // does not know is a wiring mistake, and a visible one is easier to find
      // than a menu that quietly lost a command.
      label: COMMAND_CATALOG[id]?.label ?? id,
      icon: INLINE_ICONS[id],
      separator: index === 0,
    }))
    return [...edit, ...inline]
  })

  function open(next: EditorMenuTarget): void {
    const active = document.activeElement
    focusHost = active instanceof HTMLElement ? active : null
    target.value = next
  }

  /**
   * The surface's `contextmenu` listener.
   *
   * `preventDefault()` is the whole fix: the webview asks the DOM whether the
   * event was cancelled and shows its own menu only when it was not. Verified
   * against the engine — with no listener the webview's `context-menu` signal
   * fires and its menu appears; with one that cancels, the signal never fires.
   * It is registered in the capture phase on the panes' common ancestor so it
   * runs before ProseMirror's and CodeMirror's own handlers, which occupy the
   * target and the bubble phase.
   */
  function onContextMenu(e: MouseEvent): void {
    e.preventDefault()
    open({ x: e.clientX, y: e.clientY })
  }

  function close(): void {
    target.value = null
    focusHost = null
  }

  function select(id: string): void {
    // Hand the keyboard back before anything runs: see `focusHost`.
    const host = focusHost
    focusHost = null
    host?.focus()

    const edit = EDIT_COMMAND[id as EditorEditId]
    if (edit) {
      // Deprecated, and deliberately still used: these are the engine's own
      // editing commands, and they are what the native menu dispatched. Paste
      // is among them, and reads the clipboard because the window is built with
      // access to it (`lib.rs`). The editors restore their own selection when
      // focus returns, which is what makes this act on what the user had
      // selected.
      document.execCommand(edit)
      return
    }
    options.runCommand(id)
  }

  return {
    target: computed(() => target.value),
    items,
    onContextMenu,
    close,
    select,
  }
}
