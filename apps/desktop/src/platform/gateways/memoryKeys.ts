/**
 * The memory adapter's key port.
 *
 * An AI key is "stored" nowhere, so a test never has to clean one up and no key
 * can leak from one run into the next. `loadAiKey` answers `null` — "no key
 * configured" — which is what the settings surface shows before a user adds
 * one, rather than inventing a credential that would make an unconfigured
 * provider look ready.
 */

import type { KeyPort } from './contracts'

export const memoryKeyPort: KeyPort = {
  storeAiKey: async () => undefined,
  loadAiKey: async () => null,
}
