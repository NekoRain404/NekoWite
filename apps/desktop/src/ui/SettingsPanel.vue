<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  Download,
  Palette,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
  Type,
  X,
  Puzzle,
} from 'lucide-vue-next'
import { useViewStore } from '../stores/view'
import type { ViewMode } from '../stores/view'
import { useTabsStore } from '../stores/tabs'
import { useRefsStore } from '../stores/refs'
import { exportHtml, exportToPdf } from '../services/export'
import { exportBaseName } from '../services/exportName'
import { fsService } from '../platform/gateways/fs'
import { flushEdits } from '../services/editorOwnership'
import { listVaultPlugins, setVaultPluginDisabled } from '../services/plugins'
import type { VaultPluginSummary } from '../services/plugins'
import type { AiWriteKind, AiWriteSource } from '../services/aiPermissions'
import type { AiAuditOutcome } from '../services/aiAudit'
import { describeExportError, notifyError } from '../services/errors'
import { isPathWithinVault } from '../services/attachments'
import { useSettingsStore } from '../stores/settings'
import {
  CONTEXT_CHARS_MAX,
  CONTEXT_CHARS_MIN,
  DEFAULT_CONTEXT_CHARS,
  EFFORT_OPTIONS,
} from '../stores/settings'
import { useAppearanceStore } from '../stores/appearance'
import { ACCENTS, ACCENT_COLORS, COLOR_SCHEMES, COLOR_SCHEME_PREVIEW } from '../stores/appearance'
import type { ColorScheme, ContentDirection, EditorFontId, MonoFontId, UiFontId } from '../stores/appearance'
import { getLocale, setLocale, t } from '../i18n'
import { useFocusTrap } from '../composables/useFocusTrap'
import { modalStack } from '../services/modalStack'
import { isComposingKey } from '../services/keyGuard'
import { useAiPermissionStore } from '../stores/aiPermission'
import { useVaultSessionStore } from '../stores/vaultSession'
import { AI_WRITE_POLICIES, describePolicy, type AiWritePolicy } from '../services/aiPermissions'
import type { ExportRef } from '@nekowite/editor-core'

const emit = defineEmits<{ (e: 'close'): void; (e: 'saved', path: string): void }>()

const view = useViewStore()
const tabs = useTabsStore()
const refs = useRefsStore()
const settings = useSettingsStore()
const appearance = useAppearanceStore()

function colorSchemePreview(s: ColorScheme) {
  const mode = appearance.effectiveTheme() === 'dark' ? 'dark' : 'light'
  return COLOR_SCHEME_PREVIEW[s][mode]
}

type SectionId = 'general' | 'appearance' | 'editor' | 'export' | 'ai' | 'plugins'

const SECTIONS = computed<Array<{ id: SectionId; label: string; icon: typeof Type }>>(() => [
  { id: 'general', label: t('settings.section.general'), icon: SlidersHorizontal },
  { id: 'appearance', label: t('settings.section.appearance'), icon: Palette },
  { id: 'editor', label: t('settings.section.editor'), icon: Type },
  { id: 'export', label: t('settings.section.export'), icon: Download },
  { id: 'ai', label: t('settings.section.ai'), icon: Sparkles },
  { id: 'plugins', label: t('settings.section.plugins'), icon: Puzzle },
])

const aiPermission = useAiPermissionStore()
const activeSection = ref<SectionId>('general')

/** Literal i18n keys per audit field. A table, not concatenation: the i18n
 *  parity test scans the source for real key literals, so a dynamically built
 *  key is a key nobody checks. */
const AUDIT_OUTCOME_KEYS: Record<AiAuditOutcome, string> = {
  asked: 'aiperm.audit.outcome.asked',
  allowed: 'aiperm.audit.outcome.allowed',
  denied: 'aiperm.audit.outcome.denied',
  blocked: 'aiperm.audit.outcome.blocked',
  granted: 'aiperm.audit.outcome.granted',
}
const AUDIT_SOURCE_KEYS: Record<AiWriteSource, string> = {
  ghost: 'aiperm.audit.source.ghost',
  chat: 'aiperm.audit.source.chat',
  edit: 'aiperm.audit.source.edit',
  dialog: 'aiperm.audit.source.dialog',
  plugin: 'aiperm.audit.source.plugin',
}
const AUDIT_KIND_KEYS: Record<AiWriteKind, string> = {
  insert: 'aiperm.audit.kind.insert',
  'replace-selection': 'aiperm.audit.kind.replace-selection',
  'replace-document': 'aiperm.audit.kind.replace-document',
}

const vaultSession = useVaultSessionStore()
const vaultPath = computed(() => (vaultSession.vault ?? '').trim())
const pluginRows = ref<VaultPluginSummary[]>([])
const pluginsLoading = ref(false)

/** Read the plugins folder for the vault that is open right now. Only
 *  manifests are read - nothing is imported - so opening the panel can never
 *  run plugin code. */
async function refreshPluginRows(): Promise<void> {
  const vault = vaultPath.value
  if (!vault) {
    pluginRows.value = []
    return
  }
  pluginsLoading.value = true
  try {
    pluginRows.value = await listVaultPlugins(vault)
  } catch {
    pluginRows.value = []
  } finally {
    pluginsLoading.value = false
  }
}

/** Flip one plugin and re-read, so the row describes the app's actual state
 *  rather than what the click assumed it would be. */
async function togglePlugin(row: VaultPluginSummary, enabled: boolean): Promise<void> {
  setVaultPluginDisabled(row.id, !enabled, { vault: vaultPath.value })
  await refreshPluginRows()
}

