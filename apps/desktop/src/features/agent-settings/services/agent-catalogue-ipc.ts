/**
 * The catalogue client: the backend's answer, narrowed into the port the settings page calls.
 *
 * The same split `agent-registry-ipc.ts` makes, one subject over: `agent-catalogue-policy.ts`
 * declares the domain types and the rules, and this file narrows the wire into them. The wire is
 * `unknown` (`platform` may not name a feature's types), so the shape is this file's
 * responsibility — a cast would be a promise about a foreign process, and a renamed field or an arm
 * the backend grew would reach the page as a blank row.
 *
 * **What is narrowed, and what is deliberately not.** `standing` has four arms and each is read
 * per-arm, so a field arriving on the wrong one is a rejection rather than a hole in a sentence.
 * `offerable` is a boolean the backend computed and is checked as one: this file does not derive it
 * from `defects` and `standing`, because a second derivation of one rule is how the two sides come
 * to disagree — and the direction of that disagreement would be a control drawn for a row the
 * backend cannot act on.
 *
 * **A malformed answer is a rejection, not an empty catalogue.** "No agents are listed" is a claim
 * about the registry; a shape this window cannot read is a fact about this window. Collapsing them
 * would let a broken reader look like a small registry, which is the failure the registry client's
 * own guard exists to make loud.
 */

import {
  asBoolean,
  asList,
  asNullableString,
  asNumber,
  asRecord,
  asString,
  asStringList,
  malformed,
  oneOf,
} from './agent-wire-narrowing'
import type {
  AgentCatalogueClient,
  CatalogueFreshness,
  CatalogueReadout,
  CatalogueRow,
  CatalogueStanding,
  InstallGate,
  PackageManagerId,
} from './agent-catalogue-policy'

/**
 * The window's IPC, as this client uses it: one call whose answer is not trusted.
 *
 * Structurally the port the platform gateway implements — declared rather than imported, because
 * `platform` may not reach into `features` and this module may not depend on Tauri.
 */
export interface AgentCatalogueWire {
  readCatalogue(): Promise<unknown>
}

/** The four flexibilities, listed once each, so a new arm is a compile error here. */
const STANDINGS: readonly CatalogueStanding['kind'][] = [
  'via-package-manager',
  'archive-only',
  'unsupported',
  'unrecognised',
]
const FRESHNESS: readonly CatalogueFreshness[] = ['current', 'stale', 'unavailable']

/** The package managers a standing may name. `uvx` is here because the schema has it. */
const MANAGERS: readonly PackageManagerId[] = ['npx', 'uvx']

/** The port, implemented over the window's IPC. */
export function createAgentCatalogueClient(wire: AgentCatalogueWire): AgentCatalogueClient {
  return {
    async readCatalogue(): Promise<CatalogueReadout> {
      return readout(await wire.readCatalogue())
    },
  }
}

function readout(value: unknown): CatalogueReadout {
  const record = asRecord(value, 'the catalogue')
  return {
    registryVersion: asString(record['registryVersion'], 'registryVersion'),
    freshness: oneOf(record['freshness'], FRESHNESS, 'freshness'),
    // A note is *absent* (`null`) when there is nothing to say, and a page renders that as no
    // note. `''` would be a note that says nothing, which reads as a bug rather than as silence.
    note: noteDetail(record['note']),
    rows: asList(record['rows'], 'rows').map(row),
    offerable: asNumber(record['offerable'], 'offerable'),
    installGates: asList(record['installGates'], 'installGates').map(gate),
  }
}

/**
 * The backend's note is an object with one field, so a page reads `note.detail`.
 *
 * Kept as an object on the wire rather than a bare string so a later reason can carry a second fact
 * without changing the shape of every existing answer — and flattened to the string here, because
 * this is where a foreign shape stops and the page's belongs.
 */
function noteDetail(value: unknown): string | null {
  if (value === null) return null
  const record = asRecord(value, 'note')
  return asString(record['detail'], 'note.detail')
}

function row(value: unknown, index: number): CatalogueRow {
  const record = asRecord(value, `rows[${index}]`)
  const at = (field: string) => `rows[${index}].${field}`
  return {
    id: asString(record['id'], at('id')),
    name: asString(record['name'], at('name')),
    version: asString(record['version'], at('version')),
    description: asString(record['description'], at('description')),
    repository: asNullableString(record['repository'], at('repository')),
    website: asNullableString(record['website'], at('website')),
    authors: asStringList(record['authors'], at('authors')),
    license: asNullableString(record['license'], at('license')),
    licenseUrl: asNullableString(record['licenseUrl'], at('licenseUrl')),
    iconUrl: asNullableString(record['iconUrl'], at('iconUrl')),
    standing: standing(record['standing'], at('standing')),
    defects: asStringList(record['defects'], at('defects')),
    offerable: asBoolean(record['offerable'], at('offerable')),
  }
}

/**
 * The standing, arm for arm — per-arm checks rather than a table, so a field a page reads is
 * checked against the arm that carries it. A shared reader would let `cmd` arrive on a package arm
 * and leave the sentence with a hole in it.
 */
function standing(value: unknown, what: string): CatalogueStanding {
  const record = asRecord(value, what)
  const kind = oneOf(record['kind'], STANDINGS, `${what}.kind`)
  switch (kind) {
    case 'via-package-manager':
      return {
        kind,
        manager: oneOf(record['manager'], MANAGERS, `${what}.manager`),
        package: asString(record['package'], `${what}.package`),
        program: asString(record['program'], `${what}.program`),
        args: asStringList(record['args'], `${what}.args`),
        pinnedVersion: asNullableString(record['pinnedVersion'], `${what}.pinnedVersion`),
      }
    case 'archive-only':
      return {
        kind,
        platform: asString(record['platform'], `${what}.platform`),
        cmd: asString(record['cmd'], `${what}.cmd`),
      }
    case 'unsupported':
      return { kind, published: asStringList(record['published'], `${what}.published`) }
    case 'unrecognised':
      return { kind, kinds: asStringList(record['kinds'], `${what}.kinds`) }
  }
  // Unreachable: `STANDINGS` is typed against the union. Kept so the function is total without a
  // cast, and so a build that got past that is a rejection rather than a row with no standing.
  return malformed(`${what}.kind`)
}

function gate(value: unknown, index: number): InstallGate {
  const record = asRecord(value, `installGates[${index}]`)
  return {
    check: asString(record['check'], `installGates[${index}].check`),
    transfers: asBoolean(record['transfers'], `installGates[${index}].transfers`),
  }
}
