import { extensionFromFileName, fileToBase64, mimeFromExtension } from '../services/attachments'

export type ChatRole = 'user' | 'assistant'

export interface ChatTurn {
  role: ChatRole
  content: string
}

export interface ChatImage {
  id: string
  name: string
  dataUrl: string
}

export interface ChatMessage extends ChatTurn {
  images?: ChatImage[]
  streaming?: boolean
}

let seq = 0

export function nextImageId(): string {
  seq += 1
  return `img-${seq}`
}

/** Resolve the MIME for an image blob, preferring the declared type and
 * falling back to the file extension (`image/png` as a safe last resort). */
export function pickImageMime(file: { type?: string; name?: string }): string {
  const typeMime = (file.type ?? '').trim()
  if (typeMime) return typeMime
  const ext = file.name ? extensionFromFileName(file.name) : null
  const extMime = ext ? mimeFromExtension(ext) : ''
  return extMime && extMime !== 'application/octet-stream' ? extMime : 'image/png'
}

/** Convert an image blob into a `data:<mime>;base64,<data>` URL the AI
 * gateways consume (Anthropic/Gemini split it; OpenAI passes it verbatim). */
export function fileToDataURL(file: Blob & { type?: string; name?: string }): Promise<string> {
  return fileToBase64(file).then((base64) => `data:${pickImageMime(file)};base64,${base64}`)
}

/** Truncate a string to at most `maxChars` and append an ellipsis when cut. */
function truncate(s: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  if (s.length <= maxChars) return s
  return `${s.slice(0, maxChars - 3)}...`
}

/** Wrap the transcribed turns into the message body, walking backwards to keep
 * only the most recent turns (capped at `maxChars`). `history` must already
 * end with the current user turn. */
function buildChatTranscript(history: ChatTurn[], maxChars = 6000): string {
  const label = (role: ChatRole): string => (role === 'user' ? '用户' : '助手')
  const lines: string[] = []
  let used = 0
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const turn = history[i]
    const line = `${label(turn.role)}：${turn.content.trimEnd()}`
    if (used + line.length > maxChars && lines.length > 0) break
    lines.unshift(line)
    used += line.length
  }
  return lines.join('\n\n')
}

/** Build a readable context block for the active note. A non-empty selection
 * takes priority over the full body; the note body is truncated so the block
 * never blows the token budget. Pure logic: no `t()`, no editor access. */
export function buildContextBlock(context: {
  noteTitle?: string
  selection?: string
  noteContent?: string
  maxChars?: number
} = {}): string {
  const maxChars = context.maxChars ?? 2000
  const title = context.noteTitle?.trim() ?? ''
  const selection = context.selection?.trim() ?? ''
  const content = context.noteContent?.trim() ?? ''
  const lines: string[] = []
  const header = title ? `【当前文档：${title}】` : ''
  if (selection) {
    if (header) lines.push(header)
    lines.push('【选中文本】')
    lines.push(truncate(selection, maxChars))
  } else if (content) {
    if (header) lines.push(header)
    lines.push(truncate(content, maxChars))
  }
  return lines.join('\n')
}

/** Pack the transcript into a single prompt, walking backwards to keep only
 * the most recent turns (capped at `maxChars`). `history` must already end
 * with the current user turn. An optional `context` block is prepended as a
 * reference section so the model knows what you are writing.
 *
 * The second argument may be a numeric `maxChars` (legacy) or an options object
 * `{ context, maxChars }`. When `context` is omitted/empty the output is
 * identical to the legacy numeric form. */
export function buildChatPrompt(
  history: ChatTurn[],
  maxCharsOrOpts: number | { context?: string; maxChars?: number } = 6000,
): string {
  const opts = typeof maxCharsOrOpts === 'number' ? { maxChars: maxCharsOrOpts } : maxCharsOrOpts
  const maxChars = opts.maxChars ?? 6000
  const context = opts.context?.trim() ?? ''
  const body = buildChatTranscript(history, maxChars)
  if (!context) return body
  return `以下是当前文档的上下文，供你参考：\n${context}\n\n---\n\n${body}`
}
