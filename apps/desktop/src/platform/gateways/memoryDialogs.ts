/**
 * The memory adapter's dialog port.
 *
 * Simulated native dialogs: the demo always "picks" the in-memory vault, and
 * nothing is ever written to disk through a dialog, so `saveFileDialog` answers
 * `null` — "the user cancelled" — rather than inventing a path no backend could
 * then read. What an image pick returns is the queued registry in
 * `memoryPickedFiles.ts`.
 *
 * The combined fs gateway carries these same three members (it implements the
 * dialog port beside the fs port), so a caller that holds only the narrow port
 * reaches the same behaviour through {@link createMemoryDialogPort}.
 */

import type { DialogPort, FsGateway } from './contracts'
import { takePickedPaths } from './memoryPickedFiles'

export const memoryDialogPort: DialogPort = {
  openFolderDialog: async () => 'memoir://demo',
  saveFileDialog: async () => null,
  pickImageFiles: async () => takePickedPaths(),
}

/** A {@link DialogPort} view over a (combined) memory FS gateway. */
export function createMemoryDialogPort(fs: FsGateway): DialogPort {
  return {
    openFolderDialog: () => fs.openFolderDialog(),
    saveFileDialog: (defaultName, startDir) => fs.saveFileDialog(defaultName, startDir),
    pickImageFiles: () => fs.pickImageFiles(),
  }
}
