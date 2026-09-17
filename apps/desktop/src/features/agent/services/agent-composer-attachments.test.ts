/**
 * The rules a message's attachments are held to: what a file becomes, what a paste becomes, and
 * what is refused.
 *
 * The limits themselves are the editor's (`features/attachments`), and they are imported rather
 * than restated — so what is asserted here is not "the cap is ten" but "the cap is the same one",
 * read through the module that owns it. A test that hardcoded the number would keep passing after
 * the shared constant moved, which is exactly the drift the import exists to prevent.
 */

import { describe, expect, it } from 'vitest'
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_BATCH,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENTS_PER_MESSAGE_BYTES,
} from '../../attachments'
import {
  attachmentKey,
  describeRefusal,
  imageAttachment,
  imagesFromDataTransfer,
  mediaTypeOf,
  mergeAttachments,
  resourceAttachment,
  roomFor,
} from './agent-composer-attachments'

function aFile(path: string, text = '# a'): ReturnType<typeof resourceAttachment> {
  return resourceAttachment(path, text)
}

function anImage(name: string, size = 8): ReturnType<typeof imageAttachment> {
  return imageAttachment(name, 'image/png', 'Q'.repeat(size))
}

describe('what a file becomes', () => {
  it('reads its media type off the extension, not off the browser', () => {
    expect(mediaTypeOf('notes/a.md')).toBe('text/markdown')
    expect(mediaTypeOf('notes/a.ts')).toBe('text/typescript')
    // An extension nobody has a type for falls back to `text/plain` and not to
    // `application/octet-stream`: the block this feeds is built from text, so `text/plain` is the
    // one type that is certainly true, while `octet-stream` would be this app contradicting the
    // payload it just put in the block.
    expect(mediaTypeOf('LICENSE')).toBe('text/plain')
    expect(mediaTypeOf('archive.tar.zst')).toBe('text/plain')
  })

  it('carries the path AND the text, because the block needs both', () => {
    // The path is the URI the host builds; the text is the contents the model is shown. A
    // `resource` attachment that carried only one of them would be a block with an empty body or a
    // block pointing at nothing, and both look like it worked.
    expect(aFile('notes/a.md')).toEqual({
      kind: 'resource',
      path: 'notes/a.md',
      text: '# a',
      mediaType: 'text/markdown',
    })
  })

  it('has no path on an image, because a pasted screenshot has no file', () => {
    expect(anImage('shot.png')).toEqual({
      kind: 'image',
      name: 'shot.png',
      mediaType: 'image/png',
      data: 'QQQQQQQQ',
    })
  })
})

describe('the same thing offered twice', () => {
  it('is one row, keyed by what the reader would recognise', () => {
    expect(attachmentKey(aFile('notes/a.md'))).toBe('resource:notes/a.md')
    expect(attachmentKey(anImage('shot.png'))).toBe('image:shot.png')
  })

  it('replaces the older reading instead of adding a second copy', () => {
    // A file attached, edited, and attached again is one attachment whose text is the newer
    // reading. Two rows for one file would be two blocks in the prompt saying different things
    // about the same path, with nothing on screen to say which is which.
    const merged = mergeAttachments([aFile('notes/a.md', 'old')], [aFile('notes/a.md', 'new')])
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ text: 'new' })
  })

  it('keeps the reader’s order for everything the newcomer did not touch', () => {
    const merged = mergeAttachments(
      [aFile('a.md'), anImage('shot.png'), aFile('b.md')],
      [aFile('a.md', 'again')],
    )
    expect(merged.map(attachmentKey)).toEqual([
      'resource:a.md',
      'image:shot.png',
      'resource:b.md',
    ])
  })
})

describe('what is refused', () => {
  it('counts against what is already held, not against this call', () => {
    const full = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE }, (_, i) => aFile(`${i}.md`))
    expect(roomFor(full, 10, 'x.md')).toEqual({
      reason: 'too-many',
      limit: MAX_ATTACHMENTS_PER_MESSAGE,
    })
    expect(roomFor(full.slice(1), 10, 'x.md')).toBeNull()
  })

  it('refuses one oversized file before it is read', () => {
    expect(roomFor([], MAX_ATTACHMENT_BYTES + 1, 'big.png')).toEqual({
      reason: 'too-large',
      name: 'big.png',
      limit: MAX_ATTACHMENT_BYTES,
    })
    expect(roomFor([], MAX_ATTACHMENT_BYTES, 'big.png')).toBeNull()
  })

  it('refuses what would take the message past its total', () => {
    const held = [anImage('a.png', MAX_ATTACHMENTS_PER_MESSAGE_BYTES - 4)]
    expect(roomFor(held, 8, 'b.png')).toEqual({
      reason: 'no-room',
      limit: MAX_ATTACHMENTS_PER_MESSAGE_BYTES,
    })
  })

  it('is a code, not a sentence, so the surface owns the wording', () => {
    expect(describeRefusal({ reason: 'too-many', limit: 4 }).key).toBe('tooMany')
    expect(describeRefusal({ reason: 'unreadable', name: 'a.png' })).toEqual({
      key: 'unreadable',
      params: { name: 'a.png' },
    })
    // Every arm has a sentence behind it: a refusal with no key would render as nothing at all,
    // which is the failure mode the code-not-sentence rule exists to keep visible.
    for (const refusal of [
      { reason: 'too-many', limit: 4 },
      { reason: 'too-large', name: 'a.png', limit: 10 },
      { reason: 'no-room', limit: 10 },
      { reason: 'unreadable', name: 'a.png' },
    ] as const) {
      expect(describeRefusal(refusal).key).toBeTruthy()
    }
  })
})