watch(activeSection, (section) => {
  if (section === 'plugins') void refreshPluginRows()
})
const dialogRef = ref<HTMLElement | null>(null)
const panelActive = ref(true)
// aria-modal has to mean something: without a trap, Tab walked out of the
// dialog into the tab bar and editor it was covering. Focusing the container
// (tabindex=-1) on open matches the other dialogs and keeps Enter from
// activating whatever control happens to be first.
useFocusTrap(dialogRef, panelActive, { initialFocus: false })
// The settings panel and the command palette are both full-screen modals at
// z-index 10000, and both listen for Escape on window in the capture phase.
// Keydown listeners on the same target cannot stop each other, so each one asks
// the stack whether it is the topmost modal before acting.
const modalToken = modalStack.claimModal('settings-panel')

const vaultInput = ref(localStorage.getItem('nekowite.vault') ?? '')
const hasActiveTab = computed(() => !!tabs.activeTab?.content)
const showBaseUrl = computed(
  () =>
    settings.provider === 'local' ||
    settings.provider === 'custom' ||
    // DeepSeek speaks the OpenAI wire format and is routinely served through a
    // gateway (tokenflux, OpenRouter, a company proxy), so the Base URL has to
    // be editable rather than pinned to api.deepseek.com.
    settings.provider === 'deepseek',
)

const AI_PROVIDERS = ['openai', 'anthropic', 'gemini', 'grok', 'deepseek', 'local', 'custom']

/**
 * Thinking-depth choices. `''` is "leave it to the provider": the field is then
 * omitted from the request entirely. `effortLabelKey` maps a rung to its i18n
 * key so the template never builds a key by concatenation.
 */
/**
 * The AI write policies, in the order they are offered. `describePolicy` in the
 * permission service owns the key mapping, so the wording only lives in i18n.
 */
const WRITE_POLICIES: { value: AiWritePolicy; labelKey: string }[] = AI_WRITE_POLICIES.map(
  (value) => ({ value, labelKey: describePolicy(value) }),
)

const modelLoading = ref(false)

/** How many entries the panel shows. The log keeps more than this (see
 *  services/aiAudit); the panel is a window onto it, not the whole file. */
const AUDIT_ROWS = 8

/** The newest entries first: the question this list answers is "what just
 *  happened", so the most recent line has to be the one at the top. */
const recentAiAudit = computed(() => [...aiPermission.auditLog].reverse().slice(0, AUDIT_ROWS))

/** Wall-clock time only: these rows are all from today in practice, and a date
 *  on every line would crowd out the part that matters. */
function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
const modelOptions = computed(() => {
  const list = settings.modelsCache
  const current = settings.model
  if (!current || list.includes(current)) return list
  return [current, ...list]
})

async function refreshModels(): Promise<void> {
  if (modelLoading.value) return
  modelLoading.value = true
  try {
    await settings.listModels()
  } catch (e) {
    notifyError(t('aiSettings.getModelsFailed', { msg: e instanceof Error ? e.message : String(e) }))
  } finally {
    modelLoading.value = false
  }
}

// Each provider has its own endpoint and credentials, so refetch (and clear the
// stale cache) whenever the provider changes.
watch(
  () => settings.provider,
  () => {
    settings.clearModelsCache()
    void refreshModels()
  },
)

/** The note under the accent checkbox has to say which of the two things
 *  actually happened: the OS colour was read and mapped onto the palette, or it
 *  could not be read and the accent is the theme-based pick. Claiming the system
 *  colour was applied when it was not is the lie this replaces. */
const followAccentNote = computed(() => {
  if (appearance.systemAccentState === 'read') return t('settings.appearance.followAccentHintRead')
  if (appearance.systemAccentState === 'unavailable') return t('settings.appearance.followAccentHintUnavailable')
  return t('settings.appearance.followAccentHint')
})

const UI_FONT_OPTIONS: UiFontId[] = ['system', 'inter', 'serif', 'rounded']
const EDITOR_FONT_OPTIONS: EditorFontId[] = ['system', 'serif', 'sans', 'reading']
const MONO_FONT_OPTIONS: MonoFontId[] = ['mono', 'cascadia', 'jetbrains']

function onLocaleChange(e: Event): void {
  const v = (e.target as HTMLSelectElement).value
  setLocale(v === 'en' ? 'en' : 'zh')
}

function onOverlayPointerDown(e: PointerEvent): void {
  if (e.target === e.currentTarget) emit('close')
}

function onKeydown(e: KeyboardEvent): void {
  // Shared guard: the deprecated keyCode 229 / key="Process" signals matter on
  // Windows IMEs, where `isComposing` alone is not always set.
  if (isComposingKey(e)) return
  if (e.key === 'Escape') {
    // Only the modal the user is looking at may answer Escape.
    if (!modalStack.isTopModal(modalToken)) return
    e.preventDefault()
    emit('close')
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown, true)
  void nextTick(() => dialogRef.value?.focus())
})

onBeforeUnmount(() => {
  modalStack.releaseModal(modalToken)
  window.removeEventListener('keydown', onKeydown, true)
})

watch(activeSection, () => {
  void nextTick(() => dialogRef.value?.focus())
})

async function saveAiKey(): Promise<void> {
  try {
    await settings.saveKey()
  } catch (e) {
    notifyError(t('settings.general.saveKeyFailed', { msg: e instanceof Error ? e.message : String(e) }))
  }
}

async function saveVault(): Promise<void> {
  const path = vaultInput.value.trim()
  if (!path) return
  localStorage.setItem('nekowite.vault', path)
  emit('saved', path)
}

async function browseVault(): Promise<void> {
  try {
    const picked = await fsService.openFolderDialog()
    if (!picked) return
    vaultInput.value = picked
    await saveVault()
  } catch (e) {
    notifyError(t('settings.general.vaultBrowseFailed', { msg: e instanceof Error ? e.message : String(e) }))
  }
}

function setMode(m: ViewMode): void {
  view.setMode(m)
}

