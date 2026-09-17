import { Script } from 'node:vm'

/**
 * Five tab stops whose verdicts are not in question, so the sweep's two repaired branches can be
 * shown answering BOTH ways inside every run.
 *
 * A sweep is the instrument this repository will rely on for the next defect of this class, and
 * an instrument nobody has seen fail is an instrument nobody can trust: the previous version of
 * this sweep called every stop on the page clean while `.graph-canvas` painted no ring at all, in
 * every run, before and after the fix. Two repairs are only worth making if a reader can watch
 * them decide something — so this fixture is a stop of each kind, measured by the sweep and by the
 * screenshot diff in the same run:
 *
 * | control | what it is | what the sweep must say |
 * | --- | --- | --- |
 * | `clipped` | the canvas's own geometry: a ring drawn outside a box that fills its clipping wrapper | `clipped`, and 0 repainted pixels |
 * | `plain` | the same ring with room around it | clean, and a ring in the pixels |
 * | `shadowless` | `box-shadow: 0 0 0 0 rgba(0, 0, 0, 0)` — a declaration of nothing | offender, and 0 repainted pixels |
 * | `shadow` | a three-pixel accent shadow at 30% — the composer's own indicator | clean, and a ring in the pixels |
 * | `fade` | the same shadow arriving on a 150ms transition | clean, and a ring in the pixels |
 *
 * The last one is the control the previous sweep would have failed in the other direction: a
 * box-shadow read in the task focus lands in is a colour with no alpha and no geometry, so a
 * sweep that tightened the shadow test WITHOUT waiting for the transition would call a surface
 * that paints in 150ms ringless. Both halves are here so the pair can be told apart.
 *
 * Nothing here is part of the product: it is a fixture in a fixed overlay, mounted by the probe
 * for the length of one sweep and removed before the census counts the page's own stops.
 */
export const FOCUS_CONTROLS = `
/**
 * Mount or remove the control stops, and say which ones exist.
 *
 * The host is appended INSIDE the themed root for the reason the mount script gives for its own
 * host: AppShell carries data-theme and every palette keys off it, so a host on document.body
 * would render in the default theme's accent while the app renders in the chosen one — the rings
 * would be measured in a palette nothing else on screen is using.
 */
window.__nkwFocusControls = function (mode) {
  const existing = document.querySelector('[data-nkw-focus-controls]');
  if (mode === 'remove') {
    if (existing) existing.remove();
    return { mounted: false, left: document.querySelectorAll('[data-nkw-focus-controls]').length };
  }
  if (existing) return { mounted: true, alreadyThere: true };
  const host = document.createElement('div');
  host.setAttribute('data-nkw-focus-controls', '1');
  // One control per kind, in a column. tabindex is written rather than implied: the enumeration
  // reads tabIndex as a property, and a fixture that is not a tab stop measures nothing.
  host.innerHTML =
    '<div class="nkw-ctl-clip">' +
      '<button class="nkw-ctl-clipped" tabindex="0" aria-label="clipped ring control"></button>' +
    '</div>' +
    '<button class="nkw-ctl-plain" tabindex="0" aria-label="plain ring control"></button>' +
    '<button class="nkw-ctl-shadowless" tabindex="0" aria-label="empty shadow control"></button>' +
    '<button class="nkw-ctl-shadow" tabindex="0" aria-label="shadow ring control"></button>' +
    '<button class="nkw-ctl-fade" tabindex="0" aria-label="fading shadow control"></button>';
  const style = document.createElement('style');
  style.setAttribute('data-nkw-focus-controls-style', '1');
  style.textContent = [
    // The host is opaque and fixed: the rings around the controls are then measured against a
    // surface this file owns rather than against whatever panel happens to be behind it, and the
    // screenshot diff around a control is the control's ring and nothing else.
    '[data-nkw-focus-controls] { position: fixed; left: 40px; top: 40px; z-index: 60;',
    '  display: flex; flex-direction: column; gap: 10px; padding: 10px;',
    '  background: var(--app-canvas, rgb(23, 23, 20)); }',
    '[data-nkw-focus-controls] button { display: block; width: 90px; height: 24px; padding: 0;',
    '  border: 0; background: var(--app-elevated, rgb(30, 30, 27)); }',
    // The clip: exactly the canvas's geometry, one border and one overflow away from the ring.
    '[data-nkw-focus-controls] .nkw-ctl-clip { width: 90px; height: 24px; padding: 0; border: 0;',
    '  overflow: hidden; }',
    '[data-nkw-focus-controls] .nkw-ctl-clip button { width: 100%; height: 100%; }',
    '[data-nkw-focus-controls] .nkw-ctl-clipped:focus-visible { outline: 2px solid var(--app-accent);',
    '  outline-offset: 0; }',
    '[data-nkw-focus-controls] .nkw-ctl-plain:focus-visible { outline: 2px solid var(--app-accent);',
    '  outline-offset: 0; }',
    '[data-nkw-focus-controls] .nkw-ctl-shadowless:focus-visible { outline: none;',
    '  box-shadow: 0 0 0 0 rgba(0, 0, 0, 0); }',
    '[data-nkw-focus-controls] .nkw-ctl-shadow:focus-visible { outline: none;',
    '  box-shadow: 0 0 0 3px color-mix(in srgb, var(--app-accent) 30%, transparent); }',
    // A transition is the only way to produce the shape the tightened test has to refuse at t=0
    // and accept once it has run: a shadow with no alpha and no geometry.
    '[data-nkw-focus-controls] .nkw-ctl-fade { transition: box-shadow 150ms linear; }',
    '[data-nkw-focus-controls] .nkw-ctl-fade:focus-visible { outline: none;',
    '  box-shadow: 0 0 0 3px var(--app-accent); }',
  ].join('\\n');
  const themed = document.querySelector('[data-theme]') || document.body;
  themed.append(host);
  document.head.appendChild(style);
  return { mounted: true, host: host.getAttribute('data-nkw-focus-controls') };
};
`

/** The control classes, by the verdict each one is the control FOR. */
export const CONTROL_SELECTORS = {
  /** A ring the engine reports and the wrapper clips away: the sweep must call it clipped. */
  clipped: '.nkw-ctl-clipped',
  /** The same ring with room around it: the sweep must not. */
  plain: '.nkw-ctl-plain',
  /** A box-shadow with no alpha and no geometry: the sweep must call it ringless. */
  shadowless: '.nkw-ctl-shadowless',
  /** A box-shadow that paints: the sweep must not. */
  shadow: '.nkw-ctl-shadow',
  /** The same, arriving on a transition: the sweep must not. */
  fade: '.nkw-ctl-fade',
}

// Parsed here, at import time, for the reason `agent-scroll-instrument.mjs` gives: a script that
// does not parse reaches the page as a truncated reply and no line number pointing at the cause.
new Script(FOCUS_CONTROLS)
