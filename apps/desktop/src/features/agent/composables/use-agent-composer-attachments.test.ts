/**
 * What the composer's own pick does to the message, asserted on the block it holds.
 *
 * A file reached from the `+` or the `@` list may be one of two things, and which one it becomes is
 * a fact about the *file*: a note is read as text and embedded whole, and an image is read as bytes
 * and carried as an image. The window has a reader for each — `fsService.read` for the first, the
 * media channel (`readVaultImageBase64`) for the second — and this suite is about the routing
 * between them, because a router that sent every pick down the text arm is exactly the state this
 * feature shipped in and it is invisible from the chip strip alone: a chip is drawn either way.
 *
 * So the assertion here is the attachment itself, deep-equal, and specifically its `kind`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_CAPABILITY_HOST_OFFERS,
  type AgentCapabilityFeature,
  type AgentCapabilityReport,
} from '../../../platform/gateways/agent-contracts'
import { setLocale } from '../../../i18n'
import { onNotify } from '../../../services/errors'
import { useAgentComposerAttachments } from './use-agent-composer-attachments'

const statMock = vi.hoisted(() => vi.fn())
const readMock = vi.hoisted(() => vi.fn())
const resolveMediaPathMock = vi.hoisted(() => vi.fn())

vi.mock('../../../platform/gateways/fs', () => ({
  fsService: {
    stat: statMock,
    read: readMock,
    resolveMediaPath: resolveMediaPathMock,
  },
}))

const VAULT = '/home/user/vault'

/** A one-row report. A feature the report does not name is `unreported`, which is a refusal — so a
 *  row has to be spelled out for a control to exist at all. */
function report(...features: AgentCapabilityFeature[]): AgentCapabilityReport[] {
  return features.map((feature) => ({
    feature,
    declared: 'advertised' as const,
    finding: { status: 'available' } as const,
    host: AGENT_CAPABILITY_HOST_OFFERS[feature],
  }))
}

function served(bytes: number[], ok = true, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok,
      status,
      blob: async () => new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
    })),
  )
}

let notices: string[]
let stopNotifying: () => void

function intake(...features: AgentCapabilityFeature[]): ReturnType<typeof useAgentComposerAttachments> {
  return useAgentComposerAttachments({
    capabilities: () => report(...features),
    vault: () => VAULT,
  })
}

beforeEach(() => {
  statMock.mockReset()
  readMock.mockReset()
  resolveMediaPathMock.mockReset()
  resolveMediaPathMock.mockResolvedValue('asset://localhost/home/user/vault/attachments/a.png')
  notices = []
  stopNotifying = onNotify((message) => notices.push(message))
})

afterEach(() => {
  stopNotifying()
  vi.unstubAllGlobals()
})

describe('a picked image', () => {
  it('is held as an image block carrying the vault file’s own bytes', async () => {
    // The whole of the work order in one assertion: the block's `kind` says which ACP arm it will
    // travel on, and `data` is the file's bytes as base64 — read through the media channel, which
    // is the only reader the window has for a file that is not text.
    statMock.mockResolvedValue({ size: 3, mtime: 0 })
    served([65, 66, 67])
    const attachments = intake('image-attachments')

    await expect(attachments.attachFile('attachments/knowledge-base-diagram.png')).resolves.toBe(
      'attached',
    )

    expect(attachments.held.value).toEqual([
      {
        kind: 'image',
        name: 'knowledge-base-diagram.png',
        mediaType: 'image/png',
        data: 'QUJD',
      },
    ])
    expect(resolveMediaPathMock).toHaveBeenCalledWith(VAULT, 'attachments/knowledge-base-diagram.png')
  })

  it('never goes down the text reader, which cannot answer for an image', async () => {
    // The route that shipped: `fs.read` is `std::fs::read_to_string` on the host, so every image
    // came back as a refusal and the reader was told the file was unreadable. A router that reads
    // text first and asks questions later would still call it.
    statMock.mockResolvedValue({ size: 3, mtime: 0 })
    served([65])
    readMock.mockRejectedValue(new Error('stream did not contain valid UTF-8'))
    const attachments = intake('image-attachments')

    await attachments.attachFile('shot.png')

    expect(readMock).not.toHaveBeenCalled()
    expect(attachments.held.value).toHaveLength(1)
  })

  it('falls back to its path in the message, and reads no byte, where the engine reads no images', async () => {
    // An image is licensed by a different feature of the report than a note is, and a path is text
    // on every engine — so the same row that carries a note's contents where it can still names the
    // image's path where it cannot, and the turn is not empty-handed. What must NOT happen is a
    // read: the gate is answered before the bytes are, which is this module's stated ordering.
    statMock.mockResolvedValue({ size: 3, mtime: 0 })
    served([65])
    const attachments = intake('embedded-context')

    await expect(attachments.attachFile('shot.png')).resolves.toBe('path-in-message')

    expect(attachments.held.value).toEqual([])
    expect(resolveMediaPathMock).not.toHaveBeenCalled()
    expect(statMock).not.toHaveBeenCalled()
    expect(notices).toEqual([])
  })

  it('is refused against the message’s budget before the file is fetched', async () => {
    // The size is asked for first so an image that cannot fit is refused as too large rather than
    // read and then thrown away — the same ordering the paste path takes with `File.size`.
    statMock.mockResolvedValue({ size: 20 * 1024 * 1024, mtime: 0 })
    served([65])
    const attachments = intake('image-attachments')

    // Refused, and NOT downgraded to a path: the reader asked for the file's contents to travel,
    // and a path would be this window quietly sending something else.
    await expect(attachments.attachFile('huge.png')).resolves.toBe('refused')

    expect(attachments.held.value).toEqual([])
    expect(resolveMediaPathMock).not.toHaveBeenCalled()
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('huge.png')
  })

  it('says the file could not be read when the media channel will not serve it', async () => {
    statMock.mockResolvedValue({ size: 3, mtime: 0 })
    resolveMediaPathMock.mockRejectedValue(new Error('refusing to serve shot.png: asset:// only serves media files'))
    const attachments = intake('image-attachments')

    await attachments.attachFile('shot.png')

    expect(attachments.held.value).toEqual([])
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('shot.png')
  })
})

