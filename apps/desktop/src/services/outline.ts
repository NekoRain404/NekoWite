export interface OutlineItem {
  level: number
  text: string
  line: number
  index: number
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$/

export function parseOutline(markdown: string): OutlineItem[] {
  const lines = markdown.split(/\r\n|\n|\r/)
  const items: OutlineItem[] = []
  let fence: { char: string; len: number } | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fenceMatch = FENCE_RE.exec(line)
    if (fenceMatch) {
      const char = fenceMatch[1][0]
      const len = fenceMatch[1].length
      const info = fenceMatch[2].trim()
      if (fence === null) {
        fence = { char, len }
      } else if (char === fence.char && len >= fence.len && info === '') {
        fence = null
      }
      continue
    }
    if (fence !== null) continue
    const match = ATX_RE.exec(line)
    if (!match) continue
    items.push({ level: match[1].length, text: (match[2] ?? '').trim(), line: i, index: items.length })
  }
  return items
}
