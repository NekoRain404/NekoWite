<script setup lang="ts">
import { useFloatStore } from '../stores/float'

const floatStore = useFloatStore()
</script>

<template>
  <div
    v-if="floatStore.selectedId"
    class="float-toolbar"
  >
    <button
      class="btn btn-secondary btn-sm"
      title="置前"
      @click="floatStore.bringForward()"
    >
      置前
    </button>
    <button
      class="btn btn-secondary btn-sm"
      title="置后"
      @click="floatStore.sendBackward()"
    >
      置后
    </button>
    <button
      class="btn btn-danger btn-sm"
      title="删除"
      @click="floatStore.removeSelected()"
    >
      删除
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
