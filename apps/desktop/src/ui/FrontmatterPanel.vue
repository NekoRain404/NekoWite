<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Hash, Plus, X } from 'lucide-vue-next'
import { useTabsStore } from '../stores/tabs'
import { flushSourceEdits } from '../services/sourceView'
import { useDocumentListStore } from '../stores/documentList'
import {
  emptyFrontmatterFields,
  fileNameTitle,
  parseFrontmatterForPanel,
  replaceFrontmatter,
  serializeFrontmatter,
  splitFrontmatterRaw,
  type FrontmatterFields,
} from '../services/noteMeta'
import { normalizeTag, normalizeTags } from '../services/tags'
import { t } from '../i18n'
import { isComposingKey } from '../services/keyGuard'
import { baseName } from '../services/paths'

const tabs = useTabsStore()
const documentList = useDocumentListStore()

const tab = computed(() => tabs.activeTab)

const form = ref<FrontmatterFields>(emptyFrontmatterFields())
const hasFront = ref(false)
const tagInput = ref('')

const suggestions = computed(() => documentList.tagCounts.map((c) => c.tag))
const otherEntries = computed(() => Object.entries(form.value.other))

const isDirty = computed(() => {
  const content = tab.value?.content ?? ''
  const { front } = splitFrontmatterRaw(content)
  return serializeFrontmatter(form.value) !== front
})

function syncFromContent(content: string): void {
  const { front } = splitFrontmatterRaw(content)
  hasFront.value = front !== ''
  form.value = parseFrontmatterForPanel(front)
}

watch(
  () => tab.value?.content,
  (content) => {
    if (content === undefined) return
    syncFromContent(content)
  },
  { immediate: true },
)

watch(
  () => tab.value?.id,
  () => {
    if (tab.value) syncFromContent(tab.value.content)
  },
)

function writeContent(fields: FrontmatterFields): void {
  const active = tab.value
  if (!active) return
  // Whole-document read-modify-write: publish the source pane's pending
  // keystrokes first so the edit applies to the live text (and the source pane
  // is not then mirrored back to a stale version).
  flushSourceEdits()
  const { content, changed } = replaceFrontmatter(active.content, fields)
  if (!changed) return
  active.content = content
  tabs.markDirty(active.id)
  tabs.scheduleAutosave(active.id)
  syncFromContent(content)
}

function commit(): void {
  const fields: FrontmatterFields = { ...form.value, tags: normalizeTags(form.value.tags) }
  writeContent(fields)
}

function addProperties(): void {
  const active = tab.value
  if (!active) return
  const name = active.path ? baseName(active.path) : ''
  const h1 = /^#\s+(.+?)\s*#*\s*$/m.exec(active.content)
  const title = fileNameTitle(name) || h1?.[1]?.trim() || ''
  const next: FrontmatterFields = { title, tags: [], date: '', created: '', updated: '', other: {}, rawSegments: [] }
  writeContent(next)
}

function addTagRaw(raw: string): void {
  const pieces = raw.split(',').map(normalizeTag).filter(Boolean)
  tagInput.value = ''
  if (pieces.length === 0) return
  const next = normalizeTags([...form.value.tags, ...pieces])
  commitTags(next)
}

function commitTags(next: string[]): void {
  writeContent({ ...form.value, tags: next })
}

function removeTag(tag: string): void {
  commitTags(normalizeTags(form.value.tags.filter((x) => x !== tag)))
}

function onTagKeydown(e: KeyboardEvent): void {
  // Enter accepts the IME candidate, and Backspace edits the composing text —
  // none of those may be read as "add this tag" / "delete the previous tag".
  if (isComposingKey(e)) return
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault()
    addTagRaw(tagInput.value)
    return
  }
  if (e.key === 'Backspace' && tagInput.value === '') {
    const next = form.value.tags.slice(0, -1)
    if (next.length !== form.value.tags.length) commitTags(next)
  }
}

