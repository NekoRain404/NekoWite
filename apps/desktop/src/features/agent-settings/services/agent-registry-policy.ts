/**
 * The registry settings page's rules: what an add form may submit, what a refusal means, and what
 * the page may say and do about where an engine came from.
 *
 * A pure module — no IPC, no storage, no DOM, no Vue. `R/src/agent_runtime/registry.rs` is the
 * authority (§3.4: 「后端是权威来源」), and this file never has the last word: it mirrors the
 * backend's answers so a form can point at the field that is wrong before a round trip, and so a
 * refusal the backend *did* return is said rather than shown as "failed". The backend validates
 * again on the way in (`register`, `set_enabled`) and again at `start`, because a definition can
 * be edited and the machine can change under it.
 *
 * Mirrored, not re-decided: every arm of {@link RegistryRefusal} is one arm of Rust's
 * `RegistryError` with the same facts, and this module adds no rule the backend does not have.
 * What it adds is *placement* (which form field a refusal belongs to) and the shape the page
 * renders. Where a name differs it is because the two sides are different things: Rust's `Id`
 * carries a `&'static str` field name, this one carries the form field, because the sentence a
 * user reads is about an input box.
 *
 * 不擅自更新 is surfaced here, not decided here. `InstallSource::update_policy` is a method in Rust
 * precisely so an external registration cannot claim a host-managed policy (registry.rs), and
 * {@link updateStanding} is that method's answer reaching the page: NekoWite may replace a bundled
 * or managed program, and may only *report* a version for one the user installed. Nothing in this
 * module — or in the page that reads it — performs an update; version and path selection are
 * `binary_registry`/`update` (T14), and the settings page's part is to say which of the two
 * applies.
 *
 * Redaction is a second lock, not the lock. The backend already scrubs `env_extra` on the way out
 * (`registry.rs`'s `redacted_env`), and {@link readEnvForDisplay} repeats the same rule by name so
 * a value that reached the renderer by any other path still cannot be printed. The suffix list is
 * ported verbatim, and the direction of a mistake matters: a list that is too *wide* masks a
 * variable called `MONKEY`, and one that is too narrow prints a credential.
 */

import type { AgentFailureCode } from '../../../platform/gateways/agent-contracts'

/** The value a credential is replaced by, in both implementations. */
export const REDACTED_ENV_VALUE = '<redacted>'

/**
 * Rust's `MAX_ID_BYTES`, in JS string units rather than bytes.
 *
 * The two agree everywhere it can matter: an id that passes the charset below is ASCII, so its
 * length is its byte count — and an id that fails it is refused as an id either way, so a
 * multi-byte value longer in bytes than in units is already the answer it would have got.
 */
const MAX_ID_BYTES = 64

/** Rust's `validate_id` charset: what can be an identity *and* a directory name (§3.2). */
const ID_CHARS = /^[A-Za-z0-9._-]+$/

/**
 * Rust's `is_credential_name` suffixes, upper-cased before the comparison.
 *
 * `anthropic_api_key` and `ANTHROPIC_API_KEY` are the same variable to the kernel while only one
 * is the conventional spelling, and under-redacting is the dangerous direction.
 */
const CREDENTIAL_SUFFIXES = ['KEY', 'TOKEN', 'PASSWORD', 'SECRET', 'PASS', 'CREDENTIALS', 'LICENSE']

/** Where a registration's program came from (§3.4's install-source row). */
export type InstallSource = 'bundled' | 'managed' | 'external'

/**
 * What a registration's program path is, as of the moment the backend was asked.
 *
 * Five states, not a boolean, because the user's next move differs for each: a relative path is
 * a typo in the form, a vanished file means their installation moved, and a file without an
 * executable bit is a `chmod` away. `launchable` claims launchability and nothing else (§3.4.4:
 * 注册不等于沙箱 — a file existed and was executable when it was checked).
 */
export type ProgramState =
  | 'launchable'
  | 'not-absolute'
  | 'missing'
  | 'not-a-file'
  | 'not-executable'

/** What an engine's environment is built from (registry.rs's `EnvPolicy`). */
export type EnvPolicy = 'profile-isolated' | 'user-environment'

/**
 * Who may replace a program, decided by where it came from.
 *
 * The two values are `InstallSource::update_policy`'s, and the page renders one sentence per
 * value — there is no third "ask the user" state, because a host that may not replace a program
 * has nothing to ask permission for.
 */
export type UpdatePolicy = 'host-managed' | 'reported-only'

