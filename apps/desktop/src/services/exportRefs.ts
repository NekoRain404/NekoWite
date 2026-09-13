import type { ExportRef } from '@nekowite/editor-core'
import type { Reference } from './refs'

/**
 * Project the vault's reference library onto the shape the export pipeline
 * renders citations with.
 *
 * The mapping is field-by-field on purpose: `Reference` is what the app stores
 * and searches (and carries bookkeeping of its own), while `ExportRef` is the
 * narrow subset a rendered citation needs. A cited `[@key]` has to resolve the
 * same way in every exported document, so both export entry points — the
 * settings dialog, which exports the open note, and the note card's menu,
 * which exports the note the user right-clicked — build their map here rather
 * than each keeping a copy of the field list.
 */
export function toExportRefs(refs: Iterable<Reference>): Map<string, ExportRef> {
  const map = new Map<string, ExportRef>()
  for (const ref of refs) {
    map.set(ref.key, {
      key: ref.key,
      title: ref.title,
      authors: ref.authors,
      year: ref.year,
      doi: ref.doi,
      journal: ref.journal,
      volume: ref.volume,
      issue: ref.issue,
      pages: ref.pages,
      publisher: ref.publisher,
      url: ref.url,
    })
  }
  return map
}
