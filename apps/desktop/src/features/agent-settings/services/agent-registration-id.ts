import type { AgentRegistryEntry } from './agent-registry-policy'

export function suggestRegistrationId(name: string, program: string, entries: readonly AgentRegistryEntry[]): string {
  const source = name.trim() || program.split('/').pop() || 'agent'
  const base = source.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[._-]+|[._-]+$/g, '').slice(0, 54) || 'agent'
  const ids = new Set(entries.map(entry => entry.agentId))
  let candidate = base
  for (let suffix = 2; ids.has(candidate); suffix++) candidate = `${base}-${suffix}`
  return candidate
}
