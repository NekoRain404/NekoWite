/**
 * The bytes a document carries around the Markdown model.
 *
 * Three things are part of the FILE and not part of the document the model
 * holds, so none of them can survive a trip through the parser and the
 * serializer on its own:
 *
 *   - the **BOM**. A leading U+FEFF is a byte-order mark, not content: strip it
 *     and it is gone for good. Worse, `FRONTMATTER_RE` is anchored at the start
 *     of the text, so a BOM in front of the block hides the frontmatter from the
 *     reader entirely — the `---` line is then ordinary prose and comes back as
 *     a thematic break and a setext heading (task-37 M3).
 *   - the **frontmatter block**. It is carried through as source, because the
 *     model cannot represent it (see `editor.ts`).
 *   - the file's **line ending**. It exists nowhere in mdast: the stringifier
 *     writes `\n`, so a CRLF file came back with a CRLF frontmatter spliced onto
 *     an LF body — a file that was internally consistent, made inconsistent by
 *     the act of saving it (task-37 M1).
 *
 * So each is read off the source when the document is opened and written back
 * around the serializer's output when it is saved. The rule the whole module
 * exists to keep: **a save does not rewrite bytes the user did not ask it to
 * rewrite** — a CRLF file stays CRLF, a BOM file stays a BOM file, and an
 * ordinary LF file is not touched at all.
 *
 * The decisions are stated where they are made:
 *
 *   - **Which ending is the document's.** The majority of the file's own line
 *     endings decides, the way every editor that guesses at a mixed file does;
 *     a tie, or a file with no ending at all, is LF (what the serializer writes
 *     natively, so the one that costs nothing). Counting matters: a file that is
 *     *entirely* CRLF has more CRLFs than LFs, so it reads as CRLF rather than
 *     as a 50/50 mix. A lone CR is not one of the two endings this editor
 *     writes, so a classic-Mac file is read as one line and written as LF.
 *   - **What a MIXED file does.** The majority ending is applied to the
 *     structural text — the frontmatter and the serialized body — which UNIFIES
 *     the file on the first save instead of leaving it half and half. The
 *     minority bytes are the ones rewritten, and the report says so: there is
 *     nowhere in the model to hang a per-line ending, so no round trip through
 *     it can preserve an internal disagreement.
 *   - **What is NOT rewritten.** The LF case leaves the body's bytes exactly as
 *     the serializer produced them. A CRLF the model carries as CONTENT — the
 *     value of a code block, which mdast keeps verbatim — is therefore preserved
 *     in an LF document rather than normalised away; only a CRLF document
 *     converts its body (LF to CRLF, never the other way).
 */

/** The two line endings a document may be written in. */
export type LineEnding = '\n' | '\r\n'

/** A document's bytes, split into the parts the model cannot hold. */
export interface DocumentEnvelope {
  /** The file began with a UTF-8 BOM. */
  bom: boolean
  /** The frontmatter block, source-verbatim, including its blank separator
   *  lines; `''` when the file has none. */
  front: string
  /** Everything after the block, in the file's own line endings. */
  body: string
  /** The ending the document is written in (see the header). */
  eol: LineEnding
}

const BOM = '﻿'

/**
 * The line ending the document is written in: the one it uses more of.
 *
 * Ties go to LF, and so does a file with no line ending at all — LF is what the
 * serializer emits, so it is the answer that rewrites nothing.
 */
export function detectLineEnding(text: string): LineEnding {
  const crlf = text.match(/\r\n/g)?.length ?? 0
  // `\n` is counted by every CRLF too; what matters is the LF that stands alone.
  const lf = (text.match(/\n/g)?.length ?? 0) - crlf
  return crlf > lf ? '\r\n' : '\n'
}

/**
 * YAML frontmatter block at the very start of a document, if any. The
 * trailing line breaks (including blank separator lines) are part of the
 * block so a save() re-prepends the source byte-faithfully.
 *
 * A BOM is NOT frontmatter-aware: `^` anchors on the first character, so the
 * caller strips it first (see `readDocumentEnvelope`).
 */
const FRONTMATTER_RE = /^---\r?\n(?:[\s\S]*?\r?\n)?---((?:\r?\n)+|$)/

export function splitFrontmatter(md: string): { front: string; body: string } {
  const match = FRONTMATTER_RE.exec(md)
  if (!match) return { front: '', body: md }
  return { front: match[0], body: md.slice(match[0].length) }
}

/** Split a file into the parts of it the model cannot hold. */
export function readDocumentEnvelope(content: string): DocumentEnvelope {
  const bom = content.startsWith(BOM)
  // Stripped before the frontmatter is looked for, so a BOM file with a
  // frontmatter block is read as having one.
  const text = bom ? content.slice(1) : content
  const { front, body } = splitFrontmatter(text)
  return { bom, front, body, eol: detectLineEnding(text) }
}

/**
 * Write `body` (the serializer's output) back into the document's envelope.
 *
 * `body` may be the `roundTrip` output rather than the text the model was opened
 * with — it is the document as it stands now, which is what the envelope is
 * written around.
 */
export function writeDocumentEnvelope(envelope: DocumentEnvelope, body: string): string {
  const front = inLineEnding(envelope.front, envelope.eol)
  // The LF case is left alone rather than "normalised to LF": the serializer
  // already writes LF, so the only ones left are the CRLFs the model carried as
  // content, and rewriting those is the silent byte rewrite this module exists
  // to stop. Converting in the other direction is what makes a CRLF document
  // consistent, so that direction is applied.
  const text = envelope.eol === '\r\n' ? inLineEnding(body, '\r\n') : body
  return `${envelope.bom ? BOM : ''}${front}${text}`
}

/** Rewrite every line ending in `text` as `eol`. */
function inLineEnding(text: string, eol: LineEnding): string {
  return eol === '\r\n' ? text.replace(/\r?\n/g, '\r\n') : text.replace(/\r\n/g, '\n')
}
