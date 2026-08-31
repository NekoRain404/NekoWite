import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useFloatStore } from './float'

const dispatchMock = vi.hoisted(() => vi.fn())
const lastSetNodeMarkup = vi.hoisted(() => ({ args: [] as unknown[] }))
const lastDelete = vi.hoisted(() => ({ args: [] as unknown[] }))
const trMock = vi.hoisted(() => {
  const tr = {
    setNodeMarkup: vi.fn((...args: unknown[]) => {
      lastSetNodeMarkup.args = args
      return tr
    }),
    delete: vi.fn((...args: unknown[]) => {
      lastDelete.args = args
      return tr
    }),
  }
  return tr
})
const nodeAtMock = vi.hoisted(() => vi.fn())
vi.mock('../services/editorBridge', () => ({
  editorBridge: {
    getView: vi.fn(() => ({
      state: { tr: trMock, doc: { nodeAt: nodeAtMock } },
      dispatch: dispatchMock,
    })),
  },
}))

describe('useFloatStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    dispatchMock.mockClear()
    trMock.setNodeMarkup.mockClear()
    trMock.delete.mockClear()
    nodeAtMock.mockReset()
  })

  it('selects id and position, and clears', () => {
    const s = useFloatStore()
    s.select('5', 5)
    expect(s.selectedId).toBe('5')
    expect(s.activePos).toBe(5)
    s.select(null)
    expect(s.selectedId).toBeNull()
    expect(s.activePos).toBeNull()
  })

  it('onSelectChange fires on select and clear, and unsubscribes', () => {
    const s = useFloatStore()
    const seen: (string | null)[] = []
    const off = s.onSelectChange((id) => seen.push(id))
    s.select('5', 5)
    s.select('7', 7)
    s.select(null)
    off()
    s.select('9', 9)
    expect(seen).toEqual(['5', '7', null])
  })

  it('bringForward bumps z via setNodeMarkup', () => {
    const s = useFloatStore()
    s.select('0', 0)
    nodeAtMock.mockReturnValue({
      type: { name: 'mdxComponent' },
      nodeSize: 2,
      attrs: { name: 'FloatBox', props: { x: '0', y: '0' }, children: '' },
    })
    s.bringForward()
    const call = lastSetNodeMarkup.args
    expect(call[0]).toBe(0)
    expect(call[2]).toEqual({
      name: 'FloatBox',
      props: { x: '0', y: '0', z: '2' },
      children: '',
    })
    expect(dispatchMock).toHaveBeenCalledWith(trMock)
    expect(s.selectedId).toBe('0')
    expect(s.activePos).toBe(0)
  })

  it('sendBackward decrements z via setNodeMarkup', () => {
    const s = useFloatStore()
    s.select('0', 3)
    nodeAtMock.mockReturnValue({
      type: { name: 'mdxComponent' },
      nodeSize: 2,
      attrs: { name: 'FloatBox', props: { z: '9' }, children: '' },
    })
    s.sendBackward()
    const call = lastSetNodeMarkup.args
    expect(call[0]).toBe(3)
    expect(call[2]).toEqual({ name: 'FloatBox', props: { z: '8' }, children: '' })
    expect(dispatchMock).toHaveBeenCalledWith(trMock)
  })

  it('removeSelected deletes the node at activePos', () => {
    const s = useFloatStore()
    s.select('0', 0)
    nodeAtMock.mockReturnValue({
      type: { name: 'mdxComponent' },
      nodeSize: 3,
      attrs: { name: 'FloatBox', props: {}, children: '' },
    })
    s.removeSelected()
    const call = lastDelete.args
    expect(call[0]).toBe(0)
    expect(call[1]).toBe(3)
    expect(dispatchMock).toHaveBeenCalledWith(trMock)
    expect(s.selectedId).toBeNull()
    expect(s.activePos).toBeNull()
  })
})