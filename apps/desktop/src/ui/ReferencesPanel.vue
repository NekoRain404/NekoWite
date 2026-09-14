<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { CITE_UNRESOLVED, computeCiteOrder, doiUrl } from '@nekowite/editor-core'
import { useRefsStore } from '../stores/refs'
import { editorSessionManager } from '../features/editor/session-manager'
import { t } from '../i18n'

const refs = useRefsStore()
const bump = ref(0)
let unlistenChange: (() => void) | null = null
let offEditorChange: (() => void) | null = null

interface Cited {
  key: string
  /** `CITE_UNRESOLVED` when the key is not in the library. */
  num: number
  numLabel: string
  /** Whether the library actually holds this key. An entry can be present and
   *  still have an empty title (RIS without a `TI`), which used to render the
   *  "not in the library" message for a reference the library does have. */
  found: boolean
  title: string | null
  authors: string[]
  year: string | null
  doi: string | null
  journal: string | null
}

const cited = computed<Cited[]>(() => {
  // Re-run whenever the editor signals a doc change (bump) or refs load.
  void bump.value
  const view = editorSessionManager.getView()
  if (!view) return []
  // Reuse editor-core's numbering so chips in the doc and this panel agree.
  const order = computeCiteOrder(view)
  return [...order.entries()].map(([key, num]) => {
    const ref = refs.get(key)
    return {
      key,
      num,
      numLabel: num === CITE_UNRESOLVED ? '?' : String(num),
      found: ref !== undefined,
      title: ref?.title || null,
      authors: ref?.authors ?? [],
      year: ref?.year ?? null,
      doi: ref?.doi ?? null,
      journal: ref?.journal ?? null,
    }
  })
})

function resubscribe(): void {
  unlistenChange?.()
  unlistenChange = null
  const editor = editorSessionManager.getActiveEditor()
  if (editor) {
    unlistenChange = editor.onContentChange(() => {
      bump.value++
    })
  }
}

onMounted(() => {
  // The editor is created lazily (after the first tab opens), so subscribe
  // now if it exists and again whenever it is (re)created.
  resubscribe()
  offEditorChange = editorSessionManager.subscribe(() => {
    resubscribe()
    bump.value++
  })
})

onBeforeUnmount(() => {
  unlistenChange?.()
  unlistenChange = null
  offEditorChange?.()
  offEditorChange = null
})
</script>

<template>
  <section class="references-panel">
    <h3 class="rail-section-title">
      {{ t('references.title') }}
      <span
        v-if="cited.length"
        class="rail-section-count"
      >{{ cited.length }}</span>
    </h3>
    <ol
      v-if="cited.length"
      class="refs-list"
    >
      <li
        v-for="c in cited"
        :key="c.key"
        class="refs-item"
      >
        <span class="refs-num">[{{ c.numLabel }}]</span>
        <span class="refs-body">
          <span class="refs-key">{{ c.key }}</span>
          <span
            v-if="c.found"
            class="refs-detail"
          >
            <template v-if="c.title">
              {{ c.title }}
              <span
                v-if="c.journal"
                class="refs-journal"
              > · {{ c.journal }}</span>
            </template>
            <span
              v-else
              class="refs-no-title"
            >{{ t('references.noTitle') }}</span>
            <span
              v-if="c.authors.length || c.year"
              class="refs-meta"
            >({{ c.authors.join(', ') }}{{ c.year ? `${c.authors.length ? ', ' : ''}${c.year}` : '' }})</span>
            <a
              v-if="c.doi"
              :href="doiUrl(c.doi) ?? '#'"
              class="refs-doi"
              target="_blank"
              rel="noopener"
            >doi:{{ c.doi }}</a>
          </span>
          <span
            v-else
            class="refs-detail refs-missing"
          >
            {{ t('references.missing') }}
          </span>
        </span>
      </li>
    </ol>
    <p
      v-else
      class="rail-empty"
    >
      {{ t('references.empty') }}
    </p>
  </section>
</template>

<style scoped>
.references-panel {
  padding: 12px 14px;
  border-bottom: 1px solid color-mix(in srgb, var(--app-border) 60%, transparent);
}
.rail-section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 8px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--app-muted);
}
.rail-section-count {
  font-weight: 400;
  letter-spacing: 0;
  font-variant-numeric: tabular-nums;
}
.refs-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.refs-item {
  display: flex;
  gap: 6px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--app-text);
}
.refs-num {
  flex: none;
  color: var(--app-muted);
  font-variant-numeric: tabular-nums;
}
.refs-body {
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.refs-key {
  font-weight: 600;
  letter-spacing: -0.01em;
}
.refs-detail {
  color: color-mix(in srgb, var(--app-text) 76%, var(--app-muted));
  overflow-wrap: anywhere;
}
.refs-meta {
  color: color-mix(in srgb, var(--app-text) 58%, var(--app-muted));
  margin-left: 4px;
}
.refs-journal {
  font-style: italic;
  color: color-mix(in srgb, var(--app-text) 84%, var(--app-muted));
}
.refs-doi {
  display: block;
  color: var(--app-accent);
  font-size: 10px;
  overflow-wrap: anywhere;
}
.refs-missing { color: var(--app-muted); }
.refs-no-title { color: var(--app-muted); font-style: italic; }
.rail-empty {
  margin: 0;
  font-size: 11px;
  color: var(--app-muted);
}
</style>
