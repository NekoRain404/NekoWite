<script setup lang="ts">
import { useTabsStore } from '../stores/tabs'

const props = defineProps<{ tabId: string; path: string }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const tabs = useTabsStore()

async function reloadFromDisk(): Promise<void> {
  await tabs.reloadFromDisk(props.tabId)
  emit('close')
}

function keepLocal(): void {
  emit('close')
}

function later(): void {
  emit('close')
}
</script>

<template>
  <div class="conflict-dialog">
    <div class="conflict-title">
      文件已在外部被修改
    </div>
    <div class="conflict-body">
      <span class="conflict-path">
        {{ path }}
      </span>
      的磁盘内容已变化，而当前有未保存的本地修改。
    </div>
    <div class="conflict-actions">
      <button
        class="conflict-btn primary"
        @click="reloadFromDisk"
      >
        以磁盘为准（放弃本地）
      </button>
      <button
        class="conflict-btn"
        @click="keepLocal"
      >
        保留本地
      </button>
      <button
        class="conflict-btn subtle"
        @click="later"
      >
        稍后再说
      </button>
    </div>
    <div class="conflict-note">
      以磁盘为准将加载磁盘内容并放弃本地修改；保留本地则维持当前内容并保持未保存状态。
    </div>
  </div>
</template>

<style scoped>
.conflict-dialog {
  position: fixed;
  bottom: 32px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 1500;
  width: min(420px, 90vw);
  background: #fff;
  border: 1px solid #e0a33a;
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
  padding: 12px 14px;
  font-size: 13px;
  color: #333;
}
.conflict-title {
  font-weight: 600;
  margin-bottom: 6px;
}
.conflict-path {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: #f5f5f5;
  padding: 1px 4px;
  border-radius: 3px;
  word-break: break-all;
}
.conflict-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
.conflict-btn {
  border: 1px solid #ccc;
  background: #fff;
  padding: 5px 12px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
}
.conflict-btn:hover { background: #f0f0f0; }
.conflict-btn.primary {
  background: #e67e22;
  border-color: #e67e22;
  color: #fff;
}
.conflict-btn.primary:hover { background: #d46f1b; }
.conflict-btn.subtle {
  margin-left: auto;
  color: #888;
}
.conflict-note {
  margin-top: 8px;
  color: #888;
  font-size: 12px;
}
</style>
