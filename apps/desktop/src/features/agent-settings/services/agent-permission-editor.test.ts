import { describe, expect, it } from 'vitest'
import { permissionEditor, permissionEdits } from './agent-permission-editor'
import type { ConfigRead } from './agent-settings-policy'

const document = (permissionRules: unknown): ConfigRead => ({
  path: 'opencode.jsonc', resolved: '/profile/opencode.jsonc', exists: true,
  revision: 'revision', text: '{}', editable: true, permissionRules,
})

describe('permission editor policy', () => {
  it('edits scalar rules but preserves complex and pattern rules', () => {
    const view = permissionEditor(document({ kind: 'object', rules: { edit: 'ask', bash: null, '*': 'deny' } }), true)
    expect(view.kind).toBe('editable')
    if (view.kind !== 'editable') return
    expect(view.rules.find(rule => rule.tool === 'bash')?.action).toBeNull()
    expect(view.rules.find(rule => rule.tool === '*')?.action).toBeNull()
    expect(permissionEdits(view, { edit: 'deny', bash: 'allow', '*': 'allow' })).toEqual([
      { path: ['permission', 'edit'], value: 'deny' },
    ])
  })

  it('refuses unsupported, readonly, complex-root and unparsed documents', () => {
    expect(permissionEditor(document({ kind: 'absent' }), false).kind).toBe('unsupported')
    expect(permissionEditor({ ...document({ kind: 'absent' }), editable: false }, true).kind).toBe('readonly')
    expect(permissionEditor(document({ kind: 'complex' }), true).kind).toBe('complex')
    expect(permissionEditor(document(undefined), true).kind).toBe('unreadable')
  })

  it('creates an absent permission object with safe ask defaults using conditional insertion', () => {
    const view = permissionEditor(document({ kind: 'absent' }), true)
    expect(view.kind).toBe('editable')
    if (view.kind !== 'editable') return
    expect(view.rules).toEqual([{ tool: 'edit', action: 'ask' }, { tool: 'bash', action: 'ask' }])
    expect(permissionEdits(view, { edit: 'ask', bash: 'ask' })).toEqual([
      { path: ['permission'], value: {}, ifAbsent: true },
      { path: ['permission', 'edit'], value: 'ask' },
      { path: ['permission', 'bash'], value: 'ask' },
    ])
  })
})
