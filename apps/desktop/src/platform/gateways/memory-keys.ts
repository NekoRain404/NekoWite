/**
 * The memory adapter's key port.
 *
 * An AI key is "stored" nowhere, so a test never has to clean one up and no key
 * can leak from one run into the next. `loadAiKey` answers `null` — "no key
 * configured" — which is what the settings surface shows before a user adds
 * one, rather than inventing a credential that would make an unconfigured
 * provider look ready.
 *
 * The vault is in no state either, and for the same reason: `vaultStatus`
 * answers "no master password, nothing to unlock", which is what a browser
 * build really has — no key file, no vault, no password to ask for. The two
 * writes are accepted and discarded rather than rejected, because a double that
 * refused them would be claiming a failure the real adapter does not have; what
 * it cannot do is *change* the answer above, and that is the honest limit of a
 * key store that keeps nothing.
 */

import type { KeyPort } from './contracts'

export const memoryKeyPort: KeyPort = {
  storeAiKey: async () => undefined,
  loadAiKey: async () => null,
  vaultStatus: async () => ({ passwordSet: false, unlocked: true }),
  setMasterPassword: async () => undefined,
  unlockVault: async () => undefined,
}
