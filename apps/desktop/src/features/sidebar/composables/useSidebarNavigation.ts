/**
 * The sidebar's navigation: the view/filter entries with their counts, and the
 * command that swaps the vault (§13.4 — the entries are a query over the
 * document list and the file tree; `pickVaultFolder` is a command).
 *
 * The store reads (documentList, fileTree) live here rather than in the
 * component: §10.2 keeps a feature component off the stores, and both reads are
 * the nav's own business — which view is on screen, and how many attachments
 * the vault holds.
 *
 * `pickVaultFolder` returns the chosen path instead of emitting it: the event
 * belongs to the component that owns the emit contract (§13.3), and a cancelled
 * dialog is `null` rather than a signal to keep the current vault.
 */

import { computed } from 'vue'
import {
  Clock,
  Cloud,
  Database,
  FileText,
  FolderTree,
  Inbox,
  Network,
  Paperclip,
  Star,
} from 'lucide-vue-next'
import { fsService } from '../../../platform/gateways/fs'
import { useDocumentListStore } from '../../../stores/documentList'
import { useFileTreeStore } from '../../../stores/fileTree'
import { t } from '../../../i18n'

export interface NavEntry {
  id: string
  label: string
  icon: typeof FileText
  count?: number
  active: boolean
  onClick: () => void
}

export function useSidebarNavigation() {
  const documentList = useDocumentListStore()
  const fileTree = useFileTreeStore()

  const navEntries = computed<NavEntry[]>(() => {
    const counts = documentList.counts
    const inNotes = documentList.listView === 'notes'
    const isFilter = (f: string): boolean => inNotes && documentList.filter === f
    return [
      {
        id: 'folders', label: t('nav.folders'), icon: FolderTree,
        active: documentList.listView === 'folders', onClick: () => documentList.setListView('folders'),
      },
      {
        id: 'all', label: t('nav.all'), icon: FileText, count: counts.all,
        active: isFilter('all'), onClick: () => documentList.setFilter('all'),
      },
      {
        id: 'recent', label: t('nav.recent'), icon: Clock, count: counts.recent,
        active: isFilter('recent'), onClick: () => documentList.setFilter('recent'),
      },
      {
        id: 'favorites', label: t('nav.favorites'), icon: Star, count: counts.favorites,
        active: isFilter('favorites'), onClick: () => documentList.setFilter('favorites'),
      },
      {
        id: 'uncategorized', label: t('nav.uncategorized'), icon: Inbox, count: counts.uncategorized,
        active: isFilter('uncategorized'), onClick: () => documentList.setFilter('uncategorized'),
      },
      {
        id: 'graph', label: t('nav.graph'), icon: Network,
        active: documentList.listView === 'graph', onClick: () => documentList.setListView('graph'),
      },
      {
        id: 'attachments', label: t('nav.attachments'), icon: Paperclip, count: fileTree.attachmentCount,
        active: documentList.listView === 'attachments', onClick: () => documentList.setListView('attachments'),
      },
      {
        id: 'index', label: t('nav.index'), icon: Database,
        active: documentList.listView === 'index', onClick: () => documentList.setListView('index'),
      },
      {
        id: 'cloud', label: t('nav.cloud'), icon: Cloud,
        active: documentList.listView === 'cloud', onClick: () => documentList.setListView('cloud'),
      },
    ]
  })

  /** The vault button's command. `null` means the dialog was cancelled. */
  async function pickVaultFolder(): Promise<string | null> {
    return fsService.openFolderDialog()
  }

  return { navEntries, pickVaultFolder }
}
