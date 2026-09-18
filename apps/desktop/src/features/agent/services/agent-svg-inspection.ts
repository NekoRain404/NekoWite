/**
 * What may be previewed: the safety judgement a staged artifact has to pass before anything draws it.
 *
 * §7.3 is the specification, and the first three of its clauses forbid a different way of pretending
 * a preview succeeded:
 *
 *  1. **Wait for the write** (「等待文件写入完成，不逐 token 渲染不完整 SVG」): the stat'ed size and the
 *     bytes read have to agree, and the document has to be well-formed, so a half-written file is
 *     refused rather than drawn.
 *  2. **A parser, not a pattern** (「使用成熟 sanitizer/解析器…不用正则假装消毒」): every check runs on the
 *     tree the platform's XML parser produced, behind an allowlist, and an element that is not on
 *     it is refused by name rather than deleted — a stripped SVG can differ from the one the agent
 *     drew in ways the user cannot see, which is the "completed differently" failure this codebase
 *     refuses everywhere else.
 *  3. **The preview is a verified artifact, never the raw text** (「安全预览不通过随意放宽 CSP 或直接 `v-html`
 *     执行原始内容实现；预览失败保留原文件并报错」): a branded value only {@link inspectStagedSvg} can
 *     mint, so a panel has one thing it may draw and no raw string to `v-html`.
 *
 * It is a file of its own because these three clauses are a subject, and their reason to change is
 * not the insertion's: a new attack shape — another element that can act, another attribute that can
 * reach the network — is a change here and nowhere else, while the half that stays moves when the
 * note-editing contract does. That is two subjects, and it is the split
 * `agent_runtime/permissions.rs` already makes for its own payload: `agent-svg-insertion.ts` keeps
 * its path and its whole public surface, re-exporting everything declared below, so no import in the
 * tree changed. §7.3's clauses 4–6 are about the note edit and stayed there with the code they
 * describe.
 *
 * What holds the boundary is that nothing below imports anything: the judgement runs on the
 * platform's XML parser and this file's own tables, so it is testable against a document and nothing
 * else, and the surface that draws a preview reaches it without a store, a clock or a vault.
 */

export const STAGED_SVG_MEDIA_TYPE = 'image/svg+xml'

/**
 * The bounds an artifact is held to. They are enforced rather than hoped for: the declared size is
 * checked before a byte is decoded, the text's own length again before it is encoded (a caller's
 * `sizeBytes` is a claim, not a proof), and the element and depth budgets are counted by the walk
 * that was going to visit every node anyway. 1 MiB is far above a diagram an agent draws — those run
 * 2–50 KiB — and far below the point where parsing an untrusted tree is a service nobody asked for.
 */
export const MAX_SVG_BYTES = 1024 * 1024
export const MAX_SVG_ELEMENTS = 10_000
export const MAX_SVG_DEPTH = 64

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink'
const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace'

/**
 * What a preview may hold, by local name. An allowlist is the point: what is not here is refused by
 * name, so this list is the answer to "what can this render" and a new element is a deliberate
 * addition rather than an inherited permission. Two families are absent on purpose:
 *
 *  - **animation** (`animate`, `set`, …) — the classic shape of an SVG attack is a
 *    `<set attributeName="href" to="javascript:…">` that passes every static check and retargets a
 *    link afterwards. Keeping it means modelling every attribute each element can later write.
 *  - **`<style>` and `style=`** — CSS reaches the network through `url()`, `@import` and escapes: a
 *    grammar to parse rather than a value to compare, and a half-parsed stylesheet is the "regex
 *    pretending to sanitise" §7.3 forbids. Presentation attributes are the supported way to paint.
 */
