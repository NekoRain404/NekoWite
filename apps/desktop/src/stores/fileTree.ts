import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * File-tree / vault-listing state: the truncation warning surfaced when a
 * directory walk hit its cap, and the attachments badge count. Both are produced
 * by the vault index coordinator (application service) as it indexes the vault;
 * this store only holds the reactive projections, never reading files itself.
 */
export const useFileTreeStore = defineStore('fileTree', () => {
  /** True when the last directory walk for the open vault was truncated because
   * it exceeded MAX_DIRS. Surfaces a UI warning instead of silently dropping
   * files. Reset on vault switch; set during index. */
  const vaultTruncated = ref(false)
  /** 侧栏「附件」徽标：attachments/ 顶层条目数（目录也算一个条目）。 */
  const attachmentCount = ref(0)

  function setVaultTruncated(v: boolean): void {
    vaultTruncated.value = v
  }

  function setAttachmentCount(n: number): void {
    attachmentCount.value = n
  }

  /** Reset listing state on a vault switch. */
  function resetForVault(): void {
    vaultTruncated.value = false
    attachmentCount.value = 0
  }

  return { vaultTruncated, attachmentCount, setVaultTruncated, setAttachmentCount, resetForVault }
})
