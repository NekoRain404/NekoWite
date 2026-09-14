import { describe, expect, it } from 'vitest'
import {
  AI_WRITE_POLICIES,
  DEFAULT_AI_PERMISSION,
  decideAiWrite,
  describePolicy,
  grantForSession,
  grantKey,
  isAiEnabled,
  revokeAllGrants,
} from './ai-permissions'
import type {
  AiPermissionState,
  AiWriteDecision,
  AiWriteKind,
  AiWritePolicy,
  AiWriteRequest,
} from './ai-permissions'

const req = (kind: AiWriteKind, extra: Partial<AiWriteRequest> = {}): AiWriteRequest => ({
  kind,
  summary: `AI wants to ${kind}`,
  ...extra,
})

const state = (policy: AiWritePolicy, grants: string[] = []): AiPermissionState => ({
  policy,
  sessionGrants: new Set(grants),
})

const MATRIX: Array<[AiWritePolicy, boolean, AiWriteDecision]> = [
  ['auto', false, 'allow'],
  ['auto', true, 'allow'],
  ['ask', false, 'ask'],
  ['ask', true, 'allow'],
  ['readonly', false, 'deny'],
  ['readonly', true, 'deny'],
]

describe('DEFAULT_AI_PERMISSION', () => {
  it('asks first, with nothing granted', () => {
    expect(DEFAULT_AI_PERMISSION.policy).toBe('ask')
    expect(DEFAULT_AI_PERMISSION.sessionGrants.size).toBe(0)
    expect(decideAiWrite(DEFAULT_AI_PERMISSION, req('insert'))).toBe('ask')
  })
})

describe('AI_WRITE_POLICIES', () => {
  it('lists every policy exactly once, default first', () => {
    expect(AI_WRITE_POLICIES).toEqual(['ask', 'auto', 'readonly'])
    expect(new Set(AI_WRITE_POLICIES).size).toBe(AI_WRITE_POLICIES.length)
  })
})

