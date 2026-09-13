<script setup lang="ts">
import { t } from '../i18n'

// Presentational (§10.2): the toolbar owns no selection of its own. The
// selection lives in the float store, whose actions edit the rendered document
// through the editor session — so the caller passes the current selection in
// and hears each press back as an event, rather than this component reaching
// into a store it does not own.
defineProps<{ selectedId: string | null }>()

const emit = defineEmits<{
  (e: 'bring-forward'): void
  (e: 'send-backward'): void
  (e: 'remove'): void
}>()
</script>

<template>
  <div
    v-if="selectedId"
    class="float-toolbar"
  >
    <button
      class="btn btn-secondary btn-sm"
      :title="t('floatToolbar.bringForward')"
      @click="emit('bring-forward')"
    >
      {{ t('floatToolbar.bringForward') }}
    </button>
    <button
      class="btn btn-secondary btn-sm"
      :title="t('floatToolbar.sendBackward')"
      @click="emit('send-backward')"
    >
      {{ t('floatToolbar.sendBackward') }}
    </button>
    <button
      class="btn btn-danger btn-sm"
      :title="t('common.delete')"
      @click="emit('remove')"
    >
      {{ t('common.delete') }}
    </button>
  </div>
</template>

<style scoped>
.float-toolbar {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 9999;
  display: flex;
  gap: 4px;
  padding: 4px;
  background: var(--app-elevated);
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius);
  box-shadow: 0 2px 8px rgb(0 0 0 / 18%);
}
</style>
