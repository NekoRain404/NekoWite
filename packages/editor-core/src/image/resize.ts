/** Clamp a draggable image width to a sane range (>= 1px, <= max). */
export function clampWidth(width: number, max = 4000): number {
  return Math.max(1, Math.min(Math.round(width), max))
}

/** Compute the next width for a resize drag given the start width and dx. */
export function nextWidth(startWidth: number, deltaX: number): number {
  return clampWidth(startWidth + deltaX)
}