/** One registration, as the settings page receives it — §3.4's first row, field for field. */
export interface AgentRegistryEntry {
  agentId: string
  displayName: string
  source: InstallSource
  /** The executable. Never a command line: §3.4.3 forbids concatenating one. */
  program: string
  /** The arguments, in order. A space inside one belongs to it and is never a separator. */
  args: readonly string[]
  env: EnvPolicy
  /**
   * Variables this registration adds on top of the policy.
   *
   * `value` arrives already scrubbed by the backend; the page masks it again anyway
   * ({@link readEnvForDisplay}) so a bug on either side is not a printed credential.
   */
  envExtra: readonly { name: string; value: string }[]
  enabled: boolean
  /** The adapter that owns this engine's differences, validated against `adapters::lookup`. */
  adapterId: string
  /**
   * As the last diagnostic reported it. Reported, and nothing else: nothing turns this into a
   * download, a swap, or an "update available" that acts.
   */
  reportedVersion: string | null
  programState: ProgramState
}

/** Everything the page reads, in one answer. */
export interface AgentRegistryReadout {
  /** §3.4.1: the fixed engine a new session starts on. Not a preference, so it has no setter. */
  defaultAgentId: string
  /** Every definition, in id order (the backend's `BTreeMap` order). */
  entries: readonly AgentRegistryEntry[]
  /**
   * The adapter ids the backend answers to — `adapters::lookup`'s answer, not a list of engine
   * names maintained here (§3.4 forbids a component branching on an engine).
   */
  adapterIds: readonly string[]
  /**
   * The agents with a live runtime instance.
   *
   * Ids rather than epochs: an epoch is this host's incarnation token (§6.1) and belongs in a
   * runtime-status surface, not in a row a user reads. The id is what the refusal is about.
   */
  runningAgentIds: readonly string[]
  /** Which agent each profile belongs to (§3.4's Profile row). */
  profileOwners: Readonly<Record<string, string>>
}

/**
 * What the page calls. Implemented by whichever adapter sits behind it (T4 wires the real one),
 * and it is what E4 substitutes a fake for.
 *
 * Two answers share one shape deliberately: a *rejection* means the call did not complete (the
 * IPC failed, the runtime is gone) and the page says so; a *refusal* means it completed and the
 * backend said no, with the reason as data. Collapsing the two would put "the engine refused this
 * path" and "this page could not reach the backend" behind one sentence.
 *
 * There is no `update`, no `remove` and no `install`: replacing a program is T14's, and this page
 * may not offer what it cannot do. `add` takes a draft with no `source` field — a registration the
 * form creates is `external` by construction, because a user's own program is not the host's to
 * manage and the draft has no way to claim otherwise.
 */
export interface AgentRegistryClient {
  read(): Promise<AgentRegistryReadout>
  /** `null` when the registration was accepted. */
  add(draft: AgentDraft): Promise<RegistryRefusal | null>
  /** `null` when the change was applied. */
  setEnabled(agentId: string, enabled: boolean): Promise<RegistryRefusal | null>
}

/**
 * What the add form builds.
 *
 * A registration's `env_extra` is deliberately not here: the plan's add flow is 「添加本地可执行
 * 文件、启动参数、配置来源」 (§3.4.3), and the environment an engine needs is configuration, which
 * §3.4.5 leaves with the engine and its own tooling. A field this page cannot fill is a rule it
 * could not enforce — and the *display* half of the rule still holds: a registration that already
 * carries variables is shown through {@link readEnvForDisplay}, masked.
 */
export interface AgentDraft {
  agentId: string
  displayName: string
  /** An absolute path; whether anything is at it is the backend's to say. */
  program: string
  args: readonly string[]
  adapterId: string
}

/** The form fields a refusal can be shown under. */
export type DraftField = 'agentId' | 'displayName' | 'program' | 'args' | 'adapterId'

/**
 * Why a registration, a start or a change was refused — Rust's `RegistryError`, arm for arm.
 *
 * Data only, exactly as it is on the Rust side: the wording a user reads is the page's (see
 * `AgentRegistrySettings.vue`), and this is what that wording is keyed by. `launch-failed` is the
 * one arm that carries words instead of only facts, and it has to: the engine's own message about
 * its own failure is the useful half, and the certificate case is *reworded* by
 * `TransportError::failure_message` — a rewording P0 §2.4 requires and this layer must pass
 * through rather than invent a second time.
 */
