/**
 * A scratch vault, and the records that let the built application open one without a folder dialog.
 *
 * Shared by the probes that drive the real application, because the awkward part is not writing files —
 * it is being allowed to open them. The app's own rule (`open_file.rs`) is that the *command line* is a
 * fact the renderer cannot manufacture, so a path from it is vouched for exactly like a folder-dialog
 * pick, while a path from the session bus never creates a root. A folder dialog cannot be driven from
 * these probes, so they use the other half of the same design: the backend's own record of the last vault
 * (`<config dir>/dev.nekowite.app/last-vault`, one line, read by `state/remembered.rs`) plus the
 * renderer's `nekowite.vault` key, which `VaultRegistry::register` accepts for a root it remembers
 * (`vault_confinement.rs`'s `recalled`). No dialog, and no test-only back door.
 *
 * Everything is written under the repository's git-ignored scratch, never into the invoking user's home.
 */
import fs from 'node:fs'
import path from 'node:path'

/**
 * Write a vault with `files` in it, and the record that makes it the one the app last had open.
 *
 * `files` keys may contain directories (`notes/a.md`); each is created. `configHome` is the probe's
 * `XDG_CONFIG_HOME`, so the record lands in the scratch config directory the app is about to read.
 */
export function seedVault({ dir, files, configHome }) {
  fs.mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  const record = path.join(configHome, 'dev.nekowite.app', 'last-vault')
  fs.mkdirSync(path.dirname(record), { recursive: true })
  fs.writeFileSync(record, `${dir}\n`)
  return dir
}