const ALLOWED_ELEMENTS: ReadonlySet<string> = new Set(
  [
    'svg', 'g', 'defs', 'symbol', 'use', 'title', 'desc', 'marker', 'image',
    'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'textPath',
    'linearGradient', 'radialGradient', 'stop', 'pattern', 'clipPath', 'mask',
    'filter', 'feGaussianBlur', 'feOffset', 'feBlend', 'feColorMatrix', 'feComposite',
    'feFlood', 'feMerge', 'feMergeNode', 'feMorphology',
  ].map((name) => name.toLowerCase()),
)

/**
 * The staged artifact, as the caller read it. `sizeBytes` is the size the host stat'ed *before* the
 * read, and it is what makes the read checkable: the text has to be exactly that many UTF-8 bytes.
 * A still-growing file disagrees with its own stat, and that disagreement is the only honest way to
 * know a write has not finished — the tool call reporting success is a statement about the agent's
 * process, not about the disk.
 */
export interface AgentStagedSvg {
  /** The staged file: what a confirmed insert copies into the vault, byte for byte. */
  readonly path: string
  readonly mediaType: string
  readonly sizeBytes: number
  /** The file's text, read as UTF-8 after the stat above. */
  readonly text: string
}

declare const verifiedSvg: unique symbol

/**
 * An artifact that passed every check, with the preview those checks produced.
 *
 * The brand is load-bearing, like the committed context snapshot's: {@link inspectStagedSvg} is the
 * only producer, so a panel cannot render a string it built itself and call it a preview, and
 * {@link planSvgInsertion} cannot be handed one. `markup` is the platform serialiser's output for the
 * verified tree — never the raw text, never a string this module assembled by search and replace.
 */
export interface AgentSvgPreview {
  readonly [verifiedSvg]: never
  /** The staged file this preview was verified from: what a confirmed insert copies. */
  readonly stagedPath: string
  /** What a preview may render. The raw text is not this, and must never be rendered. */
  readonly markup: string
  readonly byteLength: number
  readonly elements: number
}

/** Why an artifact may not be previewed — a code, not a sentence. Each arm names the thing to fix
 *  rather than echoing the hostile value, which would only put an attacker's string in front of the
 *  user. */
export type AgentSvgRefusal =
  | { readonly reason: 'not-svg'; readonly mediaType: string }
  | { readonly reason: 'too-large'; readonly sizeBytes: number; readonly limit: number }
  | { readonly reason: 'incomplete-read'; readonly sizeBytes: number; readonly readBytes: number }
  | { readonly reason: 'unsafe-declaration'; readonly declaration: 'doctype' | 'entity' | 'processing-instruction' }
  | { readonly reason: 'malformed' }
  | { readonly reason: 'too-complex'; readonly elements: number; readonly limit: number }
  | { readonly reason: 'too-deep'; readonly depth: number; readonly limit: number }
  | { readonly reason: 'foreign-namespace'; readonly element: string; readonly namespace: string }
  | { readonly reason: 'unsafe-element'; readonly element: string }
  | { readonly reason: 'unsafe-attribute'; readonly element: string; readonly attribute: string }
  | { readonly reason: 'external-reference'; readonly element: string; readonly attribute: string }

export type AgentSvgInspection =
  | { readonly status: 'previewed'; readonly preview: AgentSvgPreview }
  | { readonly status: 'refused'; readonly refusal: AgentSvgRefusal }

/** UTF-8 bytes, which is what a file's size is. `text.length` counts code units, so a document with
 *  one non-ASCII character would disagree with its own stat. */
function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * The constructs no legitimate SVG here needs and no parser should be handed.
 *
 * A refusal, not a sanitisation, and fail-closed on purpose: a comment that merely mentions
 * `<!DOCTYPE` refuses a file that would have been fine, while a doctype that slipped past would let
 * the parser expand entities — a billion-laughs document is a denial of service the size bound cannot
 * see, because the file is small and the expansion is not.
 */
function declarationRefusal(text: string): AgentSvgRefusal | null {
  const upper = text.toUpperCase()
  if (upper.includes('<!DOCTYPE')) return { reason: 'unsafe-declaration', declaration: 'doctype' }
  if (upper.includes('<!ENTITY')) return { reason: 'unsafe-declaration', declaration: 'entity' }
  return null
}

