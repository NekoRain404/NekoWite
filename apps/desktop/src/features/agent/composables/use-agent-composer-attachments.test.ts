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
import type {
  AgentCapabilityFeature,
  AgentCapabilityReport,
} from '../../../platform/gateways/agent-contracts'
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
