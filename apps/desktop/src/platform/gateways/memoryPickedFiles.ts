/**
 * The browser demo's picked-file registry.
 *
 * The real picker returns absolute paths and the Rust side reads the bytes
 * itself, so no file content ever crosses IPC. The demo has neither a native
 * dialog nor a real filesystem: a test queues `path -> base64` here, this makes
 * `pickImageFiles` hand those paths back, and importing one looks its payload
 * up again — which keeps the whole pick -> import -> insert flow exercisable in
 * a browser.
 *
 * This is the memory adapter's one piece of state that OUTLIVES a gateway
 * instance: the maps are module-scope, so every gateway a test builds sees the
 * same queue. It lives alone in a module because that lifetime is the point
 * (a suite seeds a pick once and drives it through several gateways), and it is
 * easier to keep an eye on when it is not buried in a 500-line factory.
 */

const pickedFiles = new Map<string, string>()
let pickQueue: string[] = []

/** Queue the files the next `dialogs.pickImageFiles()` call should return. */
export function seedMemoryPickedFiles(files: Record<string, string>): void {
  for (const [path, base64] of Object.entries(files)) {
    const name = path.replace(/\\/g, '/').split('/').pop() ?? path
    pickedFiles.set(path, base64)
    pickedFiles.set(name, base64)
    pickQueue.push(path)
  }
}

/** Drop every queued demo pick (test isolation). */
export function resetMemoryPickedFiles(): void {
  pickedFiles.clear()
  pickQueue = []
}

/** Take the paths for this pick. One-shot, like the native dialog: the call
 * that reads the queue consumes it, so reopening the picker starts empty
 * instead of re-importing the previous selection. */
export function takePickedPaths(): string[] {
  const next = pickQueue
  pickQueue = []
  return next
}

/** The bytes stashed for a picked path (or for its bare file name, which is
 * what the demo's "path" usually is). */
export function pickedFilePayload(sourcePath: string): string | undefined {
  const name = sourcePath.replace(/\\/g, '/').split('/').pop() ?? sourcePath
  return pickedFiles.get(sourcePath) ?? pickedFiles.get(name)
}