describe('what a paste or a drop carries', () => {
  /** A `DataTransfer` with real `File`s in it. The clipboard cannot be constructed in a test, so
   *  the shape the intake reads is built directly — `items` first, `files` as the fallback, which
   *  is the order `collectClipboardImages` reads them in. */
  function transfer(files: File[]): DataTransfer {
    return {
      items: files.map((file) => ({
        kind: 'file',
        type: file.type,
        getAsFile: () => file,
      })),
      files,
    } as unknown as DataTransfer
  }

  function file(name: string, type: string, size = 8): File {
    return new File([new Uint8Array(size)], name, { type })
  }

  it('takes the images and leaves everything else alone', async () => {
    // A paste is one gesture carrying whatever the reader copied: a screenshot, a file, a line of
    // text. Only the image is something this app can send, and the rest is not an error.
    const result = await imagesFromDataTransfer(
      transfer([file('shot.png', 'image/png'), file('notes.md', 'text/markdown')]),
      [],
    )
    expect(result.accepted).toHaveLength(1)
    expect(result.accepted[0]).toMatchObject({ kind: 'image', name: 'shot.png' })
    expect(result.refused).toEqual([])
  })

  it('names a screenshot the clipboard gave no name for', async () => {
    // The clipboard hands over a blob with an empty name when the image came from a screenshot
    // tool, and a chip with no label is a row the reader cannot tell from any other.
    const result = await imagesFromDataTransfer(transfer([file('', 'image/png')]), [])
    expect(result.accepted[0]).toMatchObject({ name: 'pasted-image.png', mediaType: 'image/png' })
  })

  it('refuses past the message’s own budget, per image, so the ones that fit are kept', async () => {
    // The per-file size cap is the shared filter's and it reports its own rejections, so what this
    // module adds is the *message* budget: a batch-level filter cannot know how many attachments
    // the reader has already collected or what they already weigh.
    const held = [anImage('already.png', MAX_ATTACHMENTS_PER_MESSAGE_BYTES - 4)]
    const result = await imagesFromDataTransfer(
      transfer([file('ok.png', 'image/png'), file('also.png', 'image/png')]),
      held,
    )
    expect(result.accepted).toEqual([])
    expect(result.refused).toEqual([
      { reason: 'no-room', limit: MAX_ATTACHMENTS_PER_MESSAGE_BYTES },
      { reason: 'no-room', limit: MAX_ATTACHMENTS_PER_MESSAGE_BYTES },
    ])
  })

  it('carries the shared filter’s own refusals in this module’s vocabulary', async () => {
    // The concrete consequence of the split this module used to have to live with: the intake
    // enforced the per-file cap and reported it through a toast, so an oversize image vanished from
    // a caller that draws its own rows — this one — with nothing it could put in one. The cap is
    // still the intake's; what changed is that it comes back as a *value*, named after the file.
    const result = await imagesFromDataTransfer(
      transfer([file('ok.png', 'image/png'), file('big.png', 'image/png', MAX_ATTACHMENT_BYTES + 1)]),
      [],
    )
    expect(result.accepted.map((a) => (a.kind === 'image' ? a.name : ''))).toEqual(['ok.png'])
    expect(result.refused).toEqual([
      { reason: 'too-large', name: 'big.png', limit: MAX_ATTACHMENT_BYTES },
    ])
  })

  it('carries a batch the intake would not take in one gesture, per file', async () => {
    // The intake's other budgets — ten to a paste, a session running total, a batch byte cap — are
    // not this message's own caps, so they do not borrow `too-many`'s sentence (which names how
    // many THIS message may hold). They are one arm because one thing happened: the paste brought
    // more than the app takes at once.
    const many = Array.from({ length: MAX_ATTACHMENTS_PER_BATCH + 1 }, (_, i) =>
      file(`p${i}.png`, 'image/png'),
    )
    const result = await imagesFromDataTransfer(transfer(many), [])

    // One more than the intake takes in a single gesture, so the last file is the intake's refusal
    // and the message's own cap then takes its own share of what survived. The two are told apart
    // by their arms, which is the point: eleven images pasted at once hit two different limits, and
    // one arm cannot say so.
    expect(result.accepted).toHaveLength(MAX_ATTACHMENTS_PER_MESSAGE)
    expect(result.refused[0]).toEqual({
      reason: 'intake',
      name: `p${MAX_ATTACHMENTS_PER_BATCH}.png`,
    })
    expect(result.refused.slice(1).every((refusal) => refusal.reason === 'too-many')).toBe(true)
    expect(result.refused).toHaveLength(
      1 + MAX_ATTACHMENTS_PER_BATCH - MAX_ATTACHMENTS_PER_MESSAGE,
    )
  })

  it('says nothing when the clipboard carried nothing this app can send', async () => {
    const result = await imagesFromDataTransfer(transfer([file('notes.md', 'text/markdown')]), [])
    expect(result.accepted).toEqual([])
    expect(result.refused).toEqual([])
  })
})
