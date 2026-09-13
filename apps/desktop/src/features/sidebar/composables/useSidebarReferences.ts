/**
 * The references section: the search box over the vault's bibliography and the
 * command that cites an entry into the open document (§13.4 — the results are a
 * query, `insertRef` is a command).
 *
 * The store read (refs) lives here rather than in the component: §10.2 keeps a
 * feature component off the stores, and both the count in the header and the
 * rows are the same search.
 */

import { computed, ref } from 'vue'
import { insertCiteAtCursor } from '../../../services/editorBridge'
import { useRefsStore } from '../../../stores/refs'

export function useSidebarReferences() {
  const refs = useRefsStore()

  const refQuery = ref('')
  const refCount = computed(() => refs.refs.size)
  const refResults = computed(() => refs.search(refQuery.value).slice(0, 30))

  function insertRef(key: string): void {
    insertCiteAtCursor(key)
    refQuery.value = ''
  }

  return { refQuery, refCount, refResults, insertRef }
}