function onTitleKeydown(e: KeyboardEvent): void {
  // Enter commits the title. While an IME candidate list is open it belongs to
  // the IME instead, or the half-finished pinyin string is written to the file.
  if (isComposingKey(e)) return
  if (e.key === 'Enter') {
    e.preventDefault()
    ;(e.target as HTMLInputElement).blur()
    commit()
  }
}
</script>

<template>
  <section class="frontmatter-panel">
    <h3 class="rail-section-title">
      {{ t('frontmatter.title') }}
    </h3>

    <p
      v-if="!tab"
      class="rail-empty"
    >
      {{ t('frontmatter.noDoc') }}
    </p>

    <template v-else>
      <button
        v-if="!hasFront"
        type="button"
        class="fm-add"
        @click="addProperties"
      >
        <Plus
          :size="13"
          :stroke-width="1.8"
        />
        <span>{{ t('frontmatter.addProps') }}</span>
      </button>

      <template v-else>
        <label class="fm-field">
          <span class="fm-label">{{ t('frontmatter.name') }}</span>
          <input
            v-model="form.title"
            class="fm-input"
            type="text"
            @blur="commit"
            @keydown="onTitleKeydown"
          >
        </label>

        <div class="fm-field">
          <span class="fm-label">{{ t('frontmatter.tags') }}</span>
          <div class="fm-tags">
            <span
              v-for="tag in form.tags"
              :key="tag"
              class="fm-chip"
            >
              <Hash
                :size="11"
                :stroke-width="1.8"
              />
              <span class="fm-chip-text">{{ tag }}</span>
              <button
                type="button"
                class="fm-chip-x"
                :title="t('frontmatter.tagRemove')"
                @click="removeTag(tag)"
              >
                <X
                  :size="10"
                  :stroke-width="2"
                />
              </button>
            </span>
            <input
              v-model="tagInput"
              class="fm-tag-input"
              type="text"
              list="fm-tag-suggestions"
              :placeholder="t('frontmatter.tagPlaceholder')"
              @keydown="onTagKeydown"
              @blur="addTagRaw(tagInput)"
            >
            <datalist id="fm-tag-suggestions">
              <option
                v-for="s in suggestions"
                :key="s"
                :value="s"
              />
            </datalist>
            <button
              v-if="tagInput"
              type="button"
              class="fm-tag-add"
              :aria-label="t('frontmatter.addTag')"
              :title="t('frontmatter.addTag')"
              @click="addTagRaw(tagInput)"
            >
              <Plus
                :size="12"
                :stroke-width="1.8"
              />
            </button>
          </div>
        </div>

        <label class="fm-field">
          <span class="fm-label">{{ t('frontmatter.date') }}</span>
          <input
            v-model="form.date"
            class="fm-input"
            type="text"
            placeholder="YYYY-MM-DD"
            @blur="commit"
          >
        </label>

        <label class="fm-field">
          <span class="fm-label">{{ t('frontmatter.created') }}</span>
          <input
            v-model="form.created"
            class="fm-input"
            type="text"
            placeholder="YYYY-MM-DD"
            @blur="commit"
          >
        </label>

        <label class="fm-field">
          <span class="fm-label">{{ t('frontmatter.updated') }}</span>
          <input
            v-model="form.updated"
            class="fm-input"
            type="text"
            placeholder="YYYY-MM-DD"
            @blur="commit"
          >
        </label>

        <details
          v-if="otherEntries.length"
          class="fm-other"
        >
          <summary class="fm-other-summary">
            {{ t('frontmatter.otherKeys') }}
          </summary>
          <div
            v-for="[key, value] in otherEntries"
            :key="key"
            class="fm-other-row"
          >
            <span class="fm-other-key">{{ key }}</span>
            <span class="fm-other-value">{{ value || '—' }}</span>
          </div>
        </details>

        <div class="fm-actions">
          <button
            type="button"
            class="btn btn-primary fm-apply"
            :disabled="!isDirty"
            @click="commit"
          >
            {{ t('frontmatter.apply') }}
          </button>
        </div>
      </template>
    </template>
  </section>
</template>

<style scoped>
.frontmatter-panel {
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.rail-section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--app-muted);
}
.rail-empty {
  margin: 0;
  font-size: 11px;
  color: var(--app-muted);
}

