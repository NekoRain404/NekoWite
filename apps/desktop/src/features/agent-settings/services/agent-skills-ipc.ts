/**
 * The skills client: the backend's answers, narrowed into the port the settings page calls.
 *
 * The same split `agent-registry-ipc.ts` makes, one page over. The port and its vocabulary —
 * `AgentSkillsClient`, `SkillEntryView`, the two tagged unions the page switches on — live where
 * the page that renders them lives (`components/AgentSkillsSettings.vue`), and this file is the
 * implementation of it that talks to the window's IPC: what arrives is JSON that has to be
 * narrowed, because the wire is `unknown` (`platform` may not name a feature's types, plan §6.1)
 * and a cast would be a promise about a foreign process.
 *
 * **Two failure channels, and the type says which is which.** A *refusal* is this module's return
 * value (`null` = accepted), and a *rejection* is a thrown `Error`. Nothing here turns a refusal
 * into a throw or the other way round, so the page cannot confuse "the backend said no, here is
 * why" with "this page could not reach the backend". The read answers *both* — an arrangement the
 * backend refuses to build a library from (its store lying inside a directory the engine scans) is
 * a refusal, and the page renders it with the same sentence table it renders every other refusal
 * from.
 *
 * **Which profile, and why that is not this file's decision.** Every call carries the pair, and the
 * scope list the backend answers with is built from *that* profile's roots — where its engine's
 * `HOME` and `XDG_CONFIG_HOME` point. So the client is built for one pair, the way the permission
 * and configuration clients are, and a request that named another is refused there rather than
 * answered with directories that belong to somebody else.
 *
 * **Never a value in a message.** What a malformed answer contains is unknown by construction — the
 * whole point of the check that failed — so a thrown message names the *field*, not the value it
 * held. Nothing on this wire carries a credential at all, which is worth saying because a skill's
 * own files do not travel over it either: a preview answers paths and sizes.
 */

import type {
  AgentSkillsClient,
  AgentSkillsReadout,
  SkillDisableView,
  SkillEntryView,
  SkillPreviewView,
  SkillRefusal,
  SkillScopeView,
  SkillSurfaceView,
} from '../components/AgentSkillsSettings.vue'
import type { SkillRefusalKind } from '../components/agent-skills-labels'

/**
 * The window's IPC, as this client uses it: four calls whose answers are not trusted.
 *
 * Structurally the port `platform/gateways/tauri-agent/skills.ts` implements — declared rather than
 * imported, because `platform` may not reach into `features` and this module may not depend on
 * Tauri. The two meet at the composition site, where a method that drifted is a compile error
 * rather than a call that fails at runtime.
 */
export interface AgentSkillsWire {
  read(agentId: string, profileId: string): Promise<unknown>
  preview(agentId: string, profileId: string, source: string): Promise<unknown>
  import(agentId: string, profileId: string, source: string, replace: boolean): Promise<unknown>
  setEnabled(
    agentId: string,
    profileId: string,
    name: string,
    scope: string,
    enabled: boolean,
  ): Promise<unknown>
}

/** The pair this client is about, and the port its calls go through. */
export interface AgentSkillsRequest {
  skills: AgentSkillsWire
  agentId: string
  profileId: string
}

/**
 * The refusal kinds, which are `SkillError`'s arms: one sentence per kind lives in the catalogue
 * (`agent.settings.skills.refusal.*`) and the page's copy record is keyed by this union, so a kind
 * this list does not carry is a refusal the page could say nothing about — which is why an unknown
 * one is refused here rather than passed through with a blank line under it.
 */
const REFUSAL_KINDS: readonly SkillRefusalKind[] = [
  'relative-path',
  'store-inside-scope',
  'unknown-scope',
  'not-managed',
  'no-switch',
  'outside-scope',
  'escapes-scope',
  'missing',
  'no-manifest',
  'symlink',
  'not-a-file',
  'too-many-files',
  'file-too-large',
  'skill-too-large',
  'no-frontmatter',
  'unterminated-frontmatter',
  'frontmatter-line',
  'name-missing',
  'name-shape',
  'name-mismatch',
  'description-missing',
  'description-too-long',
  'field-control',
  'name-taken',
  'no-such-skill',
  'store-occupied',
  'same-directory',
  'scan-too-large',
  'io',
]

