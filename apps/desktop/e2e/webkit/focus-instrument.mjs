/**
 * The focus instruments: what a stop paints, and whether a reader can see it.
 *
 * Split out of `agent-scroll-instrument.mjs` at the line budget, and along the seam that file
 * already had — everything here is about a FOCUS INDICATOR (the ring a stop paints when the
 * keyboard lands on it), and nothing here knows about the rail, the timeline or the agent panel.
 * `INSTRUMENTS` still owns `__nkwTabStops`, which is the enumeration both instruments share, so
 * this file's script must be installed AFTER that one: nothing here defines a tab stop.
 *
 * Two of the functions below answer questions the first version of the sweep could not:
 *
 *  - **`__nkwRingVisibility`** — an outline only a computed style can see is not an indicator.
 *    `.graph-canvas`'s ring was reported by the engine and clipped away to nothing by the wrapper
 *    that holds it (`overflow: hidden`, the canvas filling it exactly), so a keyboard reader saw
 *    no change anywhere on screen while the sweep called the stop clean in every run, before and
 *    after the fix. This computes the band the outline occupies and how much of it survives the
 *    clip of every ancestor whose overflow is not visible. It is a MODEL, not a pixel read, and
 *    the model's scope is stated where it is built and in the sweep's own result.
 *  - **`__nkwShadowPaints`** — `boxShadow !== 'none'` accepts both halves of a nothing: a shadow
 *    whose colour is fully transparent, and a shadow whose offsets, blur and spread are all zero.
 *    A `box-shadow` that fades in computes as exactly that pair in the task the focus lands in
 *    (`oklab(0 0 0 / 0) 0px 0px 0px 0px`), so the old test credited a declaration rather than a
 *    pixel. WebKit returns computed colours in more than one syntax, so the alpha is read from
 *    the slot each syntax puts it in instead of being pattern-matched against one spelling.
 */
import { Script } from 'node:vm'

