/**
 * RTL/content-direction helpers for rendered documents.
 *
 * A note's markdown has no base-direction attribute, so the browser falls back
 * to LTR unless we set `dir`. These helpers inspect the document text to
 * recommend a direction (Arabic/Hebrew -> `'rtl'`), while letting the user
 * force a choice via the appearance store's `contentDirection`.
 */

export type TextDirection = 'ltr' | 'rtl' | 'auto'

/**
 * Strong RTL script code points: Hebrew, Arabic, Arabic Presentation Forms,
 * Arabic Supplement / Egyptian hieroglyph (presentation) ranges. A character
 * in this set is an unambiguous RTL signal.
 */
const RTL_RE = /[\u0590-\u08FF\uFB1D-\uFDFD\uFE70-\uFEFC]/u

/**
 * Direction-neutral code points that never tip the vote: separators/whitespace
 * (`\p{Z}`), numbers (`\p{N}`), punctuation (`\p{P}`), combining marks
 * (`\p{M}`), format/bidi controls such as LRM/RLM `\u200E-\u200F` (`\p{Cf}`),
 * and symbols/emoji (`\p{S}`).
 */
const NEUTRAL_RE = /[\s\p{Z}\p{N}\p{P}\p{M}\p{Cf}\p{S}\p{Cs}]/u

/** How many leading code units of the document are inspected. */
const SAMPLE_LEN = 300

/**
 * Guess the base direction of `text` from a sample of its leading characters.
 *
 * - Empty, whitespace-only, or direction-neutral-only content returns
 *   `'auto'` (there is no strong signal to go on).
 * - Otherwise the majority of strong LTR vs RTL letters decides, so a primarily
 *   Arabic/Hebrew run yields `'rtl'` and a primarily Latin run `'ltr'`.
 */
export function detectDirection(text: string | null | undefined): TextDirection {
  const sample = (text ?? '').slice(0, SAMPLE_LEN)
  let rtl = 0
  let ltr = 0
  for (const ch of sample) {
    if (NEUTRAL_RE.test(ch)) continue
    if (RTL_RE.test(ch)) rtl++
    else ltr++
  }
  if (rtl === 0 && ltr === 0) return 'auto'
  return rtl > ltr ? 'rtl' : 'ltr'
}

/**
 * Resolve the effective direction for a document.
 *
 * An explicit `'ltr'`/`'rtl'` choice is returned as-is; `'auto'` (the default)
 * delegates to `detectDirection` so the document's own text decides. Use the
 * result as the `dir` attribute of the rendered container so the browser lays
 * the content out from the correct edge.
 */
export function resolveDirection(direction: TextDirection, text: string | null | undefined): TextDirection {
  if (direction !== 'auto') return direction
  return detectDirection(text)
}
