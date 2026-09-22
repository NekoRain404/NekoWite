/**
 * Delete a note and put it back — the two operations a user cannot undo by hand.
 *
 * `docs/RECOVERY.md` §2 promises that a deleted note goes to the vault's own `.nekowite-trash/` and can be
 * restored to where it was. The vitest suites test the trash store against a memory filesystem; nothing has
 * ever deleted a real file **through the running application's own menu** and then read the disk.
 *
 * Both halves are driven the way a user does them: the note card's own context menu (a **native** right-click,
 * because the app records which note the menu acts on from that event), its inline confirmation, and then the
 * sidebar's 回收站 group with the entry's 恢复 button. What is asserted is the **filesystem**, not the panel:
 * the note leaves the vault, an entry appears under `.nekowite-trash/`, and restoring puts the same text back.
 *
 * Split out of `drive-app.mjs`, which owns the session and supplies the driver calls.
 */
import fs from 'node:fs'
import path from 'node:path'
import { rightClickElement } from './drive-pointer.mjs'
import { until } from './webdriver.mjs'

/** The vault's own trash directory (`docs/PRIVACY.md` lists it beside `.nekowite/`). */
const TRASH_DIR = '.nekowite-trash'

/** How many entries the trash holds, so a restore can be seen to *move* one rather than copy it. */
function trashEntries(vault) {
  try {
    return fs.readdirSync(path.join(vault, TRASH_DIR))
  } catch {
    return []
  }
}

export async function driveTrash({ run, findElement, readings, vault, notePath, noteName }) {
  const exists = () => fs.existsSync(notePath)
  const text = () => (exists() ? fs.readFileSync(notePath, 'utf8').replace(/\s+/g, ' ').slice(0, 100) : null)
  const trash = { before: text(), trashBefore: trashEntries(vault).length }
  readings.trash = trash

  // ---- Delete, through the card's own menu --------------------------------------------------------------
  const card = await findElement('css selector', 'article.note-card')
  trash.cardFound = card !== null
  if (!card) return
  const rightClick = await rightClickElement({ run, elementId: card })
  trash.rightClick = rightClick.ok
  if (!rightClick.ok) {
    trash.rightClickError = rightClick.error
    return
  }
  const deleteItem = await until(
    async () => findElement('xpath', '//button[@role="menuitem"][contains(., "删除")]').catch(() => null),
    { timeout: 8_000, what: 'the delete item in the note menu' },
  ).catch(() => null)
  trash.deleteItemFound = deleteItem !== null
  if (!deleteItem) return
  await run('POST', `/element/${deleteItem}/click`, {})
  // The app asks once, inline, before anything is moved — the panel's own `.nl-del-yes`.
  const confirm = await until(async () => findElement('css selector', '.nl-del-yes').catch(() => null), {
    timeout: 8_000,
    what: 'the inline delete confirmation',
  }).catch(() => null)
  trash.confirmFound = confirm !== null
  if (!confirm) return
  await run('POST', `/element/${confirm}/click`, {})
  trash.goneFromDisk = await until(async () => (exists() ? null : true), {
    timeout: 10_000,
    what: 'the note to leave the vault',
  }).catch(() => false)
  trash.trashAfterDelete = trashEntries(vault)

  // ---- Restore, from the sidebar's own group ------------------------------------------------------------
  const header = await findElement(
    'xpath',
    '//*[contains(@class, "group-header")][.//*[contains(@class, "group-title") and contains(text(), "回收站")]]',
  )
  trash.trashGroupFound = header !== null
  if (header) await run('POST', `/element/${header}/click`, {})
  const restore = await until(
    async () =>
      findElement(
        'xpath',
        `//*[contains(@class, "trash-item")][.//*[contains(@class, "trash-name") and contains(text(), "${noteName}")]]//button[contains(@class, "trash-restore")]`,
      ).catch(() => null),
    { timeout: 10_000, what: 'the restore button for the deleted note' },
  ).catch(() => null)
  trash.restoreFound = restore !== null
  if (!restore) return
  await run('POST', `/element/${restore}/click`, {})
  trash.restored = await until(async () => (exists() ? true : null), {
    timeout: 10_000,
    what: 'the note to come back to its path',
  }).catch(() => false)
  trash.after = text()
  trash.trashAfterRestore = trashEntries(vault)
}
