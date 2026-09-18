/**
 * V10 — what the profile page decides before anything is written.
 *
 * §10.2's T12 row asks for 配置隔离证据、JSONC 保留、并发冲突、凭据脱敏, and the half of each that is
 * *a rule rather than a drawing* has to be decided somewhere the drawing cannot argue with. That is
 * this module, and `agent-config-edit-policy.ts` beside it, where the two of the four that are about
 * the engine's configuration *document* were moved: JSONC 保留 and the document's half of 并发冲突.
 * The split is a change to where a rule lives and not to a name a caller imports — everything that
 * moved is re-exported at the foot of this file — and it follows the two counterparts in Rust:
 * `R/src/agent_runtime/profile.rs` decides this half for the file itself and
 * `R/src/agent_runtime/config_edit.rs` the other, because §5.3's 「界面和后端使用同一规则」 only holds
 * if both sides compute it the same way rather than agreeing until the day they do not.
 *
 * What is decided here, and the failure each one is:
 *
 *  - **配置隔离.** A readout belongs to one (agentId, profileId) pair. The page is handed one and
 *    says which pair it is for; rendering it under another engine's heading is how one engine's
 *    provider, model id or credential names end up looking like another's, so
 *    {@link profileProblem} refuses the mismatch instead of trusting the caller's ordering.
 *  - **并发冲突.** {@link decideProfileWrite} is the revision rule
 *    `platform/gateways/memory-pet/settings.ts` states — the same rule `decideConfigWrite` applies
 *    to a document, spelled the same way in the file beside this one because the two shapes have no
 *    field in common: a write built on a revision that has moved is refused and the caller reloads.
 *    It is never merged, and there is no "force" arm for a page to reach for, because a merge is how
 *    a value the user changed elsewhere gets undone.
 *  - **凭据脱敏.** Credentials are write-only. The page renders a name and a placeholder
 *    ({@link credentialRows}), and a submission carries only what the user actually typed
 *    ({@link credentialSubmission}); a form resubmitted untouched submits nothing, which is what
 *    stops the placeholder itself from being stored as a key.
 *
 * Nothing here reads storage, reaches IPC or knows a window: given what the backend said and what
 * the form holds, it answers, and the caller does the writing. The readout type below is the shape
 * `commands/agent_settings.rs` answers with; when T4 lands the IPC contract it belongs in
 * `platform/gateways/agent-contracts.ts`, and this module should then import it rather than
 * declare it.
 */

/** §8.1's two modes. The strings are the backend's (`ConfigMode::id`), not a page's invention. */
export type ConfigMode = 'app-managed' | 'user-config'

export const CONFIG_MODES: readonly ConfigMode[] = ['app-managed', 'user-config']

/**
 * One merge the engine makes that this app does not set, as `profile.rs`'s `DiscoverySurface`
 * serializes it.
 *
 * A key rather than a sentence, so the page's own copy is where the wording lives and a translator
 * never sees a path or a switch name. `reused` is the profile that narrows nothing; `project` is
 * the folder a session runs in as well as every folder above it, and `managed` is the machine's
 * `/etc/opencode`.
 */
export type DiscoverySurface = 'reused' | 'project' | 'managed'

export const DISCOVERY_SURFACES: readonly DiscoverySurface[] = ['reused', 'project', 'managed']

/** One configuration source, as `profile.rs` reports it — including what it does *not* control. */
export type ConfigSourceView =
  | { kind: 'injected'; variable: string; path: string }
  | { kind: 'engine-discovery'; what: DiscoverySurface }

/** A credential as the backend reports it: a name, and never a value. */
export interface CredentialView {
  name: string
  value: string
}

/**
 * Where the credentials are, stated rather than implied (§8.1: 不宣称已经使用系统钥匙串或加密).
 * The two flags are literals so a page cannot render a promise this app does not make.
 */
export type CredentialStorageView =
  | { kind: 'host-file'; path: string; mode: string; encrypted: false; keychain: false }
  | { kind: 'none' }

