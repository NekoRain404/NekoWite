/**
 * The two new-note shortcuts: today's daily note, and the template picker that
 * creates a note from one of the vault's templates (§13.4 — the picker's state
 * and the commands that write).
 *
 * The store read (tabs) lives here rather than in the component: §10.2 keeps a
 * feature component off the stores, and opening the note the shortcut just
 * produced is this composable's own business. The vault arrives as a getter
 * because it is switched under a mounted sidebar, and every command here is
 * vault-scoped.
 */

import { ref } from 'vue'
import { notifyError } from '../../../services/errors'
import { fsService } from '../../../platform/gateways/fs'
import {
  buildDailyVars,
  ensureDailyNote,
  listTemplates,
  readTemplate,
  renderTemplate,
  templateFileBase,
  type TemplateEntry,
} from '../../../services/note-templates'
import {
  MAX_CREATE_ATTEMPTS,
  createNoteWithFreeName,
  type CreatedNote,
} from '../../../services/note-creation'
import { useTabsStore } from '../../../stores/tabs'
import { t } from '../../../i18n'

export interface UseSidebarTemplatesOptions {
  vault: () => string
}

export function useSidebarTemplates(options: UseSidebarTemplatesOptions) {
  const tabs = useTabsStore()

  const templatePickerOpen = ref(false)
  const templateTemplates = ref<TemplateEntry[]>([])

  /** Open (or create) today's daily note, rendering the default template on
   *  first use. Existing notes are opened without a write. */
  async function createDailyNote(): Promise<void> {
    try {
      const { path } = await ensureDailyNote(options.vault())
      await tabs.openTab(path)
    } catch {
      notifyError(t('daily.createFailed'))
    }
  }

  async function openTemplatePicker(): Promise<void> {
    let templates: TemplateEntry[] = []
    try {
      templates = await listTemplates(options.vault())
    } catch {
      templates = []
    }
    templateTemplates.value = templates
    templatePickerOpen.value = true
  }

  function closeTemplatePicker(): void {
    templatePickerOpen.value = false
  }

  /** Collects the vault-root filenames so a new note can avoid a collision. */
  async function rootNoteNames(): Promise<Set<string>> {
    try {
      const entries = await fsService.list(options.vault(), '.')
      return new Set(entries.filter((e) => !e.is_dir).map((e) => e.name))
    } catch {
      return new Set()
    }
  }

  async function createFromTemplate(entry: TemplateEntry): Promise<void> {
    let body: string
    try {
      body = await readTemplate(options.vault(), entry)
    } catch {
      notifyError(t('template.readFailed'))
      return
    }
    const existing = await rootNoteNames()
    const base = templateFileBase(entry)
    const content = renderTemplate(body, buildDailyVars(new Date(), { title: base }))
    let created: CreatedNote | null
    try {
      created = await createNoteWithFreeName(options.vault(), base, content, existing)
    } catch {
      notifyError(t('template.createFailed'))
      return
    }
    if (!created) {
      // Every candidate name was claimed by another writer while we were choosing
      // one. Report that instead of falling back to a write that would land on
      // top of the file that took the name.
      notifyError(t('template.nameTaken', { count: MAX_CREATE_ATTEMPTS, base }))
      return
    }
    templatePickerOpen.value = false
    await tabs.openTab(created.path)
  }

  return {
    templatePickerOpen,
    templateTemplates,
    createDailyNote,
    openTemplatePicker,
    closeTemplatePicker,
    createFromTemplate,
  }
}
