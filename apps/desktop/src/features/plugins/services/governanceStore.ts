/* ------------------------------------------------------------------------- *
 * Vault-scoped plugin records — the desktop embedder half of governance.
 *
 * The plugin governance RULES (revocation, version policy / rollback, the audit
 * ring, the MAC envelope, semver, serialization) live in
 * `@nekowite/plugin-host/governance`, which is environment-agnostic by design:
 * it keeps state in memory and exposes a serialize/load surface. What lives HERE
 * are the records that package deliberately leaves to its embedder — the trusted
 * key, the trusted-source allowlist, the approved digests, the user's on/off
 * switch — kept in memory for the session and persisted to a vault-relative,
 * MAC-protected file through fsService by ./governanceFile. NOT to localStorage,
 * which a WebView profile / localStorage attacker could rewrite.
 *
 * There is deliberately no second governance-POLICY module here: two owners of
 * the same rule is how the two drift apart. This file stores and persists; the
 * policy questions are answered by `@nekowite/plugin-host/governance`, by
 * ./trustPolicy (publisher authenticity) and by ./integrity (change detection).
 * ------------------------------------------------------------------------- */

import {
  loadGovernance,
  publisherIdOf,
  resetGovernanceForTests,
  revokePlugin,
  serializeGovernance,
  setPluginVersionRange,
} from '@nekowite/plugin-host'
import type { PluginDigestStore, PluginVersionRange } from '@nekowite/plugin-host'
import {
  clearMacSecretCache,
  readGovernanceFile,
  signalGovernanceTamperNotice,
  writeGovernanceFile,
  type DigestEntry,
  type DigestMap,
  type GovernanceFilePayload,
} from './governanceFile'

// The vault the store is currently scoped to (set on every load so a save always
// targets the right vault, and so a stale writer from a previous vault can never
// write into this one).
let currentVault: string | null = null
const GOVERNANCE_SAVE_DEBOUNCE_MS = 250
let governanceSaveTimer: ReturnType<typeof setTimeout> | null = null

/** The vault the store is currently scoped to, or null before the first load. */
export function getCurrentVault(): string | null {
  return currentVault
}

/** Composite storage key for every record scoped to a (vault, plugin id) pair:
 *  vault + plugin id, NUL-separated so a vault path and an id that both contain
 *  "/" can never collide. Two different vaults therefore never share a record for
 *  the same plugin id — a trust/permission decision made in one vault can never
 *  authorise the same-id plugin of another. */
export function vaultScopedKey(vault: string | null, id: string): string {
  // NUL separator: a vault path and a plugin id can both contain "/", so a plain
  // concatenation (or "/" join) could collide across vaults.
  return `${vault ?? ''}\u0000${id}`
}

/* ----------------------------- trust records --------------------------- */

// Authoritative in-memory trust configuration. Loaded from (and saved to) the
// MAC-protected governance file; NEVER read as an authoritative value from
// localStorage (a WebView profile / localStorage attacker must not be able to
// rewrite trust).
let memoryTrustedKey = ''
const memoryTrustedSources = new Set<string>()

/** The trusted publisher key material (a hex or UTF-8 secret), or '' if none. */
export function getPluginTrustedKey(): string {
  return memoryTrustedKey
}

/** Configure the trusted publisher key used to verify plugin signatures. Only
 *  plugins signed by a holder of this secret are treated as cryptographically
 *  trusted; a present-but-unverifiable signature is refused. Persisted to the
 *  MAC-protected governance file (best-effort, async). */
export function setPluginTrustedKey(keyMaterial: string): void {
  memoryTrustedKey = keyMaterial
  scheduleGovernanceSave()
}

/** The ids the user has explicitly trusted (publisher ids and/or full plugin ids). */
export function getPluginTrustedSourceIds(): string[] {
  return [...memoryTrustedSources]
}

/** True when a plugin's id OR its publisher id is in the trusted-source allowlist. */
export function isPluginTrustedSource(pluginId: string): boolean {
  const ids = getPluginTrustedSourceIds()
  return ids.includes(pluginId) || ids.includes(publisherIdOf(pluginId))
}

/** Add or remove an id on the trusted-source allowlist. Persisted to the
 *  MAC-protected governance file (best-effort, async). */
export function setPluginTrustedSource(pluginId: string, trusted: boolean): void {
  const ids = new Set(getPluginTrustedSourceIds())
  if (trusted) ids.add(pluginId)
  else ids.delete(pluginId)
  memoryTrustedSources.clear()
  for (const id of ids) memoryTrustedSources.add(id)
  scheduleGovernanceSave()
}

/* ---------------------------- digest records --------------------------- */

