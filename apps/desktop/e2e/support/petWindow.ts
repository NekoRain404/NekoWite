/**
 * The character window's geometry, read out of the Rust file that owns it.
 *
 * `window_host::character_window_size` is the one rule that decides how big a pet window is, and two
 * specs now measure surfaces inside it — the sprite (`desktop-pet-window-fit.spec.ts`) and the
 * bubble (`desktop-pet-bubble.spec.ts`). A second copy of the parse would be a second answer to
 * "what window does the host build", and the two would drift the moment the rule moved: one spec
 * would keep measuring the box the product used to build.
 *
 * Read rather than restated, and deliberately the opposite of what `desktop-pet-tasks.spec.ts` does
 * with the bubble's cap: what these specs measure is a *layout* property — does the engine put this
 * surface inside this box — and a copy of the rule would keep measuring the box the product used to
 * build. The numbers themselves are pinned on the Rust side
 * (`tests/desktop_pet_settings_test/geometry.rs`), which is where a rule change has to come through;
 * these specs follow whatever that rule says and fail if the browser cannot hold the surface in it.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The Rust file that owns the character window's geometry. Resolved from this file's own location,
 * the way `support/repoFs.ts` does it, so a clone anywhere reads its own tree.
 */
const WINDOW_HOST_RS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src-tauri',
  'src',
  'desktop_pet',
  'window_host.rs',
)

/** A box in viewport coordinates, as `getBoundingClientRect()` gives it. */
export type Box = { left: number; top: number; right: number; bottom: number; width: number; height: number }
/** A window box, the thing every other box is judged against. */
export type WindowBox = { width: number; height: number }

/** The text after `marker` on the same line, or a throw naming what moved. */
function declaredAfter(text: string, marker: string): string {
  const at = text.indexOf(marker)
  if (at < 0) throw new Error(`${marker} is not in window_host.rs`)
  const rest = text.slice(at + marker.length)
  const end = rest.indexOf('\n')
  return (end < 0 ? rest : rest.slice(0, end)).trim()
}

/** `CHARACTER_WINDOW_SLACK` and `CHARACTER_WINDOW_MIN_WIDTH`, as the rule declares them. */
export function windowRule(): { slack: [number, number]; floor: number } {
  const text = readFileSync(WINDOW_HOST_RS, 'utf8')
  const slack = declaredAfter(text, 'const CHARACTER_WINDOW_SLACK: (f64, f64) = (')
    .replace(/\)\s*;.*$/, '')
    .split(',')
    .map((part) => Number(part.trim()))
  const floor = Number(
    declaredAfter(text, 'const CHARACTER_WINDOW_MIN_WIDTH: f64 = ').replace(/;.*$/, ''),
  )
  if (slack.length !== 2 || slack.some((n) => !Number.isFinite(n)) || !Number.isFinite(floor)) {
    throw new Error(`the window rule could not be read: slack ${slack}, floor ${floor}`)
  }
  return { slack: [slack[0] as number, slack[1] as number], floor }
}

/** The sprite box a size implies: `pet-appearance.ts`'s `box()`, at the sheet's 160x180 aspect. */
export function spriteBox(size: number): WindowBox {
  return { width: size, height: Math.round((size * 180) / 160) }
}

/**
 * The window the host builds for a character of this size: the sprite's own box plus the slack
 * upstream's window had, floored at the width the bubble's cap needs.
 */
export function hostWindow(size: number): WindowBox {
  const { slack, floor } = windowRule()
  return {
    width: Math.max(size + slack[0], floor),
    height: spriteBox(size).height + slack[1],
  }
}

/** How far a box is past each edge of the window: positive is outside, zero or less is inside. */
export function outside(box: Box, window_: WindowBox): Record<string, number> {
  return { left: -box.left, top: -box.top, right: box.right - window_.width, bottom: box.bottom - window_.height }
}
