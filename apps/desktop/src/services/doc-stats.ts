// Pure, framework-agnostic document statistics for the stats panel. Kept as a
// pure function so it is unit-testable without a DOM or an editor, and can back
// both the stats panel and any status-bar summary.

// CJK unified ideographs + kana + Hangul syllables: no whitespace between words.
const CJK_RE = /[一-鿿぀-ヿ가-힯]/g

// Matches fenced code delimiters (backticks or tildes), optionally indented up
// to three spaces per CommonMark.
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/

// A task-list item: ordered/unordered marker, optional indentation, then a
// checkbox `- [ ]` / `- [x]` / `- [X]` (GFM also allows `*` and `+`).
const TASK_RE = /^\s*[-*+]\s+\[( |x|X)\](?:\s|$)/

const IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/g
const CITE_RE = /\[@[^\]]+\]/g

export interface DocStats {
  words: number
  chars: number
  paragraphs: number
  images: number
  citations: number
  tasks: number
  taskDone: number
  taskTotal: number
  readMinutes: number
}

/** Count "words" in markdown text. CJK has no whitespace between words, so each
 *  CJK character counts as one word; whitespace-separated runs in the remainder
 *  (latin / digits / emoji) count as one word each. */
function countWords(text: string): number {
  const cjk = text.match(CJK_RE)?.length ?? 0
  const rest = text.replace(CJK_RE, ' ').trim()
  const latinWords = rest ? rest.split(/\s+/).filter(Boolean).length : 0
  return cjk + latinWords
}

/** Return a copy of `text` with fenced code block content replaced by spaces
 *  (newlines preserved) so content regexes for images / citations / tasks never
 *  match inside a ` ``` ` block. */
function stripCodeBlocks(text: string): string {
  const lines = text.split('\n')
  let inFence = false
  return lines
    .map((line) => {
      if (FENCE_RE.test(line)) {
        inFence = !inFence
        return ' '.repeat(line.length)
      }
      return inFence ? ' '.repeat(line.length) : line
    })
    .join('\n')
}

export function computeDocStats(content: string): DocStats {
  const words = countWords(content)
  const chars = content.length

  // Paragraph blocks are split on blank lines (`\n\s*\n`); blank-only blocks
  // (whitespace, multiple newlines) do not count.
  const paragraphs = content.split(/\n\s*\n/).filter((block) => block.trim().length > 0).length

  // Images, citations and tasks ignore fenced code blocks.
  const nonCode = stripCodeBlocks(content)
  const images = (nonCode.match(IMAGE_RE) ?? []).length
  const citations = (nonCode.match(CITE_RE) ?? []).length

  let taskTotal = 0
  let taskDone = 0
  for (const line of nonCode.split('\n')) {
    const match = TASK_RE.exec(line)
    if (!match) continue
    taskTotal += 1
    if (match[1] !== ' ') taskDone += 1
  }

  const readMinutes = words === 0 ? 0 : Math.max(1, Math.ceil(words / 300))

  return {
    words,
    chars,
    paragraphs,
    images,
    citations,
    tasks: taskTotal,
    taskDone,
    taskTotal,
    readMinutes,
  }
}
