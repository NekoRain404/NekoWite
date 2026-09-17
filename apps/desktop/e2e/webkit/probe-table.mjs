/**
 * A blank table cell, and the rows × columns picker, in the engine that ships.
 *
 * Two reader reports, and neither can be settled in a unit test. The `<br />` is
 * a question about DOM the reader looks at AND bytes the app writes to a file,
 * and the picker is a question about whether a real click on the real toolbar in
 * WebKitGTK puts a dialog on screen. Chromium is not the product engine — `wry`
 * on Linux is WebKitGTK 4.1 and the AppImage bundles it — so this runs in
 * MiniBrowser through the same harness as the other probes.
 *
 * It wants `--scenario table`, whose note is shaped like the reader's: a table
 * holding BOTH ways a blank cell exists in the wild — one the author left empty,
 * and one carrying the `<br />` marker an earlier version of this app wrote.
 *
 * The write side is read from `window.__saveWrites`, which the harness's
 * `write_file` stand-in fills with the app's own argument. That is the file the
 * reader would find in their vault, byte for byte, rather than a re-derivation
 * of it from the model.
 */
import { writeFileSync } from 'node:fs'

import { clickAt } from './agent-scroll-driver.mjs'
import { clickByText } from './probe-support.mjs'
import { sleep, until } from './webdriver.mjs'

/**
 * Write the viewport to `NKW_PROBE_SHOT` when a run asks for one, and return the
 * dimensions either way.
 *
 * The harness's rule is that a probe returns numbers, and this keeps it: the
 * numbers are the return value and the picture is a side effect a run opts into.
 * The rule has a reason — a screenshot is a reading nothing can be compared with
 * — and so does the exception. "The reader sees a `<br />` in their table" is a
 * claim about what is on screen, and the numbers that would settle it (an atom
 * count, a cell height) are each answerable by more than one DOM, only one of
 * which is the thing complained about. So the run that takes it names a file,
 * and the file is looked at.
 */
async function shot(wd, label) {
  const png = await wd.screenshot()
  const path = process.env.NKW_PROBE_SHOT
  if (path && png) {
    writeFileSync(path.replace(/\.png$/, '') + `-${label}.png`, Buffer.from(png, 'base64'))
  }
  const box = await wd.execute(`return { innerWidth: innerWidth, innerHeight: innerHeight }`)
  return { captured: Boolean(png), width: box.innerWidth, height: box.innerHeight }
}

/** The toolbar button that carries the command, by the id the app sets on it. */
const TABLE_BUTTON = '[data-command-id="table.insert"]'

/**
 * One cell of a table in the rendered pane, by row and column.
 *
 * `trailingBreaks` counts ProseMirror's own caret `<br>` — the one it draws in an
 * empty block so the caret has somewhere to sit. It is never serialized, and
 * counting it apart from `atoms` is what keeps "the cell is empty" from being
 * confused with "the cell has a break in it".
 */
const readCell = (tableIndex, row, col) =>
  `(function () {
     const tables = document.querySelectorAll('.rendered-pane .ProseMirror table')
     const table = tables[${tableIndex < 0 ? 'tables.length - 1' : String(tableIndex)}]
     if (!table) return null
     const tr = table.querySelectorAll('tr')[${row}]
     if (!tr) return null
     const cell = tr.children[${col}]
     if (!cell) return null
     const p = cell.querySelector('p')
     return {
       text: (cell.textContent || ''),
       atoms: cell.querySelectorAll('span[data-type="html"]').length,
       atomValues: Array.from(cell.querySelectorAll('span[data-type="html"]'))
         .map(function (e) { return e.getAttribute('data-value') }),
       trailingBreaks: cell.querySelectorAll('br.ProseMirror-trailingBreak').length,
       emptyParagraph: Boolean(p) && p.childNodes.length === 0,
       height: cell.getBoundingClientRect().height
     }
   })()`

/** Every table in the rendered pane, by shape rather than by content. */
const TABLE_SHAPES =
  `Array.from(document.querySelectorAll('.rendered-pane .ProseMirror table')).map(function (t) {
     const rows = t.querySelectorAll('tr')
     return { rows: rows.length, cols: rows[0] ? rows[0].children.length : 0 }
   })`

/** Everything the app has written, path and bytes. */
const ALL_WRITES = `(window.__saveWrites || []).slice()`

/**
 * Where the caret is, and whether it is inside a table cell.
 *
 * The command's own gate is `isInTableCell`, so "the dialog refused" and "the
 * dialog never opened" are told apart by this rather than by inference.
 */
