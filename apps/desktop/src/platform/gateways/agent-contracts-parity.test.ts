/**
 * The hand-kept halves of the agent contract, held to the Rust that produces them.
 *
 * `agent_runtime/events.rs` states the relationship in its own words: the TypeScript envelope is
 * written in parallel, and "the list here is that contract, kept in step by hand, and NOT an
 * import". Both halves are runtime values, because both validate frames that arrive from outside
 * the process — so a spelling that exists on one side only is not a type error anywhere, and both
 * suites can be green while the boundary is broken. This file is the guard the contract's own
 * Rust-side test cannot be: that one compares serde's rendering against a table written out in
 * Rust (`tests/agent_event_contract_test.rs`), a copy of the list it guards, while these read the
 * *other* side's source.
 *
 * What each drift costs decides which check is strict:
 *
 *  - a **failure code** the Rust side has and the contract does not fails the whole frame. A
 *    `run-failed` is refused by `readRunFailure`, and `frames.ts` turns a refused frame that names
 *    a run into `invalid-response` — so the engine's own message is lost and its condition is
 *    reclassified. `certificate-untrusted` is the extension that made this list drift once
 *    already (`docs/architecture/agent-dependencies.md`), which is why this is checked for
 *    equality and in order.
 *  - an **event kind** the Rust side has and the contract does not is refused the same way, for
 *    every frame of that kind. The other direction is deliberate and must stay open — the
 *    contract carries kinds this host has no producer for (`plan-changed`, `mode-changed`,
 *    `session-changed`, `usage-changed`, `events.rs` names them) — so this is a subset check.
 *    `user-delta` used to be on that list, and the check below stayed green the whole time it had
 *    no producer anywhere: a kind declared, reduced and drawn, and never emitted. What caught it
 *    was the replay measurement (`agent_session_replay_live_test.rs`), not this file — a reminder
 *    that this list can only hold kinds that are *spelled* the same on both sides.
 *  - a **stop reason** is the one of the three whose set this repository does not own: `runs.rs`
 *    renders it from the pinned schema's `StopReason` (`wire_stop_reason`, mechanically, with no
 *    table), so a variant the dependency adds is invisible to every test here. That is exactly why
 *    the contract reads an unknown reason as its own arm (`payloads.ts`, `AgentRunEnding`) instead
 *    of holding a longer list, and why what is checked below is the contract's five against the
 *    Rust *consumer* that classifies them.
 *
 * The precedents are in-repo: `tauri-agent.test.ts` reads `adapters/mod.rs`, `desktop-entry.test.ts`
 * reads `open_file.rs`, and `desktop_pet_settings_test/schema.rs` does the same across the boundary
 * in the other direction.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AGENT_FAILURE_CODES, AGENT_STOP_REASONS, isAgentSessionState } from './agent-contracts'

const TAURI = resolve(__dirname, '../../../src-tauri/src')

function rust(path: string): string {
  return readFileSync(resolve(TAURI, path), 'utf8')
}

function typescript(path: string): string {
  return readFileSync(resolve(__dirname, path), 'utf8')
}

/** The variants of one unit enum, in declaration order, with attributes and comments removed. */
function enumVariants(source: string, name: string, file: string): string[] {
  const start = source.indexOf(`pub enum ${name} {`)
  expect(start, `pub enum ${name} is not declared in ${file}`).toBeGreaterThan(-1)
  const variants = source
    .slice(start, source.indexOf('\n}', start))
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => !line.startsWith('//') && !line.startsWith('#['))
    .map((line) => /^([A-Za-z][A-Za-z0-9_]*)\s*,/.exec(line)?.[1])
    .filter((variant): variant is string => variant !== undefined)
  expect(variants.length, `${name} lists no variants`).toBeGreaterThan(0)
  return variants
}

/** The spelling `#[serde(rename_all = "kebab-case")]` gives a variant: a hyphen at every capital
 *  after the first, then lowercased. */
