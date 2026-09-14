/**
 * The shared front of every exporter: the settings they read, the source they
 * are handed, and the render options that reach `renderDocumentAsync`.
 *
 * Split out of `export.ts` when the exporters multiplied. It is not a
 * formality: the image and text exporters need the same render options as the
 * HTML one, and reaching back into `export.ts` for them would make every
 * exporter import the module that imports every exporter — a cycle. This is the
 * one edge they may share.
 */
import type { ExportImageTarget, ExportRef, RenderDocumentOptions } from '@nekowite/editor-core'
import { fsService } from '../platform/gateways/fs'
import { buildComponentRenderers } from './export-renderers'
import { createImageSrcResolver } from './attachments'
// Cycle-blocked deep import (§13.11): `features/notes` pulls in useNoteActions,
// which reaches back here through useNoteExport. The scan module reaches nothing
// but i18n and the path helpers, so reading it directly is the one edge that
// does not close the loop.
import { splitFrontmatterRaw } from '../features/notes/services/frontmatter-scan'
import { useTabsStore } from '../stores/tabs'
import { useSettingsStore } from '../stores/settings'
import {
  EXPORT_MARGIN_MM_DEFAULT,
  clampMarginMm,
  type ExportOrientation,
  type ExportPageSize,
} from './export-page'

export interface ExportUiOptions {
  title?: string
  refs?: Map<string, ExportRef>
  math?: 'katex' | 'text'
  savePath?: string
  /** Vault-relative path of the exported note; defaults to the active tab. */
  notePath?: string | null
}

export interface ExportSettings {
  includeFrontmatter: boolean
  pageSize: ExportPageSize
  orientation: ExportOrientation
  marginMm: number
}

const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  includeFrontmatter: true,
  pageSize: 'A4',
  orientation: 'portrait',
  marginMm: EXPORT_MARGIN_MM_DEFAULT,
}

// The export implementation pulls in KaTeX (and the remark/cite parsing
// pipeline behind it) purely to render markdown to HTML/PDF, which only
// happens on explicit user export. Loading it on demand keeps the editor's
// startup bundle free of that ~1MB of math machinery.
export async function renderDocumentAsync(
  markdown: string,
  opts?: RenderDocumentOptions,
): Promise<string> {
  const mod = await import('@nekowite/editor-core')
  return mod.renderDocumentAsync(markdown, opts)
}

function storeContext(): { getVault(): string | null; getNotePath(): string | null } {
  // The tabs store is read lazily per resolution so exports always see the
  // live vault/note, and contexts without an active pinia (tests) degrade.
  try {
    const tabs = useTabsStore()
    return {
      getVault: () => tabs.vault,
      getNotePath: () => tabs.activeTab?.path ?? null,
    }
  } catch {
    return { getVault: () => null, getNotePath: () => null }
  }
}

/** Read export params from the settings store, degrading to defaults outside
 * an active pinia (the export pipeline is also exercised by unit tests). */
export function exportSettings(): ExportSettings {
  try {
    const settings = useSettingsStore()
    return {
      includeFrontmatter: settings.exportIncludeFrontmatter,
      pageSize: settings.exportPdfPageSize,
      orientation: settings.exportPdfOrientation,
      marginMm: clampMarginMm(settings.exportMarginMm),
    }
  } catch {
    return DEFAULT_EXPORT_SETTINGS
  }
}

/** Strip the YAML frontmatter block when the export should not include it. */
export function prepareSource(source: string, includeFrontmatter: boolean): string {
  if (includeFrontmatter) return source
  return splitFrontmatterRaw(source).body
}

/**
 * `imageSrcTarget` is per destination: a saved .html has to be self-contained
 * (data URLs), while the in-app print/PDF path renders through the asset
 * protocol and keeps the cheap display URL.
 *
 * The image export joins the `'data'` side even though it renders in-app: its
 * document is serialised into an `<svg><foreignObject>` and drawn through an
 * `<img>`, and an SVG loaded as an image may not fetch anything — an `asset:`
 * URL would come out as an empty box, and a document with a photo in it would
 * export as a document with a hole in it.
 */
export function toRenderOptions(
  opts: ExportUiOptions,
  imageSrcTarget: ExportImageTarget = 'display',
): RenderDocumentOptions {
  const ctx = storeContext()
  return {
    title: opts.title,
    refs: opts.refs,
    componentRenderers: buildComponentRenderers(),
    math: opts.math,
    includeCss: true,
    imageSrcTarget,
    resolveImage: createImageSrcResolver(fsService, {
      getVault: ctx.getVault,
      getNotePath: () => opts.notePath ?? ctx.getNotePath(),
    }),
  }
}
