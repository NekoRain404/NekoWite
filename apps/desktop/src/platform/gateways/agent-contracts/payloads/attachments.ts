/**
 * What a prompt carries beside its text.
 *
 * The one part of this vocabulary that travels *to* the engine rather than from it, which is why the
 * capability question that gates it (`promptCapabilities`) is asked at send time instead of being
 * encoded in these types. It changes when the blocks a client may attach change — and the two kinds
 * are exactly the two ACP defines for a client under a capability, so that is a schema change rather
 * than an app one.
 */

/**
 * The kinds of thing a prompt can carry beside its text.
 *
 * Two, and they are the two ACP defines a *client* may attach under a capability: `resource` is
 * `ContentBlock::Resource` (a file's contents, embedded whole, which the schema requires
 * `promptCapabilities.embeddedContext` for) and `image` is `ContentBlock::Image`
 * (`promptCapabilities.image`). Exported as a value for the caller that has to judge a foreign
 * value and for the tests that hold it to each kind, the way {@link AGENT_STOP_REASONS} is.
 */
export const AGENT_PROMPT_ATTACHMENT_KINDS = ['resource', 'image'] as const

/**
 * One thing a turn carries beside its words.
 *
 * **The contents travel; a name alone would not.** Both arms carry what the model is to be shown —
 * a file's text, an image's bytes — because the question a reader is asking when they attach
 * something is whether the model *saw* it, and a path is not an answer to that. Whether the block
 * may be sent at all is the engine's own report rather than this type's business: the handshake's
 * `promptCapabilities` decides, the host reads it at send time, and a window that drew the control
 * has already asked the same report (see the agent feature's capability gate).
 *
 * `resource.path` is vault-relative and `/`-separated — the spelling the reader was shown and the
 * one the workspace is addressed by — while the host turns it into the absolute `file:` URI the
 * block carries. The two are different on purpose: a `file:` URI is a whole path or it is not a
 * URI, and the composer only ever knows the workspace-relative one.
 *
 * `image.data` is base64 with no `data:` prefix, which is what ACP's `ImageContent.data` holds.
 * There is no path on that arm: a pasted screenshot has no file behind it, and inventing one would
 * be claiming a file exists.
 */
export type AgentPromptAttachment =
  | {
      readonly kind: 'resource'
      /** Vault-relative and `/`-separated: what the block's URI is built from. */
      readonly path: string
      /** The file's text, as the window read it when the reader attached it. */
      readonly text: string
      /** The media type the file's extension implies, for the block's `mimeType`. */
      readonly mediaType: string
    }
  | {
      readonly kind: 'image'
      /** What to call it: the dropped file's name, or a generated one for a paste. */
      readonly name: string
      readonly mediaType: string
      /** Base64, with no `data:` prefix. */
      readonly data: string
    }

/**
 * What an attachment is called wherever a person reads it — a chip, a notice, a refusal.
 *
 * One function rather than two field reads at each surface, because the two arms do not share a
 * field name (`path` against `name`) and a caller that guessed would show a blank label for
 * whichever arm it guessed wrong about.
 */
export function promptAttachmentLabel(attachment: AgentPromptAttachment): string {
  return attachment.kind === 'resource' ? attachment.path : attachment.name
}
