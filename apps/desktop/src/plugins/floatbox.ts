import { defineComponent, h, onBeforeUnmount, onMounted, ref } from 'vue'
import { definePlugin } from '@nekowite/plugin-host'
import type { NekoEditor } from '@nekowite/editor-core'
import { insertMdxComponent } from '@nekowite/editor-core'
import { editorBridge } from '../services/editorBridge'
import { useFloatStore } from '../stores/float'
import {
  applyDrag,
  applyResize,
  applyRotate,
  normalizeProps,
  updateFloatProps,
  type ResizeCorner,
} from '../services/floatProps'

type EditorView = NonNullable<ReturnType<NekoEditor['getView']>>

const currentSelectedId = ref<string | null>(null)
let selectionUnsub: (() => void) | null = null
let selectionSubCount = 0

function onStoreSelect(id: string | null): void {
  currentSelectedId.value = id
}

export function subscribeSelection(): () => void {
  selectionSubCount++
  if (!selectionUnsub) {
    const store = useFloatStore()
    currentSelectedId.value = store.selectedId
    selectionUnsub = store.onSelectChange(onStoreSelect)
  }
  return () => {
    selectionSubCount = Math.max(0, selectionSubCount - 1)
    if (selectionSubCount === 0) {
      selectionUnsub?.()
      selectionUnsub = null
    }
  }
}

export function unsubscribeSelection(): void {
  selectionSubCount = 0
  selectionUnsub?.()
  selectionUnsub = null
  currentSelectedId.value = null
}

export function getCurrentSelectedId(): string | null {
  return currentSelectedId.value
}

type FloatBoxProps = {
  x: string
  y: string
  w: string
  h: string
  angle: string
  z: string
  children: string
  _getPos?: () => number | undefined
  _view?: EditorView | null
}

type DragBase = { x: number; y: number; w: number; h: number; angle: number }

type DragSession = {
  mode: 'drag' | 'resize' | 'rotate'
  corner: ResizeCorner | null
  started: boolean
  startX: number
  startY: number
  base: DragBase
  view: EditorView | null
  getPos: (() => number | undefined) | undefined
}

let session: DragSession | null = null

function posOf(getPos: (() => number | undefined) | undefined): number | undefined {
  return typeof getPos === 'function' ? getPos() : undefined
}

function resolveView(view: EditorView | null | undefined): EditorView | null {
  return view ?? editorBridge.getView()
}

function applyDelta(view: EditorView | null, getPos: (() => number | undefined) | undefined, delta: Record<string, string>): void {
  const pos = posOf(getPos)
  if (pos == null) return
  updateFloatProps(view, pos, delta)
}

function onWindowPointerMove(e: PointerEvent): void {
  if (!session) return
  const dx = e.clientX - session.startX
  const dy = e.clientY - session.startY
  if (!session.started) {
    if (Math.abs(dx) + Math.abs(dy) < 3) return
    session.started = true
  }
  const { base, mode } = session
  let delta: Record<string, string> = {}
  if (mode === 'drag') {
    const p = applyDrag({ x: base.x, y: base.y }, dx, dy)
    delta = { x: String(p.x), y: String(p.y) }
  } else if (mode === 'resize' && session.corner) {
    const r = applyResize(
      { x: base.x, y: base.y, w: base.w, h: base.h },
      session.corner,
      dx,
      dy,
    )
    delta = {
      x: String(r.x),
      y: String(r.y),
      w: String(r.w),
      h: String(r.h),
    }
  } else if (mode === 'rotate') {
    const cx = base.x + base.w / 2
    const cy = base.y + base.h / 2
    const cur = Math.atan2(e.clientY - cy, e.clientX - cx)
    const start = Math.atan2(session.startY - cy, session.startX - cx)
    const a = applyRotate({ angle: base.angle }, ((cur - start) * 180) / Math.PI)
    delta = { angle: String(a.angle) }
  }
  applyDelta(session.view, session.getPos, delta)
}

function onWindowPointerUp(): void {
  session = null
}

if (typeof window !== 'undefined') {
  window.addEventListener('pointermove', onWindowPointerMove)
  window.addEventListener('pointerup', onWindowPointerUp)
  window.addEventListener('pointercancel', onWindowPointerUp)
}

