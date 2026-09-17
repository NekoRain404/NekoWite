/**
 * A blank table cell, and the rows × columns picker, in both view modes.
 *
 * Split out of `verify.mjs` at §13.1's line budget and along the seam that file splits by: the
 * SUBJECT. Everything left there reads a surface one of the pre-existing probes measured; this
 * reads the two the table probe opened. The collector arrives as an argument, so `Checks` stays
 * the one place a verdict is formed.
 *
 * A run under any scenario but `table` reports the probe skipped, and this then claims nothing —
 * the same shape `note-switch` has, so a plain run of everything neither passes nor fails here.
 *
 * Every check names the mutation that turns it red, and the pair that carries the reader's report
 * was shown red by running the probe against the unmodified sources: the saved note came back
 * `| <br /> |` in every blank cell, and the fixture's marker cell reopened with `atoms=1`.
 */

export function verifyTable(c, results) {
  // A blank table cell, and the rows × columns picker, in both view modes. Under any scenario
  // but `table` the probe reports itself skipped and claims nothing — the same shape
  // `note-switch` has — so a plain run of everything neither passes nor fails these.
  const table = results.probes['table-cell']
  if (table && !table.skipped) {
    const marker = table.onOpen?.markerCell
    const dialog = table.dialog ?? {}
    const inserted = table.inserted ?? {}
    // FAILS IF: the empty-cell placeholder is written again — the paragraph serializer's
    // `<br />` reaching a cell, by either route (a fresh table's blank cells, or a note that
    // already holds one and is re-saved).
    c.run(
      'table: a blank cell is written as a blank cell',
      `saved bytes: ${JSON.stringify(table.afterInsert?.writes?.find((w) => w.path.endsWith('.md'))?.content ?? null)}`,
      typeof table.afterInsert?.writes !== 'undefined' &&
        !table.afterInsert.writes.some((w) => w.path.endsWith('.md') && w.content.includes('<br')),
    )
    // FAILS IF: the marker survives the parse as an `html` atom. `trailingBreaks` is
    // ProseMirror's own caret `<br>`, which is never serialized; `atoms` is the marker, and it
    // is what let a save write `<br />` beside whatever was typed next to it.
    c.run(
      'table: a note that already holds `| <br /> |` reopens with an empty cell',
      `atoms=${marker?.atoms} trailingBreaks=${marker?.trailingBreaks} text=${JSON.stringify(marker?.text)}`,
      marker?.atoms === 0 && marker?.text === '',
    )
    // FAILS IF: the toolbar button is gone, hidden, or its command stops resolving to the
    // dialog — the whole of what "I need to set rows and columns" asks for.
    c.run(
      'table: the toolbar button opens the size dialog',
      `button=${JSON.stringify(table.toolbarButton)} appeared=${dialog.appeared} box=${JSON.stringify(dialog.box)}`,
      Boolean(table.toolbarButton?.visible) &&
        dialog.appeared === true &&
        dialog.box?.visible === true &&
        dialog.box?.inViewport === true,
    )
    // FAILS IF: the dialog loses its two number fields, or opens on a size it cannot insert.
    c.run(
      'table: the dialog offers rows and columns',
      `title=${JSON.stringify(dialog.title)} fields=${JSON.stringify(dialog.fields)} steppers=${JSON.stringify(dialog.steppers)} buttons=${JSON.stringify(dialog.buttons)}`,
      Array.isArray(dialog.steppers) &&
        dialog.steppers.length === 2 &&
        dialog.steppers.every((v) => Number(v) >= 2 || v === '3') &&
        Array.isArray(dialog.fields) &&
        dialog.fields.length === 2,
    )
    // FAILS IF: the steppers stop reaching the document. The probe stepped 3×3 to 4×5 through
    // the dialog's own buttons; the fixture table is 3×2, so the new shape has to be the one
    // that was ASKED for, not the default and not the fixture.
    const newest = inserted.shapes?.[0]
    c.run(
      'table: the size asked for is the size inserted',
      `tables on the page ${JSON.stringify(inserted.shapes)} dialogGone=${inserted.dialogGone}`,
      newest?.rows === 4 && newest?.cols === 5 && inserted.dialogGone === true,
    )
    // FAILS IF: a refused insert closes the dialog and says nothing — the regression the
    // refusal message exists for. The caret opens inside the table's last cell, so this is
    // the reading of what a reader meets when they click the button straight away.
    c.run(
      'table: a refused insert keeps the dialog and says why',
      `stillUp=${table.refused?.dialogStillUp} hit=${JSON.stringify(table.refused?.hit)} refusal=${JSON.stringify(table.refused?.refusal)}`,
      table.refused?.dialogStillUp === true &&
        typeof table.refused?.refusal === 'string' &&
        table.refused.refusal.length > 0 &&
        table.refused?.hit?.isTheButton === true,
    )
    // FAILS IF: source mode goes back to inserting a fixed 3×3 with no question asked. The
    // same button has to mean the same thing in both view modes.
    c.run(
      'table: source mode gets the same picker',
      `reached=${table.sourceMode?.reached} dialog=${table.sourceMode?.afterClick?.dialog}`,
      table.sourceMode?.reached !== true || table.sourceMode?.afterClick?.dialog === true,
    )
  }
}