.fm-add {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 30px;
  padding: 0 12px;
  border: 1px dashed color-mix(in srgb, var(--app-border) 78%, transparent);
  border-radius: var(--app-radius);
  background: color-mix(in srgb, var(--app-elevated) 44%, transparent);
  color: var(--app-muted);
  font-family: var(--app-font);
  font-size: 12px;
  font-weight: 550;
  letter-spacing: -0.01em;
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease),
              border-color var(--app-motion-fast) var(--app-ease);
}
.fm-add:hover {
  color: var(--app-text);
  border-color: color-mix(in srgb, var(--app-accent) 42%, var(--app-border));
  background: color-mix(in srgb, var(--app-accent-soft) 60%, var(--app-elevated));
}

.fm-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.fm-label {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.03em;
  color: var(--app-muted);
}
.fm-input {
  width: 100%;
  height: 30px;
  padding: 0 9px;
  font-family: var(--app-font);
  font-size: 12px;
  font-weight: 450;
  letter-spacing: -0.01em;
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-elevated) 42%, var(--app-panel));
  border: 1px solid color-mix(in srgb, var(--app-border) 54%, transparent);
  border-radius: var(--app-radius);
  outline: none;
  transition: border-color var(--app-motion-fast) var(--app-ease),
              background var(--app-motion-fast) var(--app-ease),
              box-shadow var(--app-motion-fast) var(--app-ease);
}
.fm-input::placeholder { color: var(--app-muted); }
.fm-input:focus {
  border-color: color-mix(in srgb, var(--app-accent) 55%, var(--app-border));
  background: color-mix(in srgb, var(--app-elevated) 72%, var(--app-panel));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--app-accent) 14%, transparent);
}

.fm-tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
  padding: 4px 5px;
  border: 1px solid color-mix(in srgb, var(--app-border) 54%, transparent);
  border-radius: var(--app-radius);
  background: color-mix(in srgb, var(--app-elevated) 42%, var(--app-panel));
}
.fm-tags:focus-within {
  border-color: color-mix(in srgb, var(--app-accent) 55%, var(--app-border));
  background: color-mix(in srgb, var(--app-elevated) 72%, var(--app-panel));
}
.fm-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 4px 0 7px;
  border-radius: var(--app-radius-xs);
  background: color-mix(in srgb, var(--app-accent-soft) 72%, var(--app-elevated));
  color: color-mix(in srgb, var(--app-accent) 82%, var(--app-text));
  font-size: 11px;
  font-weight: 550;
  letter-spacing: -0.01em;
}
.fm-chip-text {
  max-width: 160px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.fm-chip-x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  padding: 0;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--app-muted);
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.fm-chip-x:hover {
  color: var(--app-danger);
  background: color-mix(in srgb, var(--app-danger) 14%, transparent);
}
.fm-tag-input {
  flex: 1;
  min-width: 80px;
  height: 22px;
  border: none;
  background: transparent;
  color: var(--app-text);
  font-family: var(--app-font);
  font-size: 11px;
  outline: none;
}
.fm-tag-input::placeholder { color: var(--app-muted); }
.fm-tag-add {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: var(--app-radius-xs);
  background: transparent;
  color: var(--app-accent);
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease);
}
.fm-tag-add:hover {
  background: color-mix(in srgb, var(--app-accent-soft) 70%, transparent);
}

.fm-other {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.fm-other-summary {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.03em;
  color: var(--app-muted);
  cursor: pointer;
}
.fm-other-row {
  display: grid;
  grid-template-columns: minmax(0, 34%) minmax(0, 1fr);
  gap: 8px;
  padding: 3px 2px;
  font-size: 11px;
}
.fm-other-key {
  color: color-mix(in srgb, var(--app-text) 78%, var(--app-muted));
  font-weight: 550;
}
.fm-other-value {
  color: var(--app-muted);
  overflow-wrap: anywhere;
}

.fm-actions {
  display: flex;
  justify-content: flex-end;
}
.fm-apply {
  height: 28px;
  padding: 0 14px;
  font-size: 11.5px;
}
.fm-apply:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
