/**
 * The long image: one picture of the whole document.
 *
 * The route is `<svg><foreignObject>` drawn onto a `<canvas>`, and it was
 * chosen because the browser renders the foreignObject with its own CSS engine,
 * so fidelity is the engine's rather than a reimplementation's — a Markdown
 * renderer rewritten in JavaScript would have to redo CJK line breaking, table
 * layout, code-block whitespace and math, and would get them subtly wrong. The
 * constraint that kills this approach elsewhere is images: an SVG loaded as an
 * `<img>` fetches nothing, so every image in the document must already be a
 * `data:` URL. The export pipeline already does exactly that for the saved
 * `.html` (`imageSrcTarget: 'data'`), so the constraint was already paid for.
 *
 * Two things about the clone are not obvious and were measured, not assumed:
 *
 *  - The renderer's own stylesheet sizes the document for a browser window
 *    (`body{max-width:50rem;margin:0 auto;padding:2rem}`). A `body` selector
 *    cannot match anything inside a foreignObject, because there is no `<body>`
 *    there — so without carrying the body's box across as an inline style the
 *    text reflows into a wider column, the document comes out shorter than the
 *    frame, and the last paragraphs are simply not in the image. Measured on a
 *    4 999px document: the naive clone lost the last 522px and the final eight
 *    paragraphs; carrying the box across left a 78px tail, which is the bottom
 *    padding.
 *  - `image/webp` is not a format this engine's canvas can encode. It does not
 *    fail either — `toDataURL('image/webp')` and `toBlob(…, 'image/webp')` both
 *    return a `data:image/png` / `Blob{type:'image/png'}`. A `.webp` written
 *    from that would be a PNG under the wrong extension, so WebP is not offered.
 */

/** How long to wait for the export frame's `srcdoc` to load before giving up.
 *  Only reached when `onload` never fires. */
const LOAD_SAFETY_MS = 60_000

/** The viewport the document is laid out in. Only has to be wider than the
 *  renderer's own 50rem column; the height is a starting box, not a limit —
 *  the body is content-sized. Exported because the preview has to lay the
 *  document out in a frame of the same width, or it would be previewing a
 *  layout the export does not produce. */
export const EXPORT_FRAME_SIZE = 1200

export type ExportImageFormat = 'png' | 'jpeg'

/** The MIME a format encodes to. The extension comes from the same pair
 *  (`export-name.ts`) so a `.png` can never hold JPEG bytes. */
export const IMAGE_MIME: Record<ExportImageFormat, 'image/png' | 'image/jpeg'> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
}

export interface RenderedImage {
  /** The encoded bytes, base64, without a data-URL prefix. */
  base64: string
  mime: string
  /** Real pixel dimensions, read back from the canvas that produced it. */
  width: number
  height: number
}

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
): HTMLElementTagNameMap[K] {
  return doc.createElement(tag)
}

const SVG_NS = 'http://www.w3.org/2000/svg'
const XHTML_NS = 'http://www.w3.org/1999/xhtml'

/**
 * The box the cloned document is laid out in — the body's own box, reproduced
 * as an inline style.
 *
 * `clientWidth` is the PADDING box, so it is not the value `width` wants:
 * `width:clientWidth` with `box-sizing:content-box` and the padding added again
 * makes the box 64px wider than the frame it is about to be drawn into. The
 * column then reflows wider, the document comes out short, and the right-hand
 * 64px of every line — glyphs included — is cut off by the frame. Measured on a
 * 4 999px document: a 928px box inside an 864px frame, a 4 868px document
 * instead of 4 951px. The content width is therefore the padding box minus the
 * padding, and the padding itself is carried separately.
 */
function cloneBox(doc: Document, body: HTMLElement): HTMLElement {
  const computed = doc.defaultView?.getComputedStyle(body)
  const box = doc.createElementNS(XHTML_NS, 'div')
  const rules = ['margin:0', 'box-sizing:content-box']
  if (computed) {
    const padLeft = Number.parseFloat(computed.paddingLeft) || 0
    const padRight = Number.parseFloat(computed.paddingRight) || 0
    rules.push(
      `width:${Math.max(0, body.clientWidth - padLeft - padRight)}px`,
      `padding:${computed.padding}`,
      `font-family:${computed.fontFamily}`,
      `font-size:${computed.fontSize}`,
      `line-height:${computed.lineHeight}`,
      `color:${computed.color}`,
      `background:${computed.backgroundColor}`,
      `text-align:${computed.textAlign}`,
      `position:${computed.position}`,
    )
    box.setAttribute('dir', computed.direction || 'ltr')
  } else {
    rules.push(`width:${body.clientWidth}px`)
  }
  box.setAttribute('style', rules.join(';'))
  for (const child of Array.from(body.childNodes)) box.appendChild(child.cloneNode(true))
  return box
}

/**
 * Lay the clone out beside the document it was cloned from and require the two
 * to agree, before anything is drawn.
 *
 * This is the one measurement that makes the whole approach safe. The export is
 * only faithful while the foreignObject lays the document out exactly as the
 * frame did, and there are several ways for that to stop being true — a
 * `width` that does not match the padding box, a rule the cloned stylesheet
 * does not carry, a font that resolves differently. Any of them produces an
 * image that is silently the wrong shape, and a picture nobody measures looks
 * right. So it is measured, and a mismatch fails the export with both numbers
 * in hand rather than shipping the picture.
 */