function kebab(variant: string): string {
  return variant
    .replace(/[A-Z]/g, (letter, at) => (at === 0 ? letter : `-${letter}`))
    .toLowerCase()
}

describe('the agent contract’s hand-kept halves', () => {
  const events = rust('agent_runtime/events.rs')

  it('spells every failure code the way `AgentFailureCode` declares it', () => {
    expect(enumVariants(events, 'AgentFailureCode', 'events.rs').map(kebab)).toEqual([
      ...AGENT_FAILURE_CODES,
    ])
  })

  it('has a reader for every event kind the runtime can publish', () => {
    // `payloadReaders` is the contract's runtime correlation between a kind and its payload
    // (`validation.ts` says it is the only one), so its keys are the kinds a frame may arrive
    // under. A Rust kind missing from them is a frame this window refuses.
    const validation = typescript('agent-contracts/validation.ts')
    const map = validation.slice(validation.indexOf('const payloadReaders'))
    const readable = new Set(
      [...map.matchAll(/^ {2}'([a-z-]+)': read[A-Za-z]+,/gm)].map(([, kind]) => kind),
    )
    expect(readable.size, 'payloadReaders correlates no kinds').toBeGreaterThan(0)

    const unreadable = enumVariants(events, 'AgentEventKind', 'events.rs')
      .map(kebab)
      .filter((kind) => !readable.has(kind))
    expect(unreadable, 'every frame of these kinds would be refused').toEqual([])
  })

  it('names every session state the runtime can report, and is allowed to name more', () => {
    // The window's own copy of this fact is gone: `AGENT_SESSION_STATES` is the contract's value
    // and `AgentSessionState` is derived from it, so the boundary cannot be wider or narrower than
    // the type any more. What can still drift is the pair *across* the boundary — and this
    // direction is the one with a cost, because `readHostState` refuses a name it does not have
    // and the refusal takes the whole snapshot with it (the replayable tail and every pending
    // permission prompt, `channel.ts`; the Rust side cites the same cost at `snapshot.rs`, where
    // it is the reason an ending it cannot classify is carried rather than invented).
    //
    // The other direction is deliberate and must stay open, exactly as it is for event kinds:
    // `idle` and `starting` describe the runtime before a session exists, so this host has no
    // producer for them and `snapshot.rs` says so ("a state it cannot reach is not one it should
    // be able to invent"). So this is a subset check, and only this way round.
    // Held to the contract's own test of its own list (`isAgentSessionState`, the one
    // `readHostState` branches on) rather than to a membership check written here: the claim is
    // that the boundary would accept this word, and this is the boundary's own question.
    const unnameable = enumVariants(rust('agent_runtime/snapshot.rs'), 'SessionState', 'snapshot.rs')
      .map(kebab)
      .filter((state) => !isAgentSessionState(state))
    expect(unnameable, 'a snapshot in these states would be refused whole').toEqual([])
  })

  it('classifies exactly the stop reasons the contract names', () => {
    // There is no Rust enum of this repository's to compare against — see the header — so the
    // authority used here is the host's own projection, whose match is where a published reason
    // becomes a pet state. A reason on one side only is a value this window reads as
    // `unrecognised` (or, before `AgentRunEnding`, a frame that failed), with both suites green.
    const outcomes = rust('desktop_pet/task_projection/outcomes.rs')
    const start = outcomes.indexOf('fn state_from_stop_reason(')
    expect(start, 'state_from_stop_reason is not declared in outcomes.rs').toBeGreaterThan(-1)
    const classified = [
      ...outcomes.slice(start, outcomes.indexOf('\n}', start)).matchAll(/Some\("([a-z-]+)"\)/g),
    ].map(([, reason]) => reason)

    expect(
      classified.length,
      'a reason classified twice cannot be compared as a set',
    ).toBe(new Set(classified).size)
    expect([...classified].sort()).toEqual([...AGENT_STOP_REASONS].sort())
  })
})