function refsMap(): Map<string, ExportRef> {
  const m = new Map<string, ExportRef>()
  for (const r of refs.refs.values()) {
    m.set(r.key, {
      key: r.key,
      title: r.title,
      authors: r.authors,
      year: r.year,
      doi: r.doi,
      journal: r.journal,
      volume: r.volume,
      issue: r.issue,
      pages: r.pages,
      publisher: r.publisher,
      url: r.url,
    })
  }
  return m
}

async function onExportHtml(): Promise<void> {
  const tab = tabs.activeTab
  if (!tab) return
  // The native dialog lets the user aim anywhere (Desktop, Home, …), but the
  // Rust `write_file` command is vault-confined — an absolute path outside the
  // vault is rejected with "path escapes vault" and the export silently fails.
  // (Preferred fix, needing a backend change: a dedicated non-confined
  // `export_file` command that writes an absolute path outside the vault.)
  // Until that lands, do not lead the user to a doomed path: short-circuit a
  // vault-external destination up front and tell them to pick a vault path.
  const vault = tabs.vault
  const savePath = await fsService.saveFileDialog(exportBaseName(tab.path) + '.html', vault ?? undefined)
  if (!savePath) return
  if (vault && !isPathWithinVault(savePath, vault)) {
    notifyError(t('error.exportOutsideVault'))
    return
  }
  try {
    // The tab lags the source pane by its debounce window; export the live text.
    await flushEdits()
    await exportHtml(tab.content, vault ?? '', savePath, { title: exportBaseName(tab.path), refs: refsMap() })
  } catch (e) {
    // Belt-and-braces: if the backend still rejects (e.g. a symlink resolved
    // outside, or no vault open) describeExportError maps it to a clear hint.
    notifyError(describeExportError(e))
  }
}

async function onExportPdf(): Promise<void> {
  const tab = tabs.activeTab
  if (!tab) return
  // Persist the live text into the tab before handing it to the exporter.
  await flushEdits()
  exportToPdf(tab.content, { title: exportBaseName(tab.path), refs: refsMap() })
}
</script>

