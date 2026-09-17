/**
 * The catalogue's rules: what a registry entry may be turned into, and what it may never be shown
 * as saying.
 *
 * A pure module — no IPC, no DOM, no Vue — and the counterpart of
 * `R/src/agent_runtime/catalogue.rs`, which is the authority. The backend parses the published
 * schema and decides the standing; this file mirrors those answers so a page can render them and
 * so an arm the backend grows is a compile error here rather than a row that renders nothing.
 *
 * **The rule this file exists for is a negative one.** A catalogue entry is a description of a
 * *process*: an id, a version, a URL, an argument list — everything a publisher wrote about an
 * artifact nobody here has run. What an engine can *do* is established by a handshake and a session
 * negotiation (§3.4's capability row), and not one field in this file is evidence for any of it.
 * So there is deliberately no function here that answers a capability question: a page that wanted
 * to draw a capability row from a catalogue entry has nothing to call, which is the shape
 * 「不能让按钮看起来可用、点击后才发现不支持」 takes at the type level.
 *
 * **And the second negative.** An entry whose distribution this build cannot act on gets no
 * control. {@link catalogueAction} is the only place that is decided, and it answers `none` with a
 * reason for three of the four standings — the fourth, a package-manager invocation, is the one
 * thing a catalogue can hand to a registration without this app becoming the downloader. The
 * §3.3 checks a download would owe travel with the readout (`readout.installGates`) so the reason
 * can be shown rather than asserted.
 *
 * The vocabulary is the backend's, spelled the same way on both sides — the same rule
 * `agent-registry-policy.ts` follows for `InstallSource`, so neither side keeps a second name for
 * one value.
 */

/** How current the catalogue's rows are. `unavailable` is the arm with no rows at all. */
export type CatalogueFreshness = 'current' | 'stale' | 'unavailable'

/**
 * What the backend could do about an entry's distribution.
 *
 * Four arms, and exactly one is actionable — which is why this union is not a boolean and why
 * `offerable` is computed by the backend rather than re-derived here from a pair of fields.
 */
export type CatalogueStanding =
  | {
      /** A package-manager invocation: `npx` or `uvx`. The manager owns the artifact's provenance. */
      kind: 'via-package-manager'
      /** `npx` or `uvx` — the manager's own name, not a product being run. */
      manager: string
      /** The package, which may or may not pin a version. */
      package: string
      /** The program a registration points at. Kept apart from `args`: §3.4.3 forbids a command line. */
      program: string
      args: readonly string[]
      /**
       * The version the package string pins, or `null` when it pins none.
       *
       * Not a convenience: `@latest` and a bare name both pin nothing, and a row that showed the
       * entry's version here would be repeating the publisher's claim as though the artifact had
       * made it. `null` is the honest answer and the page says "whatever the manager resolves".
       */
      pinnedVersion: string | null
    }
  | {
      /** An archive for this machine, and no package distribution: using it makes this app the downloader. */
      kind: 'archive-only'
      platform: string
      cmd: string
    }
  | { /** Archives for other machines only. */ kind: 'unsupported'; published: readonly string[] }
  | { /** Distribution kinds this build does not understand, named so a row can say which. */ kind: 'unrecognised'; kinds: readonly string[] }

/** The package manager's own name, as the wire spells it. */
export type PackageManagerId = 'npx' | 'uvx'

/** One §3.3 check, and whether a registry entry can support it. */
export interface InstallGate {
  /** The check's own name, matching `update.rs`'s `Check::as_str`. */
  check: string
  /**
   * Whether a registry entry can support it. `false` is not a gap in this build's work: it is the
   * reason an archive arm offers no control, and anything else would have to be replaced by a
   * *decision* — pinning a digest in-app, or shipping a suite — that a catalogue may not make.
   */
  transfers: boolean
}

/** One registry entry, as the backend read it. */
export interface CatalogueRow {
  id: string
  name: string
  /** The version the *entry* declares for its stable channel. Never a version of anything local. */
  version: string
  description: string
  repository: string | null
  website: string | null
  authors: readonly string[]
  /** An SPDX identifier or `proprietary`; free text on the wire, because the schema allows any. */
  license: string | null
  /** Required by the schema for every entry but one, so absent means the document is at fault. */
  licenseUrl: string | null
  iconUrl: string | null
  standing: CatalogueStanding
  /** Why the entry cannot be offered, when it cannot. A document defect, not a machine's state. */
  defects: readonly string[]
  /**
   * Whether a control may be drawn. The backend computes it (`defects` empty *and* the standing
   * actionable); this module never re-derives it, because two derivations of one rule is how they
   * come to disagree.
   */
  offerable: boolean
}