describe('a picked image this app has no reader for', () => {
  // The assertions below are on the *sentence*, because the sentence is the whole of what was
  // wrong: the route was refused either way, and only the reason the reader was given was false.
  // Read in English so the assertion can name the words; the catalogue's other language carries
  // the same key (see `i18n.test.ts`).
  beforeEach(() => {
    setLocale('en')
  })

  it('is refused for its format, and the text reader is never asked about it', async () => {
    // `attachments/scan.tiff` is a file the app itself puts in a vault: the importer's allowlist
    // (`apps/desktop/src-tauri/src/storage/attachment_store.rs`'s `IMPORT_IMAGE_EXTENSIONS`) is
    // wider than this window's, deliberately — a vault is the reader's own folder. The picker's
    // routing predicate reads only this window's list, so it sent the file down the TEXT arm,
    // whose reader is `read_to_string`: the app told the reader a file it had just imported was
    // "unreadable", naming a reason that was not the reason.
    readMock.mockRejectedValue(new Error('stream did not contain valid UTF-8'))
    const attachments = intake('image-attachments', 'embedded-context')

    await expect(attachments.attachFile('attachments/scan.tiff')).resolves.toBe('refused')

    // Not read at all. The reason is the file's *format*, and the path the reader picked carries
    // it, so asking a reader that refuses every image is how the wrong sentence was written.
    expect(readMock).not.toHaveBeenCalled()
    expect(attachments.held.value).toEqual([])
    expect(notices).toEqual([
      'attachments/scan.tiff was not attached: this app attaches only the image formats it can read (PNG, JPG, JPEG, GIF, WEBP, BMP, AVIF, SVG), and this file is not one of them. Convert it to one of them and attach it again — pasting and dropping take the same list.',
    ])
  })

  it('still travels as its path where the engine reads no images', async () => {
    // The other engine: the report licenses no image block, so the pick has always travelled as
    // its path and a `.tiff` is no different from a `.png` there. A sentence about a format the
    // reader never needed would be this window's own opinion rather than a fact about the turn.
    readMock.mockRejectedValue(new Error('stream did not contain valid UTF-8'))
    const attachments = intake('embedded-context')

    await expect(attachments.attachFile('attachments/scan.tiff')).resolves.toBe('path-in-message')

    expect(attachments.held.value).toEqual([])
    expect(readMock).not.toHaveBeenCalled()
    expect(notices).toEqual([])
  })

  it('leaves a binary that is not an image refused as unreadable, which is true of it', async () => {
    // The guard on the new arm: it is about images. A `.pdf` is neither an image nor text, and
    // the window has no reader for it — "unreadable" is the honest sentence there, so the new
    // reason must not swallow every unknown extension.
    readMock.mockRejectedValue(new Error('stream did not contain valid UTF-8'))
    const attachments = intake('image-attachments', 'embedded-context')

    await expect(attachments.attachFile('attachments/paper.pdf')).resolves.toBe('refused')

    expect(attachments.held.value).toEqual([])
    expect(notices).toEqual([
      'attachments/paper.pdf could not be read, so there is nothing to send in it.',
    ])
  })
})