describe('grantKey', () => {
  it('is stable across different text and targets of the same kind', () => {
    const a = grantKey(req('insert', { summary: 'Add an intro', target: '/v/a.md' }))
    const b = grantKey(req('insert', { summary: 'Append a citation', target: '/v/b.md' }))
    const c = grantKey({ kind: 'insert', summary: 'No target here' })
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  it('keeps the write kinds isolated, so one grant cannot cover the other', () => {
    // A whole-document replacement destroys more than a selection, so approving
    // one kind must never approve another.
    const keys = [
      grantKey(req('insert')),
      grantKey(req('replace-selection')),
      grantKey(req('replace-document')),
    ]
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('does not embed the request text in the key', () => {
    const key = grantKey(req('replace-selection', { summary: 'private draft text' }))
    expect(key).not.toContain('private')
  })
})

describe('the master switch', () => {
  const EVERY_KIND: AiWriteKind[] = ['insert', 'replace-selection', 'replace-document']

  it('starts on, so nothing the user relied on changes by itself', () => {
    expect(isAiEnabled(DEFAULT_AI_PERMISSION)).toBe(true)
    expect(DEFAULT_AI_PERMISSION.enabled).toBe(true)
  })

  it('reads a state written before the switch existed as ON', () => {
    // An install from an older build carries no `enabled` field, and that user
    // had a working AI. Treating the missing field as "off" would break them;
    // only an explicit false may switch AI off.
    const legacy: AiPermissionState = { policy: 'auto', sessionGrants: new Set() }
    expect(isAiEnabled(legacy)).toBe(true)
    expect(decideAiWrite(legacy, req('insert'))).toBe('allow')
  })

  it.each(EVERY_KIND)('refuses a %s write even under the permissive policy', (kind) => {
    const off: AiPermissionState = { policy: 'auto', sessionGrants: new Set(), enabled: false }
    expect(decideAiWrite(off, req(kind))).toBe('deny')
  })

  it('overrides a grant given earlier in the session', () => {
    // The switch is checked before the grant table: "off" must not be undone by
    // a permission the user handed out while it was still on.
    const granted = grantForSession(state('ask'), req('insert'))
    const off: AiPermissionState = { ...granted, enabled: false }
    expect(decideAiWrite(off, req('insert'))).toBe('deny')
  })

  it('leaves the grant set alone, so switching back on restores the session', () => {
    const granted = grantForSession(state('ask'), req('insert'))
    const off: AiPermissionState = { ...granted, enabled: false }
    const on: AiPermissionState = { ...off, enabled: true }
    expect(decideAiWrite(on, req('insert'))).toBe('allow')
  })
})

describe('decideAiWrite', () => {
  it.each(MATRIX)('%s with granted=%s decides %s', (policy, granted, expected) => {
    const grants = granted ? [grantKey(req('insert'))] : []
    expect(decideAiWrite(state(policy, grants), req('insert'))).toBe(expected)
  })

  it('auto allows without any grant, so a grant is never the reason', () => {
    expect(decideAiWrite(state('auto'), req('insert'))).toBe('allow')
    expect(
      decideAiWrite(state('auto', [grantKey(req('replace-selection'))]), req('insert')),
    ).toBe('allow')
  })

  it('readonly denies even when a grant for that kind exists', () => {
    const granted = state('readonly', [grantKey(req('replace-selection'))])
    expect(decideAiWrite(granted, req('replace-selection'))).toBe('deny')
  })

  it('ask allows only the granted kind', () => {
    const granted = state('ask', [grantKey(req('insert'))])
    expect(decideAiWrite(granted, req('insert'))).toBe('allow')
    expect(decideAiWrite(granted, req('replace-selection'))).toBe('ask')
  })

  it('ask ignores grant strings that grantKey never produced', () => {
    const granted = state('ask', ['insert', 'ai-write:INSERT', 'ai-write:replace-selection'])
    expect(decideAiWrite(granted, req('insert'))).toBe('ask')
  })

  it('falls back to ask for a policy it does not recognise', () => {
    const legacy: AiPermissionState = {
      policy: 'agentic' as AiWritePolicy,
      sessionGrants: new Set(),
    }
    expect(decideAiWrite(legacy, req('insert'))).toBe('ask')
  })

  it('does not let an unrecognised policy ride on a session grant', () => {
    const legacy: AiPermissionState = {
      policy: 'agentic' as AiWritePolicy,
      sessionGrants: new Set([grantKey(req('insert'))]),
    }
    expect(decideAiWrite(legacy, req('insert'))).toBe('ask')
  })

  it('falls back to ask when the policy is missing entirely', () => {
    const blob = { sessionGrants: new Set<string>() } as unknown as AiPermissionState
    expect(decideAiWrite(blob, req('insert'))).toBe('ask')
  })

  it('treats a missing grant set as no grants', () => {
    const blob = { policy: 'ask' } as unknown as AiPermissionState
    expect(decideAiWrite(blob, req('insert'))).toBe('ask')
  })
})

describe('grantForSession', () => {
  it('adds the grant and leaves the input state untouched', () => {
    const before = state('ask')
    const after = grantForSession(before, req('insert'))
    expect(after).not.toBe(before)
    expect(after.policy).toBe('ask')
    expect(after.sessionGrants.has(grantKey(req('insert')))).toBe(true)
    expect(before.sessionGrants.size).toBe(0)
  })

  it('does not mutate a grant set it was handed', () => {
    const shared = new Set([grantKey(req('replace-selection'))])
    grantForSession({ policy: 'ask', sessionGrants: shared }, req('insert'))
    expect(shared.size).toBe(1)
    expect(shared.has(grantKey(req('insert')))).toBe(false)
  })

  it('turns the granted kind into an allow while the other kind still asks', () => {
    const granted = grantForSession(state('ask'), req('insert'))
    expect(decideAiWrite(granted, req('insert'))).toBe('allow')
    expect(decideAiWrite(granted, req('replace-selection'))).toBe('ask')
  })

  it('is idempotent for the same kind', () => {
    const once = grantForSession(state('ask'), req('insert'))
    const twice = grantForSession(once, req('insert'))
    expect(twice.sessionGrants.size).toBe(1)
  })

  it('grants into a legacy state that has no grant set yet', () => {
    const legacy = { policy: 'ask' } as unknown as AiPermissionState
    const granted = grantForSession(legacy, req('insert'))
    expect(granted.policy).toBe('ask')
    expect(decideAiWrite(granted, req('insert'))).toBe('allow')
  })
})

describe('revokeAllGrants', () => {
  it('drops every grant and leaves the input state untouched', () => {
    const before = state('ask', [grantKey(req('insert')), grantKey(req('replace-selection'))])
    const after = revokeAllGrants(before)
    expect(after).not.toBe(before)
    expect(after.sessionGrants.size).toBe(0)
    expect(before.sessionGrants.size).toBe(2)
  })

  it('keeps the policy, so readonly stays readonly and auto keeps writing', () => {
    expect(revokeAllGrants(state('auto', [grantKey(req('insert'))])).policy).toBe('auto')
    expect(revokeAllGrants(state('readonly')).policy).toBe('readonly')
  })

  it('sends the next write back through the prompt', () => {
    const granted = grantForSession(state('ask'), req('insert'))
    expect(decideAiWrite(revokeAllGrants(granted), req('insert'))).toBe('ask')
  })

  it('does not mutate a grant set it was handed', () => {
    const shared = new Set([grantKey(req('insert'))])
    revokeAllGrants({ policy: 'ask', sessionGrants: shared })
    expect(shared.size).toBe(1)
  })
})

describe('describePolicy', () => {
  it.each([
    ['ask', 'aiperm.policyAsk'],
    ['auto', 'aiperm.policyAuto'],
    ['readonly', 'aiperm.policyReadonly'],
  ] as Array<[AiWritePolicy, string]>)('returns the i18n key for %s', (policy, key) => {
    expect(describePolicy(policy)).toBe(key)
  })

  it('returns keys rather than user-facing wording', () => {
    for (const policy of AI_WRITE_POLICIES) {
      const key = describePolicy(policy)
      // A key, not user-facing wording. Deliberately not pinned to a nested
      // shape: the locales define these as flat keys, and the point is that
      // this module never returns prose.
      expect(key).toMatch(/^aiperm\.policy/)
      expect(key).not.toMatch(/\s/)
    }
  })

  it('gives every policy a distinct key', () => {
    const keys = AI_WRITE_POLICIES.map((policy) => describePolicy(policy))
    expect(new Set(keys).size).toBe(AI_WRITE_POLICIES.length)
  })

  it('describes an unknown policy as ask, the decision it would produce', () => {
    expect(describePolicy('agentic' as AiWritePolicy)).toBe('aiperm.policyAsk')
  })
})
