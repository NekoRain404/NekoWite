/**
 * What an image alt says, whichever reader read the file.
 *
 * micromark computes `image.alt` from the label’s tokens, and the MDX token types
 * (`mdxJsxTextElement`, `mdxTextExpression`) are not types it counts — so
 * `![a<br/>b](p.png)` read as MDX said `alt: 'ab'`, and because the alt is a
 * string the serializer writes back verbatim, the tag was gone from the file the
 * next time the note was saved. That is silent data loss in the user’s own file,
 * and the one place in this package where OPENING a document could destroy part
 * of it. An image is the only node it can happen to: a title is a tokenizer
 * string and a link’s text is children, so neither is recomputed from inline
 * content (`[a<br/>b](http://y)` and `![alt](p.png "a<br/>b")` were both measured
 * clean before anything was changed).
 *
 * The answer is not re-derived here. The DOCUMENT is handed to the same processor
 * the Markdown path reads documents with — the copy `withMdxSyntax` takes before
 * the MDX extension goes on — and each image’s `alt` is taken from the image that
 * starts at the same offset. It is the whole document rather than the image’s own
 * slice because a reference image (`![a<br/>b][r]`) is only an image while its
 * definition is in view; parsing the slice alone leaves it as literal text and
 * finds no alt at all. It is the SAME call the Markdown path makes on the same
 * bytes, which is what makes the two readers agree by construction instead of
 * through a second implementation that happens to match today.
 *
 * Two things keep this from doing harm:
 *
 *   - the source handed over is the one the caller PARSED, not the one the masker
 *     produced (`mask.ts` hides constructs the MDX parser rejects behind
 *     same-length placeholders). A placeholder read into an alt would be written
 *     into the file, which is the one thing that module’s design forbids.
 *   - the extra parse only happens for a document that holds an image whose own
 *     source contains `<` or `{`. An MDX construct is a tag or a `{ … }` by
 *     definition, so an ordinary image cannot have lost anything.
 */
import type { Parse } from './mask'
import type { SourceNode } from './source'

/** A node that can hold an alt and children — the shape both readers produce. */
export interface AltNode extends SourceNode {
  children?: AltNode[]
  /** An image’s alt text, which the serializer writes back verbatim. */
  alt?: unknown
}

/** The nodes whose `alt` is a string the model holds. A link has none: what a
 *  link says is its children. */
const ALT_NODES = new Set(['image', 'imageReference'])

/** Replace the alt of every image that lost something, with the Markdown answer. */
export function restoreImageAlts(tree: AltNode, source: string, plain: Parse | null): void {
  if (!plain) return
  const images = imageNodes(tree).filter((node) => {
    const start = node.position?.start?.offset
    const end = node.position?.end?.offset
    return start !== undefined && end !== undefined && /[<{]/.test(source.slice(start, end))
  })
  if (images.length === 0) return
  let markdown: AltNode
  try {
    markdown = plain(source) as AltNode
  } catch {
    // The Markdown reader refused the document; the MDX answer stands, which is
    // the behaviour this replaced.
    return
  }
  const alts = new Map<number, string>()
  collectAlts(markdown, alts)
  for (const node of images) {
    const start = node.position?.start?.offset
    const alt = start === undefined ? undefined : alts.get(start)
    if (alt !== undefined) node.alt = alt
  }
}

/** Every image node in a tree, at any depth. */
function imageNodes(tree: AltNode, found: AltNode[] = []): AltNode[] {
  for (const child of tree.children ?? []) {
    if (ALT_NODES.has(child.type ?? '')) found.push(child)
    imageNodes(child, found)
  }
  return found
}

/** The alt of every image in a parsed document, by the offset it starts at. */
function collectAlts(node: AltNode, alts: Map<number, string>): void {
  if (ALT_NODES.has(node.type ?? '') && typeof node.alt === 'string') {
    const start = node.position?.start?.offset
    if (start !== undefined && !alts.has(start)) alts.set(start, node.alt)
  }
  for (const child of node.children ?? []) collectAlts(child, alts)
}