/** Everything the catalogue section reads, in one answer. */
export interface CatalogueReadout {
  /** The registry schema version the document declared. Empty when nothing was read. */
  registryVersion: string
  freshness: CatalogueFreshness
  /** Why the rows are stale or absent, when they are — the backend's own sentence. */
  note: string | null
  rows: readonly CatalogueRow[]
  offerable: number
  installGates: readonly InstallGate[]
}

/**
 * What the catalogue section calls. Implemented by whichever adapter sits behind it, and the thing
 * a test substitutes a fake for.
 *
 * One call, and a *rejection* means the IPC failed — there is no refusal arm here, because reading
 * a catalogue is not a request the backend can say no to. "The registry could not be reached" is an
 * answer, and it travels in {@link CatalogueReadout.freshness} where a page can say it, rather than
 * as a thrown error the page could only render as a blank section.
 */
export interface AgentCatalogueClient {
  readCatalogue(): Promise<CatalogueReadout>
}

/** What a row's control does, or why there is none. */
export type CatalogueAction =
  | {
      kind: 'prefill'
      /** The program a registration would point at — the package manager, not the agent. */
      program: string
      /** The argument array. Never joined into a command line (§3.4.3). */
      args: readonly string[]
      /** A name for the add form. The registry's display name is what a user recognizes. */
      displayName: string
      /** The id a registration would carry — the registry's own id. */
      agentId: string
    }
  | {
      kind: 'none'
      /** Why there is nothing to draw, as one of the standings' names. The page turns it into a sentence. */
      reason: CatalogueStanding['kind']
    }

/**
 * What a row's control may be, which is the whole of 「不能让按钮看起来可用、点击后才发现不支持」.
 *
 * Three of the four standings answer `none`, and the reasons are different rather than one
 * "unavailable": an archive would make this app the downloader and §3.3 will not let it be
 * (`digest` does not transfer — see {@link InstallGate}), other machines' archives have nothing to
 * run here, and an unrecognised kind is something this build cannot describe at all. A page that
 * collapsed them would send a user to the wrong fix.
 *
 * `offerable` is read rather than recomputed. The backend also computes it, from its own parse — and
 * a row the backend marked unofferable is refused here even if its standing looks actionable, so a
 * disagreement between the two sides resolves towards drawing nothing.
 */
export function catalogueAction(row: CatalogueRow): CatalogueAction {
  if (!row.offerable) return { kind: 'none', reason: row.standing.kind }
  const standing = row.standing
  if (standing.kind !== 'via-package-manager') return { kind: 'none', reason: standing.kind }
  return {
    kind: 'prefill',
    program: standing.program,
    args: standing.args,
    displayName: row.name,
    agentId: row.id,
  }
}

/**
 * The §3.3 checks a registry entry cannot support, so a page can say *why* it draws no install
 * control instead of asking a user to take the refusal on trust.
 *
 * Derived from the readout rather than listed here: the backend is the authority on which checks
 * transfer, and a second list on this side is a second answer that could drift from it.
 */
export function untransferableGates(readout: CatalogueReadout): readonly string[] {
  return readout.installGates.filter((gate) => !gate.transfers).map((gate) => gate.check)
}

/**
 * Whether the catalogue has anything to show.
 *
 * Three questions in one place, because a page that tested only one of them would draw an empty
 * list for a registry it never read — the same failure as a row that offers nothing.
 */
export function catalogueIsEmpty(readout: CatalogueReadout): boolean {
  return readout.rows.length === 0
}

/**
 * The features a catalogue entry is *not* evidence about, so a page that wanted to draw a
 * capability row has the refusal in hand.
 *
 * Field-for-field the vocabulary the capability report uses, and the reason this file has no
 * function that answers one of them. Listed here so the *question* is named in one place: every one
 * of these is established by a handshake or a session negotiation and by nothing else (§3.4's
 * capability row), which is why they are absent from every type above.
 */
export const CATALOGUE_SAYS_NOTHING_ABOUT: readonly string[] = [
  'session-resume',
  'slash-commands',
  'model-selection',
  'image-attachments',
  'audio-attachments',
  'session-config-options',
  'embedded-context',
]
