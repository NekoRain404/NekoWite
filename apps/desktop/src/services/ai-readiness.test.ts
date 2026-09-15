import { describe, expect, it } from 'vitest'
import { isAiConfigured, type AiReadiness } from './ai-readiness'

/**
 * The predicate on its own, held to the four states the ghost writer's gate
 * meets.
 *
 * A hosted provider is configured when a credential is present, and a
 * credential is present in exactly two ways: typed into the settings field this
 * session, or stored in the vault. The second arm is the one the first arm
 * cannot stand in for — the store empties the field the moment a stored key
 * arrives, so after a restart a configured install has an empty field and only
 * the vault's answer left to go on.
 */

function readiness(over: Partial<AiReadiness> = {}): AiReadiness {
  return { provider: 'anthropic', baseUrl: '', apiKey: '', ...over }
}

describe('isAiConfigured', () => {
  it('counts a key stored in the vault as a credential, with the field empty', () => {
    expect(isAiConfigured(readiness({ apiKey: '', keyConfigured: true }))).toBe(true)
  })

  it('counts a key typed this session but not yet saved', () => {
    expect(isAiConfigured(readiness({ apiKey: 'sk-just-typed' }))).toBe(true)
  })

  it('does not count an empty field with nothing stored — the fresh install', () => {
    // The regression to watch: this must never become "always configured", or
    // every Tab press on an install with no AI set up asks a provider that
    // cannot answer.
    expect(isAiConfigured(readiness({ apiKey: '', keyConfigured: false }))).toBe(false)
    expect(isAiConfigured(readiness({ apiKey: '', keyConfigured: undefined }))).toBe(false)
  })

  it('does not count a blank or whitespace-only field as a key', () => {
    expect(isAiConfigured(readiness({ apiKey: '   ' }))).toBe(false)
  })

  it('still refuses a local/custom endpoint with no Base URL, key or no key', () => {
    // local/custom talk to a user-run server and are addressed by URL, so a
    // credential does not make them reachable — unchanged by the key fix.
    for (const provider of ['local', 'custom']) {
      expect(isAiConfigured(readiness({ provider, baseUrl: '', keyConfigured: true }))).toBe(false)
      expect(
        isAiConfigured({
          provider,
          baseUrl: 'http://localhost:1234/v1',
          apiKey: '',
          keyConfigured: false,
        }),
      ).toBe(true)
    }
  })
})
