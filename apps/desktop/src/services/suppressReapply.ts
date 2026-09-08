// Consume-once guard for save-time rewrites (I2): tabs.ts arms this before
// syncing tab.content with the onSave-rewritten text, and RenderedPane's
// content watch consumes it so the editor is NOT re-opened with the rewritten
// content (which would replace the user's live text and reset caret/scroll).
// The model syncs; the live editor content stays untouched until the next user edit.
let suppressReapply = false

export function armSuppressReapply(): void {
  suppressReapply = true
}

export function shouldSuppressReapply(): boolean {
  return suppressReapply
}

export function consumeSuppressReapply(): boolean {
  const was = suppressReapply
  suppressReapply = false
  return was
}