export type RegistryRefusal =
  | { kind: 'id'; field: string; value: string }
  | { kind: 'program'; path: string; state: ProgramState }
  | { kind: 'argument'; index: number }
  | { kind: 'environment'; name: string }
  | { kind: 'unknown-adapter'; adapterId: string }
  | { kind: 'duplicate-agent'; agentId: string }
  | { kind: 'unknown-agent'; agentId: string }
  | { kind: 'profile-unbound'; profileId: string; agentId: string; owner: string | null }
  | { kind: 'disabled'; agentId: string }
  | { kind: 'already-running'; agentId: string }
  | { kind: 'instance-running'; agentId: string }
  | { kind: 'is-default'; agentId: string }
  | { kind: 'launch-failed'; agentId: string; code: AgentFailureCode; message: string }

/** Every kind above, so a copy tree can be required to have one sentence per arm. */
export type RegistryRefusalKind = RegistryRefusal['kind']

/**
 * Everything about a draft that can be judged without the machine, in the order Rust judges it
 * (`AgentRegistration::validate`, then `register`'s duplicate check).
 *
 * Whether the program is *there* is deliberately absent: that is a state of the filesystem
 * (`program_state`), not a property of a definition, and a form that guessed would refuse a
 * sidecar that has not been built yet — a state registry.rs says is normal to report.
 */
export function validateAgentDraft(
  draft: AgentDraft,
  context: { adapterIds: readonly string[]; entries: readonly AgentRegistryEntry[] },
): RegistryRefusal[] {
  const refusals: RegistryRefusal[] = []
  if (!isUsableId(draft.agentId)) {
    refusals.push({ kind: 'id', field: 'agent_id', value: draft.agentId })
  }
  // A path that could never work is a definition error, and saying so at the form is the
  // difference between "fix this path" and "your file vanished" — `Path::is_absolute` is
  // `/`-prefixed on the one platform this app ships for.
  if (!draft.program.startsWith('/')) {
    refusals.push({ kind: 'program', path: draft.program, state: 'not-absolute' })
  }
  // The whole of argument validation: §3.4.3 keeps the path and the array separate all the way to
  // `execve`, so an argument containing spaces has no path that could split it — what is left to
  // refuse is the NUL byte, and the position is what a form points at.
  const nul = draft.args.findIndex((arg) => arg.includes('\0'))
  if (nul >= 0) refusals.push({ kind: 'argument', index: nul })
  if (!context.adapterIds.includes(draft.adapterId)) {
    refusals.push({ kind: 'unknown-adapter', adapterId: draft.adapterId })
  }
  // Kept apart from the rest because it is not a property of the draft: an id is free until it is
  // taken, and this is the readout saying it is. Still a courtesy — the backend refuses a
  // duplicate itself, and a readout that is a second stale cannot be what decides it.
  if (context.entries.some((entry) => entry.agentId === draft.agentId)) {
    refusals.push({ kind: 'duplicate-agent', agentId: draft.agentId })
  }
  return refusals
}

/** Which input a refusal belongs under, or `null` when it is about the action rather than a field. */
export function refusedField(refusal: RegistryRefusal): DraftField | null {
  switch (refusal.kind) {
    case 'id':
    case 'duplicate-agent':
      return 'agentId'
    case 'program':
      return 'program'
    case 'argument':
      return 'args'
    case 'unknown-adapter':
      return 'adapterId'
    // Not a field the user got wrong: these are about the registration as a whole (it is the
    // default, an engine is live on it, the profile belongs elsewhere) or about starting it.
    case 'environment':
    case 'profile-unbound':
    case 'disabled':
    case 'already-running':
    case 'instance-running':
    case 'is-default':
    case 'unknown-agent':
    case 'launch-failed':
      return null
  }
}

/** The form an environment block may be printed in: credentials masked, everything else kept. */
export function readEnvForDisplay(
  env: readonly { name: string; value: string }[],
): { name: string; value: string }[] {
  return env.map((variable) => ({
    name: variable.name,
    value: isCredentialName(variable.name) ? REDACTED_ENV_VALUE : variable.value,
  }))
}

/**
 * §3.4.6 and §3.1.4: 「高级用户可选择系统 CLI；此模式只检测兼容性，不擅自升级或替换用户安装」.
 *
 * The page's part is to *say* which of the two applies; it has no second opinion to offer, and no
 * update for an external program to offer either.
 */
export function updateStanding(source: InstallSource): UpdatePolicy {
  return source === 'external' ? 'reported-only' : 'host-managed'
}

/** Whether a registration may be switched off, or the refusal saying why not. */
export type DisableStanding = { allowed: true } | { allowed: false; refusal: RegistryRefusal }

