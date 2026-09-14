/**
 * System accent-colour adapter.
 *
 * The OS accent is the one piece of appearance the web layer cannot read for
 * itself, so it comes from the backend command `system_accent_color` (which
 * reads `HKCU\...\Explorer\Accent` and falls back to `...\DWM` on Windows).
 * That read is best-effort by design: a non-Windows build, a registry the app
 * may not read, and a frontend running outside Tauri all resolve to `null`, and
 * the caller must fall back to its own choice rather than pretend (see
 * `stores/appearance.ts`, which reports which of the two happened).
 *
 * Like `platform/window.ts` this is a narrow platform adapter: stores call it,
 * and nothing in here knows about settings, palettes or themes.
 */

import { invoke } from '@tauri-apps/api/core'

export interface SystemAccentColor {
  r: number
  g: number
  b: number
  /** Which registry value answered; kept for diagnostics, never displayed. */
  source: string
}

function isChannel(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255
}

/** Reads the OS accent colour, or `null` when the platform cannot answer. */
export async function readSystemAccentColor(): Promise<SystemAccentColor | null> {
  let answer: SystemAccentColor | null
  try {
    answer = await invoke<SystemAccentColor | null>('system_accent_color')
  } catch {
    // A browser build, a backend without the command, or a registry that
    // refused the read: "no answer" is a normal outcome here, not an error.
    return null
  }
  if (!answer || !isChannel(answer.r) || !isChannel(answer.g) || !isChannel(answer.b)) return null
  return {
    r: answer.r,
    g: answer.g,
    b: answer.b,
    source: typeof answer.source === 'string' ? answer.source : '',
  }
}
