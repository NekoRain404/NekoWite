import assert from 'node:assert/strict'
import { test } from 'node:test'
import { verify } from './verify.mjs'

test('an isolated focus probe does not require the agent-scroll probe', () => {
  const result = verify({ agent: true, only: 'focus-ring', probes: {} })
  assert.equal(result.results.some((check) => check.name.includes('nothing measured it')), false)
})

test('an explicitly requested agent-scroll probe must produce a result', () => {
  const result = verify({ agent: true, only: 'agent-scroll', probes: {} })
  assert.equal(result.results.some((check) => check.name.includes('nothing measured it') && !check.holds), true)
})

test('a full agent run still requires agent-scroll measurements', () => {
  const result = verify({ agent: true, probes: {} })
  assert.equal(result.results.some((check) => check.name.includes('nothing measured it') && !check.holds), true)
})
