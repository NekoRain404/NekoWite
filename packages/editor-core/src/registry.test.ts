import { describe, expect, it } from 'vitest'
import {
  registerCommand,
  getCommand,
  listCommands,
  registerComponent,
  getComponent,
  registerToolbar,
  getToolbar,
  registerAll,
  unregisterCommand,
  unregisterComponent,
  unregisterToolbar,
} from './registry'
import { defineComponent, h } from 'vue'

const Dummy = defineComponent({ setup: () => () => h('div', 'x') })

describe('registry', () => {
  it('registers and retrieves command', () => {
    const run = () => {}
    registerCommand({ id: 'c1', run })
    expect(getCommand('c1')?.run).toBe(run)
  })
  it('lists registered commands and drops unregistered ones', () => {
    registerCommand({ id: 'c-list', run: () => {} })
    expect(listCommands().some((c) => c.id === 'c-list')).toBe(true)
    unregisterCommand('c-list')
    expect(listCommands().some((c) => c.id === 'c-list')).toBe(false)
  })
  it('registers component', () => {
    registerComponent('Callout', Dummy)
    expect(getComponent('Callout')).toBe(Dummy)
  })
  it('registers toolbar items in order', () => {
    registerToolbar({ id: 't1', label: 'T1', run: () => {} })
    expect(getToolbar().some((t) => t.id === 't1')).toBe(true)
  })
  it('registerToolbar replaces an existing id instead of duplicating', () => {
    const first = () => {}
    const second = () => {}
    registerToolbar({ id: 't-upsert', label: 'A', run: first })
    registerToolbar({ id: 't-upsert', label: 'B', run: second })
    const items = getToolbar().filter((t) => t.id === 't-upsert')
    expect(items).toHaveLength(1)
    expect(items[0].label).toBe('B')
    expect(items[0].run).toBe(second)
  })
  it('registerToolbar re-registers an id IN PLACE, keeping toolbar order', () => {
    // The features re-run per editor (tableFeature/mathFeature) and plugins
    // re-register on activation, so the same id is registered repeatedly. The
    // update must overwrite the existing entry rather than remove-and-append:
    // a button that drifted to the end of the toolbar on every reload is a
    // visible regression, and it is what made the features' own
    // `unregisterToolbar` call (before re-registering) a bug worth removing.
    registerToolbar({ id: 't-order-a', label: 'A', run: () => {} })
    registerToolbar({ id: 't-order-b', label: 'B', run: () => {} })
    registerToolbar({ id: 't-order-c', label: 'C', run: () => {} })
    const before = getToolbar().map((t) => t.id)
    const at = before.indexOf('t-order-b')
    expect(at).toBeGreaterThanOrEqual(0)

    registerToolbar({ id: 't-order-b', label: 'B2', run: () => {} })

    expect(getToolbar().map((t) => t.id)).toEqual(before)
    expect(getToolbar().find((t) => t.id === 't-order-b')?.label).toBe('B2')
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
  it('unregisters a command', () => {
    const run = () => {}
    registerCommand({ id: 'c-unreg', run })
    expect(getCommand('c-unreg')?.run).toBe(run)
    unregisterCommand('c-unreg')
    expect(getCommand('c-unreg')).toBeUndefined()
  })
  it('unregisters a component', () => {
    registerComponent('UnregComp', Dummy)
    expect(getComponent('UnregComp')).toBe(Dummy)
    unregisterComponent('UnregComp')
    expect(getComponent('UnregComp')).toBeUndefined()
  })
  it('unregisters a toolbar item by id', () => {
    registerToolbar({ id: 't-unreg', label: 'T', run: () => {} })
    expect(getToolbar().some((t) => t.id === 't-unreg')).toBe(true)
    unregisterToolbar('t-unreg')
    expect(getToolbar().some((t) => t.id === 't-unreg')).toBe(false)
  })
  it('unregister of unknown id is a no-op', () => {
    expect(() => unregisterCommand('no-such')).not.toThrow()
    expect(() => unregisterComponent('no-such')).not.toThrow()
    expect(() => unregisterToolbar('no-such')).not.toThrow()
  })
})
