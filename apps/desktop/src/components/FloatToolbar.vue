<script setup lang="ts">
import { useFloatStore } from '../stores/float'
import { t } from '../i18n'

const floatStore = useFloatStore()
</script>

<template>
  <div
    v-if="floatStore.selectedId"
    class="float-toolbar"
  >
    <button
      class="btn btn-secondary btn-sm"
      :title="t('floatToolbar.bringForward')"
      @click="floatStore.bringForward()"
    >
      {{ t('floatToolbar.bringForward') }}
    </button>
    <button
      class="btn btn-secondary btn-sm"
      :title="t('floatToolbar.sendBackward')"
      @click="floatStore.sendBackward()"
    >
      {{ t('floatToolbar.sendBackward') }}
    </button>
    <button
      class="btn btn-danger btn-sm"
      :title="t('common.delete')"
      @click="floatStore.removeSelected()"
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
