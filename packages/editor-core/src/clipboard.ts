// Injectable clipboard writer used by the UI-only node views (code copy,
// heading anchor). Defaults to `navigator.clipboard.writeText`; tests and
// non-browser hosts override it via `configureClipboardWriter`. Kept as a
// module-level sink so a single override is shared by every node view created
// by the editor, mirroring how `configureImageResolver` works.

export type ClipboardWriter = (text: string) => Promise<void> | void

const defaultWriter: ClipboardWriter = (text) => navigator.clipboard.writeText(text)

let writeToClipboard: ClipboardWriter = defaultWriter

export function configureClipboardWriter(writer: ClipboardWriter | null): void {
  writeToClipboard = writer ?? defaultWriter
}

export function copyText(text: string): Promise<void> {
  return Promise.resolve(writeToClipboard(text))
}
