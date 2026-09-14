/* ------------------------------------------------------------------------- *
 * The gated vault-plugin load pipeline.
 *
 * This module owns the ORDER of the gates. Nothing here decides what a gate
 * means — revocation/version policy is `@nekowite/plugin-host/governance`,
 * consent is ./permissions, publisher authenticity is ./trustPolicy, change
 * detection is ./integrity, the gates that need the plugin's own code are
 * ./vaultPluginPostimport, and the records they consult are ./governanceStore.
 * What is owned here is the sequence: no plugin code is executed before every
 * gate has passed, and no gate is skipped.
 * ------------------------------------------------------------------------- */

import {
  clearAuditLog,
  collectPluginPermissions,
  createPluginError,
  flushAuditLogToFile,
  governanceRefusal,
  isPluginRevoked,
  isVersionAllowed,
  joinPath,
  loadPlugin,
  recordPluginEvent,
  recordPluginVersion,
  resetUnstablePlugin,
  rollbackPoint,
  verifyPluginIntegrity,
} from '@nekowite/plugin-host'
import type { DynamicImport, LoadResult, PluginDefinition, PluginFsEntry } from '@nekowite/plugin-host'
import { describePluginError, notifyError } from '../../../services/errors'
import { t } from '../../../i18n'
import {
  importSource,
  isPluginImportAllowedByCsp,
  loadFailure,
  makeVaultPluginFsAdapter,
  MAX_PARALLEL_PLUGIN_LOADS,
  preloadVaultPlugin,
  runBounded,
  signalPluginLoadingDisabledByCsp,
  type PreloadedPlugin,
} from './discovery'
import {
  disposeVaultAuditLogFile,
  ensureLifecycleErrorRouter,
  setupAuditRouter,
  setupVaultAuditLogFile,
} from './audit-log'
import {
  getRecordedDigest,
  isVaultPluginDisabled,
  loadGovernanceFile,
  makeVaultIntegrityStore,
  scheduleGovernanceSave,
} from './governance-store'
import { askPluginPermission } from './permissions'
import { askReapproveIntegrity } from './integrity'
import { decidePluginTrust } from './trust-policy'
import { applyPostImportGates } from './vault-plugin-postimport'
import {
  activateVaultPlugins,
  deactivateVaultPlugins,
  getVaultPluginClaim,
} from './vault-plugin-activate'

/**
 * Scan `vault/plugins/<id>/` for user plugins and activate each one.
 *
 * Reading goes through the injected `PluginFsAdapter` (built from the app's vault
 * file service, so the boundary plugin-host defines is real in production), while
 * `loadPlugin`/`activatePlugin` keep the plugin-host contract. Every
 * previously-activated vault plugin is deactivated first so switching vaults
 * never leaks a plugin's components/commands/lifecycle hooks into the next
 * vault. Best-effort: a missing plugins dir is not an error; per-plugin failures
 * are surfaced through the app's error toast.
 *
 * Loading is staged to keep startup time from growing linearly with plugin count,
 * AND so no plugin code is executed before it is verified:
 *  1. Per-plugin independent work (read manifest → read code → fingerprint) runs
 *     concurrently with bounded parallelism. NO module is imported here; each
 *     plugin's source string is only read and digested.
 *  2. Permission confirmation (manifest-declared capabilities) stays sequential
 *     (it drives a user dialog), followed by the integrity gate. A plugin that
 *     fails either gate is NEVER imported.
 *  3. Only after consent + integrity pass does the loader import (execute) the
 *     plugin source — the last action before activation. This is the security
 *     boundary: a tampered or unapproved plugin's top-level side effects never
 *     run, even if it would later be "not activated."
 *  4. Post-import, a plugin that declares additional capabilities in its code is
 *     consent-checked again (best-effort, since top-level already ran), a
 *     point-of-use permission guard runs, and non-isolated declarations surface
 *     a "trusted-but-unsandboxed" notice.
 *  5. Activation of the consented plugins runs concurrently, but recorded in a
 *     deterministic order (sorted by plugin id) so the UI/registration order is
 *     stable across reloads.
 */
