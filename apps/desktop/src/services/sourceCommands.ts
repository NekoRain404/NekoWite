/**
 * Markdown-level implementations of the builtin toolbar commands for the
 * CodeMirror source pane.
 *
 * The editor-core commands are ProseMirror commands: they rewrite the rendered
 * document model. While the source pane is the author that model is stale, so
 * running them there edits a document nobody can see — and on the way back
 * through the serializer it would replace the raw Markdown under the caret.
 * These apply the same transformations to the Markdown text, so a toolbar
 * button behaves the same in source mode as it does rendered.
 */

import { EditorSelection } from '@codemirror/state'
import type { ChangeSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

/** Inline wrappers, keyed by the editor-core command id. */
const INLINE_WRAPS: Record<string, string> = {
  bold: '**',
  italic: '*',
  strike: '~~',
  'inline-code': '`',
}

/** Block prefixes, keyed by the editor-core command id. */
const LINE_PREFIXES: Record<string, string> = {
  'list-unordered': '- ',
  'list-ordered': '1. ',
  'list-task': '- [ ] ',
  quote: '> ',
}

const HEADING_RE = /^(#{1,6})\s+/

/** The heading level encoded in a `heading:hN` command id, or null. */
function headingLevel(id: string): number | null {
  if (!id.startsWith('heading:h')) return null
  const level = Number(id.slice('heading:h'.length))
  return Number.isInteger(level) && level >= 1 && level <= 6 ? level : null
}

/** True when `id` has a source-mode implementation in this module. */
export function isSourceCommand(id: string): boolean {
  return (
    headingLevel(id) !== null ||
    id in INLINE_WRAPS ||
    id in LINE_PREFIXES ||
    id === 'link' ||
    id === 'code-block' ||
    id === 'hr' ||
    id === 'insert-component'
  )
}

/** Every line the main selection touches, in document order. */
function selectedLines(view: EditorView) {
  const doc = view.state.doc
  const { from, to } = view.state.selection.main
  const first = doc.lineAt(from)
  let lastNumber = doc.lineAt(to).number
  // A selection that ends exactly at the start of an empty final line does not
  // really cover it: that is just the newline terminating the line above (what
  // select-all over a trailing-newline document produces). Prefixing it would
  // leave a stray `## ` / `- ` behind.
  if (lastNumber > first.number) {
    const last = doc.line(lastNumber)
    if (last.length === 0 && last.from === to) lastNumber -= 1
  }
  const lines = []
  for (let number = first.number; number <= lastNumber; number += 1) {
    lines.push(doc.line(number))
  }
  return lines
}

/**
 * The selection with any newline at its end trimmed off.
 *
 * A text selection that runs to the end of a line usually includes that line's
 * newline, but wrapping it would put the closing marker on the next line
 * (`**hello\n**` instead of `**hello**\n`).
 */
function trimmedRange(view: EditorView, from: number, to: number): { from: number; to: number } {
  const doc = view.state.doc
  let end = to
  while (end > from && doc.sliceString(end - 1, end) === '\n') end -= 1
  return { from, to: end }
}

/**
 * Replace the selection with `insert`.
 *
 * `caret` places the cursor inside the inserted text (an offset from the start);
 * it defaults to the end, which is what a plain paste wants. A template that
 * the user is meant to fill in — a math block, an MDX component — parks the
 * caret where the content goes.
 */
export function insertSourceText(view: EditorView, insert: string, caret?: number): void {
  const offset = caret === undefined ? insert.length : Math.max(0, Math.min(caret, insert.length))
  view.dispatch(
    view.state.changeByRange((range) => ({
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(range.from + offset),
    })),
  )
  view.focus()
}

/**
 * Toggle `marker` around each selection. An empty selection gets the pair with
 * the caret parked between the two markers; a selection that already carries
 * the markers loses them, so pressing the button twice is a round trip.
 */
function toggleInline(view: EditorView, marker: string): void {
  const { state } = view
  view.dispatch(
    state.changeByRange((range) => {
      const { from, to } = range
      const doc = state.doc
      if (from === to) {
        return {
          changes: { from, insert: marker + marker },
          range: EditorSelection.cursor(from + marker.length),
        }
      }
      const trimmed = trimmedRange(view, from, to)
      const end = trimmed.to
      const selected = doc.sliceString(from, end)
      if (selected === '') {
        return {
          changes: { from, insert: marker + marker },
          range: EditorSelection.cursor(from + marker.length),
        }
      }
      const padding = marker.length
      if (selected.length >= padding * 2 && selected.startsWith(marker) && selected.endsWith(marker)) {
        const inner = selected.slice(padding, selected.length - padding)
        return {
          changes: { from, to: end, insert: inner },
          range: EditorSelection.range(from, from + inner.length),
        }
      }
      const before = doc.sliceString(Math.max(0, from - padding), from)
      const after = doc.sliceString(end, Math.min(doc.length, end + padding))
      if (before === marker && after === marker) {
        return {
          changes: [
            { from: from - padding, to: from, insert: '' },
            { from: end, to: end + padding, insert: '' },
          ],
          range: EditorSelection.range(from - padding, end - padding),
        }
      }
      return {
        changes: { from, to: end, insert: marker + selected + marker },
        range: EditorSelection.range(from + padding, end + padding),
      }
    }),
  )
  view.focus()
}

/** Add `prefix` to every selected line, or strip it when they all have it. */
function toggleLinePrefix(view: EditorView, prefix: string): void {
  const lines = selectedLines(view)
  const allPrefixed = lines.every((line) => line.text.startsWith(prefix))
  const changes: ChangeSpec[] = []
  for (const line of lines) {
    if (allPrefixed) {
      changes.push({ from: line.from, to: line.from + prefix.length, insert: '' })
    } else if (!line.text.startsWith(prefix)) {
      changes.push({ from: line.from, insert: prefix })
    }
  }
  if (changes.length === 0) return
  view.dispatch({ changes })
  view.focus()
}

/** Set (or, at the same level, clear) an ATX heading on every selected line. */
function applyHeading(view: EditorView, level: number): void {
  const changes: ChangeSpec[] = []
  for (const line of selectedLines(view)) {
    const match = HEADING_RE.exec(line.text)
    const body = match ? line.text.slice(match[0].length) : line.text
    const sameLevel = match !== null && match[1].length === level
    const next = sameLevel ? body : `${'#'.repeat(level)} ${body}`
    if (next === line.text) continue
    changes.push({ from: line.from, to: line.to, insert: next })
  }
  if (changes.length === 0) return
  view.dispatch({ changes })
  view.focus()
}

/** A line that opens or closes a fenced code block. */
function isFence(text: string): boolean {
  return text.trim().startsWith('```')
}

/**
 * Delete the two fence lines (and their newlines) in one transaction.
 *
 * The closing line is often the last line and so has no trailing newline of its
 * own — the separator then lives *before* it, and leaving that behind would
 * strand a blank line where the code block used to be. Ranges are clamped to
 * the document and kept from overlapping, which an empty ``` ``` block would
 * otherwise produce.
 */
function removeLines(
  view: EditorView,
  open: { from: number; to: number },
  close: { from: number; to: number },
): void {
  const doc = view.state.doc
  const openTo = Math.min(open.to + 1, doc.length)
  const isLastLine = close.to + 1 > doc.length
  const closeFrom = Math.max(isLastLine && close.from > 0 ? close.from - 1 : close.from, openTo)
  const closeTo = Math.min(close.to + 1, doc.length)
  view.dispatch({
    changes: [
      { from: open.from, to: openTo, insert: '' },
      { from: closeFrom, to: closeTo, insert: '' },
    ],
  })
  view.focus()
}

/**
 * Fence the selected lines as a code block, or remove the fence that already
 * wraps them.
 *
 * Two shapes count as "already fenced": a selection that includes the fence
 * lines themselves (what a select-all over a fenced block produces), and a
 * selection sitting inside a fence pair. Both must unfence, or pressing the
 * button twice would keep stacking fences.
 */
function toggleCodeBlock(view: EditorView): void {
  const doc = view.state.doc
  const lines = selectedLines(view)
  const first = lines[0]
  const last = lines[lines.length - 1]
  if (first.number !== last.number && isFence(first.text) && isFence(last.text)) {
    removeLines(view, first, last)
    return
  }
  const above = first.number > 1 ? doc.line(first.number - 1) : null
  const below = last.number < doc.lines ? doc.line(last.number + 1) : null
  if (above && below && isFence(above.text) && isFence(below.text)) {
    removeLines(view, above, below)
    return
  }
  view.dispatch({
    changes: [
      { from: first.from, insert: '```\n' },
      { from: last.to, insert: '\n```' },
    ],
  })
  view.focus()
}

/** Wrap the selection as a Markdown link, parking the caret on the URL. */
function insertLink(view: EditorView): void {
  const { state } = view
  view.dispatch(
    state.changeByRange((range) => {
      const end = trimmedRange(view, range.from, range.to).to
      const selected = state.doc.sliceString(range.from, end)
      const label = selected || 'text'
      const insert = `[${label}](https://)`
      return {
        changes: { from: range.from, to: end, insert },
        // A bare `[text](https://)` leaves the caret on the placeholder URL so
        // the first typed character goes where the user expects; a real
        // selection stays selected so it can be retyped.
        range: selected
          ? EditorSelection.range(range.from + 1, range.from + 1 + label.length)
          : EditorSelection.cursor(range.from + insert.length - 1),
      }
    }),
  )
  view.focus()
}

/** Insert a horizontal rule on its own line, separated from surrounding text. */
function insertHr(view: EditorView): void {
  const doc = view.state.doc
  const line = doc.lineAt(view.state.selection.main.from)
  const spaced = line.text.trim() !== ''
  insertSourceText(view, spaced ? '\n\n---\n' : '---\n')
}

/**
 * Run the source-mode implementation of `id`. Returns false when the command
 * has none, so the caller can fall back to the registry (plugin commands are
 * still view-independent and must keep working).
 */
export function runSourceCommand(view: EditorView, id: string): boolean {
  const level = headingLevel(id)
  if (level !== null) {
    applyHeading(view, level)
    return true
  }
  const wrap = INLINE_WRAPS[id]
  if (wrap) {
    toggleInline(view, wrap)
    return true
  }
  const prefix = LINE_PREFIXES[id]
  if (prefix) {
    toggleLinePrefix(view, prefix)
    return true
  }
  switch (id) {
    case 'link':
      insertLink(view)
      return true
    case 'code-block':
      toggleCodeBlock(view)
      return true
    case 'hr':
      insertHr(view)
      return true
    case 'insert-component':
      insertSourceText(view, '<Component />\n')
      return true
    default:
      return false
  }
}
