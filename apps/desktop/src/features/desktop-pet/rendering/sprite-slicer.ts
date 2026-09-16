/**
 * Slicing a spritesheet into frames, by alpha gutter.
 *
 * Ported from `references/desktop-pet/windows/src/pet.ts` at commit
 * `be171a01273a1ed92a27bcdf72f8a58768bac421`:
 *   - `ALPHA_THRESHOLD`, `COLS`, `ROWS` (lines 8-10)
 *   - `segments` (64-74)
 *   - `slice` (76-111), the slicing loop itself, unchanged
 *   - the fixed 8x9 grid cell used when pixels are unreadable (295-301)
 *   - the per-clip widest frame (172, applied at 293)
 *
 * The algorithm is kept because it is what makes the pet work on ragged sheets:
 * transparent rows split the sheet into clips and transparent columns split each clip
 * into frames, so an empty cell in a row simply does not exist and the pet never blinks
 * out on a sparse row. The only thing that needs a DOM is reading the pixels, and that is
 * the single dependency a caller may inject (plan §3: 配置、时钟和随机源改为注入) - which
 * is also what makes slicing testable without a browser.
 */

/** Alpha above this counts as a drawn pixel (upstream line 10; also used for hit-testing). */
export const ALPHA_THRESHOLD = 16

/** The grid assumed when the sheet's pixels cannot be read (upstream 8-9, used at 295-301). */
export const FIXED_GRID_COLS = 8
export const FIXED_GRID_ROWS = 9

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * What the slicer needs of an image. Structural rather than `HTMLImageElement` so a test
 * can hand it a synthetic sheet.
 */
export interface SpriteImageLike {
  readonly naturalWidth: number
  readonly naturalHeight: number
}

/** The sheet's pixels, as RGBA. */
export interface SheetPixels {
  width: number
  height: number
  data: Uint8ClampedArray
}

/**
 * Reads the sheet's pixels. `null` is upstream's single "pixels unreadable" signal - no
 * 2D context, a tainted canvas (loaded without CORS), or an image that never decoded -
 * and the caller then falls back to the fixed grid instead of sliced clips.
 */
export type SheetPixelReader = (
  img: SpriteImageLike,
  width: number,
  height: number,
) => SheetPixels | null

/** Contiguous runs of `true` in an occupancy array, as `[start, end)` pairs (upstream 64-74). */
export function segments(occ: Uint8Array): Array<[number, number]> {
  const out: Array<[number, number]> = []
  let start = -1
  for (let i = 0; i < occ.length; i++) {
    if (occ[i] && start < 0) start = i
    else if (!occ[i] && start >= 0) {
      out.push([start, i])
      start = -1
    }
  }
  if (start >= 0) out.push([start, occ.length])
  return out
}

/**
 * The default reader: draw the sheet onto an offscreen canvas and take its pixels
 * (upstream 80-90). Not one thing about it changed except that every failure mode exits
 * with `null` instead of only the CORS `getImageData` throw: a detached, corrupt or
 * not-yet-decoded image throws out of `drawImage` too, and the caller's contract is
 * "unreadable pixels → fixed grid", so one signal covers all of them (plan §3: 处理销毁
 * 与资源失败).
 */
export function readSheetPixels(
  img: SpriteImageLike,
  width: number,
  height: number,
): SheetPixels | null {
  try {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    // willReadFrequently, as upstream: the alpha scan reads the whole buffer once.
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    ctx.drawImage(img as unknown as CanvasImageSource, 0, 0)
    const image = ctx.getImageData(0, 0, width, height)
    return { width: image.width, height: image.height, data: image.data }
  } catch {
    // Tainted canvas (no CORS) or an image that cannot be drawn: displayable, unsliceable.
    return null
  }
}

/**
 * Alpha-gutter slice: rows by transparent bands, then frames within each row
 * (upstream `slice`, 76-111).
 *
 * Returns one array of frames per clip. An empty array means "no clips" - a sheet that is
 * entirely transparent, or whose pixels could not be read - and the player then draws
 * from the fixed grid, exactly as upstream did.
 */