/** The profile as the settings page reads it. */
export interface AgentProfileReadout {
  profileId: string
  agentId: string
  mode: ConfigMode
  root: string
  revision: string
  provider: string | null
  modelId: string | null
  editable: boolean
  sources: ConfigSourceView[]
  credentials: CredentialView[]
  credentialStorage: CredentialStorageView
  permissions: PermissionView
  /**
   * The engine's own configuration document, as the editor opens it: a path relative to
   * {@link root}, or `null` where this host owns no such file.
   *
   * Relative, and that is the backend's choice rather than this file's: `agent_config_document`
   * confines every read to the profile root, and the relative spelling is the one that check takes.
   * `null` is not "there is no configuration" — it is `user-config`, the mode where the engine
   * reads the user's own installation and this app writes nothing there. The two are different
   * sentences and the page draws them differently.
   */
  configDocument: string | null
}

/**
 * What this app does about permissions for this profile — §8.1's 「列出实际生效源」 for the one
 * setting this host writes into an engine of its own.
 *
 * `state` is the whole point of the type, and it is three ids rather than a boolean because the
 * third is a real and unprotected one: `not-this-host` is a profile that reuses the user's own
 * installation, where this app wrote no rules and cannot say what the engine will ask. `rules` is
 * what this app ships — a fact about this app, not about the file — and `state` is what says
 * whether those are the ones in force.
 */
export interface PermissionView {
  state: PermissionState
  /** Where the rules live, or `null` when this host may not write there. */
  document: string | null
  rules: PermissionRuleView[]
}

export type PermissionState = 'written' | 'engine-own' | 'not-this-host'

export const PERMISSION_STATES: readonly PermissionState[] = [
  'written',
  'engine-own',
  'not-this-host',
]

/** One rule, in the engine's own vocabulary: its tool name and its action for it. */
export interface PermissionRuleView {
  tool: string
  action: string
}

/** The four option kinds the engine may offer with a request (ACP v1). */
export type PermissionOptionKind =
  | 'allow_once'
  | 'allow_always'
  | 'reject_once'
  | 'reject_always'

export const PERMISSION_OPTION_KINDS: readonly PermissionOptionKind[] = [
  'allow_once',
  'allow_always',
  'reject_once',
  'reject_always',
]

/** The value the page shows where a credential would be. */
export const REDACTED_CREDENTIAL = '<redacted>'

/** The three fields a form may submit, which is every editable member of the record. */
export interface ProfileFields {
  mode: ConfigMode
  provider: string | null
  modelId: string | null
}

export interface ProfileWrite {
  agentId: string
  profileId: string
  /** The revision the form was built from — the token a conflict is decided on. */
  revision: string
  fields: ProfileFields
}

export type ProfileUpdate =
  | { status: 'applied'; fields: ProfileFields }
  /** Someone else's write landed first. Render `current` and rebuild the form from it. */
  | { status: 'conflict'; current: AgentProfileReadout }
  | { status: 'refused'; reason: ProfileRefusal; message: string }

export type ProfileRefusal =
  | 'wrong-profile'
  | 'not-editable'
  | 'mode-unusable'
  | 'field-unusable'

/**
 * Whether this readout is the pair the page thinks it is showing, and why not when it is not.
 *
 * The check is not ceremony: a page that switched engines, or reused a cached readout, would
 * otherwise render one engine's provider and credential names under another engine's heading —
 * exactly the confusion §3.4's Profile row exists to prevent, arrived at from the UI side.
 */
export function profileProblem(
  readout: AgentProfileReadout,
  agentId: string,
  profileId: string,
): ProfileRefusal | null {
  return readout.agentId === agentId && readout.profileId === profileId ? null : 'wrong-profile'
}

/** The sentence a refusal is rendered with — structure first, wording here. */
export function profileRefusalMessage(reason: ProfileRefusal): string {
  switch (reason) {
    case 'wrong-profile':
      return 'This profile belongs to another engine. Nothing here can be shown under this one.'
    case 'not-editable':
      return 'This profile reuses your own configuration, so settings reads it and writes nothing.'
    case 'mode-unusable':
      return 'That configuration mode is not one this build knows.'
    case 'field-unusable':
      return 'A provider or model name cannot be empty or contain a control character.'
  }
}

/**
 * §8.1's mode switch, as the plan a page renders.
 *
 * What the plan deliberately cannot contain is a file operation. 「切换模式不自动移动或覆盖旧文件」 is
 * the requirement, and the way to keep it is for the vocabulary of this function to have no word
 * for moving one: `changes` describes what the *host* will do from then on, and
 * {@link ModeSwitchPlan.touchesExistingFiles} is false by construction rather than by promise.
 */
export interface ModeSwitchPlan {
  from: ConfigMode
  to: ConfigMode
  changes: ModeChange[]
  touchesExistingFiles: false
}

