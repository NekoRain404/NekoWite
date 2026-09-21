/**
 * A session configuration option, the values it accepts, and the set of them an engine reports.
 *
 * ACP's config option is the one mechanism this app has for the model selector and the session mode
 * alike (§6.3 leaves the ids and the values to the engine), so all four shapes here change together
 * when that schema changes — and the same types are the answer to both `session/new` and
 * `session/set_config_option`, which the Rust command passes through in one shape on purpose.
 */

/** One value a configuration option accepts. */
export interface AgentConfigChoice {
  value: string
  name: string
  description?: string
}

/**
 * What a configuration option is set to, and what it could be set to.
 *
 * Two arms because the schema's `SessionConfigKind` has two (`select`, `boolean`):
 * a boolean option's value is not a string, so one flattened shape would make one
 * of the two unrepresentable — the same defect the extra kinds exist to avoid.
 */
export type AgentConfigValue =
  | { kind: 'select'; current: string; choices: AgentConfigChoice[] }
  | { kind: 'toggle'; current: boolean }

/** One session configuration option (ACP `SessionConfigOption`); the model
 *  selector P0 §2.2 measured coming back with `session/new` is one of these. */
export interface AgentConfigOption {
  /** The engine's id, which is what setting it addresses (`configId` on the wire). */
  id: string
  name: string
  description?: string
  value: AgentConfigValue
}

/**
 * The whole set of a session's options, as an engine reports it — the answer to `session/new`
 * and the answer to `session/set_config_option`, which the Rust command passes through in one
 * shape on purpose.
 *
 * Two arms, and they are two different statements: a list is what the engine said its options
 * are (and an empty list is a valid one — an engine may withdraw every option it offered), while
 * `null` is this window failing to read the answer at all. A caller that collapsed them would
 * clear a row on an answer nobody could read, which is the engine being credited with a change it
 * never made.
 */
export type AgentConfigOptionList = readonly AgentConfigOption[] | null