export function sliceSheet(
  img: SpriteImageLike,
  readPixels: SheetPixelReader = readSheetPixels,
): Rect[][] {
  const w = img.naturalWidth
  const h = img.naturalHeight
  // Upstream 79: an image with no dimensions has nothing to slice. This is also the
  // "illegal dimensions" case - a 0-wide sheet, or one that never finished decoding.
  if (!w || !h) return []

  const pixels = readPixels(img, w, h)
  if (!pixels) return []
  // Upstream read whatever `getImageData` returned because it had just sized the canvas
  // from the image. The reader is injectable now, so the buffer is checked instead of
  // trusted: a short or differently-sized buffer indexed with the upstream row/column
  // maths would read unrelated pixels as if they were the sheet's, and a reader that
  // rescaled the sheet would silently produce clips at the wrong coordinates. Refusing
  // the data degrades to the fixed grid, which is a visible, explainable fallback.
  if (pixels.width !== w || pixels.height !== h || pixels.data.length < w * h * 4) return []

  const { data } = pixels
  const rowHas = new Uint8Array(h)
  for (let y = 0; y < h; y++) {
    const off = y * w * 4
    for (let x = 0; x < w; x++) {
      if (data[off + x * 4 + 3] > ALPHA_THRESHOLD) {
        rowHas[y] = 1
        break
      }
    }
  }

  const clips: Rect[][] = []
  for (const [y0, y1] of segments(rowHas)) {
    const colHas = new Uint8Array(w)
    for (let y = y0; y < y1; y++) {
      const off = y * w * 4
      for (let x = 0; x < w; x++) {
        if (data[off + x * 4 + 3] > ALPHA_THRESHOLD) colHas[x] = 1
      }
    }
    const clip = segments(colHas).map(([x0, x1]) => ({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }))
    if (clip.length) clips.push(clip)
  }
  return clips
}

/**
 * The widest frame of each clip (upstream 172). The scale is computed per clip rather
 * than per frame so a clip whose frames differ slightly in width does not pulse, and the
 * bubble above the pet does not bounce.
 *
 * An empty clip yields 0 rather than upstream's `Math.max()` of nothing, which is
 * `-Infinity` and would make the fit divide by it. `sliceSheet` never produces one, but a
 * caller can.
 */
export function clipWidths(clips: Rect[][]): number[] {
  return clips.map((clip) => (clip.length ? Math.max(...clip.map((frame) => frame.w)) : 0))
}

/**
 * Clamps a row index into `[0, count - 1]` (upstream clamped with `Math.min` at 263 and
 * 299). A row that is not a usable index - negative, fractional, `NaN`, or an unknown
 * state that never got a mapping - resolves to a real row instead of indexing with `NaN`
 * and falling through to `undefined` (§5.2: 未知动画行明确回退，不读任意越界帧).
 */
export function clampRow(row: number, count: number): number {
  if (!Number.isFinite(row)) return 0
  if (count <= 0) return 0
  return Math.min(Math.max(Math.floor(row), 0), count - 1)
}

/**
 * The fixed 8x9 grid cell for a frame, used when the sheet's pixels are unreadable
 * (upstream 295-301). Upstream clamped only the upper bound, so a negative row produced a
 * negative source `y` - `drawImage` then clips it and the pet silently disappears; the
 * row is clamped on both ends here.
 */
export function fallbackGridFrame(img: SpriteImageLike, frame: number, row: number): Rect | null {
  const fw = img.naturalWidth / FIXED_GRID_COLS
  const fh = img.naturalHeight / FIXED_GRID_ROWS
  if (!fw || !fh) return null
  return {
    x: (frame % FIXED_GRID_COLS) * fw,
    y: clampRow(row, FIXED_GRID_ROWS) * fh,
    w: fw,
    h: fh,
  }
}
