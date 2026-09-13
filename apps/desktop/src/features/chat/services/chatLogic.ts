import { extensionFromFileName, fileToBase64, mimeFromExtension } from '../../../services/attachments'
import { t } from '../../../i18n'

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

/**
 * Truncate, and SAY SO.
 *
 * A 100 000-character note sent under a 2 000-character budget gave the model
 * the first 2% of the document, and nothing in the UI, the prompt or the answer
 * hinted that anything was missing — so the reply confidently discussed the
 * opening of a note whose actual subject was fifty pages further down. The
 * omitted count goes into the context itself (the model can then say what it
 * cannot see) and the fact is reported to the caller so the panel can tell the
 * user.
 */
function truncateWithNotice(
  s: string,
  maxChars: number,
  /** Keep the END of the text too. True for a note body, false for a selection:
   *  a selection is what the user pointed at, so its beginning is the point. */
  keepTail = false,
): { text: string; notice: string } {
  if (maxChars <= 0) return { text: '', notice: '' }
  if (s.length <= maxChars) return { text: s, notice: '' }
  const omitted = s.length - maxChars
  const notice = t('chat.contextTruncated', { omitted })
  if (!keepTail) {
    return { text: truncate(s, maxChars), notice }
  }
  // A note is not a prefix of itself. Sending only its opening (what this did)
  // meant the model confidently discussed the introduction of a note whose
  // actual subject was fifty pages further down, and the person writing the
  // END of a long note - the usual case, you ask about what you are writing -
  // was the one person whose text never reached the model. Split the budget
  // between the opening (what the note is) and the ending (where the work is),
  // and put the omission notice where the missing text was.
  const headLen = Math.floor(maxChars * 0.5)
  const tailLen = maxChars - headLen
  return {
    text: [s.slice(0, headLen), notice, s.slice(s.length - tailLen)].join('\n'),
    // The notice is inside the text now, between the two halves it describes.
    notice: '',
  }
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
  const label = (role: ChatRole): string => (role === 'user' ? t('chat.user') : t('chat.assistant'))
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
 * never blows the token budget. Uses `t()` (module-safe i18n), no editor access. */
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
  const header = title ? t('chat.currentDocHeader', { title }) : ''
  const pushBody = (body: string, keepTail = false): void => {
    const { text, notice } = truncateWithNotice(body, maxChars, keepTail)
    lines.push(text)
    // The notice follows the text it describes: a reader (and the model) sees
    // what was included first, then learns that something was left out.
    if (notice) lines.push(notice)
  }
  if (selection) {
    if (header) lines.push(header)
    lines.push(t('chat.selectionHeader'))
    pushBody(selection)
  } else if (content) {
    if (header) lines.push(header)
    pushBody(content, true)
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
  return t('chat.contextIntro', { context, body })
}
