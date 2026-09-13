/**
 * The attachments feature's public API.
 *
 * Nothing outside this feature imports one of its files by path (§13.11): a
 * caller goes through this entry point, so the internal layout can change
 * without touching a call site, and two features cannot reach into each
 * other's internals.
 *
 * The whole pipeline is exported, not a curated subset: `services/attachments.ts`
 * and `services/attachmentLibrary.ts` are compatibility shims for ONE stage
 * (§10.1.5) that re-export this entry point, and they have to keep resolving
 * every name their callers used before the split — the panel, the chat panel,
 * the export and recovery services and the perf bench today, until the last of
 * them is migrated and the shims are deleted.
 */

/* Path grammar (`attachment-paths.ts`): names, extensions and the
 * note↔attachment references. Pure — no gateway, no Vue, no store. */
export {
  ATTACHMENTS_DIR,
  ATTACHMENT_EXTENSIONS,
  attachmentMonthDir,
  attachmentRelativePath,
  escapeMarkdownAlt,
  extensionFromFileName,
  extensionFromMime,
  formatStamp,
  isAttachmentExtension,
  isImageFile,
  isImagePath,
  isPathWithinVault,
  markdownImageBlock,
  mimeFromExtension,
  noteDirectory,
  relativePathFromNote,
  relativePathFromNoteVault,
  resolveRelativePath,
  sanitizeAttachmentFileName,
  suggestedPasteFileName,
  vaultRelativeFromNote,
  vaultRelativeFromNoteVault,
} from './services/attachment-paths'
export type { AttachmentExtension } from './services/attachment-paths'

/* Intake (`attachment-import.ts`): the limits enforced before any base64
 * encode or IPC, the import plan and the clipboard extraction. */
export {
  applyAttachmentLimits,
  attachmentSessionCount,
  classifyAttachmentFiles,
  collectClipboardImages,
  formatAttachmentBytes,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_BATCH,
  MAX_ATTACHMENTS_PER_BATCH_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENTS_PER_MESSAGE_BYTES,
  MAX_ATTACHMENTS_PER_SESSION,
  MAX_ATTACHMENTS_PER_VAULT_BYTES,
  MIN_ATTACHMENT_FREE_DISK_BYTES,
  planAttachmentImport,
  resetAttachmentSession,
  shouldStreamImport,
  STREAM_IMPORT_BACKEND_COMMAND,
  STREAM_IMPORT_MIN_BYTES,
} from './services/attachment-import'
export type {
  AttachmentImportContext,
  AttachmentImportPlan,
  AttachmentLimitReason,
  AttachmentLimitResult,
  AttachmentRejection,
} from './services/attachment-import'

/* Media reads and the vault library (`attachment-library.ts`). */
export {
  createImageSrcResolver,
  deleteAttachment,
  fileToBase64,
  formatBytes,
  formatRelativeTime,
  loadAttachmentLibrary,
  LOW_COPY_ENCODE_MIN_BYTES,
} from './services/attachment-library'
export type { AttachmentItem, ImageSrcResolverContext } from './services/attachment-library'