export type ModeChange =
  | 'roots-are-injected'
  | 'roots-are-the-users'
  | 'host-starts-writing'
  | 'host-stops-writing'
  | 'credentials-move-to-the-engine'

export function planModeSwitch(from: ConfigMode, to: ConfigMode): ModeSwitchPlan {
  if (from === to) {
    return { from, to, changes: [], touchesExistingFiles: false }
  }
  return {
    from,
    to,
    changes:
      to === 'app-managed'
        ? ['roots-are-injected', 'host-starts-writing', 'credentials-move-to-the-engine']
        : ['roots-are-the-users', 'host-stops-writing'],
    touchesExistingFiles: false,
  }
}

/** Builds the write a form submits, from the readout it was built from. */
export function profileWrite(readout: AgentProfileReadout, fields: ProfileFields): ProfileWrite {
  return {
    agentId: readout.agentId,
    profileId: readout.profileId,
    revision: readout.revision,
    fields,
  }
}

/**
 * Whether one submitted record write may be applied.
 *
 * The order of the arms is the order of what a caller must do about them:
 *
 *  1. a write for another pair is refused first — the identity is the prerequisite of every other
 *     judgement, and a mismatch means the form and the readout were assembled wrong;
 *  2. a profile this host does not write is refused whole (§8.1's reuse mode);
 *  3. a revision that has moved is a **conflict**, and the answer carries the readout to reload
 *     from. A revision *ahead* of the readout is refused the same way: a page cannot skip the
 *     counter, or it would win every later conflict by asserting a token nobody issued;
 *  4. an unusable field is refused last, because a fallback written for the user would report
 *     success for a save that changed their setting to something they did not choose.
 */
export function decideProfileWrite(
  readout: AgentProfileReadout,
  write: ProfileWrite,
): ProfileUpdate {
  if (write.agentId !== readout.agentId || write.profileId !== readout.profileId) {
    return {
      status: 'refused',
      reason: 'wrong-profile',
      message: profileRefusalMessage('wrong-profile'),
    }
  }
  if (!readout.editable) {
    return {
      status: 'refused',
      reason: 'not-editable',
      message: profileRefusalMessage('not-editable'),
    }
  }
  if (write.revision !== readout.revision) {
    return { status: 'conflict', current: readout }
  }
  if (!CONFIG_MODES.includes(write.fields.mode)) {
    return {
      status: 'refused',
      reason: 'mode-unusable',
      message: profileRefusalMessage('mode-unusable'),
    }
  }
  if (!isUsableName(write.fields.provider) || !isUsableName(write.fields.modelId)) {
    return {
      status: 'refused',
      reason: 'field-unusable',
      message: profileRefusalMessage('field-unusable'),
    }
  }
  return { status: 'applied', fields: write.fields }
}

/**
 * A name a document, a diagnostic and an environment variable can all carry.
 *
 * `null` is "nothing chosen yet" and is usable; a blank or control-bearing string is what an
 * unfinished form and a paste from a terminal produce, and neither is a provider id. The backend
 * refuses the same shape (`ProfileFields::validate`), so a form that passed this reaches a refusal
 * there rather than a value in a config file.
 */
function isUsableName(value: string | null): boolean {
  if (value === null) return true
  const trimmed = value.trim()
  if (trimmed === '') return false
  return !Array.from(trimmed).some((character) => {
    const code = character.codePointAt(0) ?? 0
    return code < 0x20 || code === 0x7f
  })
}

/**
 * The credential rows the page may render: names, and the placeholder in every value.
 *
 * The value from the readout is *replaced* rather than passed through. The backend does not send
 * values — that is the point of `profile.rs`'s `Secret` — and a page that rendered whatever arrived
 * would be a second place the rule has to hold, which is one place too many for §8.1's
 * 「密钥不进入消息、日志或 localStorage」.
 */
export function credentialRows(
  readout: AgentProfileReadout,
): { name: string; value: string }[] {
  return readout.credentials.map((entry) => ({
    name: entry.name,
    value: entry.value === '' ? '' : REDACTED_CREDENTIAL,
  }))
}