describe('a paste before the engine has answered', () => {
  // The sentence is the whole of what is asserted here, and that is not a shortcut: the file is
  // refused either way, and the panel's `null` — what `AgentGateway.capabilities` leaves behind
  // when it rejects — is the state a *reader* hits, because the report arrives after this component
  // mounts. Read in English so the assertion can name the words (the catalogue's other language
  // carries the same key); the `detail` inside the braces is the service's own.
  beforeEach(() => {
    setLocale('en')
  })

  /** A clipboard carrying one image: all `addFromTransfer` looks at before it reads any bytes. */
  function paste(name = 'shot.png'): DataTransfer {
    const file = new File(['x'], name, { type: 'image/png' })
    const item = { kind: 'file', type: 'image/png', getAsFile: () => file }
    return {
      items: [item] as unknown as DataTransferItemList,
      files: [file] as unknown as FileList,
    } as unknown as DataTransfer
  }

  /** The same intake, with the whole report replaced by what the case is about. */
  function overReport(
    reports: readonly AgentCapabilityReport[] | null,
  ): ReturnType<typeof useAgentComposerAttachments> {
    return useAgentComposerAttachments({ capabilities: () => reports, vault: () => VAULT })
  }

  it('does not name a report nobody holds, and says nothing has answered instead', async () => {
    // The two states `AgentPanel` keeps apart — and that both consumers used to fold together with
    // a `?? []`, which made this sentence unreachable. Written from the reader's side because that
    // is where the difference is: the refusal is the same act, and what they are told about it is
    // not.
    const nothing = overReport(null)
    await nothing.addFromTransfer(paste())
    // An engine whose report arrived and names no such feature: the other `unreported`, and the
    // other sentence.
    const empty = overReport([])
    await empty.addFromTransfer(paste())

    expect(notices).toHaveLength(2)
    expect(notices[0]).toContain('shot.png')
    expect(notices[0]).toContain('has not answered')
    expect(notices[1]).toContain('names no such feature')
    expect(notices[0]).not.toBe(notices[1])
    // And neither paste put anything in the message: no report licensed a block, so none was built.
    expect(nothing.held.value).toEqual([])
    expect(empty.held.value).toEqual([])
  })

  it('builds no block for either, which is the half the two states do agree on', async () => {
    // The two `unreported`s differ in what the reader is *told*; what they agree on is that nothing
    // may travel. Read through the public surface — a picked note answers `path-in-message` and the
    // workspace is never read at all — rather than through the standings themselves, which are the
    // composable's private vocabulary now: nothing outside it ever read one, and a value published
    // for a caller that does not exist is a claim rather than a feature. The case used to assert
    // "draws no control for either", which named a control this composable has never drawn.
    const nothing = overReport(null)
    expect(await nothing.attachFile('welcome.md')).toBe('path-in-message')
    const empty = overReport([])
    expect(await empty.attachFile('welcome.md')).toBe('path-in-message')

    expect(readMock).not.toHaveBeenCalled()
    expect(nothing.held.value).toEqual([])
    expect(empty.held.value).toEqual([])
  })
})

describe('a picked note', () => {
  it('is still read as text and embedded whole', async () => {
    // The other arm, unchanged — and the guard that matters most here, because the routing added
    // for images is one predicate away from sending every note down the byte reader.
    readMock.mockResolvedValue('# welcome')
    const attachments = intake('embedded-context')

    await expect(attachments.attachFile('welcome.md')).resolves.toBe('attached')

    expect(attachments.held.value).toEqual([
      { kind: 'resource', path: 'welcome.md', text: '# welcome', mediaType: 'text/markdown' },
    ])
    expect(resolveMediaPathMock).not.toHaveBeenCalled()
  })

  it('still falls back to its path where embedded files are not read', async () => {
    // The behaviour this app shipped before images could be picked, and the one the image arm was
    // made to match: it is the *same* row, so it does the same thing for the same reason.
    readMock.mockResolvedValue('# welcome')
    const attachments = intake('image-attachments')

    await expect(attachments.attachFile('welcome.md')).resolves.toBe('path-in-message')

    expect(attachments.held.value).toEqual([])
    expect(readMock).not.toHaveBeenCalled()
    expect(notices).toEqual([])
  })
})
