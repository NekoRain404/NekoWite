/**
 * What the skills page reads: the backend's answer as the page, the IPC client and the composition
 * site all name it, and the port that answer arrives through.
 *
 * This was the middle of `AgentSkillsSettings.vue`'s setup block, and it is a file of its own
 * because the page is not the only thing that names these shapes. `services/agent-skills-ipc.ts`
 * imports all eight of them — it is the module that *builds* an {@link AgentSkillsReadout} out of an
 * untrusted answer — `app/agent-settings-composition.ts` names {@link AgentSkillsClient} for the
 * prop it hands the page, and both of their specs build fixtures from the row and refusal types. A
 * page that owns the contract its readers depend on is a dependency the wrong way round: with these
 * declarations in the component, a change to how the page draws a row reads to anyone following the
 * imports as a change to the wire.
 *
 * The page imports them and re-exports them, so every specifier that names
 * `AgentSkillsSettings.vue` keeps resolving — the IPC client, its spec, the composition site and the
 * page's own spec — and the split is a change to where a declaration lives rather than to a name a
 * caller writes.
 *
 * What a refusal *is* stays in `agent-skills-labels.ts`: {@link SkillRefusal.kind} is
 * `SkillRefusalKind`, the vocabulary the copy tree is keyed by, and two declarations of that list
 * would be two lists to keep in step.
 */
import type { SkillRefusalKind } from './agent-skills-labels'

/** A refusal as the backend sends it: its kind, plus the facts that sentence carries. */
export interface SkillRefusal {
  kind: SkillRefusalKind
  [fact: string]: unknown
}

/** How a directory's contents can be switched off, as `skills.rs` reports it. */
export type SkillDisableView =
  | { kind: 'per-skill' }
  | { kind: 'engine-switch'; variable: string }
  | { kind: 'none' }

/** What the engine will do with a discovered skill. */
export type SkillSurfaceView =
  | { kind: 'offered' }
  | { kind: 'undescribed' }
  | { kind: 'suppressed'; variable: string }
  | { kind: 'unusable'; error: SkillRefusal }
  | { kind: 'disabled' }

export interface SkillEntryView {
  name: string
  description: string | null
  directory: string
  scope: string
  scopeLabel: string
  owner: 'managed' | 'engine' | 'foreign'
  conflicts: string[]
  surface: SkillSurfaceView
  /** The engine's switch that is on for this row's *scope*, or `null` if none is (see the page's
      file comment in `AgentSkillsSettings.vue`: a directory that is configured and one that
      contributes are two facts). */
  suppressedBy: string | null
  disable: SkillDisableView
}

/** One directory the engine's rules name, as the readout describes it. */
export interface SkillScopeView {
  id: string
  label: string
  root: string
  /** The engine's own switch that stops it reading this directory, or `null` if it reads it. */
  suppressedBy: string | null
}

export interface AgentSkillsReadout {
  /** Every directory the engine's rules name — the page draws one heading per entry. */
  scopes: SkillScopeView[]
  skills: SkillEntryView[]
  disabled: SkillEntryView[]
  /**
   * The scope an import would install into, or `null` when this profile has none.
   *
   * A scope *id* into {@link AgentSkillsReadout.scopes} rather than a path: what the page needs is
   * where the control would write, and where that is is the backend's answer — the same predicate
   * `SkillLibrary::import` refuses on, so a page offering an import the backend would refuse (or
   * omitting one it would accept) cannot be built from this readout.
   */
  importScope: string | null
}

/** What an import would install, read from the folder and written nowhere. */
export interface SkillPreviewView {
  name: string
  description: string
  files: { path: string; bytes: number }[]
  scripts: { path: string; bytes: number }[]
  totalBytes: number
}

/**
 * The backend, chosen at the composition site.
 *
 * Two failure channels, kept apart as they are everywhere else in this tree: a **rejection** is the
 * call not completing and the page says so; a **refusal** is data that comes back and is rendered.
 *
 * The read carries both, and `preview` already did: an arrangement the backend refuses to build a
 * library from (this host's store lying inside a directory the engine scans) is not a broken
 * connection, and answering it as one would leave the page's "could not be read from the backend"
 * standing over a backend that answered with a reason.
 */
export interface AgentSkillsClient {
  read(): Promise<AgentSkillsReadout | SkillRefusal>
  preview(source: string): Promise<SkillPreviewView | SkillRefusal>
  import(source: string, replace: boolean): Promise<SkillRefusal | null>
  setEnabled(name: string, scope: string, enabled: boolean): Promise<SkillRefusal | null>
}
