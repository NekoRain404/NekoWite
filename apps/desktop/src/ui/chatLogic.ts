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

/** Pack the transcript into a single prompt, walking backwards to keep only
 * the most recent turns (capped at `maxChars`). `history` must already end
 * with the current user turn. */
export function buildChatPrompt(history: ChatTurn[], maxChars = 6000): string {
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