<template>
  <Teleport to="body">
    <div
      class="settings-overlay"
      role="presentation"
      @pointerdown="onOverlayPointerDown"
    >
      <div
        ref="dialogRef"
        class="settings-dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="t('settings.dialogTitle')"
        tabindex="-1"
      >
        <div class="dialog-header">
          <span class="dialog-title">{{ t('settings.dialogTitle') }}</span>
          <span class="dialog-spacer" />
          <button
            class="settings-close"
            :title="t('common.close')"
            @click="emit('close')"
          >
            <X
              :size="15"
              :stroke-width="1.8"
            />
          </button>
        </div>
        <div class="dialog-body">
          <aside
            class="dialog-nav"
            role="tablist"
            :aria-label="t('settings.dialogTitle')"
          >
            <button
              v-for="s in SECTIONS"
              :key="s.id"
              class="nav-row"
              :class="{ active: activeSection === s.id }"
              role="tab"
              :aria-selected="activeSection === s.id"
              :aria-current="activeSection === s.id ? 'true' : undefined"
              @click="activeSection = s.id"
            >
              <component
                :is="s.icon"
                class="nav-row-icon"
                :size="15"
                :stroke-width="1.8"
              />
              <span>{{ s.label }}</span>
            </button>
          </aside>
          <div class="dialog-content">
            <section
              v-if="activeSection === 'general'"
              class="settings-section"
            >
              <span class="settings-label">{{ t('settings.general.vault') }}</span>
              <div class="vault-row">
                <input
                  v-model="vaultInput"
                  class="input"
                  type="text"
                  :placeholder="t('settings.general.vaultPlaceholder')"
                  @keyup.enter="saveVault"
                >
                <button
                  class="btn btn-secondary btn-sm vault-browse"
                  :title="t('common.browse')"
                  @click="browseVault"
                >
                  {{ t('common.browse') }}
                </button>
              </div>
              <button
                class="btn btn-secondary settings-save"
                @click="saveVault"
              >
                {{ t('common.saveAndSwitch') }}
              </button>
              <span class="settings-note">{{ t('settings.general.vaultNote') }}</span>

              <span class="settings-label">{{ t('settings.general.language') }}</span>
              <label class="settings-field">
                <select
                  class="input"
                  :value="getLocale()"
                  @change="onLocaleChange"
                >
                  <option value="zh">{{ t('settings.general.languageZh') }}</option>
                  <option value="en">{{ t('settings.general.languageEn') }}</option>
                </select>
              </label>
            </section>

            <section
              v-else-if="activeSection === 'appearance'"
              class="settings-section"
            >
              <span class="settings-label">{{ t('settings.appearance.theme') }}</span>
              <div class="view-modes">
                <button
                  class="switch-option"
                  :class="{ 'is-active': appearance.theme === 'light' }"
                  @click="appearance.setTheme('light')"
                >
                  {{ t('settings.appearance.themeLight') }}
                </button>
                <button
                  class="switch-option"
                  :class="{ 'is-active': appearance.theme === 'dark' }"
                  @click="appearance.setTheme('dark')"
                >
                  {{ t('settings.appearance.themeDark') }}
                </button>
                <button
                  class="switch-option"
                  :class="{ 'is-active': appearance.theme === 'system' }"
                  @click="appearance.setTheme('system')"
                >
                  {{ t('settings.appearance.themeSystem') }}
                </button>
              </div>
              <span class="settings-label">{{ t('settings.appearance.colorScheme') }}</span>
              <div
                class="color-scheme-grid"
                role="radiogroup"
                :aria-label="t('settings.appearance.colorScheme')"
              >
                <button
                  v-for="s in COLOR_SCHEMES"
                  :key="s"
                  type="button"
                  class="color-scheme-card"
                  role="radio"
                  :aria-checked="appearance.colorScheme === s"
                  :class="{ 'is-selected': appearance.colorScheme === s }"
                  :data-scheme="s"
                  :title="t(`settings.appearance.colorScheme_${s}`)"
                  @click="appearance.setColorScheme(s)"
                >
                  <span
                    class="color-scheme-preview"
                    aria-hidden="true"
                  >
                    <span
                      class="color-scheme-swatch"
                      :style="{ background: colorSchemePreview(s).canvas, borderColor: colorSchemePreview(s).border }"
                    />
                  </span>
                  <span class="color-scheme-name">{{ t(`settings.appearance.colorScheme_${s}`) }}</span>
                </button>
              </div>
              <span class="settings-label">{{ t('settings.appearance.accent') }}</span>
              <div
                class="accent-row"
                :class="{ 'is-disabled': appearance.followSystemAccent }"
              >
                <button
                  v-for="a in ACCENTS"
                  :key="a"
                  type="button"
                  class="accent-swatch"
                  :class="{ 'is-selected': appearance.accent === a }"
                  :style="{ background: ACCENT_COLORS[a] }"
                  :aria-label="a"
                  :title="a as string"
                  @click="appearance.setAccent(a)"
                />
              </div>
              <label class="settings-field settings-toggle">
                <span>{{ t('settings.appearance.followSystemAccent') }}</span>
                <input
                  :checked="appearance.followSystemAccent"
                  type="checkbox"
                  class="checkbox"
                  @change="appearance.setFollowSystemAccent(($event.target as HTMLInputElement).checked)"
                >
              </label>
              <span
                v-if="appearance.followSystemAccent"
                class="settings-note"
              >{{ followAccentNote }}</span>
              <span class="settings-label">{{ t('settings.appearance.font') }}</span>
              <label class="settings-field">
                <span>{{ t('settings.appearance.uiFont') }}</span>
                <select
                  class="input"
                  :value="appearance.uiFont"
                  @change="appearance.setUiFont(($event.target as HTMLSelectElement).value as UiFontId)"
                >
                  <option
                    v-for="f in UI_FONT_OPTIONS"
                    :key="f"
                    :value="f"
                  >
                    {{ t(`font.${f}`) }}
                  </option>
                </select>
              </label>
              <label class="settings-field">
                <span>{{ t('settings.appearance.editorFont') }}</span>
                <select
                  class="input"
                  :value="appearance.editorFont"
                  @change="appearance.setEditorFont(($event.target as HTMLSelectElement).value as EditorFontId)"
                >
                  <option
                    v-for="f in EDITOR_FONT_OPTIONS"
                    :key="f"
                    :value="f"
                  >
                    {{ t(`font.${f}`) }}
                  </option>
                </select>
              </label>
              <label class="settings-field">
                <span>{{ t('settings.appearance.monoFont') }}</span>
                <select
                  class="input"
                  :value="appearance.monoFont"
                  @change="appearance.setMonoFont(($event.target as HTMLSelectElement).value as MonoFontId)"
                >
                  <option
                    v-for="f in MONO_FONT_OPTIONS"
                    :key="f"
                    :value="f"
                  >
                    {{ t(`font.${f}`) }}
                  </option>
                </select>
              </label>
              <label class="settings-field">
                <span>{{ t('settings.appearance.fontSize', { size: appearance.bodyFontSize }) }}</span>
                <input
                  class="input"
                  :value="appearance.bodyFontSize"
                  type="number"
                  min="12"
                  max="20"
                  @change="appearance.setBodyFontSize(Math.min(20, Math.max(12, Number(($event.target as HTMLInputElement).value) || 15)))"
                >
              </label>
              <label class="settings-field">
                <span>{{ t('settings.appearance.lineHeight', { lh: appearance.lineHeight }) }}</span>
                <input
                  class="input"
                  :value="appearance.lineHeight"
                  type="number"
                  min="1.2"
                  max="2.4"
                  step="0.1"
                  @change="appearance.setLineHeight(Math.min(2.4, Math.max(1.2, Number(($event.target as HTMLInputElement).value) || 1.8)))"
                >
              </label>
              <label class="settings-field settings-toggle">
                <span>{{ t('settings.appearance.highContrast') }}</span>
                <input
                  type="checkbox"
                  :checked="appearance.highContrast"
                  @change="appearance.setHighContrast(($event.target as HTMLInputElement).checked)"
                >
              </label>
              <label class="settings-field">
                <span>{{ t('settings.appearance.contentDirection') }}</span>
                <select
                  class="input"
                  :value="appearance.contentDirection"
                  @change="appearance.setContentDirection(($event.target as HTMLSelectElement).value as ContentDirection)"
                >
                  <option value="auto">{{ t('settings.appearance.directionAuto') }}</option>
                  <option value="ltr">{{ t('settings.appearance.directionLtr') }}</option>
                  <option value="rtl">{{ t('settings.appearance.directionRtl') }}</option>
                </select>
              </label>
              <span class="settings-label">{{ t('settings.editor.behavior') }}</span>
              <label class="settings-field settings-toggle">
                <span>{{ t('settings.editor.focusMode') }}</span>
                <input
                  :checked="appearance.focusMode"
                  type="checkbox"
                  class="checkbox"
                  @change="appearance.setFocusMode(($event.target as HTMLInputElement).checked)"
                >
              </label>
            </section>

            <section
              v-else-if="activeSection === 'editor'"
              class="settings-section"
            >
              <span class="settings-label">{{ t('settings.editor.view') }}</span>
              <div class="view-modes">
                <button
                  class="switch-option"
                  :class="{ 'is-active': view.mode === 'source' }"
                  @click="setMode('source')"
                >
                  {{ t('settings.editor.viewSource') }}
                </button>
                <button
                  class="switch-option"
                  :class="{ 'is-active': view.mode === 'rendered' }"
                  @click="setMode('rendered')"
                >
                  {{ t('settings.editor.viewRendered') }}
                </button>
                <button
                  class="switch-option"
                  :class="{ 'is-active': view.mode === 'split' }"
                  @click="setMode('split')"
                >
                  {{ t('settings.editor.viewSplit') }}
                </button>
              </div>
              <span class="settings-label">{{ t('settings.editor.defaultView') }}</span>
              <div class="view-modes">
                <button
                  class="switch-option"
                  :class="{ 'is-active': view.defaultMode === 'source' }"
                  @click="view.setDefaultMode('source')"
                >
                  {{ t('settings.editor.viewSource') }}
                </button>
                <button
                  class="switch-option"
                  :class="{ 'is-active': view.defaultMode === 'rendered' }"
                  @click="view.setDefaultMode('rendered')"
                >
                  {{ t('settings.editor.viewRendered') }}
                </button>
                <button
                  class="switch-option"
                  :class="{ 'is-active': view.defaultMode === 'split' }"
                  @click="view.setDefaultMode('split')"
                >
                  {{ t('settings.editor.viewSplit') }}
                </button>
              </div>
              <span class="settings-label">{{ t('settings.editor.save') }}</span>
              <label class="settings-field">
                <span>{{ t('settings.editor.autosaveInterval') }}</span>
                <select
                  v-model="settings.autosaveInterval"
                  class="input"
                >
                  <option :value="'off'">
                    {{ t('settings.editor.autosaveOff') }}
                  </option>
                  <option :value="5000">
                    {{ t('settings.editor.autosave5s') }}
                  </option>
                  <option :value="15000">
                    {{ t('settings.editor.autosave15s') }}
                  </option>
                  <option :value="30000">
                    {{ t('settings.editor.autosave30s') }}
                  </option>
                  <option :value="60000">
                    {{ t('settings.editor.autosave60s') }}
                  </option>
                </select>
              </label>
              <label class="settings-field">
                <span>{{ t('settings.editor.maxHistory') }}</span>
                <input
                  class="input"
                  :value="settings.maxHistory"
                  type="number"
                  min="1"
                  max="100"
                  @change="settings.maxHistory = Math.min(100, Math.max(1, Math.round(Number(($event.target as HTMLInputElement).value) || 10)))"
                >
              </label>
              <span class="settings-label">{{ t('settings.editor.behavior') }}</span>
              <label class="settings-field settings-toggle">
                <span>{{ t('settings.editor.spellCheck') }}</span>
                <input
                  :checked="appearance.spellCheckEnabled"
                  type="checkbox"
                  class="checkbox"
                  @change="appearance.setSpellCheckEnabled(($event.target as HTMLInputElement).checked)"
                >
              </label>
              <label class="settings-field settings-toggle">
                <span>{{ t('settings.editor.softWrap') }}</span>
                <input
                  :checked="appearance.softWrap"
                  type="checkbox"
                  class="checkbox"
                  @change="appearance.setSoftWrap(($event.target as HTMLInputElement).checked)"
                >
              </label>
              <label class="settings-field settings-toggle">
                <span>{{ t('settings.editor.lineNumbers') }}</span>
                <input
                  :checked="appearance.lineNumbers"
                  type="checkbox"
                  class="checkbox"
                  @change="appearance.setLineNumbers(($event.target as HTMLInputElement).checked)"
                >
              </label>
              <label class="settings-field settings-toggle">
                <span>{{ t('settings.editor.renderTaskChecklist') }}</span>
                <input
                  :checked="appearance.renderTaskChecklist"
                  type="checkbox"
                  class="checkbox"
                  @change="appearance.setRenderTaskChecklist(($event.target as HTMLInputElement).checked)"
                >
              </label>
              <label class="settings-field settings-toggle">
                <span>{{ t('settings.editor.autoSyncScroll') }}</span>
                <input
                  :checked="appearance.autoSyncScroll"
                  type="checkbox"
                  class="checkbox"
                  @change="appearance.setAutoSyncScroll(($event.target as HTMLInputElement).checked)"
                >
              </label>
              <label class="settings-field">
                <span>{{ t('settings.editor.wordGoal', { goal: appearance.wordGoal }) }}</span>
                <input
                  class="input"
                  :value="appearance.wordGoal"
                  type="number"
                  min="0"
                  max="100000"
                  step="100"
                  @change="appearance.setWordGoal(Number(($event.target as HTMLInputElement).value) || 0)"
                >
              </label>
              <label class="settings-field settings-toggle">
                <span>{{ t('settings.editor.autosaveOnBlur') }}</span>
                <input
                  :checked="appearance.autosaveOnBlur"
                  type="checkbox"
                  class="checkbox"
                  @change="appearance.setAutosaveOnBlur(($event.target as HTMLInputElement).checked)"
                >
              </label>
              <label class="settings-field settings-toggle">
                <span>{{ t('settings.editor.statusBarWords') }}</span>
                <input
                  :checked="appearance.statusBarWords"
                  type="checkbox"
                  class="checkbox"
                  @change="appearance.setStatusBarWords(($event.target as HTMLInputElement).checked)"
                >
              </label>
              <label class="settings-field settings-toggle">
                <span>{{ t('settings.editor.confirmBeforeDelete') }}</span>
                <input
                  :checked="appearance.confirmBeforeDelete"
                  type="checkbox"
                  class="checkbox"
                  @change="appearance.setConfirmBeforeDelete(($event.target as HTMLInputElement).checked)"
                >
              </label>
            </section>

            <section
              v-else-if="activeSection === 'export'"
              class="settings-section"
            >
              <span class="settings-label">{{ t('settings.export.current') }}</span>
              <div class="view-modes">
                <button
                  class="btn btn-secondary btn-sm"
                  :disabled="!hasActiveTab"
                  @click="onExportHtml"
                >
                  {{ t('settings.export.html') }}
                </button>
                <button
                  class="btn btn-secondary btn-sm"
                  :disabled="!hasActiveTab"
                  @click="onExportPdf"
                >
                  {{ t('settings.export.pdf') }}
                </button>
              </div>
              <span
                v-if="!hasActiveTab"
                class="settings-note"
              >{{ t('settings.export.none') }}</span>
              <span class="settings-label">{{ t('settings.export.defaults') }}</span>
              <label class="settings-field settings-toggle">
                <span>{{ t('settings.export.frontmatter') }}</span>
                <input
                  :checked="settings.exportIncludeFrontmatter"
                  type="checkbox"
                  class="checkbox"
                  @change="settings.exportIncludeFrontmatter = ($event.target as HTMLInputElement).checked"
                >
              </label>
              <label class="settings-field">
                <span>{{ t('settings.export.pageSize') }}</span>
                <select
                  v-model="settings.exportPdfPageSize"
                  class="input"
                >
                  <option value="A4">
                    {{ t('settings.export.pageSizeA4') }}
                  </option>
                  <option value="Letter">
                    {{ t('settings.export.pageSizeLetter') }}
                  </option>
                </select>
              </label>
              <label class="settings-field">
                <span>{{ t('settings.export.orientation') }}</span>
                <select
                  v-model="settings.exportPdfOrientation"
                  class="input"
                >
                  <option value="portrait">
                    {{ t('settings.export.portrait') }}
                  </option>
                  <option value="landscape">
                    {{ t('settings.export.landscape') }}
                  </option>
                </select>
              </label>
            </section>

            <section
              v-else-if="activeSection === 'plugins'"
              class="settings-section"
            >
              <span class="settings-label">{{ t('settings.section.plugins') }}</span>
              <span class="settings-note">{{ t('settings.plugins.hint') }}</span>
              <span
                v-if="pluginsLoading"
                class="settings-note"
              >{{ t('settings.plugins.loading') }}</span>
              <span
                v-else-if="!vaultPath"
                class="settings-note"
              >{{ t('settings.plugins.vaultMissing') }}</span>
              <span
                v-else-if="!pluginRows.length"
                class="settings-note"
              >{{ t('settings.plugins.empty') }}</span>
              <div
                v-for="row in pluginRows"
                :key="row.id"
                class="plugin-row"
              >
                <label class="settings-field settings-toggle plugin-row-toggle">
                  <span>{{ row.name }} <span class="plugin-version">v{{ row.version }}</span></span>
                  <input
                    :checked="!row.disabled"
                    type="checkbox"
                    class="checkbox"
                    @change="togglePlugin(row, ($event.target as HTMLInputElement).checked)"
                  >
                </label>
                <span class="settings-note plugin-state">
                  {{ row.disabled ? t('settings.plugins.disabledNote') : (row.active ? t('settings.plugins.activeNote') : t('settings.plugins.inactiveNote')) }}
                </span>
                <span
                  v-if="row.unstable"
                  class="settings-note plugin-state is-warn"
                >{{ t('settings.plugins.unstableNote') }}</span>
              </div>
            </section>

            <section
              v-else-if="activeSection === 'ai'"
              class="settings-section"
            >
              <span class="settings-label">{{ t('settings.section.ai') }}</span>
              <label class="settings-field">
                <span>{{ t('aiSettings.provider') }}</span>
                <select
                  v-model="settings.provider"
                  class="input"
                >
                  <option
                    v-for="p in AI_PROVIDERS"
                    :key="p"
                    :value="p"
                  >
                    {{ p }}
                  </option>
                </select>
              </label>
              <label class="settings-field">
                <span>{{ t('aiSettings.model') }}</span>
                <div class="model-row">
                  <input
                    v-model="settings.model"
                    class="input"
                    type="text"
                    list="model-list"
                    placeholder="qwen2.5-coder:3b"
                  >
                  <datalist id="model-list">
                    <option
                      v-for="m in modelOptions"
                      :key="m"
                      :value="m"
                    >
                      {{ m }}
                    </option>
                  </datalist>
                  <button
                    class="btn btn-secondary btn-sm model-refresh"
                    :disabled="modelLoading"
                    :title="t('aiSettings.refreshModels')"
                    @click="refreshModels"
                  >
                    <RefreshCw
                      :size="13"
                      :stroke-width="1.8"
                      class="model-refresh-icon"
                      :class="{ spin: modelLoading }"
                    />
                    <span>{{ t('aiSettings.refresh') }}</span>
                  </button>
                </div>
              </label>
              <label
                v-if="showBaseUrl"
                class="settings-field"
              >
                <span>{{ t('aiSettings.baseUrl') }}</span>
                <input
                  v-model="settings.baseUrl"
                  class="input"
                  type="text"
                  placeholder="http://localhost:1234/v1"
                >
              </label>
              <label
                v-if="showBaseUrl"
                class="settings-field settings-toggle"
              >
                <span>{{ t('aiSettings.allowPrivate') }}</span>
                <input
                  v-model="settings.allowPrivate"
                  type="checkbox"
                  class="checkbox"
                >
              </label>
              <span
                v-if="showBaseUrl"
                class="settings-note"
              >{{ t('aiSettings.allowPrivateHint') }}</span>
              <label class="settings-field">
                <span>{{ t('aiSettings.apiKey') }}</span>
                <input
                  v-model="settings.apiKey"
                  class="input"
                  type="password"
                  placeholder="sk-..."
                >
              </label>
              <button
                class="btn btn-secondary settings-save"
                @click="saveAiKey"
              >
                {{ t('aiSettings.saveKey') }}
              </button>
              <span class="settings-note">{{ t('aiSettings.keyNote') }}</span>
              <label class="settings-field settings-toggle">
                <span>{{ t('aiSettings.systemPrompt') }}</span>
                <input
                  v-model="settings.systemPromptOn"
                  type="checkbox"
                  class="checkbox"
                >
              </label>
              <label
                v-if="settings.systemPromptOn"
                class="settings-field"
              >
                <span>{{ t('aiSettings.systemPromptHint') }}</span>
                <textarea
                  v-model="settings.systemPrompt"
                  class="input textarea"
                  rows="3"
                  :placeholder="t('aiSettings.systemPromptPlaceholder')"
                />
              </label>
              <label class="settings-field">
                <span>{{ t('aiSettings.temperature') }}</span>
                <input
                  class="input"
                  :value="settings.temperature"
                  type="number"
                  min="0"
                  max="2"
                  step="0.1"
                  @change="settings.temperature = Math.min(2, Math.max(0, Number(($event.target as HTMLInputElement).value) || 0.7))"
                >
              </label>
              <label class="settings-field">
                <span>{{ t('aiSettings.effort') }}</span>
                <select
                  class="input"
                  :value="settings.reasoningEffort"
                  @change="settings.reasoningEffort = ($event.target as HTMLSelectElement).value as typeof settings.reasoningEffort"
                >
                  <option
                    v-for="opt in EFFORT_OPTIONS"
                    :key="opt.value"
                    :value="opt.value"
                  >
                    {{ t(opt.labelKey) }}
                  </option>
                </select>
                <span class="settings-note">{{ t('aiSettings.effortHint') }}</span>
              </label>
              <label class="settings-field">
                <span>{{ t('aiSettings.contextChars') }}</span>
                <input
                  class="input"
                  :value="settings.contextChars"
                  type="number"
                  :min="CONTEXT_CHARS_MIN"
                  :max="CONTEXT_CHARS_MAX"
                  step="1000"
                  @change="settings.contextChars = Math.min(CONTEXT_CHARS_MAX, Math.max(CONTEXT_CHARS_MIN, Math.round(Number(($event.target as HTMLInputElement).value) || DEFAULT_CONTEXT_CHARS)))"
                >
                <span class="settings-note">{{ t('aiSettings.contextCharsHint', { min: CONTEXT_CHARS_MIN, max: CONTEXT_CHARS_MAX }) }}</span>
              </label>
              <label class="settings-field settings-toggle">
                <span>{{ t('aiperm.enabled') }}</span>
                <input
                  :checked="aiPermission.enabled"
                  type="checkbox"
                  class="checkbox"
                  @change="aiPermission.setEnabled(($event.target as HTMLInputElement).checked)"
                >
              </label>
              <span class="settings-note">{{ t('aiperm.enabledHint') }}</span>
              <label class="settings-field">
                <span>{{ t('aiperm.policy') }}</span>
                <select
                  class="input"
                  :value="aiPermission.policy"
                  @change="aiPermission.setPolicy(($event.target as HTMLSelectElement).value as AiWritePolicy)"
                >
                  <option
                    v-for="opt in WRITE_POLICIES"
                    :key="opt.value"
                    :value="opt.value"
                  >
                    {{ t(opt.labelKey) }}
                  </option>
                </select>
                <span class="settings-note">{{ t('aiperm.policyHint') }}</span>
              </label>
              <div class="settings-field settings-audit">
                <span>{{ t('aiperm.audit.title') }}</span>
                <span class="settings-note">{{ t('aiperm.audit.hint') }}</span>
                <span
                  v-if="recentAiAudit.length"
                  class="settings-note"
                >{{ t('aiperm.audit.counts', aiPermission.auditSummary) }}</span>
                <ul
                  v-if="recentAiAudit.length"
                  class="ai-audit-list"
                >
                  <li
                    v-for="entry in recentAiAudit"
                    :key="entry.seq"
                    class="ai-audit-row"
                    :class="'is-' + entry.outcome"
                  >
                    <span class="ai-audit-time">{{ clockTime(entry.at) }}</span>
                    <span class="ai-audit-source">{{ t(AUDIT_SOURCE_KEYS[entry.source]) }}</span>
                    <span
                      v-if="entry.kind"
                      class="ai-audit-kind"
                    >{{ t(AUDIT_KIND_KEYS[entry.kind]) }}</span>
                    <span class="ai-audit-outcome">{{ t(AUDIT_OUTCOME_KEYS[entry.outcome]) }}</span>
                    <span
                      v-if="entry.detail"
                      class="ai-audit-detail"
                    >{{ entry.detail }}</span>
                  </li>
                </ul>
                <span
                  v-else
                  class="settings-note"
                >{{ t('aiperm.audit.empty') }}</span>
                <button
                  class="btn btn-secondary btn-sm"
                  :disabled="!recentAiAudit.length"
                  @click="aiPermission.forgetAudit()"
                >
                  {{ t('aiperm.audit.clear') }}
                </button>
              </div>
              <div class="settings-field">
                <span>{{ t('aiperm.grants') }}</span>
                <span class="settings-note">
                  {{ aiPermission.sessionGrants.size
                    ? [...aiPermission.sessionGrants].join(', ')
                    : t('aiperm.noGrants') }}
                </span>
                <button
                  class="btn btn-secondary btn-sm"
                  :disabled="aiPermission.sessionGrants.size === 0"
                  @click="aiPermission.forgetGrants()"
                >
                  {{ t('aiperm.revoke') }}
                </button>
              </div>
              <label class="settings-field">
                <span>{{ t('aiSettings.maxTokens') }}</span>
                <input
                  class="input"
                  :value="settings.maxTokens"
                  type="number"
                  min="128"
                  max="8192"
                  step="64"
                  @change="settings.maxTokens = Math.min(8192, Math.max(128, Math.round(Number(($event.target as HTMLInputElement).value) || 1024)))"
                >
              </label>
            </section>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.settings-overlay {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: color-mix(in srgb, var(--app-canvas) 45%, transparent);
  backdrop-filter: blur(2px);
}