export async function loadVaultPlugins(vault: string): Promise<void> {
  deactivateVaultPlugins()
  // This scan's claim on the plugin set. Every await below (a read, a consent
  // dialog, a digest, an import) can be overtaken by a vault switch, which starts
  // a new claim (see `getVaultPluginClaim`).
  const claim = getVaultPluginClaim()
  // On every vault load, dispose the previous vault's audit-log sink and clear the
  // audit ring: a stale sink (closure over a prior vault) must never write into
  // this vault, and events must not leak across a vault switch. A fresh log is
  // then reloaded from THIS vault's file below.
  disposeVaultAuditLogFile()
  clearAuditLog()
  ensureLifecycleErrorRouter()
  // Attach the audit router and best-effort wire the audit log to a vault-relative
  // file via the fs service (when available). This runs before the CSP gate so
  // governance decisions are always observed.
  setupAuditRouter()
  setupVaultAuditLogFile(vault)

  const adapter = makeVaultPluginFsAdapter(vault)
  let entries: PluginFsEntry[]
  try {
    entries = await adapter.readdir(joinPath(vault, 'plugins'))
  } catch {
    return
  }
  const pluginDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  // A vault with no `plugins/` directory has nothing that could be disabled, so
  // there is nothing to report and nothing to gate: staying quiet here is the
  // absence of a requested feature, not a silent failure. Telling every user on
  // every launch that plugins are blocked — in a vault they never put a plugin
  // in — turns a security implementation detail into permanent, alarming noise
  // (and used to write a plugin audit record into every vault on open).
  if (pluginDirs.length === 0) return

  // CSP gate: the production Tauri webview's strict CSP blocks the in-window
  // `import('blob:...')` that plugin loading relies on. Rather than attempting
  // (and failing) the import for every plugin, skip the scan entirely and surface
  // one notice. The permission/integrity/manifest code below stays intact so it
  // becomes live the moment plugin loading moves behind real isolation. The gate
  // only triggers in the real Tauri webview — not in the unit-test DOM or the
  // browser Demo, where the existing integrity/permission scenarios still run.
  // Listing the directory first is deliberate: it reads no plugin code and every
  // vault open already lists directories, but it is what lets us tell "the user
  // has plugins that cannot load" from "the user has no plugins at all".
  if (!isPluginImportAllowedByCsp()) {
    signalPluginLoadingDisabledByCsp()
    void flushAuditLogToFile()
    return
  }

  // Governance/trust state (revocations, versions, ranges, trusted key, trusted
  // sources, digests) is persisted in a MAC-protected vault file. Load it now that
  // we're scoping to this vault — after the CSP gate so a CSP-blocked build does
  // not touch the file system. On a MAC failure this refuses the contained trust.
  await loadGovernanceFile(vault)

  // Phase 1 — parallel, independent per-plugin work (manifest + code + digest).
  // No import happens here; execution is deferred until after the gates below.
  const preloaded = await runBounded(
    pluginDirs.map((name) => () => preloadVaultPlugin(adapter, vault, name)),
    MAX_PARALLEL_PLUGIN_LOADS,
  )
  // Deterministic registration order for the UI, independent of IO timing.
  preloaded.sort((a, b) => (a.meta?.id ?? a.dirName).localeCompare(b.meta?.id ?? b.dirName))

  // Re-approval for the host's quarantine ("crash-restart-on-unstable"). The host
  // refuses to activate a plugin marked unstable until it is explicitly reset, and
  // deactivating cannot do it: markPluginUnstable already removed the plugin from
  // the host's active map, so `deactivatePlugin` (and therefore
  // `deactivateVaultPlugins`) returns early and the flag used to survive a vault
  // switch forever. Loading a vault IS the re-approval the refusal message asks
  // for — a deliberate user action (open/switch a library, or reload on the
  // message's advice) — and it only drops the stability quarantine: the plugin is
  // imported and activated again only if it passes every gate below (revocation,
  // version policy, consent, trust, integrity). This is also the only reachable
  // path for it, which is why it happens here rather than behind its own command.
  for (const p of preloaded) {
    if (p.meta) resetUnstablePlugin(p.meta.id)
  }

  // Phase 2 — sequential permission confirmation (user dialog) + integrity
  // verification, THEN the gated import. Collect the consented plugins for
  // concurrent activation.
  const integrityStore = makeVaultIntegrityStore(vault)
  const consented: PreloadedPlugin[] = []
  for (const p of preloaded) {
    // A directory without a manifest is not a plugin; drop it quietly.
    if (p.skip) continue
    if (p.error) {
      notifyError(describePluginError(p.error))
      continue
    }
    const meta = p.meta
    const source = p.source
    if (!meta || !source) continue

    // GATE -1 — the user switched this plugin off. Checked before consent,
    // trust and integrity so a disabled plugin is not asked about, not read
    // and certainly not run; that is what "off" has to mean.
    if (isVaultPluginDisabled(meta.id)) continue

    // GATE 0 — revocation, BEFORE any execution. A revoked plugin (id or version
    // /range) is refused here with the recorded reason, so its module is never
    // imported. Non-silent: audited + surfaced via the error channel.
    const rev = isPluginRevoked(meta.id, meta.version)
    if (rev.revoked) {
      recordPluginEvent(meta.id, 'revoked', rev.reason ?? 'revoked', { version: meta.version, sanitize: true })
      const refused = governanceRefusal(
        meta.id,
        'revoked',
        `Plugin "${meta.name}" has been revoked${rev.reason ? `: ${rev.reason}` : ''} and will not be loaded.`,
        'Remove or update the plugin, or unrevoke it if you trust the new version.',
      )
      notifyError(describePluginError(refused))
      continue
    }

    // GATE 0.5 — version policy. A version outside the configured supported range,
    // or one recorded as bad, is refused before any execution. A rollback point
    // (last-known-good) is surfaced so the user can make an informed decision.
    if (!isVersionAllowed(meta.id, meta.version)) {
      recordPluginEvent(meta.id, 'version-refused', `version ${meta.version} is not allowed`, { version: meta.version })
      const point = rollbackPoint(meta.id)
      const refused = governanceRefusal(
        meta.id,
        'version-refused',
        `Plugin "${meta.name}" version ${meta.version} is outside the supported range or is a known-bad version.`,
        point
          ? `Roll back to ${point.version} (BEST-EFFORT: it still must pass the digest/trust gate) or update the plugin.`
          : 'Update the plugin to a supported version, or remove it.',
      )
      notifyError(describePluginError(refused))
      continue
    }

    // GATE 1 — permission consent BEFORE any execution. Only capabilities
    // declared in the manifest are known pre-import; those are the trust
    // contract. A denial here means the module is never imported.
    const preManifest = { permissions: meta.permissions } as PluginDefinition
    if (!(await askPluginPermission(meta, preManifest, vault))) {
      const declared = collectPluginPermissions(meta, preManifest)
      recordPluginEvent(meta.id, 'permission-denied', `declared permissions: ${declared.join(', ') || 'none'}`, { version: meta.version })
      notifyError(
        describePluginError(
          createPluginError('PLUGIN_PERMISSION_DENIED', {
            pluginId: meta.id,
            message:
              declared.length > 0
                ? `Plugin "${meta.name}" requires permission(s): ${declared.join(', ')} but consent was not granted.`
                : t('plugin.permissionSkipped', { name: meta.name }),
            // A denial is cached for the session (see the permission verdicts in
            // ./permissions), so reloading the vault cannot re-ask — only a
            // restart starts a session where the plugin is asked about again.
            recovery: 'Restart NekoWrite to be asked again (a denial is remembered for this session), or remove the plugin.',
          }),
        ),
      )
      continue
    }

    // GATE 1.5 — trust / source authenticity BEFORE any execution. An invalid
    // signature is refused outright (never imported); an unsigned plugin is
    // never silently trusted — it is flagged as unsigned/untrusted-source, or,
    // under the strict policy, must be explicitly trusted (allowlist/decider).
    const trust = await decidePluginTrust(meta, p.signature, p.signaturePayload)
    if (trust.action === 'deny') {
      if (trust.error.code === 'PLUGIN_SIGNATURE_INVALID') {
        recordPluginEvent(meta.id, 'signature-invalid', trust.error.message, { version: meta.version, sanitize: true })
      } else if (trust.error.code === 'PLUGIN_UNSIGNED_UNTRUSTED') {
        recordPluginEvent(meta.id, 'import-refused', 'unsigned and not from a trusted source', { version: meta.version })
      }
      notifyError(describePluginError(trust.error))
      continue
    }

    // GATE 2 — integrity BEFORE any execution. Refuse to silently run a plugin
    // whose code/manifest changed since it was approved. First approval records
    // the baseline; a mismatch is surfaced (re-approve/deny) instead of auto-run.
    let baseline: { id: string; version: string; digest: string } | null = null
    const digest = p.digest
    if (digest) {
      const verdict = verifyPluginIntegrity(meta.id, digest, integrityStore)
      if (verdict === 'mismatch') {
        const expected = getRecordedDigest(vault, meta.id)
        const reapprove = await askReapproveIntegrity(meta, expected ?? '', digest)
        if (!reapprove) {
          recordPluginEvent(meta.id, 'verify-failed', 'code/manifest changed since approval; refused', { version: meta.version })
          notifyError(
            describePluginError(
              createPluginError('PLUGIN_VERIFY_FAILED', {
                pluginId: meta.id,
                message: `Plugin "${meta.name}"'s code or manifest changed since you approved it; refusing to run it.`,
                recovery: 'Re-approve it only if you trust the new version, or reinstall the plugin.',
              }),
            ),
          )
          continue
        }
        // Re-approved: adopt the new fingerprint as the baseline after import succeeds.
        baseline = { id: meta.id, version: meta.version, digest }
      } else if (verdict === 'missing') {
        // First approval in this store: record the baseline fingerprint after import succeeds.
        baseline = { id: meta.id, version: meta.version, digest }
      }
    }

    // GATE 3 — the import (LAST action before activation). Only reached after
    // consent + integrity pass, so a tampered/unapproved plugin's top-level
    // module code never executes.
    const importer: DynamicImport = () => importSource(source)
    let loadResult: LoadResult
    try {
      loadResult = await loadPlugin(meta, importer)
    } catch (e) {
      // loadPlugin normally swallows load errors into an ok:false result, but a
      // dynamic-import rejection can still escape — classify it the same way
      // instead of bubbling and aborting the whole scan.
      notifyError(describePluginError(loadFailure(meta, e instanceof Error ? e.message : String(e))))
      continue
    }
    if (!loadResult.ok) {
      notifyError(describePluginError(loadFailure(meta, loadResult.error)))
      continue
    }
    const definition = loadResult.definition

    // The gated import ran (plugin code executed). Record the loaded version +
    // digest and the load audit event so the governance policy can reason about
    // future loads (version range, rollback, revocation).
    recordPluginVersion(meta.id, meta.version, digest)
    recordPluginEvent(meta.id, 'load', 'loaded', { version: meta.version })
    scheduleGovernanceSave()
    void flushAuditLogToFile()

    // GATE 3.5 — everything that can only be judged now that the plugin's code
    // has run: a code-level capability declaration is consent-checked again, the
    // declared set is asserted at the point of use, and a non-isolated
    // capability is surfaced. See ./vault-plugin-postimport for what each does
    // and why; this loop owns only the order.
    if (!(await applyPostImportGates({ meta, definition, vault, baseline }))) continue

    p.loadResult = loadResult
    consented.push(p)
  }

  // Phase 3 — activation of the consented plugins (./vaultPluginActivate owns
  // the host call, the failure mapping and the active-set bookkeeping). Nothing
  // may be activated under a superseded claim: another vault's load has already
  // installed its own set, and this one's would land on top of it with nothing
  // left to take it down again.
  if (claim !== getVaultPluginClaim()) return
  await activateVaultPlugins(consented)

  // Flush the audit log to its file (best-effort) so the activate/deactivate/
  // crash decisions recorded during this scan reach the persisted file, reflecting
  // the full load + activation cycle rather than only the initial loads.
  void flushAuditLogToFile()
}
