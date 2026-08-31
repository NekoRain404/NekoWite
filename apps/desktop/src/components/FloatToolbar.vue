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
      class="ft-btn"
      title="置前"
      @click="floatStore.bringForward()"
    >
      置前
    </button>
    <button
      class="ft-btn"
      title="置后"
      @click="floatStore.sendBackward()"
    >
      置后
    </button>
    <button
      class="ft-btn ft-btn-danger"
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
  z-index: 50;
  display: flex;
  gap: 4px;
  padding: 4px;
  background: #fff;
  border: 1px solid #d0d0d0;
  border-radius: 6px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
}
.ft-btn {
  padding: 3px 10px;
  border: 1px solid #d0d0d0;
  background: #fff;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  color: #333;
}
.ft-btn:hover {
  background: #f0f0f0;
}
.ft-btn-danger:hover {
  background: #fdecea;
  border-color: #c0392b;
  color: #c0392b;
}
</style>
