import type { ConfigEdit, ConfigRead } from './agent-settings-policy'

export type PermissionAction = 'ask' | 'allow' | 'deny'
export interface PermissionEditorRule { tool: string; action: PermissionAction | null }
export type PermissionEditorView =
  | { kind: 'editable'; absent: boolean; rules: PermissionEditorRule[] }
  | { kind: 'unsupported' | 'readonly' | 'complex' | 'unreadable' }

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function permissionAction(value: unknown): value is PermissionAction {
  return value === 'ask' || value === 'allow' || value === 'deny'
}

export function permissionEditor(document: ConfigRead, verifiedOpenCode: boolean): PermissionEditorView {
  if (!verifiedOpenCode) return { kind: 'unsupported' }
  if (!document.editable) return { kind: 'readonly' }
  const projection = document.permissionRules
  if (!record(projection)) return { kind: 'unreadable' }
  if (projection.kind === 'complex') return { kind: 'complex' }
  if (projection.kind === 'absent') {
    return { kind: 'editable', absent: true, rules: [{ tool: 'edit', action: 'ask' }, { tool: 'bash', action: 'ask' }] }
  }
  if (projection.kind !== 'object' || !record(projection.rules)) return { kind: 'unreadable' }
  const rules = Object.entries(projection.rules).map(([tool, action]) => ({
    tool,
    // Pattern and nested rules keep their original precedence and structure on disk.
    action: /^[a-z][a-z0-9_]*$/.test(tool) && permissionAction(action) ? action : null,
  }))
  return { kind: 'editable', absent: false, rules }
}

export function permissionEdits(view: Extract<PermissionEditorView, { kind: 'editable' }>, draft: Record<string, PermissionAction>): ConfigEdit[] {
  const edits: ConfigEdit[] = view.absent ? [{ path: ['permission'], value: {}, ifAbsent: true }] : []
  for (const rule of view.rules) {
    const value = draft[rule.tool]
    if (rule.action !== null && permissionAction(value) && (view.absent || value !== rule.action)) {
      edits.push({ path: ['permission', rule.tool], value })
    }
  }
  return edits
}
