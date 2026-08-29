import { describe, expect, it } from 'vitest'
import { registerCommand, getCommand, registerComponent, getComponent, registerToolbar, getToolbar, registerAll } from './registry'
import { defineComponent, h } from 'vue'

const Dummy = defineComponent({ setup: () => () => h('div', 'x') })

describe('registry', () => {
  it('registers and retrieves command', () => {
    const run = () => {}
    registerCommand({ id: 'c1', run })
    expect(getCommand('c1')?.run).toBe(run)
  })
  it('registers component', () => {
    registerComponent('Callout', Dummy)
    expect(getComponent('Callout')).toBe(Dummy)
  })
  it('registers toolbar items in order', () => {
    registerToolbar({ id: 't1', label: 'T1', run: () => {} })
    expect(getToolbar().some((t) => t.id === 't1')).toBe(true)
  })
  it('registerAll registers batch', () => {
    const run = () => {}
    registerAll({ commands: [{ id: 'c2', run }], toolbar: [{ id: 't2', label: 'T2', run }] })
    expect(getCommand('c2')?.run).toBe(run)
    expect(getToolbar().some((t) => t.id === 't2')).toBe(true)
  })
  it('throws on duplicate command id', () => {
    registerCommand({ id: 'dup', run: () => {} })
    expect(() => registerCommand({ id: 'dup', run: () => {} })).toThrow()
  })
})
