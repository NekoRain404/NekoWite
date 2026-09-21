/**
 * The fake host the Tauri-agent gateway suites drive the real adapter with.
 *
 * The suites that test the window's own IPC mock `invoke` and `listen`; every suite above them
 * hands this port in instead, so the adapter's own behaviour is exercised without a Tauri process.
 * `fakeIpc` deliberately answers working defaults — a host that refused would make every test that
 * merely touches the gateway report a broken host — and `capabilityAnswer` is the one answer two
 * places read: the fake's own default and the capability report's tests.
 */

import {
  AGENT_CAPABILITY_FEATURES,
  AGENT_CAPABILITY_HOST_OFFERS,
  type AgentSession,
} from './agent-contracts'
import type { createTauriAgentGateway } from './tauri-agent'
import type { AgentHostSnapshot, AgentIpc } from './tauri-agent/ipc'
import { IDENTITY } from './tauri-agent-frames'

// ---------------------------------------------------------------------------
// The gateway: a fake IPC in place of the window's
// ---------------------------------------------------------------------------

/**
 * What `agent_session_capabilities` answers, in the shape `commands/agent_capabilities.rs` returns:
 * `CapabilityReport` with `#[serde(rename_all = "camelCase")]` on the struct and a `status`-tagged
 * finding. One row per feature, which is what the host's own `HostFeature::ALL` drives.
 */
export function capabilityAnswer(
  finding: (feature: string) => unknown = (feature) =>
    feature === 'image-attachments'
      ? { status: 'available' }
      : { status: 'unverified', detail: `${feature} has not been negotiated` },
): unknown[] {
  return AGENT_CAPABILITY_FEATURES.map((feature) => ({
    feature,
    declared: 'unverified',
    finding: finding(feature),
    // The host's third subject, from the contract's table — which is itself held to the Rust source
    // by the `host_offer` case in `tauri-agent-capabilities.test.ts`, so a fixture that read it here
    // cannot drift from the host.
    host: AGENT_CAPABILITY_HOST_OFFERS[feature],
  }))
}

export interface FakeIpc extends AgentIpc {
  /** Push a frame at the gateway as the host would. */
  push(frame: unknown): void
  /** How many listeners are currently registered. */
  readonly listeners: number
  /** How many of those have been removed by their own unsubscribe. */
  readonly unlistened: number
  calls: string[]
}

/**
 * The name the fake host's `session/list` gives its one session.
 *
 * Named rather than inlined because two tests are about the same string travelling: the list
 * answers it, and a reopen of that session has to reach the panel carrying it (the load response
 * itself has no title field — see `AgentSession.title`).
 */
export const LISTED_TITLE = 'New session - 2026-01-01T00:00:01Z'

export function fakeIpc(overrides: Partial<AgentIpc> = {}): FakeIpc {
  const registered = new Set<(frame: unknown) => void>()
  const removed: Array<(frame: unknown) => void> = []
  const calls: string[] = []
  const ipc: FakeIpc = {
    calls,
    get listeners() {
      return registered.size
    },
    get unlistened() {
      return removed.length
    },
    push(frame) {
      for (const listener of [...registered]) listener(frame)
    },
    async start() {
      calls.push('start')
      return { agentId: 'opencode', profileId: 'default', runtimeEpoch: 'epoch-1' }
    },
    async stop() {
      calls.push('stop')
    },
    async openSession() {
      calls.push('openSession')
      return {
        sessionId: 'ses_fake_1',
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            type: 'select',
            currentValue: 'fake/model-a',
            options: [
              { value: 'fake/model-a', name: 'Model A' },
              { value: 'fake/model-b', name: 'Model B' },
            ],
          },
        ],
        modelOptionId: 'model',
      }
    },
    // The three session-management calls. Defaults that *work* rather than throw, because the
    // fake has to stand for a host that answers: a default that refused would make every test
    // that merely touches the gateway report a broken host. What each one answers is the smallest
    // thing the reader accepts — one listed session, one loaded session, a close that returns —
    // and a test that wants a refusal uses `overrides`, which is why the port takes a `Partial`.
    async listSessions() {
      calls.push('listSessions')
      return {
        sessions: [
          {
            sessionId: 'ses_fake_1',
            cwd: '/vault',
            title: LISTED_TITLE,
            updatedAt: '2026-01-01T00:00:01Z',
            // The host's half of the row, and the one field the engine cannot answer: this host
            // holds the session, so a free action on this row is one it will carry out. Required
            // by the reader — a row without it is a host this window does not understand.
            held: true,
          },
        ],
        nextCursor: null,
      }
    },
    async loadSession() {
      calls.push('loadSession')
      return {
        sessionId: 'ses_fake_1',
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            type: 'select',
            currentValue: 'fake/model-a',
            options: [
              { value: 'fake/model-a', name: 'Model A' },
              { value: 'fake/model-b', name: 'Model B' },
            ],
          },
        ],
        modelOptionId: 'model',
      }
    },
    async closeSession() {
      calls.push('closeSession')
    },
    async selectModel() {
      calls.push('selectModel')
    },
    async prompt() {
      calls.push('prompt')
      return 'run-0'
    },
    async cancel() {
      calls.push('cancel')
    },
    // The host's default answer here is a refusal, unlike the session-management calls above, and
    // it is the one every real host gives for a file it did not write: the double and the pinned
    // engine's own-tool writes both land on `no-baseline`. A test that wants a recovery uses
    // `overrides` — what matters for the default is that the *reader* is exercised.
    async recoverChange(_sessionId: string, path: string) {
      calls.push('recoverChange')
      return { kind: 'refused', path, code: 'no-baseline' }
    },
    async answerPermission() {
      calls.push('answerPermission')
    },
    async snapshot(): Promise<AgentHostSnapshot> {
      calls.push('snapshot')
      return { identity: IDENTITY, state: 'ready', runId: null, sequence: 0, events: [], permissions: [] }
    },
    async capabilities() {
      calls.push('capabilities')
      return capabilityAnswer()
    },
    async onEvent(listener) {
      registered.add(listener)
      return () => {
        registered.delete(listener)
        removed.push(listener)
      }
    },
    ...overrides,
  }
  return ipc
}

export async function openSessionOn(gateway: ReturnType<typeof createTauriAgentGateway>): Promise<AgentSession> {
  await gateway.start()
  return gateway.openSession({ vaultId: 'vault-1', cwd: '/vault' })
}

/** Let the adapter's own awaits (the channel registration, the prompt call) finish, so a test
 *  can push a frame at a gateway that is really waiting for one. */
export function settleMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
