import { describe, expect, it } from 'vitest'
import {
  buildPluginSignaturePayload,
  createPluginSignature,
  encodePluginKeyMaterial,
  publisherIdOf,
  verifyPluginSignature,
} from './loader'

// A fixed NFC-normalized payload for determinism.
function payload(): string {
  return buildPluginSignaturePayload('@scope/note', '1.0.0', 'index.js', 'export default {}', ['fs', 'ai'])
}

describe('publisherIdOf', () => {
  it('attributes a scoped plugin to its scope', () => {
    expect(publisherIdOf('@scope/note')).toBe('@scope')
  })

  it('attributes an unscoped plugin to itself', () => {
    expect(publisherIdOf('note')).toBe('note')
  })
})

describe('buildPluginSignaturePayload', () => {
  it('is deterministic for the same inputs', () => {
    expect(payload()).toBe(payload())
  })

  it('is canonical: permission order does not change the payload', () => {
    const a = buildPluginSignaturePayload('@scope/note', '1.0.0', 'index.js', 'export default {}', ['fs', 'ai'])
    const b = buildPluginSignaturePayload('@scope/note', '1.0.0', 'index.js', 'export default {}', ['ai', 'fs'])
    expect(a).toBe(b)
  })

  it('is sensitive to code and manifest identity', () => {
    const a = buildPluginSignaturePayload('@scope/note', '1.0.0', 'index.js', 'export default {}', undefined)
    const b = buildPluginSignaturePayload('@scope/note', '2.0.0', 'index.js', 'export default {}', undefined)
    const c = buildPluginSignaturePayload('@scope/note', '1.0.0', 'index.js', 'export default {x:1}', undefined)
    expect(a).not.toBe(b)
    expect(a).not.toBe(c)
  })
})

describe('encodePluginKeyMaterial', () => {
  it('decodes an even-length hex key to raw bytes', () => {
    const bytes = encodePluginKeyMaterial('4e656b6f')
    expect(bytes.length).toBe(4)
    expect(Array.from(bytes)).toEqual([0x4e, 0x65, 0x6b, 0x6f])
  })

  it('uses UTF-8 bytes for a non-hex secret', () => {
    const bytes = encodePluginKeyMaterial('neko-secret')
    expect(Array.from(bytes)).toEqual(Array.from(new TextEncoder().encode('neko-secret')))
  })
})

describe('verifyPluginSignature (HMAC-SHA256, shared-secret key)', () => {
  const KEY = '4e656b6f2d6b6579' // hex-like secret
  const OTHER_KEY = 'deadbeefdeadbeef'

  it('accepts a valid signature', async () => {
    const sig = await createPluginSignature(payload(), KEY)
    await expect(verifyPluginSignature(sig, payload(), KEY)).resolves.toBe(true)
  })

  it('refuses a signature produced with a different key', async () => {
    const sig = await createPluginSignature(payload(), KEY)
    await expect(verifyPluginSignature(sig, payload(), OTHER_KEY)).resolves.toBe(false)
  })

  it('refuses when the payload has been tampered with', async () => {
    const sig = await createPluginSignature(payload(), KEY)
    const tampered = buildPluginSignaturePayload('@scope/note', '2.0.0', 'index.js', 'export default {}', ['fs', 'ai'])
    await expect(verifyPluginSignature(sig, tampered, KEY)).resolves.toBe(false)
  })

  it('refuses a malformed (non-hex) signature rather than throwing', async () => {
    await expect(verifyPluginSignature('zzzz', payload(), KEY)).rejects.toThrow()
  })
})