export const FOCUS_INSTRUMENTS = `
/**
 * The ring the engine is actually painting on a focused element, read from the computed style.
 *
 * A tab stop with no visible indicator is the second half of the defect this phase measures: the
 * project's own rule is that a focus ring is not removed without a replacement, and "the rule
 * exists in the stylesheet" is not the same claim as "the engine paints it". Read beside
 * focus-visible's own verdict, because an outline painted only when the heuristic agrees is the
 * difference between a ring on a keyboard reader's screen and a ring on everybody's.
 */
window.__nkwFocusRing = function (sel) {
  const el = document.querySelector(sel);
  if (!el) return { why: 'no ' + sel };
  const s = getComputedStyle(el);
  return {
    focused: document.activeElement === el,
    matchesFocusVisible: el.matches(':focus-visible'),
    outlineStyle: s.outlineStyle,
    outlineWidth: s.outlineWidth,
    outlineColor: s.outlineColor,
    outlineOffset: s.outlineOffset,
  };
};

/**
 * The alpha a computed colour declares, or null when the syntax is not one this knows.
 *
 * The slot, not the shape: \`oklab(0 0 0 / 0)\` is a fully transparent colour and
 * \`oklab(0 0 0)\` is an opaque black, so a test that looks for zeros decides the opposite of the
 * truth on one of them. A syntax that is not handled returns null rather than a guess, and the
 * caller is the one that says what an unknown value means.
 */
window.__nkwColorAlpha = function (value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  if (text === '' || text === 'none') return null;
  if (text === 'transparent') return 0;
  if (text === 'currentcolor') return 1;
  const hex = text.match(/^#([0-9a-f]+)$/);
  if (hex) {
    const d = hex[1];
    if (d.length === 4) return parseInt(d[3] + d[3], 16) / 255;
    if (d.length === 8) return parseInt(d.slice(6, 8), 16) / 255;
    if (d.length === 3 || d.length === 6) return 1;
    return null;
  }
  const fn = text.match(/^[a-z-]+\\(([\\s\\S]*)\\)$/);
  if (!fn) return null;
  const body = fn[1];
  // The slash is where every modern syntax puts the alpha, and it is the ONLY place it is
  // optional: no slash means opaque.
  const slash = body.split('/');
  if (slash.length === 2) {
    const raw = slash[1].trim();
    const a = parseFloat(raw);
    if (!isFinite(a)) return null;
    return raw.charAt(raw.length - 1) === '%' ? a / 100 : a;
  }
  if (slash.length > 2) return null;
  // The old comma spelling of rgba() carries its alpha as a fourth argument.
  const parts = body.split(',');
  if (parts.length === 4) {
    const a = parseFloat(parts[3]);
    return isFinite(a) ? a : null;
  }
  return 1;
};

/** Comma-separated at the top level only, so a colour's own arguments do not split a layer. */
window.__nkwSplitTop = function (value) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value.charAt(i);
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) { out.push(value.slice(start, i)); start = i + 1; }
  }
  out.push(value.slice(start));
  return out;
};

/**
 * Whether a computed box-shadow paints anything, and whether the answer was proven.
 *
 * \`paints\` needs both halves: a colour with alpha above zero AND a geometry that covers
 * something (an offset, a blur or a spread that is not zero). \`unparsed\` is set when a layer's
 * colour is in a syntax this does not know, and such a layer COUNTS AS PAINTING — a sweep whose
 * red is produced by a parser gap sends its reader to change a control that is not broken, and
 * that is how a list of findings stops being believed. The reading carries the flag so a caller
 * can say the verdict was not proven rather than hide it.
 */
window.__nkwShadowPaints = function (value) {
  if (typeof value !== 'string') return { paints: false, unparsed: false, why: 'no value' };
  const text = value.trim();
  if (text === '' || text === 'none') return { paints: false, unparsed: false, why: 'none' };
  const layers = window.__nkwSplitTop(text);
  let unparsed = false;
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i].replace(/\\binset\\b/, ' ').trim();
    if (layer === '') continue;
    const lengths = layer.match(/-?[\\d.]+px/g) || [];
    if (lengths.length === 0) continue;
    const color = layer.replace(/-?[\\d.]+px/g, ' ').replace(/\\s+/g, ' ').trim();
    const alpha = window.__nkwColorAlpha(color);
    if (alpha === null) { unparsed = true; continue; }
    const geometry = lengths.some(function (v) { return Math.abs(parseFloat(v)) > 0; });
    if (alpha > 0 && geometry) return { paints: true, unparsed: unparsed, why: 'a layer with alpha and geometry' };
  }
  return { paints: unparsed, unparsed: unparsed,
           why: unparsed ? 'a colour in a syntax this does not know' : 'no layer with both alpha and geometry' };
};

/**
 * An indicator drawn on a pseudo-element, which getComputedStyle(el) cannot see at all.
 *
 * LayoutResizeHandle in this app draws its focus indicator as a two-pixel ::after bar that
 * gains a background on :focus-visible, and it is not alone: an element that reveals a control,
 * lifts an overlay or fills a bar when focused is a pattern this codebase uses deliberately. A
 * sweep that only read the element's own outline would call every one of those ringless, and a
 * false accusation in a list of defects is worse than a missing one — it sends the next reader to
 * change something that is not broken, and it is how the list stops being believed.
 *
 * The test is narrow on purpose: the pseudo-element must have a box, be visible, and carry a
 * background, a border or an outline of its own. opacity: 0 counts as invisible, because a bar
 * that is transparent is the pre-focus state of the very thing being looked for — and the alpha
 * of a background is read the same way, so a colour that has faded all the way out is not paint.
 */
window.__nkwPseudoIndicator = function (el) {
  const parts = ['::after', '::before'];
  for (let i = 0; i < parts.length; i++) {
    const s = getComputedStyle(el, parts[i]);
    if (!s || s.content === 'none') continue;
    if (s.visibility === 'hidden' || s.display === 'none') continue;
    if (parseFloat(s.opacity) === 0) continue;
    // No size test. getComputedStyle reports a pseudo-element's box in the computed form, so a
    // bar positioned with top: 0; bottom: 0 reads height: auto while it is on screen at its
    // parent's full height — the first version demanded a numeric width AND height, called the
    // three resize handles in this page ringless, and put three false accusations in the list.
    // What is asked instead is only that the pseudo-element is drawn and that it paints.
    const background = window.__nkwColorAlpha(s.backgroundColor);
    const hasPaint =
      (background !== null && background > 0) ||
      (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) ||
      window.__nkwShadowPaints(s.boxShadow).paints;
    if (hasPaint) {
      return { part: parts[i], width: s.width, height: s.height,
               background: s.backgroundColor, outline: s.outlineStyle + ' ' + s.outlineWidth };
    }
  }
  return null;
};

/**
 * The colour a reader sees behind an element: the first opaque ancestor background.
 *
 * Walks up rather than assuming the element's own background is what is behind the ring, because
 * the rings this codebase draws sit at -2px (inside the element) and at +1/+2px (outside it, over
 * the parent). Both are reported by the caller; this is the "outside it" half.
 */
window.__nkwBackdrop = function (el) {
  let node = el.parentElement;
  while (node) {
    const bg = getComputedStyle(node).backgroundColor;
    const m = bg && bg.match(/rgba?\\(([^)]+)\\)/);
    if (m) {
      const parts = m[1].split(',').map(function (v) { return parseFloat(v); });
      if (parts.length < 4 || parts[3] >= 0.999) return { color: bg, from: node.className || node.tagName };
    }
    node = node.parentElement;
  }
  return { color: 'rgb(255,255,255)', from: 'nothing (the document default)' };
};

/**
 * WCAG's contrast ratio between two colours, as a number with two decimals.
 *
 * The ratio the standards name for a focus indicator is 3:1 against the adjacent colour, and the
 * only honest way to check it is to resolve both colours in the engine and do the arithmetic on
 * what it returns. A colour it cannot parse comes back null, which is reported rather than
 * rounded to a pass.
 */
window.__nkwContrast = function (a, b) {
  const parse = function (value) {
    const m = value && value.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const parts = m[1].split(',').map(function (v) { return parseFloat(v); });
    if (parts.length < 3 || parts.some(function (v) { return !isFinite(v); })) return null;
    // The RGB is used as it is, without compositing a translucent indicator over what is behind
    // it. That is stated rather than hidden: outlineColor's own alpha is reported beside the
    // ratio, so a reader can see that a 58%-alpha ring's ratio is about the colour it is mixed
    // FROM. The colours this codebase paints a focus ring with are opaque, and the mixed ones are
    // filled surfaces rather than outlines.
    return parts.slice(0, 3);
  };
  const lum = function (rgb) {
    const channel = function (v) {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
  };
  const ca = parse(a), cb = parse(b);
  if (!ca || !cb) return null;
  const la = lum(ca), lb = lum(cb);
  const hi = Math.max(la, lb), lo = Math.min(la, lb);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
};

/** px or zero: a computed length that will not parse must not turn a comparison into NaN. */
window.__nkwPx = function (value) {
  const n = parseFloat(value);
  return isFinite(n) ? n : 0;
};

/**
 * Every ancestor whose overflow clips what is painted inside it, as the box it clips to.
 *
 * \`overflow: hidden\` clips a descendant's outline exactly as it clips the descendant — that is
 * how .graph-canvas's ring was reported by the engine and painted nowhere — and the clip is the
 * ancestor's PADDING box, which is why the border is subtracted rather than the border box being
 * used. \`contain: paint\` clips the same way without an overflow value, so it is read here too.
 */
window.__nkwClipsOf = function (el) {
  const clips = [];
  let node = el.parentElement;
  while (node && node !== document.documentElement && node !== document.body) {
    const s = getComputedStyle(node);
    const contain = String(s.contain || '');
    const paint = contain.indexOf('paint') !== -1 || contain === 'strict' || contain === 'content';
    const x = paint || s.overflowX !== 'visible';
    const y = paint || s.overflowY !== 'visible';
    if (x || y) {
      const r = node.getBoundingClientRect();
      clips.push({
        x: x, y: y,
        left: r.left + window.__nkwPx(s.borderLeftWidth),
        top: r.top + window.__nkwPx(s.borderTopWidth),
        right: r.right - window.__nkwPx(s.borderRightWidth),
        bottom: r.bottom - window.__nkwPx(s.borderBottomWidth),
        from: node.className || node.tagName
      });
    }
    node = node.parentElement;
  }
  return clips;
};

/** The area of a rectangle after every clip has been applied to it. */
window.__nkwVisibleArea = function (rect, clips) {
  let left = rect.left, top = rect.top, right = rect.right, bottom = rect.bottom;
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    if (c.x) { if (c.left > left) left = c.left; if (c.right < right) right = c.right; }
    if (c.y) { if (c.top > top) top = c.top; if (c.bottom < bottom) bottom = c.bottom; }
  }
  return Math.max(0, right - left) * Math.max(0, bottom - top);
};

/**
 * The band an outline occupies, and how much of it the page's own clipping leaves on screen.
 *
 * The outline is drawn at \`outline-offset\` from the border edge and its width extends AWAY from
 * that line, so a positive offset puts the whole band outside the box and a negative one puts it
 * inside — which is a geometry, not a taste: the app draws -2px on full-bleed containers because
 * anything outside their box is clipped, and one of them (.graph-canvas) was clipped anyway.
 *
 * The band is four rectangles rather than one dilated box, because a frame is not a rectangle and
 * a test that used the dilated box would see the element's own visible interior through the hole
 * and call a fully clipped ring painted. Rotation and skew are not modelled: an element under a
 * transform has its outline transformed with it, and this reads the axis-aligned border box, so
 * the band it computes can be smaller than the painted one. A smaller band can only make this
 * test LESS likely to fire, and it is the false accusation that would cost the sweep its readers.
 *
 * **What it cannot see, said rather than implied:** a clip-path or a mask, a rounded clip (the
 * clip a border-radius gives an \`overflow: hidden\` ancestor — the band is treated as square, so
 * the model clips less than the engine and accuses less), \`overflow-clip-margin\`, and a ring
 * covered by a later element rather than clipped by an ancestor. It models outlines; a
 * box-shadow's footprint depends on the element's own background and its blur, so a shadow clipped
 * by an ancestor is left to the pixel reader, which is the only thing that can settle it.
 */
window.__nkwRingVisibility = function (el, outline) {
  const s = outline === undefined ? getComputedStyle(el) : outline;
  const width = window.__nkwPx(s.outlineWidth);
  if (s.outlineStyle === 'none' || width <= 0) return null;
  const offset = s.outlineOffset === undefined ? 0 : window.__nkwPx(s.outlineOffset);
  const box = el.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return null;
  const near = Math.min(offset, offset + width);
  const far = Math.max(offset, offset + width);
  // How far the band reaches INTO the box (never more than half of it) and OUT of it.
  const innX = Math.min(Math.max(-near, 0), box.width / 2);
  const innY = Math.min(Math.max(-near, 0), box.height / 2);
  const out = Math.max(far, 0);
  const bands = [
    { left: box.left, right: box.right, top: box.top - out, bottom: box.top + innY },
    { left: box.left, right: box.right, top: box.bottom - innY, bottom: box.bottom + out },
    { left: box.left - out, right: box.left + innX, top: box.top, bottom: box.bottom },
    { left: box.right - innX, right: box.right + out, top: box.top, bottom: box.bottom }
  ];
  const clips = window.__nkwClipsOf(el);
  let bandArea = 0;
  let visibleArea = 0;
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    bandArea += Math.max(0, b.right - b.left) * Math.max(0, b.bottom - b.top);
    visibleArea += window.__nkwVisibleArea(b, clips);
  }
  const boxVisible = window.__nkwVisibleArea(box, clips);
  const round = function (v) { return Math.round(v); };
  return {
    width: width, offset: offset, reach: { inn: innX, out: out },
    bandArea: round(bandArea), visibleArea: round(visibleArea), boxVisible: round(boxVisible),
    // On screen, as a percentage of the ring — 100 when nothing clips it, 0 when a reader would
    // see no change at all. Partial clipping is REPORTED and not judged: a stop half out of a
    // scrolled container is a stop the reader scrolled, not a surface whose ring was never drawn.
    onScreen: bandArea > 0 ? Math.round((visibleArea / bandArea) * 100) : 0,
    clips: clips.map(function (c) { return c.from; }),
    // The class this exists for: the control itself is on screen and its ring is not. A stop
    // whose box is clipped away too is a stop nobody can see in the first place, and calling its
    // ring missing would be a false accusation about a surface that is simply scrolled away.
    clipped: visibleArea === 0 && boxVisible > 0
  };
};

/**
 * The ring the engine paints on an element the moment it holds focus — the sweep's one question.
 *
 * The instrument above reads whatever is on screen NOW, which is what a check wants when a real
 * Tab has just landed. This is for the other direction: focus the element, read, put focus back,
 * so a list of a hundred and fifty stops can be asked one at a time. Focus is restored to where
 * it was, because a sweep that left the page focused on its last candidate would be a gesture
 * the phases after it did not ask for.
 *
 * **It is a method with a failure mode of its own**, and that is why it returns
 * matchesFocusVisible beside the outline: WebKitGTK decides :focus-visible from the modality
 * of the last input, so a programmatic focus after a pointer gesture legitimately paints nothing
 * and every reading below would be a false accusation. The caller establishes modality with a
 * real key first and proves the method against a witness element known to paint — see
 * __nkwFocusSweep's witness.
 *
 * \`painted\` is "the engine reports an indicator" — an outline it is drawing, a box-shadow that
 * paints (see __nkwShadowPaints), or a pseudo-element that carries paint. \`clipped\` is the
 * separate question of whether layout leaves any of it on screen, and \`onScreen\` is the reading
 * behind that verdict. A caller that wants a reader to SEE something wants both.
 */
window.__nkwFocusPaint = function (sel) {
  const el = document.querySelector(sel);
  if (!el) return null;
  const before = document.activeElement;
  el.focus({ preventScroll: true });
  const s = getComputedStyle(el);
  const shadow = window.__nkwShadowPaints(s.boxShadow);
  const out = {
    sel: sel,
    tag: el.tagName.toLowerCase(),
    cls: el.className || null,
    tookFocus: document.activeElement === el,
    matchesFocusVisible: el.matches(':focus-visible'),
    matchesFocus: el.matches(':focus'),
    outlineStyle: s.outlineStyle,
    outlineWidth: s.outlineWidth,
    outlineColor: s.outlineColor,
    outlineOffset: s.outlineOffset,
    boxShadow: s.boxShadow,
    shadowPaints: shadow.paints,
    shadowWhy: shadow.why
  };
  out.pseudo = window.__nkwPseudoIndicator(el);
  // Read while the element still holds focus: an indicator behind :focus-visible is not on the
  // element at all until this moment, and a reading taken after the focus was put back would be
  // a reading of the control's resting state.
  out.ring = window.__nkwRingVisibility(el, s);
  out.clipped = out.ring !== null && out.ring.clipped === true;
  out.painted =
    out.matchesFocus === true &&
    ((out.outlineStyle !== 'none' && window.__nkwPx(out.outlineWidth) > 0) ||
      shadow.paints ||
      out.pseudo !== null);
  // Contrast, because an indicator a reader cannot see against what is behind it is the defect
  // wearing a fix's clothes: the project's own standards put a floor under the indicator's size
  // and its contrast, and "there is an outline" answers neither. The ring is drawn OUTSIDE the
  // element's own background in the offset case and INSIDE it in the inset case, so both are
  // reported and the caller judges; the arithmetic is WCAG's relative-luminance ratio.
  if (out.painted && out.outlineStyle !== 'none') {
    const backdrop = window.__nkwBackdrop(el);
    out.backdrop = backdrop;
    out.backdropContrast = window.__nkwContrast(out.outlineColor, backdrop.color);
    out.ownContrast = window.__nkwContrast(out.outlineColor, s.backgroundColor);
    out.outlineWidthPx = window.__nkwPx(out.outlineWidth);
  }
  if (before && before !== el && before.focus) before.focus({ preventScroll: true });
  else if (!before) el.blur();
  return out;
};

/**
 * Every tab stop under a root that takes focus and shows nothing, asked of the engine.
 *
 * This is the systematic half of the two surfaces this harness measures one at a time: a
 * container that is a tab stop with no ring is the same defect as a container that is no tab
 * stop at all, and fixing the instances a reviewer happened to walk past is how the class
 * survives. The list is read from the live DOM through the same __nkwTabStops the tab-order
 * reading uses, and each stop's ring is PAINTED and read back — not grepped out of a stylesheet,
 * which is the difference between "a rule exists" and "a reader sees it".
 *
 * witness is not optional and is not decoration. One element known to paint is measured through
 * the same code path in the same call; when the witness comes back ringless, the whole sweep is
 * reported blind and the caller is told not to read the rest — because a method that cannot
 * see a ring will report every stop as ringless, which is exactly the wrong conclusion and looks
 * exactly like right.
 *
 * **The three answers it can give, and why they are three.** \`offenders\` report nothing at all;
 * \`clipped\` report a ring that layout removes from the screen (the class .graph-canvas was in,
 * and the one this sweep could not see); \`clean\` is everything else. A stop in \`clipped\` is a
 * stop a keyboard reader sees no change on, which is why it is not counted as clean — and it is
 * kept in its own list rather than merged into \`offenders\` because the two send their reader to
 * different places: one to a missing rule, the other to a clip that eats the rule that is there.
 */
window.__nkwFocusSweep = function (opts, done) {
  const stops = window.__nkwTabStops(opts.root === undefined ? null : opts.root);
  if (stops === null) { done({ why: 'no ' + opts.root }); return; }
  const witness = window.__nkwFocusPaint(opts.witness);
  if (!witness || witness.painted !== true) {
    done({ blind: true, witness: witness, total: stops.length,
           why: 'the witness ' + opts.witness + ' painted no ring under this method' });
    return;
  }
  const offenders = [];
  const clipped = [];
  const unaddressable = [];
  let i = 0;
  const selectorOf = function (index) { return '[data-nkw-sweep="' + index + '"]'; };
  /** The entry both lists are made of: enough for a reader to find the element and see the verdict. */
  const entryOf = function (index, reading) {
    return {
      i: index, tag: reading.tag, cls: reading.cls, tookFocus: reading.tookFocus,
      outline: reading.outlineStyle + ' ' + reading.outlineWidth,
      offset: reading.outlineOffset, boxShadow: reading.boxShadow,
      shadowPaints: reading.shadowPaints, shadowWhy: reading.shadowWhy,
      focusVisible: reading.matchesFocusVisible, focus: reading.matchesFocus,
      pseudo: reading.pseudo, where: window.__nkwStopWhere(stops[index])
    };
  };
  const finish = function (index, reading) {
    const el = stops[index];
    el.removeAttribute('data-nkw-sweep');
    // Blurred, because the next stop's reading must not be taken with the previous one still
    // focused: __nkwFocusPaint puts focus back where it found it, and this makes sure it has
    // somewhere to go back to.
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    if (!reading) { unaddressable.push(index); requestAnimationFrame(step); return; }
    if (!reading.painted) offenders.push(entryOf(index, reading));
    else if (reading.clipped === true) {
      const entry = entryOf(index, reading);
      entry.ring = reading.ring;
      clipped.push(entry);
    }
    requestAnimationFrame(step);
  };
  /**
   * **One frame per stop, and the second reading is not politeness.** Several of this app's focus
   * indicators arrive on a transition — LayoutResizeHandle fades a two-pixel bar in over
   * --app-motion-fast, the composer's field fades a three-pixel box-shadow in — and a computed
   * style read in the same task as the focus samples that transition at t=0, where a box-shadow
   * is a colour with no alpha and no geometry. The first version read all hundred and sixty stops
   * synchronously and named those three handles as ringless; they paint, 150ms later. A sweep that
   * has to be told which of its findings are real is not a sweep — so a stop whose indicator is
   * not on screen at the instant focus lands is focused again, HELD for four frames, and read
   * then. The wait is paid only by the stops that need it, and holding focus across it is the
   * whole point: blurring first would let the transition run back to its unfocused value and the
   * settled read would be of the state the control is in when nothing is focused.
   */
  const step = function () {
    if (i >= stops.length) {
      done({
        root: opts.root === undefined ? null : opts.root,
        total: stops.length, witness: witness, blind: false,
        offenders: offenders, clipped: clipped, unaddressable: unaddressable,
        clean: stops.length - offenders.length - clipped.length - unaddressable.length
      });
      return;
    }
    const el = stops[i];
    const box = el.getBoundingClientRect();
    const index = i;
    i += 1;
    if (box.width < 2 || box.height < 2) { requestAnimationFrame(step); return; }
    el.setAttribute('data-nkw-sweep', String(index));
    const first = window.__nkwFocusPaint(selectorOf(index));
    if (first && first.painted === true && first.clipped !== true) { finish(index, first); return; }
    el.focus({ preventScroll: true });
    let left = 4;
    const settle = function () {
      if (--left > 0) { requestAnimationFrame(settle); return; }
      finish(index, window.__nkwFocusPaint(selectorOf(index)));
    };
    requestAnimationFrame(settle);
  };
  requestAnimationFrame(step);
};

/**
 * The focusable elements the narrow enumeration cannot see.
 *
 * __nkwTabStops walks a[href], button, input, textarea, select, [tabindex], which is every
 * way this app makes a control focusable — and NOT every way a page can. A contenteditable
 * region is a tab stop with no attribute in that list, and this application's editor body is
 * exactly one, so the answer to "which stops paint the engine's ring" was being read off a list
 * that could not contain it. Nothing is asserted about the candidates here: whether they are
 * stops at all is measured by focusing them, and what they paint is read the same way every
 * other stop's is. Shadow roots are not walked — no component in this repository renders one —
 * and that is a stated limit rather than an oversight.
 */
window.__nkwStopsBeyondEnumeration = function (root) {
  const scope = root ? document.querySelector(root) : document;
  if (!scope) return null;
  const narrow = window.__nkwTabStops(root) || [];
  const candidates = Array.from(
    scope.querySelectorAll(
      '[contenteditable]:not([contenteditable="false"]), summary, audio[controls], video[controls], iframe, object, embed'
    )
  );
  return candidates.filter(function (el) {
    if (narrow.indexOf(el) !== -1) return false;
    if (el.disabled) return false;
    if (el.closest('[inert]')) return false;
    if (el.getClientRects().length === 0) return false;
    return getComputedStyle(el).visibility !== 'hidden';
  });
};

/**
 * Where a stop lives, as the chain of classes above it.
 *
 * The census names stops by their own class, and a class is not where a file is: the stops this
 * sweep has reported by hand — a title-bar button, a file-tree header, an unclassed input in the
 * front-matter panel — took a reader from a class name to a file by grepping, and one of them was
 * attributed to the wrong component in the report that named it. The parent chain is the
 * measurable half of that walk.
 */
window.__nkwStopWhere = function (el) {
  const chain = [];
  let node = el.parentElement;
  while (node && chain.length < 3) {
    const cls = node.className;
    chain.push(typeof cls === 'string' && cls.trim() !== '' ? cls.trim().split(/\\s+/)[0] : node.tagName.toLowerCase());
    node = node.parentElement;
  }
  const attr = function (name) { return el.getAttribute ? el.getAttribute(name) : null; };
  return {
    tag: el.tagName.toLowerCase(), id: el.id || null, type: attr('type'), name: attr('name'),
    title: attr('title'), label: attr('aria-label'), parent: chain.join(' < ')
  };
};
`

new Script(FOCUS_INSTRUMENTS)