// Authoritative, in-memory digest baseline. This is loaded from (and saved to)
// the MAC-protected governance file; it is NEVER read from localStorage as an
// authoritative value (a WebView profile / localStorage attacker must not be able
// to rewrite an approval baseline). localStorage is no longer used for digests.
const memoryDigestMap = new Map<string, DigestEntry>()

function readDigestMap(): DigestMap {
  return Object.fromEntries(memoryDigestMap)
}

function writeDigestMap(map: DigestMap): void {
  memoryDigestMap.clear()
  for (const [key, value] of Object.entries(map)) memoryDigestMap.set(key, value)
  scheduleGovernanceSave()
}

/** Test-only: seed a recorded baseline digest for a (vault, id) pair. Mirrors the
 *  authoritative in-memory store so tests can drive the integrity gate without
 *  going through the MAC file. */
export function setPluginRecordedDigestForTest(
  vault: string,
  id: string,
  version: string,
  digest: string,
): void {
  memoryDigestMap.set(vaultScopedKey(vault, id), { v: version, d: digest })
}

/** Test-only: read the recorded baseline digest for a (vault, id) pair. */
export function getPluginRecordedDigestForTest(vault: string, id: string): string | undefined {
  return memoryDigestMap.get(vaultScopedKey(vault, id))?.d
}

/** The last-approved digest for a (vault, plugin id) pair, if any. */
export function getRecordedDigest(vault: string, id: string): string | undefined {
  return readDigestMap()[vaultScopedKey(vault, id)]?.d
}

/** Record (or re-approve) a plugin's digest as the new expected baseline. */
export function setRecordedDigest(vault: string, id: string, version: string, digest: string): void {
  const map = readDigestMap()
  map[vaultScopedKey(vault, id)] = { v: version, d: digest }
  writeDigestMap(map)
}

// Adapter so plugin-host's validate helper can read the persisted value, scoped
// to the vault currently being loaded (closing over `vault`).
export function makeVaultIntegrityStore(vault: string): PluginDigestStore {
  return {
    get: (id) => getRecordedDigest(vault, id),
    set: () => {
      /* recording happens through setRecordedDigest (needs the version too) */
    },
  }
}

/* ------------------------- the on/off switch --------------------------- */

/** Plugin ids the user switched off for the current vault (the `disabled` field
 *  of the governance file). Authoritative copy in memory, mirrored to the file. */
const disabledPlugins = new Set<string>()

/** Whether a plugin is switched off in the current vault. */
export function isVaultPluginDisabled(pluginId: string): boolean {
  return disabledPlugins.has(pluginId)
}

/** Add (or remove) a plugin id in the in-memory disabled set. Persisting is the
 *  caller's decision: the switch has two writers (the vault scan and the settings
 *  panel) that persist against different vaults. */
export function setDisabledPluginRecord(pluginId: string, disabled: boolean): void {
  if (disabled) disabledPlugins.add(pluginId)
  else disabledPlugins.delete(pluginId)
}

/** Collect the current security-relevant records into a payload string. */
function buildGovernancePayload(): GovernanceFilePayload {
  return {
    governance: serializeGovernance(),
    trustedKey: memoryTrustedKey,
    trustedSources: [...memoryTrustedSources],
    digests: readDigestMap(),
    disabled: [...disabledPlugins],
  }
}

/** Debounced, async persistence of the governance state to the MAC file. Fire-and-
 *  forget; a missing/incomplete fs is a silent no-op (state still lives in memory
 *  for the session). */
export function scheduleGovernanceSave(): void {
  if (!currentVault) return
  if (governanceSaveTimer) clearTimeout(governanceSaveTimer)
  governanceSaveTimer = setTimeout(() => {
    governanceSaveTimer = null
    if (currentVault) void writeGovernanceFile(currentVault, buildGovernancePayload())
  }, GOVERNANCE_SAVE_DEBOUNCE_MS)
}

/**
 * Load the MAC-protected governance file for a vault into the authoritative
 * in-memory records. Assumes `currentVault` is already set.
 *
 *  - File absent                 -> first run; keep any in-memory (session) state.
 *  - Content not a MAC envelope  -> not a governance file (a stale/mismatched read,
 *                                   e.g. a note or a libwebfs path mismatch); keep
 *                                   in-memory state, never clobber the file.
 *  - MAC verify FAILS            -> TAMPERED: reset trust-nothing + surface a notice
 *                                   (never silently trust the file's contents).
 *  - MAC verify PASSES           -> apply the file's records authoritatively.
 */