function assertCloneMatchesSource(
  body: HTMLElement,
  box: HTMLElement,
  expected: { width: number; height: number },
): void {
  const doc = body.ownerDocument
  // Absolute and far off-screen: it must not move the document it is being
  // measured against, and `body` is `position:relative` so this stays inside it.
  const probe = doc.createElement('div')
  probe.setAttribute('style', `position:absolute;left:-99999px;top:0;width:${expected.width}px;`)
  probe.appendChild(box)
  body.appendChild(probe)
  const measured = { width: box.offsetWidth, height: box.offsetHeight }
  probe.remove()
  if (measured.width !== expected.width || measured.height !== expected.height) {
    throw new Error(
      `the document does not lay out the same way outside its page ` +
      `(${measured.width}x${measured.height} against ${expected.width}x${expected.height})`,
    )
  }
}

/** Build the `<svg><foreignObject>` document for an already-laid-out `body`. */
function serializeBodyAsSvg(body: HTMLElement, box: HTMLElement, width: number, height: number): string {
  const doc = body.ownerDocument
  const svg = doc.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('xmlns', SVG_NS)
  svg.setAttribute('width', String(width))
  svg.setAttribute('height', String(height))
  const foreign = doc.createElementNS(SVG_NS, 'foreignObject')
  foreign.setAttribute('width', String(width))
  foreign.setAttribute('height', String(height))

  const host = doc.createElementNS(XHTML_NS, 'div')
  // The stylesheet travels with the document. `<style>` inside a `<div>` is
  // valid HTML5 and is the only way the foreignObject sees the renderer's CSS —
  // an SVG image has no `<head>` of its own to inherit from.
  for (const node of Array.from(doc.head.querySelectorAll('style,link'))) {
    host.appendChild(node.cloneNode(true))
  }
  host.appendChild(box)
  foreign.appendChild(host)
  svg.appendChild(foreign)
  return new XMLSerializer().serializeToString(svg)
}

interface DrawResult {
  dataUrl: string
  width: number
  height: number
}

/** The whole pipeline, run inside the frame's own document. */
async function rasterizeDocument(frameDoc: Document, format: ExportImageFormat, quality: number): Promise<DrawResult> {
  const win = frameDoc.defaultView
  const body = frameDoc.body
  if (!win || !body) throw new Error('export frame has no document')

  // Images inside the document have to be decoded before the frame is measured
  // or the layout is the one from before they arrived.
  await Promise.all(
    Array.from(frameDoc.images).map((img) =>
      img.complete ? Promise.resolve() : new Promise<void>((resolve) => {
        img.addEventListener('load', () => resolve(), { once: true })
        img.addEventListener('error', () => resolve(), { once: true })
      }),
    ),
  )

  const width = body.offsetWidth
  const height = body.offsetHeight
  if (width <= 0 || height <= 0) throw new Error('the document has no layout to export')

  const box = cloneBox(frameDoc, body)
  assertCloneMatchesSource(body, box, { width, height })
  const svg = serializeBodyAsSvg(body, box, width, height)
  const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`

  const image = new win.Image()
  await new Promise<void>((resolve, reject) => {
    image.addEventListener('load', () => resolve(), { once: true })
    image.addEventListener('error', () => reject(new Error('the document could not be drawn')), { once: true })
    image.src = svgUrl
  })

  const canvas = el(frameDoc, 'canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('this webview has no 2d canvas')

  // The ground is painted, not inherited. The export stylesheet leaves the body
  // transparent, and these images end up in chat windows and documents whose
  // background nobody here controls: a transparent PNG over a dark theme is
  // dark text on dark, and JPEG has no alpha at all, so an unpainted canvas is
  // encoded as BLACK by the engine's own choice. Measured: an unpainted JPEG
  // came back (0,0,0,255) at every sampled corner; painted first, (255,255,255).
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(image, 0, 0, width, height)

  const mime = IMAGE_MIME[format]
  const dataUrl = format === 'jpeg'
    ? canvas.toDataURL(mime, quality)
    : canvas.toDataURL(mime)
  // The engine answers with the format it actually produced. Trusting the
  // request instead is how a `.webp` ends up holding PNG bytes.
  if (!dataUrl.startsWith(`data:${mime}`)) {
    throw new Error(`the webview encoded ${mime} as ${dataUrl.slice(5, dataUrl.indexOf(';'))}`)
  }
  return { dataUrl, width: canvas.width, height: canvas.height }
}

function decodeBase64(dataUrl: string): string {
  const comma = dataUrl.indexOf(',')
  return comma === -1 ? '' : dataUrl.slice(comma + 1)
}

/**
 * Render `html` (a full document, as the renderer produces it) into one image
 * of the whole document.
 *
 * `html` must already have its images inlined — see the module header.
 */
export async function renderHtmlToImage(
  html: string,
  format: ExportImageFormat,
  quality: number,
): Promise<RenderedImage> {
  if (typeof document === 'undefined') throw new Error('no document to render in')
  const iframe = document.createElement('iframe')
  // NOT `display:none`: an element with no box gives its document no layout, so
  // the body would measure 0×0 and the export would fail on exactly the
  // documents this feature exists for. Off-screen and transparent instead.
  iframe.setAttribute('aria-hidden', 'true')
  iframe.style.cssText =
    `position:fixed;top:0;left:${-EXPORT_FRAME_SIZE * 20}px;width:${EXPORT_FRAME_SIZE}px;height:${EXPORT_FRAME_SIZE}px;border:0;opacity:0;pointer-events:none;`
  iframe.srcdoc = html
  document.body.appendChild(iframe)

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('the export frame never loaded')), LOAD_SAFETY_MS)
      iframe.addEventListener('load', () => resolve(), { once: true })
    })
    const frameDoc = iframe.contentDocument
    if (!frameDoc) throw new Error('the export frame has no document')
    const drawn = await rasterizeDocument(frameDoc, format, quality)
    return {
      base64: decodeBase64(drawn.dataUrl),
      mime: IMAGE_MIME[format],
      width: drawn.width,
      height: drawn.height,
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    iframe.remove()
  }
}