.settings-dialog {
  display: flex;
  flex-direction: column;
  width: min(720px, 100%);
  height: min(520px, 100%);
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--app-border) 86%, transparent);
  border-radius: var(--app-radius-xl);
  background: color-mix(in srgb, var(--app-elevated) 97%, var(--app-panel));
  box-shadow: var(--app-shadow-dialog);
  color: var(--app-text);
  outline: none;
}

.dialog-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid color-mix(in srgb, var(--app-border) 60%, transparent);
  user-select: none;
}
.dialog-title {
  font-size: 13px;
  font-weight: 650;
  letter-spacing: -0.01em;
  color: var(--app-text);
}
.dialog-spacer { flex: 1; }
.settings-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: none;
  background: transparent;
  cursor: pointer;
  padding: 0;
  color: var(--app-muted);
  border-radius: var(--app-radius-sm);
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.settings-close:hover {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-panel) 70%, transparent);
}
.settings-close:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}

.dialog-body {
  flex: 1;
  min-height: 0;
  display: flex;
}

.dialog-nav {
  display: flex;
  flex-direction: column;
  gap: 1px;
  width: 152px;
  flex: none;
  padding: 10px 8px;
  border-right: 1px solid color-mix(in srgb, var(--app-border) 60%, transparent);
  overflow-y: auto;
  user-select: none;
}
.nav-row {
  display: grid;
  grid-template-columns: 15px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 32px;
  padding: 0 10px;
  border: none;
  border-radius: var(--app-radius-lg);
  background: transparent;
  color: color-mix(in srgb, var(--app-text) 72%, var(--app-muted));
  font-family: var(--app-font);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: -0.01em;
  text-align: left;
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.nav-row:hover {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-panel) 62%, transparent);
}
.nav-row:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
.nav-row.active {
  background: color-mix(in srgb, var(--app-accent-soft) 76%, var(--app-elevated));
  color: var(--app-text);
  font-weight: 600;
}
.nav-row.active .nav-row-icon {
  color: var(--app-accent);
}
.nav-row-icon {
  color: color-mix(in srgb, var(--app-accent) 82%, var(--app-text));
}