const OWNERS = ['managed', 'engine', 'foreign'] as const
const SURFACES = ['offered', 'undescribed', 'suppressed', 'unusable', 'disabled'] as const
const DISABLES = ['per-skill', 'engine-switch', 'none'] as const

/** The port, implemented over the window's IPC. */
export function createAgentSkillsClient(request: AgentSkillsRequest): AgentSkillsClient {
  const pair = { agentId: request.agentId, profileId: request.profileId }
  return {
    async read(): Promise<AgentSkillsReadout | SkillRefusal> {
      const answer = await request.skills.read(pair.agentId, pair.profileId)
      return isRefusal(answer) ? refusal(answer) : readout(answer)
    },
    async preview(source: string): Promise<SkillPreviewView | SkillRefusal> {
      const answer = await request.skills.preview(pair.agentId, pair.profileId, source)
      return isRefusal(answer) ? refusal(answer) : preview(answer)
    },
    async import(source: string, replace: boolean): Promise<SkillRefusal | null> {
      return nullableRefusal(
        await request.skills.import(pair.agentId, pair.profileId, source, replace),
      )
    },
    async setEnabled(name: string, scope: string, enabled: boolean): Promise<SkillRefusal | null> {
      return nullableRefusal(
        await request.skills.setEnabled(pair.agentId, pair.profileId, name, scope, enabled),
      )
    },
  }
}

// ---------------------------------------------------------------------------
// The answers
// ---------------------------------------------------------------------------

/**
 * Whether an answer is a refusal rather than a readout or a preview.
 *
 * The two are told apart by the one field only a refusal has — the backend's `kind`, which the
 * readout does not carry at its root. A readout that *did* carry one would be read as a refusal and
 * drawn as a sentence, which is the direction this check fails in.
 */
function isRefusal(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>)['kind'] === 'string'
  )
}

/** `null` is the accepted arm; anything else is a refusal and must read as one. */
function nullableRefusal(value: unknown): SkillRefusal | null {
  return value === null ? null : refusal(value)
}

function readout(value: unknown): AgentSkillsReadout {
  const record = asRecord(value, 'the readout')
  return {
    scopes: asList(record['scopes'], 'scopes').map(scope),
    skills: asList(record['skills'], 'skills').map(entry),
    disabled: asList(record['disabled'], 'disabled').map(entry),
    importScope: asNullableString(record['importScope'], 'importScope'),
  }
}

function scope(value: unknown, index: number): SkillScopeView {
  const record = asRecord(value, `scopes[${index}]`)
  const at = (field: string) => `scopes[${index}].${field}`
  return {
    id: asString(record['id'], at('id')),
    label: asString(record['label'], at('label')),
    root: asString(record['root'], at('root')),
    suppressedBy: asNullableString(record['suppressedBy'], at('suppressedBy')),
  }
}

function entry(value: unknown, index: number): SkillEntryView {
  const record = asRecord(value, `a row[${index}]`)
  const at = (field: string) => `a row[${index}].${field}`
  return {
    name: asString(record['name'], at('name')),
    description: asNullableString(record['description'], at('description')),
    directory: asString(record['directory'], at('directory')),
    scope: asString(record['scope'], at('scope')),
    scopeLabel: asString(record['scopeLabel'], at('scopeLabel')),
    owner: oneOf(record['owner'], OWNERS, at('owner')),
    conflicts: asStringList(record['conflicts'], at('conflicts')),
    surface: surface(record['surface'], at('surface')),
    suppressedBy: asNullableString(record['suppressedBy'], at('suppressedBy')),
    disable: disable(record['disable'], at('disable')),
  }
}