/** A same-document reference, the only `href` a renderer is given here: `#id`, non-empty. */
function isFragmentReference(value: string): boolean {
  return value.startsWith('#') && value.length > 1
}

/** Every `url(…)` in a presentation attribute has to be a fragment: a paint server may point at a
 *  gradient in the same document and may not make the renderer fetch anything. A quoted target
 *  counts (`url('#g')` is valid CSS), so the check is on the target rather than the spelling, and a
 *  malformed value fails closed because what is left of it is not a fragment either. */
function hasExternalUrl(value: string): boolean {
  const lower = value.toLowerCase()
  let at = lower.indexOf('url(')
  while (at !== -1) {
    const close = value.indexOf(')', at)
    const raw = (close === -1 ? value.slice(at + 4) : value.slice(at + 4, close)).trim()
    const target = raw.startsWith("'") || raw.startsWith('"') ? raw.slice(1, -1).trim() : raw
    if (!isFragmentReference(target)) return true
    at = lower.indexOf('url(', close === -1 ? value.length : close)
  }
  return false
}

/** The attribute channels that are not inert data. With animation refused, everything else on an
 *  allowlisted element is geometry or paint: a name this module has never seen cannot execute. */
function judgeAttributes(element: string, node: Element): AgentSvgRefusal | null {
  const unsafe = (attribute: string): AgentSvgRefusal => ({ reason: 'unsafe-attribute', element, attribute })
  for (const attribute of Array.from(node.attributes)) {
    const name = attribute.name.toLowerCase()
    const local = (attribute.localName || attribute.name).toLowerCase()
    if (name === 'xmlns' || name.startsWith('xmlns:')) continue

    const namespace = attribute.namespaceURI
    if (namespace === XLINK_NAMESPACE) {
      if (local !== 'href') return unsafe(attribute.name)
    } else if (namespace === XML_NAMESPACE) {
      if (local !== 'space') return unsafe(attribute.name)
    } else if (namespace !== null) {
      // A namespaced attribute this module does not know is a vocabulary something else can act on,
      // and the document declared the namespace that brings it.
      return unsafe(attribute.name)
    }
    if (name.startsWith('on') || name === 'style') return unsafe(attribute.name)
    if (local === 'href' && !isFragmentReference(attribute.value)) {
      return { reason: 'external-reference', element, attribute: attribute.name }
    }
    if (hasExternalUrl(attribute.value)) {
      return { reason: 'external-reference', element, attribute: attribute.name }
    }
  }
  return null
}

type TreeJudgement = { readonly refusal: AgentSvgRefusal } | { readonly elements: number }

/**
 * The walk: every node of the parsed tree, judged, with the budgets counted as it goes. It answers
 * with the element count when the tree is clean, which is why nothing measures the tree twice.
 *
 * Iterative rather than recursive because the input is the thing it bounds — a deep document must
 * meet the depth limit, not the JavaScript stack — and it stops at the first violation rather than
 * collecting them, because the first one is already a refusal and the caller needs one reason.
 */
