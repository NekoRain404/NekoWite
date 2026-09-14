/**
 * The settings domain's storage codec: how one stored scalar becomes one typed
 * setting value, or the fallback when it is not the shape this app wrote.
 *
 * Settings are the domain that uses many scalar keys rather than a single
 * versioned blob (see `services/persistence`), so what these five readers share
 * is the *encoding* — a list is JSON, a boolean is the literal `'true'`/`'false'`
 * , a number is whatever `Number` makes of it — and that is the one job here.
 *
 * What is deliberately NOT here is any key's name, default or meaning: those
 * belong to the slice that owns the setting, so a reader can change one
 * subject's storage without reading the other two. Corruption is survivable on
 * purpose — these are hand-editable keys, and a half-written one must not take
 * the settings page down with it.
 */

import { persistence } from '../services/persistence'

export function readLs(key: string, fallback: string): string {
  const v = persistence.get(key)
  return v && v.length > 0 ? v : fallback
}

export function readNumber(key: string, fallback: number): number {
  const v = persistence.get(key)
  if (!v || v.length === 0) return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

export function readBool(key: string, fallback: boolean): boolean {
  const v = persistence.get(key)
  if (v === 'true') return true
  if (v === 'false') return false
  return fallback
}

export function readEnum<T extends string>(key: string, values: readonly T[], fallback: T): T {
  const v = persistence.get(key)
  return typeof v === 'string' && (values as readonly string[]).includes(v) ? (v as T) : fallback
}

/**
 * A list of ids, stored as JSON.
 *
 * A value that is not the array we wrote is discarded rather than repaired:
 * half a list of unknown strings is worse than none.
 */
export function readStringList(key: string): string[] {
  const v = persistence.get(key)
  if (!v) return []
  try {
    const parsed: unknown = JSON.parse(v)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
