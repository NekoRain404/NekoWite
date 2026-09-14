import { describe, expect, it } from 'vitest'
import {
  detectLineEnding,
  readDocumentEnvelope,
  splitFrontmatter,
  writeDocumentEnvelope,
} from './document-envelope'

/**
 * The envelope decisions, at the level they are made.
 *
 * The end-to-end consequence of each one is asserted in `editor.test.ts` and
 * `mdx/byte-fidelity.test.ts`; what is pinned here is the RULE, so a change to it
 * is a visible decision rather than a drift in some other file's expectations.
 */

describe('the line ending a document is written in', () => {
  it('is LF for a file with no line ending at all', () => {
    expect(detectLineEnding('')).toBe('\n')
    expect(detectLineEnding('one line, no break')).toBe('\n')
  })

  it('is the file’s own ending when the file is consistent', () => {
    expect(detectLineEnding('one\ntwo\n')).toBe('\n')
    expect(detectLineEnding('one\r\ntwo\r\n')).toBe('\r\n')
  })

  it('follows the majority when the file is mixed', () => {
    expect(detectLineEnding('one\r\ntwo\r\nthree\n')).toBe('\r\n')
    expect(detectLineEnding('one\ntwo\nthree\r\n')).toBe('\n')
  })

  it('is LF when the two are tied, and for a CR-only file', () => {
    // A tie is not a convention: LF is what the serializer writes natively, so
    // it is the one that costs nothing.
    expect(detectLineEnding('one\r\ntwo\n')).toBe('\n')
    // A lone CR is not one of the two endings this editor writes: micromark may
    // read it as a line ending, but nothing downstream does, so a CR-only file
    // is not a CRLF file (classic-Mac endings are normalised, deliberately).
    expect(detectLineEnding('one\rtwo\r')).toBe('\n')
  })

  it('counts a CRLF once, for its own ending', () => {
    // The bug this guards: counting every `\n` as an LF would make a file that
    // is entirely CRLF look like a 50/50 mix and rewrite it as LF.
    expect(detectLineEnding('---\r\ntitle: x\r\n---\r\n\r\nbody\r\n')).toBe('\r\n')
  })
})

describe('reading and writing a document’s envelope', () => {
  it('keeps a BOM out of the body and puts it back byte for byte', () => {
    const envelope = readDocumentEnvelope('﻿# Title\n\nbody\n')
    expect(envelope.bom).toBe(true)
    expect(envelope.body).toBe('# Title\n\nbody\n')
    expect(writeDocumentEnvelope(envelope, envelope.body)).toBe('﻿# Title\n\nbody\n')
  })

  it('is not a BOM when it is not at the very start', () => {
    expect(readDocumentEnvelope('# a﻿b\n').bom).toBe(false)
  })

  it('finds the frontmatter behind a BOM', () => {
    // The BOM is not part of the `---` line, so a reader that slices the source
    // before stripping it sees no frontmatter at all and parses the block as
    // prose (a thematic break and a setext heading) — which is how a BOM file
    // with frontmatter came back rewritten.
    const envelope = readDocumentEnvelope('﻿---\ntitle: x\n---\n\nbody\n')
    expect(envelope.front).toBe('---\ntitle: x\n---\n\n')
    expect(envelope.body).toBe('body\n')
  })

  it('writes the frontmatter in the document’s own ending', () => {
    const envelope = readDocumentEnvelope('---\r\ntitle: x\r\n---\r\n\r\nbody\r\n')
    expect(envelope.eol).toBe('\r\n')
    expect(writeDocumentEnvelope(envelope, 'body\r\n')).toBe(
      '---\r\ntitle: x\r\n---\r\n\r\nbody\r\n',
    )
  })

  it('rewrites a minority frontmatter so the file is one ending end to end', () => {
    // The everyday M1 shape: a CRLF block glued to a body the serializer writes
    // in LF. The body is the majority, so the frontmatter is what moves — the
    // alternative is a file that is internally inconsistent after a save.
    const envelope = readDocumentEnvelope('---\r\ntitle: x\r\n---\r\n\r\nb1\nb2\nb3\nb4\nb5\n')
    expect(envelope.eol).toBe('\n')
    expect(writeDocumentEnvelope(envelope, envelope.body)).toBe(
      '---\ntitle: x\n---\n\nb1\nb2\nb3\nb4\nb5\n',
    )
  })

  it('never touches an LF body’s bytes', () => {
    // A CRLF the MODEL carries as content (the value of a code block) is not a
    // line ending this editor gets to normalise: rewriting it would be the
    // silent byte rewrite the CRLF handling exists to stop.
    const body = '```\ncode one\r\ncode two\n```\n'
    const envelope = readDocumentEnvelope(body)
    expect(envelope.eol).toBe('\n')
    expect(writeDocumentEnvelope(envelope, body)).toBe(body)
  })

  it('writes a CRLF document in CRLF throughout', () => {
    const envelope = readDocumentEnvelope('one\r\ntwo\r\n')
    expect(writeDocumentEnvelope(envelope, 'one\ntwo\n')).toBe('one\r\ntwo\r\n')
  })

  it('preserves a frontmatter-only file and an empty one', () => {
    for (const input of [
      '---\ntitle: x\n---',
      '---\ntitle: x\n---\n',
      '---\ntitle: x\n---\n\n',
      '',
    ]) {
      const envelope = readDocumentEnvelope(input)
      expect(writeDocumentEnvelope(envelope, envelope.body)).toBe(input)
    }
    // A file that is nothing but a BOM is still that file.
    const bomOnly = readDocumentEnvelope('﻿')
    expect(writeDocumentEnvelope(bomOnly, bomOnly.body)).toBe('﻿')
  })
})

describe('splitFrontmatter', () => {
  it('still answers with the raw block and the body behind it', () => {
    expect(splitFrontmatter('---\ntitle: x\n---\n\nbody\n')).toEqual({
      front: '---\ntitle: x\n---\n\n',
      body: 'body\n',
    })
    expect(splitFrontmatter('# body\n')).toEqual({ front: '', body: '# body\n' })
  })
})
