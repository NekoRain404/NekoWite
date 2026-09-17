/**
 * Handing text to the system clipboard, from a webview whose clipboard is not a given.
 *
 * Two paths, and the second is not decoration. `navigator.clipboard.writeText` is the modern
 * one and it is *unmeasured on the engine this app ships*: WebKitGTK 4.1 under Tauri exposes the
 * async clipboard only in a secure context, and whether the packaged app is one is exactly the
 * kind of question the WebKit harness exists for and has not answered for the clipboard. So the
 * fallback is the engine's own copy command over a staged selection — a path first written inside
 * a component that had to copy a whole buffer, moved here so there is one of it for a surface that
 * copies anything.
 *
 * **The result is returned rather than swallowed.** A copy control that silently does nothing
 * leaves the reader pasting a stale buffer and believing they copied something; both callers
 * report the failure, and neither assumes that either path worked.
 */

/** Stage the text off-screen and let the engine's own copy command take the selection. */
function stagedCopy(text: string): boolean {
  const staged = document.createElement('textarea')
  staged.value = text
  staged.setAttribute('readonly', '')
  staged.style.cssText = 'position:absolute;left:-9999px;top:0'
  document.body.appendChild(staged)
  staged.select()
  const copied = typeof document.execCommand === 'function' && document.execCommand('copy')
  staged.remove()
  return copied
}

/** Whether the text reached the clipboard. Never throws: a refusal is an answer. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard === undefined) return stagedCopy(text)
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
