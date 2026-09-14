/**
 * How the frontend learns WHY a write was refused.
 *
 * The backend already answers a read-only save with a sentence that names the
 * reason, that the file is untouched, and the one thing that unblocks it. The
 * sentence is not the signal: copy changes, and a test (or a branch) that
 * pattern-matches it breaks on the day someone rewords the toast — this
 * programme has already paid for that class of coupling more than once. The
 * reason travels as a token in front of the sentence, the way
 * `errors::ALREADY_EXISTS_PREFIX` already carries "the name is taken" from Rust
 * to `platform/create-new-file.ts`, and the prose after it is free to change.
 */

import { describe, expect, it } from 'vitest'
import { READ_ONLY_PREFIX, classifyWriteRefusal, copyNameFor, withoutRefusalToken } from './write-refusal'

/** The refusal `write_file` produces today, verbatim (task-55 report §"What the
 *  user sees"; the unix `(mode …)` half is part of it). */
const REFUSAL =
  'could not replace /vault/ro.md: the file is read-only (mode 0444), so it was ' +
  'left untouched; clear the read-only permission to save over it, or save it ' +
  'under a different name'

describe('classifyWriteRefusal', () => {
  it('reads the token the backend puts in front of a read-only refusal', () => {
    // The literal is deliberate: it is the Rust side's `READ_ONLY_PREFIX`, and
    // this test is the place the two spellings are held together.
    expect(READ_ONLY_PREFIX).toBe('EREADONLY: ')
    expect(classifyWriteRefusal(`${READ_ONLY_PREFIX}${REFUSAL}`)).toBe('read-only')
  })

  it('does not treat the sentence alone as the reason', () => {
    // If this ever passes, the coupling is back: the classifier would start
    // depending on prose that is free to change.
    expect(classifyWriteRefusal(REFUSAL)).toBe('none')
  })

  it('still classifies when the sentence is reworded underneath the token', () => {
    expect(classifyWriteRefusal(`${READ_ONLY_PREFIX}whatever the copy becomes`)).toBe('read-only')
  })

  it('classifies an ordinary failure, an Error, and junk as none', () => {
    expect(classifyWriteRefusal('disk full')).toBe('none')
    expect(classifyWriteRefusal(new Error('disk full'))).toBe('none')
    expect(classifyWriteRefusal(undefined)).toBe('none')
    // An Error whose message carries the token is still the same refusal: Tauri
    // rejects with the raw string, but a wrapper that makes an Error of it must
    // not lose the reason.
    expect(classifyWriteRefusal(new Error(`${READ_ONLY_PREFIX}${REFUSAL}`))).toBe('read-only')
  })
})

describe('withoutRefusalToken', () => {
  it('strips the token so a caller can show or log the backend sentence', () => {
    expect(withoutRefusalToken(`${READ_ONLY_PREFIX}${REFUSAL}`)).toBe(REFUSAL)
  })

  it('leaves a message without a token alone', () => {
    expect(withoutRefusalToken('disk full')).toBe('disk full')
    // Only a LEADING token is a refusal; the phrase inside a sentence is not.
    expect(withoutRefusalToken(`saved: ${READ_ONLY_PREFIX}x`)).toBe(`saved: ${READ_ONLY_PREFIX}x`)
  })
})

describe('copyNameFor', () => {
  it('marks the name so the dialog does not default back to the refused file', () => {
    expect(copyNameFor('/vault/notes/ro.md')).toBe('ro (copy).md')
    expect(copyNameFor('C:\\vault\\ro.md')).toBe('ro (copy).md')
  })

  it('handles a name with no extension and a dot-file', () => {
    expect(copyNameFor('/vault/README')).toBe('README (copy)')
    expect(copyNameFor('/vault/.hidden')).toBe('.hidden (copy)')
  })
})