/** The five arms of "what the engine will do with it", each checked for the fact it carries. */
function surface(value: unknown, what: string): SkillSurfaceView {
  const record = asRecord(value, what)
  const kind = oneOf(record['kind'], SURFACES, `${what}.kind`)
  switch (kind) {
    case 'suppressed':
      return { kind, variable: asString(record['variable'], `${what}.variable`) }
    case 'unusable':
      return { kind, error: refusal(record['error']) }
    case 'offered':
    case 'undescribed':
    case 'disabled':
      return { kind }
  }
}

/** The three arms of "how this directory's contents can be switched off". */
function disable(value: unknown, what: string): SkillDisableView {
  const record = asRecord(value, what)
  const kind = oneOf(record['kind'], DISABLES, `${what}.kind`)
  if (kind === 'engine-switch') {
    return { kind, variable: asString(record['variable'], `${what}.variable`) }
  }
  return { kind }
}

function preview(value: unknown): SkillPreviewView {
  const record = asRecord(value, 'a preview')
  return {
    name: asString(record['name'], 'preview.name'),
    description: asString(record['description'], 'preview.description'),
    files: asList(record['files'], 'preview.files').map(listed),
    scripts: asList(record['scripts'], 'preview.scripts').map(listed),
    totalBytes: asNumber(record['totalBytes'], 'preview.totalBytes'),
  }
}

function listed(value: unknown, index: number): { path: string; bytes: number } {
  const record = asRecord(value, `a listed file[${index}]`)
  return {
    path: asString(record['path'], `a listed file[${index}].path`),
    bytes: asNumber(record['bytes'], `a listed file[${index}].bytes`),
  }
}

/**
 * The refusal, arm for arm — `SkillError`'s own vocabulary.
 *
 * The *facts* each arm carries are read as a bag rather than per arm, and that is deliberate here
 * where the registry's is written out per arm: the page interpolates them into a sentence by slot
 * name (`{path}`, `{name}`, `{message}`), so what has to survive this narrowing is every fact the
 * backend sent, whatever it is called. A number is kept as a number so a sentence that says "line
 * 7" gets 7 and not "7". What is *not* kept is anything that is not a string or a number — an arm
 * that grew an object or a list would render as a hole, and a hole is what this whole table exists
 * to make impossible — so an unreadable fact drops the answer into a rejection instead.
 */
function refusal(value: unknown): SkillRefusal {
  const record = asRecord(value, 'a refusal')
  const kind = oneOf(record['kind'], REFUSAL_KINDS, 'kind')
  const facts: SkillRefusal = { kind }
  for (const [key, fact] of Object.entries(record)) {
    if (key === 'kind') continue
    if (fact === null) {
      // A nullable fact (`variable` on the two arms that carry an engine switch) is passed through
      // as `null`: the page's `fill` leaves a slot with no value alone rather than inventing one.
      facts[key] = null
      continue
    }
    if (typeof fact === 'string' || typeof fact === 'number') {
      facts[key] = fact
      continue
    }
    return malformed(`a refusal.${key}`)
  }
  return facts
}

// ---------------------------------------------------------------------------
// Narrowing
// ---------------------------------------------------------------------------

/** A failed call, not a refused one: the page's unreadable state is the answer to this. */
function malformed(what: string): never {
  throw new Error(`the skills backend answered something this window does not understand: ${what}`)
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return malformed(what)
  return value as Record<string, unknown>
}

function asList(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) return malformed(what)
  return value
}

function asString(value: unknown, what: string): string {
  if (typeof value !== 'string') return malformed(what)
  return value
}

function asNullableString(value: unknown, what: string): string | null {
  if (value === null) return null
  return asString(value, what)
}

function asNumber(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return malformed(what)
  return value
}

function asStringList(value: unknown, what: string): string[] {
  return asList(value, what).map((item, index) => asString(item, `${what}[${index}]`))
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  const text = asString(value, what)
  if (!(allowed as readonly string[]).includes(text)) return malformed(what)
  return text as T
}