export const FloatBox = defineComponent({
  props: {
    x: { type: String, default: '0' },
    y: { type: String, default: '0' },
    w: { type: String, default: '240' },
    h: { type: String, default: '160' },
    angle: { type: String, default: '0' },
    z: { type: String, default: '1' },
    children: { type: String, default: '' },
    // eslint-disable-next-line vue/prop-name-casing
    _getPos: { type: Function as unknown as () => (() => number | undefined) | undefined, default: undefined },
    // eslint-disable-next-line vue/prop-name-casing
    _view: { type: Object as unknown as () => EditorView | null, default: null },
  },
  setup(props) {
    const p = props as unknown as FloatBoxProps
    const getPos = () => posOf(p._getPos)
    const view = () => resolveView(p._view)

    let unsubSelection: (() => void) | null = null
    onMounted(() => {
      unsubSelection = subscribeSelection()
    })
    onBeforeUnmount(() => {
      unsubSelection?.()
      unsubSelection = null
    })

    const selectSelf = (): void => {
      const pos = getPos()
      const store = useFloatStore()
      store.select(pos != null ? String(pos) : null, pos)
    }

    const startDrag = (e: PointerEvent): void => {
      selectSelf()
      if ((e.target as Element).closest('.fb-content')) return
      e.preventDefault()
      const n = normalizeProps({
        x: p.x,
        y: p.y,
        w: p.w,
        h: p.h,
        angle: p.angle,
        z: p.z,
      })
      session = {
        mode: 'drag',
        corner: null,
        started: false,
        startX: e.clientX,
        startY: e.clientY,
        base: { x: n.x, y: n.y, w: n.w, h: n.h, angle: n.angle },
        view: view(),
        getPos,
      }
    }

    const startResize = (corner: ResizeCorner) => (e: PointerEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      selectSelf()
      const n = normalizeProps({ x: p.x, y: p.y, w: p.w, h: p.h, angle: p.angle, z: p.z })
      session = {
        mode: 'resize',
        corner,
        started: true,
        startX: e.clientX,
        startY: e.clientY,
        base: { x: n.x, y: n.y, w: n.w, h: n.h, angle: n.angle },
        view: view(),
        getPos,
      }
    }

    const startRotate = (e: PointerEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      selectSelf()
      const n = normalizeProps({ x: p.x, y: p.y, w: p.w, h: p.h, angle: p.angle, z: p.z })
      session = {
        mode: 'rotate',
        corner: null,
        started: true,
        startX: e.clientX,
        startY: e.clientY,
        base: { x: n.x, y: n.y, w: n.w, h: n.h, angle: n.angle },
        view: view(),
        getPos,
      }
    }

    const onContentBlur = (e: FocusEvent): void => {
      const el = e.target as HTMLElement
      updateFloatChildren(view(), getPos(), el.innerText)
    }

    const corners: ResizeCorner[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

    return () => {
      const pos = getPos()
      const selected = pos != null && getCurrentSelectedId() === String(pos)
      const style: Record<string, string> = {
        position: 'absolute',
        left: `${p.x}px`,
        top: `${p.y}px`,
        width: `${p.w}px`,
        height: `${p.h}px`,
        transform: `rotate(${p.angle}deg)`,
        zIndex: p.z,
      }
      return h(
        'div',
        {
          class: ['float-box', { selected }],
          style,
          onPointerdown: startDrag,
        },
        [
          h('div', {
            class: 'fb-content',
            contenteditable: 'plaintext-only',
            textContent: p.children,
            onBlur: onContentBlur,
          }),
          ...corners.map((c) =>
            h('div', {
              class: `fb-handle fb-${c}`,
              onPointerdown: startResize(c),
            }),
          ),
          h('div', { class: 'fb-rotate-handle', onPointerdown: startRotate }, '↻'),
        ],
      )
    }
  },
})

function updateFloatChildren(view: EditorView | null, pos: number | undefined, text: string): void {
  if (view == null || pos == null) return
  const node = view.state.doc.nodeAt(pos)
  if (!node) return
  view.dispatch(
    view.state.tr.setNodeMarkup(pos, undefined, {
      ...node.attrs,
      children: text,
    }),
  )
}

export function insertFloatBox(): void {
  const view = editorBridge.getView()
  if (!view) return
  insertMdxComponent(view, { name: 'FloatBox', props: {}, children: '浮动内容' })
}

export const floatboxPlugin = definePlugin({
  name: 'FloatBox',
  components: { FloatBox },
  toolbar: [{ id: 'floatbox.insert', label: '插入 FloatBox', run: insertFloatBox }],
})