export async function loadGovernanceFile(vault: string): Promise<void> {
  currentVault = vault
  const read = await readGovernanceFile(vault)
  if (read.kind === 'tampered') {
    resetTrustRecordsForTamper()
    signalGovernanceTamperNotice()
    return
  }
  if (read.kind !== 'ok') return
  try {
    const payload = JSON.parse(read.payload) as GovernanceFilePayload
    memoryTrustedKey = typeof payload.trustedKey === 'string' ? payload.trustedKey : ''
    memoryTrustedSources.clear()
    for (const id of Array.isArray(payload.trustedSources) ? payload.trustedSources : []) {
      memoryTrustedSources.add(id)
    }
    memoryDigestMap.clear()
    for (const [k, v] of Object.entries(payload.digests ?? {})) memoryDigestMap.set(k, v)
    disabledPlugins.clear()
    for (const id of Array.isArray(payload.disabled) ? payload.disabled : []) {
      if (typeof id === 'string' && id) disabledPlugins.add(id)
    }
    if (typeof payload.governance === 'string') loadGovernance(payload.governance)
  } catch {
    resetTrustRecordsForTamper()
    signalGovernanceTamperNotice()
  }
}

/** Reset the in-memory trust records (never trust a tampered file). */
function resetTrustRecordsForTamper(): void {
  memoryTrustedKey = ''
  memoryTrustedSources.clear()
  memoryDigestMap.clear()
}

/**
 * Read the disabled set straight from a vault's governance file.
 *
 * The loader normally applies it, but the loader is not always reached: the
 * strict-CSP build skips plugin loading entirely, so the settings panel - whose
 * job is to show and change this switch - has to be able to read it on its own.
 * A missing or unverifiable file reads as "nothing disabled": this must never
 * invent a policy, and never be the reason a panel fails to render.
 */
export async function refreshDisabledPlugins(vault: string): Promise<void> {
  try {
    const read = await readGovernanceFile(vault)
    if (read.kind !== 'ok') return
    const payload = JSON.parse(read.payload) as GovernanceFilePayload
    disabledPlugins.clear()
    for (const id of Array.isArray(payload.disabled) ? payload.disabled : []) {
      if (typeof id === 'string' && id) disabledPlugins.add(id)
    }
  } catch {
    /* no governance file yet */
  }
}

/**
 * Persist the disabled set for `vault`, READ-MODIFY-WRITE.
 *
 * Reading first is the point: this file also holds trust anchors, revocations
 * and digests, and the CSP-blocked build never loaded them into memory. Writing
 * a fresh payload built from empty in-memory records would silently erase a
 * user's revocations, so the file's own contents are the base whenever they are
 * readable and their MAC verifies. An unverifiable file is left untouched:
 * overwriting a tampered file is how the attacker's version becomes the trusted
 * one on the next read.
 */
export async function persistDisabledPlugins(vault: string): Promise<void> {
  try {
    const read = await readGovernanceFile(vault)
    if (read.kind === 'tampered') return
    let payload: GovernanceFilePayload | null = null
    if (read.kind === 'ok') {
      try {
        payload = JSON.parse(read.payload) as GovernanceFilePayload
      } catch {
        payload = null // a valid MAC over unparseable content: fall back to memory
      }
    }
    const base: GovernanceFilePayload = payload ?? buildGovernancePayload()
    const next: GovernanceFilePayload = { ...base, disabled: [...disabledPlugins] }
    await writeGovernanceFile(vault, next)
  } catch {
    /* best-effort, exactly like the other governance writer */
  }
}

/* ------------------- vault-scoped governance wrappers ------------------ */

/** Revoke a plugin id (all versions) or a specific version/range. Persisted to the
 *  MAC-protected governance file (best-effort, async). */
export function revokeVaultPlugin(pluginId: string, version = 'all', reason?: string): void {
  revokePlugin(pluginId, version, reason)
  scheduleGovernanceSave()
}

/** Configure the supported version range for a plugin. Persisted to the file. */
export function setVaultPluginVersionRange(pluginId: string, range: PluginVersionRange): void {
  setPluginVersionRange(pluginId, range)
  scheduleGovernanceSave()
}

/** Reset the in-memory records this store owns (trust, digests, switch, vault
 *  binding, MAC secret) plus the plugin-host governance state. Test-only. */
export function resetGovernanceStoreForTests(): void {
  memoryTrustedKey = ''
  memoryTrustedSources.clear()
  memoryDigestMap.clear()
  disabledPlugins.clear()
  currentVault = null
  clearMacSecretCache()
  if (governanceSaveTimer) {
    clearTimeout(governanceSaveTimer)
    governanceSaveTimer = null
  }
  resetGovernanceForTests()
}
