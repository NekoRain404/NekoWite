import {
  basicPlugins,
  clearImageSelection,
  configureHeadingAnchorUrl,
  configureImageResolver,
  configureWikilinkHandler,
  createEditor,
} from '@nekowite/editor-core'
import type { NekoEditor } from '@nekowite/editor-core'
import { setActiveEditor } from '@nekowite/plugin-host'
import { editorBridge } from '../../../services/editorBridge'
import { setCalloutView } from '../../../plugins/callout'
import { createImageSrcResolver } from '../../../services/attachments'
import { dirRelativeToVault } from '../../../services/noteMeta'
import { fsService } from '../../../services/fs'
import { useTabsStore } from '../../../stores/tabs'
import { useLibraryStore } from '../../../stores/library'
import type { DocumentSession } from '../model/documentSession'

type EditorView = NonNullable<ReturnType<NekoEditor['getView']>>

export interface EditorControllerDeps {
  session: DocumentSession
  /** The editor mount element (inside the rendered pane). */
  getEditorEl: () => HTMLElement | null
}

export interface EditorController {
  /** Create the Milkdown editor, register it with the bridge and configure the
   *  image resolver / heading-anchor URL / wikilink handlers. No-op if the
   *  mount element is missing. */
  mount(): void
  /** Tear down decorators, the bridge and the ProseMirror view. Idempotent. */
  destroy(): void
  getEditor(): NekoEditor | null
  getView(): EditorView | null
}

/**
 * Owns the editor instance lifecycle and the platform wiring that depends on
 * the live tab (image resolution, heading deep-link, wikilink open). Exposes
 * the editor through commands only — callers never reach the ProseMirror
 * `${EditorView}` directly, which keeps the bridge the single access point.
 */
export function createEditorController(deps: EditorControllerDeps): EditorController {
  const tabs = useTabsStore()
  const library = useLibraryStore()

  function mount(): void {
    const el = deps.getEditorEl()
    if (!el) return
    const editor = createEditor(el, { plugins: basicPlugins })
    deps.session.editor = editor
    editorBridge.setEditor(editor)
    setActiveEditor(editor)
    configureImageResolver(
      createImageSrcResolver(fsService, {
        getVault: () => tabs.vault,
        getNotePath: () => tabs.activeTab?.path ?? null,
      }),
    )
    // Heading anchors copy a deep-link fragment. Prefer the note's vault-relative
    // path so the link is resolvable from anywhere; fall back to a bare fragment
    // for unsaved docs. Reads live tab state at click time.
    configureHeadingAnchorUrl((slug) => {
      const path = tabs.activeTab?.path
      const vault = tabs.vault
      if (!path || !vault) return `#${slug}`
      return `${vault.replace(/\/+$/, '')}/${path}#${slug}`
    })
    // Ctrl/Cmd+click on a [[wikilink]] chip opens the target note. Resolve the
    // wiki target against the current note's vault-relative directory using the
    // library index (same resolution as the backlinks/links panels).
    configureWikilinkHandler((target) => {
      const path = tabs.activeTab?.path
      const vault = tabs.vault
      if (!path || !vault) return
      const relDir = dirRelativeToVault(path, vault)
      const resolved = library.resolveLinkPath(relDir, target)
      if (resolved) void tabs.openTab(resolved)
    })
  }

  function destroy(): void {
    const editor = deps.session.editor
    deps.session.editor = null
    // Order matters: detach the decorators/resolvers and the plugin-view callback
    // before destroying the ProseMirror view so a destroyed view is never re-wired.
    setCalloutView(null)
    clearImageSelection()
    configureImageResolver(null)
    configureHeadingAnchorUrl(null)
    configureWikilinkHandler(null)
    editorBridge.setEditor(null)
    setActiveEditor(null)
    editor?.destroy()
  }

  function getView(): EditorView | null {
    const editor = deps.session.editor
    if (!editor) return null
    try {
      return editor.getView()
    } catch {
      return null
    }
  }

  return { mount, destroy, getEditor: () => deps.session.editor, getView }
}
