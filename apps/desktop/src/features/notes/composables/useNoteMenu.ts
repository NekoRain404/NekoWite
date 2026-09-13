/**
 * The note card's context menu: which note it is acting on, the items it
 * offers, and which command a pick stands for.
 *
 * The target is the path recorded when the menu opened, plus the click
 * position. Every item acts on THAT note — never on `tabs.activeTab`, which is
 * a different note whenever the user right-clicks a background card.
 *
 * The item ids live next to the switch that reads them, so a label and the
 * command it names cannot drift apart. The commands themselves arrive as
 * parameters: the menu is a dispatch table over the actions the note list owns,
 * and it can be driven without a mounted component.
 */

import { computed, markRaw, ref, type ComputedRef } from 'vue'
import {
  Download,
  FileDown,
  FolderOpen,
  PencilLine,
  Star,
  StarOff,
  Trash2,
} from 'lucide-vue-next'
import { t } from '../../../i18n'
import type { ContextMenuItem } from '../../../ui/ContextMenu.vue'
import type { NoteCardContextTarget } from '../../../ui/NoteCard.vue'

/** What picking a menu item does. Every command takes the path the menu was
 *  opened on — the one binding all of these actions share. */
export interface NoteMenuCommands {
  open(path: string): void
  toggleFavorite(path: string): void
  rename(path: string): void
  exportHtml(path: string): void
  exportPdf(path: string): void
  delete(path: string): void
}

export interface UseNoteMenuOptions extends NoteMenuCommands {
  /** Whether `path` is favorited. Asked on every render, so the star item
   *  describes this note's CURRENT state instead of a cached one. */
  isFavorite(path: string): boolean
}

export interface NoteMenuModel {
  /** The note the menu is acting on, or null when it is closed. */
  target: ComputedRef<NoteCardContextTarget | null>
  items: ComputedRef<ContextMenuItem[]>
  open(target: NoteCardContextTarget): void
  close(): void
  select(id: string): void
}

export function useNoteMenu(options: UseNoteMenuOptions): NoteMenuModel {
  /**
   * The note the card menu is acting on: the path recorded when the menu opened,
   * plus the click position. Every action reads THIS path — never
   * `tabs.activeTab`, which is a different note whenever the user right-clicks a
   * background card.
   */
  const target = ref<NoteCardContextTarget | null>(null)

  const NOTE_MENU_ICONS = {
    open: markRaw(FolderOpen),
    favorite: markRaw(Star),
    unfavorite: markRaw(StarOff),
    rename: markRaw(PencilLine),
    exportHtml: markRaw(Download),
    exportPdf: markRaw(FileDown),
    delete: markRaw(Trash2),
  }

  const items = computed<ContextMenuItem[]>(() => {
    const current = target.value
    if (!current) return []
    // Resolved on every render, so the label and icon always describe the action
    // for this note's CURRENT favourite state instead of a cached one.
    const favorite = options.isFavorite(current.path)
    return [
      { id: 'open', label: t('notecard.open'), icon: NOTE_MENU_ICONS.open },
      {
        id: 'toggle-favorite',
        label: t(favorite ? 'notecard.unfavorite' : 'notecard.favorite'),
        // The icon matches the label's action: Star = add, StarOff = remove.
        icon: favorite ? NOTE_MENU_ICONS.unfavorite : NOTE_MENU_ICONS.favorite,
      },
      { id: 'rename', label: t('filetree.rename'), icon: NOTE_MENU_ICONS.rename },
      { id: 'export-html', label: t('notecard.exportHtml'), icon: NOTE_MENU_ICONS.exportHtml },
      { id: 'export-pdf', label: t('notecard.exportPdf'), icon: NOTE_MENU_ICONS.exportPdf },
      // A leading divider sets the destructive action apart from the rest.
      {
        id: 'delete',
        label: t('filetree.delete'),
        icon: NOTE_MENU_ICONS.delete,
        separator: true,
        danger: true,
      },
    ]
  })

  function open(next: NoteCardContextTarget): void {
    target.value = next
  }

  function close(): void {
    target.value = null
  }

  function select(id: string): void {
    // ContextMenu emits `select` before `close`, so the target recorded when the
    // menu opened is still here.
    const current = target.value
    if (!current) return
    switch (id) {
      case 'open':
        options.open(current.path)
        break
      case 'toggle-favorite':
        options.toggleFavorite(current.path)
        break
      case 'rename':
        options.rename(current.path)
        break
      case 'export-html':
        options.exportHtml(current.path)
        break
      case 'export-pdf':
        options.exportPdf(current.path)
        break
      case 'delete':
        options.delete(current.path)
        break
    }
  }

  return {
    target: computed(() => target.value),
    items,
    open,
    close,
    select,
  }
}
