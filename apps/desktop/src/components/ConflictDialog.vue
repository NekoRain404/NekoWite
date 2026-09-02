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
  <div class="dialog-overlay">
    <div class="dialog conflict-dialog">
      <div class="conflict-title">
        文件已在外部被修改
      </div>
      <div class="conflict-body">
        <span class="conflict-path">
          {{ path }}
        </span>
        的磁盘内容已变化，而当前有未保存的本地修改。
      </div>
      <div class="dialog-actions">
        <button
          class="btn btn-primary"
          @click="reloadFromDisk"
        >
          以磁盘为准（放弃本地）
        </button>
        <button
          class="btn btn-secondary"
          @click="keepLocal"
        >
          保留本地
        </button>
        <button
          class="btn btn-ghost"
          @click="later"
        >
          稍后再说
        </button>
      </div>
      <div class="conflict-note">
        以磁盘为准将加载磁盘内容并放弃本地修改；保留本地则维持当前内容并保持未保存状态。
      </div>
    </div>
  </div>
</template>

<style scoped>
.conflict-dialog {
  position: fixed;
  bottom: 32px;
  left: 50%;
  transform: translateX(-50%);
  width: min(420px, 90vw);
  padding: 12px 14px;
  font-size: 13px;
  color: var(--app-text);
}
.conflict-title {
  font-weight: 600;
  margin-bottom: 6px;
  color: var(--app-text);
}
.conflict-path {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: var(--app-panel);
  padding: 1px 4px;
  border-radius: 3px;
  word-break: break-all;
}
.dialog-actions {
  margin-top: 10px;
}
.conflict-note {
  margin-top: 8px;
  color: var(--app-muted);
  font-size: 12px;
}
</style>
