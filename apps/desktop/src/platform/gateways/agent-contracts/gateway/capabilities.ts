/**
 * §3.4's capability row: what the installation declares, what the engine reported, and what this app
 * offers — one feature at a time, with the three subjects kept apart.
 *
 * A module of its own because the lists and the four types here are held to their Rust counterparts
 * by tests that read both sides (`agent_runtime/capabilities.rs`'s `host_offer`,
 * `agent_runtime/adapters/mod.rs`'s `HostFeature::ALL`), so this is the file a capability
 * negotiation changes — and the one whose edits are checked against the host rather than trusted.
 */

/**
 * The features a capability report has a row for, in the order the host reports them.
 *
 * One list, and it is the host's: the Rust `HostFeature::ALL` (`agent_runtime/adapters/mod.rs`),
 * spelled with the same names `HostFeature::as_str` produces. They are *data* — a settings page
 * renders them as they arrived rather than translating them — so the two sides sharing one spelling
 * is the whole contract, and `tauri-agent.test.ts` reads the Rust file and holds the two lists to
 * each other rather than trusting this copy.
 */
export const AGENT_CAPABILITY_FEATURES = [
  'session-resume',
  'session-list',
  'session-resume-without-history',
  'session-close',
  'session-fork',
  'slash-commands',
  'model-selection',
  'image-attachments',
  'audio-attachments',
  'session-config-options',
  'embedded-context',
] as const

export type AgentCapabilityFeature = (typeof AGENT_CAPABILITY_FEATURES)[number]

/**
 * What this app offers for each feature, feature for feature.
 *
 * **The Rust `host_offer` (`agent_runtime/capabilities.rs`) is the source, and this is a copy held
 * to it by a test** — the same arrangement `AGENT_CAPABILITY_FEATURES` has with `HostFeature::ALL`,
 * and for the same reason: one side is a program and the other is a window, and the only thing that
 * keeps them the same is a test that reads both.
 *
 * It exists because a report needs a value on every row and this half has no "not known" arm: a
 * host always knows what it offers, which is the whole point of {@link AgentCapabilityOffer}. A
 * double that answered one arm for everything would be teaching a page that this app's half moves
 * with a test's script, so the double reads this table instead.
 */
export const AGENT_CAPABILITY_HOST_OFFERS: Readonly<
  Record<AgentCapabilityFeature, AgentCapabilityOffer>
> = {
  'session-resume': { status: 'command', command: 'agent_load_session' },
  'session-list': { status: 'command', command: 'agent_list_sessions' },
  // The engine advertises `session/resume` and this app calls `session/load` — two methods the
  // schema separates, and only one of them has a caller here.
  'session-resume-without-history': { status: 'nothing' },
  'session-close': { status: 'command', command: 'agent_close_session' },
  // The row this table's `nothing` arm exists for: measured served by the engine, advertised in its
  // handshake, and reached by nothing in this build.
  'session-fork': { status: 'nothing' },
  'slash-commands': { status: 'control' },
  'model-selection': { status: 'command', command: 'agent_set_config_option' },
  'image-attachments': { status: 'control' },
  'audio-attachments': { status: 'nothing' },
  'session-config-options': { status: 'command', command: 'agent_set_config_option' },
  'embedded-context': { status: 'control' },
}

/**
 * What the installation claims about a feature — `adapters::Capability`, arm for arm.
 *
 * A **claim**, not an answer: §3.4 makes the install declaration a start-time hint, and the
 * handshake and the session negotiation are what decide what works. It is reported (a page that
 * showed only the finding would be hiding that the pinned version was measured to differ), but it
 * is never a route to {@link AgentCapabilityFinding} saying `available`.
 *
 * `unverified` is a third arm rather than a synonym for `not-advertised` because the two are
 * different claims: "the pinned version is known not to do this" against "we have not measured this
 * engine at all", and letting one stand in for the other is the failure the third state exists to
 * prevent.
 */
export type AgentCapabilityDeclaration = 'advertised' | 'not-advertised' | 'unverified'

/**
 * What was established about one feature, from the engine's own report.
 *
 * Three arms, and the third is the one a two-armed version would lose — `available` is only ever
 * built from something the engine reported, `unavailable` is a report that said no, and `unverified`
 * is one that has not happened. Every non-available arm *requires* a detail, so a report cannot say
 * a capability is missing and leave the user to guess why (§7.2 「不宣称…」), and the same shape is
 * what D3's `PetCapabilityFinding` uses on the pet side.
 */
export type AgentCapabilityFinding =
  | { readonly status: 'available' }
  | { readonly status: 'unavailable' | 'unverified'; readonly detail: string }

/**
 * What **this app** offers for one feature — `capabilities::HostOffer`, arm for arm.
 *
 * The third subject of §3.4's row, and the one neither of the other two is about: the declaration
 * is what the pinned version was measured to do and the finding is what the engine reported, so a
 * row carrying only those two says 「the engine can do this」 in words a reader takes for 「you can
 * do this」. On the pinned engine that reading is wrong — `session/fork` and `session/resume` are
 * advertised and this app calls neither — and the arms here are how that is said without the
 * finding having to lie about the engine or the row having to be dropped.
 *
 * `command` is a name in `build.rs`'s manifest rather than a `true`, so 「this app can do it」 is a
 * claim about the shipped command surface that a reader can go and check.
 */
export type AgentCapabilityOffer =
  | { readonly status: 'command'; readonly command: string }
  | { readonly status: 'control' }
  | { readonly status: 'nothing' }

/**
 * One feature, with all three of §3.4's row's subjects kept apart.
 *
 * Three fields rather than one optimistic one: a page that merged any two of them would be showing
 * one claim as another — the installation's start-time hint as the engine's answer, or either of
 * those as this app's own ability. The finding is nested rather than intersected into this type so
 * a consumer reads `report.finding.status` and narrows a plain union.
 */
export interface AgentCapabilityReport {
  readonly feature: AgentCapabilityFeature
  readonly declared: AgentCapabilityDeclaration
  readonly finding: AgentCapabilityFinding
  /** What this build does about it, whether or not a negotiation happened. */
  readonly host: AgentCapabilityOffer
}