.dialog-content {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 16px 20px 20px;
}
.settings-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.settings-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--app-text); }
.settings-field > span { color: var(--app-muted); font-size: 11px; }
.settings-note { font-size: 11px; line-height: 1.5; color: var(--app-muted); }

/* The AI activity list: one line per event, newest first. Outcomes are
 * colour-coded rather than icon-coded, because the whole list is read at a
 * glance to answer "did anything get through that I did not want?". */
.ai-audit-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 2px 0 0;
  padding: 0;
  list-style: none;
  max-height: 168px;
  overflow-y: auto;
}
.ai-audit-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--app-muted);
}
.ai-audit-time {
  font-variant-numeric: tabular-nums;
  opacity: 0.75;
  flex: none;
}
.ai-audit-source {
  flex: none;
  color: var(--app-text);
}
.ai-audit-kind,
.ai-audit-detail {
  flex: none;
  opacity: 0.8;
}
.ai-audit-detail {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ai-audit-outcome {
  flex: none;
  margin-left: auto;
}
.ai-audit-row.is-allowed .ai-audit-outcome {
  color: var(--app-accent);
}
.ai-audit-row.is-denied .ai-audit-outcome,
.ai-audit-row.is-blocked .ai-audit-outcome {
  color: var(--app-danger, #c0392b);
}
.settings-save { align-self: flex-start; }
.vault-row { display: flex; gap: 6px; }
.vault-row .input { flex: 1; min-width: 0; }
.vault-browse { flex: none; }
.model-row { display: flex; gap: 6px; }
.model-row .input { flex: 1; min-width: 0; }
.model-refresh { flex: none; padding: 0 10px; }
.model-refresh:disabled { cursor: default; opacity: 0.6; }
.model-refresh-icon.spin {
  animation: model-spin 0.9s linear infinite;
}
@keyframes model-spin {
  to { transform: rotate(360deg); }
}
.settings-label {
  margin-top: 6px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: color-mix(in srgb, var(--app-muted) 82%, transparent);
}
.settings-section .settings-label:first-child { margin-top: 0; }
.settings-toggle {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
}
.settings-toggle > span { color: var(--app-text); font-size: 12px; }
.checkbox {
  width: 16px;
  height: 16px;
  accent-color: var(--app-accent);
  cursor: pointer;
}
.textarea {
  resize: vertical;
  min-height: 64px;
  font-family: var(--app-font);
  line-height: 1.5;
}
.view-modes { display: flex; gap: 6px; flex-wrap: wrap; }
.view-modes button:disabled { opacity: 0.5; cursor: not-allowed; }
.accent-row { display: flex; gap: 6px; }
.accent-row.is-disabled { opacity: 0.5; pointer-events: none; }
.color-scheme-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(86px, 1fr));
  gap: 8px;
}
.color-scheme-card {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
  padding: 6px;
  border: 1px solid color-mix(in srgb, var(--app-border) 80%, transparent);
  border-radius: var(--app-radius-lg);
  background: color-mix(in srgb, var(--app-elevated) 82%, var(--app-panel));
  color: var(--app-text);
  font-family: var(--app-font);
  font-size: 11px;
  cursor: pointer;
  transition: border-color var(--app-motion-fast) var(--app-ease),
              box-shadow var(--app-motion-fast) var(--app-ease),
              background var(--app-motion-fast) var(--app-ease);
}
.color-scheme-card:hover {
  border-color: color-mix(in srgb, var(--app-accent) 45%, var(--app-border));
}
.color-scheme-card:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
.color-scheme-card.is-selected {
  border-color: var(--app-accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--app-accent) 24%, transparent);
}
.color-scheme-preview {
  display: block;
}
.color-scheme-swatch {
  display: block;
  width: 100%;
  height: 44px;
  border-radius: var(--app-radius-sm);
  border: 1px solid;
}
.color-scheme-name {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  text-align: center;
  color: var(--app-muted);
}

</style>