/**
 * The form's fields, one per credential the readout names, all of them untouched.
 *
 * `draft: null` for every one, which is what {@link credentialSubmission} reads as "the user did
 * not touch this" — so a form opened and saved without an edit sends an empty patch rather than
 * re-submitting the placeholder as the value. That is why the draft is nullable rather than an
 * empty string: `""` is a value the user typed, and it means *clear the credential*.
 *
 * The set of names is the backend's, not this page's. Which credentials an engine needs is the
 * adapter's answer (§3.4.5), so the form renders the ones the readout carries and invents none —
 * a page that offered a fixed list would be recommending names for an engine it does not know.
 */
export function credentialFields(readout: AgentProfileReadout): CredentialField[] {
  return readout.credentials.map((entry) => ({
    name: entry.name,
    display: entry.value === '' ? '' : REDACTED_CREDENTIAL,
    draft: null,
  }))
}

/** What one credential field of the form holds. */
export interface CredentialField {
  name: string
  /** What the page is showing: the placeholder, or nothing when no credential is stored. */
  display: string
  /** What the user typed, if they typed anything. */
  draft: string | null
}

export type CredentialSubmission =
  | { kind: 'unchanged' }
  | { kind: 'set'; value: string }
  | { kind: 'clear' }
  | { kind: 'refused'; message: string }

/**
 * What one credential field submits.
 *
 * The rule that matters is the second arm's guard: a form that was submitted without the user
 * touching the field is `unchanged` and sends nothing, and a draft that *is* the placeholder is
 * refused rather than accepted. Without both, the page's own display value becomes the credential
 * — the key is replaced by the string `<redacted>`, the provider stops authenticating, and the
 * failure shows up as an authentication error much later than the save that caused it.
 */
export function credentialSubmission(field: CredentialField): CredentialSubmission {
  if (field.draft === null) {
    return { kind: 'unchanged' }
  }
  const draft = field.draft.trim()
  if (draft === REDACTED_CREDENTIAL) {
    return {
      kind: 'refused',
      message:
        'That is the value this page shows in place of a key, not a key. Type the new value, or ' +
        'leave the field alone to keep the one that is stored.',
    }
  }
  if (draft === '') {
    return { kind: 'clear' }
  }
  // Surrounding whitespace is a copy-paste artefact from a browser or a terminal, and a key that
  // carries one fails to authenticate in a way that reads as "wrong key".
  return { kind: 'set', value: draft }
}

/**
 * One change to the credential set, as the backend's `CredentialSubmission` takes it.
 *
 * Tagged, and a *patch* rather than a whole set: the page shows names and the placeholder, so a
 * form that edits one credential cannot resubmit the others. A surface that took a whole set would
 * delete every credential the form did not mention — the user edits one key and the other three
 * disappear, with nothing on screen to say so.
 */
export type CredentialChange =
  | { op: 'set'; name: string; value: string }
  | { op: 'remove'; name: string }

/**
 * The whole submission for a form: only the fields that changed anything.
 *
 * A form whose fields are all `unchanged` submits an empty patch — no request, and no write that
 * would move the set for no reason.
 */
export function credentialWrite(
  fields: CredentialField[],
): { changes: CredentialChange[] } | { refused: string } {
  const changes: CredentialChange[] = []
  for (const field of fields) {
    const submission = credentialSubmission(field)
    switch (submission.kind) {
      case 'unchanged':
        break
      case 'set':
        changes.push({ op: 'set', name: field.name, value: submission.value })
        break
      case 'clear':
        // A cleared field removes the name. Sending an empty value instead would store an empty
        // key, which a provider rejects much later and in a much less obvious way.
        changes.push({ op: 'remove', name: field.name })
        break
      case 'refused':
        return { refused: submission.message }
    }
  }
  return { changes }
}

/**
 * The document half, re-exported so that this module's path keeps every name it had.
 *
 * The callers already name this file: the configuration page and the provider authoring form import
 * the document types and `decideConfigWrite` from it, `agent-config-ipc.ts` and
 * `agent-provider-block.ts` name `ConfigEdit` and `ConfigRead`, and `agent-settings-policy.test.ts`
 * covers both halves through it. The move changes where a rule is written down, not the specifier
 * anyone writes to reach it.
 */
export type {
  ConfigEdit,
  ConfigEditor,
  ConfigRead,
  ConfigRefusal,
  ConfigUpdate,
  ConfigValueParse,
  ConfigWrite,
} from './agent-config-edit-policy'
export {
  configEditor,
  configRefusalMessage,
  decideConfigWrite,
  parseConfigValue,
} from './agent-config-edit-policy'