function judgeTree(document: Document): TreeJudgement {
  const stack: { readonly node: Node; readonly depth: number }[] = [{ node: document, depth: 0 }]
  let elements = 0

  while (stack.length > 0) {
    const { node, depth } = stack.pop() as { readonly node: Node; readonly depth: number }
    // `<?xml-stylesheet?>` makes a renderer fetch a stylesheet, and the DOM gives no portable way to
    // read a processing instruction's target once parsed, so PIs are refused as a class.
    if (node.nodeType === Node.PROCESSING_INSTRUCTION_NODE) {
      return { refusal: { reason: 'unsafe-declaration', declaration: 'processing-instruction' } }
    }
    if (node.nodeType === Node.DOCUMENT_TYPE_NODE) {
      return { refusal: { reason: 'unsafe-declaration', declaration: 'doctype' } }
    }

    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as Element
      elements += 1
      if (elements > MAX_SVG_ELEMENTS) {
        return { refusal: { reason: 'too-complex', elements, limit: MAX_SVG_ELEMENTS } }
      }
      if (depth > MAX_SVG_DEPTH) return { refusal: { reason: 'too-deep', depth, limit: MAX_SVG_DEPTH } }

      const name = (element.localName || element.tagName).toLowerCase()
      // A parser that cannot parse returns its error as a node rather than as an exception, and that
      // node is an element like any other: it has to be looked for, or a malformed document reads as
      // a small tree of unknown elements.
      if (name === 'parsererror') return { refusal: { reason: 'malformed' } }
      const namespace = element.namespaceURI
      if (namespace !== SVG_NAMESPACE) {
        return { refusal: { reason: 'foreign-namespace', element: name, namespace: namespace ?? '' } }
      }
      if (!ALLOWED_ELEMENTS.has(name)) return { refusal: { reason: 'unsafe-element', element: name } }
      const attributes = judgeAttributes(name, element)
      if (attributes !== null) return { refusal: attributes }
    }

    // Children are pushed whatever the node was: the document node is not an element and its subtree
    // is the whole document, so a walk descending only through elements would visit the root and stop
    // — and every check below the root would never run.
    for (const child of Array.from(node.childNodes)) stack.push({ node: child, depth: depth + 1 })
  }
  return { elements }
}

/**
 * Look at a staged artifact, and answer either with a preview or with the reason there is none.
 *
 * The order is the order of the questions: is this the kind of file we accept, is it within the
 * bound, is the read complete, is the content something a parser may be handed, does it parse, and
 * does every node pass. Nothing before the parse reads the content, so the checks that are about the
 * *read* cannot be reached by anything the content says.
 */
export function inspectStagedSvg(staged: AgentStagedSvg): AgentSvgInspection {
  const refused = (refusal: AgentSvgRefusal): AgentSvgInspection => ({ status: 'refused', refusal })
  const mediaType = staged.mediaType.split(';')[0].trim().toLowerCase()
  if (mediaType !== STAGED_SVG_MEDIA_TYPE) return refused({ reason: 'not-svg', mediaType })
  if (staged.sizeBytes > MAX_SVG_BYTES) {
    return refused({ reason: 'too-large', sizeBytes: staged.sizeBytes, limit: MAX_SVG_BYTES })
  }
  // Before the encode below, which is the first step whose cost the caller's number controls. Code
  // units are a lower bound on bytes, so this refuses only what is certainly over the bound.
  if (staged.text.length > MAX_SVG_BYTES) {
    return refused({ reason: 'too-large', sizeBytes: staged.text.length, limit: MAX_SVG_BYTES })
  }
  const byteLength = utf8Length(staged.text)
  if (byteLength !== staged.sizeBytes) {
    return refused({ reason: 'incomplete-read', sizeBytes: staged.sizeBytes, readBytes: byteLength })
  }
  const declaration = declarationRefusal(staged.text)
  if (declaration !== null) return refused(declaration)

  let document: Document
  try {
    document = new DOMParser().parseFromString(staged.text, 'image/svg+xml')
  } catch {
    // A parser may throw on input it refuses. A refusal here is the honest answer rather than an
    // exception escaping the service whose whole job is to say what it will not draw.
    return refused({ reason: 'malformed' })
  }

  const root = document.documentElement
  if (root === null || (root.localName || root.tagName).toLowerCase() !== 'svg') {
    return refused({ reason: 'malformed' })
  }
  const judged = judgeTree(document)
  if ('refusal' in judged) return refused(judged.refusal)

  const preview = Object.freeze({
    stagedPath: staged.path,
    markup: new XMLSerializer().serializeToString(document),
    byteLength,
    elements: judged.elements,
  })
  return { status: 'previewed', preview: preview as unknown as AgentSvgPreview }
}