/**
 * The preconditions `AgentRegistry::set_enabled(id, false)` applies, so the page does not offer a
 * control that can only fail.
 *
 * Switching *on* has no precondition, and the function is total over that direction too: a
 * registration that is already off has nothing to handle before it is switched back on, so the
 * answer is `allowed` whatever the readout says about it. The backend still decides both — this is
 * the same rule asked twice, not a decision taken away from it.
 */
export function disableStanding(
  entry: AgentRegistryEntry,
  readout: AgentRegistryReadout,
): DisableStanding {
  if (!entry.enabled) return { allowed: true }
  // §3.4.1 makes the default the fixed answer for a new session; disabling it would leave the
  // new-session list with nothing to preselect.
  if (entry.agentId === readout.defaultAgentId) {
    return { allowed: false, refusal: { kind: 'is-default', agentId: entry.agentId } }
  }
  // §3.4.7: an active task is handled first. A run mid-write does not stop being mid-write because
  // a settings form was submitted.
  if (readout.runningAgentIds.includes(entry.agentId)) {
    return { allowed: false, refusal: { kind: 'instance-running', agentId: entry.agentId } }
  }
  return { allowed: true }
}

/**
 * What choosing an engine means for the session that is open.
 *
 * §3.4.2: 「切换引擎创建新会话；旧会话保留所属引擎、授权与历史」. A session is bound to the engine that
 * opened it, so there is no arm here that re-points one — the answer is `new-session` or the
 * session stays, and the caller opens the new one through the gateway it already has (this page
 * never opens sessions, and never reaches into the panel's feature).
 */
export type EngineSwitchPlan =
  | { kind: 'keep-session'; agentId: string }
  | { kind: 'new-session'; agentId: string; profileId: string }
  | { kind: 'refused'; refusal: RegistryRefusal }

/**
 * Plan a switch, refusing exactly what `AgentRegistry::start` refuses about identity.
 *
 * The order is `start`'s: the agent exists, the profile belongs to it, it is switched on. Whether
 * the *program* can be launched is not asked here — it is a state of the machine (the row reports
 * it, and the refusal a start returns names it), and a stale readout must not be what stands
 * between a user and a session.
 */
export function planEngineSwitch(request: {
  /** The engine the open session is on, or `null` when no session is open. */
  sessionAgentId: string | null
  /** The engine chosen for the next session. */
  agentId: string
  /** The profile a new session would use (T12's choice; this page only reads the binding). */
  profileId: string
  readout: AgentRegistryReadout
}): EngineSwitchPlan {
  const { agentId, profileId, readout } = request
  const entry = readout.entries.find((candidate) => candidate.agentId === agentId)
  if (entry === undefined) {
    return { kind: 'refused', refusal: { kind: 'unknown-agent', agentId } }
  }
  // §3.4's Profile row: credentials, model ids and configuration files are not copied between
  // engines, so a profile belonging to another one is a request for that engine's credentials. The
  // owner is named because "it is taken" and "it is taken by *that* engine" are different answers.
  const owner = readout.profileOwners[profileId]
  if (owner !== undefined && owner !== agentId) {
    return { kind: 'refused', refusal: { kind: 'profile-unbound', profileId, agentId, owner } }
  }
  if (!entry.enabled) {
    return { kind: 'refused', refusal: { kind: 'disabled', agentId } }
  }
  if (request.sessionAgentId === agentId) {
    return { kind: 'keep-session', agentId }
  }
  return { kind: 'new-session', agentId, profileId }
}

/**
 * Substitute `{name}` slots in a sentence.
 *
 * A slot with no matching fact is left *visible* rather than emptied: this page's whole job is to
 * not say things it cannot back, and a sentence with a hole in it is a bug someone can see, while
 * a sentence with a word missing reads as finished.
 */
export function fillTemplate(template: string, facts: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (slot, name: string) => facts[name] ?? slot)
}

/** Rust's `validate_id`, on this side of the boundary. */
function isUsableId(value: string): boolean {
  return (
    value !== '' &&
    value.length <= MAX_ID_BYTES &&
    value !== '.' &&
    value !== '..' &&
    !value.startsWith('.') &&
    ID_CHARS.test(value)
  )
}

/** Rust's `is_credential_name`. */
function isCredentialName(name: string): boolean {
  const upper = name.toUpperCase()
  return CREDENTIAL_SUFFIXES.some((suffix) => upper.endsWith(suffix))
}
