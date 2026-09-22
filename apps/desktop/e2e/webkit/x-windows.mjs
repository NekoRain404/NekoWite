/**
 * The X window tree as an instrument: which windows exist, how big they are, what they say they are,
 * what they look like, and the two ways to dismiss one.
 *
 * A GTK dialog is not a page. No WebDriver endpoint can see one and no script can query one — so for the
 * question "did `window.print()` reach a dialog, and could a user dismiss it?", the X server is the only
 * witness there is. This module is what `drive-app.mjs --print` reads that witness with.
 *
 * The standard X tools rather than a binding: `xwininfo` for the root's children and for geometry,
 * `xprop` for what a window says about itself, ImageMagick's `import` for a picture of it, and `xdotool`
 * for the two dismissals (a `WM_DELETE_WINDOW` client message, and a real key at a point).
 *
 * `xdotool search --name ''` is deliberately **not** how windows are listed: it matches on a name and
 * silently drops every window that has none, which would turn "nothing opened" into a difference that is
 * not there.
 */
import { execFileSync } from 'node:child_process'

/** Everything here talks to the display the caller was started on (`DISPLAY` is inherited, never set). */
const run = (command, argv) => execFileSync(command, argv, { encoding: 'utf8', env: process.env })

/**
 * Every window the root window owns, by id and name.
 *
 * `xwininfo -root -children` rather than a search: it lists unnamed windows too (the app owns a 1x1 and a
 * 10x10 helper), and a window missing from the baseline makes a later window look like two.
 */
export function xWindows() {
  const out = run('xwininfo', ['-root', '-children'])
  return [...out.matchAll(/^\s+(0x[0-9a-f]+)\s+(?:"([^"]*)"|\(has no name\))/gm)].map((m) => ({
    id: m[1],
    name: m[2] ?? '',
  }))
}

/**
 * Width, height, map state and absolute position of one window.
 *
 * A name is not enough to call something a dialog: the app owns hidden helper windows, so the question is
 * whether a *visible, dialog-sized* window appeared. The absolute position is what {@link pressKeyAt}
 * needs — with no window manager the pointer decides which window receives a key.
 */
export function windowGeometry(id) {
  const out = run('xwininfo', ['-id', id])
  const field = (name) => out.match(new RegExp(`^\\s*${name}:\\s*(.+)$`, 'm'))?.[1]?.trim() ?? null
  const number = (name) => {
    const value = field(name)
    return value === null || Number.isNaN(Number(value)) ? null : Number(value)
  }
  const upper = out.match(/Absolute upper-left X:\s*(-?\d+)[\s\S]*?Absolute upper-left Y:\s*(-?\d+)/)
  return {
    width: number('Width'),
    height: number('Height'),
    mapState: field('Map State'),
    x: upper ? Number(upper[1]) : null,
    y: upper ? Number(upper[2]) : null,
  }
}

/** The four properties that name a window and say what kind of window it is, or the reason they could not be read. */
export function windowProperties(id) {
  const wanted = ['WM_NAME', '_NET_WM_NAME', 'WM_CLASS', '_NET_WM_WINDOW_TYPE', 'WM_TRANSIENT_FOR']
  try {
    const out = run('xprop', ['-id', id])
    const properties = {}
    for (const name of wanted) {
      const line = out.split('\n').find((l) => l.startsWith(`${name}(`) || l.startsWith(`${name} =`))
      if (line) properties[name] = line.slice(line.indexOf('=') + 1).trim().slice(0, 120)
    }
    return properties
  } catch (e) {
    return { unreadable: String(e?.message ?? e).slice(0, 120) }
  }
}

/**
 * A picture of one window, written to `file` (PNG), for the readings that can only be *looked at*: a
 * dialog that is present but empty, or a window whose size says nothing about whether it has content.
 */
export function screenshotWindow(id, file) {
  try {
    run('import', ['-window', id, file])
    return true
  } catch (e) {
    return `unreadable: ${String(e?.message ?? e).slice(0, 120)}`
  }
}

/**
 * Dismiss one window the way a window manager does — a `WM_DELETE_WINDOW` client message, which a GTK
 * dialog handles as "cancel". Destroying the window instead would prove nothing about the app's own
 * cleanup path, which is what the caller is measuring.
 */
export function closeWindow(id) {
  try {
    run('xdotool', ['windowclose', id])
    return true
  } catch {
    // Already gone is the normal case for the second attempt, not a finding.
    return false
  }
}

/**
 * A real key press **at a point**, for the case {@link closeWindow} cannot reach: with no window manager
 * the X input focus is `PointerRoot`, so a key goes to whatever the pointer is on. `xdotool key --window`
 * would instead send a synthetic event, which GTK is entitled to ignore.
 */
export function pressKeyAt(x, y, key) {
  try {
    run('xdotool', ['mousemove', '--sync', String(x), String(y)])
    run('xdotool', ['key', '--clearmodifiers', key])
    return true
  } catch {
    return false
  }
}
