/**
 * Is this point on the character, or on the empty space around it?
 *
 * Ported from `references/desktop-pet/windows/src/pet.ts` at commit
 * `be171a01273a1ed92a27bcdf72f8a58768bac421`, `hitTest` (136-150): the sprite rect
 * pre-check, the CSS-pixel to backing-store scaling, the single-pixel alpha read, and the
 * fallback to "inside the rect" when the canvas is tainted.
 *
 * The result is what the shell uses to tell a drag on the pet from a click on the
 * transparent gap beside it (§7.2) - it is not OS-level click-through, and no caller
 * should describe it as one.
 *
 * The scaling is upstream's and is why the test survives a device pixel ratio: the
 * backing store and the CSS box differ by exactly that ratio, and the rect being tested
 * is in backing-store pixels, so a point that hits at 1x hits at 2x.
 */
import { ALPHA_THRESHOLD, type Rect } from './sprite-slicer'

/** The canvas as the test sees it: backing-store pixels plus the laid-out CSS box. */
export interface HitSurface {
  width: number
  height: number
  clientWidth: number
  clientHeight: number
}

export interface HitPoint {
  x: number
  y: number
}

/**
 * Alpha of one backing-store pixel, or `null` when the pixels cannot be read (a tainted
 * canvas). `null` and `0` mean different things: `null` falls back to the rect, `0` is a
 * miss.
 */
export type PointAlphaReader = (x: number, y: number) => number | null

export interface HitTestOptions {
  /** The last drawn sprite bounds, in backing-store pixels, or null when nothing is drawn. */
  spriteRect: Rect | null
  surface: HitSurface
  readAlpha: PointAlphaReader
}

/**
 * `cssX`/`cssY` are CSS pixels relative to the canvas, as a pointer event delivers them.
 */
export function hitTestSprite(point: HitPoint, options: HitTestOptions): boolean {
  const rect = options.spriteRect
  const { surface, readAlpha } = options
  // Nothing has been drawn: nothing to hit (upstream 139-140).
  if (!rect) return false

  // Upstream 141-142. `|| 1` guards a canvas that has no layout box yet - an unlaid-out
  // element would otherwise divide by zero and turn every point into NaN, which fails
  // every comparison and reads as "never hits".
  const kx = surface.width / (surface.clientWidth || 1)
  const ky = surface.height / (surface.clientHeight || 1)
  const x = point.x * kx
  const y = point.y * ky

  // Upper edges are inclusive, as upstream left them (144). The alpha read one pixel past
  // the sprite then rejects the point anyway, so this is only a 1px sliver of work.
  if (x < rect.x || x > rect.x + rect.w || y < rect.y || y > rect.y + rect.h) return false

  const alpha = readAlpha(Math.floor(x), Math.floor(y))
  // Upstream 146-149: pixels unreadable (tainted canvas) means the rect alone decides.
  if (alpha === null) return true
  return alpha > ALPHA_THRESHOLD
}

/**
 * The alpha reader over a live 2D context (upstream 146). The same threshold as slicing
 * is used; upstream wrote a bare `16` here while naming `ALPHA_THRESHOLD` at the top of
 * the file, which is the kind of pair that drifts.
 */
export function contextAlphaReader(ctx: CanvasRenderingContext2D): PointAlphaReader {
  return (x, y) => {
    try {
      return ctx.getImageData(x, y, 1, 1).data[3]
    } catch {
      // A tainted canvas throws here; displayable, unreadable.
      return null
    }
  }
}
