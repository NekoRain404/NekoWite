/** Clamp a draggable image dimension to a sane range (>= 1px, <= max). */
export function clampWidth(width: number, max = 4000): number {
  return Math.max(1, Math.min(Math.round(width), max))
}

/** Compute the next width for a resize drag given the start width and dx. */
export function nextWidth(startWidth: number, deltaX: number): number {
  return clampWidth(startWidth + deltaX)
}

/** Keyboard sizing step for arrow-key width adjust (px). */
export const KEY_STEP = 10

/** A safe aspect ratio (w/h). Falls back to 1 (square) when unmeasurable. */
export function safeRatio(width: number, height: number): number {
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return width / height
  }
  return 1
}

/**
 * Compute `{width, height}` for a proportional (aspect-locked) resize.
 * Given the original dimensions and the target width, height is derived from
 * the ratio so the image never distorts. The returned width is clamped; height
 * follows the ratio and clamps to >= 1px.
 */
export function proportionalSize(
  startWidth: number,
  startHeight: number,
  targetWidth: number,
): { width: number; height: number } {
  const ratio = safeRatio(startWidth, startHeight)
  const width = clampWidth(targetWidth)
  const height = Math.max(1, Math.round(width / ratio))
  return { width, height }
}
