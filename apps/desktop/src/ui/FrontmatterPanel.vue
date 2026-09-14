<script setup lang="ts">
import { Hash, Plus, X } from 'lucide-vue-next'
// Cycle-blocked deep import (§13.11): `features/notes` cannot export this
// composable. The model edits tags through `services/tags`, which imports the
// frontmatter helpers back through the feature's entry, so an entry that took
// the composable would close `index → composable → services/tags → index`. The
// composable's own modules reach nothing that reaches the entry, so reading it
// directly is the one edge that does not close the loop.
import { useFrontmatterPanel } from '../features/notes/composables/use-frontmatter-panel'
import { t } from '../i18n'

// The model — the fields, the tag input, and the writes back into the document
// — is the composable's, so it can be read without mounting a component. This
// file is the markup, the styles it loads and the event wiring.
const {
  hasDoc,
  form,
  hasFront,
  tagInput,
  suggestions,
  otherEntries,
  isDirty,
  addProperties,
  commit,
  addTagRaw,
  removeTag,
  onTagKeydown,
  onTitleKeydown,
} = useFrontmatterPanel()
</script>

<template>
  <section class="frontmatter-panel">
    <h3 class="rail-section-title">
      {{ t('frontmatter.title') }}
    </h3>

    <div class="fm-body">
      <p
        v-if="!hasDoc"
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
    </div>
  </section>
</template>

<style scoped src="./frontmatterPanel.css"></style>