const CARET_STATE =
  `(function () {
     const v = document.querySelector('.rendered-pane .ProseMirror')
     if (!v) return { error: 'no editor' }
     const sel = window.getSelection()
     const node = sel && sel.anchorNode
     const el = node ? (node.nodeType === 1 ? node : node.parentElement) : null
     return { inEditor: Boolean(el && v.contains(el)),
              inCell: Boolean(el && el.closest('td, th')),
              inHeading: Boolean(el && el.closest('h1')),
              focused: document.activeElement === v,
              text: el ? (el.textContent || '').slice(0, 24) : null }
   })()`

/**
 * Ask the app to save now rather than waiting out its own debounce.
 *
 * The app's autosave is real and this does not replace it — it shortens the wait,
 * so a probe that has to read the file does not depend on a timer whose length is
 * not part of what is being measured.
 */
async function saveNow(wd) {
  await wd.execute(
    `document.dispatchEvent(new KeyboardEvent('keydown',
       { key: 's', metaKey: true, ctrlKey: true, bubbles: true }))
     return true`,
  )
  await sleep(1600)
}

export const tableProbe = {
  name: 'table-cell',
  async run(wd) {
    const out = { onOpen: null, note: null, toolbarButton: null, dialog: null, inserted: null, afterInsert: null }

    // The fixture this probe is about, or a statement that this run is not for
    // it — a plain run of every probe uses the `long` document, which has no
    // table, and a probe that threw there would make the whole run red for a
    // reason that is about the scenario rather than about the app.
    const hasTable = await until(
      () => wd.execute(`return Boolean(document.querySelector('.rendered-pane .ProseMirror table'))`),
      { timeout: 20_000, what: 'the fixture table in the rendered pane' },
    )
      .then(() => true)
      .catch(() => false)
    if (!hasTable) return { skipped: 'this scenario has no table; run with --scenario table' }

    // Read BEFORE anything is touched, so "the note as it arrived" and "the note
    // after an edit" are two different readings and the difference is visible. In
    // particular: whether merely OPENING a note rewrites it is a question a
    // migration has to answer, and this is where it is answered.
    out.onOpen = {
      shapes: await wd.execute(`return ${TABLE_SHAPES}`),
      header: await wd.execute(`return ${readCell}(0, 0, 0)`),
      // The cell the author left empty.
      authorEmpty: await wd.execute(`return ${readCell}(0, 1, 1)`),
      // The cell an earlier version wrote `<br />` into.
      markerCell: await wd.execute(`return ${readCell(0, 2, 0)}`),
      writesBeforeAnyEdit: await wd.execute(`return ${ALL_WRITES}`),
      shot: await shot(wd, 'note'),
    }

    // ---- The pane's mode, and the caret the command reads ------------------
    // The fixture's document ENDS with the table, so the caret the editor opens
    // with is inside its last cell — and `insertTable` refuses there, by design:
    // a table in a cell would be lifted out and split the host table in two. That
    // refusal is what a reader meets if they click the table button with the
    // caret where the app left it, so it is measured rather than avoided.
    const caret = await wd.execute(
      `const v = document.querySelector('.rendered-pane .ProseMirror')
       if (!v) return null
       const sel = window.getSelection()
       return { atEnd: sel ? sel.anchorOffset : null, selText: sel ? String(sel).slice(0, 20) : null,
                activeInEditor: document.activeElement === v }`,
    )
    out.caretOnOpen = caret

    // A real driver click on the toolbar button, at the point it occupies. This
    // is the part a unit test cannot answer: whether the dialog is reachable and
    // on screen in this engine, by the route the reader takes.
    out.toolbarButton = await wd.execute(
      `const b = document.querySelector('${TABLE_BUTTON}')
       if (!b) return null
       const r = b.getBoundingClientRect()
       return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width,
                height: r.height, title: b.getAttribute('title'),
                aria: b.getAttribute('aria-label'),
                visible: getComputedStyle(b).display !== 'none' && r.width > 0 }`,
    )
    if (!out.toolbarButton) return out

    await clickAt(wd, out.toolbarButton.x, out.toolbarButton.y)

    let appeared = true
    await until(() => wd.execute(`return Boolean(document.querySelector('.table-overlay .table-dialog'))`), {
      timeout: 5000,
      what: 'the table size dialog',
    }).catch(() => {
      appeared = false
    })

    // The arrival is allowed to settle before anything is read or clicked. The
    // dialog animates in (`overlay-in` / `surface-fade` / `surface-scale`), and a
    // rect read mid-animation is the rect of a scaled, transparent box: the first
    // run of this probe photographed an invisible dialog and clicked a button
    // that was not where it had been measured.
    if (appeared) {
      await until(
        () =>
          wd.execute(
            `const el = document.querySelector('.table-dialog')
             if (!el) return false
             const cs = getComputedStyle(el)
             return Number(cs.opacity) > 0.99 && el.getBoundingClientRect().width > 0`,
          ),
        { timeout: 5000, what: 'the dialog arrival to settle' },
      )
    }

    const readDialog = () =>
      wd.execute(
        `const el = document.querySelector('.table-dialog')
         if (!el) return null
         const r = el.getBoundingClientRect()
         const cs = getComputedStyle(el)
         return { top: r.top, left: r.left, width: r.width, height: r.height,
                  opacity: cs.opacity,
                  visible: cs.display !== 'none' && cs.visibility !== 'hidden'
                           && Number(cs.opacity) > 0.9 && r.width > 0,
                  inViewport: r.top >= 0 && r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight }`,
      )

    const readChrome = async () => ({
      title: await wd.execute(`return (document.querySelector('.table-dialog-title') || {}).textContent || null`),
      fields: await wd.execute(
        `return Array.from(document.querySelectorAll('.table-dialog-field'))
           .map(function (e) { return (e.textContent || '').trim() })`,
      ),
      steppers: await wd.execute(
        `return Array.from(document.querySelectorAll('.table-dialog-stepper'))
           .map(function (s) { return (s.querySelector('span') || {}).textContent || null })`,
      ),
      buttons: await wd.execute(
        `return Array.from(document.querySelectorAll('.table-dialog-actions button'))
           .map(function (b) { return (b.textContent || '').trim() })`,
      ),
      refusal: await wd.execute(
        `const el = document.querySelector('.table-dialog-refusal')
         return el ? (el.textContent || '').trim() : null`,
      ),
    })

    out.dialog = { appeared, box: await readDialog(), ...(await readChrome()), shot: await shot(wd, 'dialog') }
    if (!appeared) return out

    // Step the columns up twice (3 -> 5) and the rows once (3 -> 4) through the
    // dialog's OWN buttons — the route a reader takes, not a value written in.
    const step = async (index, times) => {
      for (let i = 0; i < times; i++) {
        const box = await wd.execute(
          `const b = document.querySelectorAll('.table-dialog-stepper')[${index}].querySelectorAll('button')[1]
           const r = b.getBoundingClientRect()
           return { x: r.left + r.width / 2, y: r.top + r.height / 2 }`,
        )
        await clickAt(wd, box.x, box.y)
        await sleep(90)
      }
    }
    await step(1, 2)
    await step(0, 1)
    out.dialog.afterStepping = await wd.execute(
      `return Array.from(document.querySelectorAll('.table-dialog-stepper'))
         .map(function (s) { return (s.querySelector('span') || {}).textContent || null })`,
    )

    // Confirm, by the dialog's own last button, clicked through the driver — and
    // hit-tested first. What is at that point is the question a "the click did
    // nothing" result cannot answer on its own: a button measured correctly and
    // covered by an overlay reads exactly like a button that was never there.
    const confirm = await wd.execute(
      `const bs = document.querySelectorAll('.table-dialog-actions button')
       const b = bs[bs.length - 1]
       if (!b) return null
       const r = b.getBoundingClientRect()
       const x = r.left + r.width / 2, y = r.top + r.height / 2
       const hit = document.elementFromPoint(x, y)
       return { x: x, y: y, label: (b.textContent || '').trim(),
                hitTag: hit ? hit.tagName : null, isTheButton: hit === b }`,
    )
    if (confirm) await clickAt(wd, confirm.x, confirm.y)
    await sleep(900)

    // What the caret-in-a-cell case produced: the dialog is still up, and it says
    // why. This is the reading that matters — the picker is not missing, the
    // insert was REFUSED, and the reading has to tell those apart.
    out.refused = {
      confirmLabel: confirm ? confirm.label : null,
      hit: confirm ? { tag: confirm.hitTag, isTheButton: confirm.isTheButton } : null,
      dialogStillUp: await wd.execute(`return Boolean(document.querySelector('.table-dialog'))`),
      refusal: await wd.execute(
        `const el = document.querySelector('.table-dialog-refusal')
         return el ? (el.textContent || '').trim() : null`,
      ),
      shapes: await wd.execute(`return ${TABLE_SHAPES}`),
      shot: await shot(wd, 'refused'),
    }

    // Close it, the way the reader would.
    const cancel = await wd.execute(
      `const bs = document.querySelectorAll('.table-dialog-actions button')
       const b = bs[0]
       if (!b) return null
       const r = b.getBoundingClientRect()
       return { x: r.left + r.width / 2, y: r.top + r.height / 2 }`,
    )
    if (cancel) await clickAt(wd, cancel.x, cancel.y)
    await sleep(400)
    out.dialogClosed = await wd.execute(`return !document.querySelector('.table-dialog')`)

    // ---- The caret deliberately outside the table, then insert -------------
    // Clicked on the heading, which is the nearest place a reader would put the
    // caret to start a new block above the table.
    const heading = await wd.execute(
      `const h = document.querySelector('.rendered-pane .ProseMirror h1')
       const r = h.getBoundingClientRect()
       return { x: r.right - 8, y: r.top + r.height / 2 }`,
    )
    out.headingClick = heading
    await clickAt(wd, heading.x, heading.y)
    await sleep(500)
    out.caretAfterHeadingClick = await wd.execute(`return ${CARET_STATE}`)
    // The button is re-measured rather than reused: it was read before a dialog
    // was opened and closed, and a point read once is a point that can go stale.
    const button2 = await wd.execute(
      `const b = document.querySelector('${TABLE_BUTTON}')
       const r = b.getBoundingClientRect()
       return { x: r.left + r.width / 2, y: r.top + r.height / 2,
                there: Boolean(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)) }`,
    )
    await clickAt(wd, button2.x, button2.y)
    await sleep(500)
    out.secondButton = button2
    out.afterSecondClick = await wd.execute(
      `const el = document.querySelector('.table-dialog')
       return { dialog: Boolean(el),
                overlay: Boolean(document.querySelector('.table-overlay')),
                opacity: el ? getComputedStyle(el).opacity : null,
                animations: el && el.getAnimations ? el.getAnimations().map(function (a) {
                  return { name: a.animationName || String(a.id || ''), state: a.playState,
                           fill: a.effect && a.effect.getTiming ? a.effect.getTiming().fill : null,
                           duration: a.effect && a.effect.getTiming ? a.effect.getTiming().duration : null }
                }) : null,
                caret: (${CARET_STATE}) }`,
    )
    // Waited on EXISTENCE and then allowed to settle, rather than polled on a
    // computed opacity: the arrival's last frame is what the rect has to be taken
    // at, and a predicate that keeps saying no while the dialog is plainly on
    // screen is a predicate measuring the wrong element. The opacity is reported
    // either way, so "it never settled" stays visible as a number.
    const second = await until(
      // `return` matters: WebDriver runs this script as a function BODY, so a
      // bare expression evaluates to `undefined` and the poll never fires.
      () => wd.execute(`return Boolean(document.querySelector('.table-dialog'))`),
      { timeout: 5000, what: 'the second dialog' },
    )
      .then(() => true)
      .catch(() => false)
    await sleep(700)
    out.secondDialog = second
    if (!second) {
      out.secondShot = await shot(wd, 'second-missing')
      return out
    }
    await step(1, 2)
    await step(0, 1)
    const confirm2 = await wd.execute(
      `const bs = document.querySelectorAll('.table-dialog-actions button')
       const b = bs[bs.length - 1]
       const r = b.getBoundingClientRect()
       return { x: r.left + r.width / 2, y: r.top + r.height / 2 }`,
    )
    await clickAt(wd, confirm2.x, confirm2.y)
    await sleep(900)

    out.inserted = {
      shapes: await wd.execute(`return ${TABLE_SHAPES}`),
      dialogGone: await wd.execute(`return !document.querySelector('.table-dialog')`),
      refusal: await wd.execute(
        `const el = document.querySelector('.table-dialog-refusal')
         return el ? (el.textContent || '').trim() : null`,
      ),
      emptyCell: await wd.execute(`return ${readCell(-1, 1, 1)}`),
    }

    await saveNow(wd)
    out.afterInsert = {
      writes: await wd.execute(`return ${ALL_WRITES}`),
      // The reader's own table, still in the same document: what an edit
      // elsewhere did to the cells nobody touched.
      originalNoteCells: {
        authorEmpty: await wd.execute(`return ${readCell(0, 1, 1)}`),
        markerCell: await wd.execute(`return ${readCell(0, 2, 0)}`),
      },
      shot: await shot(wd, 'after'),
    }

    // ---- The same command in SOURCE mode -----------------------------------
    // `run-editor-command.ts` states the contract — "a button behaves the same
    // in every view mode" — and this is the reading that decides whether the
    // table command keeps it. The source pane is CodeMirror, which has no grid
    // for a size dialog to step, so the question is not whether the dialog is
    // the same but whether the reader gets a choice AT ALL.
    await clickByText(wd, '.switch-option', 'Source').catch(() => null)
    await sleep(600)
    out.sourceMode = {
      reached: await wd.execute(`return Boolean(document.querySelector('.cm-content'))`),
      before: await wd.execute(
        `const c = document.querySelector('.cm-content')
         return c ? (c.textContent || '').slice(0, 40) : null`,
      ),
    }
    if (out.sourceMode.reached) {
      await clickAt(wd, out.toolbarButton.x, out.toolbarButton.y)
      await sleep(700)
      out.sourceMode.afterClick = {
        dialog: await wd.execute(`return Boolean(document.querySelector('.table-dialog'))`),
        text: await wd.execute(
          `const c = document.querySelector('.cm-content')
           return c ? (c.textContent || '').slice(0, 160) : null`,
        ),
        shot: await shot(wd, 'source'),
      }
    }
    return out
  },
}

