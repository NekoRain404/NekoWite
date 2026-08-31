import type { NekoEditor } from '@nekowite/editor-core'

type EditorView = NonNullable<ReturnType<NekoEditor['getView']>>

export type FloatBoxProps = {
  x: number
  y: number
  w: number
  h: number
  angle: number
  z: number
}

export type ResizeCorner = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

export type DragBase = { x: number; y: number }
export type ResizeBase = { x: number; y: number; w: number; h: number }
export type RotateBase = { angle: number }

const MIN_SIZE = 20

function toFiniteNumber(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

export function normalizeProps(p: Record<string, string>): FloatBoxProps {
  return {
    x: toFiniteNumber(p.x, 0),
    y: toFiniteNumber(p.y, 0),
    w: toFiniteNumber(p.w, 240),
    h: toFiniteNumber(p.h, 160),
    angle: toFiniteNumber(p.angle, 0),
    z: toFiniteNumber(p.z, 1),
  }
}

export function applyDrag(base: DragBase, dx: number, dy: number): DragBase {
  return { x: Math.round(base.x + dx), y: Math.round(base.y + dy) }
}

function clampMin(n: number): number {
  return Math.max(MIN_SIZE, n)
}

export function applyResize(
  base: ResizeBase,
  corner: ResizeCorner,
  dx: number,
  dy: number,
): ResizeBase {
  const res: ResizeBase = { ...base }
  const fromWest = corner === 'nw' || corner === 'w' || corner === 'sw'
  const fromNorth = corner === 'nw' || corner === 'n' || corner === 'ne'
  const fromEast = corner === 'ne' || corner === 'e' || corner === 'se'
  const fromSouth = corner === 'se' || corner === 's' || corner === 'sw'
  if (fromWest) {
    res.x = Math.round(base.x + dx)
    res.w = clampMin(Math.round(base.w - dx))
  } else if (fromEast) {
    res.w = clampMin(Math.round(base.w + dx))
  }
  if (fromNorth) {
    res.y = Math.round(base.y + dy)
    res.h = clampMin(Math.round(base.h - dy))
  } else if (fromSouth) {
    res.h = clampMin(Math.round(base.h + dy))
  }
  return res
}

export function applyRotate(base: RotateBase, dAngleDeg: number): RotateBase {
  return { angle: Math.round(base.angle + dAngleDeg) }
}

export function updateFloatProps(
  view: EditorView | null,
  pos: number,
  propsDelta: Record<string, string>,
): void {
  if (!view) return
  const node = view.state.doc.nodeAt(pos)
  if (!node) return
  const oldProps = (node.attrs.props ?? {}) as Record<string, string>
  view.dispatch(
    view.state.tr.setNodeMarkup(pos, undefined, {
      ...node.attrs,
      props: { ...oldProps, ...propsDelta },
    }),
  )
}
